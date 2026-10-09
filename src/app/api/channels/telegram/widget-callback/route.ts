import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest } from "@/lib/auth";
import pool from "@/lib/db";
import crypto from "crypto";

/**
 * POST /api/channels/telegram/widget-callback
 *
 * Verifies Telegram Login Widget data and creates a link between
 * the authenticated maavaDao user and their Telegram identity.
 *
 * Body: { id, first_name, last_name?, username?, photo_url?, auth_date, hash }
 *
 * Verification: HMAC-SHA256 of sorted key=value pairs using SHA256(bot_token) as key.
 * See: https://core.telegram.org/widgets/login#checking-authorization
 */
export async function POST(request: NextRequest) {
  const user = await authenticateRequest(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: Record<string, string>;
  try {
    body = (await request.json()) as Record<string, string>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { id, first_name, last_name, username, photo_url, auth_date, hash } = body;

  if (!id || !auth_date || !hash) {
    return NextResponse.json(
      { error: "Missing required fields: id, auth_date, hash" },
      { status: 400 },
    );
  }

  // ── Replay protection: reject data older than 5 minutes ──
  const authTimestamp = parseInt(auth_date, 10);
  if (isNaN(authTimestamp) || (Date.now() / 1000 - authTimestamp) > 300) {
    return NextResponse.json(
      { error: "Login data has expired. Please try again." },
      { status: 400 },
    );
  }

  // ── Verify Telegram hash ──
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    console.error("[telegram-widget] TELEGRAM_BOT_TOKEN not set");
    return NextResponse.json(
      { error: "Telegram integration not configured" },
      { status: 500 },
    );
  }

  // Build data-check-string: sort all fields except `hash`, join as key=value with \n
  const checkFields: Record<string, string> = {};
  for (const [key, value] of Object.entries(body)) {
    if (key !== "hash" && value !== undefined && value !== null) {
      checkFields[key] = String(value);
    }
  }
  const dataCheckString = Object.keys(checkFields)
    .sort()
    .map((k) => `${k}=${checkFields[k]}`)
    .join("\n");

  const secretKey = crypto.createHash("sha256").update(botToken).digest();
  const computedHash = crypto
    .createHmac("sha256", secretKey)
    .update(dataCheckString)
    .digest("hex");

  if (computedHash !== hash) {
    console.warn("[telegram-widget] Hash verification failed");
    return NextResponse.json(
      { error: "Invalid Telegram login data" },
      { status: 403 },
    );
  }

  // ── Data verified — create the link ──
  const telegramUserId = String(id);
  const platformMeta = JSON.stringify({
    firstName: first_name || null,
    lastName: last_name || null,
    username: username || null,
    photoUrl: photo_url || null,
  });

  try {
    // 1. Upsert into telegram_channel_links (dedicated table)
    await pool.query(
      `INSERT INTO telegram_channel_links
         (maavadao_user_id, telegram_user_id, telegram_chat_id, telegram_username,
          telegram_first_name, telegram_last_name, linked_via, is_active, last_seen_at)
       VALUES ($1, $2, $2, $3, $4, $5, 'widget', true, NOW())
       ON CONFLICT (telegram_user_id)
       DO UPDATE SET
         maavadao_user_id      = EXCLUDED.maavadao_user_id,
         telegram_username   = COALESCE(EXCLUDED.telegram_username, telegram_channel_links.telegram_username),
         telegram_first_name = COALESCE(EXCLUDED.telegram_first_name, telegram_channel_links.telegram_first_name),
         telegram_last_name  = COALESCE(EXCLUDED.telegram_last_name, telegram_channel_links.telegram_last_name),
         linked_via          = 'widget',
         is_active           = true,
         last_seen_at        = NOW(),
         updated_at          = NOW()`,
      [
        user.userId,
        BigInt(telegramUserId),
        username || null,
        first_name || null,
        last_name || null,
      ],
    );

    // 2. Also upsert into platform_channel_links for backward compatibility
    await pool.query(
      `INSERT INTO platform_channel_links
         (user_id, platform, platform_user_id, platform_meta, is_active, linked_at)
       VALUES ($1, 'telegram', $2, $3, true, NOW())
       ON CONFLICT (platform, platform_user_id)
       DO UPDATE SET
         user_id       = EXCLUDED.user_id,
         platform_meta = EXCLUDED.platform_meta,
         is_active     = true,
         linked_at     = NOW(),
         updated_at    = NOW()`,
      [user.userId, telegramUserId, platformMeta],
    );

    console.log(`[telegram-widget] Linked user ${user.userId} ← telegram ${telegramUserId} via widget`);

    return NextResponse.json({
      data: {
        platform: "telegram",
        platformUserId: telegramUserId,
        linkedVia: "widget",
        username: username || null,
        firstName: first_name || null,
      },
    });
  } catch (err) {
    console.error("[telegram-widget] DB error:", err);
    return NextResponse.json(
      { error: "Failed to link Telegram account" },
      { status: 500 },
    );
  }
}
