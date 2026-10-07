// Shared types + constants for the Inbox feature.

export type InboxProvider = 'gmail' | 'outlook';

export type AiPolicyMode = 'off' | 'approval_required' | 'autonomous';

export interface InboxAiPolicy {
  mode: AiPolicyMode;
  can_send: boolean;
  can_reply: boolean;
  can_forward: boolean;
  can_delete: boolean;
  can_archive: boolean;
  can_label: boolean;
  approval_required_for_send: boolean;
  max_actions_per_hour: number;
  excluded_addresses: string[];      // do not act on threads with these
  excluded_labels: string[];          // do not act on threads with these labels
  allowed_label_targets: string[];    // labels we may add (allowlist)
  custom_instructions: string;        // free-text given to the model
}

export const DEFAULT_INBOX_POLICY: InboxAiPolicy = {
  mode: 'approval_required',
  can_send: false,
  can_reply: false,
  can_forward: false,
  can_delete: false,
  can_archive: false,
  can_label: false,
  approval_required_for_send: true,
  max_actions_per_hour: 20,
  excluded_addresses: [],
  excluded_labels: [],
  allowed_label_targets: [],
  custom_instructions: '',
};

export interface InboxAccountSummary {
  id: string;
  provider: InboxProvider;
  account_email: string;
  display_name: string | null;
  scopes: string[];
  status: 'active' | 'revoked' | 'error';
  last_error: string | null;
  last_synced_at: string | null;
  created_at: string;
  policy: InboxAiPolicy;
}

export interface OAuthTokenBundle {
  access_token: string;
  refresh_token?: string;
  expires_at: number;            // epoch ms
  token_type?: string;
  scope?: string;
  raw?: Record<string, unknown>;
}
