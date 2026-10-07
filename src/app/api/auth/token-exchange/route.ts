/**
 * POST /api/auth/token-exchange
 *
 * Validates a short-lived transfer token (passed via URL when redirecting from
 * barrsa.com to {subdomain}.barrsa.com) and sets an httpOnly auth-token cookie
 * for the subdomain.
 *
 * Flow:
 *   1. User logs in on barrsa.com → gets a transfer token
 *   2. Redirect: https://user.barrsa.com?auth_token=TRANSFER_TOKEN&state=RANDOM
 *   3. Subdomain JS calls POST /api/auth/token-exchange { token: TRANSFER_TOKEN }
 *   4. This route validates the transfer token and sets the session cookie
 */
import { NextRequest, NextResponse } from 'next/server';
import { validateTransferToken, createJWT } from '@/lib/auth';
import pool from '@/lib/db';
import { initUserConfig } from '@/lib/gcs';

export async function POST(request: NextRequest) {
  let body: { token?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const token = body.token;
  if (!token || typeof token !== 'string') {
    return NextResponse.json({ error: 'Token required' }, { status: 400 });
  }

  const payload = await validateTransferToken(token);
  if (!payload || !payload.userId) {
    return NextResponse.json({ error: 'Invalid or expired transfer token' }, { status: 401 });
  }

  // Look up tenant from DB to get latest subdomain/tenant info
  let subdomain = payload.subdomain;
  let tenantId = payload.tenantId;
  try {
    const res = await pool.query<{ id: string; subdomain: string }>(
      'SELECT id, subdomain FROM tenants WHERE user_id = $1 LIMIT 1',
      [payload.userId],
    );
    if (res.rows[0]) {
      tenantId = res.rows[0].id;
      subdomain = res.rows[0].subdomain;
    }
  } catch {
    // Non-fatal — use the claims from the transfer token
  }

  const sessionToken = await createJWT({
    userId: payload.userId,
    email: payload.email,
    subdomain,
    tenantId,
  });

  // Fire-and-forget: ensure per-user GCS bucket + default openclaw.json exist
  void (async () => {
    try {
      const usernameRes = await pool.query<{ username: string }>(
        'SELECT username FROM users WHERE id = $1 LIMIT 1',
        [payload.userId],
      );
      const username = usernameRes.rows[0]?.username;
      if (username) {
        await initUserConfig(username);
      }
    } catch {
      // Non-fatal — GCS init failure must never block login
    }
  })();

  const response = NextResponse.json({
    success: true,
    token: sessionToken,
    user: {
      userId: payload.userId,
      email: payload.email,
      subdomain,
      tenantId,
    },
  });

  response.cookies.set('auth-token', sessionToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 7 * 24 * 60 * 60, // 7 days
    domain: process.env.NODE_ENV === 'production' ? '.barrsa.com' : undefined,
  });

  return response;
}
