import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { validateJWT } from '@/lib/jwt';

// The dashboard is the member space: one host (e.g. agent.mawadao.com) for every
// member. The tenant comes from the signed-in member's JWT, not the hostname.
// Sign-in and onboarding happen on the main site.

// Cloud mode: when true, enables JWT auth
const CLOUD_MODE = process.env.NEXT_PUBLIC_CLOUD_MODE === 'true';

function firstForwardedValue(value: string | null): string {
  if (!value) return '';
  return value.split(',')[0].trim();
}

function stripPort(host: string): string {
  return host.replace(/:\d+$/, '').trim();
}

function resolveExternalHost(request: NextRequest): string {
  const forwardedHost = firstForwardedValue(request.headers.get('x-forwarded-host'));
  if (forwardedHost) return forwardedHost;

  const urlHost = request.nextUrl.host?.trim();
  if (urlHost) return urlHost;

  return firstForwardedValue(request.headers.get('host'));
}

function resolveExternalProtocol(request: NextRequest): string {
  const proto = firstForwardedValue(request.headers.get('x-forwarded-proto')) || request.nextUrl.protocol.replace(':', '') || 'https';
  const host = stripPort(resolveExternalHost(request)).toLowerCase();
  // Reverse proxies can show internal http while the public domain is https.
  if (host === 'mawadao.com' || host.endsWith('.mawadao.com')) {
    return 'https';
  }
  return proto;
}

function securityHeaders(response: NextResponse): NextResponse {
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

  // /auth/* is the sign-in flow itself, so it can't require a session.
  if (!CLOUD_MODE || pathname.startsWith('/auth')) {
    return securityHeaders(NextResponse.next());
  }

  const proto = resolveExternalProtocol(request);
  const externalHost = resolveExternalHost(request);
  const mainSite = `${proto}://${(process.env.NEXT_PUBLIC_ROOT_DOMAIN || 'mawadao.com').replace(/:\d+$/, '')}`;
  const here = `${proto}://${externalHost}${pathname}${request.nextUrl.search}`;

  const token = request.cookies.get('auth-token')?.value;
  const user = token ? await validateJWT(token) : null;

  // --- Transfer token arrival ---
  // After login the main site redirects here with ?auth_token=TRANSFER_TOKEN&state=RANDOM.
  // We do NOT exchange the token in middleware because Set-Cookie on a 307
  // redirect response is unreliable across browsers/proxies. Instead, we let the
  // page render so client-side JS can call POST /api/auth/token-exchange.
  const authTokenParam = request.nextUrl.searchParams.get('auth_token');
  if (authTokenParam && !user) {
    const response = NextResponse.next();
    response.headers.set('x-needs-token-exchange', '1');
    return securityHeaders(response);
  }

  // Already signed in but leftover auth params: redirect to the clean URL.
  if (authTokenParam && user) {
    const cleanParams = new URLSearchParams(request.nextUrl.search);
    cleanParams.delete('auth_token');
    cleanParams.delete('state');
    const qs = cleanParams.toString();
    return NextResponse.redirect(new URL(`${proto}://${externalHost}${pathname}${qs ? '?' + qs : ''}`));
  }

  if (!user) {
    const loginUrl = new URL('/auth/login', mainSite);
    loginUrl.searchParams.set('redirect', here);
    return NextResponse.redirect(loginUrl);
  }

  // Signed in without a workspace yet: finish onboarding on the main site.
  if (!user.subdomain) {
    const onboardingUrl = new URL('/', mainSite);
    onboardingUrl.searchParams.set('step', 'subdomain');
    return NextResponse.redirect(onboardingUrl);
  }

  const response = NextResponse.next();
  response.headers.set('x-subdomain', user.subdomain);
  response.headers.set('x-tenant-id', user.tenantId || '');
  response.headers.set('x-user-id', user.userId);
  return securityHeaders(response);
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
