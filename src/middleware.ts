import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { validateJWT } from '@/lib/jwt';

// Routes that require authentication
const protectedRoutes = ['/settings', '/channels', '/integrations', '/mission-control'];

// Auth is handled on the main domain (barrsa.com) — no local auth routes

// Cloud mode: when true, enables JWT auth
const CLOUD_MODE = process.env.NEXT_PUBLIC_CLOUD_MODE === 'true';

function firstForwardedValue(value: string | null): string {
  if (!value) return '';
  return value.split(',')[0].trim();
}

function stripPort(host: string): string {
  return host.replace(/:\d+$/, '').trim();
}

function resolveExternalProtocol(request: NextRequest): string {
  const proto = firstForwardedValue(request.headers.get('x-forwarded-proto')) || request.nextUrl.protocol.replace(':', '') || 'https';
  const host = stripPort(resolveExternalHost(request)).toLowerCase();
  // Reverse proxies can show internal http while the public domain is https.
  if (host === 'barrsa.com' || host.endsWith('.barrsa.com')) {
    return 'https';
  }
  return proto;
}

function resolveExternalHost(request: NextRequest): string {
  const forwardedHost = firstForwardedValue(request.headers.get('x-forwarded-host'));
  if (forwardedHost) return forwardedHost;

  const urlHost = request.nextUrl.host?.trim();
  if (urlHost) return urlHost;

  return firstForwardedValue(request.headers.get('host'));
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Skip middleware entirely for API routes, static assets, and health endpoints.
  // The config.matcher should already exclude these, but some hosting environments
  // (Cloud Run, reverse proxies) can cause unexpected path matching.
  if (
    pathname.startsWith('/api/') ||
    pathname.startsWith('/_next/') ||
    pathname.startsWith('/favicon') ||
    pathname.startsWith('/site.webmanifest')
  ) {
    return NextResponse.next();
  }

  const externalHost = resolveExternalHost(request);

  // --- Subdomain detection ---
  const ROOT_DOMAIN = process.env.NEXT_PUBLIC_ROOT_DOMAIN || 'barrsa.com';
  const currentHost = stripPort(externalHost);
  const rootBase = ROOT_DOMAIN.replace(/:\d+$/, '');

  const isSubdomain =
    currentHost !== rootBase &&
    currentHost !== 'localhost' &&
    currentHost !== 'www.' + rootBase &&
    currentHost.endsWith('.' + rootBase);

  const subdomain = isSubdomain
    ? currentHost.replace('.' + rootBase, '')
    : null;

  if (CLOUD_MODE) {
    const token = request.cookies.get('auth-token')?.value;
    const user = token ? await validateJWT(token) : null;

    // Subdomain request (e.g., username.barrsa.com)
    if (subdomain) {
      // --- Transfer token arrival ---
      // When redirected from barrsa.com after login, the URL contains
      // ?auth_token=TRANSFER_TOKEN&state=RANDOM.
      // We do NOT exchange the token in middleware because Set-Cookie on
      // a 307 redirect response is unreliable across browsers/proxies.
      // Instead, we let the page render so client-side JS can call
      // POST /api/auth/token-exchange which sets the cookie properly.
      const authTokenParam = request.nextUrl.searchParams.get('auth_token');
      if (authTokenParam && !user) {
        // Rewrite to root so the page renders with auth_token in the URL
        const response = NextResponse.next();
        response.headers.set('x-subdomain', subdomain);
        response.headers.set('x-needs-token-exchange', '1');
        return response;
      }

      // If user already has a valid cookie AND there are leftover auth params,
      // strip them and redirect to a clean URL.
      if (authTokenParam && user) {
        const proto = resolveExternalProtocol(request);
        const cleanParams = new URLSearchParams(request.nextUrl.search);
        cleanParams.delete('auth_token');
        cleanParams.delete('state');
        const qs = cleanParams.toString();
        const cleanHref = `${proto}://${externalHost}${pathname}${qs ? '?' + qs : ''}`;
        return NextResponse.redirect(new URL(cleanHref));
      }

      if (!user) {
        // Not authenticated → redirect to main domain login
        const proto = resolveExternalProtocol(request);
        const loginUrl = new URL('/auth/login', `${proto}://${rootBase}`);
        loginUrl.searchParams.set('redirect', `${proto}://${externalHost}${pathname}${request.nextUrl.search}`);
        return NextResponse.redirect(loginUrl);
      }

      // Verify ownership: JWT subdomain must match URL subdomain.
      // The logged-in user belongs to a different subdomain — send them to login
      // on the main domain so they can sign in with the correct account.
      if (user.subdomain !== subdomain) {
        const proto = resolveExternalProtocol(request);
        const loginUrl = new URL('/auth/login', `${proto}://${rootBase}`);
        loginUrl.searchParams.set('redirect', `${proto}://${externalHost}${pathname}${request.nextUrl.search}`);
        loginUrl.searchParams.set('reason', 'wrong_account');
        return NextResponse.redirect(loginUrl);
      }

      // Set tenant routing headers for all subdomain requests
      const response = NextResponse.next();
      response.headers.set('x-subdomain', subdomain);
      response.headers.set('x-tenant-id', user.tenantId || '');
      response.headers.set('x-user-id', user.userId);
      response.headers.set('X-Frame-Options', 'DENY');
      response.headers.set('X-Content-Type-Options', 'nosniff');
      response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
      response.headers.set('Permissions-Policy', 'camera=(), microphone=(self), geolocation=(), payment=()');
      response.headers.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
      return response;
    }

    // Main domain — protected routes require auth
    if (!user && protectedRoutes.some(route => pathname.startsWith(route))) {
      const proto = resolveExternalProtocol(request);
      const loginUrl = new URL('/auth/login', `${proto}://${rootBase}`);
      loginUrl.searchParams.set('redirect', `${proto}://${externalHost}${pathname}${request.nextUrl.search}`);
      return NextResponse.redirect(loginUrl);
    }
  } else {
    // Local mode: subdomain rewrite sets header
    if (isSubdomain && subdomain) {
      const response = NextResponse.next();
      response.headers.set('x-subdomain', subdomain);
      return response;
    }
  }

  // --- Security headers ---
  const response = NextResponse.next();
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.headers.set('X-DNS-Prefetch-Control', 'on');
  response.headers.set('Permissions-Policy', 'camera=(), microphone=(self), geolocation=(), payment=()');
  if (CLOUD_MODE) {
    response.headers.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  }

  return response;
}

export const config = {
  matcher: [
    // Explicitly list page routes that need middleware — avoid negative-lookahead
    // regex which can cause routing issues on Cloud Run / production builds.
    '/',
    '/settings/:path*',
    '/channels/:path*',
    '/integrations/:path*',
    '/marketplace/:path*',
    '/auth/:path*',
    '/chat/:path*',
    '/mission-control/:path*',
    '/health/:path*',
    '/seller/:path*',
  ],
};
