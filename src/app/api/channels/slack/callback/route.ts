// GET /api/channels/slack/callback
// Handles the Slack OAuth redirect after user authorizes the mawaDao Slack app.

import { NextRequest, NextResponse } from 'next/server';
import { verifyOAuthState, exchangeSlackCode, upsertSlackConnection } from '@/lib/slack-oauth';
import { MEMBER_SPACE_URL } from '@/lib/constants';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get('code');
  const state = searchParams.get('state');
  const error = searchParams.get('error');

  // User denied authorization
  if (error) {
    console.warn('[slack/callback] User denied authorization:', error);
    return redirectToChannels(`slack_error=${encodeURIComponent(error)}`);
  }

  if (!code || !state) {
    return redirectToChannels('slack_error=missing_code_or_state');
  }

  // Verify CSRF state token
  const statePayload = await verifyOAuthState(state);
  if (!statePayload) {
    console.error('[slack/callback] Invalid or expired state token');
    return redirectToChannels('slack_error=invalid_state');
  }

  const userId = statePayload.userId;

  try {
    // Exchange code for tokens
    const oauthResponse = await exchangeSlackCode(code);

    // Persist installation
    await upsertSlackConnection(userId, oauthResponse);

    console.log(
      `[slack/callback] Slack connected: team=${oauthResponse.team.id} ` +
        `name="${oauthResponse.team.name}" user=${userId}`,
    );

    return redirectToChannels('success=slack_connected');
  } catch (err) {
    console.error('[slack/callback] OAuth exchange failed:', err);
    return redirectToChannels('slack_error=exchange_failed');
  }
}

function redirectToChannels(queryString: string): NextResponse {
  return NextResponse.redirect(`${MEMBER_SPACE_URL}/channels?${queryString}`);
}
