// Provider-config helpers for Gmail (Google) + Outlook (Microsoft Graph) OAuth.
// All values come from env vars. Never hard-code client secrets.

import { SignJWT, jwtVerify } from 'jose';
import type { InboxProvider, OAuthTokenBundle } from './types';

const STATE_SECRET = new TextEncoder().encode(
  process.env.INBOX_OAUTH_STATE_SECRET || process.env.JWT_SECRET || 'change-this-jwt-secret',
);
const STATE_ISSUER = 'mawadao-inbox-oauth';
const STATE_MAX_AGE_SEC = 600;

export interface InboxOAuthState {
  userId: string;
  provider: InboxProvider;
  nonce: string;
}

export async function createInboxOAuthState(payload: InboxOAuthState): Promise<string> {
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setIssuer(STATE_ISSUER)
    .setExpirationTime(`${STATE_MAX_AGE_SEC}s`)
    .sign(STATE_SECRET);
}

export async function verifyInboxOAuthState(token: string): Promise<InboxOAuthState | null> {
  try {
    const { payload } = await jwtVerify(token, STATE_SECRET, {
      issuer: STATE_ISSUER,
      algorithms: ['HS256'],
    });
    return {
      userId: payload.userId as string,
      provider: payload.provider as InboxProvider,
      nonce: payload.nonce as string,
    };
  } catch {
    return null;
  }
}

// ── Gmail (Google) ───────────────────────────────────────────────────────

export const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.modify',
  'openid',
  'email',
  'profile',
];

export interface GmailConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export function getGmailConfig(): GmailConfig {
  return {
    clientId: process.env.GMAIL_OAUTH_CLIENT_ID || '',
    clientSecret: process.env.GMAIL_OAUTH_CLIENT_SECRET || '',
    redirectUri:
      process.env.GMAIL_OAUTH_REDIRECT_URI ||
      'https://agent.mawadao.com/api/inbox/oauth/gmail/callback',
  };
}

export function buildGmailAuthUrl(state: string): string {
  const cfg = getGmailConfig();
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    response_type: 'code',
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    scope: GMAIL_SCOPES.join(' '),
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export async function exchangeGmailCode(code: string): Promise<OAuthTokenBundle> {
  const cfg = getGmailConfig();
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      redirect_uri: cfg.redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Google token exchange failed: HTTP ${res.status} ${text}`);
  }
  const data = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    token_type: string;
    scope?: string;
  };
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + (data.expires_in ?? 3600) * 1000,
    token_type: data.token_type,
    scope: data.scope,
    raw: data as unknown as Record<string, unknown>,
  };
}

export async function refreshGmailAccessToken(refreshToken: string): Promise<OAuthTokenBundle> {
  const cfg = getGmailConfig();
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Google token refresh failed: HTTP ${res.status} ${text}`);
  }
  const data = (await res.json()) as {
    access_token: string;
    expires_in: number;
    token_type: string;
    scope?: string;
  };
  return {
    access_token: data.access_token,
    refresh_token: refreshToken, // Google refresh tokens are long-lived; reuse.
    expires_at: Date.now() + (data.expires_in ?? 3600) * 1000,
    token_type: data.token_type,
    scope: data.scope,
    raw: data as unknown as Record<string, unknown>,
  };
}

export async function fetchGmailProfile(accessToken: string): Promise<{ email: string; name?: string }> {
  // Prefer the OIDC userinfo endpoint — it only needs the `openid email profile`
  // scopes (already requested) and does not require the Gmail API to be enabled
  // on the OAuth client's GCP project. This makes the OAuth handshake succeed
  // even before the operator enables gmail.googleapis.com in the Console.
  const res = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (res.ok) {
    const data = (await res.json()) as { email?: string; name?: string };
    if (data.email) return { email: data.email, name: data.name };
  }

  // Fallback: Gmail API profile (requires gmail.googleapis.com enabled).
  const gmailRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!gmailRes.ok) {
    const body = await gmailRes.text().catch(() => '');
    throw new Error(`Gmail profile fetch failed: HTTP ${gmailRes.status} ${body.slice(0, 200)}`);
  }
  const data = (await gmailRes.json()) as { emailAddress: string };
  return { email: data.emailAddress };
}

// ── Outlook (Microsoft Graph) ───────────────────────────────────────────

export const OUTLOOK_SCOPES = [
  'offline_access',
  'openid',
  'profile',
  'email',
  'Mail.Read',
  'Mail.Send',
  'Mail.ReadWrite',
];

export interface OutlookConfig {
  clientId: string;
  clientSecret: string;
  tenantId: string; // 'common' for multi-tenant
  redirectUri: string;
}

export function getOutlookConfig(): OutlookConfig {
  return {
    clientId: process.env.MS_GRAPH_CLIENT_ID || '',
    clientSecret: process.env.MS_GRAPH_CLIENT_SECRET || '',
    tenantId: process.env.MS_GRAPH_TENANT_ID || 'common',
    redirectUri:
      process.env.MS_GRAPH_REDIRECT_URI ||
      'https://agent.mawadao.com/api/inbox/oauth/outlook/callback',
  };
}

export function buildOutlookAuthUrl(state: string): string {
  const cfg = getOutlookConfig();
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    response_type: 'code',
    redirect_uri: cfg.redirectUri,
    response_mode: 'query',
    scope: OUTLOOK_SCOPES.join(' '),
    state,
    prompt: 'consent',
  });
  return `https://login.microsoftonline.com/${cfg.tenantId}/oauth2/v2.0/authorize?${params.toString()}`;
}

export async function exchangeOutlookCode(code: string): Promise<OAuthTokenBundle> {
  const cfg = getOutlookConfig();
  const res = await fetch(
    `https://login.microsoftonline.com/${cfg.tenantId}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        code,
        redirect_uri: cfg.redirectUri,
        grant_type: 'authorization_code',
        scope: OUTLOOK_SCOPES.join(' '),
      }),
    },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Microsoft token exchange failed: HTTP ${res.status} ${text}`);
  }
  const data = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    token_type: string;
    scope?: string;
  };
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + (data.expires_in ?? 3600) * 1000,
    token_type: data.token_type,
    scope: data.scope,
    raw: data as unknown as Record<string, unknown>,
  };
}

export async function fetchOutlookProfile(accessToken: string): Promise<{ email: string; name?: string }> {
  const res = await fetch('https://graph.microsoft.com/v1.0/me', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Microsoft Graph /me failed: HTTP ${res.status}`);
  const data = (await res.json()) as { mail?: string; userPrincipalName?: string; displayName?: string };
  return {
    email: data.mail || data.userPrincipalName || '',
    name: data.displayName,
  };
}
