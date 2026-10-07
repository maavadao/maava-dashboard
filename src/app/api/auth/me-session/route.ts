/**
 * GET /api/auth/me-session
 *
 * Reads the httpOnly auth-token cookie, validates the JWT, and returns user
 * info + a token the client can use for Bearer auth on API calls.
 *
 * Purpose: bootstrap client-side auth state when the zustand store is empty
 * but a valid session cookie exists (e.g. after page reload, localStorage cleared).
 */
import { NextRequest, NextResponse } from 'next/server';
import { validateJWT } from '@/lib/auth';
import pool from '@/lib/db';

export async function GET(request: NextRequest) {
  const cookie = request.cookies.get('auth-token')?.value;
  if (!cookie) {
    return NextResponse.json({ authenticated: false }, { status: 401 });
  }

  const payload = await validateJWT(cookie);
  if (!payload || !payload.userId) {
    return NextResponse.json({ authenticated: false }, { status: 401 });
  }

  // Verify user still exists in DB — catches accounts deleted externally
  try {
    const { rows } = await pool.query(
      'SELECT id FROM users WHERE id = $1 AND is_active = true',
      [payload.userId]
    );
    if (rows.length === 0) {
      return NextResponse.json({ authenticated: false }, { status: 401 });
    }
  } catch {
    // DB unreachable — allow through to avoid locking out users on transient errors
  }

  return NextResponse.json({
    authenticated: true,
    token: cookie,
    user: {
      userId: payload.userId,
      email: payload.email,
      subdomain: payload.subdomain,
      tenantId: payload.tenantId,
    },
  });
}
