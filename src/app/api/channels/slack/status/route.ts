// GET /api/channels/slack/status
// Returns the Slack connection status for the authenticated user.

import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest } from '@/lib/auth';
import { getSlackConnectionForUser } from '@/lib/slack-oauth';
import type { SlackConnectionStatus } from '@/types/slack';

const EVENTS_ENABLED = process.env.SLACK_EVENTS_ENABLED !== 'false';
const SOCKET_MODE_ENABLED = process.env.SLACK_SOCKET_MODE_ENABLED === 'true';

export async function GET(request: NextRequest) {
  const user = await authenticateRequest(request);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const connection = await getSlackConnectionForUser(user.userId);

    if (!connection) {
      const status: SlackConnectionStatus = {
        connected: false,
        teamId: null,
        teamName: null,
        botUserId: null,
        installedAt: null,
        mode: SOCKET_MODE_ENABLED ? 'socket_mode' : 'events_api',
        capabilities: {
          dm: true,
          mentions: true,
          channels: false,
          threads: true,
        },
      };
      return NextResponse.json({ data: status });
    }

    const status: SlackConnectionStatus = {
      connected: true,
      teamId: connection.slackTeamId,
      teamName: connection.slackTeamName,
      botUserId: connection.slackBotUserId,
      installedAt: connection.createdAt,
      mode: SOCKET_MODE_ENABLED ? 'socket_mode' : 'events_api',
      capabilities: {
        dm: true,
        mentions: true,
        channels: false,
        threads: true,
      },
    };

    return NextResponse.json({ data: status });
  } catch (err) {
    console.error('[slack/status] Error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
