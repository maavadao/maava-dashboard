import pool from '@/lib/db';
import { getCachedBackendUrl, cacheBackendUrl } from '@/lib/redis';

export interface TenantInfo {
  tenantId: string;
  userId: string;
  agentId: string | null;
  subdomain: string;
  backendUrl: string;
  storageBucket: string | null;
  region: string;
  gatewayToken: string | null;
}

/**
 * Resolve a subdomain to the tenant's backend URL.
 * Checks Redis cache first, falls back to PostgreSQL, then caches the result.
 * Returns null if no active tenant exists for this subdomain.
 */
export async function resolveTenantBackend(subdomain: string): Promise<TenantInfo | null> {
  if (!subdomain) return null;

  // 1. Check Redis cache for fast path
  const cached = await getCachedBackendUrl(subdomain);
  if (cached) {
    // Cache only stores backend_url; we still need full info for auth checks.
    // For performance, we can return a minimal object and let callers query DB if they need more.
    // But for the proxy route, backendUrl is all we need.
    // Query DB anyway to get full tenant info (still fast with index).
  }

  // 2. Query PostgreSQL
  try {
    const result = await pool.query(
      `SELECT id, user_id, agent_id, subdomain, backend_url, storage_bucket, region, gateway_token
       FROM tenants
       WHERE subdomain = $1 AND status = 'active'
       LIMIT 1`,
      [subdomain]
    );

    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    if (!row.backend_url) return null;

    const info: TenantInfo = {
      tenantId: row.id,
      userId: row.user_id,
      agentId: row.agent_id,
      subdomain: row.subdomain,
      backendUrl: row.backend_url,
      storageBucket: row.storage_bucket,
      region: row.region,
      gatewayToken: row.gateway_token ?? null,
    };

    // 3. Cache in Redis for subsequent requests
    await cacheBackendUrl(subdomain, row.backend_url);

    return info;
  } catch (err) {
    console.error('[tenant-lookup] DB query failed:', err);
    // If DB fails but we had a cache hit, return minimal info
    if (cached) {
      return {
        tenantId: '',
        userId: '',
        agentId: null,
        subdomain,
        backendUrl: cached,
        storageBucket: null,
        gatewayToken: null,
        region: 'europe-west1',
      };
    }
    return null;
  }
}

/**
 * Resolve the active tenant row for a given user id.
 *
 * Mirrors `resolveTenantBackend` but is keyed by `tenants.user_id` so callers
 * that already know the authenticated user (e.g. the Mission Control gateway
 * bootstrap route) can look up the user's per-tenant Cloud Run backend
 * without first having to know the subdomain.
 */
export async function resolveTenantBackendByUserId(userId: string): Promise<TenantInfo | null> {
  if (!userId) return null;
  try {
    const result = await pool.query(
      `SELECT id, user_id, agent_id, subdomain, backend_url, storage_bucket, region, gateway_token
       FROM tenants
       WHERE user_id = $1 AND status = 'active'
       ORDER BY created_at ASC NULLS LAST
       LIMIT 1`,
      [userId]
    );

    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    if (!row.backend_url) return null;

    return {
      tenantId: row.id,
      userId: row.user_id,
      agentId: row.agent_id,
      subdomain: row.subdomain,
      backendUrl: row.backend_url,
      storageBucket: row.storage_bucket,
      region: row.region,
      gatewayToken: row.gateway_token ?? null,
    };
  } catch (err) {
    console.error('[tenant-lookup] DB query (by user id) failed:', err);
    return null;
  }
}

/**
 * Check if a subdomain is owned by a specific user.
 */
export async function isSubdomainOwner(subdomain: string, userId: string): Promise<boolean> {
  try {
    const result = await pool.query(
      `SELECT 1 FROM tenants WHERE subdomain = $1 AND user_id = $2 AND status = 'active' LIMIT 1`,
      [subdomain, userId]
    );
    return result.rows.length > 0;
  } catch {
    return false;
  }
}

/**
 * Check if a subdomain is available for registration.
 */
export async function isSubdomainAvailable(subdomain: string): Promise<boolean> {
  try {
    const result = await pool.query(
      `SELECT 1 FROM tenants WHERE subdomain = $1 LIMIT 1`,
      [subdomain]
    );
    return result.rows.length === 0;
  } catch {
    return false;
  }
}
