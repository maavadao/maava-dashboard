// Inbox DB layer — typed CRUD for accounts + policies.

import pool from '@/lib/db';
import { encryptTokenBundle, decryptTokenBundle } from './crypto';
import {
  DEFAULT_INBOX_POLICY,
  type InboxAccountSummary,
  type InboxAiPolicy,
  type InboxProvider,
  type OAuthTokenBundle,
} from './types';

interface InboxAccountRow {
  id: string;
  user_id: string;
  provider: InboxProvider;
  account_email: string;
  display_name: string | null;
  scopes: string[];
  token_ciphertext: string;
  status: 'active' | 'revoked' | 'error';
  last_error: string | null;
  last_synced_at: Date | null;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

interface InboxPolicyRow {
  account_id: string;
  mode: InboxAiPolicy['mode'];
  can_send: boolean;
  can_reply: boolean;
  can_forward: boolean;
  can_delete: boolean;
  can_archive: boolean;
  can_label: boolean;
  approval_required_for_send: boolean;
  max_actions_per_hour: number;
  excluded_addresses: string[];
  excluded_labels: string[];
  allowed_label_targets: string[];
  custom_instructions: string;
  updated_at: Date;
}

function policyFromRow(row: InboxPolicyRow | undefined): InboxAiPolicy {
  if (!row) return { ...DEFAULT_INBOX_POLICY };
  return {
    mode: row.mode,
    can_send: row.can_send,
    can_reply: row.can_reply,
    can_forward: row.can_forward,
    can_delete: row.can_delete,
    can_archive: row.can_archive,
    can_label: row.can_label,
    approval_required_for_send: row.approval_required_for_send,
    max_actions_per_hour: row.max_actions_per_hour,
    excluded_addresses: row.excluded_addresses ?? [],
    excluded_labels: row.excluded_labels ?? [],
    allowed_label_targets: row.allowed_label_targets ?? [],
    custom_instructions: row.custom_instructions ?? '',
  };
}

export async function listInboxAccounts(userId: string): Promise<InboxAccountSummary[]> {
  const accountsRes = await pool.query<InboxAccountRow>(
    `SELECT * FROM inbox_accounts WHERE user_id = $1 AND status <> 'revoked' ORDER BY created_at DESC`,
    [userId],
  );
  if (accountsRes.rows.length === 0) return [];

  const ids = accountsRes.rows.map((r) => r.id);
  const policiesRes = await pool.query<InboxPolicyRow>(
    `SELECT * FROM inbox_ai_policies WHERE account_id = ANY($1::uuid[])`,
    [ids],
  );
  const policyById = new Map(policiesRes.rows.map((r) => [r.account_id, r]));

  return accountsRes.rows.map((r) => ({
    id: r.id,
    provider: r.provider,
    account_email: r.account_email,
    display_name: r.display_name,
    scopes: r.scopes ?? [],
    status: r.status,
    last_error: r.last_error,
    last_synced_at: r.last_synced_at ? r.last_synced_at.toISOString() : null,
    created_at: r.created_at.toISOString(),
    policy: policyFromRow(policyById.get(r.id)),
  }));
}

export async function getInboxAccount(
  userId: string,
  accountId: string,
): Promise<InboxAccountSummary | null> {
  const res = await pool.query<InboxAccountRow>(
    `SELECT * FROM inbox_accounts WHERE id = $1 AND user_id = $2 LIMIT 1`,
    [accountId, userId],
  );
  if (res.rows.length === 0) return null;
  const row = res.rows[0];
  const polRes = await pool.query<InboxPolicyRow>(
    `SELECT * FROM inbox_ai_policies WHERE account_id = $1 LIMIT 1`,
    [accountId],
  );
  return {
    id: row.id,
    provider: row.provider,
    account_email: row.account_email,
    display_name: row.display_name,
    scopes: row.scopes ?? [],
    status: row.status,
    last_error: row.last_error,
    last_synced_at: row.last_synced_at ? row.last_synced_at.toISOString() : null,
    created_at: row.created_at.toISOString(),
    policy: policyFromRow(polRes.rows[0]),
  };
}

export interface UpsertInboxAccountInput {
  userId: string;
  provider: InboxProvider;
  accountEmail: string;
  displayName?: string | null;
  scopes: string[];
  tokens: OAuthTokenBundle;
  metadata?: Record<string, unknown>;
}

export async function upsertInboxAccount(input: UpsertInboxAccountInput): Promise<string> {
  const ciphertext = encryptTokenBundle(input.tokens);
  const res = await pool.query<{ id: string }>(
    `INSERT INTO inbox_accounts
      (user_id, provider, account_email, display_name, scopes, token_ciphertext, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (user_id, provider, account_email)
     DO UPDATE SET
       display_name = EXCLUDED.display_name,
       scopes = EXCLUDED.scopes,
       token_ciphertext = EXCLUDED.token_ciphertext,
       metadata = inbox_accounts.metadata || EXCLUDED.metadata,
       status = 'active',
       last_error = NULL,
       updated_at = NOW()
     RETURNING id`,
    [
      input.userId,
      input.provider,
      input.accountEmail,
      input.displayName ?? null,
      input.scopes,
      ciphertext,
      JSON.stringify(input.metadata ?? {}),
    ],
  );
  const id = res.rows[0].id;
  // Ensure a policy row exists with safe defaults
  await pool.query(
    `INSERT INTO inbox_ai_policies (account_id) VALUES ($1) ON CONFLICT (account_id) DO NOTHING`,
    [id],
  );
  return id;
}

export async function disconnectInboxAccount(userId: string, accountId: string): Promise<boolean> {
  const res = await pool.query(
    `UPDATE inbox_accounts SET status = 'revoked', updated_at = NOW()
     WHERE id = $1 AND user_id = $2 AND status <> 'revoked'`,
    [accountId, userId],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function getDecryptedTokens(
  userId: string,
  accountId: string,
): Promise<OAuthTokenBundle | null> {
  const res = await pool.query<{ token_ciphertext: string }>(
    `SELECT token_ciphertext FROM inbox_accounts WHERE id = $1 AND user_id = $2 AND status = 'active' LIMIT 1`,
    [accountId, userId],
  );
  if (res.rows.length === 0) return null;
  return decryptTokenBundle<OAuthTokenBundle>(res.rows[0].token_ciphertext);
}

export async function updateAccountTokens(
  userId: string,
  accountId: string,
  tokens: OAuthTokenBundle,
): Promise<void> {
  const ciphertext = encryptTokenBundle(tokens);
  await pool.query(
    `UPDATE inbox_accounts
     SET token_ciphertext = $1, status = 'active', last_error = NULL, updated_at = NOW()
     WHERE id = $2 AND user_id = $3`,
    [ciphertext, accountId, userId],
  );
}

export async function markAccountError(
  userId: string,
  accountId: string,
  message: string,
): Promise<void> {
  await pool.query(
    `UPDATE inbox_accounts SET status = 'error', last_error = $1, updated_at = NOW()
     WHERE id = $2 AND user_id = $3`,
    [message.slice(0, 500), accountId, userId],
  );
}

export async function touchAccountSync(userId: string, accountId: string): Promise<void> {
  await pool.query(
    `UPDATE inbox_accounts SET last_synced_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND user_id = $2`,
    [accountId, userId],
  );
}

export async function updatePolicy(
  userId: string,
  accountId: string,
  patch: Partial<InboxAiPolicy>,
): Promise<InboxAiPolicy | null> {
  // Verify ownership
  const own = await pool.query<{ id: string }>(
    `SELECT id FROM inbox_accounts WHERE id = $1 AND user_id = $2 LIMIT 1`,
    [accountId, userId],
  );
  if (own.rows.length === 0) return null;

  // Ensure row exists
  await pool.query(
    `INSERT INTO inbox_ai_policies (account_id) VALUES ($1) ON CONFLICT (account_id) DO NOTHING`,
    [accountId],
  );

  const fields: string[] = [];
  const values: unknown[] = [];
  let i = 1;
  const allowed: (keyof InboxAiPolicy)[] = [
    'mode',
    'can_send',
    'can_reply',
    'can_forward',
    'can_delete',
    'can_archive',
    'can_label',
    'approval_required_for_send',
    'max_actions_per_hour',
    'excluded_addresses',
    'excluded_labels',
    'allowed_label_targets',
    'custom_instructions',
  ];
  for (const k of allowed) {
    if (patch[k] !== undefined) {
      fields.push(`${k} = $${i++}`);
      values.push(patch[k]);
    }
  }
  if (fields.length > 0) {
    values.push(accountId);
    await pool.query(
      `UPDATE inbox_ai_policies SET ${fields.join(', ')}, updated_at = NOW() WHERE account_id = $${i}`,
      values,
    );
  }

  const polRes = await pool.query<InboxPolicyRow>(
    `SELECT * FROM inbox_ai_policies WHERE account_id = $1 LIMIT 1`,
    [accountId],
  );
  return policyFromRow(polRes.rows[0]);
}

export async function recordOAuthState(
  stateToken: string,
  userId: string,
  provider: InboxProvider,
): Promise<void> {
  await pool.query(
    `INSERT INTO inbox_oauth_states (state_token, user_id, provider) VALUES ($1, $2, $3)
     ON CONFLICT (state_token) DO NOTHING`,
    [stateToken, userId, provider],
  );
}

export async function consumeOAuthState(stateToken: string): Promise<boolean> {
  const res = await pool.query(
    `UPDATE inbox_oauth_states SET consumed_at = NOW()
     WHERE state_token = $1 AND consumed_at IS NULL`,
    [stateToken],
  );
  return (res.rowCount ?? 0) > 0;
}

// ─── Drafts ────────────────────────────────────────────────────────────────

export interface InboxDraftRow {
  id: string;
  user_id: string;
  account_id: string;
  source_message_id: string;
  source_thread_id: string | null;
  to_addr: string;
  subject: string;
  body_text: string;
  model: string | null;
  status: 'pending' | 'sent' | 'rejected';
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  sent_at: string | null;
}

interface InboxDraftRowDb extends Omit<InboxDraftRow, 'created_at' | 'updated_at' | 'sent_at'> {
  created_at: Date;
  updated_at: Date;
  sent_at: Date | null;
}

function draftFromRow(r: InboxDraftRowDb): InboxDraftRow {
  return {
    ...r,
    created_at: r.created_at.toISOString(),
    updated_at: r.updated_at.toISOString(),
    sent_at: r.sent_at ? r.sent_at.toISOString() : null,
  };
}

export interface CreateDraftInput {
  userId: string;
  accountId: string;
  sourceMessageId: string;
  sourceThreadId: string | null;
  toAddr: string;
  subject: string;
  bodyText: string;
  model: string | null;
  metadata?: Record<string, unknown>;
}

export async function createDraft(input: CreateDraftInput): Promise<InboxDraftRow> {
  const res = await pool.query<InboxDraftRowDb>(
    `INSERT INTO inbox_drafts
       (user_id, account_id, source_message_id, source_thread_id, to_addr, subject, body_text, model, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [
      input.userId,
      input.accountId,
      input.sourceMessageId,
      input.sourceThreadId,
      input.toAddr,
      input.subject,
      input.bodyText,
      input.model,
      JSON.stringify(input.metadata ?? {}),
    ],
  );
  return draftFromRow(res.rows[0]);
}

export async function listDrafts(
  userId: string,
  opts: { status?: 'pending' | 'sent' | 'rejected'; accountId?: string; limit?: number } = {},
): Promise<InboxDraftRow[]> {
  const params: unknown[] = [userId];
  let where = `user_id = $1`;
  if (opts.status) {
    params.push(opts.status);
    where += ` AND status = $${params.length}`;
  }
  if (opts.accountId) {
    params.push(opts.accountId);
    where += ` AND account_id = $${params.length}`;
  }
  params.push(Math.min(opts.limit ?? 50, 200));
  const res = await pool.query<InboxDraftRowDb>(
    `SELECT * FROM inbox_drafts WHERE ${where} ORDER BY created_at DESC LIMIT $${params.length}`,
    params,
  );
  return res.rows.map(draftFromRow);
}

export async function getDraft(userId: string, draftId: string): Promise<InboxDraftRow | null> {
  const res = await pool.query<InboxDraftRowDb>(
    `SELECT * FROM inbox_drafts WHERE id = $1 AND user_id = $2 LIMIT 1`,
    [draftId, userId],
  );
  return res.rows[0] ? draftFromRow(res.rows[0]) : null;
}

export async function updateDraft(
  userId: string,
  draftId: string,
  patch: { subject?: string; bodyText?: string; toAddr?: string },
): Promise<InboxDraftRow | null> {
  const fields: string[] = [];
  const values: unknown[] = [];
  let i = 1;
  if (patch.subject !== undefined) {
    fields.push(`subject = $${i++}`);
    values.push(patch.subject);
  }
  if (patch.bodyText !== undefined) {
    fields.push(`body_text = $${i++}`);
    values.push(patch.bodyText);
  }
  if (patch.toAddr !== undefined) {
    fields.push(`to_addr = $${i++}`);
    values.push(patch.toAddr);
  }
  if (fields.length === 0) return getDraft(userId, draftId);
  values.push(draftId, userId);
  const res = await pool.query<InboxDraftRowDb>(
    `UPDATE inbox_drafts SET ${fields.join(', ')}, updated_at = NOW()
     WHERE id = $${i++} AND user_id = $${i} AND status = 'pending'
     RETURNING *`,
    values,
  );
  return res.rows[0] ? draftFromRow(res.rows[0]) : null;
}

export async function rejectDraft(userId: string, draftId: string): Promise<boolean> {
  const res = await pool.query(
    `UPDATE inbox_drafts SET status = 'rejected', updated_at = NOW()
     WHERE id = $1 AND user_id = $2 AND status = 'pending'`,
    [draftId, userId],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function markDraftSent(userId: string, draftId: string): Promise<boolean> {
  const res = await pool.query(
    `UPDATE inbox_drafts SET status = 'sent', sent_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND user_id = $2 AND status = 'pending'`,
    [draftId, userId],
  );
  return (res.rowCount ?? 0) > 0;
}
