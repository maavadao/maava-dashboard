// ─── Slack integration types ───

/** Raw Slack OAuth v2 token exchange response */
export interface SlackOAuthV2Response {
  ok: boolean;
  error?: string;
  access_token: string;
  token_type: 'bot';
  scope: string;
  bot_user_id: string;
  app_id: string;
  team: { id: string; name: string };
  enterprise?: { id: string; name: string } | null;
  authed_user: {
    id: string;
    scope?: string;
    access_token?: string;
    token_type?: string;
  };
  incoming_webhook?: {
    channel: string;
    channel_id: string;
    configuration_url: string;
    url: string;
  };
}

/** Persisted Slack workspace installation */
export interface SlackConnection {
  id: string;
  maavadaoUserId: string;
  slackTeamId: string;
  slackTeamName: string | null;
  slackBotToken: string;
  slackBotUserId: string | null;
  slackAuthedUserId: string | null;
  slackScope: string | null;
  slackEnterpriseId: string | null;
  slackInstalledByUserId: string | null;
  slackAppId: string | null;
  isActive: boolean;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

/** Public-safe status returned to the dashboard */
export interface SlackConnectionStatus {
  connected: boolean;
  teamId: string | null;
  teamName: string | null;
  botUserId: string | null;
  installedAt: string | null;
  mode: 'events_api' | 'socket_mode';
  capabilities: {
    dm: boolean;
    mentions: boolean;
    channels: boolean;
    threads: boolean;
  };
}

// ─── Slack Event API types ───

export interface SlackUrlVerificationEvent {
  type: 'url_verification';
  token: string;
  challenge: string;
}

export interface SlackEventCallback {
  type: 'event_callback';
  token: string;
  team_id: string;
  enterprise_id?: string;
  api_app_id: string;
  event_id: string;
  event_time: number;
  event: SlackEvent;
}

export type SlackEventPayload = SlackUrlVerificationEvent | SlackEventCallback;

export interface SlackEvent {
  type: string;
  subtype?: string;
  user?: string;
  bot_id?: string;
  bot_profile?: { id: string; name: string };
  text?: string;
  channel?: string;
  channel_type?: string; // 'im' | 'channel' | 'group' | 'mpim'
  ts?: string;
  thread_ts?: string;
  event_ts?: string;
  team?: string;
  files?: SlackFile[];
}

export interface SlackFile {
  id: string;
  name: string;
  mimetype: string;
  url_private: string;
  size: number;
}

/** chat.postMessage request payload */
export interface SlackPostMessagePayload {
  channel: string;
  text: string;
  thread_ts?: string;
  mrkdwn?: boolean;
  unfurl_links?: boolean;
  unfurl_media?: boolean;
  metadata?: Record<string, unknown>;
}

/** Generic Slack API response envelope */
export interface SlackApiResponse {
  ok: boolean;
  error?: string;
  ts?: string;
  channel?: string;
  message?: Record<string, unknown>;
}

/** OAuth state payload encoded as JWT */
export interface SlackOAuthState {
  userId: string;
  nonce: string;
  iat?: number;
}

/** Internal routing context built from an inbound Slack event */
export interface SlackRoutingContext {
  teamId: string;
  enterpriseId: string | null;
  slackUserId: string;
  channelId: string;
  channelType: string;
  threadTs: string | null;
  messageTs: string;
  text: string;
  files: SlackFile[];
  connection: SlackConnection;
  sessionKey: string;
}
