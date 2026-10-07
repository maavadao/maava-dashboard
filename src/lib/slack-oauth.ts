// ─── Slack OAuth helpers ───

import { SignJWT, jwtVerify } from 'jose';
import pool from '@/lib/db';
import type { SlackOAuthV2Response, SlackConnection, SlackOAuthState } from '@/types/slack';

// ── Environment ──

const SLACK_CLIENT_ID = process.env.SLACK_CLIENT_ID || '';
const SLACK_CLIENT_SECRET = process.env.SLACK_CLIENT_SECRET || '';
const SLACK_REDIRECT_URI =
  process.env.SLACK_REDIRECT_URI || 'http://localhost:3001/api/channels/slack/callback';
const SLACK_BOT_SCOPES =
  process.env.SLACK_BOT_SCOPES ||
  'app_mentions:read,channels:history,groups:history,im:history,chat:write,commands,reactions:write,files:write';
const SLACK_USER_SCOPES = process.env.SLACK_USER_SCOPES || '';

const STATE_SECRET = new TextEncoder().encode(
  process.env.SLACK_OAUTH_STATE_SECRET || process.env.JWT_SECRET || 'change-this-jwt-secret',
);
const STATE_ISSUER = 'mawadao-slack-oauth';
const STATE_MAX_AGE_SEC = 600; // 10 minutes

// ── OAuth URL ──

export function buildSlackOAuthUrl(userId: string, stateToken: string): string {
  const params = new URLSearchParams({
    client_id: SLACK_CLIENT_ID,
    scope: SLACK_BOT_SCOPES,
    redirect_uri: SLACK_REDIRECT_URI,
    state: stateToken,
  });
  if (SLACK_USER_SCOPES) {
    params.set('user_scope', SLACK_USER_SCOPES);
  }
  return `https://slack.com/oauth/v2/authorize?${params.toString()}`;
}

// ── CSRF state token ──

export async function createOAuthState(userId: string): Promise<string> {
  const nonce = crypto.randomUUID();
  return new SignJWT({ userId, nonce } satisfies SlackOAuthState)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${STATE_MAX_AGE_SEC}s`)
    .setIssuer(STATE_ISSUER)
    .sign(STATE_SECRET);
}

export async function verifyOAuthState(token: string): Promise<SlackOAuthState | null> {
  try {
    const { payload } = await jwtVerify(token, STATE_SECRET, {
      issuer: STATE_ISSUER,
      algorithms: ['HS256'],
    });
    return {
      userId: payload.userId as string,
      nonce: payload.nonce as string,
      iat: payload.iat as number,
    };
  } catch {
    return null;
  }
}

// ── Token exchange ──

export async function exchangeSlackCode(code: string): Promise<SlackOAuthV2Response> {
  const response = await fetch('https://slack.com/api/oauth.v2.access', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: SLACK_CLIENT_ID,
      client_secret: SLACK_CLIENT_SECRET,
      code,
      redirect_uri: SLACK_REDIRECT_URI,
    }),
  });

  if (!response.ok) {
    throw new Error(`Slack oauth.v2.access failed: HTTP ${response.status}`);
  }

  const data = (await response.json()) as SlackOAuthV2Response;
  if (!data.ok) {
    throw new Error(`Slack oauth.v2.access error: ${data.error}`);
  }
  return data;
}

// ── Persist installation ──

export async function upsertSlackConnection(
  userId: string,
  oauthResponse: SlackOAuthV2Response,
): Promise<SlackConnection> {
  const result = await pool.query(
    `INSERT INTO slack_connections (
      mawadao_user_id, slack_team_id, slack_team_name, slack_bot_token,
      slack_bot_user_id, slack_authed_user_id, slack_scope,
      slack_enterprise_id, slack_installed_by_user_id, slack_app_id,
      is_active, metadata
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, true, $11)
    ON CONFLICT (slack_team_id, mawadao_user_id)
    DO UPDATE SET
      slack_team_name = EXCLUDED.slack_team_name,
      slack_bot_token = EXCLUDED.slack_bot_token,
      slack_bot_user_id = EXCLUDED.slack_bot_user_id,
      slack_authed_user_id = EXCLUDED.slack_authed_user_id,
      slack_scope = EXCLUDED.slack_scope,
      slack_enterprise_id = EXCLUDED.slack_enterprise_id,
      slack_installed_by_user_id = EXCLUDED.slack_installed_by_user_id,
      slack_app_id = EXCLUDED.slack_app_id,
      is_active = true,
      metadata = EXCLUDED.metadata,
      updated_at = NOW()
    RETURNING *`,
    [
      userId,
      oauthResponse.team.id,
      oauthResponse.team.name,
      oauthResponse.access_token,
      oauthResponse.bot_user_id,
      oauthResponse.authed_user?.id ?? null,
      oauthResponse.scope,
      oauthResponse.enterprise?.id ?? null,
      oauthResponse.authed_user?.id ?? null,
      oauthResponse.app_id,
      JSON.stringify({
        tokenType: oauthResponse.token_type,
        incomingWebhook: oauthResponse.incoming_webhook ?? null,
      }),
    ],
  );

  return formatConnection(result.rows[0]);
}

// ── Query helpers ──

export async function getSlackConnectionForUser(
  userId: string,
): Promise<SlackConnection | null> {
  const result = await pool.query(
    `SELECT * FROM slack_connections
     WHERE mawadao_user_id = $1 AND is_active = true
     ORDER BY updated_at DESC
     LIMIT 1`,
    [userId],
  );
  if (result.rows.length === 0) return null;
  return formatConnection(result.rows[0]);
}

export async function getSlackConnectionByTeam(
  teamId: string,
): Promise<SlackConnection | null> {
  const result = await pool.query(
    `SELECT * FROM slack_connections
     WHERE slack_team_id = $1 AND is_active = true
     ORDER BY updated_at DESC
     LIMIT 1`,
    [teamId],
  );
  if (result.rows.length === 0) return null;
  return formatConnection(result.rows[0]);
}

export async function getSlackConnectionByTeamAndUser(
  teamId: string,
  slackUserId: string,
): Promise<SlackConnection | null> {
  // Try identity link first (for shared workspaces)
  const identityResult = await pool.query(
    `SELECT sc.* FROM slack_connections sc
     JOIN slack_identity_links sil ON sil.mawadao_user_id = sc.mawadao_user_id
       AND sil.slack_team_id = sc.slack_team_id
     WHERE sil.slack_team_id = $1 AND sil.slack_user_id = $2
       AND sc.is_active = true
     LIMIT 1`,
    [teamId, slackUserId],
  );
  if (identityResult.rows.length > 0) {
    return formatConnection(identityResult.rows[0]);
  }

  // Fallback to team-level lookup
  return getSlackConnectionByTeam(teamId);
}

export async function deactivateSlackConnection(
  userId: string,
  teamId?: string,
): Promise<boolean> {
  const conditions = ['mawadao_user_id = $1', 'is_active = true'];
  const params: string[] = [userId];

  if (teamId) {
    params.push(teamId);
    conditions.push(`slack_team_id = $${params.length}`);
  }

  const result = await pool.query(
    `UPDATE slack_connections SET is_active = false, updated_at = NOW()
     WHERE ${conditions.join(' AND ')}`,
    params,
  );
  return (result.rowCount ?? 0) > 0;
}

export async function revokeSlackToken(botToken: string): Promise<void> {
  try {
    await fetch('https://slack.com/api/auth.revoke', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${botToken}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });
  } catch (err) {
    console.error('[slack-oauth] Token revocation failed:', err);
  }
}

// ── Event deduplication ──

export async function isEventProcessed(eventId: string): Promise<boolean> {
  const result = await pool.query(
    'SELECT 1 FROM slack_event_log WHERE event_id = $1',
    [eventId],
  );
  return result.rows.length > 0;
}

export async function markEventProcessed(eventId: string, teamId: string): Promise<void> {
  await pool.query(
    `INSERT INTO slack_event_log (event_id, team_id)
     VALUES ($1, $2)
     ON CONFLICT (event_id) DO NOTHING`,
    [eventId, teamId],
  );
}

/** Clean up old event log entries (call periodically via cron) */
export async function cleanupEventLog(maxAgeHours = 24): Promise<number> {
  const result = await pool.query(
    `DELETE FROM slack_event_log WHERE processed_at < NOW() - INTERVAL '1 hour' * $1`,
    [maxAgeHours],
  );
  return result.rowCount ?? 0;
}

// ── Row formatter ──

function formatConnection(row: Record<string, unknown>): SlackConnection {
  return {
    id: row.id as string,
    mawadaoUserId: row.mawadao_user_id as string,
    slackTeamId: row.slack_team_id as string,
    slackTeamName: (row.slack_team_name as string) ?? null,
    slackBotToken: row.slack_bot_token as string,
    slackBotUserId: (row.slack_bot_user_id as string) ?? null,
    slackAuthedUserId: (row.slack_authed_user_id as string) ?? null,
    slackScope: (row.slack_scope as string) ?? null,
    slackEnterpriseId: (row.slack_enterprise_id as string) ?? null,
    slackInstalledByUserId: (row.slack_installed_by_user_id as string) ?? null,
    slackAppId: (row.slack_app_id as string) ?? null,
    isActive: row.is_active as boolean,
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}
