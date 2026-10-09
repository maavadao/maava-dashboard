/**
 * Config access via the maava-storage HTTP service.
 *
 * All user configs live in a single shared GCS bucket:
 *   {SHARED_BUCKET}/{userId}/mountfolder/openclaw.json
 *
 * The maava-storage service holds the GCS credentials and exposes a simple
 * REST API so the dashboard never needs direct GCS SDK access.
 */

const STORAGE_URL = process.env.STORAGE_URL || "";
const STORAGE_API_SECRET = process.env.STORAGE_API_SECRET || "";
export const SHARED_BUCKET =
  process.env.GCS_SHARED_BUCKET || "maava-data";

/**
 * On Cloud Run, fetch a short-lived OIDC identity token from the metadata server.
 * This is required to call other Cloud Run services that do NOT have --allow-unauthenticated.
 * Returns null on failure (local dev, or metadata server unavailable).
 */
async function getCloudRunIdentityToken(audience: string): Promise<string | null> {
  // K_SERVICE is set by Cloud Run — skip on local dev
  if (!process.env.K_SERVICE) return null;
  try {
    const metaUrl =
      `http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity` +
      `?audience=${encodeURIComponent(audience)}`;
    const res = await fetch(metaUrl, {
      headers: { "Metadata-Flavor": "Google" },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    return (await res.text()).trim();
  } catch {
    return null;
  }
}

async function bmHeaders(): Promise<Record<string, string>> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (STORAGE_API_SECRET) h["X-Storage-Secret"] = STORAGE_API_SECRET;
  // Attach OIDC identity token so Cloud Run IAM auth is satisfied
  const token = await getCloudRunIdentityToken(STORAGE_URL);
  if (token) h["Authorization"] = `Bearer ${token}`;
  return h;
}

/** Default openclaw.json template used as a fallback when config is unreachable. */
export const DEFAULT_GATEWAY_CONFIG = {
  meta: {
    version: '1.0.0',
    createdAt: '',
  },
  gateway: {
    auth: {
      token: '',
    },
    http: {
      endpoints: {
        chatCompletions: { enabled: true },
      },
    },
    reload: {
      mode: 'debounce',
      debounceMs: 500,
    },
    nodes: {
      browser: false,
    },
  },
  agents: {
    defaults: {
      workspace: '~/.openclaw',
      models: ['openclaw'],
      memorySearch: true,
    },
    list: [],
  },
  channels: {
    defaults: {
      groupPolicy: 'disabled',
      heartbeat: false,
    },
  },
  skills: {
    load: {
      watch: true,
      watchDebounceMs: 500,
    },
  },
  tools: {
    web: { enabled: true },
    exec: { enabled: false },
  },
  memory: {
    backend: 'sqlite',
    citations: true,
  },
};

/**
 * Read a user's openclaw.json from the shared GCS bucket.
 * Returns null when maava-storage is unreachable or the file does not exist.
 */
export async function readUserConfig(userId: string): Promise<unknown | null> {
  if (!STORAGE_URL) return null;
  const filePath = `${userId}/mountfolder/openclaw.json`;
  try {
    const res = await fetch(
      `${STORAGE_URL}/api/v1/buckets/${encodeURIComponent(SHARED_BUCKET)}/files/${filePath}`,
      { headers: await bmHeaders(), signal: AbortSignal.timeout(10_000) }
    );
    if (!res.ok) return null;
    return (await res.json()) as unknown;
  } catch {
    return null;
  }
}

/**
 * Write a user's openclaw.json to the shared GCS bucket.
 * Throws on failure so callers can surface the error.
 */
export async function writeUserConfig(userId: string, data: unknown): Promise<void> {
  if (!STORAGE_URL) {
    throw new Error("STORAGE_URL is not configured");
  }
  const filePath = `${userId}/mountfolder/openclaw.json`;
  const res = await fetch(
    `${STORAGE_URL}/api/v1/buckets/${encodeURIComponent(SHARED_BUCKET)}/files/${filePath}`,
    {
      method: "PUT",
      headers: await bmHeaders(),
      body: JSON.stringify(data, null, 2),
      signal: AbortSignal.timeout(15_000),
    }
  );
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`maava-storage write failed (HTTP ${res.status}): ${body}`);
  }
}

/**
 * No-op — config seeding is done by maava-deployer at provisioning time.
 * Kept for backward compatibility with token-exchange route.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function initUserConfig(_username: string): Promise<void> {
  // Intentional no-op: openclaw.json is seeded by maava-deployer/seedTenantBucketConfig
}
