import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest, extractJWTFromRequest } from "@/lib/auth";
import pool from "@/lib/db";
import { syncChannelsToGcs } from "@/lib/sync-channels";

const ALLOWED_CHANNEL_TYPES = [
  'discord', 'slack', 'telegram', 'teams', 'whatsapp',
  'web', 'signal', 'line', 'viber',
];

/** Map a DB row (snake_case) to the SavedChannel shape the client expects (camelCase). */
function formatChannel(row: Record<string, unknown>) {
  // Extract credential key names without exposing values
  let credentialKeys: string[] = [];
  if (row.credentials && typeof row.credentials === 'object') {
    credentialKeys = Object.keys(row.credentials as Record<string, unknown>);
  }
  return {
    id: row.id,
    userId: row.user_id,
    agentId: row.agent_id ?? null,
    channelType: row.channel_type,
    channelName: row.channel_name ?? null,
    credentialKeys,
    metadata: row.metadata ?? {},
    isActive: row.is_active ?? false,
    connectedAt: row.connected_at ?? null,
    lastError: row.last_error ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at ?? row.created_at,
  };
}

/** GET /api/channels — list saved channels for the authenticated user */
export async function GET(request: NextRequest) {
  const user = await authenticateRequest(request);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const result = await pool.query(
      `SELECT id, user_id, agent_id, channel_type, channel_name,
              credentials, metadata, is_active, connected_at, last_error,
              created_at, updated_at
       FROM agent_channels
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [user.userId],
    );
    return NextResponse.json({ success: true, data: result.rows.map(formatChannel) });
  } catch (err) {
    console.error('[api/channels GET]', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/** POST /api/channels — save (upsert) a channel connection */
export async function POST(request: NextRequest) {
  const user = await authenticateRequest(request);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const { channelType, channelName, credentials, metadata } = body as Record<string, unknown>;

  if (
    !channelType ||
    typeof channelType !== 'string' ||
    !ALLOWED_CHANNEL_TYPES.includes(channelType)
  ) {
    return NextResponse.json(
      { error: `Invalid channelType. Allowed: ${ALLOWED_CHANNEL_TYPES.join(', ')}` },
      { status: 400 },
    );
  }

  if (!credentials || typeof credentials !== 'object') {
    return NextResponse.json({ error: 'credentials object is required' }, { status: 400 });
  }

  try {
    const result = await pool.query(
      `INSERT INTO agent_channels (user_id, channel_type, channel_name, credentials, metadata, is_active, connected_at)
       VALUES ($1, $2, $3, $4, $5, true, NOW())
       ON CONFLICT (user_id, channel_type)
       DO UPDATE SET
         channel_name  = EXCLUDED.channel_name,
         credentials   = EXCLUDED.credentials,
         metadata      = EXCLUDED.metadata,
         is_active     = true,
         connected_at  = NOW(),
         last_error    = NULL,
         updated_at    = NOW()
       RETURNING *`,
      [
        user.userId,
        channelType,
        channelName || channelType,
        JSON.stringify(credentials),
        JSON.stringify(metadata || {}),
      ],
    );
    // Sync channel credentials to GCS openclaw.json and notify the live gateway.
    // Await so we can surface a warning if GCS is misconfigured.
    const rawJwt = extractJWTFromRequest(request);
    const gcsOk = await syncChannelsToGcs(user.userId, user.subdomain, rawJwt).catch((err) => {
      console.error('[api/channels POST] Unexpected sync error:', err);
      return false;
    });

    const response: Record<string, unknown> = { success: true, data: formatChannel(result.rows[0]) };
    if (!gcsOk) {
      response.gcsSyncWarning = 'Channel saved to DB but GCS sync failed. Ensure STORAGE_URL and STORAGE_API_SECRET are set correctly in the maava-dashboard service.';
    }
    return NextResponse.json(response, { status: 201 });
  } catch (err) {
    console.error('[api/channels POST]', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
