import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest, extractJWTFromRequest } from "@/lib/auth";
import pool from "@/lib/db";
import { syncChannelsToGcs } from "@/lib/sync-channels";

interface RouteContext {
  params: Promise<{ channelType: string }>;
}

/** DELETE /api/channels/[channelType] — hard-delete a channel connection */
export async function DELETE(request: NextRequest, context: RouteContext) {
  const user = await authenticateRequest(request);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { channelType } = await context.params;

  try {
    const result = await pool.query(
      'DELETE FROM agent_channels WHERE user_id = $1 AND channel_type = $2 RETURNING id',
      [user.userId, channelType],
    );

    if (result.rowCount === 0) {
      return NextResponse.json({ error: 'Channel not found' }, { status: 404 });
    }

    // Remove channel from GCS openclaw.json and notify the live gateway.
    const rawJwt = extractJWTFromRequest(request);
    syncChannelsToGcs(user.userId, user.subdomain, rawJwt).catch(() => {});

    return new NextResponse(null, { status: 204 });
  } catch (err) {
    console.error('[api/channels DELETE]', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/** PATCH /api/channels/[channelType] — disable (soft-disconnect) or re-enable */
export async function PATCH(request: NextRequest, context: RouteContext) {
  const user = await authenticateRequest(request);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { channelType } = await context.params;

  let body: Record<string, unknown> = {};
  try {
    body = await request.json();
  } catch {
    // body is optional for a disable call
  }

  // Default action is disable; pass { enable: true } to re-enable
  const isActive = body.enable === true;

  try {
    const result = await pool.query(
      `UPDATE agent_channels
       SET is_active = $3, updated_at = NOW()
       WHERE user_id = $1 AND channel_type = $2
       RETURNING *`,
      [user.userId, channelType, isActive],
    );

    if (result.rowCount === 0) {
      return NextResponse.json({ error: 'Channel not found' }, { status: 404 });
    }

    const row = result.rows[0];
    // Sync enabled/disabled state to GCS openclaw.json and notify the live gateway.
    const rawJwt = extractJWTFromRequest(request);
    syncChannelsToGcs(user.userId, user.subdomain, rawJwt).catch(() => {});

    let credentialKeys: string[] = [];
    if (row.credentials && typeof row.credentials === 'object') {
      credentialKeys = Object.keys(row.credentials as Record<string, unknown>);
    }
    return NextResponse.json({
      success: true,
      data: {
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
      },
    });
  } catch (err) {
    console.error('[api/channels PATCH]', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
