import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest } from "@/lib/auth";
import pool from "@/lib/db";

const ALLOWED_PLATFORMS = ['telegram', 'discord', 'whatsapp'];

function formatLink(row: Record<string, unknown>) {
  return {
    id: row.id,
    userId: row.user_id,
    platform: row.platform,
    platformUserId: row.platform_user_id,
    platformMeta: row.platform_meta ?? {},
    isActive: row.is_active ?? false,
    linkedAt: row.linked_at ?? row.created_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at ?? row.created_at,
  };
}

/** GET /api/platform-links — list SaaS platform links for the authenticated user */
export async function GET(request: NextRequest) {
  const user = await authenticateRequest(request);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const result = await pool.query(
      `SELECT * FROM platform_channel_links
       WHERE user_id = $1 AND is_active = true
       ORDER BY created_at DESC`,
      [user.userId],
    );
    return NextResponse.json({ data: result.rows.map(formatLink) });
  } catch (err) {
    console.error('[api/platform-links GET]', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/** POST /api/platform-links — link a SaaS platform account */
export async function POST(request: NextRequest) {
  const user = await authenticateRequest(request);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const platform = body.platform as string;
  const platformData = body.platformData as Record<string, string> | undefined;

  if (!platform || !ALLOWED_PLATFORMS.includes(platform)) {
    return NextResponse.json(
      { error: `Invalid platform. Allowed: ${ALLOWED_PLATFORMS.join(', ')}` },
      { status: 400 },
    );
  }

  if (!platformData || typeof platformData !== 'object') {
    return NextResponse.json({ error: 'platformData is required' }, { status: 400 });
  }

  let platformUserId: string;
  let platformMeta: Record<string, unknown> = {};

  switch (platform) {
    case 'telegram': {
      // Telegram Login Widget data: { id, first_name, last_name?, username?, photo_url?, auth_date, hash }
      if (!platformData.id) {
        return NextResponse.json({ error: 'Telegram id is required' }, { status: 400 });
      }
      platformUserId = String(platformData.id);
      platformMeta = {
        firstName: platformData.first_name,
        lastName: platformData.last_name,
        username: platformData.username,
        photoUrl: platformData.photo_url,
      };
      break;
    }
    case 'discord': {
      // After OAuth, we get a code that should be exchanged server-side.
      // For now, expect the frontend to pass the Discord user info directly
      // after the OAuth callback resolves it.
      if (!platformData.id && !platformData.code) {
        return NextResponse.json({ error: 'Discord id or code is required' }, { status: 400 });
      }
      platformUserId = String(platformData.id || platformData.code);
      platformMeta = {
        username: platformData.username,
        discriminator: platformData.discriminator,
        avatar: platformData.avatar,
      };
      break;
    }
    case 'whatsapp': {
      if (!platformData.phoneNumber) {
        return NextResponse.json({ error: 'Phone number is required' }, { status: 400 });
      }
      // Normalize phone: strip everything except digits and +
      const phone = platformData.phoneNumber.replace(/[^\d+]/g, '');
      if (phone.length < 7) {
        return NextResponse.json({ error: 'Invalid phone number' }, { status: 400 });
      }
      platformUserId = phone;
      platformMeta = { phoneNumber: phone };
      break;
    }
    default:
      return NextResponse.json({ error: 'Unsupported platform' }, { status: 400 });
  }

  try {
    const result = await pool.query(
      `INSERT INTO platform_channel_links (user_id, platform, platform_user_id, platform_meta, is_active, linked_at)
       VALUES ($1, $2, $3, $4, true, NOW())
       ON CONFLICT (platform, platform_user_id)
       DO UPDATE SET
         user_id       = EXCLUDED.user_id,
         platform_meta = EXCLUDED.platform_meta,
         is_active     = true,
         linked_at     = NOW(),
         updated_at    = NOW()
       RETURNING *`,
      [user.userId, platform, platformUserId, JSON.stringify(platformMeta)],
    );

    return NextResponse.json({ data: formatLink(result.rows[0]) });
  } catch (err) {
    console.error('[api/platform-links POST]', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
