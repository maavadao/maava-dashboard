// DELETE /api/channels/slack/disconnect
// Deactivates the Slack workspace connection for the authenticated user.

import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest } from '@/lib/auth';
import {
  getSlackConnectionForUser,
  deactivateSlackConnection,
  revokeSlackToken,
} from '@/lib/slack-oauth';

export async function DELETE(request: NextRequest) {
  const user = await authenticateRequest(request);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const connection = await getSlackConnectionForUser(user.userId);
    if (!connection) {
      return NextResponse.json({ error: 'No active Slack connection' }, { status: 404 });
    }

    // Soft-delete (mark inactive)
    const deactivated = await deactivateSlackConnection(user.userId, connection.slackTeamId);
    if (!deactivated) {
      return NextResponse.json({ error: 'Failed to disconnect' }, { status: 500 });
    }

    // Optionally revoke the bot token at Slack
    // This is best-effort; failure doesn't block the disconnect
    await revokeSlackToken(connection.slackBotToken).catch((err) => {
      console.warn('[slack/disconnect] Token revocation failed (non-blocking):', err);
    });

    console.log(
      `[slack/disconnect] Disconnected: team=${connection.slackTeamId} user=${user.userId}`,
    );

    return NextResponse.json({
      success: true,
      message: `Disconnected from ${connection.slackTeamName || connection.slackTeamId}`,
    });
  } catch (err) {
    console.error('[slack/disconnect] Error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
