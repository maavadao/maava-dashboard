// ─── Barrsa Slack channel configuration model ───
// Platform-managed config; no user-managed bot credentials or pairing flows.

export type BarrsaSlackChannelConfig = {
  enabled: boolean;
  mode: 'events_api' | 'socket_mode';

  // tokens (platform-managed, never exposed to end users)
  botToken?: string;
  appToken?: string;
  signingSecret?: string;

  // DM / channel toggles
  dm?: {
    enabled: boolean;
    groupEnabled?: boolean;
    groupChannels?: string[];
  };

  channels?: Record<
    string,
    {
      allow?: boolean;
      requireMention?: boolean;
      allowBots?: boolean;
      skills?: string[];
      systemPrompt?: string;
    }
  >;

  historyLimit?: number;
  allowBots?: boolean;

  // reaction behavior
  reactionNotifications?: 'off' | 'own' | 'all' | 'allowlist';
  reactionAllowlist?: string[];

  // threading
  replyToMode?: 'off' | 'first' | 'all';
  thread?: {
    historyScope?: 'thread' | 'channel';
    inheritParent?: boolean;
    initialHistoryLimit?: number;
  };

  // capabilities / actions
  actions?: {
    reactions?: boolean;
    messages?: boolean;
    pins?: boolean;
    memberInfo?: boolean;
    emojiList?: boolean;
  };

  // slash commands
  slashCommand?: {
    enabled?: boolean;
    name?: string;
    sessionPrefix?: string;
    ephemeral?: boolean;
  };

  // UX / reply formatting
  typingReaction?: string;
  ackReaction?: {
    emoji?: string;
    direct?: boolean;
    group?: 'always' | 'mentions' | 'never';
  };

  textChunkLimit?: number;
  chunkMode?: 'length' | 'newline';
  streaming?: 'off' | 'partial' | 'block' | 'progress';
  nativeStreaming?: boolean;
  mediaMaxMb?: number;

  capabilities?: {
    interactiveReplies?: boolean;
  };

  commands?: {
    native?: boolean;
  };
};

export const DEFAULT_BARRSA_SLACK_CONFIG: BarrsaSlackChannelConfig = {
  enabled: true,
  mode: 'events_api',
  dm: {
    enabled: true,
    groupEnabled: false,
    groupChannels: [],
  },
  channels: {},
  historyLimit: 50,
  allowBots: false,
  reactionNotifications: 'own',
  reactionAllowlist: [],
  replyToMode: 'off',
  thread: {
    historyScope: 'thread',
    inheritParent: false,
    initialHistoryLimit: 20,
  },
  actions: {
    reactions: true,
    messages: true,
    pins: true,
    memberInfo: true,
    emojiList: true,
  },
  slashCommand: {
    enabled: false,
    name: 'barrsa',
    sessionPrefix: 'slack:slash',
    ephemeral: true,
  },
  typingReaction: 'hourglass_flowing_sand',
  ackReaction: {
    emoji: '',
    direct: true,
    group: 'mentions',
  },
  textChunkLimit: 4000,
  chunkMode: 'length',
  streaming: 'partial',
  nativeStreaming: true,
  mediaMaxMb: 20,
  capabilities: {
    interactiveReplies: true,
  },
  commands: {
    native: false,
  },
};
