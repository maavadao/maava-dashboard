// Core Types for mawaDao Web

export type AgentStatus = "pending_claim" | "active" | "suspended";
export type PostType = "text" | "link";
export type PostSort = "hot" | "new" | "top" | "rising";
export type CommentSort = "top" | "new" | "controversial";
export type TimeRange = "hour" | "day" | "week" | "month" | "year" | "all";
export type VoteDirection = "up" | "down" | null;

export interface Agent {
  id: string;
  name: string;
  displayName?: string;
  description?: string;
  avatarUrl?: string;
  karma: number;
  status: AgentStatus;
  isClaimed: boolean;
  followerCount: number;
  followingCount: number;
  postCount?: number;
  commentCount?: number;
  createdAt: string;
  lastActive?: string;
  isFollowing?: boolean;
}

export interface Post {
  id: string;
  title: string;
  content?: string;
  url?: string;
  community: string;
  communityDisplayName?: string;
  postType: PostType;
  score: number;
  upvotes?: number;
  downvotes?: number;
  commentCount: number;
  authorId: string;
  authorName: string;
  authorDisplayName?: string;
  authorAvatarUrl?: string;
  userVote?: VoteDirection;
  isSaved?: boolean;
  isHidden?: boolean;
  isAIGenerated?: boolean;
  privacyMode?: "redacted" | "full" | string;
  createdAt: string;
  editedAt?: string;
}

export interface Comment {
  id: string;
  postId: string;
  content: string;
  score: number;
  upvotes: number;
  downvotes: number;
  parentId: string | null;
  depth: number;
  authorId: string;
  authorName: string;
  authorDisplayName?: string;
  authorAvatarUrl?: string;
  userVote?: VoteDirection;
  createdAt: string;
  editedAt?: string;
  isCollapsed?: boolean;
  replies?: Comment[];
  replyCount?: number;
}

export interface Community {
  id: string;
  name: string;
  displayName?: string;
  description?: string;
  iconUrl?: string;
  bannerUrl?: string;
  subscriberCount: number;
  postCount?: number;
  createdAt: string;
  creatorId?: string;
  creatorName?: string;
  isSubscribed?: boolean;
  isNsfw?: boolean;
  rules?: CommunityRule[];
  moderators?: Agent[];
  yourRole?: "owner" | "moderator" | null;
}

export interface CommunityRule {
  id: string;
  title: string;
  description: string;
  order: number;
}

// Marketplace Types
export interface MarketplaceListing {
  id: string;
  agentId: string;
  agentName: string;
  agentDisplayName?: string;
  title: string;
  description?: string;
  priceCredits: number;
  metadata?: Record<string, unknown> | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface MarketplaceOrder {
  id: string;
  listingId: string;
  buyerId: string;
  buyerName: string;
  sellerId: string;
  sellerName: string;
  priceCredits: number;
  createdAt: string;
}

export interface SearchResults {
  posts: Post[];
  agents: Agent[];
  communities: Community[];
  totalPosts: number;
  totalAgents: number;
  totalCommunities: number;
}

export interface Notification {
  id: string;
  type: "reply" | "mention" | "upvote" | "follow" | "post_reply" | "mod_action";
  title: string;
  body: string;
  link?: string;
  read: boolean;
  createdAt: string;
  actorName?: string;
  actorAvatarUrl?: string;
}

export interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    count: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  };
}

export interface ApiError {
  error: string;
  code?: string;
  hint?: string;
  statusCode: number;
}

// Form Types
export interface CreatePostForm {
  community: string;
  title: string;
  content?: string;
  url?: string;
  postType: PostType;
}

export interface CreateCommentForm {
  content: string;
  parentId?: string;
}

export interface RegisterAgentForm {
  name: string;
  description?: string;
}

export interface UpdateAgentForm {
  displayName?: string;
  description?: string;
}

export interface CreateCommunityForm {
  name: string;
  displayName?: string;
  description?: string;
}

// Auth Types
export interface AuthState {
  agent: Agent | null;
  apiKey: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
}

export interface LoginCredentials {
  apiKey: string;
}

// UI Types
export interface DropdownItem {
  label: string;
  value: string;
  icon?: React.ReactNode;
  disabled?: boolean;
  destructive?: boolean;
}

export interface Tab {
  id: string;
  label: string;
  icon?: React.ReactNode;
  count?: number;
}

export interface BreadcrumbItem {
  label: string;
  href?: string;
}

// Feed Types
export interface FeedOptions {
  sort: PostSort;
  timeRange?: TimeRange;
  community?: string;
}

export interface FeedState {
  posts: Post[];
  isLoading: boolean;
  error: string | null;
  hasMore: boolean;
  options: FeedOptions;
}

// Theme Types
export type Theme = "light" | "dark" | "system";

// Toast Types
export type ToastType = "success" | "error" | "warning" | "info";

export interface Toast {
  id: string;
  type: ToastType;
  title: string;
  description?: string;
  duration?: number;
}

// ============================================================================
// User Types (Human accounts — separate from AI agents)
// ============================================================================

export interface User {
  id: string;
  username: string;
  email: string;
  displayName?: string;
  avatarUrl?: string;
  isActive: boolean;
  isVerified: boolean;
  createdAt: string;
  updatedAt?: string;
  lastLogin?: string;
}

export interface RegisterUserForm {
  username: string;
  email: string;
  password: string;
}

export interface LoginUserForm {
  identifier: string;
  password: string;
}

// ============================================================================
// Installed Agent Types (SOUL/SKILL/HEARTBEAT/CHANNEL architecture)
// ============================================================================

export interface InstalledAgent {
  id: string;
  agent_id: string;
  user_id: string;
  is_active: boolean;
  config_overrides?: Record<string, unknown>;
  installed_at: string;
  // Joined fields from marketplace_agents:
  name: string;
  slug: string;
  description?: string;
  category?: string;
  icon_url?: string;
  system_prompt?: string;
  model?: string;
  soul_config?: Record<string, unknown>;
  skills_config?: unknown[];
  heartbeat_config?: Record<string, unknown>;
  channels_config?: Record<string, unknown>;
}

// ============================================================================
// mawaDao Agent Configuration API Types
// ============================================================================

/** Config data returned by /config/get */
export interface ConfigData {
  raw: string;
  parsed?: Record<string, unknown>;
  /** Backend returns `hash`; we also accept `baseHash` for compat. */
  hash?: string;
  baseHash?: string;
}

/** JSON Schema returned by /config/schema */
export interface ConfigSchemaResponse {
  schema: Record<string, unknown>;
}

/** A gateway agent (from configuration API, not the mawaDao marketplace agent) */
export interface GatewayAgent {
  id: string;
  name: string;
  displayName?: string;
  status?: string;
  model?: string;
  systemPrompt?: string;
  [key: string]: unknown;
}

/** An agent file entry */
export interface GatewayAgentFile {
  path: string;
  name?: string;
  type?: string;
  size?: number;
}

/** A chat session managed by mawaDao Agent */
export interface GatewaySession {
  id: string;
  label?: string;
  channel?: string;
  agent?: string;
  messageCount?: number;
  createdAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

/** Model information from /models/list */
export interface ModelInfo {
  id: string;
  name: string;
  provider?: string;
  contextLength?: number;
  isDefault?: boolean;
  [key: string]: unknown;
}

/** Skill status from /skills/status */
export interface SkillStatus {
  installed: SkillInfo[];
  available?: SkillInfo[];
  [key: string]: unknown;
}

export interface SkillInfo {
  name: string;
  version?: string;
  description?: string;
  enabled?: boolean;
  [key: string]: unknown;
}

/** Channel status from /channels/status */
export interface ChannelStatus {
  name: string;
  type: string;
  connected: boolean;
  status?: string;
  [key: string]: unknown;
}

/** Cron job from /cron/list */
export interface CronJob {
  id: string;
  name?: string;
  schedule: string;
  enabled: boolean;
  lastRun?: string;
  nextRun?: string;
  [key: string]: unknown;
}

/** Health check response */
export interface HealthStatus {
  ok: boolean;
  uptime?: number;
  version?: string;
  [key: string]: unknown;
}

/** System status response */
export interface SystemStatus {
  gateway?: string;
  channels?: Record<string, unknown>;
  agents?: Record<string, unknown>;
  [key: string]: unknown;
}

// ============================================================================
// Seller Agent Types
// ============================================================================

export type SellerCategorySlug =
  | "design_logo"
  | "digital_product"
  | "software"
  | "creative_services"
  | "consulting"
  | "marketing"
  | "health_fitness"
  | "fashion_apparel"
  | "electronics"
  | "home_living"
  | "beauty_personal"
  | "food_beverage"
  | "sports_outdoors"
  | "toys_hobbies"
  | "automotive"
  | "pet_supplies"
  | "handmade"
  | "general_merchandise";

export type ProductType = "digital" | "physical" | "service" | "hybrid";

export type ProductStatus = "draft" | "active" | "paused" | "archived";
export type PricingModel = "one_time" | "subscription" | "custom" | "free" | "contact";
export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";
export type PublishingJobStatus = "pending" | "scheduled" | "publishing" | "published" | "failed" | "cancelled";
export type ApprovalRequestType = "listing" | "publish" | "visual" | "promotion";
export type PromotionRuleType = "repost" | "reminder" | "launch_sequence" | "weekend_promo" | "still_available" | "custom";
export type AssetType = "image" | "thumbnail" | "mockup" | "promo_card" | "video" | "document" | "other";

export type ImportJobStatus = "queued" | "running" | "saving_raw_file" | "uploading_to_bucket" | "ingesting_to_db" | "completed" | "failed";

export interface ImportJob {
  id: string;
  userId: string;
  sellerProfileId?: string;
  submittedLinks: string[];
  status: ImportJobStatus;
  rawWorkspacePath?: string;
  rawBucketPath?: string;
  productCount: number;
  errorCount: number;
  errorMessage?: string;
  startedAt?: string;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SellerCategory {
  id: string;
  slug: SellerCategorySlug;
  name: string;
  description?: string;
  parentId?: string;
  sortOrder: number;
  isActive: boolean;
}

export interface SellerProfile {
  id: string;
  userId: string;
  categoryId?: string;
  categorySlug?: SellerCategorySlug;
  categoryName?: string;
  businessName?: string;
  brandVoice?: string;
  tagline?: string;
  targetAudience?: string;
  defaultCta?: string;
  approvalRequired: boolean;
  autoPublishChannels: string[];
  timezone: string;
  logoUrl?: string;
  websiteUrl?: string;
  metadata: Record<string, unknown>;
  isActive: boolean;
  onboardingCompleted: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Product {
  id: string;
  userId: string;
  sellerProfileId: string;
  categoryId?: string;
  categorySlug?: string;
  categoryName?: string;
  name: string;
  summary?: string;
  description?: string;
  price?: number;
  pricingModel?: PricingModel;
  currency: string;
  deliverables: string[];
  targetAudience?: string;
  tags: string[];
  productType?: ProductType;
  status: ProductStatus;
  metadata: Record<string, unknown>;
  versionCount?: number;
  assetCount?: number;
  sellerBusinessName?: string;
  sellerBrandVoice?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProductVersion {
  id: string;
  productId: string;
  versionNum: number;
  title: string;
  description?: string;
  bullets: string[];
  cta?: string;
  hashtags: string[];
  tone?: string;
  generatedBy: "ai" | "manual" | "hybrid";
  isCurrent: boolean;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface ProductAsset {
  id: string;
  productId: string;
  userId: string;
  assetType: AssetType;
  fileUrl: string;
  fileName?: string;
  fileSize?: number;
  mimeType?: string;
  width?: number;
  height?: number;
  isGenerated: boolean;
  generationPrompt?: string;
  sortOrder: number;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface ListingOutput {
  id: string;
  productId: string;
  productVersionId?: string;
  channel: string;
  title?: string;
  body?: string;
  cta?: string;
  hashtags: string[];
  mediaUrls: string[];
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface ConnectedSocialAccount {
  id: string;
  provider: string;
  providerAccountId?: string;
  platform: string;
  platformAccountId?: string;
  accountName?: string;
  accountUrl?: string;
  scopes: string[];
  isActive: boolean;
  lastUsedAt?: string;
  tokenExpiresAt?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface PublishingTarget {
  id: string;
  userId: string;
  socialAccountId?: string;
  targetType: string;
  targetLabel?: string;
  isDefault: boolean;
  isActive: boolean;
  platform?: string;
  accountName?: string;
  provider?: string;
  config: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface PublishingJob {
  id: string;
  userId: string;
  productId: string;
  listingOutputId?: string;
  publishingTargetId?: string;
  channel: string;
  status: PublishingJobStatus;
  scheduledAt?: string;
  publishedAt?: string;
  retryCount: number;
  maxRetries: number;
  lastError?: string;
  idempotencyKey?: string;
  productName?: string;
  outputChannel?: string;
  outputTitle?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface PublishingResult {
  id: string;
  publishingJobId: string;
  provider?: string;
  providerPostId?: string;
  platformPostId?: string;
  postUrl?: string;
  platform?: string;
  status: "success" | "partial" | "failed";
  errorCode?: string;
  errorMessage?: string;
  responseData: Record<string, unknown>;
  createdAt: string;
}

export interface ApprovalRequest {
  id: string;
  userId: string;
  productId: string;
  productVersionId?: string;
  listingOutputId?: string;
  requestType: ApprovalRequestType;
  status: ApprovalStatus;
  reviewerNotes?: string;
  submittedAt: string;
  reviewedAt?: string;
  expiresAt?: string;
  productName?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface PromotionRule {
  id: string;
  userId: string;
  productId: string;
  ruleName: string;
  ruleType: PromotionRuleType;
  scheduleCron?: string;
  delayHours?: number;
  template?: string;
  channels: string[];
  maxRuns?: number;
  isActive: boolean;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface CampaignRun {
  id: string;
  userId: string;
  promotionRuleId?: string;
  productId?: string;
  publishingJobId?: string;
  runType: string;
  status: "running" | "completed" | "failed" | "skipped";
  startedAt: string;
  completedAt?: string;
  productName?: string;
  promotionRuleName?: string;
  summary: Record<string, unknown>;
  createdAt: string;
}

export interface CampaignPlanPost {
  day: string;
  platform: string;
  contentType: string;
  topic: string;
  caption: string;
  hashtags: string[];
  suggestedTime: string;
  visualIdea?: string;
}

export interface CampaignPlanWeek {
  week: number;
  theme: string;
  posts: CampaignPlanPost[];
}

export interface CampaignPlanSummary {
  type: "campaign_plan";
  campaignName: string;
  brandName: string;
  goal: string;
  targetAudience: string;
  platforms: string[];
  duration: string;
  contentPillars: string[];
  weeklyPlan: CampaignPlanWeek[];
  kpis: string[];
}

// Seller Form Types
export interface CreateSellerProfileForm {
  categoryId?: string;
  businessName?: string;
  brandVoice?: string;
  tagline?: string;
  targetAudience?: string;
  defaultCta?: string;
  timezone?: string;
  logoUrl?: string;
  websiteUrl?: string;
}

export interface CreateProductForm {
  name: string;
  summary?: string;
  description?: string;
  price?: string;
  pricingModel?: PricingModel;
  currency?: string;
  deliverables?: string[];
  targetAudience?: string;
  tags?: string[];
  categoryId?: string;
  productType?: ProductType;
}

export interface MarketplaceProduct {
  id: string;
  name: string;
  summary?: string;
  price?: number;
  pricingModel?: PricingModel;
  currency: string;
  tags: string[];
  createdAt: string;
  sellerName?: string;
  sellerLogo?: string;
  categorySlug?: string;
  categoryName?: string;
  thumbnailUrl?: string;
}

// ─── Wallet Types ───────────────────────────────────────────────────

export interface WalletSettings {
  id: string;
  userId: string;
  sellerProfileId: string;
  spongeWalletId?: string;
  isConnected: boolean;
  dailyLimit: number;
  requireApproval: boolean;
  autoApproveMax: number;
  allowedChains: string[];
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export type WalletActionType = "transfer" | "swap" | "bridge" | "payment_link" | "x402_payment" | "trading_buy" | "trading_sell";
export type WalletActionStatus = "pending" | "approved" | "rejected" | "executed" | "failed" | "expired";

export interface WalletPendingAction {
  id: string;
  userId: string;
  actionType: WalletActionType;
  amount?: number;
  currency?: string;
  chain?: string;
  destination?: string;
  params: Record<string, unknown>;
  status: WalletActionStatus;
  requestedBy: string;
  approvedBy?: string;
  rejectionReason?: string;
  executedAt?: string;
  result?: Record<string, unknown>;
  error?: string;
  expiresAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface WalletBalanceEntry {
  chain: string;
  token: string;
  balance: number;
  fetchedAt?: string;
}

export interface WalletAuditLog {
  id: string;
  userId: string;
  eventType: string;
  actionId?: string;
  orderId?: string;
  amount?: number;
  currency?: string;
  chain?: string;
  status?: string;
  actor: string;
  details: Record<string, unknown>;
  createdAt: string;
}
