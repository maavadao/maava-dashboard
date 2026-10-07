// GET /api/inbox/oauth/gmail/start
// Begins the Gmail OAuth flow by redirecting to Google's consent screen.

import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest } from '@/lib/auth';
import { buildGmailAuthUrl, createInboxOAuthState, getGmailConfig } from '@/lib/inbox/providers';
import { recordOAuthState } from '@/lib/inbox/db';

export async function GET(request: NextRequest) {
  const user = await authenticateRequest(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const cfg = getGmailConfig();
  if (!cfg.clientId || !cfg.clientSecret) {
    return NextResponse.json(
      { error: 'Gmail OAuth is not configured. Set GMAIL_OAUTH_CLIENT_ID / GMAIL_OAUTH_CLIENT_SECRET.' },
      { status: 503 },
    );
  }

  try {
    const state = await createInboxOAuthState({
      userId: user.userId,
      provider: 'gmail',
      nonce: crypto.randomUUID(),
    });
    await recordOAuthState(state, user.userId, 'gmail');
    return NextResponse.redirect(buildGmailAuthUrl(state));
  } catch (err) {
    console.error('[inbox/gmail/start]', err);
    return NextResponse.json({ error: 'Failed to start Gmail OAuth' }, { status: 500 });
  }
}
