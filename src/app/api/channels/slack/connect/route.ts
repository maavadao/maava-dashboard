// GET /api/channels/slack/connect
// Initiates Slack OAuth flow by redirecting user to Slack's authorize page.

import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest } from '@/lib/auth';
import { buildSlackOAuthUrl, createOAuthState } from '@/lib/slack-oauth';

export async function GET(request: NextRequest) {
  const user = await authenticateRequest(request);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const stateToken = await createOAuthState(user.userId);
    const authUrl = buildSlackOAuthUrl(user.userId, stateToken);

    return NextResponse.redirect(authUrl);
  } catch (err) {
    console.error('[slack/connect] Failed to initiate OAuth:', err);
    return NextResponse.json({ error: 'Failed to initiate Slack OAuth' }, { status: 500 });
  }
}
