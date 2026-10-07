import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest } from '@/lib/auth';

/**
 * Proxy route for Mission Control API.
 * Forwards /api/mission-control/[...path] → MC backend /api/v1/[...path]
 * Injects auth headers from the tenant dashboard session.
 */

const MC_BACKEND_URL = process.env.MISSION_CONTROL_API_URL || 'http://localhost:8000';
const MC_AUTH_TOKEN = process.env.MISSION_CONTROL_AUTH_TOKEN || '';

// Only allow safe, expected methods
const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

function buildUpstreamUrl(path: string[], searchParams: URLSearchParams): string {
  const safePath = path.map((seg) => encodeURIComponent(seg)).join('/');
  const qs = searchParams.toString();
  return `${MC_BACKEND_URL}/api/v1/${safePath}${qs ? `?${qs}` : ''}`;
}

async function proxyRequest(request: NextRequest, pathSegments: string[]) {
  if (!ALLOWED_METHODS.has(request.method)) {
    return NextResponse.json({ error: 'Method not allowed' }, { status: 405 });
  }

  const user = await authenticateRequest(request);
  if (!user || !user.userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const userId = user.userId;

  const upstreamUrl = buildUpstreamUrl(pathSegments, request.nextUrl.searchParams);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };

  // Use local auth token for MC backend (AUTH_MODE=local)
  if (MC_AUTH_TOKEN) {
    headers['Authorization'] = `Bearer ${MC_AUTH_TOKEN}`;
  }

  // Pass user context to MC backend so it can resolve the per-tenant gateway.
  headers['X-Forwarded-User-Id'] = userId;
  if (user.email) headers['X-Forwarded-User-Email'] = user.email;
  if (user.subdomain) headers['X-Forwarded-Tenant-Subdomain'] = user.subdomain;
  if (user.tenantId) headers['X-Forwarded-Tenant-Id'] = user.tenantId;

  let body: string | undefined;
  if (request.method !== 'GET' && request.method !== 'DELETE') {
    try {
      body = await request.text();
    } catch {
      // no body
    }
  }

  try {
    const upstreamRes = await fetch(upstreamUrl, {
      method: request.method,
      headers,
      body,
    });

    // Sanitize 5xx responses — don't forward raw MC backend errors/stack traces
    if (upstreamRes.status >= 500) {
      console.error(`[mission-control-proxy] MC backend ${upstreamRes.status} on ${request.method} ${upstreamUrl}`);
      return NextResponse.json(
        { error: 'Mission Control internal error' },
        { status: upstreamRes.status }
      );
    }

    const responseBody = await upstreamRes.text();
    return new NextResponse(responseBody, {
      status: upstreamRes.status,
      headers: {
        'Content-Type': upstreamRes.headers.get('Content-Type') || 'application/json',
      },
    });
  } catch (err) {
    console.error('[mission-control-proxy] upstream error:', err);
    return NextResponse.json(
      { error: 'Mission Control service unavailable' },
      { status: 502 }
    );
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path } = await params;
  return proxyRequest(request, path);
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path } = await params;
  return proxyRequest(request, path);
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path } = await params;
  return proxyRequest(request, path);
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path } = await params;
  return proxyRequest(request, path);
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path } = await params;
  return proxyRequest(request, path);
}
