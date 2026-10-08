// ─── Slack event router ───
// Parses inbound Slack events, resolves the target mawaDao tenant,
// forwards to mawa, and sends the reply back to Slack.

import type {
  SlackEventCallback,
  SlackEvent,
  SlackRoutingContext,
} from '@/types/slack';
import { DEFAULT_MAWADAO_SLACK_CONFIG } from '@/lib/slack-config';
import {
  getSlackConnectionByTeamAndUser,
  isEventProcessed,
  markEventProcessed,
} from '@/lib/slack-oauth';
import { sendSlackReply, addSlackReaction, removeSlackReaction } from '@/lib/slack-client';
import { forwardToGateway, buildSessionKey } from '@/lib/gateway-proxy';

const config = DEFAULT_MAWADAO_SLACK_CONFIG;

// Event subtypes to always ignore (system / bot-generated)
const IGNORED_SUBTYPES = new Set([
  'bot_message',
  'message_changed',
  'message_deleted',
  'channel_join',
  'channel_leave',
  'channel_topic',
  'channel_purpose',
  'channel_name',
  'channel_archive',
  'channel_unarchive',
  'group_join',
  'group_leave',
  'group_topic',
  'group_purpose',
  'group_name',
  'group_archive',
  'group_unarchive',
  'file_share',
  'me_message',
  'tombstone',
  'thread_broadcast',
]);

/**
 * Main entry: process an event_callback from Slack.
 * Returns true if the event was handled, false if skipped.
 */
export async function routeSlackEvent(payload: SlackEventCallback): Promise<boolean> {
  const { event, event_id, team_id, enterprise_id } = payload;

  // Deduplication
  if (await isEventProcessed(event_id)) {
    console.log(`[slack-router] Duplicate event ${event_id}, skipping`);
    return false;
  }

  // Should we handle this event type?
  if (!shouldHandleEvent(event)) {
    return false;
  }

  // Mark processed early to avoid double delivery
  await markEventProcessed(event_id, team_id);

  const slackUserId = event.user || '';
  const channelId = event.channel || '';
  const channelType = event.channel_type || 'unknown';
  const messageTs = event.ts || event.event_ts || '';
  const threadTs = event.thread_ts || null;
  const text = event.text || '';

  // Resolve the owning mawaDao user via team_id (+ optional slack user)
  const connection = await getSlackConnectionByTeamAndUser(team_id, slackUserId);
  if (!connection) {
    console.warn(`[slack-router] No active connection for team=${team_id} user=${slackUserId}`);
    return false;
  }

  // Ignore messages from our own bot
  if (connection.slackBotUserId && event.bot_id) {
    return false;
  }
  if (slackUserId === connection.slackBotUserId) {
    return false;
  }

  // Build routing context
  const sessionKey = buildSessionKey(team_id, channelId, threadTs, slackUserId);
  const routingCtx: SlackRoutingContext = {
    teamId: team_id,
    enterpriseId: enterprise_id ?? null,
    slackUserId,
    channelId,
    channelType,
    threadTs,
    messageTs,
    text,
    files: event.files ?? [],
    connection,
    sessionKey,
  };

  // Process asynchronously — don't block the 3s Slack response window
  handleEventAsync(routingCtx).catch((err) => {
    console.error(`[slack-router] Async event handling failed for ${event_id}:`, err);
  });

  return true;
}

// ── Event filtering ──

function shouldHandleEvent(event: SlackEvent): boolean {
  // Ignore system subtypes
  if (event.subtype && IGNORED_SUBTYPES.has(event.subtype)) return false;

  // Ignore bot messages unless explicitly allowed
  if (event.bot_id && !config.allowBots) return false;

  const eventType = event.type;
  const channelType = event.channel_type;

  // Required: app_mention
  if (eventType === 'app_mention') return true;

  // Required: DM messages
  if (eventType === 'message' && channelType === 'im') {
    return config.dm?.enabled !== false;
  }

  // Optional: group DMs
  if (eventType === 'message' && channelType === 'mpim') {
    return config.dm?.groupEnabled === true;
  }

  // Optional: public/private channels (only mentions by default)
  if (eventType === 'message' && (channelType === 'channel' || channelType === 'group')) {
    // For channel messages, only process if the event is a mention
    // (standalone message events in channels require explicit opt-in)
    return false;
  }

  return false;
}

// ── Async event processor ──

async function handleEventAsync(ctx: SlackRoutingContext): Promise<void> {
  const { connection, channelId, text, messageTs, threadTs, sessionKey } = ctx;
  const botToken = connection.slackBotToken;

  // Add typing indicator reaction
  const typingEmoji = config.typingReaction || 'hourglass_flowing_sand';
  await addSlackReaction(botToken, channelId, messageTs, typingEmoji).catch(() => {});

  try {
    // Resolve the tenant's mawa backend URL
    let gatewayUrl: string | null = null;

    // Direct lookup by userId
    const pool = (await import('@/lib/db')).default;
    const tenantResult = await pool.query(
      `SELECT id, subdomain, backend_url, gateway_token FROM tenants
       WHERE user_id = $1 AND status = 'active'
       LIMIT 1`,
      [connection.mawadaoUserId],
    );

    const tenantRow = tenantResult.rows[0];
    if (tenantRow?.backend_url) {
      gatewayUrl = tenantRow.backend_url;
    }

    // Forward to mawa
    const response = await forwardToGateway({
      mawadaoUserId: connection.mawadaoUserId,
      tenantId: tenantRow?.id ?? null,
      tenantSubdomain: tenantRow?.subdomain ?? null,
      gatewayInstanceUrl: gatewayUrl,
      authToken: tenantRow?.gateway_token ?? null,
      message: stripBotMention(text, connection.slackBotUserId),
      sessionKey,
      channelMeta: {
        platform: 'slack',
        teamId: ctx.teamId,
        channelId,
        userId: ctx.slackUserId,
        threadTs,
        messageTs,
        channelType: ctx.channelType,
        workspaceName: connection.slackTeamName,
      },
    });

    // Send reply back to Slack
    await sendSlackReply(
      botToken,
      channelId,
      response.text,
      threadTs || messageTs, // Always thread the reply
    );
  } catch (err) {
    console.error(`[slack-router] Failed to process message:`, err);

    // Send error reply to user
    await sendSlackReply(
      botToken,
      channelId,
      "Sorry, I encountered an error processing your message. Please try again.",
      threadTs || messageTs,
    ).catch(() => {});
  } finally {
    // Remove typing indicator
    await removeSlackReaction(botToken, channelId, messageTs, typingEmoji).catch(() => {});
  }
}

// Strip <@BOT_USER_ID> mentions from the beginning of the message
function stripBotMention(text: string, botUserId: string | null): string {
  if (!botUserId) return text.trim();
  return text.replace(new RegExp(`<@${botUserId}>`, 'g'), '').trim();
}
