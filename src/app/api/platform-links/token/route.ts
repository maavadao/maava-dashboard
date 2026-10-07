import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest } from "@/lib/auth";
import pool from "@/lib/db";
import crypto from "crypto";

const ALLOWED_PLATFORMS = ["telegram", "discord", "whatsapp"];
const TOKEN_TTL_MINUTES = 10;

/**
 * POST /api/platform-links/token — generate a one-time, short-lived deep-link
 * token that the bot will use to finalize the account link.
 *
 * Body: { platform: "telegram" }
 * Returns: { data: { token, platform, expiresAt, deepLink? } }
 */
export async function POST(request: NextRequest) {
  const user = await authenticateRequest(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const platform = body.platform as string;
  if (!platform || !ALLOWED_PLATFORMS.includes(platform)) {
    return NextResponse.json(
      { error: `Invalid platform. Allowed: ${ALLOWED_PLATFORMS.join(", ")}` },
      { status: 400 },
    );
  }

  const token = crypto.randomBytes(16).toString("base64url"); // 22 chars, URL-safe
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MINUTES * 60 * 1000);

  try {
    // Invalidate any previous unused tokens for the same user + platform
    await pool.query(
      `DELETE FROM platform_link_tokens
       WHERE user_id = $1 AND platform = $2 AND used_at IS NULL`,
      [user.userId, platform],
    );

    // Store the new token
    await pool.query(
      `INSERT INTO platform_link_tokens (token, user_id, platform, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [token, user.userId, platform, expiresAt.toISOString()],
    );

    // Build platform-specific deep link
    let deepLink: string | undefined;
    if (platform === "telegram") {
      const botUsername =
        process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME || "barrsa_bot";
      deepLink = `https://t.me/${botUsername}?start=${token}`;
    }

    return NextResponse.json({
      data: { token, platform, expiresAt: expiresAt.toISOString(), deepLink },
    });
  } catch (err) {
    console.error("[api/platform-links/token POST]", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
