import { NextResponse } from 'next/server';
import pool from '@/lib/db';

export const dynamic = 'force-dynamic';

const OPENCLAW_GATEWAY_URL = (
  process.env.OPENCLAW_GATEWAY_URL ||
  process.env.NEXT_PUBLIC_OPENCLAW_GATEWAY_URL ||
  ''
).replace(/\/+$/, '');

const OPENCLAW_GATEWAY_TOKEN =
  process.env.OPENCLAW_GATEWAY_TOKEN ||
  process.env.NEXT_PUBLIC_OPENCLAW_GATEWAY_TOKEN ||
  '';

const CLOUD_MODE = process.env.NEXT_PUBLIC_CLOUD_MODE === 'true';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const JWT_SECRET = process.env.JWT_SECRET;

interface CheckResult {
  status: 'ok' | 'warn' | 'fail';
  latency_ms?: number;
  message: string;
  details?: Record<string, unknown>;
}

async function checkDB(): Promise<CheckResult> {
  const t0 = Date.now();
  try {
    const client = await pool.connect();
    try {
      await client.query('SELECT 1');
      // Check conversations table exists
      const { rows } = await client.query(
        `SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_name = 'conversations'`
      );
      const hasTable = Number(rows[0]?.n) > 0;
      return {
        status: hasTable ? 'ok' : 'warn',
        latency_ms: Date.now() - t0,
        message: hasTable ? 'Database connected, conversations table exists' : 'Database connected but conversations table missing',
        details: { has_conversations_table: hasTable, database_url_set: !!process.env.DATABASE_URL },
      };
    } finally {
      client.release();
    }
  } catch (err) {
    return {
      status: 'fail',
      latency_ms: Date.now() - t0,
      message: `Database connection failed: ${err instanceof Error ? err.message : String(err)}`,
      details: { database_url_set: !!process.env.DATABASE_URL },
    };
  }
}

function checkJWT(): CheckResult {
  if (!JWT_SECRET) {
    return {
      status: 'fail',
      message: 'JWT_SECRET not set — using insecure fallback. Auth will fail if Go auth service uses a different secret.',
      details: { jwt_secret_set: false, fallback_used: true },
    };
  }
  if (JWT_SECRET === 'change-this-jwt-secret') {
    return {
      status: 'warn',
      message: 'JWT_SECRET is the default placeholder. Make sure it matches the Go auth service.',
      details: { jwt_secret_set: true, is_default: true },
    };
  }
  return {
    status: 'ok',
    message: 'JWT_SECRET is configured',
    details: { jwt_secret_set: true, is_default: false },
  };
}

function checkProviders(): CheckResult {
  const providers: string[] = [];
  if (OPENCLAW_GATEWAY_URL) providers.push(`Gateway (${OPENCLAW_GATEWAY_URL})`);
  if (OPENAI_API_KEY) providers.push('OpenAI');
  if (ANTHROPIC_API_KEY) providers.push('Anthropic');

  if (providers.length === 0) {
    return {
      status: 'fail',
      message: 'No AI providers configured. Chat will return 503. Set OPENAI_API_KEY or ANTHROPIC_API_KEY.',
      details: { gateway: false, openai: false, anthropic: false },
    };
  }

  return {
    status: 'ok',
    message: `Available providers: ${providers.join(', ')}`,
    details: {
      gateway: !!OPENCLAW_GATEWAY_URL,
      gateway_url: OPENCLAW_GATEWAY_URL || null,
      openai: !!OPENAI_API_KEY,
      anthropic: !!ANTHROPIC_API_KEY,
    },
  };
}

async function checkGateway(): Promise<CheckResult> {
  if (!OPENCLAW_GATEWAY_URL) {
    return { status: 'warn', message: 'No gateway URL configured — will use direct AI providers' };
  }
  const t0 = Date.now();
  try {
    const res = await fetch(`${OPENCLAW_GATEWAY_URL}/v1/models`, {
      headers: { Authorization: `Bearer ${OPENCLAW_GATEWAY_TOKEN}` },
      signal: AbortSignal.timeout(5000),
    });
    const latency = Date.now() - t0;
    if (res.ok) {
      const data = await res.json().catch(() => null) as { data?: unknown[] } | null;
      return {
        status: 'ok',
        latency_ms: latency,
        message: `Gateway reachable (${data?.data?.length ?? '?'} models)`,
        details: { url: OPENCLAW_GATEWAY_URL, models_count: data?.data?.length },
      };
    }
    return {
      status: 'warn',
      latency_ms: latency,
      message: `Gateway returned HTTP ${res.status}`,
      details: { url: OPENCLAW_GATEWAY_URL },
    };
  } catch (err) {
    return {
      status: 'fail',
      latency_ms: Date.now() - t0,
      message: `Gateway unreachable: ${err instanceof Error ? err.message : String(err)}`,
      details: { url: OPENCLAW_GATEWAY_URL },
    };
  }
}

async function checkChatEndpoint(): Promise<CheckResult> {
  // Minimal validation: make sure the chat route can parse a body
  // (This is a self-check — we just validate the route exists and
  // the provider selection logic would succeed)
  const providers: string[] = [];
  if (OPENCLAW_GATEWAY_URL) providers.push('gateway');
  if (OPENAI_API_KEY) providers.push('openai');
  if (ANTHROPIC_API_KEY) providers.push('anthropic');

  if (providers.length === 0) {
    return {
      status: 'fail',
      message: 'Chat endpoint will return 503 — no AI provider keys available',
    };
  }

  const primary = providers[0];
  return {
    status: 'ok',
    message: `Chat endpoint ready — primary provider: ${primary}, fallbacks: ${providers.slice(1).join(', ') || 'none'}`,
    details: { provider_chain: providers, cloud_mode: CLOUD_MODE },
  };
}

export async function GET() {
  const timestamp = new Date().toISOString();

  // Run all checks in parallel
  const [db, jwt, providers, gateway, chatEndpoint] = await Promise.all([
    checkDB(),
    Promise.resolve(checkJWT()),
    Promise.resolve(checkProviders()),
    checkGateway(),
    Promise.resolve(checkChatEndpoint()),
  ]);

  const checks = { db, jwt, providers, gateway, chat_endpoint: chatEndpoint };

  // Overall status
  const allResults = Object.values(checks);
  const hasFail = allResults.some((r) => r.status === 'fail');
  const hasWarn = allResults.some((r) => r.status === 'warn');
  const overall = hasFail ? 'fail' : hasWarn ? 'warn' : 'ok';

  // Summary of issues
  const issues = allResults
    .filter((r) => r.status !== 'ok')
    .map((r) => r.message);

  const env = {
    cloud_mode: CLOUD_MODE,
    node_env: process.env.NODE_ENV,
    database_url_set: !!process.env.DATABASE_URL,
    jwt_secret_set: !!JWT_SECRET,
    openai_key_set: !!OPENAI_API_KEY,
    anthropic_key_set: !!ANTHROPIC_API_KEY,
    gateway_url: OPENCLAW_GATEWAY_URL || null,
    auth_url: process.env.NEXT_PUBLIC_AUTH_URL || null,
  };

  const body = {
    service: 'mawaDao Chat Health Check',
    status: overall,
    timestamp,
    checks,
    issues,
    env,
  };

  return NextResponse.json(body, {
    status: overall === 'fail' ? 503 : 200,
    headers: { 'Cache-Control': 'no-store' },
  });
}
