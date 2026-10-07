// Thin Gmail REST API wrapper with automatic access-token refresh + persistence.
//
// All calls go through `withGmailAccessToken()` which:
//   1. Loads the encrypted token bundle for (userId, accountId)
//   2. Refreshes the access token if it's expired (or about to in 60s)
//   3. Persists the refreshed bundle back into the DB
//   4. Calls the supplied function with a valid access_token
//
// On a non-recoverable auth failure we mark the account as 'error' so the UI
// can prompt the user to reconnect.

import {
  getDecryptedTokens,
  updateAccountTokens,
  markAccountError,
  touchAccountSync,
} from './db';
import { refreshGmailAccessToken } from './providers';
import type { OAuthTokenBundle } from './types';

const REFRESH_LEEWAY_MS = 60_000;

export class GmailAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GmailAuthError';
  }
}

export class GmailApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'GmailApiError';
    this.status = status;
  }
}

async function ensureFreshToken(
  userId: string,
  accountId: string,
  bundle: OAuthTokenBundle,
): Promise<OAuthTokenBundle> {
  if (bundle.expires_at && bundle.expires_at - Date.now() > REFRESH_LEEWAY_MS) {
    return bundle;
  }
  if (!bundle.refresh_token) {
    throw new GmailAuthError('Access token expired and no refresh_token available — reconnect required.');
  }
  const refreshed = await refreshGmailAccessToken(bundle.refresh_token);
  await updateAccountTokens(userId, accountId, refreshed);
  return refreshed;
}

export async function withGmailAccessToken<T>(
  userId: string,
  accountId: string,
  fn: (accessToken: string) => Promise<T>,
): Promise<T> {
  const bundle = await getDecryptedTokens(userId, accountId);
  if (!bundle) throw new GmailAuthError('Inbox account not found or revoked.');
  try {
    const fresh = await ensureFreshToken(userId, accountId, bundle);
    return await fn(fresh.access_token);
  } catch (err) {
    if (err instanceof GmailAuthError) {
      await markAccountError(userId, accountId, err.message).catch(() => {});
    }
    throw err;
  }
}

async function gmailFetch<T>(accessToken: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1${path}`, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  });
  if (res.status === 401 || res.status === 403) {
    const body = await res.text().catch(() => '');
    throw new GmailAuthError(`Gmail auth failed: HTTP ${res.status} ${body.slice(0, 200)}`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new GmailApiError(`Gmail API error ${res.status}: ${body.slice(0, 200)}`, res.status);
  }
  return (await res.json()) as T;
}

// ── Types ───────────────────────────────────────────────────────────────

export interface GmailLabel {
  id: string;
  name: string;
  type: 'system' | 'user';
  messagesTotal?: number;
  messagesUnread?: number;
}

export interface GmailMessageMeta {
  id: string;
  threadId: string;
  labelIds: string[];
  snippet: string;
  internalDate: string; // epoch ms as string
  // Decoded headers for list view convenience
  from: string;
  to: string;
  subject: string;
  date: string;
  unread: boolean;
}

export interface GmailMessageBody {
  text: string | null;
  html: string | null;
}

export interface GmailMessageFull extends GmailMessageMeta {
  body: GmailMessageBody;
  headers: Record<string, string>;
  attachments: Array<{ id: string; filename: string; mimeType: string; size: number }>;
}

interface GmailRawHeader {
  name: string;
  value: string;
}

interface GmailRawPart {
  partId?: string;
  mimeType: string;
  filename?: string;
  headers?: GmailRawHeader[];
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: GmailRawPart[];
}

interface GmailRawMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet: string;
  internalDate: string;
  payload?: GmailRawPart;
}

// ── Helpers ─────────────────────────────────────────────────────────────

function headersToMap(headers?: GmailRawHeader[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of headers ?? []) out[h.name.toLowerCase()] = h.value;
  return out;
}

function decodeBase64Url(data: string): string {
  const padded = data.replace(/-/g, '+').replace(/_/g, '/');
  const pad = padded.length % 4;
  const fixed = pad ? padded + '='.repeat(4 - pad) : padded;
  return Buffer.from(fixed, 'base64').toString('utf8');
}

function walkParts(part: GmailRawPart | undefined, body: GmailMessageBody, attachments: GmailMessageFull['attachments']): void {
  if (!part) return;
  const mt = (part.mimeType || '').toLowerCase();
  if (part.body?.attachmentId && part.filename) {
    attachments.push({
      id: part.body.attachmentId,
      filename: part.filename,
      mimeType: part.mimeType,
      size: part.body.size ?? 0,
    });
  } else if (part.body?.data) {
    if (mt === 'text/plain' && body.text === null) {
      body.text = decodeBase64Url(part.body.data);
    } else if (mt === 'text/html' && body.html === null) {
      body.html = decodeBase64Url(part.body.data);
    }
  }
  for (const p of part.parts ?? []) walkParts(p, body, attachments);
}

function metaFromRaw(raw: GmailRawMessage): GmailMessageMeta {
  const h = headersToMap(raw.payload?.headers);
  return {
    id: raw.id,
    threadId: raw.threadId,
    labelIds: raw.labelIds ?? [],
    snippet: raw.snippet,
    internalDate: raw.internalDate,
    from: h['from'] ?? '',
    to: h['to'] ?? '',
    subject: h['subject'] ?? '(no subject)',
    date: h['date'] ?? '',
    unread: (raw.labelIds ?? []).includes('UNREAD'),
  };
}

// ── Public operations ───────────────────────────────────────────────────

export interface ListMessagesOptions {
  q?: string;
  labelIds?: string[];
  pageToken?: string;
  maxResults?: number;
}

export async function listGmailMessages(
  userId: string,
  accountId: string,
  opts: ListMessagesOptions = {},
): Promise<{ messages: GmailMessageMeta[]; nextPageToken: string | null; resultSizeEstimate: number }> {
  return withGmailAccessToken(userId, accountId, async (token) => {
    const params = new URLSearchParams();
    params.set('maxResults', String(Math.min(opts.maxResults ?? 25, 100)));
    if (opts.q) params.set('q', opts.q);
    if (opts.pageToken) params.set('pageToken', opts.pageToken);
    for (const l of opts.labelIds ?? []) params.append('labelIds', l);

    const list = await gmailFetch<{
      messages?: Array<{ id: string; threadId: string }>;
      nextPageToken?: string;
      resultSizeEstimate?: number;
    }>(token, `/users/me/messages?${params.toString()}`);

    const ids = list.messages ?? [];
    if (ids.length === 0) {
      await touchAccountSync(userId, accountId).catch(() => {});
      return { messages: [], nextPageToken: list.nextPageToken ?? null, resultSizeEstimate: list.resultSizeEstimate ?? 0 };
    }

    // Fetch metadata for each message in parallel (capped concurrency).
    const metas = await Promise.all(
      ids.map((m) =>
        gmailFetch<GmailRawMessage>(
          token,
          `/users/me/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`,
        ).then(metaFromRaw),
      ),
    );

    await touchAccountSync(userId, accountId).catch(() => {});
    return {
      messages: metas,
      nextPageToken: list.nextPageToken ?? null,
      resultSizeEstimate: list.resultSizeEstimate ?? metas.length,
    };
  });
}

export async function getGmailMessage(
  userId: string,
  accountId: string,
  messageId: string,
): Promise<GmailMessageFull> {
  return withGmailAccessToken(userId, accountId, async (token) => {
    const raw = await gmailFetch<GmailRawMessage>(
      token,
      `/users/me/messages/${encodeURIComponent(messageId)}?format=full`,
    );
    const meta = metaFromRaw(raw);
    const body: GmailMessageBody = { text: null, html: null };
    const attachments: GmailMessageFull['attachments'] = [];
    walkParts(raw.payload, body, attachments);
    return {
      ...meta,
      headers: headersToMap(raw.payload?.headers),
      body,
      attachments,
    };
  });
}

export async function listGmailLabels(userId: string, accountId: string): Promise<GmailLabel[]> {
  return withGmailAccessToken(userId, accountId, async (token) => {
    const res = await gmailFetch<{ labels?: GmailLabel[] }>(token, `/users/me/labels`);
    return res.labels ?? [];
  });
}

export async function modifyGmailMessage(
  userId: string,
  accountId: string,
  messageId: string,
  changes: { addLabelIds?: string[]; removeLabelIds?: string[] },
): Promise<void> {
  await withGmailAccessToken(userId, accountId, async (token) => {
    await gmailFetch(token, `/users/me/messages/${encodeURIComponent(messageId)}/modify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(changes),
    });
  });
}

// ─── Send ──────────────────────────────────────────────────────────────────

function encodeRfc2047(str: string): string {
  // Quote non-ASCII subject/header values per RFC 2047 (UTF-8, Base64).
  if (/^[\x20-\x7E]*$/.test(str)) return str;
  const b64 = Buffer.from(str, 'utf8').toString('base64');
  return `=?UTF-8?B?${b64}?=`;
}

function buildRfc822(opts: {
  from: string;
  to: string;
  subject: string;
  bodyText: string;
  inReplyTo?: string | null;
  references?: string | null;
}): string {
  const lines = [
    `From: ${opts.from}`,
    `To: ${opts.to}`,
    `Subject: ${encodeRfc2047(opts.subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
  ];
  if (opts.inReplyTo) lines.push(`In-Reply-To: ${opts.inReplyTo}`);
  if (opts.references) lines.push(`References: ${opts.references}`);
  lines.push('', opts.bodyText);
  return lines.join('\r\n');
}

function toBase64Url(input: string): string {
  return Buffer.from(input, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export interface SendGmailReplyInput {
  fromAddress: string;
  to: string;
  subject: string;
  bodyText: string;
  threadId?: string | null;
  inReplyTo?: string | null;
  references?: string | null;
}

export interface SendGmailReplyResult {
  id: string;
  threadId: string;
  labelIds?: string[];
}

export async function sendGmailReply(
  userId: string,
  accountId: string,
  input: SendGmailReplyInput,
): Promise<SendGmailReplyResult> {
  return withGmailAccessToken(userId, accountId, async (token) => {
    const raw = toBase64Url(
      buildRfc822({
        from: input.fromAddress,
        to: input.to,
        subject: input.subject,
        bodyText: input.bodyText,
        inReplyTo: input.inReplyTo ?? null,
        references: input.references ?? input.inReplyTo ?? null,
      }),
    );
    const body: Record<string, unknown> = { raw };
    if (input.threadId) body.threadId = input.threadId;
    const res = await gmailFetch<SendGmailReplyResult>(token, `/users/me/messages/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res;
  });
}
