// GET /api/channels/slack/callback
// Handles the Slack OAuth redirect after user authorizes the mawaDao Slack app.

import { NextRequest, NextResponse } from 'next/server';
import { verifyOAuthState, exchangeSlackCode, upsertSlackConnection } from '@/lib/slack-oauth';
import pool from '@/lib/db';
import { MAWADAO_DOMAIN } from '@/lib/constants';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get('code');
  const state = searchParams.get('state');
  const error = searchParams.get('error');

  // User denied authorization
  if (error) {
    console.warn('[slack/callback] User denied authorization:', error);
    return redirectToChannels(null, `slack_error=${encodeURIComponent(error)}`);
  }

  if (!code || !state) {
    return redirectToChannels(null, 'slack_error=missing_code_or_state');
  }

  // Verify CSRF state token
  const statePayload = await verifyOAuthState(state);
  if (!statePayload) {
    console.error('[slack/callback] Invalid or expired state token');
    return redirectToChannels(null, 'slack_error=invalid_state');
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

    // Resolve the user's subdomain for redirect
    const subdomain = await getUserSubdomain(userId);

    return redirectToChannels(subdomain, 'success=slack_connected');
  } catch (err) {
    console.error('[slack/callback] OAuth exchange failed:', err);
    const subdomain = await getUserSubdomain(userId).catch(() => null);
    return redirectToChannels(subdomain, 'slack_error=exchange_failed');
  }
}

async function getUserSubdomain(userId: string): Promise<string | null> {
  try {
    const result = await pool.query(
      `SELECT subdomain FROM tenants WHERE user_id = $1 AND status = 'active' LIMIT 1`,
      [userId],
    );
    return result.rows[0]?.subdomain ?? null;
  } catch {
    return null;
  }
}

function redirectToChannels(subdomain: string | null, queryString: string): NextResponse {
  const host = subdomain ? `${subdomain}.${MAWADAO_DOMAIN}` : MAWADAO_DOMAIN;
  return NextResponse.redirect(`https://${host}/channels?${queryString}`);
}
