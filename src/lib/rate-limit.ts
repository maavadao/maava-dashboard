/**
 * In-memory rate limiter for Next.js API routes.
 *
 * Uses a sliding window counter per IP/key. Suitable for single-instance
 * deployments; for multi-instance, swap with Redis-based rate limiting.
 */

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const store = new Map<string, RateLimitEntry>();

/** Clean up expired entries periodically (every 60s) */
let cleanupTimer: ReturnType<typeof setInterval> | null = null;
function ensureCleanup() {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    const now = Date.now();
    store.forEach((entry, key) => {
      if (entry.resetAt <= now) {
        store.delete(key);
      }
    });
  }, 60_000);
  // Don't block process exit
  if (cleanupTimer && typeof cleanupTimer === "object" && "unref" in cleanupTimer) {
    cleanupTimer.unref();
  }
}

export interface RateLimitConfig {
  /** Maximum number of requests per window */
  max: number;
  /** Window size in seconds */
  windowSec: number;
  /** Prefix for the key (e.g. "provision", "import") */
  prefix: string;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

/**
 * Check if a request is within the rate limit.
 *
 * @param key - Unique identifier (typically IP address or userId)
 * @param config - Rate limit configuration
 * @returns Whether the request is allowed and remaining quota
 */
export function checkRateLimit(key: string, config: RateLimitConfig): RateLimitResult {
  ensureCleanup();

  const storeKey = `${config.prefix}:${key}`;
  const now = Date.now();

  const entry = store.get(storeKey);
  if (!entry || entry.resetAt <= now) {
    // New window
    const resetAt = now + config.windowSec * 1000;
    store.set(storeKey, { count: 1, resetAt });
    return { allowed: true, remaining: config.max - 1, resetAt };
  }

  if (entry.count >= config.max) {
    return { allowed: false, remaining: 0, resetAt: entry.resetAt };
  }

  entry.count++;
  return { allowed: true, remaining: config.max - entry.count, resetAt: entry.resetAt };
}

/** Pre-configured rate limits for different endpoints */
export const RATE_LIMITS = {
  /** Provisioning: 3 attempts per hour (per user) */
  provision: { max: 3, windowSec: 3600, prefix: "provision" } as RateLimitConfig,
  /** Import: 10 per hour */
  import: { max: 10, windowSec: 3600, prefix: "import" } as RateLimitConfig,
  /** Export: 20 per hour */
  export: { max: 20, windowSec: 3600, prefix: "export" } as RateLimitConfig,
  /** Subdomain check: 30 per minute */
  subdomainCheck: { max: 30, windowSec: 60, prefix: "subdomain-check" } as RateLimitConfig,
  /** Auth: 10 per minute */
  auth: { max: 10, windowSec: 60, prefix: "auth" } as RateLimitConfig,
  /** General API proxy: 120 per minute */
  proxy: { max: 120, windowSec: 60, prefix: "proxy" } as RateLimitConfig,
} as const;
