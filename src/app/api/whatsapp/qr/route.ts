/**
 * POST /api/whatsapp/qr
 *
 * Resolves the tenant's OpenClaw gateway endpoint via DB (tenants.backend_url),
 * then calls the gateway's /api/v1/channels/login to obtain the WhatsApp QR code.
 * Forwards the user's auth-token JWT to the gateway for authentication.
 *
 * Returns: { success: boolean; qrDataUrl?: string; message: string; error?: string }
 */
import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequestOrApiKey } from '@/lib/auth';
import { resolveTenantBackend } from '@/lib/tenant-lookup';

const GCP_PROJECT_NUMBER = process.env.GCP_PROJECT_NUMBER || '';
const GCP_REGION = process.env.GCP_REGION || 'europe-west1';

interface GatewayInfo { url: string; tenantId: string; }

/** Resolve gateway URL and tenant ID for a subdomain */
async function resolveGateway(subdomain: string): Promise<GatewayInfo | null> {
  // 1. Tenant DB lookup (same pattern as ai-chat route)
  try {
    const tenant = await resolveTenantBackend(subdomain);
    if (tenant?.backendUrl) {
      return {
        url: tenant.backendUrl.replace(/\/+$/, ''),
        tenantId: tenant.tenantId,
      };
    }
  } catch { /* DB unavailable — fall through */ }

  // 2. Derive from Cloud Run naming convention
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
      { success: false, error: 'Not authenticated' },
      { status: 401 },
    );
  }

  // 2. The member's workspace comes from their session
  const subdomain = auth.user.subdomain;
  if (!subdomain) {
    return NextResponse.json(
      { success: false, error: 'No workspace for this account' },
      { status: 400 },
    );
  }

  // 3. Resolve gateway
  const gateway = await resolveGateway(subdomain);
  if (!gateway) {
    return NextResponse.json(
      {
        success: false,
        message: 'Gateway not configured. Deploy your agent instance first.',
        error: 'gateway_not_configured',
      },
      { status: 503 },
    );
  }

  // 4. Parse optional body (force flag)
  let body: { force?: boolean } = {};
  try {
    body = await request.json();
  } catch { /* no body is fine */ }

  // 5. Forward to gateway channels/login, passing the user's JWT
  try {
    const res = await fetch(`${gateway.url}/api/v1/channels/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${auth.authToken}`,
        ...(gateway.tenantId ? { 'X-Tenant-ID': gateway.tenantId } : {}),
      },
      body: JSON.stringify({ force: body.force ?? false }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => 'Unknown error');
      return NextResponse.json(
        { success: false, message: `Gateway returned ${res.status}`, error: errText },
        { status: res.status },
      );
    }

    const data = await res.json();
    const inner = data?.data ?? data;
    return NextResponse.json({
      success: true,
      qrDataUrl: inner?.qrDataUrl ?? inner?.qr ?? null,
      message: inner?.message ?? data?.message ?? 'QR requested',
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Gateway unreachable';
    return NextResponse.json(
      { success: false, message: `Gateway unreachable: ${msg}`, error: 'gateway_unreachable' },
      { status: 502 },
    );
  }
}
