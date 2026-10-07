import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { validateJWT, validateTransferToken } from '@/lib/jwt';

// The dashboard is the member space: agent.mawadao.com/<username>. Each member
// can only open their own space; the tenant comes from their JWT, and the
// username in the path must match it. Sign-in and onboarding happen on the main site.

// Cloud mode: when true, enables JWT auth
const CLOUD_MODE = process.env.NEXT_PUBLIC_CLOUD_MODE === 'true';

// Without sign-in (local development) the member space is served at /dev.
const LOCAL_USERNAME = 'dev';

// Top-level sections of the member space. A path starting with one of these has
// no /<username> prefix (old links, OAuth returns) and gets one added.
const SECTIONS = new Set([
  'c', 'channels', 'chat', 'health', 'inbox', 'integrations',
  'marketplace', 'mission-control', 'seller', 'settings',
]);

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

/** The path inside the member's space: "/alice/channels" → "/channels". */
function splitMemberPath(pathname: string): { first: string; rest: string } {
  const [, first = '', ...tail] = pathname.split('/');
  return { first, rest: tail.length ? `/${tail.join('/')}` : '' };
}

export async function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl;

  // /auth/* is the sign-in flow itself, so it can't require a session.
  if (pathname.startsWith('/auth')) {
    return securityHeaders(NextResponse.next());
  }

  const proto = resolveExternalProtocol(request);
  const origin = `${proto}://${resolveExternalHost(request)}`;
  const { first, rest } = splitMemberPath(pathname);
  const prefixed = first !== '' && !SECTIONS.has(first);

  if (!CLOUD_MODE) {
    if (!prefixed) {
      return NextResponse.redirect(new URL(`/${LOCAL_USERNAME}${pathname === '/' ? '' : pathname}${search}`, origin));
    }
    return securityHeaders(NextResponse.next());
  }

  const mainSite = `${proto}://${(process.env.NEXT_PUBLIC_ROOT_DOMAIN || 'mawadao.com').replace(/:\d+$/, '')}`;
  const token = request.cookies.get('auth-token')?.value;
  const user = token ? await validateJWT(token) : null;

  // --- Transfer token arrival ---
  // After login the main site redirects here with ?auth_token=TRANSFER_TOKEN&state=RANDOM.
  // We do NOT exchange the token in middleware because Set-Cookie on a 307
  // redirect response is unreliable across browsers/proxies. Instead, we let the
  // page render so client-side JS can call POST /api/auth/token-exchange.
  const authTokenParam = request.nextUrl.searchParams.get('auth_token');
  if (authTokenParam && !user) {
    // Arrived without a /<username> prefix: send the token to the member's space.
    if (!prefixed) {
      const transfer = await validateTransferToken(authTokenParam);
      if (transfer?.subdomain) {
        const target = `/${transfer.subdomain}${pathname === '/' ? '' : pathname}${search}`;
        return NextResponse.redirect(new URL(target, origin));
      }
    }
    const response = NextResponse.next();
    response.headers.set('x-needs-token-exchange', '1');
    return securityHeaders(response);
  }

  if (!user) {
    const loginUrl = new URL('/auth/login', mainSite);
    loginUrl.searchParams.set('redirect', `${origin}${pathname}${search}`);
    return NextResponse.redirect(loginUrl);
  }

  // Signed in without a workspace yet: finish onboarding on the main site.
  if (!user.subdomain) {
    const onboardingUrl = new URL('/', mainSite);
    onboardingUrl.searchParams.set('step', 'subdomain');
    return NextResponse.redirect(onboardingUrl);
  }

  const own = `/${user.subdomain}`;

  // "/" or an unprefixed section path → the same place in the member's own space.
  // Someone else's space → the member's own space.
  if (!prefixed || first !== user.subdomain) {
    const target = !prefixed ? `${own}${pathname === '/' ? '' : pathname}` : own;
    const params = new URLSearchParams(search);
    if (!prefixed) {
      params.delete('auth_token');
      params.delete('state');
    }
    const qs = prefixed ? '' : params.toString();
    return NextResponse.redirect(new URL(`${target}${qs ? '?' + qs : ''}`, origin));
  }

  // Already signed in but leftover transfer params: redirect to the clean URL.
  if (authTokenParam) {
    const params = new URLSearchParams(search);
    params.delete('auth_token');
    params.delete('state');
    const qs = params.toString();
    return NextResponse.redirect(new URL(`${own}${rest}${qs ? '?' + qs : ''}`, origin));
  }

  const response = NextResponse.next();
  response.headers.set('x-subdomain', user.subdomain);
  response.headers.set('x-tenant-id', user.tenantId || '');
  response.headers.set('x-user-id', user.userId);
  return securityHeaders(response);
}

export const config = {
  matcher: [
    // Every page; API routes, Next.js assets and root files are excluded.
    '/((?!api/|_next/|favicon|site\\.webmanifest).*)',
  ],
};
