// mawaDao API Client

import type {
  Agent,
  Post,
  Comment,
  Community,
  Notification,
  SearchResults,
  PaginatedResponse,
  CreatePostForm,
  CreateCommentForm,
  RegisterAgentForm,
  PostSort,
  CommentSort,
  TimeRange,
  MarketplaceListing,
  MarketplaceOrder,
  SellerCategory,
  SellerProfile,
  Product,
  ProductVersion,
  ProductAsset,
  ListingOutput,
  ConnectedSocialAccount,
  PublishingTarget,
  PublishingJob,
  PublishingResult,
  ApprovalRequest,
  PromotionRule,
  CampaignRun,
  CreateSellerProfileForm,
  CreateProductForm,
  MarketplaceProduct,
  WalletSettings,
  WalletPendingAction,
  WalletAuditLog,
} from "@/types";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL;

class ApiError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public code?: string,
    public hint?: string
  ) {
    super(message);
    this.name = "ApiError";
  }
}

class ApiClient {
  private apiKey: string | null = null;

  setApiKey(key: string | null) {
    this.apiKey = key;
    if (key && typeof window !== "undefined") {
      localStorage.setItem("mawadao_api_key", key);
    }
  }

  getApiKey(): string | null {
    if (this.apiKey) return this.apiKey;
    if (typeof window !== "undefined") {
      this.apiKey = localStorage.getItem("mawadao_api_key");
    }
    return this.apiKey;
  }

  clearApiKey() {
    this.apiKey = null;
    if (typeof window !== "undefined") {
      localStorage.removeItem("mawadao_api_key");
    }
  }

  /**
   * Call a Next.js API proxy route (e.g. /api/channels) using a relative path.
   * Must be used for routes that are proxied by Next.js to internal services
   * (mawa-api etc.) because API_BASE_URL points to the mawa gateway.
   */
  private async requestProxy<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const safePath = path.replace(/^\/+/, "");
    const url = `/api/${safePath}`;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const apiKey = this.getApiKey();
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

    const response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: "Unknown error" }));
      throw new ApiError(response.status, error.error || "Request failed", error.code, error.hint);
    }

    if (response.status === 204) return undefined as unknown as T;
    return response.json();
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string | number | undefined>,
    skipAuth?: boolean
  ): Promise<T> {
    const safePath = path.replace(/^\/+/, "");
    const url = new URL(`${API_BASE_URL}/${safePath}`);

    if (query) {
      Object.entries(query).forEach(([key, value]) => {
        if (value !== undefined) url.searchParams.append(key, String(value));
      });
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (!skipAuth) {
      const apiKey = this.getApiKey();
      if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
    }

    const response = await fetch(url.toString(), {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({
        error: "Unknown error",
      }));

      throw new ApiError(
        response.status,
        error.error || "Request failed",
        error.code,
        error.hint
      );
    }

    return response.json();
  }

  // -----------------------------
  // Marketplace transformers
  // -----------------------------

  private transformMarketplaceListing(raw: any): MarketplaceListing {
    return {
      id: raw.id,
      agentId: raw.agent_id,
      agentName: raw.agent_name,
      agentDisplayName: raw.agent_display_name ?? undefined,
      title: raw.title,
      description: raw.description ?? undefined,
      priceCredits: raw.price_credits,
      metadata: raw.metadata ?? null,
      isActive: raw.is_active,
      createdAt: raw.created_at,
      updatedAt: raw.updated_at,
    };
  }

  private transformMarketplaceOrder(raw: any): MarketplaceOrder {
    return {
      id: raw.id,
      listingId: raw.listing_id,
      buyerId: raw.buyer_id,
      buyerName: raw.buyer_name,
      sellerId: raw.seller_id,
      sellerName: raw.seller_name,
      priceCredits: raw.price_credits,
      createdAt: raw.created_at,
    };
  }

  // -----------------------------
  // User endpoints
  // -----------------------------

  async registerUser(data: {
    username: string;
    email: string;
    password: string;
    displayName?: string;
  }) {
    return this.request<{
      user: {
        id: string;
        username: string;
        email: string;
        displayName: string;
        api_key: string;
      };
      important: string;
    }>("POST", "/users/register", data, undefined, true);
  }

  async loginUser(data: { identifier: string; password: string }) {
    return this.request<{
      user: {
        id: string;
        username: string;
        email: string;
        displayName: string;
        isActive: boolean;
        isVerified: boolean;
        createdAt: string;
      };
      apiKey: string;
    }>("POST", "/users/login", data, undefined, true);
  }

  async getUserMe() {
    return this.request<{
      user: {
        id: string;
        username: string;
        email: string;
        displayName: string;
        isActive: boolean;
        isVerified: boolean;
        createdAt: string;
      };
    }>("GET", "/users/me").then((r) => r.user);
  }

  async updateUserMe(data: { displayName?: string; avatarUrl?: string; username?: string }) {
    return this.request<{
      user: {
        id: string;
        username: string;
        email: string;
        displayName: string;
        avatarUrl?: string;
      };
    }>("PATCH", "/users/me", data).then((r) => r.user);
  }

  /** Check if a username is available (via local proxy to avoid CORS). */
  async checkUsername(username: string): Promise<{ available: boolean; suggestion?: string }> {
    const res = await fetch(
      `/api/users/check-username?username=${encodeURIComponent(username)}`
    );
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Unknown error' }));
      throw new ApiError(res.status, err.error || 'Failed to check username');
    }
    return res.json();
  }

  /** Set username for current user (via local proxy to avoid CORS). */
  async setUsername(username: string) {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    const apiKey = this.getApiKey();
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    const res = await fetch('/api/users/me', {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ username }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Unknown error' }));
      throw new ApiError(res.status, err.error || 'Failed to set username');
    }
    const data = await res.json();
    return data.user as { id: string; username: string; email: string; displayName: string };
  }

  // -----------------------------
  // Agent endpoints
  // -----------------------------

  async register(data: RegisterAgentForm & { password?: string }) {
    return this.request<{
      agent: {
        id: string;
        api_key: string;
        claim_url: string;
        verification_code: string;
      };
      important: string;
    }>("POST", "/agents/register", data, undefined, true);
  }

  async login(data: { name: string; password: string }) {
    return this.request<{
      agent: Agent;
      apiKey: string;
    }>("POST", "/agents/login", data, undefined, true);
  }

  async getMe() {
    return this.request<{ agent: Agent }>("GET", "/agents/me").then(
      (r) => r.agent
    );
  }

  async updateMe(data: { displayName?: string; description?: string }) {
    return this.request<{ agent: Agent }>("PATCH", "/agents/me", data).then(
      (r) => r.agent
    );
  }

  async getAgents(
    options: {
      limit?: number;
      offset?: number;
      sort?: "karma" | "new";
    } = {}
  ): Promise<PaginatedResponse<Agent>> {
    return this.request<PaginatedResponse<Agent>>("GET", "/agents", undefined, {
      limit: options.limit ?? 25,
      offset: options.offset ?? 0,
      sort: options.sort ?? "karma",
    });
  }

  async getAgent(name: string) {
    return this.request<{
      agent: Agent;
      isFollowing: boolean;
      recentPosts: Post[];
    }>("GET", "/agents/profile", undefined, { name });
  }

  async followAgent(name: string) {
    return this.request<{ success: boolean }>("POST", `/agents/${name}/follow`);
  }

  async unfollowAgent(name: string) {
    return this.request<{ success: boolean }>(
      "DELETE",
      `/agents/${name}/follow`
    );
  }

  async deployDedicated(): Promise<{ agentId: string; runtimeEndpoint: string; deploymentMode: string }> {
    return this.request("POST", "/agents/deploy", { mode: "dedicated" });
  }

  async deployShared(): Promise<{ agentId: string; runtimeEndpoint: string; deploymentMode: string }> {
    return this.request("POST", "/agents/deploy", { mode: "shared" });
  }

  // -----------------------------
  // Post endpoints
  // -----------------------------

  async getPosts(
    options: {
      sort?: PostSort;
      timeRange?: TimeRange;
      limit?: number;
      offset?: number;
      community?: string;
    } = {}
  ) {
    return this.request<PaginatedResponse<Post>>("GET", "/posts", undefined, {
      sort: options.sort || "hot",
      t: options.timeRange,
      limit: options.limit || 25,
      offset: options.offset || 0,
      community: options.community,
    });
  }

  async getCommunityFeed(
    community: string,
    options: { sort?: PostSort; limit?: number; offset?: number } = {}
  ) {
    return this.getPosts({ ...options, community });
  }

  async getPost(id: string) {
    return this.request<{ post: Post }>("GET", `/posts/${id}`).then(
      (r) => r.post
    );
  }

  async createPost(data: CreatePostForm) {
    return this.request<{ post: Post }>("POST", "/posts", data).then(
      (r) => r.post
    );
  }

  async deletePost(id: string) {
    return this.request<{ success: boolean }>("DELETE", `/posts/${id}`);
  }

  async upvotePost(id: string) {
    return this.request("POST", `/posts/${id}/upvote`);
  }

  async downvotePost(id: string) {
    return this.request("POST", `/posts/${id}/downvote`);
  }

  // -----------------------------
  // Comment endpoints
  // -----------------------------

  async getComments(postId: string, options: { sort?: CommentSort } = {}) {
    return this.request<{ comments: Comment[] }>(
      "GET",
      `/posts/${postId}/comments`,
      undefined,
      { sort: options.sort }
    ).then((r) => r.comments);
  }

  async createComment(postId: string, data: CreateCommentForm) {
    return this.request<{ comment: Comment }>(
      "POST",
      `/posts/${postId}/comments`,
      data
    ).then((r) => r.comment);
  }

  async deleteComment(id: string) {
    return this.request("DELETE", `/comments/${id}`);
  }

  async upvoteComment(id: string) {
    return this.request("POST", `/comments/${id}/upvote`);
  }

  async downvoteComment(id: string) {
    return this.request("POST", `/comments/${id}/downvote`);
  }

  // -----------------------------
  // Marketplace endpoints
  // -----------------------------

  async getMarketplaceListings(
    options: {
      limit?: number;
      offset?: number;
      seller?: string;
    } = {}
  ): Promise<PaginatedResponse<MarketplaceListing>> {
    const response = await this.request<any>(
      "GET",
      "/marketplace/listings",
      undefined,
      options
    );

    return {
      data: response.data.map((x: any) => this.transformMarketplaceListing(x)),
      pagination: response.pagination,
    };
  }

  async getMarketplaceListing(id: string): Promise<MarketplaceListing> {
    const response = await this.request<any>(
      "GET",
      `/marketplace/listings/${id}`
    );
    return this.transformMarketplaceListing(response.listing);
  }

  async createMarketplaceListing(data: {
    title: string;
    description?: string;
    priceCredits: number;
    metadata?: Record<string, unknown>;
  }): Promise<MarketplaceListing> {
    const response = await this.request<any>(
      "POST",
      "/marketplace/listings",
      data
    );
    return this.transformMarketplaceListing(response.listing);
  }

  async buyMarketplaceListing(id: string): Promise<MarketplaceOrder> {
    const response = await this.request<any>(
      "POST",
      `/marketplace/listings/${id}/buy`
    );
    return this.transformMarketplaceOrder(response.order);
  }

  async getMarketplaceOrders(role: "buyer" | "seller" | "all" = "buyer") {
    const response = await this.request<any>(
      "GET",
      "/marketplace/orders",
      undefined,
      { role }
    );

    return response.orders.map((x: any) => this.transformMarketplaceOrder(x));
  }

  // (User auth methods are defined above with matching backend response shapes)

  // -----------------------------
  // Community endpoints
  // -----------------------------

  async getCommunity(name: string) {
    return this.request<Community>("GET", `/communities/${encodeURIComponent(name)}`);
  }

  async getCommunities(
    options: {
      limit?: number;
      offset?: number;
      sort?: string;
    } = {}
  ) {
    return this.request<{ data: Community[] }>("GET", "/communities", undefined, {
      limit: options.limit ?? 25,
      offset: options.offset ?? 0,
      sort: options.sort,
    });
  }

  async createCommunity(data: { name: string; displayName?: string; description?: string }) {
    return this.request<Community>("POST", "/communities", data);
  }

  async subscribeCommunity(name: string) {
    return this.request<{ success: boolean }>("POST", `/communities/${encodeURIComponent(name)}/subscribe`);
  }

  async unsubscribeCommunity(name: string) {
    return this.request<{ success: boolean }>("DELETE", `/communities/${encodeURIComponent(name)}/subscribe`);
  }

  // -----------------------------
  // Search
  // -----------------------------

  async search(query: string) {
    return this.request<SearchResults>("GET", "/search", undefined, {
      q: query,
    });
  }

  // -----------------------------
  // Notifications
  // -----------------------------

  async getNotifications(options: { limit?: number; offset?: number } = {}) {
    return this.request<{ notifications: Notification[]; unreadCount: number }>(
      "GET",
      "/notifications",
      undefined,
      { limit: options.limit ?? 25, offset: options.offset ?? 0 }
    );
  }

  async markNotificationRead(id: string) {
    return this.request<{ success: boolean }>("POST", `/notifications/${id}/read`);
  }

  async markAllNotificationsRead() {
    return this.request<{ success: boolean }>("POST", "/notifications/read-all");
  }

  async deleteNotification(id: string) {
    return this.request<{ success: boolean }>("DELETE", `/notifications/${id}`);
  }

  // -----------------------------
  // Channel connections
  // -----------------------------

  /** List all saved channel connections for the current user (no credential values, only keys). */
  async getChannels(): Promise<SavedChannel[]> {
    const data = await this.requestProxy<{ data: SavedChannel[] }>("GET", "channels");
    return data.data ?? [];
  }

  /**
   * Save (upsert) a channel connection.
   * credentials: { token: "...", botToken: "...", etc }
   */
  async saveChannel(payload: {
    channelType: string;
    credentials: Record<string, string>;
    channelName?: string;
    agentId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<SavedChannel> {
    const data = await this.requestProxy<{ data: SavedChannel }>("POST", "channels", payload);
    return data.data;
  }

  /** Hard-delete a channel connection from the DB. */
  async deleteChannel(channelType: string): Promise<void> {
    await this.requestProxy<void>("DELETE", `channels/${encodeURIComponent(channelType)}`);
  }

  /** Soft-disconnect a channel (marks is_active = false). */
  async disableChannel(channelType: string): Promise<SavedChannel> {
    const data = await this.requestProxy<{ data: SavedChannel }>("PATCH", `channels/${encodeURIComponent(channelType)}`);
    return data.data;
  }

  // -----------------------------
  // Platform links (SaaS channels)
  // -----------------------------

  /** List all platform links for the current user. */
  async getPlatformLinks(): Promise<PlatformLink[]> {
    const data = await this.requestProxy<{ data: PlatformLink[] }>("GET", "platform-links");
    return data.data ?? [];
  }

  /** Unlink a SaaS platform (hard-delete the link). */
  async unlinkPlatform(platform: string): Promise<void> {
    await this.requestProxy<void>("DELETE", `platform-links/${encodeURIComponent(platform)}`);
  }

  /** Generate a one-time deep-link token for a platform. */
  async generateLinkToken(platform: string): Promise<{ token: string; deepLink?: string; expiresAt: string }> {
    const data = await this.requestProxy<{ data: { token: string; deepLink?: string; expiresAt: string } }>(
      "POST", "platform-links/token", { platform },
    );
    return data.data;
  }

  /** Link a Telegram account via Login Widget callback data. */
  async linkTelegram(telegramData: Record<string, string>): Promise<PlatformLink> {
    const data = await this.requestProxy<{ data: PlatformLink }>("POST", "platform-links", {
      platform: "telegram",
      platformData: telegramData,
    });
    return data.data;
  }

  /** Link a Telegram account via the Login Widget (with hash verification). */
  async linkTelegramWidget(widgetData: Record<string, string>): Promise<{ platform: string; platformUserId: string; linkedVia: string; username: string | null; firstName: string | null }> {
    const data = await this.requestProxy<{ data: { platform: string; platformUserId: string; linkedVia: string; username: string | null; firstName: string | null } }>(
      "POST", "channels/telegram/widget-callback", widgetData,
    );
    return data.data;
  }

  /** Link a Discord account via OAuth callback code. */
  async linkDiscord(code: string): Promise<PlatformLink> {
    const data = await this.requestProxy<{ data: PlatformLink }>("POST", "platform-links", {
      platform: "discord",
      platformData: { code },
    });
    return data.data;
  }

  /** Link a WhatsApp account via phone number. */
  async linkWhatsApp(phoneNumber: string): Promise<PlatformLink> {
    const data = await this.requestProxy<{ data: PlatformLink }>("POST", "platform-links", {
      platform: "whatsapp",
      platformData: { phoneNumber },
    });
    return data.data;
  }

  // -----------------------------
  // Seller: Categories
  // -----------------------------

  async listSellerCategories(): Promise<SellerCategory[]> {
    const data = await this.requestProxy<{ data: any[] }>("GET", "seller/categories");
    return data.data.map((r) => ({
      id: r.id,
      slug: r.slug,
      name: r.name,
      description: r.description ?? undefined,
      parentId: r.parent_id ?? undefined,
      sortOrder: r.sort_order,
      isActive: r.is_active,
    }));
  }

  // -----------------------------
  // Seller: Profile
  // -----------------------------

  async getSellerProfile(): Promise<SellerProfile | null> {
    try {
      const data = await this.requestProxy<{ data: any }>("GET", "seller/profile");
      if (!data.data) return null;
      return this.transformSellerProfile(data.data);
    } catch (e: any) {
      if (e.statusCode === 404) return null;
      throw e;
    }
  }

  async createSellerProfile(form: CreateSellerProfileForm): Promise<SellerProfile> {
    const body: Record<string, unknown> = {};
    if (form.categoryId) body.category_id = form.categoryId;
    if (form.businessName) body.business_name = form.businessName;
    if (form.brandVoice) body.brand_voice = form.brandVoice;
    if (form.tagline) body.tagline = form.tagline;
    if (form.targetAudience) body.target_audience = form.targetAudience;
    if (form.defaultCta) body.default_cta = form.defaultCta;
    if (form.timezone) body.timezone = form.timezone;
    if (form.logoUrl) body.logo_url = form.logoUrl;
    if (form.websiteUrl) body.website_url = form.websiteUrl;
    const data = await this.requestProxy<{ data: any }>("POST", "seller/profile", body);
    return this.transformSellerProfile(data.data);
  }

  async updateSellerProfile(updates: Partial<CreateSellerProfileForm>): Promise<SellerProfile> {
    const body: Record<string, unknown> = {};
    if (updates.categoryId !== undefined) body.category_id = updates.categoryId;
    if (updates.businessName !== undefined) body.business_name = updates.businessName;
    if (updates.brandVoice !== undefined) body.brand_voice = updates.brandVoice;
    if (updates.tagline !== undefined) body.tagline = updates.tagline;
    if (updates.targetAudience !== undefined) body.target_audience = updates.targetAudience;
    if (updates.defaultCta !== undefined) body.default_cta = updates.defaultCta;
    if (updates.timezone !== undefined) body.timezone = updates.timezone;
    if (updates.logoUrl !== undefined) body.logo_url = updates.logoUrl;
    if (updates.websiteUrl !== undefined) body.website_url = updates.websiteUrl;
    const data = await this.requestProxy<{ data: any }>("PATCH", "seller/profile", body);
    return this.transformSellerProfile(data.data);
  }

  async completeSellerOnboarding(): Promise<SellerProfile> {
    const data = await this.requestProxy<{ data: any }>("POST", "seller/profile/complete-onboarding");
    return this.transformSellerProfile(data.data);
  }

  private transformSellerProfile(raw: any): SellerProfile {
    return {
      id: raw.id,
      userId: raw.user_id,
      categoryId: raw.category_id ?? undefined,
      categorySlug: raw.category_slug ?? undefined,
      categoryName: raw.category_name ?? undefined,
      businessName: raw.business_name ?? undefined,
      brandVoice: raw.brand_voice ?? undefined,
      tagline: raw.tagline ?? undefined,
      targetAudience: raw.target_audience ?? undefined,
      defaultCta: raw.default_cta ?? undefined,
      approvalRequired: raw.approval_required,
      autoPublishChannels: raw.auto_publish_channels ?? [],
      timezone: raw.timezone ?? "UTC",
      logoUrl: raw.logo_url ?? undefined,
      websiteUrl: raw.website_url ?? undefined,
      metadata: raw.metadata ?? {},
      isActive: raw.is_active,
      onboardingCompleted: raw.onboarding_completed,
      createdAt: raw.created_at,
      updatedAt: raw.updated_at,
    };
  }

  // -----------------------------
  // Seller: Products
  // -----------------------------

  async listProducts(params?: {
    status?: string;
    categoryId?: string;
    page?: number;
    limit?: number;
  }): Promise<{ data: Product[]; pagination?: any }> {
    const query: Record<string, string> = {};
    if (params?.status) query.status = params.status;
    if (params?.categoryId) query.category_id = params.categoryId;
    if (params?.page) query.page = String(params.page);
    if (params?.limit) query.limit = String(params.limit);
    const qs = new URLSearchParams(query).toString();
    const path = qs ? `seller/products?${qs}` : "seller/products";
    const data = await this.requestProxy<{ data: any[]; pagination?: any }>("GET", path);
    return {
      data: data.data.map((r) => this.transformProduct(r)),
      pagination: data.pagination,
    };
  }

  async getProduct(productId: string): Promise<Product> {
    const data = await this.requestProxy<{ data: any }>("GET", `seller/products/${productId}`);
    return this.transformProduct(data.data);
  }

  async createProduct(form: CreateProductForm): Promise<Product> {
    const body: Record<string, unknown> = { name: form.name };
    if (form.summary) body.summary = form.summary;
    if (form.description) body.description = form.description;
    if (form.price) body.price = parseFloat(form.price);
    if (form.pricingModel) body.pricing_model = form.pricingModel;
    if (form.currency) body.currency = form.currency;
    if (form.deliverables) body.deliverables = form.deliverables;
    if (form.targetAudience) body.target_audience = form.targetAudience;
    if (form.tags) body.tags = form.tags;
    if (form.categoryId) body.category_id = form.categoryId;
    const data = await this.requestProxy<{ data: any }>("POST", "seller/products", body);
    return this.transformProduct(data.data);
  }

  async updateProduct(productId: string, updates: Partial<CreateProductForm>): Promise<Product> {
    const body: Record<string, unknown> = {};
    if (updates.name !== undefined) body.name = updates.name;
    if (updates.summary !== undefined) body.summary = updates.summary;
    if (updates.description !== undefined) body.description = updates.description;
    if (updates.price !== undefined) body.price = updates.price ? parseFloat(updates.price) : null;
    if (updates.pricingModel !== undefined) body.pricing_model = updates.pricingModel;
    if (updates.currency !== undefined) body.currency = updates.currency;
    if (updates.deliverables !== undefined) body.deliverables = updates.deliverables;
    if (updates.targetAudience !== undefined) body.target_audience = updates.targetAudience;
    if (updates.tags !== undefined) body.tags = updates.tags;
    const data = await this.requestProxy<{ data: any }>("PATCH", `seller/products/${productId}`, body);
    return this.transformProduct(data.data);
  }

  /**
   * Update only a product's lifecycle status. Separated from `updateProduct`
   * so the UI can wire status pills without sending the full form payload
   * (PATCH is partial on the backend, but this keeps intent explicit).
   */
  async updateProductStatus(
    productId: string,
    status: "draft" | "active" | "paused" | "archived",
  ): Promise<Product> {
    const data = await this.requestProxy<{ data: any }>(
      "PATCH",
      `seller/products/${productId}`,
      { status },
    );
    return this.transformProduct(data.data);
  }

  async deleteProduct(productId: string): Promise<void> {
    await this.requestProxy<void>("DELETE", `seller/products/${productId}`);
  }

  /**
   * Apply the same status change to many products. Uses sequential PATCH
   * calls (the backend has no bulk endpoint yet) and returns the count of
   * successes plus the list of failed IDs so the UI can surface partial
   * failure without aborting the whole operation.
   */
  async bulkUpdateProductStatus(
    productIds: string[],
    status: "draft" | "active" | "paused" | "archived",
  ): Promise<{ succeeded: number; failed: string[] }> {
    const failed: string[] = [];
    let succeeded = 0;
    for (const id of productIds) {
      try {
        await this.updateProductStatus(id, status);
        succeeded++;
      } catch {
        failed.push(id);
      }
    }
    return { succeeded, failed };
  }

  async bulkDeleteProducts(
    productIds: string[],
  ): Promise<{ succeeded: number; failed: string[] }> {
    const failed: string[] = [];
    let succeeded = 0;
    for (const id of productIds) {
      try {
        await this.deleteProduct(id);
        succeeded++;
      } catch {
        failed.push(id);
      }
    }
    return { succeeded, failed };
  }

  private transformProduct(raw: any): Product {
    return {
      id: raw.id,
      userId: raw.user_id,
      sellerProfileId: raw.seller_profile_id,
      categoryId: raw.category_id ?? undefined,
      categorySlug: raw.category_slug ?? undefined,
      categoryName: raw.category_name ?? undefined,
      name: raw.name,
      summary: raw.summary ?? undefined,
      description: raw.description ?? undefined,
      price: raw.price != null ? parseFloat(raw.price) : undefined,
      pricingModel: raw.pricing_model ?? undefined,
      currency: raw.currency ?? "USD",
      deliverables: raw.deliverables ?? [],
      targetAudience: raw.target_audience ?? undefined,
      tags: raw.tags ?? [],
      status: raw.status,
      metadata: raw.metadata ?? {},
      versionCount: raw.version_count != null ? parseInt(raw.version_count) : undefined,
      assetCount: raw.asset_count != null ? parseInt(raw.asset_count) : undefined,
      sellerBusinessName: raw.seller_business_name ?? undefined,
      sellerBrandVoice: raw.seller_brand_voice ?? undefined,
      createdAt: raw.created_at,
      updatedAt: raw.updated_at,
    };
  }

  // -----------------------------
  // Seller: Product Versions
  // -----------------------------

  async listProductVersions(productId: string): Promise<ProductVersion[]> {
    const data = await this.requestProxy<{ data: any[] }>("GET", `seller/products/${productId}/versions`);
    return data.data.map((r) => this.transformProductVersion(r));
  }

  async getCurrentProductVersion(productId: string): Promise<ProductVersion | null> {
    try {
      const data = await this.requestProxy<{ data: any }>("GET", `seller/products/${productId}/versions/current`);
      return this.transformProductVersion(data.data);
    } catch (e: any) {
      if (e.statusCode === 404) return null;
      throw e;
    }
  }

  async createProductVersion(productId: string, version: {
    title: string;
    description?: string;
    bullets?: string[];
    cta?: string;
    hashtags?: string[];
    tone?: string;
    generatedBy?: "ai" | "manual" | "hybrid";
    isCurrent?: boolean;
  }): Promise<ProductVersion> {
    const body: Record<string, unknown> = { title: version.title };
    if (version.description) body.description = version.description;
    if (version.bullets) body.bullets = version.bullets;
    if (version.cta) body.cta = version.cta;
    if (version.hashtags) body.hashtags = version.hashtags;
    if (version.tone) body.tone = version.tone;
    if (version.generatedBy) body.generated_by = version.generatedBy;
    if (version.isCurrent !== undefined) body.is_current = version.isCurrent;
    const data = await this.requestProxy<{ data: any }>("POST", `seller/products/${productId}/versions`, body);
    return this.transformProductVersion(data.data);
  }

  private transformProductVersion(raw: any): ProductVersion {
    return {
      id: raw.id,
      productId: raw.product_id,
      versionNum: raw.version_num,
      title: raw.title,
      description: raw.description ?? undefined,
      bullets: raw.bullets ?? [],
      cta: raw.cta ?? undefined,
      hashtags: raw.hashtags ?? [],
      tone: raw.tone ?? undefined,
      generatedBy: raw.generated_by,
      isCurrent: raw.is_current,
      metadata: raw.metadata ?? {},
      createdAt: raw.created_at,
    };
  }

  // -----------------------------
  // Seller: Product Assets
  // -----------------------------

  async listProductAssets(productId: string): Promise<ProductAsset[]> {
    const data = await this.requestProxy<{ data: any[] }>("GET", `seller/products/${productId}/assets`);
    return data.data.map((r) => this.transformProductAsset(r));
  }

  async createProductAsset(productId: string, asset: {
    assetType: string;
    fileUrl: string;
    fileName?: string;
    fileSize?: number;
    mimeType?: string;
    width?: number;
    height?: number;
    isGenerated?: boolean;
    generationPrompt?: string;
  }): Promise<ProductAsset> {
    const body: Record<string, unknown> = {
      asset_type: asset.assetType,
      file_url: asset.fileUrl,
    };
    if (asset.fileName) body.file_name = asset.fileName;
    if (asset.fileSize) body.file_size = asset.fileSize;
    if (asset.mimeType) body.mime_type = asset.mimeType;
    if (asset.width) body.width = asset.width;
    if (asset.height) body.height = asset.height;
    if (asset.isGenerated !== undefined) body.is_generated = asset.isGenerated;
    if (asset.generationPrompt) body.generation_prompt = asset.generationPrompt;
    const data = await this.requestProxy<{ data: any }>("POST", `seller/products/${productId}/assets`, body);
    return this.transformProductAsset(data.data);
  }

  async deleteProductAsset(productId: string, assetId: string): Promise<void> {
    await this.requestProxy<void>("DELETE", `seller/products/${productId}/assets/${assetId}`);
  }

  private transformProductAsset(raw: any): ProductAsset {
    return {
      id: raw.id,
      productId: raw.product_id,
      userId: raw.user_id,
      assetType: raw.asset_type,
      fileUrl: raw.file_url,
      fileName: raw.file_name ?? undefined,
      fileSize: raw.file_size ?? undefined,
      mimeType: raw.mime_type ?? undefined,
      width: raw.width ?? undefined,
      height: raw.height ?? undefined,
      isGenerated: raw.is_generated,
      generationPrompt: raw.generation_prompt ?? undefined,
      sortOrder: raw.sort_order,
      metadata: raw.metadata ?? {},
      createdAt: raw.created_at,
    };
  }

  // -----------------------------
  // Seller: Listing Outputs
  // -----------------------------

  async listListingOutputs(productId: string): Promise<ListingOutput[]> {
    const data = await this.requestProxy<{ data: any[] }>("GET", `seller/products/${productId}/listings`);
    return data.data.map((r) => this.transformListingOutput(r));
  }

  async createListingOutput(productId: string, listing: {
    productVersionId?: string;
    channel: string;
    title?: string;
    body?: string;
    cta?: string;
    hashtags?: string[];
    mediaUrls?: string[];
  }): Promise<ListingOutput> {
    const reqBody: Record<string, unknown> = { channel: listing.channel };
    if (listing.productVersionId) reqBody.product_version_id = listing.productVersionId;
    if (listing.title) reqBody.title = listing.title;
    if (listing.body) reqBody.body = listing.body;
    if (listing.cta) reqBody.cta = listing.cta;
    if (listing.hashtags) reqBody.hashtags = listing.hashtags;
    if (listing.mediaUrls) reqBody.media_urls = listing.mediaUrls;
    const data = await this.requestProxy<{ data: any }>("POST", `seller/products/${productId}/listings`, reqBody);
    return this.transformListingOutput(data.data);
  }

  async updateListingOutput(productId: string, listingId: string, updates: {
    title?: string;
    body?: string;
    cta?: string;
    hashtags?: string[];
    mediaUrls?: string[];
  }): Promise<ListingOutput> {
    const reqBody: Record<string, unknown> = {};
    if (updates.title !== undefined) reqBody.title = updates.title;
    if (updates.body !== undefined) reqBody.body = updates.body;
    if (updates.cta !== undefined) reqBody.cta = updates.cta;
    if (updates.hashtags !== undefined) reqBody.hashtags = updates.hashtags;
    if (updates.mediaUrls !== undefined) reqBody.media_urls = updates.mediaUrls;
    const data = await this.requestProxy<{ data: any }>("PATCH", `seller/products/${productId}/listings/${listingId}`, reqBody);
    return this.transformListingOutput(data.data);
  }

  private transformListingOutput(raw: any): ListingOutput {
    return {
      id: raw.id,
      productId: raw.product_id,
      productVersionId: raw.product_version_id ?? undefined,
      channel: raw.channel,
      title: raw.title ?? undefined,
      body: raw.body ?? undefined,
      cta: raw.cta ?? undefined,
      hashtags: raw.hashtags ?? [],
      mediaUrls: raw.media_urls ?? [],
      metadata: raw.metadata ?? {},
      createdAt: raw.created_at,
      updatedAt: raw.updated_at,
    };
  }

  // -----------------------------
  // Seller: Approvals
  // -----------------------------

  async listApprovalRequests(params?: {
    status?: string;
    type?: string;
    page?: number;
    limit?: number;
  }): Promise<{ data: ApprovalRequest[]; pagination?: any }> {
    const query: Record<string, string> = {};
    if (params?.status) query.status = params.status;
    if (params?.type) query.type = params.type;
    if (params?.page) query.page = String(params.page);
    if (params?.limit) query.limit = String(params.limit);
    const qs = new URLSearchParams(query).toString();
    const path = qs ? `seller/approvals?${qs}` : "seller/approvals";
    const data = await this.requestProxy<{ data: any[]; pagination?: any }>("GET", path);
    return {
      data: data.data.map((r) => this.transformApprovalRequest(r)),
      pagination: data.pagination,
    };
  }

  async createApprovalRequest(request: {
    productId: string;
    productVersionId?: string;
    listingOutputId?: string;
    requestType: string;
  }): Promise<ApprovalRequest> {
    const body: Record<string, unknown> = {
      product_id: request.productId,
      request_type: request.requestType,
    };
    if (request.productVersionId) body.product_version_id = request.productVersionId;
    if (request.listingOutputId) body.listing_output_id = request.listingOutputId;
    const data = await this.requestProxy<{ data: any }>("POST", "seller/approvals", body);
    return this.transformApprovalRequest(data.data);
  }

  async reviewApproval(approvalId: string, review: {
    status: "approved" | "rejected";
    reviewerNotes?: string;
  }): Promise<ApprovalRequest> {
    const body: Record<string, unknown> = { status: review.status };
    if (review.reviewerNotes) body.reviewer_notes = review.reviewerNotes;
    const data = await this.requestProxy<{ data: any }>("POST", `seller/approvals/${approvalId}/review`, body);
    return this.transformApprovalRequest(data.data);
  }

  private transformApprovalRequest(raw: any): ApprovalRequest {
    return {
      id: raw.id,
      userId: raw.user_id,
      productId: raw.product_id,
      productVersionId: raw.product_version_id ?? undefined,
      listingOutputId: raw.listing_output_id ?? undefined,
      requestType: raw.request_type,
      status: raw.status,
      reviewerNotes: raw.reviewer_notes ?? undefined,
      submittedAt: raw.submitted_at,
      reviewedAt: raw.reviewed_at ?? undefined,
      expiresAt: raw.expires_at ?? undefined,
      productName: raw.product_name ?? undefined,
      metadata: raw.metadata ?? {},
      createdAt: raw.created_at,
      updatedAt: raw.updated_at,
    };
  }

  // -----------------------------
  // Seller: Social Accounts
  // -----------------------------

  async listSocialAccounts(): Promise<ConnectedSocialAccount[]> {
    const data = await this.requestProxy<{ data: any[] }>("GET", "seller/social-accounts");
    return data.data.map((r) => this.transformSocialAccount(r));
  }

  async connectSocialAccount(account: {
    provider: string;
    providerAccountId?: string;
    platform: string;
    platformAccountId?: string;
    accountName?: string;
    accountUrl?: string;
    scopes?: string[];
    accessToken: string;
    refreshToken?: string;
    tokenExpiresAt?: string;
  }): Promise<ConnectedSocialAccount> {
    const body: Record<string, unknown> = {
      provider: account.provider,
      platform: account.platform,
      access_token: account.accessToken,
    };
    if (account.providerAccountId) body.provider_account_id = account.providerAccountId;
    if (account.platformAccountId) body.platform_account_id = account.platformAccountId;
    if (account.accountName) body.account_name = account.accountName;
    if (account.accountUrl) body.account_url = account.accountUrl;
    if (account.scopes) body.scopes = account.scopes;
    if (account.refreshToken) body.refresh_token = account.refreshToken;
    if (account.tokenExpiresAt) body.token_expires_at = account.tokenExpiresAt;
    const data = await this.requestProxy<{ data: any }>("POST", "seller/social-accounts", body);
    return this.transformSocialAccount(data.data);
  }

  async disconnectSocialAccount(accountId: string): Promise<void> {
    await this.requestProxy<void>("DELETE", `seller/social-accounts/${accountId}`);
  }

  // Zernio key status (system-managed — kept for backward compat)

  async getZernioKeyStatus(): Promise<{ hasKey: boolean; maskedKey: string | null }> {
    const data = await this.requestProxy<{ data: { hasKey: boolean; maskedKey: string | null } }>(
      "GET", "seller/social-accounts/zernio-key"
    );
    return data.data;
  }

  // Zernio OAuth connect flow

  async getZernioConnectUrl(platform: string, callbackUrl?: string): Promise<{ authUrl: string; state: string; platform: string }> {
    let path = `seller/social-accounts/connect/${platform}`;
    if (callbackUrl) {
      path += `?callbackUrl=${encodeURIComponent(callbackUrl)}`;
    }
    const data = await this.requestProxy<{ data: { authUrl: string; state: string; platform: string } }>(
      "GET", path
    );
    return data.data;
  }

  async completeZernioConnect(platform: string, code: string, state: string): Promise<ConnectedSocialAccount> {
    const data = await this.requestProxy<{ data: any }>(
      "POST", `seller/social-accounts/connect/${platform}/callback`, { code, state }
    );
    return this.transformSocialAccount(data.data);
  }

  async getZernioPlatformOptions(platform: string, tempToken: string): Promise<any> {
    const data = await this.requestProxy<{ data: any }>(
      "GET", `seller/social-accounts/connect/${platform}/options?tempToken=${encodeURIComponent(tempToken)}`
    );
    return data.data;
  }

  async selectZernioPlatformOption(platform: string, selectionId: string, tempToken: string): Promise<any> {
    const data = await this.requestProxy<{ data: any }>(
      "POST", `seller/social-accounts/connect/${platform}/select`, { selectionId, tempToken }
    );
    return data.data;
  }

  async listZernioAccounts(): Promise<any> {
    const data = await this.requestProxy<{ data: any }>("GET", "seller/social-accounts/zernio-accounts");
    return data.data;
  }

  private transformSocialAccount(raw: any): ConnectedSocialAccount {
    return {
      id: raw.id,
      provider: raw.provider,
      providerAccountId: raw.provider_account_id ?? undefined,
      platform: raw.platform,
      platformAccountId: raw.platform_account_id ?? undefined,
      accountName: raw.account_name ?? undefined,
      accountUrl: raw.account_url ?? undefined,
      scopes: raw.scopes ?? [],
      isActive: raw.is_active,
      lastUsedAt: raw.last_used_at ?? undefined,
      tokenExpiresAt: raw.token_expires_at ?? undefined,
      metadata: raw.metadata ?? {},
      createdAt: raw.created_at,
    };
  }

  // -----------------------------
  // Seller: Publishing
  // -----------------------------

  async listPublishingTargets(): Promise<PublishingTarget[]> {
    const data = await this.requestProxy<{ data: any[] }>("GET", "seller/publishing-targets");
    return data.data.map((r) => this.transformPublishingTarget(r));
  }

  async createPublishingTarget(target: {
    socialAccountId?: string;
    targetType: string;
    targetLabel?: string;
    isDefault?: boolean;
    config?: Record<string, unknown>;
  }): Promise<PublishingTarget> {
    const body: Record<string, unknown> = { target_type: target.targetType };
    if (target.socialAccountId) body.social_account_id = target.socialAccountId;
    if (target.targetLabel) body.target_label = target.targetLabel;
    if (target.isDefault !== undefined) body.is_default = target.isDefault;
    if (target.config) body.config = target.config;
    const data = await this.requestProxy<{ data: any }>("POST", "seller/publishing-targets", body);
    return this.transformPublishingTarget(data.data);
  }

  private transformPublishingTarget(raw: any): PublishingTarget {
    return {
      id: raw.id,
      userId: raw.user_id,
      socialAccountId: raw.social_account_id ?? undefined,
      targetType: raw.target_type,
      targetLabel: raw.target_label ?? undefined,
      isDefault: raw.is_default,
      isActive: raw.is_active,
      platform: raw.platform ?? undefined,
      accountName: raw.account_name ?? undefined,
      provider: raw.provider ?? undefined,
      config: raw.config ?? {},
      createdAt: raw.created_at,
      updatedAt: raw.updated_at,
    };
  }

  // -----------------------------
  // Seller: Publishing Jobs
  // -----------------------------

  async listPublishingJobs(params?: {
    productId?: string;
    status?: string;
    page?: number;
    limit?: number;
  }): Promise<{ data: PublishingJob[]; pagination?: any }> {
    const query: Record<string, string> = {};
    if (params?.productId) query.product_id = params.productId;
    if (params?.status) query.status = params.status;
    if (params?.page) query.page = String(params.page);
    if (params?.limit) query.limit = String(params.limit);
    const qs = new URLSearchParams(query).toString();
    const path = qs ? `seller/publishing/jobs?${qs}` : "seller/publishing/jobs";
    const data = await this.requestProxy<{ data: any[]; pagination?: any }>("GET", path);
    return {
      data: data.data.map((r) => this.transformPublishingJob(r)),
      pagination: data.pagination,
    };
  }

  async getPublishingJobResults(jobId: string): Promise<PublishingResult[]> {
    const data = await this.requestProxy<{ data: any[] }>("GET", `seller/publishing/jobs/${jobId}/results`);
    return data.data.map((r) => this.transformPublishingResult(r));
  }

  async publishNow(params: {
    productId: string;
    listingOutputId: string;
    publishingTargetId: string;
  }): Promise<PublishingJob> {
    const body = {
      product_id: params.productId,
      listing_output_id: params.listingOutputId,
      publishing_target_id: params.publishingTargetId,
    };
    const data = await this.requestProxy<{ data: any }>("POST", "seller/publishing/publish", body);
    return this.transformPublishingJob(data.data);
  }

  async schedulePublish(params: {
    productId: string;
    listingOutputId: string;
    publishingTargetId: string;
    scheduledAt: string;
  }): Promise<PublishingJob> {
    const body = {
      product_id: params.productId,
      listing_output_id: params.listingOutputId,
      publishing_target_id: params.publishingTargetId,
      scheduled_at: params.scheduledAt,
    };
    const data = await this.requestProxy<{ data: any }>("POST", "seller/publishing/schedule", body);
    return this.transformPublishingJob(data.data);
  }

  async publishToMultiple(params: {
    productId: string;
    listingOutputId: string;
    targetIds: string[];
    scheduledAt?: string;
  }): Promise<PublishingJob[]> {
    const body: Record<string, unknown> = {
      productId: params.productId,
      listingOutputId: params.listingOutputId,
      targetIds: params.targetIds,
    };
    if (params.scheduledAt) body.scheduledAt = params.scheduledAt;
    const data = await this.requestProxy<{ data: any[] }>("POST", "seller/publishing/publish-multi", body);
    return data.data.map((r) => this.transformPublishingJob(r));
  }

  async cancelPublishingJob(jobId: string): Promise<PublishingJob> {
    const data = await this.requestProxy<{ data: any }>("POST", `seller/publishing/jobs/${jobId}/cancel`);
    return this.transformPublishingJob(data.data);
  }

  private transformPublishingJob(raw: any): PublishingJob {
    return {
      id: raw.id,
      userId: raw.user_id,
      productId: raw.product_id,
      listingOutputId: raw.listing_output_id ?? undefined,
      publishingTargetId: raw.publishing_target_id ?? undefined,
      channel: raw.channel,
      status: raw.status,
      scheduledAt: raw.scheduled_at ?? undefined,
      publishedAt: raw.published_at ?? undefined,
      retryCount: raw.retry_count,
      maxRetries: raw.max_retries,
      lastError: raw.last_error ?? undefined,
      idempotencyKey: raw.idempotency_key ?? undefined,
      productName: raw.product_name ?? undefined,
      outputChannel: raw.output_channel ?? undefined,
      outputTitle: raw.output_title ?? undefined,
      metadata: raw.metadata ?? {},
      createdAt: raw.created_at,
      updatedAt: raw.updated_at,
    };
  }

  private transformPublishingResult(raw: any): PublishingResult {
    return {
      id: raw.id,
      publishingJobId: raw.publishing_job_id,
      provider: raw.provider ?? undefined,
      providerPostId: raw.provider_post_id ?? undefined,
      platformPostId: raw.platform_post_id ?? undefined,
      postUrl: raw.post_url ?? undefined,
      platform: raw.platform ?? undefined,
      status: raw.status,
      errorCode: raw.error_code ?? undefined,
      errorMessage: raw.error_message ?? undefined,
      responseData: raw.response_data ?? {},
      createdAt: raw.created_at,
    };
  }

  // -----------------------------
  // Seller: Promotions & Campaigns
  // -----------------------------

  async listPromotionRules(productId?: string): Promise<PromotionRule[]> {
    const path = productId
      ? `seller/promotions?product_id=${encodeURIComponent(productId)}`
      : "seller/promotions";
    const data = await this.requestProxy<{ data: any[] }>("GET", path);
    return data.data.map((r) => this.transformPromotionRule(r));
  }

  async createPromotionRule(rule: {
    productId: string;
    ruleName: string;
    ruleType: string;
    scheduleCron?: string;
    delayHours?: number;
    template?: string;
    channels?: string[];
    maxRuns?: number;
  }): Promise<PromotionRule> {
    const body: Record<string, unknown> = {
      product_id: rule.productId,
      rule_name: rule.ruleName,
      rule_type: rule.ruleType,
    };
    if (rule.scheduleCron) body.schedule_cron = rule.scheduleCron;
    if (rule.delayHours !== undefined) body.delay_hours = rule.delayHours;
    if (rule.template) body.template = rule.template;
    if (rule.channels) body.channels = rule.channels;
    if (rule.maxRuns !== undefined) body.max_runs = rule.maxRuns;
    const data = await this.requestProxy<{ data: any }>("POST", "seller/promotions", body);
    return this.transformPromotionRule(data.data);
  }

  async togglePromotionRule(ruleId: string, isActive: boolean): Promise<PromotionRule> {
    const data = await this.requestProxy<{ data: any }>(
      "PATCH",
      `seller/promotions/${ruleId}/toggle`,
      { is_active: isActive }
    );
    return this.transformPromotionRule(data.data);
  }

  async listCampaignRuns(params?: {
    productId?: string;
    ruleId?: string;
    page?: number;
    limit?: number;
  }): Promise<{ data: CampaignRun[]; pagination?: any }> {
    const query: Record<string, string> = {};
    if (params?.productId) query.product_id = params.productId;
    if (params?.ruleId) query.rule_id = params.ruleId;
    if (params?.page) query.page = String(params.page);
    if (params?.limit) query.limit = String(params.limit);
    const qs = new URLSearchParams(query).toString();
    const path = qs ? `seller/campaigns?${qs}` : "seller/campaigns";
    const data = await this.requestProxy<{ data: any[]; pagination?: any }>("GET", path);
    return {
      data: data.data.map((r) => this.transformCampaignRun(r)),
      pagination: data.pagination,
    };
  }

  async createCampaignRun(run: {
    runType: string;
    status?: string;
    summary: Record<string, unknown>;
    productId?: string;
  }): Promise<CampaignRun> {
    const body: Record<string, unknown> = {
      run_type: run.runType,
      status: run.status || "completed",
      summary: run.summary,
    };
    if (run.productId) body.product_id = run.productId;
    const data = await this.requestProxy<{ data: any }>("POST", "seller/campaigns", body);
    return this.transformCampaignRun(data.data);
  }

  async getCampaignRun(id: string): Promise<CampaignRun> {
    const data = await this.requestProxy<{ data: any }>("GET", `seller/campaigns/${id}`);
    return this.transformCampaignRun(data.data);
  }

  async updateCampaignRun(id: string, updates: {
    status?: string;
    summary?: Record<string, unknown>;
  }): Promise<CampaignRun> {
    const data = await this.requestProxy<{ data: any }>("PATCH", `seller/campaigns/${id}`, updates);
    return this.transformCampaignRun(data.data);
  }

  private transformPromotionRule(raw: any): PromotionRule {
    return {
      id: raw.id,
      userId: raw.user_id,
      productId: raw.product_id,
      ruleName: raw.rule_name,
      ruleType: raw.rule_type,
      scheduleCron: raw.schedule_cron ?? undefined,
      delayHours: raw.delay_hours ?? undefined,
      template: raw.template ?? undefined,
      channels: raw.channels ?? [],
      maxRuns: raw.max_runs ?? undefined,
      isActive: raw.is_active,
      metadata: raw.metadata ?? {},
      createdAt: raw.created_at,
      updatedAt: raw.updated_at,
    };
  }

  private transformCampaignRun(raw: any): CampaignRun {
    return {
      id: raw.id,
      userId: raw.user_id,
      promotionRuleId: raw.promotion_rule_id ?? undefined,
      productId: raw.product_id ?? undefined,
      publishingJobId: raw.publishing_job_id ?? undefined,
      runType: raw.run_type,
      status: raw.status,
      startedAt: raw.started_at,
      completedAt: raw.completed_at ?? undefined,
      productName: raw.product_name ?? undefined,
      promotionRuleName: raw.promotion_rule_name ?? undefined,
      summary: raw.summary ?? {},
      createdAt: raw.created_at,
    };
  }

  // -----------------------------
  // Seller: Browse Marketplace
  // -----------------------------

  async browseMarketplaceProducts(params?: {
    category?: string;
    search?: string;
    page?: number;
    limit?: number;
  }): Promise<{ data: MarketplaceProduct[]; pagination?: any }> {
    const query: Record<string, string> = {};
    if (params?.category) query.category = params.category;
    if (params?.search) query.search = params.search;
    if (params?.page) query.page = String(params.page);
    if (params?.limit) query.limit = String(params.limit);
    const qs = new URLSearchParams(query).toString();
    const path = qs ? `seller/marketplace/browse?${qs}` : "seller/marketplace/browse";
    const data = await this.requestProxy<{ data: any[]; pagination?: any }>("GET", path);
    return {
      data: data.data.map((r) => ({
        id: r.id,
        name: r.name,
        summary: r.summary ?? undefined,
        price: r.price != null ? parseFloat(r.price) : undefined,
        pricingModel: r.pricing_model ?? undefined,
        currency: r.currency ?? "USD",
        tags: r.tags ?? [],
        createdAt: r.created_at,
        sellerName: r.seller_name ?? undefined,
        sellerLogo: r.seller_logo ?? undefined,
        categorySlug: r.category_slug ?? undefined,
        categoryName: r.category_name ?? undefined,
        thumbnailUrl: r.thumbnail_url ?? undefined,
      })),
      pagination: data.pagination,
    };
  }

  // ─── Seller: Wallet ──────────────────────────────────────────────

  async getWalletSettings(): Promise<WalletSettings | null> {
    try {
      const data = await this.requestProxy<{ data: any }>("GET", "seller/wallet/settings");
      if (!data.data) return null;
      return this.transformWalletSettings(data.data);
    } catch (err: any) {
      if (err.statusCode === 404) return null;
      throw err;
    }
  }

  async updateWalletSettings(data: Partial<{
    dailyLimit: string;
    requireApproval: string;
    autoApproveMax: string;
    allowedChains: string;
  }>): Promise<WalletSettings> {
    const res = await this.requestProxy<{ data: any }>("PUT", "seller/wallet/settings", data);
    return this.transformWalletSettings(res.data);
  }

  async connectWallet(spongeApiKey: string): Promise<WalletSettings> {
    const res = await this.requestProxy<{ data: any }>("POST", "seller/wallet/connect", { spongeApiKey });
    return this.transformWalletSettings(res.data);
  }

  async disconnectWallet(): Promise<WalletSettings> {
    const res = await this.requestProxy<{ data: any }>("POST", "seller/wallet/disconnect");
    return this.transformWalletSettings(res.data);
  }

  async getWalletBalances(options?: { chain?: string; refresh?: boolean }): Promise<any> {
    const params: string[] = [];
    if (options?.chain) params.push(`chain=${encodeURIComponent(options.chain)}`);
    if (options?.refresh) params.push("refresh=true");
    const qs = params.length ? `?${params.join("&")}` : "";
    const data = await this.requestProxy<{ data: any }>("GET", `seller/wallet/balances${qs}`);
    return data.data;
  }

  async requestWalletTransfer(data: { to: string; amount: string; chain?: string; currency?: string }): Promise<WalletPendingAction> {
    const res = await this.requestProxy<{ data: any }>("POST", "seller/wallet/transfers", data);
    return this.transformWalletAction(res.data);
  }

  async requestWalletSwap(data: { from: string; to: string; amount: string; chain?: string }): Promise<WalletPendingAction> {
    const res = await this.requestProxy<{ data: any }>("POST", "seller/wallet/swaps", data);
    return this.transformWalletAction(res.data);
  }

  async listWalletActions(options?: { status?: string; actionType?: string; limit?: number; offset?: number }): Promise<WalletPendingAction[]> {
    const params: string[] = [];
    if (options?.status) params.push(`status=${encodeURIComponent(options.status)}`);
    if (options?.actionType) params.push(`actionType=${encodeURIComponent(options.actionType)}`);
    if (options?.limit) params.push(`limit=${options.limit}`);
    if (options?.offset) params.push(`offset=${options.offset}`);
    const qs = params.length ? `?${params.join("&")}` : "";
    const data = await this.requestProxy<{ data: any[] }>("GET", `seller/wallet/actions${qs}`);
    return data.data.map((r) => this.transformWalletAction(r));
  }

  async approveWalletAction(actionId: string): Promise<WalletPendingAction> {
    const res = await this.requestProxy<{ data: any }>("POST", `seller/wallet/actions/${actionId}/approve`);
    return this.transformWalletAction(res.data);
  }

  async rejectWalletAction(actionId: string, reason?: string): Promise<WalletPendingAction> {
    const res = await this.requestProxy<{ data: any }>("POST", `seller/wallet/actions/${actionId}/reject`, { reason });
    return this.transformWalletAction(res.data);
  }

  async createWalletPaymentLink(data: { amount: string; description?: string; productId?: string }): Promise<any> {
    const res = await this.requestProxy<{ data: any }>("POST", "seller/wallet/payment-links", data);
    return res.data;
  }

  async getWalletTransactions(options?: { chain?: string; limit?: number; offset?: number }): Promise<any> {
    const params: string[] = [];
    if (options?.chain) params.push(`chain=${encodeURIComponent(options.chain)}`);
    if (options?.limit) params.push(`limit=${options.limit}`);
    if (options?.offset) params.push(`offset=${options.offset}`);
    const qs = params.length ? `?${params.join("&")}` : "";
    const data = await this.requestProxy<{ data: any }>("GET", `seller/wallet/transactions${qs}`);
    return data.data;
  }

  async getWalletAuditLogs(options?: { eventType?: string; limit?: number; offset?: number }): Promise<WalletAuditLog[]> {
    const params: string[] = [];
    if (options?.eventType) params.push(`eventType=${encodeURIComponent(options.eventType)}`);
    if (options?.limit) params.push(`limit=${options.limit}`);
    if (options?.offset) params.push(`offset=${options.offset}`);
    const qs = params.length ? `?${params.join("&")}` : "";
    const data = await this.requestProxy<{ data: any[] }>("GET", `seller/wallet/audit-logs${qs}`);
    return data.data.map((r) => this.transformAuditLog(r));
  }

  private transformWalletSettings(raw: any): WalletSettings {
    return {
      id: raw.id,
      userId: raw.user_id,
      sellerProfileId: raw.seller_profile_id,
      spongeWalletId: raw.sponge_wallet_id ?? undefined,
      isConnected: raw.is_connected,
      dailyLimit: parseFloat(raw.daily_limit) || 1000,
      requireApproval: raw.require_approval,
      autoApproveMax: parseFloat(raw.auto_approve_max) || 10,
      allowedChains: raw.allowed_chains ?? ["base", "solana"],
      metadata: raw.metadata ?? {},
      createdAt: raw.created_at,
      updatedAt: raw.updated_at,
    };
  }

  private transformWalletAction(raw: any): WalletPendingAction {
    return {
      id: raw.id,
      userId: raw.user_id,
      actionType: raw.action_type,
      amount: raw.amount != null ? parseFloat(raw.amount) : undefined,
      currency: raw.currency ?? undefined,
      chain: raw.chain ?? undefined,
      destination: raw.destination ?? undefined,
      params: raw.params ?? {},
      status: raw.status,
      requestedBy: raw.requested_by,
      approvedBy: raw.approved_by ?? undefined,
      rejectionReason: raw.rejection_reason ?? undefined,
      executedAt: raw.executed_at ?? undefined,
      result: raw.result ?? undefined,
      error: raw.error ?? undefined,
      expiresAt: raw.expires_at ?? undefined,
      createdAt: raw.created_at,
      updatedAt: raw.updated_at,
    };
  }

  private transformAuditLog(raw: any): WalletAuditLog {
    return {
      id: raw.id,
      userId: raw.user_id,
      eventType: raw.event_type,
      actionId: raw.action_id ?? undefined,
      orderId: raw.order_id ?? undefined,
      amount: raw.amount != null ? parseFloat(raw.amount) : undefined,
      currency: raw.currency ?? undefined,
      chain: raw.chain ?? undefined,
      status: raw.status ?? undefined,
      actor: raw.actor,
      details: raw.details ?? {},
      createdAt: raw.created_at,
    };
  }
}

export interface SavedChannel {
  id: string;
  userId: string;
  agentId: string | null;
  channelType: string;
  channelName: string | null;
  /** Which credential keys are present (values are NEVER returned). */
  credentialKeys: string[];
  metadata: Record<string, unknown>;
  isActive: boolean;
  connectedAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PlatformLink {
  id: string;
  userId: string;
  platform: string;
  platformUserId: string;
  platformMeta: Record<string, unknown>;
  isActive: boolean;
  linkedAt: string;
  createdAt: string;
  updatedAt: string;
}

export const api = new ApiClient();
export { ApiError };
