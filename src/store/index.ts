import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { Agent, Post, PostSort, TimeRange, Notification, User, InstalledAgent } from "@/types";
import { api } from "@/lib/api";
import { configApi } from "@/lib/config-api";

// Auth Store — supports both agent (API-key) and human user (email/password) auth
interface AuthStore {
  agent: Agent | null;
  user: User | null;
  apiKey: string | null;
  token: string | null; // OAuth session token
  isLoading: boolean;
  error: string | null;

  setAgent: (agent: Agent | null) => void;
  setUser: (user: User | null) => void;
  setApiKey: (key: string | null) => void;
  setToken: (token: string | null) => void;
  login: (apiKey: string) => Promise<void>;
  loginAgent: (name: string, password: string) => Promise<void>;
  loginUser: (identifier: string, password: string) => Promise<void>;
  registerUser: (username: string, email: string, password: string) => Promise<void>;
  logout: () => void;
  refresh: () => Promise<void>;
}

export const useAuthStore = create<AuthStore>()(
  persist(
    (set, get) => ({
      agent: null,
      user: null,
      apiKey: null,
      token: null,
      isLoading: false,
      error: null,

      setAgent: (agent) => set({ agent }),
      setUser: (user) => set({ user }),
      setApiKey: (apiKey) => {
        api.setApiKey(apiKey);
        set({ apiKey });
      },
      setToken: (token) => {
        // Store OAuth token separately from apiKey
        // Can be used for backend API calls
        set({ token });
      },

      login: async (apiKey: string) => {
        set({ isLoading: true, error: null });
        try {
          api.setApiKey(apiKey);
          const agent = await api.getMe();
          // Wire up the config API tenant ID from the agent's ID
          configApi.setTenantId(agent.id);
          set({ agent, apiKey, isLoading: false });
        } catch (err) {
          api.clearApiKey();
          set({
            error: (err as Error).message,
            isLoading: false,
            agent: null,
            apiKey: null,
          });
          throw err;
        }
      },

      loginAgent: async (name: string, password: string) => {
        set({ isLoading: true, error: null });
        try {
          const result = await api.login({ name, password });
          const { agent, apiKey } = result;
          api.setApiKey(apiKey);
          configApi.setTenantId(agent.id);
          set({ agent, apiKey, isLoading: false });
        } catch (err) {
          api.clearApiKey();
          set({
            error: (err as Error).message,
            isLoading: false,
            agent: null,
            apiKey: null,
          });
          throw err;
        }
      },

      loginUser: async (identifier: string, password: string) => {
        set({ isLoading: true, error: null });
        try {
          const result = await api.loginUser({ identifier, password });
          const { user, apiKey } = result;
          api.setApiKey(apiKey);
          configApi.setTenantId(user.id);
          set({ user, apiKey, isLoading: false });
        } catch (err) {
          set({
            error: (err as Error).message,
            isLoading: false,
            user: null,
            apiKey: null,
          });
          throw err;
        }
      },

      registerUser: async (username: string, email: string, password: string) => {
        set({ isLoading: true, error: null });
        try {
          const result = await api.registerUser({ username, email, password });
          // Backend returns { user: { id, username, email, displayName, api_key }, important }
          const apiKey = result.user.api_key;
          const user: User = {
            id: result.user.id,
            username: result.user.username,
            email: result.user.email,
            displayName: result.user.displayName,
            isActive: true,
            isVerified: false,
            createdAt: new Date().toISOString(),
          };
          api.setApiKey(apiKey);
          configApi.setTenantId(user.id);
          set({ user, apiKey, isLoading: false });
        } catch (err) {
          set({
            error: (err as Error).message,
            isLoading: false,
          });
          throw err;
        }
      },

      logout: () => {
        api.clearApiKey();
        configApi.setTenantId(null);
        set({ agent: null, user: null, apiKey: null, token: null, error: null });
        // Clear all persisted storage to prevent stale sessions
        if (typeof window !== 'undefined') {
          try { localStorage.clear(); } catch {}
          try { sessionStorage.clear(); } catch {}
        }
        // Await cookie clear before redirect to prevent race condition:
        // without waiting, barrsa.com may still see the stale cookie,
        // bounce back to subdomain, which then redirects to login?redirect=…
        (async () => {
          try {
            await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
          } catch { /* best-effort */ }
          if (typeof window !== 'undefined') {
            window.location.href = 'https://barrsa.com';
          }
        })();
      },

      refresh: async () => {
        const { apiKey, user } = get();
        if (!apiKey) return;
        try {
          api.setApiKey(apiKey);
          if (user) {
            // User-based auth — try fetching updated profile
            try {
              const freshUser = await api.getUserMe();
              configApi.setTenantId(freshUser.id);
              set({ user: { ...user, ...freshUser } });
            } catch {
              // If getUserMe fails, keep the persisted user
              configApi.setTenantId(user.id);
            }
          } else {
            const agent = await api.getMe();
            configApi.setTenantId(agent.id);
            set({ agent });
          }
        } catch (err: unknown) {
          // Auto-logout on 401 Unauthorized (expired / invalid token)
          const status = (err as { statusCode?: number })?.statusCode;
          if (status === 401 || status === 403) {
            api.clearApiKey();
            configApi.setTenantId(null);
            set({ agent: null, user: null, apiKey: null, error: null });
          }
          // Other errors (network, 500) are silently ignored — keep existing state
        }
      },
    }),
    {
      name: "barrsa-auth",
      partialize: (state) => ({
        apiKey: state.apiKey,
        token: state.token,
        user: state.user,
      }),
    }
  )
);

// Setup Store — tracks wizard progress (persisted)
type SetupStep = 'intro' | 'interests' | 'provider' | 'messenger' | 'launch';

interface SetupStore {
  setupStep: SetupStep;
  setupComplete: boolean;
  selectedProvider: string | null;
  selectedInterests: string[];
  connectedMessengers: string[];

  setSetupStep: (step: SetupStep) => void;
  setSelectedProvider: (id: string | null) => void;
  toggleInterest: (id: string) => void;
  toggleMessenger: (id: string) => void;
  completeSetup: () => void;
  resetSetup: () => void;
}

export const useSetupStore = create<SetupStore>()(
  persist(
    (set, get) => ({
      setupStep: 'intro',
      setupComplete: false,
      selectedProvider: null,
      selectedInterests: [],
      connectedMessengers: [],

      setSetupStep: (step) => set({ setupStep: step }),
      setSelectedProvider: (id) => set({ selectedProvider: id }),
      toggleInterest: (id) => {
        const current = get().selectedInterests;
        if (current.includes(id)) {
          set({ selectedInterests: current.filter((i) => i !== id) });
        } else {
          set({ selectedInterests: [...current, id] });
        }
      },
      toggleMessenger: (id) => {
        const current = get().connectedMessengers;
        if (current.includes(id)) {
          set({ connectedMessengers: current.filter((m) => m !== id) });
        } else {
          set({ connectedMessengers: [...current, id] });
        }
      },
      completeSetup: () => set({ setupComplete: true }),
      resetSetup: () =>
        set({
          setupStep: 'intro',
          setupComplete: false,
          selectedProvider: null,
          selectedInterests: [],
          connectedMessengers: [],
        }),
    }),
    {
      name: 'barrsa-setup',
      partialize: (state) => ({
        setupStep: state.setupStep,
        setupComplete: state.setupComplete,
        selectedProvider: state.selectedProvider,
        selectedInterests: state.selectedInterests,
        connectedMessengers: state.connectedMessengers,
      }),
    }
  )
);

// Feed Store
interface FeedStore {
  posts: Post[];
  sort: PostSort;
  timeRange: TimeRange;
  submolt: string | null;
  isLoading: boolean;
  hasMore: boolean;
  offset: number;

  setSort: (sort: PostSort) => void;
  setTimeRange: (timeRange: TimeRange) => void;
  setSubmolt: (submolt: string | null) => void;
  loadPosts: (reset?: boolean) => Promise<void>;
  loadMore: () => Promise<void>;
  updatePostVote: (
    postId: string,
    vote: "up" | "down" | null,
    scoreDiff: number
  ) => void;
}

export const useFeedStore = create<FeedStore>((set, get) => ({
  posts: [],
  sort: "hot",
  timeRange: "day",
  submolt: null,
  isLoading: false,
  hasMore: true,
  offset: 0,

  setSort: (sort) => {
    set({ sort, posts: [], offset: 0, hasMore: true });
    get().loadPosts(true);
  },

  setTimeRange: (timeRange) => {
    set({ timeRange, posts: [], offset: 0, hasMore: true });
    get().loadPosts(true);
  },

  setSubmolt: (submolt) => {
    set({ submolt, posts: [], offset: 0, hasMore: true });
    get().loadPosts(true);
  },

  loadPosts: async (reset = false) => {
    const { sort, timeRange, submolt, isLoading } = get();
    if (isLoading) return;

    set({ isLoading: true });
    try {
      const offset = reset ? 0 : get().offset;
      const response = submolt
        ? await api.getSubmoltFeed(submolt, { sort, limit: 25, offset })
        : await api.getPosts({ sort, timeRange, limit: 25, offset });

      set({
        posts: reset ? response.data : [...get().posts, ...response.data],
        hasMore: response.pagination.hasMore,
        offset: offset + response.data.length,
        isLoading: false,
      });
    } catch (err) {
      // Stop infinite scroll retries on errors (especially 429 rate limits)
      set({ isLoading: false, hasMore: false });
      console.error("Failed to load posts:", err);
    }
  },

  loadMore: async () => {
    const { hasMore, isLoading } = get();
    if (!hasMore || isLoading) return;
    await get().loadPosts();
  },

  updatePostVote: (postId, vote, scoreDiff) => {
    set({
      posts: get().posts.map((p) =>
        p.id === postId
          ? { ...p, userVote: vote, score: p.score + scoreDiff }
          : p
      ),
    });
  },
}));

// UI Store
interface UIStore {
  sidebarOpen: boolean;
  mobileMenuOpen: boolean;
  createPostOpen: boolean;
  searchOpen: boolean;

  toggleSidebar: () => void;
  toggleMobileMenu: () => void;
  openCreatePost: () => void;
  closeCreatePost: () => void;
  openSearch: () => void;
  closeSearch: () => void;
}

export const useUIStore = create<UIStore>((set) => ({
  sidebarOpen: true,
  mobileMenuOpen: false,
  createPostOpen: false,
  searchOpen: false,

  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  toggleMobileMenu: () => set((s) => ({ mobileMenuOpen: !s.mobileMenuOpen })),
  openCreatePost: () => set({ createPostOpen: true }),
  closeCreatePost: () => set({ createPostOpen: false }),
  openSearch: () => set({ searchOpen: true }),
  closeSearch: () => set({ searchOpen: false }),
}));

// Notifications Store
interface NotificationStore {
  notifications: Notification[];
  unreadCount: number;
  isLoading: boolean;

  loadNotifications: () => Promise<void>;
  markAsRead: (id: string) => void;
  markAllAsRead: () => void;
  clear: () => void;
}

export const useNotificationStore = create<NotificationStore>((set, get) => ({
  notifications: [],
  unreadCount: 0,
  isLoading: false,

  loadNotifications: async () => {
    set({ isLoading: true });
    // TODO: Implement API call
    set({ isLoading: false });
  },

  markAsRead: (id) => {
    set({
      notifications: get().notifications.map((n) =>
        n.id === id ? { ...n, read: true } : n
      ),
      unreadCount: Math.max(0, get().unreadCount - 1),
    });
  },

  markAllAsRead: () => {
    set({
      notifications: get().notifications.map((n) => ({ ...n, read: true })),
      unreadCount: 0,
    });
  },

  clear: () => set({ notifications: [], unreadCount: 0 }),
}));

// OpenClaw Chat Store (gateway URL, token, config API URL, and optional AI key overrides)
interface OpenClawChatStore {
  // Chat gateway (WebSocket + completions, port 19001)
  gatewayToken: string | null;
  gatewayUrl: string | null;
  // Config REST API (dashboard/sessions/models, port 19002)
  configApiUrl: string | null;
  // Optional AI provider key overrides (client-stored, sent in request body)
  openaiKey: string | null;
  anthropicKey: string | null;

  setGatewayToken: (token: string | null) => void;
  /** Updates the chat gateway URL only — does NOT change the config REST API client. */
  setGatewayUrl: (url: string | null) => void;
  /** Updates the config REST API URL and syncs the configApi client immediately. */
  setConfigApiUrl: (url: string | null) => void;
  setOpenaiKey: (key: string | null) => void;
  setAnthropicKey: (key: string | null) => void;
}

const initialGatewayToken =
  process.env.NEXT_PUBLIC_OPENCLAW_GATEWAY_TOKEN?.trim() || null;

export const useOpenClawChatStore = create<OpenClawChatStore>()(
  persist(
    (set) => ({
      gatewayToken: initialGatewayToken,
      gatewayUrl: null,
      configApiUrl: null,
      openaiKey: null,
      anthropicKey: null,

      setGatewayToken: (gatewayToken) => set({ gatewayToken }),
      setGatewayUrl: (gatewayUrl) => set({ gatewayUrl }),
      setConfigApiUrl: (configApiUrl) => {
        // Sync the config-api client immediately so dashboard calls use the new URL right away
        configApi.setBaseUrl(configApiUrl);
        set({ configApiUrl });
      },
      setOpenaiKey: (openaiKey) => set({ openaiKey }),
      setAnthropicKey: (anthropicKey) => set({ anthropicKey }),
    }),
    {
      name: "barrsa-openclaw-chat",
      partialize: (s) => ({
        gatewayToken: s.gatewayToken,
        gatewayUrl: s.gatewayUrl,
        configApiUrl: s.configApiUrl,
        openaiKey: s.openaiKey,
        anthropicKey: s.anthropicKey,
      }),
      // On rehydration, sync config-api base URL and prefer env token when persisted is null
      merge: (persisted, current) => {
        const p = persisted as Partial<OpenClawChatStore> | undefined;
        if (p?.configApiUrl) configApi.setBaseUrl(p.configApiUrl);
        return {
          ...current,
          gatewayToken: p?.gatewayToken ?? initialGatewayToken ?? null,
          gatewayUrl: p?.gatewayUrl ?? current.gatewayUrl ?? null,
          configApiUrl: p?.configApiUrl ?? current.configApiUrl ?? null,
          openaiKey: p?.openaiKey ?? null,
          anthropicKey: p?.anthropicKey ?? null,
        };
      },
    }
  )
);

// Skills Store (enabled skills for chat)
type EnabledSkill = { skill_id: string; name: string; category: string };

interface SkillsStore {
  enabledSkills: EnabledSkill[];
  loaded: boolean;
  setEnabledSkills: (skills: EnabledSkill[]) => void;
  clearSkills: () => void;
}

export const useSkillsStore = create<SkillsStore>((set) => ({
  enabledSkills: [],
  loaded: false,
  setEnabledSkills: (skills) => set({ enabledSkills: skills, loaded: true }),
  clearSkills: () => set({ enabledSkills: [], loaded: false }),
}));

// Installed Agents Store (SOUL/SKILL/HEARTBEAT/CHANNEL architecture)
interface InstalledAgentsStore {
  agents: InstalledAgent[];
  selectedAgentId: string | null;
  loaded: boolean;
  loadAgents: (userId: string) => Promise<void>;
  selectAgent: (agentId: string | null) => void;
  getSelectedAgent: () => InstalledAgent | null;
}

export const useInstalledAgentsStore = create<InstalledAgentsStore>((set, get) => ({
  agents: [],
  selectedAgentId: null,
  loaded: false,

  loadAgents: async (userId: string) => {
    if (!userId || userId === 'anonymous') {
      set({ agents: [], loaded: true });
      return;
    }
    set({ loaded: false });
    try {
      const res = await fetch('/api/agents/installed', {
        headers: { 'x-user-id': userId },
      });
      if (!res.ok) {
        set({ agents: [], loaded: true });
        return;
      }
      const data = await res.json();
      set({ agents: data.agents || [], loaded: true });
    } catch {
      set({ agents: [], loaded: true });
    }
  },

  selectAgent: (agentId) => set({ selectedAgentId: agentId }),

  getSelectedAgent: () => {
    const { agents, selectedAgentId } = get();
    if (!selectedAgentId) return null;
    return agents.find(a => a.agent_id === selectedAgentId) || null;
  },
}));

// Subscriptions Store
interface SubscriptionStore {
  subscribedSubmolts: string[];
  addSubscription: (name: string) => void;
  removeSubscription: (name: string) => void;
  isSubscribed: (name: string) => boolean;
}

export const useSubscriptionStore = create<SubscriptionStore>()(
  persist(
    (set, get) => ({
      subscribedSubmolts: [],

      addSubscription: (name) => {
        if (!get().subscribedSubmolts.includes(name)) {
          set({ subscribedSubmolts: [...get().subscribedSubmolts, name] });
        }
      },

      removeSubscription: (name) => {
        set({
          subscribedSubmolts: get().subscribedSubmolts.filter(
            (s) => s !== name
          ),
        });
      },

      isSubscribed: (name) => get().subscribedSubmolts.includes(name),
    }),
    { name: "barrsa-subscriptions" }
  )
);
