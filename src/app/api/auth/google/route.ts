import { NextRequest, NextResponse } from 'next/server';

function toHostOnly(host: string): string {
  return host.split(',')[0].trim().split(':')[0].trim();
}

function firstForwardedValue(value: string | null): string {
  if (!value) return '';
  return value.split(',')[0].trim();
}

function resolveAuthBase(request: NextRequest): string {
  // The member space is one host, so auth.<host> would be wrong there.
  if (process.env.NEXT_PUBLIC_AUTH_URL) return process.env.NEXT_PUBLIC_AUTH_URL;

  const xfProto = firstForwardedValue(request.headers.get('x-forwarded-proto'));
  const xfHost = firstForwardedValue(request.headers.get('x-forwarded-host'));
  const hostHeader = firstForwardedValue(request.headers.get('host'));
  const urlHost = request.nextUrl.hostname?.trim();

  const protocol = xfProto || request.nextUrl.protocol.replace(':', '') || 'https';
  const host = toHostOnly(xfHost || urlHost || hostHeader || 'maavadao.com');

  if (host === 'localhost' || host === '127.0.0.1') {
    return process.env.NEXT_PUBLIC_AUTH_URL || 'https://auth.maavadao.com';
  }

  if (host.startsWith('auth.')) {
    return `${protocol}://${host}`;
  }

  return `${protocol}://auth.${host}`;
}

/**
 * Runtime redirect entrypoint for Google OAuth.
 * Keeps auth URL resolution server-side to avoid stale build-time env issues.
 */
export async function GET(request: NextRequest) {
  const authBase = resolveAuthBase(request).replace(/\/+$/, '');
  return NextResponse.redirect(`${authBase}/auth/google`);
}
