// maava Configuration API Client
// All endpoints are POST-based RPC calls via the gateway bridge.
// Auth uses X-Tenant-ID header (mapped from the logged-in agent's ID).
// Response envelope: { success: boolean; data: T | null; message: string; error?: unknown }

import { CONFIG_API_URL } from "@/lib/constants";
import type {
  ConfigData,
  ConfigSchemaResponse,
  GatewayAgent,
  GatewayAgentFile,
  GatewaySession,
  ModelInfo,
  SkillStatus,
  ChannelStatus,
  CronJob,
  HealthStatus,
  SystemStatus,
} from "@/types";

/** Returns true when the URL targets localhost — unusable from a production browser. */
function isLocalhostUrl(url: string | undefined | null): boolean {
  if (!url) return true;
  // Relative URLs (like /api/gateway) are same-origin proxies — never localhost
  if (url.startsWith("/")) return false;
  try {
    const u = new URL(url);
    return u.hostname === "localhost" || u.hostname === "127.0.0.1";
  } catch {
    return true;
  }
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class ConfigApiError extends Error {
  /** Alias so SWR `onErrorRetry` can read `err.status` */
  get status() {
    return this.statusCode;
  }
  constructor(
    public statusCode: number,
    message: string,
    public details?: unknown
  ) {
    super(message);
    this.name = "ConfigApiError";
  }
}

// ---------------------------------------------------------------------------
// Envelope type returned by every endpoint
// ---------------------------------------------------------------------------

interface Envelope<T> {
  success: boolean;
  data: T | null;
  message: string;
  error?: unknown;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

class ConfigApiClient {
  private tenantId: string | null = null;
  private baseUrl: string = CONFIG_API_URL;
  private cloudMode: boolean = false;
  private authToken: string | null = null;
  /** Becomes true after a network-level fetch failure; auto-clears after 60 s */
  private networkDown: boolean = false;
  private networkDownTimer: ReturnType<typeof setTimeout> | null = null;

  private markNetworkDown() {
    this.networkDown = true;
    if (this.networkDownTimer) clearTimeout(this.networkDownTimer);
    this.networkDownTimer = setTimeout(() => {
      this.networkDown = false;
      this.networkDownTimer = null;
    }, 60_000);
  }

  /** Set the tenant (agent) ID used for all subsequent calls. */
  setTenantId(id: string | null) {
    this.tenantId = id;
  }

  getTenantId(): string | null {
    return this.tenantId;
  }

  /**
   * Enable cloud mode — routes API calls through /api/proxy/ instead
   * of directly to the gateway. The proxy resolves the backend URL
   * from the JWT and tenant lookup.
   */
  setCloudMode(enabled: boolean) {
    this.cloudMode = enabled;
    if (enabled && typeof window !== "undefined") {
      // In cloud mode, use the proxy route on the same origin
      this.baseUrl = `${window.location.origin}/api/proxy/v1`;
    }
  }

  isCloudMode(): boolean {
    return this.cloudMode;
  }

  /** Set JWT auth token for cloud mode requests */
  setAuthToken(token: string | null) {
    this.authToken = token;
  }

  /**
   * Override the base URL at runtime.
   * The gateway URL can be set by the user in Settings, or derived from
   * the deployed agent's Cloud Run endpoint.
   * Accepts a full URL like `https://my-agent.run.app` — `/api/v1` is
   * appended automatically if the URL doesn't already end with `/api/v1`.
   */
  setBaseUrl(url: string | null) {
    if (!url) {
      this.baseUrl = this.cloudMode && typeof window !== "undefined"
        ? `${window.location.origin}/api/proxy/v1`
        : CONFIG_API_URL;
      return;
    }
    // Normalise: strip trailing slash, ensure /api/v1 suffix
    let normalised = url.replace(/\/+$/, "");
    if (!normalised.endsWith("/api/v1")) {
      normalised += "/api/v1";
    }
    // In browser context, route localhost URLs through the Next.js proxy
    // so the browser never gets ERR_CONNECTION_REFUSED on port 19002
    if (typeof window !== "undefined" && isLocalhostUrl(normalised)) {
      this.baseUrl = "/api/gateway";
    } else {
      this.baseUrl = normalised;
    }
    // Clear network-down flag when URL is explicitly updated (user reconfigured)
    this.networkDown = false;
    if (this.networkDownTimer) { clearTimeout(this.networkDownTimer); this.networkDownTimer = null; }
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  /** True when the API is unreachable (e.g. localhost API from a remote browser, or recent connection failure). */
  isUnavailable(): boolean {
    // Connection refused / network-down flag set by a recent failed fetch
    if (this.networkDown) return true;
    // In cloud mode, the proxy handles routing — always available
    if (this.cloudMode) return false;
    // If we're also running on localhost, localhost API is reachable (when a URL is configured)
    if (typeof window !== 'undefined') {
      const winHost = window.location.hostname;
      if (winHost === 'localhost' || winHost === '127.0.0.1') {
        return !this.baseUrl;
      }
    }
    return isLocalhostUrl(this.baseUrl);
  }

  // -------------------------------------------------------------------------
  // Core request helper
  // -------------------------------------------------------------------------

  private async request<T>(
    path: string,
    body?: Record<string, unknown>
  ): Promise<T> {
    // Guard: never call localhost from a remote (production) browser
    if (typeof window !== "undefined" && isLocalhostUrl(this.baseUrl)) {
      const winHost = window.location.hostname;
      if (winHost !== 'localhost' && winHost !== '127.0.0.1') {
        throw new ConfigApiError(
          0,
          "maava gateway URL is not configured. Go to Settings → maava Gateway to set it."
        );
      }
    }

    const url = `${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (this.tenantId) {
      headers["X-Tenant-ID"] = this.tenantId;
    }

    // In cloud mode, include JWT auth token
    if (this.cloudMode && this.authToken) {
      headers["Authorization"] = `Bearer ${this.authToken}`;
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body ?? {}),
        credentials: this.cloudMode ? "include" : "same-origin",
      });
    } catch (networkErr) {
      // Network-level error (ERR_CONNECTION_REFUSED, offline, etc.) — mark as down
      this.markNetworkDown();
      throw new ConfigApiError(0, "maava gateway is unreachable");
    }

    if (!response.ok) {
      const err = await response.json().catch(() => ({
        error: "Unknown error",
      }));
      throw new ConfigApiError(
        response.status,
        typeof err.message === "string" ? err.message : "Request failed",
        err.error
      );
    }

    const envelope: Envelope<T> = await response.json();

    if (!envelope.success) {
      throw new ConfigApiError(
        200,
        typeof envelope.message === "string"
          ? envelope.message
          : "Request failed",
        envelope.error
      );
    }

    return envelope.data as T;
  }

  // -------------------------------------------------------------------------
  // Health
  // -------------------------------------------------------------------------

  async health(): Promise<HealthStatus> {
    return this.request<HealthStatus>("/health");
  }

  async status(): Promise<SystemStatus> {
    return this.request<SystemStatus>("/status");
  }

  // -------------------------------------------------------------------------
  // Config
  // -------------------------------------------------------------------------

  async configGet(): Promise<ConfigData> {
    return this.request<ConfigData>("/config/get");
  }

  async configSet(
    raw: string,
    baseHash?: string
  ): Promise<{ ok: boolean }> {
    return this.request<{ ok: boolean }>("/config/set", { raw, baseHash });
  }

  async configApply(
    raw: string,
    baseHash?: string
  ): Promise<{ ok: boolean }> {
    return this.request<{ ok: boolean }>("/config/apply", { raw, baseHash });
  }

  async configPatch(
    patch: Record<string, unknown>,
    baseHash?: string
  ): Promise<{ ok: boolean }> {
    // Backend config.patch expects { raw: "<JSON string of patch>", baseHash? }
    const body: Record<string, unknown> = { raw: JSON.stringify(patch) };
    if (baseHash) body.baseHash = baseHash;
    return this.request<{ ok: boolean }>("/config/patch", body);
  }

  async configSchema(): Promise<ConfigSchemaResponse> {
    return this.request<ConfigSchemaResponse>("/config/schema");
  }

  // -------------------------------------------------------------------------
  // Agents
  // -------------------------------------------------------------------------

  async agentRun(params: Record<string, unknown> = {}): Promise<unknown> {
    return this.request<unknown>("/agent/run", params);
  }

  async agentIdentity(): Promise<unknown> {
    return this.request<unknown>("/agent/identity");
  }

  async agentsList(): Promise<GatewayAgent[]> {
    return this.request<GatewayAgent[]>("/agents/list");
  }

  async agentFilesList(): Promise<GatewayAgentFile[]> {
    return this.request<GatewayAgentFile[]>("/agents/files/list");
  }

  async agentFilesGet(
    path: string
  ): Promise<{ path: string; content: string }> {
    return this.request<{ path: string; content: string }>(
      "/agents/files/get",
      { path }
    );
  }

  async agentFilesSet(
    path: string,
    content: string
  ): Promise<{ ok: boolean }> {
    return this.request<{ ok: boolean }>("/agents/files/set", {
      path,
      content,
    });
  }

  // -------------------------------------------------------------------------
  // Channels
  // -------------------------------------------------------------------------

  async channelsStatus(): Promise<ChannelStatus[]> {
    const data = await this.request<{ channelMeta?: ChannelStatus[] } | ChannelStatus[]>("/channels/status");
    if (Array.isArray(data)) return data;
    return Array.isArray(data?.channelMeta) ? data.channelMeta : [];
  }

  async channelsLogout(
    channel: string
  ): Promise<{ ok: boolean }> {
    return this.request<{ ok: boolean }>("/channels/logout", { channel });
  }

  async channelsLogin(opts?: {
    force?: boolean;
    accountId?: string;
  }): Promise<{ qrDataUrl?: string; message: string }> {
    return this.request<{ qrDataUrl?: string; message: string }>(
      "/channels/login",
      opts ?? {}
    );
  }

  // -------------------------------------------------------------------------
  // Sessions
  // -------------------------------------------------------------------------

  async sessionsList(): Promise<GatewaySession[]> {
    const data = await this.request<{ sessions?: Record<string, unknown>[] } | Record<string, unknown>[]>("/sessions/list");
    const raw: Record<string, unknown>[] = Array.isArray(data)
      ? data
      : Array.isArray((data as { sessions?: unknown[] })?.sessions)
        ? (data as { sessions: Record<string, unknown>[] }).sessions
        : [];
    // Normalise: backend returns sessionId/key/displayName/chatType; frontend expects id/label/channel
    return raw.map((s) => ({
      ...s,
      id: (s.sessionId as string) || (s.key as string) || (s.id as string) || '',
      label: (s.displayName as string) || (s.label as string) || undefined,
      channel: (s.chatType as string) || (s.channel as string) || (s.kind as string) || undefined,
      createdAt: typeof s.createdAt === 'number' ? new Date(s.createdAt as number).toISOString() : (s.createdAt as string | undefined),
      updatedAt: typeof s.updatedAt === 'number' ? new Date(s.updatedAt as number).toISOString() : (s.updatedAt as string | undefined),
    } as GatewaySession));
  }

  async sessionsPreview(
    id: string
  ): Promise<{ session: GatewaySession; messages: unknown[] }> {
    return this.request<{ session: GatewaySession; messages: unknown[] }>(
      "/sessions/preview",
      { id }
    );
  }

  async sessionsReset(id: string): Promise<{ ok: boolean }> {
    return this.request<{ ok: boolean }>("/sessions/reset", { id });
  }

  async sessionsDelete(id: string): Promise<{ ok: boolean }> {
    return this.request<{ ok: boolean }>("/sessions/delete", { id });
  }

  async sessionsCompact(id: string): Promise<{ ok: boolean }> {
    return this.request<{ ok: boolean }>("/sessions/compact", { id });
  }

  // -------------------------------------------------------------------------
  // Models
  // -------------------------------------------------------------------------

  async modelsList(): Promise<ModelInfo[]> {
    const data = await this.request<{ models?: ModelInfo[] } | ModelInfo[]>("/models/list");
    if (Array.isArray(data)) return data;
    return Array.isArray(data?.models) ? data.models : [];
  }

  // -------------------------------------------------------------------------
  // Skills
  // -------------------------------------------------------------------------

  async skillsStatus(): Promise<SkillStatus> {
    const data = await this.request<SkillStatus & { skills?: unknown[] }>("/skills/status");
    // Backend returns { skills: [...] }, normalise to { installed: [...] }
    if (!data.installed && Array.isArray(data.skills)) {
      data.installed = data.skills as SkillStatus['installed'];
    }
    return data;
  }

  async skillsInstall(
    skill: string
  ): Promise<{ ok: boolean }> {
    return this.request<{ ok: boolean }>("/skills/install", { skill });
  }

  async skillsUpdate(
    skill: string
  ): Promise<{ ok: boolean }> {
    return this.request<{ ok: boolean }>("/skills/update", { skill });
  }

  // -------------------------------------------------------------------------
  // Cron
  // -------------------------------------------------------------------------

  async cronList(): Promise<CronJob[]> {
    return this.request<CronJob[]>("/cron/list");
  }

  async cronStatus(): Promise<unknown> {
    return this.request<unknown>("/cron/status");
  }

  async cronAdd(
    job: Record<string, unknown>
  ): Promise<{ ok: boolean }> {
    return this.request<{ ok: boolean }>("/cron/add", job);
  }

  async cronRemove(id: string): Promise<{ ok: boolean }> {
    return this.request<{ ok: boolean }>("/cron/remove", { id });
  }

  async cronRun(id: string): Promise<unknown> {
    return this.request<unknown>("/cron/run", { id });
  }

  // -------------------------------------------------------------------------
  // Messages
  // -------------------------------------------------------------------------

  async messagesSend(
    params: Record<string, unknown>
  ): Promise<unknown> {
    return this.request<unknown>("/messages/send", params);
  }

  async messagesWake(
    params: Record<string, unknown>
  ): Promise<unknown> {
    return this.request<unknown>("/messages/wake", params);
  }

  // -------------------------------------------------------------------------
  // TTS
  // -------------------------------------------------------------------------

  async ttsStatus(): Promise<unknown> {
    return this.request<unknown>("/tts/status");
  }

  async ttsProviders(): Promise<unknown> {
    return this.request<unknown>("/tts/providers");
  }

  // -------------------------------------------------------------------------
  // Wizard
  // -------------------------------------------------------------------------

  async wizardStart(): Promise<unknown> {
    return this.request<unknown>("/wizard/start");
  }

  async wizardNext(
    params: Record<string, unknown> = {}
  ): Promise<unknown> {
    return this.request<unknown>("/wizard/next", params);
  }

  async wizardCancel(): Promise<unknown> {
    return this.request<unknown>("/wizard/cancel");
  }

  async wizardStatus(): Promise<unknown> {
    return this.request<unknown>("/wizard/status");
  }

  // -------------------------------------------------------------------------
  // Logs
  // -------------------------------------------------------------------------

  async logsTail(
    params: Record<string, unknown> = {}
  ): Promise<unknown> {
    return this.request<unknown>("/logs/tail", params);
  }

  // -------------------------------------------------------------------------
  // Misc / Usage
  // -------------------------------------------------------------------------

  async usageStatus(): Promise<unknown> {
    return this.request<unknown>("/usage/status");
  }

  async usageCost(): Promise<unknown> {
    return this.request<unknown>("/usage/cost");
  }
}

export const configApi = new ConfigApiClient();
