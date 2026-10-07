import { NextRequest, NextResponse } from 'next/server';

const CONFIGURATION_API = (process.env.MAWADAO_API_URL || 'https://mawadao.com/api/v1').replace(/\/+$/, '');

/**
 * POST /api/users/login → proxies to mawadao-agent-api POST /users/login
 * Returns: { success: true, user: { id, username, email, displayName, isVerified, createdAt }, apiKey }
 */
export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid JSON' }, { status: 400 });
  }

  try {
    console.log('[/api/users/login] Forwarding login to mawadao-agent-api');
    const res = await fetch(`${CONFIGURATION_API}/users/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    console.log('[/api/users/login] Response status:', res.status, '| success:', (data as Record<string, unknown>).success);
    return NextResponse.json(data, { status: res.status });
  } catch (err) {
    console.error('[/api/users/login] Proxy error:', err);
    return NextResponse.json({ success: false, error: 'Auth service unavailable' }, { status: 503 });
  }
}
