import Redis from 'ioredis';

// Singleton Redis client for tenant routing cache.
// Falls back gracefully — if Redis is unavailable, callers fall through to DB.

let redis: Redis | null = null;

function getRedis(): Redis | null {
  if (!process.env.REDIS_URL) return null;
  if (!redis) {
    redis = new Redis(process.env.REDIS_URL, {
      maxRetriesPerRequest: 1,
      connectTimeout: 3000,
      lazyConnect: true,
    });
    redis.on('error', (err) => {
      console.error('[redis] Connection error:', err.message);
    });
  }
  return redis;
}

const SUBDOMAIN_PREFIX = 'subdomain:';
const DEFAULT_TTL = 3600; // 1 hour

/**
 * Look up a cached backend URL by subdomain.
 * Returns null on cache miss or if Redis is unavailable.
 */
export async function getCachedBackendUrl(subdomain: string): Promise<string | null> {
  const client = getRedis();
  if (!client) return null;
  try {
    return await client.get(`${SUBDOMAIN_PREFIX}${subdomain}`);
  } catch {
    return null;
  }
}

/**
 * Cache a subdomain → backend URL mapping.
 */
export async function cacheBackendUrl(subdomain: string, url: string, ttl = DEFAULT_TTL): Promise<void> {
  const client = getRedis();
  if (!client) return;
  try {
    await client.set(`${SUBDOMAIN_PREFIX}${subdomain}`, url, 'EX', ttl);
  } catch {
    // Non-critical — next request will just query DB
  }
}

/**
 * Invalidate a cached subdomain mapping (e.g. on tenant deletion or backend URL change).
 */
export async function invalidateBackendUrl(subdomain: string): Promise<void> {
  const client = getRedis();
  if (!client) return;
  try {
    await client.del(`${SUBDOMAIN_PREFIX}${subdomain}`);
  } catch {
    // Non-critical
  }
}
