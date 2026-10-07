// GET /api/inbox/oauth/outlook/start

import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest } from '@/lib/auth';
import { buildOutlookAuthUrl, createInboxOAuthState, getOutlookConfig } from '@/lib/inbox/providers';
import { recordOAuthState } from '@/lib/inbox/db';

export async function GET(request: NextRequest) {
  const user = await authenticateRequest(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const cfg = getOutlookConfig();
  if (!cfg.clientId || !cfg.clientSecret) {
    return NextResponse.json(
      { error: 'Outlook OAuth is not configured. Set MS_GRAPH_CLIENT_ID / MS_GRAPH_CLIENT_SECRET.' },
      { status: 503 },
    );
  }

  try {
    const state = await createInboxOAuthState({
      userId: user.userId,
      provider: 'outlook',
      nonce: crypto.randomUUID(),
    });
    await recordOAuthState(state, user.userId, 'outlook');
    return NextResponse.redirect(buildOutlookAuthUrl(state));
  } catch (err) {
    console.error('[inbox/outlook/start]', err);
    return NextResponse.json({ error: 'Failed to start Outlook OAuth' }, { status: 500 });
  }
}
