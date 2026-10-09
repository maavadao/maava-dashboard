import { NextRequest, NextResponse } from 'next/server';

const CONFIGURATION_API = (process.env.MAAVADAO_API_URL || 'https://maavadao.com/api/v1').replace(/\/+$/, '');

/**
 * POST /api/users/register → proxies to maava-api POST /users/register
 * Returns: { success: true, user: { id, username, email, displayName, api_key }, important }
 */
export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid JSON' }, { status: 400 });
  }

  try {
    console.log('[/api/users/register] Forwarding registration to maava-api');
    const res = await fetch(`${CONFIGURATION_API}/users/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    console.log('[/api/users/register] Response status:', res.status, '| success:', (data as Record<string, unknown>).success);
    return NextResponse.json(data, { status: res.status });
  } catch (err) {
    console.error('[/api/users/register] Proxy error:', err);
    return NextResponse.json({ success: false, error: 'Auth service unavailable' }, { status: 503 });
  }
}
