import { NextResponse } from 'next/server';
import pool from '@/lib/db';

export const dynamic = 'force-dynamic';

const GATEWAY_URL = (
  process.env.GATEWAY_URL ||
  process.env.NEXT_PUBLIC_GATEWAY_URL ||
  ''
).replace(/\/+$/, '');

interface HealthComponent {
  status: 'ok' | 'degraded' | 'down';
  latency_ms?: number;
  error?: string;
  details?: Record<string, unknown>;
}

const CLOUD_MODE = process.env.NEXT_PUBLIC_CLOUD_MODE === 'true';

export async function GET() {
  const timestamp = new Date().toISOString();

  // 1. Database check
  const db: HealthComponent = { status: 'down' };
  const dbT0 = Date.now();
  try {
    const client = await pool.connect();
    try {
      await client.query('SELECT 1');
      db.status = 'ok';
      db.latency_ms = Date.now() - dbT0;
    } finally {
      client.release();
    }
  } catch (err) {
    db.latency_ms = Date.now() - dbT0;
    db.error = err instanceof Error ? err.message : String(err);
  }

  // 2. Gateway check (local mode only) / Providers check (cloud mode)
  const gateway: HealthComponent = { status: 'down', details: { url: GATEWAY_URL } };
  const providers: HealthComponent = { status: 'down' };

  if (CLOUD_MODE) {
    // In cloud mode, check provider connectivity instead of gateway
    const connectedProviders: string[] = [];
    if (process.env.OPENAI_API_KEY) connectedProviders.push('openai');
    if (process.env.ANTHROPIC_API_KEY) connectedProviders.push('anthropic');

    if (connectedProviders.length > 0) {
      providers.status = 'ok';
      providers.details = { connected: connectedProviders };
    } else {
      providers.error = 'No AI provider keys configured';
    }
  } else {
    if (GATEWAY_URL) {
      const gT0 = Date.now();
      try {
        const res = await fetch(`${GATEWAY_URL}/v1/models`, {
          signal: AbortSignal.timeout(5000),
        });
        gateway.latency_ms = Date.now() - gT0;
        if (res.ok) {
          gateway.status = 'ok';
          const data = await res.json().catch(() => null);
          if (data?.data) {
            gateway.details!.models_count = data.data.length;
          }
        } else {
          gateway.status = 'degraded';
          gateway.error = `HTTP ${res.status}`;
        }
      } catch (err) {
        gateway.latency_ms = Date.now() - gT0;
        gateway.error = err instanceof Error ? err.message : String(err);
      }
    } else {
      gateway.error = 'No gateway URL configured';
    }
  }

  // 3. GCS check
  const gcs: HealthComponent = { status: 'down' };
  try {
    const { Storage } = await import('@google-cloud/storage');
    const storage = new Storage({
      projectId: process.env.GOOGLE_CLOUD_PROJECT || process.env.GCP_PROJECT_ID || 'mawadao',
    });
    const gcsT0 = Date.now();
    // Lightweight check — just list 1 bucket
    await storage.getBuckets({ maxResults: 1 });
    gcs.latency_ms = Date.now() - gcsT0;
    gcs.status = 'ok';
  } catch (err) {
    gcs.error = err instanceof Error ? err.message : String(err);
  }

  // 4. Environment summary
  const env = {
    cloud_mode: process.env.NEXT_PUBLIC_CLOUD_MODE === 'true',
    gateway_url: GATEWAY_URL || null,
    openai_key_set: !!process.env.OPENAI_API_KEY,
    anthropic_key_set: !!process.env.ANTHROPIC_API_KEY,
    database_url_set: !!process.env.DATABASE_URL,
    gcs_project: process.env.GOOGLE_CLOUD_PROJECT || process.env.GCP_PROJECT_ID || 'mawadao',
    node_version: process.version,
    commit: process.env.COMMIT_SHA ?? '(unknown)',
  };

  // Overall status
  const components = CLOUD_MODE
    ? { db, providers, gcs }
    : { db, gateway, gcs };
  const allStatuses = Object.values(components).map((c) => c.status);
  const overall = allStatuses.every((s) => s === 'ok')
    ? 'ok'
    : allStatuses.some((s) => s === 'ok')
      ? 'degraded'
      : 'down';

  const body = {
    service: 'maavaDao Tenant Dashboard — maava Health',
    status: overall,
    timestamp,
    components,
    env,
  };

  return NextResponse.json(body, { status: overall === 'down' ? 503 : 200 });
}
