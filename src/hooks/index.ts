import { useState, useEffect, useCallback, useRef } from "react";
import useSWR, { SWRConfiguration } from "swr";
import { api, ApiError, type SavedChannel, type PlatformLink } from "@/lib/api";
import { configApi } from "@/lib/config-api";
import { useAuthStore } from "@/store";
import type {
  ConfigData,
  ConfigSchemaResponse,
  GatewaySession,
  ModelInfo,
  SkillStatus,
  ChannelStatus,
  CronJob,
  HealthStatus,
  SystemStatus,
  GatewayAgentFile,
} from "@/types";

// SWR fetcher
const fetcher = <T>(fn: () => Promise<T>) => fn();

// Auth hooks
export function useAuth() {
  const { agent, user, apiKey, isLoading, error, login, logout, refresh } =
    useAuthStore();

  useEffect(() => {
    if (apiKey && !agent && !user) refresh();
  }, [apiKey, agent, user, refresh]);

  return {
    agent,
    user,
    apiKey,
    isLoading,
    error,
    isAuthenticated: !!agent || !!user,
    login,
    logout,
    refresh,
  };
}

// Debounce hook
export function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedValue(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);

  return debouncedValue;
}

// Local storage hook
export function useLocalStorage<T>(
  key: string,
  initialValue: T
): [T, (value: T | ((prev: T) => T)) => void] {
  const [storedValue, setStoredValue] = useState<T>(() => {
    if (typeof window === "undefined") return initialValue;
    try {
      const item = window.localStorage.getItem(key);
      return item ? JSON.parse(item) : initialValue;
    } catch {
      return initialValue;
    }
  });

  const setValue = useCallback(
    (value: T | ((prev: T) => T)) => {
      setStoredValue((prev) => {
        const newValue = value instanceof Function ? value(prev) : value;
        if (typeof window !== "undefined") {
          window.localStorage.setItem(key, JSON.stringify(newValue));
        }
        return newValue;
      });
    },
    [key]
  );

  return [storedValue, setValue];
}

// Media query hook
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    const media = window.matchMedia(query);
    setMatches(media.matches);

    const listener = (e: MediaQueryListEvent) => setMatches(e.matches);
    media.addEventListener("change", listener);
    return () => media.removeEventListener("change", listener);
  }, [query]);

  return matches;
}

// Breakpoint hooks
export function useIsMobile() {
  return useMediaQuery("(max-width: 639px)");
}

export function useIsTablet() {
  return useMediaQuery("(min-width: 640px) and (max-width: 1023px)");
}

export function useIsDesktop() {
  return useMediaQuery("(min-width: 1024px)");
}

// Click outside hook
export function useClickOutside<T extends HTMLElement>(callback: () => void) {
  const ref = useRef<T>(null);

  useEffect(() => {
    const handleClick = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        callback();
      }
    };

    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [callback]);

  return ref;
}

// Keyboard shortcut hook
export function useKeyboardShortcut(
  key: string,
  callback: () => void,
  options: { ctrl?: boolean; shift?: boolean; alt?: boolean } = {}
) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.key.toLowerCase() === key.toLowerCase() &&
        (!options.ctrl || event.ctrlKey || event.metaKey) &&
        (!options.shift || event.shiftKey) &&
        (!options.alt || event.altKey)
      ) {
        event.preventDefault();
        callback();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [key, callback, options]);
}

// Copy to clipboard hook
export function useCopyToClipboard(): [
  boolean,
  (text: string) => Promise<void>
] {
  const [copied, setCopied] = useState(false);

  const copy = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }, []);

  return [copied, copy];
}

// Toggle hook
export function useToggle(
  initialValue = false
): [boolean, () => void, (value: boolean) => void] {
  const [value, setValue] = useState(initialValue);
  const toggle = useCallback(() => setValue((v) => !v), []);
  return [value, toggle, setValue];
}

// Previous value hook
export function usePrevious<T>(value: T): T | undefined {
  const ref = useRef<T>();
  useEffect(() => {
    ref.current = value;
  });
  return ref.current;
}

export function isValidAgentName(name: string): boolean {
  // Must be 2–32 chars
  if (name.length < 2 || name.length > 32) return false;

  // Only letters, numbers, and underscores
  const regex = /^[A-Za-z0-9_]+$/;

  return regex.test(name);
}

// ============================================================================
// maava Configuration API hooks
// ============================================================================

/**
 * Returns a SWR key only when the config API has a reachable (non-localhost) URL.
 * Passing `null` as key tells SWR to skip the request entirely.
 */
function gatewayKey(segments: string[]): string[] | null {
  return configApi.isUnavailable() ? null : segments;
}

/** Fetch the current maava config (raw YAML + parsed + baseHash). */
export function useConfig(config?: SWRConfiguration) {
  return useSWR<ConfigData>(
    gatewayKey(["openclaw", "config"]),
    () => configApi.configGet(),
    { revalidateOnFocus: false, ...config }
  );
}

/** Fetch the JSON schema for the config. */
export function useConfigSchema(config?: SWRConfiguration) {
  return useSWR<ConfigSchemaResponse>(
    gatewayKey(["openclaw", "config-schema"]),
    () => configApi.configSchema(),
    { revalidateOnFocus: false, ...config }
  );
}

/** Gateway health check. */
export function useGatewayHealth(config?: SWRConfiguration) {
  return useSWR<HealthStatus>(
    gatewayKey(["openclaw", "health"]),
    () => configApi.health(),
    { refreshInterval: 30_000, ...config }
  );
}

/** Gateway system status. */
export function useGatewayStatus(config?: SWRConfiguration) {
  return useSWR<SystemStatus>(
    gatewayKey(["openclaw", "status"]),
    () => configApi.status(),
    { refreshInterval: 30_000, ...config }
  );
}

/** List available models. */
export function useModels(config?: SWRConfiguration) {
  return useSWR<ModelInfo[]>(
    gatewayKey(["openclaw", "models"]),
    () => configApi.modelsList(),
    { revalidateOnFocus: false, ...config }
  );
}

/** List chat sessions. */
export function useSessions(config?: SWRConfiguration) {
  return useSWR<GatewaySession[]>(
    gatewayKey(["openclaw", "sessions"]),
    () => configApi.sessionsList(),
    config
  );
}

/** Get skills status. */
export function useSkills(config?: SWRConfiguration) {
  return useSWR<SkillStatus>(
    gatewayKey(["openclaw", "skills"]),
    () => configApi.skillsStatus(),
    { revalidateOnFocus: false, ...config }
  );
}

/** Get channel statuses from maava gateway. */
export function useChannels(config?: SWRConfiguration) {
  return useSWR<ChannelStatus[]>(
    gatewayKey(["openclaw", "channels"]),
    () => configApi.channelsStatus(),
    { refreshInterval: 30_000, onErrorRetry: () => {}, ...config }
  );
}

/** Get saved channel connections from the maavaDao DB (per-user). */
export function useSavedChannels(config?: SWRConfiguration) {
  const { isAuthenticated } = useAuth();
  return useSWR<SavedChannel[]>(
    isAuthenticated ? ["saved-channels"] : null,
    () => api.getChannels(),
    { revalidateOnFocus: false, ...config }
  );
}

/** Get SaaS platform links (Telegram, Discord, WhatsApp) for the current user. */
export function usePlatformLinks(config?: SWRConfiguration) {
  const { isAuthenticated } = useAuth();
  return useSWR<PlatformLink[]>(
    isAuthenticated ? ["platform-links"] : null,
    () => api.getPlatformLinks(),
    { revalidateOnFocus: false, ...config }
  );
}

/** Get Slack connection status for the current user. */
export function useSlackStatus(config?: SWRConfiguration) {
  const { isAuthenticated } = useAuth();
  return useSWR<import('@/types/slack').SlackConnectionStatus>(
    isAuthenticated ? ["slack-status"] : null,
    async () => {
      const res = await fetch('/api/channels/slack/status', { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to fetch Slack status');
      const data = await res.json();
      return data.data;
    },
    { revalidateOnFocus: false, ...config }
  );
}

/** List cron jobs. */
export function useCronJobs(config?: SWRConfiguration) {
  return useSWR<CronJob[]>(
    gatewayKey(["openclaw", "cron"]),
    () => configApi.cronList(),
    config
  );
}

/** List agent files. */
export function useAgentFiles(config?: SWRConfiguration) {
  return useSWR<GatewayAgentFile[]>(
    gatewayKey(["openclaw", "agent-files"]),
    async () => {
      try {
        return await configApi.agentFilesList();
      } catch {
        // Endpoint may not exist on this gateway – return empty list silently
        return [] as GatewayAgentFile[];
      }
    },
    {
      revalidateOnFocus: false,
      ...config,
    }
  );
}
