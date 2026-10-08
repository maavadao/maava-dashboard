import { NextRequest, NextResponse } from "next/server";
import { validateJWT } from "@/lib/auth";
import pool from "@/lib/db";

const API_BASE = process.env.MAWADAO_API_URL;
const DEPLOYER_URL = process.env.DEPLOYER_URL || "";
const DEPLOYER_API_SECRET = process.env.DEPLOYER_API_SECRET || "";

export async function GET(request: NextRequest) {
  try {
    const authHeader = request.headers.get("authorization");
    if (!authHeader) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const response = await fetch(`${API_BASE}/users/me`, {
      headers: {
        "Content-Type": "application/json",
        Authorization: authHeader,
      },
    });

    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/users/me
 *
 * Permanently deletes the authenticated user account and all associated data.
 * Uses the httpOnly auth-token cookie — no body required.
 */
export async function DELETE(request: NextRequest) {
  const cookie = request.cookies.get("auth-token")?.value;
  if (!cookie) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const payload = await validateJWT(cookie);
  if (!payload || !payload.userId) {
    return NextResponse.json({ error: "Invalid session" }, { status: 401 });
  }

  const userId = payload.userId as string;

  try {
    // 0. Fetch tenant record BEFORE deletion so we can clean up the Cloud Run service
    const tenantRes = await pool.query(
      `SELECT subdomain, cloud_run_service_name, region FROM tenants WHERE user_id = $1 LIMIT 1`,
      [userId]
    );
    const tenant = tenantRes.rows[0] as
      | { subdomain: string; cloud_run_service_name: string | null; region: string }
      | undefined;

    // 1. Delete the Cloud Run service (best-effort — log and continue if it fails)
    if (tenant?.subdomain && DEPLOYER_URL) {
      try {
        const delRes = await fetch(
          `${DEPLOYER_URL}/tenants/${encodeURIComponent(tenant.subdomain)}?userId=${encodeURIComponent(userId)}`,
          {
            method: "DELETE",
            headers: DEPLOYER_API_SECRET
              ? { "X-Deployer-Secret": DEPLOYER_API_SECRET }
              : {},
          }
        );
        const delData = await delRes.json().catch(() => ({}));
        console.log(
          `[DELETE /api/users/me] Cloud Run cleanup for ${tenant.subdomain}:`,
          JSON.stringify(delData)
        );
      } catch (crErr) {
        console.warn(
          `[DELETE /api/users/me] Cloud Run cleanup failed for ${tenant.subdomain} (non-fatal):`,
          crErr
        );
      }
    }

    // 2. Clean up mawa-dashboard tables (TEXT user_id — no FK cascades)
    await pool.query(
      `DELETE FROM messages
       WHERE conversation_id IN (SELECT id FROM conversations WHERE user_id = $1)`,
      [userId]
    );
    await pool.query(`DELETE FROM conversations WHERE user_id = $1`, [userId]);
    await pool.query(`DELETE FROM user_skills WHERE user_id = $1`, [userId]);
    await pool.query(`DELETE FROM user_chat_preferences WHERE user_id = $1`, [userId]);
    await pool.query(`DELETE FROM user_installed_agents WHERE user_id = $1`, [userId]);

    // 3. Delete the user row — ON DELETE CASCADE handles:
    //    tenants, provider_keys, posts, comments, votes, follows, subscriptions, etc.
    const result = await pool.query(
      `DELETE FROM users WHERE id = $1 RETURNING id`,
      [userId]
    );

    if ((result.rowCount ?? 0) === 0) {
      console.warn(`[DELETE /api/users/me] User ${userId} not found (already deleted)`);
    } else {
      console.log(`[DELETE /api/users/me] Deleted user ${userId}`);
    }
  } catch (err) {
    console.error("[DELETE /api/users/me] DB error:", err);
    return NextResponse.json({ error: "Failed to delete account" }, { status: 500 });
  }

  // 4. Clear the auth-token cookie so the session is immediately invalid
  const response = NextResponse.json({ success: true });
  response.cookies.set("auth-token", "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
    domain: process.env.NODE_ENV === "production" ? ".mawadao.com" : undefined,
  });
  return response;
}
