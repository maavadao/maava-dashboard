import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, createJWT } from '@/lib/auth';
import { resolveTenantBackendByUserId, type TenantInfo } from '@/lib/tenant-lookup';

/**
 * POST /api/mission-control/gateway-bootstrap
 *
 * Bootstraps the Mission Control org for the authenticated user and registers
 * the maava gateway pointing at THIS user's per-tenant `tenant-platform`
 * Cloud Run service.
 *
 * Each user has their own tenant-platform Cloud Run instance (one container
 * per user, see the `tenants` table). MC therefore needs one Gateway row per
 * MC user/org, with:
 *
 *   - url:              `tenants.backend_url`            (per-user HTTPS URL)
 *   - token:            short-lived JWT signed with the shared `JWT_SECRET`
 *                       so tenant-platform's cloud-auth middleware accepts it
 *   - integration_mode: `rest_bridge` so MC dispatches RPC calls over HTTPS
 *                       (POST /api/v1/rpc/:method) instead of WebSocket v3
 *
 * The token is refreshed on every bootstrap call (the dashboard layout calls
 * this on every Mission Control page mount), so we don't need a separate
 * rotation worker — it naturally stays well within the 7-day expiry.
 */

const MC_BACKEND_URL = process.env.MISSION_CONTROL_API_URL || 'http://localhost:8000';
const MC_AUTH_TOKEN = process.env.MISSION_CONTROL_AUTH_TOKEN || '';
const GATEWAY_NAME_PREFIX = 'tenant-platform';
const GATEWAY_TOKEN_TTL = '7d';

async function mcFetch<T>(
  path: string,
  userId: string,
  init?: RequestInit
): Promise<{ data: T | null; status: number; bodyText?: string }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'X-Forwarded-User-Id': userId,
  };
  if (MC_AUTH_TOKEN) {
    headers['Authorization'] = `Bearer ${MC_AUTH_TOKEN}`;
  }

  const res = await fetch(`${MC_BACKEND_URL}/api/v1${path}`, {
    ...init,
    headers: { ...headers, ...(init?.headers || {}) },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    console.error(`[gateway-bootstrap] MC ${res.status} ${path}: ${text}`);
    return { data: null, status: res.status, bodyText: text };
  }
  return { data: (await res.json()) as T, status: res.status };
}

interface MCUser {
  id: string;
  email: string;
  name: string;
}

interface MCGateway {
  id: string;
  name: string;
  url: string;
  organization_id: string;
  integration_mode?: string;
}

interface MCGatewayList {
  items: MCGateway[];
  total: number;
}

function buildGatewayName(tenant: TenantInfo): string {
  const subdomain = tenant.subdomain?.trim();
  return subdomain ? `${GATEWAY_NAME_PREFIX}:${subdomain}` : GATEWAY_NAME_PREFIX;
}

async function mintTenantPlatformToken(
  userId: string,
  email: string,
  tenant: TenantInfo,
): Promise<string> {
  return createJWT(
    {
      userId,
      email,
      subdomain: tenant.subdomain || null,
      tenantId: tenant.tenantId || null,
    },
    GATEWAY_TOKEN_TTL,
  );
}

export async function POST(request: NextRequest) {
  // Resolve the authenticated user (we need email + subdomain for the JWT).
  const user = await authenticateRequest(request);
  if (!user || !user.userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const userId = user.userId;
  const userEmail = user.email || '';

  const results: Record<string, unknown> = { userId };

  // Step 1: Ensure an MC user + organization exists for this caller.
  const { data: mcUser } = await mcFetch<MCUser>('/auth/bootstrap', userId, {
    method: 'POST',
    body: '{}',
  });
  if (!mcUser) {
    return NextResponse.json(
      { error: 'Failed to bootstrap MC user', ...results },
      { status: 502 }
    );
  }
  results.mcUser = { id: mcUser.id, name: mcUser.name };

  // Step 2: Look up the user's per-tenant Cloud Run backend.
  const tenant = await resolveTenantBackendByUserId(userId);
  if (!tenant || !tenant.backendUrl) {
    results.status = 'no_tenant_provisioned';
    results.hint =
      'No active tenants row was found for this user. Provision a tenant-platform first.';
    return NextResponse.json(results, { status: 200 });
  }
  results.tenant = {
    id: tenant.tenantId,
    subdomain: tenant.subdomain,
    backendUrl: tenant.backendUrl,
  };

  // Step 3: Mint a fresh JWT that tenant-platform's cloud-auth middleware
  // will accept (issuer + HS256 + JWT_SECRET shared via Cloud Run secret).
  let bridgeToken: string;
  try {
    bridgeToken = await mintTenantPlatformToken(userId, userEmail, tenant);
  } catch (err) {
    console.error('[gateway-bootstrap] JWT mint failed:', err);
    return NextResponse.json(
      { error: 'Failed to mint tenant-platform JWT', ...results },
      { status: 500 }
    );
  }

  const desiredName = buildGatewayName(tenant);
  const desiredPayload = {
    name: desiredName,
    url: tenant.backendUrl,
    token: bridgeToken,
    workspace_root: '/app/workspace-main',
    allow_insecure_tls: false,
    disable_device_pairing: true,
    integration_mode: 'rest_bridge',
  } as const;

  // Step 4: Reconcile the MC Gateway row.
  const { data: gateways } = await mcFetch<MCGatewayList>('/gateways?limit=10', userId);
  const existing = gateways?.items?.find(
    (g) => g.name === desiredName || g.url === tenant.backendUrl,
  );

  if (existing) {
    // Always refresh the token (rotates on every page mount) and keep url/mode in sync.
    const { data: patched } = await mcFetch<MCGateway>(
      `/gateways/${existing.id}`,
      userId,
      {
        method: 'PATCH',
        body: JSON.stringify({
          name: desiredName,
          url: tenant.backendUrl,
          token: bridgeToken,
          integration_mode: 'rest_bridge',
          allow_insecure_tls: false,
          disable_device_pairing: true,
        }),
      },
    );
    if (!patched) {
      results.status = 'gateway_update_failed';
      return NextResponse.json(results, { status: 502 });
    }
    results.gateway = { id: patched.id, name: patched.name, url: patched.url };
    results.status = 'updated';
    return NextResponse.json(results);
  }

  const { data: created, bodyText } = await mcFetch<MCGateway>(
    '/gateways',
    userId,
    {
      method: 'POST',
      body: JSON.stringify(desiredPayload),
    },
  );

  if (!created) {
    results.status = 'gateway_registration_failed';
    if (bodyText) results.error = bodyText;
    return NextResponse.json(results, { status: 502 });
  }

  results.gateway = { id: created.id, name: created.name, url: created.url };
  results.status = 'registered';

  return NextResponse.json(results);
}
