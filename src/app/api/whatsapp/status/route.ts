/**
 * POST /api/whatsapp/status
 *
 * Resolves the tenant's mawaDao Agent gateway endpoint via DB (tenants.backend_url)
 * and returns the current WhatsApp channel connection status.
 * Forwards the user's auth-token JWT to the gateway for authentication.
 *
 * Returns: { success: boolean; connected: boolean; status: string; error?: string }
 */
import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequestOrApiKey } from '@/lib/auth';
import { resolveTenantBackend } from '@/lib/tenant-lookup';

const GCP_PROJECT_NUMBER = process.env.GCP_PROJECT_NUMBER || '';
const GCP_REGION = process.env.GCP_REGION || 'europe-west1';

interface GatewayInfo { url: string; tenantId: string; }

async function resolveGateway(subdomain: string): Promise<GatewayInfo | null> {
  try {
    const tenant = await resolveTenantBackend(subdomain);
    if (tenant?.backendUrl) {
      return {
        url: tenant.backendUrl.replace(/\/+$/, ''),
        tenantId: tenant.tenantId,
      };
    }
  } catch { /* DB unavailable — fall through */ }

  const safe = subdomain.toLowerCase().replace(/[^a-z0-9-]/g, '');
  if (safe) {
    return {
      url: `https://mawadao-${safe}-${GCP_PROJECT_NUMBER}.${GCP_REGION}.run.app`,
      tenantId: '',
    };
  }
  return null;
}

export async function POST(request: NextRequest) {
  // 1. Resolve auth from session JWT or mawaDao API key
  const auth = await authenticateRequestOrApiKey(request);
  if (!auth) {
    return NextResponse.json(
      { success: false, connected: false, error: 'Not authenticated' },
      { status: 401 },
    );
  }

  // 2. The member's workspace comes from their session
  const subdomain = auth.user.subdomain;
  if (!subdomain) {
    return NextResponse.json(
      { success: false, connected: false, error: 'No workspace for this account' },
      { status: 400 },
    );
  }

  const gateway = await resolveGateway(subdomain);
  if (!gateway) {
    return NextResponse.json(
      { success: false, connected: false, status: 'gateway_not_configured' },
      { status: 503 },
    );
  }

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${auth.authToken}`,
      ...(gateway.tenantId ? { 'X-Tenant-ID': gateway.tenantId } : {}),
    };

    const res = await fetch(`${gateway.url}/api/v1/channels/status`, {
      method: 'POST',
      headers,
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(8_000),
    });

    if (!res.ok) {
      return NextResponse.json({ success: false, connected: false, status: 'error' }, { status: res.status });
    }

    const data = await res.json();
    // Gateway response: { success: true, data: { channels: { whatsapp: { running, configured, ... } }, channelAccounts: { whatsapp: [...] } } }
    const inner = data?.data ?? data;
    const waChannel = inner?.channels?.whatsapp;
    const waAccounts: Array<Record<string, unknown>> = inner?.channelAccounts?.whatsapp ?? [];
    const defaultAccount = waAccounts.find((a) => a.accountId === 'default') ?? waAccounts[0];

    const connected =
      waChannel?.running === true ||
      defaultAccount?.running === true;
    const status = waChannel
      ? (waChannel.running ? 'connected' : 'disconnected')
      : 'not_configured';

    return NextResponse.json({
      success: true,
      connected,
      status,
    });
  } catch {
    return NextResponse.json({ success: false, connected: false, status: 'gateway_unreachable' }, { status: 502 });
  }
}
