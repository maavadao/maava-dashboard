/**
 * Channel Delivery Service
 * 
 * Sends messages to users via their linked channels (Slack, Telegram, etc.)
 * Used by the AI chat (via [DELIVER] blocks) and scheduled tasks (cron).
 */

import pool from '@/lib/db';
import { sendSlackReply } from '@/lib/slack-client';

export type ChannelPlatform = 'slack' | 'telegram' | 'discord' | 'whatsapp';

export interface DeliveryTarget {
  platform: ChannelPlatform;
  channelId?: string;   // optional: specific Slack channel / Telegram chat
}

export interface DeliveryRequest {
  userId: string;
  text: string;
  targets?: DeliveryTarget[];        // specific platforms; if empty → all linked
  sourceContext?: string;             // e.g. "cron:daily-report", "ai-chat"
}

export interface DeliveryResult {
  platform: ChannelPlatform;
  status: 'sent' | 'skipped' | 'error';
  reason?: string;
}

/** Linked channel info returned to the AI so it knows what's available */
export interface LinkedChannelInfo {
  platform: ChannelPlatform;
  displayName: string;      // e.g. "Slack (My Workspace)" or "Telegram (@user)"
  isActive: boolean;
}

// ─── Query linked channels for a user ──────────────────────────────────

export async function getLinkedChannels(userId: string): Promise<LinkedChannelInfo[]> {
  const channels: LinkedChannelInfo[] = [];

  // 1. Slack connections (separate table)
  const slackResult = await pool.query(
    `SELECT slack_team_name, slack_bot_token, is_active
     FROM slack_connections
     WHERE maavadao_user_id = $1
     ORDER BY created_at DESC`,
    [userId],
  );
  for (const row of slackResult.rows) {
    channels.push({
      platform: 'slack',
      displayName: `Slack${row.slack_team_name ? ` (${row.slack_team_name})` : ''}`,
      isActive: row.is_active && !!row.slack_bot_token,
    });
  }

  // 2. Telegram (dedicated table first, fallback to generic)
  try {
    const tgResult = await pool.query(
      `SELECT telegram_username, telegram_first_name, is_active, last_seen_at
       FROM telegram_channel_links
       WHERE maavadao_user_id = $1
       ORDER BY created_at DESC`,
      [userId],
    );
    for (const row of tgResult.rows) {
      channels.push({
        platform: 'telegram',
        displayName: `Telegram${row.telegram_username ? ` (@${row.telegram_username})` : row.telegram_first_name ? ` (${row.telegram_first_name})` : ''}`,
        isActive: row.is_active,
      });
    }
  } catch {
    // Table may not exist yet — fall through to generic query which includes telegram
  }

  // 3. Other platform channel links (Discord, WhatsApp, + telegram fallback)
  const tgAlreadyFound = channels.some(c => c.platform === 'telegram');
  const pclResult = await pool.query(
    `SELECT platform, platform_meta, is_active
     FROM platform_channel_links
     WHERE user_id = $1
     ORDER BY created_at DESC`,
    [userId],
  );
  for (const row of pclResult.rows) {
    // Skip telegram if we already got it from dedicated table
    if (row.platform === 'telegram' && tgAlreadyFound) continue;

    const meta = row.platform_meta || {};
    let displayName = row.platform;
    if (row.platform === 'telegram') {
      displayName = `Telegram${meta.username ? ` (@${meta.username})` : meta.first_name ? ` (${meta.first_name})` : ''}`;
    } else if (row.platform === 'discord') {
      displayName = `Discord${meta.username ? ` (${meta.username})` : ''}`;
    } else if (row.platform === 'whatsapp') {
      displayName = `WhatsApp${meta.phone ? ` (${meta.phone})` : ''}`;
    }
    channels.push({
      platform: row.platform as ChannelPlatform,
      displayName,
      isActive: row.is_active,
    });
  }

  return channels;
}

// ─── Send to Slack ─────────────────────────────────────────────────────

async function deliverToSlack(userId: string, text: string, targetChannelId?: string): Promise<DeliveryResult> {
  // Find the user's active Slack connection
  const result = await pool.query(
    `SELECT slack_bot_token, slack_authed_user_id, slack_bot_user_id, slack_team_name
     FROM slack_connections
     WHERE maavadao_user_id = $1 AND is_active = true
     ORDER BY created_at DESC LIMIT 1`,
    [userId],
  );

  if (!result.rows[0]) {
    return { platform: 'slack', status: 'skipped', reason: 'not linked' };
  }

  const { slack_bot_token, slack_authed_user_id } = result.rows[0];

  // If no specific channel, DM the user who installed the app
  const channel = targetChannelId || slack_authed_user_id;
  if (!channel) {
    return { platform: 'slack', status: 'error', reason: 'no target channel or user ID' };
  }

  try {
    await sendSlackReply(slack_bot_token, channel, text);
    return { platform: 'slack', status: 'sent' };
  } catch (err: any) {
    console.error(`[channel-delivery] Slack send failed:`, err.message);
    return { platform: 'slack', status: 'error', reason: err.message };
  }
}

// ─── Send to Telegram (via maava-channels outbound API) ────────────────

async function deliverToTelegram(userId: string, text: string): Promise<DeliveryResult> {
  return deliverViaChannelRouter(userId, 'telegram', text);
}

// ─── Generic delivery via maava-channels outbound API ──────────────────

async function deliverViaChannelRouter(userId: string, platform: ChannelPlatform, text: string): Promise<DeliveryResult> {
  // Check if the user actually has this platform linked
  let linked = false;

  // For telegram, check dedicated table first
  if (platform === 'telegram') {
    try {
      const tgResult = await pool.query(
        `SELECT telegram_chat_id FROM telegram_channel_links
         WHERE maavadao_user_id = $1 AND is_active = true
         LIMIT 1`,
        [userId],
      );
      linked = !!tgResult.rows[0];
    } catch {
      // Table may not exist yet — fall through to generic check
    }
  }

  // Generic platform_channel_links check (works for all platforms)
  if (!linked) {
    const result = await pool.query(
      `SELECT platform_user_id FROM platform_channel_links
       WHERE user_id = $1 AND platform = $2 AND is_active = true
       LIMIT 1`,
      [userId, platform],
    );
    linked = !!result.rows[0];
  }

  if (!linked) {
    return { platform, status: 'skipped', reason: 'not linked' };
  }

  // Call the maava-channels outbound API
  const channelsUrl = process.env.CHANNELS_URL || 'http://localhost:8090';
  const outboundSecret = process.env.OUTBOUND_SECRET || '';

  try {
    const res = await fetch(`${channelsUrl}/api/outbound/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_id: userId,
        platform,
        text,
        secret: outboundSecret,
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      const err = await res.text().catch(() => 'unknown');
      return { platform, status: 'error', reason: `HTTP ${res.status}: ${err}` };
    }

    return { platform, status: 'sent' };
  } catch (err: any) {
    return { platform, status: 'error', reason: err.message };
  }
}

// ─── Main delivery function ────────────────────────────────────────────

export async function deliverMessage(req: DeliveryRequest): Promise<DeliveryResult[]> {
  const results: DeliveryResult[] = [];

  // Determine which platforms to deliver to
  let platforms: ChannelPlatform[];
  if (req.targets && req.targets.length > 0) {
    platforms = req.targets.map(t => t.platform);
  } else {
    // Send to all linked channels
    const linked = await getLinkedChannels(req.userId);
    platforms = linked.filter(c => c.isActive).map(c => c.platform);
  }

  // Deduplicate
  platforms = Array.from(new Set(platforms));

  for (const platform of platforms) {
    const target = req.targets?.find(t => t.platform === platform);

    switch (platform) {
      case 'slack':
        results.push(await deliverToSlack(req.userId, req.text, target?.channelId));
        break;
      case 'telegram':
      case 'discord':
      case 'whatsapp':
        results.push(await deliverViaChannelRouter(req.userId, platform, req.text));
        break;
      default:
        results.push({ platform, status: 'skipped', reason: 'unknown platform' });
    }
  }

  return results;
}
