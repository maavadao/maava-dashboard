/**
 * Syncs a user's active channel credentials from the database into their
 * openclaw.json stored in GCS, then notifies the running gateway to reload.
 *
 * Called after every channel save / delete / toggle so:
 *   1. The GCS file is authoritative on the next container restart.
 *   2. The live container picks up the change immediately via config.patch.
 *
 * Non-fatal — logs on failure without throwing so the API response is never
 * blocked by a GCS write error.
 */

import pool from '@/lib/db';
import { readUserConfig, writeUserConfig, DEFAULT_GATEWAY_CONFIG } from '@/lib/gcs';

// Strip trailing /api/v1 if already included in the env var
const _deployerBase = (
  process.env.DEPLOYER_URL ||
  'http://localhost:3002'
).replace(/\/api\/v1\/?$/, '');
const DEPLOYER_URL = _deployerBase;
// Support both secret env var names
const DEPLOYER_API_SECRET =
  process.env.DEPLOYER_API_SECRET ||
  process.env.DEPLOYER_API_SECRET ||
  '';

/** Channel types we manage in openclaw.json (token/credential-based only). */
const MANAGED_CHANNEL_TYPES = ['discord', 'telegram', 'slack', 'teams', 'whatsapp', 'signal', 'line', 'viber', 'web'];

type ChannelRow = {
  channel_type: string;
  credentials: unknown; // may arrive as parsed object OR JSON string from pg
  is_active: boolean;
};

/** Parse credentials whether pg returned an object or a JSON string. */
function parseCredentials(raw: unknown): Record<string, string> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, string>;
  }
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch { /* fall through */ }
  }
  return {};
}

/**
 * Map DB credential keys to the openclaw.json shape the gateway expects.
 * Only actual truthy values are included — undefined/empty fields are omitted
 * so the gateway schema validation doesn't reject the entry.
 */
function buildChannelEntry(
  channelType: string,
  credentials: Record<string, string>,
): Record<string, unknown> {
  const pick = (key: string) => credentials[key]?.trim() || undefined;

  switch (channelType) {
    case 'telegram':
      return {
        enabled: true,
        botToken: pick('botToken'),
        dmPolicy: 'open',
        groupPolicy: 'open',
        allowFrom: ['*'],
      };
    case 'discord': {
      const entry: Record<string, unknown> = {
        enabled: true,
        token: pick('token'),
        groupPolicy: 'open',
        dm: {
          enabled: true,
          policy: 'open',
          allowFrom: ['*'],
        },
      };
      if (pick('applicationId')) entry.applicationId = pick('applicationId');
      return entry;
    }
    case 'slack':
      return {
        enabled: true,
        botToken: pick('botToken'),
        appToken: pick('appToken'),
      };
    case 'teams': {
      const entry: Record<string, unknown> = {
        enabled: true,
        appId: pick('appId'),
        appPassword: pick('appPassword'),
      };
      if (pick('tenantId')) entry.tenantId = pick('tenantId');
      return entry;
    }
    case 'whatsapp':
      return {
        enabled: true,
        phoneNumberId: pick('phoneNumberId'),
        accessToken: pick('accessToken'),
        verifyToken: pick('verifyToken'),
        dm: {
          enabled: true,
          policy: 'open',
          allowFrom: ['*'],
        },
      };
    case 'signal':
      return {
        enabled: true,
        phoneNumber: pick('phoneNumber'),
        apiUrl: pick('apiUrl'),
        dm: {
          enabled: true,
          policy: 'open',
          allowFrom: ['*'],
        },
      };
    case 'line':
      return {
        enabled: true,
        channelAccessToken: pick('channelAccessToken'),
        channelSecret: pick('channelSecret'),
        dm: {
          enabled: true,
          policy: 'open',
          allowFrom: ['*'],
        },
      };
    case 'viber':
      return {
        enabled: true,
        authToken: pick('authToken'),
        botName: pick('botName'),
        dm: {
          enabled: true,
          policy: 'open',
          allowFrom: ['*'],
        },
      };
    default:
      // Generic: spread all non-empty credential values + mark enabled
      return {
        enabled: true,
        ...Object.fromEntries(
          Object.entries(credentials).filter(([, v]) => v?.trim()),
        ),
      };
  }
}

/**
 * Look up the live gateway URL for a user's subdomain.
 * Returns null when no matching agent is found.
 */
async function getGatewayUrl(subdomain: string | null | undefined): Promise<string | null> {
  if (!subdomain) return null;
  try {
    const result = await pool.query<{ runtime_endpoint: string }>(
      `SELECT runtime_endpoint FROM agents WHERE subdomain = $1 AND runtime_endpoint IS NOT NULL LIMIT 1`,
      [subdomain],
    );
    return result.rows[0]?.runtime_endpoint?.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Push the updated channels section to the live gateway via its REST config.patch endpoint.
 * The gateway uses the same JWT_SECRET as the dashboard so the user's token is valid.
 * This gives an immediate live effect without waiting for a container restart.
 */
async function notifyGateway(
  gatewayUrl: string,
  userJwt: string,
  channelsPatch: Record<string, unknown>,
  pluginEntriesPatch: Record<string, unknown>,
): Promise<void> {
  try {
    const res = await fetch(`${gatewayUrl}/api/v1/config/patch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${userJwt}`,
      },
      body: JSON.stringify({
        raw: JSON.stringify({
          channels: channelsPatch,
          plugins: { entries: pluginEntriesPatch },
        }),
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      console.warn(`[syncChannelsToGcs] Gateway config.patch returned HTTP ${res.status}`);
    } else {
      console.log('[syncChannelsToGcs] Gateway notified — live config updated');
    }
  } catch (err) {
    // Gateway unreachable (cold-start, scaling to zero, etc.) — GCS write is sufficient
    console.warn('[syncChannelsToGcs] Gateway unreachable (non-fatal):', (err as Error).message);
  }
}

/**
 * Extract the Cloud Run service name from a runtime_endpoint URL.
 * Cloud Run URLs follow the pattern:
 *   https://{service-name}-{project-number}.{region}.run.app
 * The project number is always 10+ consecutive digits.
 */
function extractServiceName(runtimeEndpoint: string): string | null {
  try {
    const hostname = new URL(runtimeEndpoint).hostname;
    // Match everything before the last "-{10+digits}." which is the project number
    const match = hostname.match(/^(.+)-\d{10,}\./);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * Trigger a Cloud Run service restart via the maava-deployer API.
 * This ensures the container re-reads the updated GCS config on startup.
 * Non-fatal — logs on failure.
 */
async function restartCloudRunService(runtimeEndpoint: string): Promise<void> {
  if (!DEPLOYER_API_SECRET) {
    console.warn('[syncChannelsToGcs] Service restart skipped — DEPLOYER_API_SECRET not set');
    return;
  }
  const serviceName = extractServiceName(runtimeEndpoint);
  if (!serviceName) {
    console.warn('[syncChannelsToGcs] Service restart skipped — could not extract service name from:', runtimeEndpoint);
    return;
  }
  try {
    const url = `${DEPLOYER_URL}/api/v1/cloud-run/services/${encodeURIComponent(serviceName)}/restart?region=europe-west1`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'x-deployer-secret': DEPLOYER_API_SECRET },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      console.warn(`[syncChannelsToGcs] Service restart returned HTTP ${res.status} for ${serviceName}`);
    } else {
      console.log(`[syncChannelsToGcs] Service restart triggered for ${serviceName}`);
    }
  } catch (err) {
    console.warn('[syncChannelsToGcs] Service restart failed (non-fatal):', (err as Error).message);
  }
}

/**
 * Rebuild the `channels` section of a user's openclaw.json from their DB rows,
 * persist it to GCS, and notify the live gateway to reload.
 *
 * @param userId    - User UUID from the JWT
 * @param subdomain - User subdomain (used to look up gateway URL)
 * @param userJwt   - Raw JWT string from the original request (forwarded to gateway)
 * @returns true if the GCS write succeeded, false otherwise
 */
export async function syncChannelsToGcs(
  userId: string,
  subdomain?: string | null,
  userJwt?: string | null,
): Promise<boolean> {
  // 1. Fetch all channel rows for this user
  let rows: ChannelRow[];
  try {
    const result = await pool.query<ChannelRow>(
      `SELECT channel_type, credentials, is_active
       FROM agent_channels
       WHERE user_id = $1`,
      [userId],
    );
    rows = result.rows;
  } catch (err) {
    console.error('[syncChannelsToGcs] DB query failed:', err);
    return false;
  }

  // 2. Read current openclaw.json (best-effort — missing file falls back to safe defaults).
  // Using DEFAULT_GATEWAY_CONFIG instead of {} prevents data loss: if the file doesn't
  // exist yet (or STORAGE_URL is temporarily unavailable), any subsequent write
  // will not wipe gateway auth, agents, skills, etc.
  let config: Record<string, unknown> = JSON.parse(JSON.stringify(DEFAULT_GATEWAY_CONFIG));
  try {
    const existing = await readUserConfig(userId);
    if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
      config = { ...(existing as Record<string, unknown>) };
    }
    // If existing === null the file doesn't exist yet — DEFAULT_GATEWAY_CONFIG is the right base.
  } catch {
    // readUserConfig threw — DEFAULT_GATEWAY_CONFIG already set above
  }

  // 3. Rebuild channels section — clear all managed-channel keys, add active ones back
  const existingChannels =
    config.channels && typeof config.channels === 'object' && !Array.isArray(config.channels)
      ? { ...(config.channels as Record<string, unknown>) }
      : {};

  for (const type of MANAGED_CHANNEL_TYPES) {
    delete existingChannels[type];
  }

  const activeChannelsPatch: Record<string, unknown> = {};
  for (const row of rows) {
    if (row.is_active && MANAGED_CHANNEL_TYPES.includes(row.channel_type)) {
      const creds = parseCredentials(row.credentials);
      const entry = buildChannelEntry(row.channel_type, creds);
      existingChannels[row.channel_type] = entry;
      activeChannelsPatch[row.channel_type] = entry;
    }
  }

  config.channels = existingChannels;

  // 3b. Sync plugins.entries — enable plugin for every active channel, disable for inactive ones.
  // The gateway uses plugins.entries.<type>.enabled to decide whether to load the plugin,
  // so this must stay in sync with channels or an "enabled" channel credential is silently ignored.
  const pluginsObj =
    config.plugins && typeof config.plugins === 'object' && !Array.isArray(config.plugins)
      ? { ...(config.plugins as Record<string, unknown>) }
      : {};
  const existingEntries =
    pluginsObj.entries && typeof pluginsObj.entries === 'object' && !Array.isArray(pluginsObj.entries)
      ? { ...(pluginsObj.entries as Record<string, unknown>) }
      : {};

  for (const type of MANAGED_CHANNEL_TYPES) {
    if (type in activeChannelsPatch) {
      existingEntries[type] = { enabled: true };
    } else {
      // Remove inactive channel plugin entries so the gateway doesn't reject
      // plugin names that aren't installed in the container.
      delete existingEntries[type];
    }
  }

  config.plugins = { ...pluginsObj, entries: existingEntries };

  // 4. Write updated config to GCS (authoritative — survives restarts)
  let gcsOk = false;
  try {
    await writeUserConfig(userId, config);
    gcsOk = true;
    console.log(`[syncChannelsToGcs] GCS config updated for user ${userId}`);
  } catch (err) {
    console.error('[syncChannelsToGcs] GCS write failed:', err);
    // Still try to notify the gateway even if GCS write failed
  }

  // 5. Notify the live gateway so changes take effect immediately, and restart
  //    the Cloud Run service so the updated GCS config is read on next startup.
  const gatewayUrl = await getGatewayUrl(subdomain);
  if (gatewayUrl) {
    if (userJwt) {
      await notifyGateway(gatewayUrl, userJwt, activeChannelsPatch, existingEntries);
    }
    // Restart the service so it re-reads the updated GCS config (best-effort)
    if (gcsOk) {
      await restartCloudRunService(gatewayUrl);
    }
  }

  return gcsOk;
}
