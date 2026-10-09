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
  // Domain `.maavadao.com` covers both maavadao.com and *.maavadao.com subdomains.
  res.cookies.set('auth-token', '', {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    domain: '.maavadao.com',
    path: '/',
    maxAge: 0,
  });

  return res;
}
