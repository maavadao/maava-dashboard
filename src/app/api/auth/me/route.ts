import { NextRequest, NextResponse } from 'next/server';

// Use the Go auth service URL (not the maava-api).
const API_BASE = (process.env.NEXT_PUBLIC_AUTH_URL || 'https://auth.maavadao.com').replace(/\/+$/, '');

/**
 * Proxy GET /api/auth/me → Go auth service GET /auth/me
 * Avoids cross-origin browser fetch to the auth service.
 */
export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization');
  if (!authHeader) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const response = await fetch(`${API_BASE}/auth/me`, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader,
      },
    });

    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
