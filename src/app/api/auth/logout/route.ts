/**
 * POST /api/auth/logout
 *
 * Clears the httpOnly auth-token cookie and returns a success response.
 * The client should also clear zustand state and redirect to the main domain.
 */
import { NextResponse } from 'next/server';

export async function POST() {
  const res = NextResponse.json({ success: true });

  // Clear the httpOnly session cookie.
  // Domain `.mawadao.com` covers both mawadao.com and *.mawadao.com subdomains.
  res.cookies.set('auth-token', '', {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    domain: '.mawadao.com',
    path: '/',
    maxAge: 0,
  });

  return res;
}
