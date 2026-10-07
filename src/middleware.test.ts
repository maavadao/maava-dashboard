import { describe, test, expect, vi, beforeAll, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const validateJWT = vi.fn();
vi.mock('@/lib/jwt', () => ({ validateJWT: (...args: unknown[]) => validateJWT(...args) }));

type Middleware = (req: NextRequest) => Promise<Response>;
let middleware: Middleware;

const member = { userId: 'user-1', email: 'alice@example.com', subdomain: 'alice', tenantId: 'tenant-1' };

function request(path: string, opts: { cookie?: boolean } = {}) {
  const req = new NextRequest(new URL(`https://agent.mawadao.com${path}`), {
    headers: new Headers({ 'x-forwarded-host': 'agent.mawadao.com', 'x-forwarded-proto': 'https' }),
  });
  if (opts.cookie) req.cookies.set('auth-token', 'jwt');
  return req;
}

beforeAll(async () => {
  // CLOUD_MODE is read when the module loads.
  process.env.NEXT_PUBLIC_CLOUD_MODE = 'true';
  process.env.NEXT_PUBLIC_ROOT_DOMAIN = 'mawadao.com';
  ({ middleware } = await import('./middleware'));
});

beforeEach(() => validateJWT.mockReset());

describe('member space middleware', () => {
  test('sends visitors without a session to login on the main site', async () => {
    const res = await middleware(request('/channels?tab=slack'));
    expect(res.status).toBe(307);
    const location = new URL(res.headers.get('location')!);
    expect(location.origin).toBe('https://mawadao.com');
    expect(location.pathname).toBe('/auth/login');
    expect(location.searchParams.get('redirect')).toBe('https://agent.mawadao.com/channels?tab=slack');
  });

  test('lets the page exchange a transfer token', async () => {
    const res = await middleware(request('/?auth_token=xfer&state=abc'));
    expect(res.status).toBe(200);
    expect(res.headers.get('x-needs-token-exchange')).toBe('1');
  });

  test('strips leftover transfer params once signed in', async () => {
    validateJWT.mockResolvedValue(member);
    const res = await middleware(request('/?auth_token=old&state=x&tab=1', { cookie: true }));
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('https://agent.mawadao.com/?tab=1');
  });

  test('takes the tenant from the session, not the host', async () => {
    validateJWT.mockResolvedValue(member);
    const res = await middleware(request('/', { cookie: true }));
    expect(res.status).toBe(200);
    expect(res.headers.get('x-subdomain')).toBe('alice');
    expect(res.headers.get('x-tenant-id')).toBe('tenant-1');
    expect(res.headers.get('x-user-id')).toBe('user-1');
  });

  test('sends members without a workspace to onboarding on the main site', async () => {
    validateJWT.mockResolvedValue({ ...member, subdomain: null, tenantId: null });
    const res = await middleware(request('/', { cookie: true }));
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('https://mawadao.com/?step=subdomain');
  });

  test('does not gate the sign-in callback', async () => {
    const res = await middleware(request('/auth/callback?code=1'));
    expect(res.status).toBe(200);
    expect(validateJWT).not.toHaveBeenCalled();
  });
});
