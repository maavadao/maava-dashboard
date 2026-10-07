// GET /api/inbox/oauth/gmail/callback?code=...&state=...

import { NextRequest, NextResponse } from 'next/server';
import {
  exchangeGmailCode,
  fetchGmailProfile,
  GMAIL_SCOPES,
  verifyInboxOAuthState,
} from '@/lib/inbox/providers';
import { consumeOAuthState, upsertInboxAccount } from '@/lib/inbox/db';

// Always send users back to the member space, never to the
// origin that handled the callback (which would be localhost in dev).
const INBOX_APP_BASE_URL = (
  process.env.MEMBER_SPACE_URL ||
  process.env.NEXT_PUBLIC_MEMBER_SPACE_URL ||
  process.env.NEXT_PUBLIC_MEMBER_SPACE_URL ||
  'https://agent.mawadao.com'
).replace(/\/+$/, '');

function inboxRedirect(_url: URL, params: Record<string, string>): NextResponse {
  const target = new URL('/inbox', INBOX_APP_BASE_URL);
  for (const [k, v] of Object.entries(params)) target.searchParams.set(k, v);
  return NextResponse.redirect(target);
}

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const oauthError = url.searchParams.get('error');

  if (oauthError) {
    return inboxRedirect(url, { error: oauthError });
  }
  if (!code || !state) {
    return inboxRedirect(url, { error: 'missing_code_or_state' });
  }

  const verified = await verifyInboxOAuthState(state);
  if (!verified || verified.provider !== 'gmail') {
    return inboxRedirect(url, { error: 'invalid_state' });
  }
  const consumed = await consumeOAuthState(state);
  if (!consumed) {
    return inboxRedirect(url, { error: 'state_already_used' });
  }

  try {
    const tokens = await exchangeGmailCode(code);
    const profile = await fetchGmailProfile(tokens.access_token);
    if (!profile.email) throw new Error('Profile missing email');

    await upsertInboxAccount({
      userId: verified.userId,
      provider: 'gmail',
      accountEmail: profile.email,
      displayName: profile.name ?? null,
      scopes: tokens.scope ? tokens.scope.split(' ') : GMAIL_SCOPES,
      tokens,
    });

    return inboxRedirect(url, { connected: 'gmail' });
  } catch (err) {
    console.error('[inbox/gmail/callback]', err);
    return inboxRedirect(url, { error: 'gmail_oauth_failed' });
  }
}
