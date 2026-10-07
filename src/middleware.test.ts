import { describe, test, expect, vi, beforeAll, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const validateJWT = vi.fn();
const validateTransferToken = vi.fn();
vi.mock('@/lib/jwt', () => ({
  validateJWT: (...args: unknown[]) => validateJWT(...args),
  validateTransferToken: (...args: unknown[]) => validateTransferToken(...args),
}));

type Middleware = (req: NextRequest) => Promise<Response>;
let middleware: Middleware;

const alice = { userId: 'user-1', email: 'alice@example.com', subdomain: 'alice', tenantId: 'tenant-1' };

function request(path: string, opts: { cookie?: boolean } = {}) {
  const req = new NextRequest(new URL(`https://agent.mawadao.com${path}`), {
    headers: new Headers({ 'x-forwarded-host': 'agent.mawadao.com', 'x-forwarded-proto': 'https' }),
  });
  if (opts.cookie) req.cookies.set('auth-token', 'jwt');
  return req;
}

const location = (res: Response) => res.headers.get('location');

beforeAll(async () => {
  // CLOUD_MODE is read when the module loads.
  process.env.NEXT_PUBLIC_CLOUD_MODE = 'true';
  process.env.NEXT_PUBLIC_ROOT_DOMAIN = 'mawadao.com';
  ({ middleware } = await import('./middleware'));
});

beforeEach(() => {
  validateJWT.mockReset();
  validateTransferToken.mockReset();
});

describe('member space at agent.mawadao.com/<username>', () => {
  test('sends visitors without a session to login on the main site', async () => {
    const res = await middleware(request('/alice/channels?tab=slack'));
    expect(res.status).toBe(307);
    const url = new URL(location(res)!);
    expect(url.origin).toBe('https://mawadao.com');
    expect(url.pathname).toBe('/auth/login');
    expect(url.searchParams.get('redirect')).toBe('https://agent.mawadao.com/alice/channels?tab=slack');
  });

  test('opens the member’s own space with tenant headers', async () => {
    validateJWT.mockResolvedValue(alice);
    const res = await middleware(request('/alice/channels', { cookie: true }));
    expect(res.status).toBe(200);
    expect(res.headers.get('x-subdomain')).toBe('alice');
    expect(res.headers.get('x-tenant-id')).toBe('tenant-1');
    expect(res.headers.get('x-user-id')).toBe('user-1');
  });

  test('sends the root to the member’s space', async () => {
    validateJWT.mockResolvedValue(alice);
    const res = await middleware(request('/', { cookie: true }));
    expect(location(res)).toBe('https://agent.mawadao.com/alice');
  });

  test('adds the username to section paths without one', async () => {
    validateJWT.mockResolvedValue(alice);
    const res = await middleware(request('/channels?success=slack_connected', { cookie: true }));
    expect(location(res)).toBe('https://agent.mawadao.com/alice/channels?success=slack_connected');
  });

  test('never shows another member’s space', async () => {
    validateJWT.mockResolvedValue(alice);
    const res = await middleware(request('/bob/settings', { cookie: true }));
    expect(location(res)).toBe('https://agent.mawadao.com/alice');
  });

  test('lets the page exchange a transfer token', async () => {
    const res = await middleware(request('/alice?auth_token=xfer&state=abc'));
    expect(res.status).toBe(200);
    expect(res.headers.get('x-needs-token-exchange')).toBe('1');
  });

  test('routes a transfer token that arrives at the root to its member', async () => {
    validateTransferToken.mockResolvedValue(alice);
    const res = await middleware(request('/?auth_token=xfer&state=abc'));
    expect(location(res)).toBe('https://agent.mawadao.com/alice?auth_token=xfer&state=abc');
  });

  test('strips leftover transfer params once signed in', async () => {
    validateJWT.mockResolvedValue(alice);
    const res = await middleware(request('/alice?auth_token=old&state=x&tab=1', { cookie: true }));
    expect(location(res)).toBe('https://agent.mawadao.com/alice?tab=1');
  });

  test('sends members without a workspace to onboarding on the main site', async () => {
    validateJWT.mockResolvedValue({ ...alice, subdomain: null, tenantId: null });
    const res = await middleware(request('/', { cookie: true }));
    expect(location(res)).toBe('https://mawadao.com/?step=subdomain');
  });

  test('does not gate the sign-in callback', async () => {
    const res = await middleware(request('/auth/callback?code=1'));
    expect(res.status).toBe(200);
    expect(validateJWT).not.toHaveBeenCalled();
  });
});
