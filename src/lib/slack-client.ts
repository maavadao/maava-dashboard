// ─── Slack Web API client (outbound messages) ───

import type { SlackPostMessagePayload, SlackApiResponse } from '@/types/slack';

const MAX_TEXT_LENGTH = 4000; // Slack's soft limit per message
const RETRY_STATUS_CODES = [429, 500, 502, 503, 504];
const MAX_RETRIES = 3;

/**
 * Send a message to Slack using chat.postMessage.
 * Handles threading, message chunking, and 429 retries.
 */
export async function sendSlackMessage(
  botToken: string,
  payload: SlackPostMessagePayload,
): Promise<SlackApiResponse> {
  // Long messages get chunked
  if (payload.text.length > MAX_TEXT_LENGTH) {
    return sendChunkedMessage(botToken, payload);
  }

  return callSlackApi(botToken, 'chat.postMessage', payload);
}

/**
 * Send a threaded reply. If thread_ts is absent, sends a top-level message.
 */
export async function sendSlackReply(
  botToken: string,
  channel: string,
  text: string,
  threadTs?: string | null,
): Promise<SlackApiResponse> {
  const payload: SlackPostMessagePayload = {
    channel,
    text,
    mrkdwn: true,
    unfurl_links: false,
    unfurl_media: false,
  };

  if (threadTs) {
    payload.thread_ts = threadTs;
  }

  return sendSlackMessage(botToken, payload);
}

/**
 * Add a reaction emoji to a message.
 */
export async function addSlackReaction(
  botToken: string,
  channel: string,
  timestamp: string,
  emoji: string,
): Promise<SlackApiResponse> {
  return callSlackApi(botToken, 'reactions.add', {
    channel,
    timestamp,
    name: emoji,
  });
}

/**
 * Remove a reaction emoji from a message.
 */
export async function removeSlackReaction(
  botToken: string,
  channel: string,
  timestamp: string,
  emoji: string,
): Promise<SlackApiResponse> {
  return callSlackApi(botToken, 'reactions.remove', {
    channel,
    timestamp,
    name: emoji,
  });
}

// ── Internal helpers ──

async function sendChunkedMessage(
  botToken: string,
  payload: SlackPostMessagePayload,
): Promise<SlackApiResponse> {
  const chunks = chunkText(payload.text, MAX_TEXT_LENGTH);
  let lastResponse: SlackApiResponse | null = null;

  // First chunk is the initial message (or threaded if thread_ts exists)
  const firstPayload = { ...payload, text: chunks[0] };
  lastResponse = await callSlackApi(botToken, 'chat.postMessage', firstPayload);

  if (!lastResponse.ok || chunks.length === 1) return lastResponse;

  // Subsequent chunks thread under the first message (or the existing thread)
  const threadTs = payload.thread_ts || lastResponse.ts;

  for (let i = 1; i < chunks.length; i++) {
    lastResponse = await callSlackApi(botToken, 'chat.postMessage', {
      channel: payload.channel,
      text: chunks[i],
      thread_ts: threadTs,
      mrkdwn: true,
    });
    if (!lastResponse.ok) break;
  }

  return lastResponse!;
}

function chunkText(text: string, maxLen: number): string[] {
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    // Try to break at a newline
    let breakIndex = remaining.lastIndexOf('\n', maxLen);
    if (breakIndex < maxLen * 0.5) {
      // No good newline break; break at space
      breakIndex = remaining.lastIndexOf(' ', maxLen);
    }
    if (breakIndex < maxLen * 0.3) {
      // No good break point; hard cut
      breakIndex = maxLen;
    }

    chunks.push(remaining.slice(0, breakIndex));
    remaining = remaining.slice(breakIndex).trimStart();
  }

  return chunks;
}

async function callSlackApi(
  botToken: string,
  method: string,
  body: Record<string, unknown> | SlackPostMessagePayload,
  retryCount = 0,
): Promise<SlackApiResponse> {
  const response = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${botToken}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(body),
  });

  // Handle rate limiting with retry-after
  if (response.status === 429 && retryCount < MAX_RETRIES) {
    const retryAfter = Number(response.headers.get('retry-after') || '1');
    const waitMs = Math.min(retryAfter * 1000, 30_000);
    console.warn(`[slack-client] Rate limited on ${method}, retrying in ${waitMs}ms`);
    await sleep(waitMs);
    return callSlackApi(botToken, method, body, retryCount + 1);
  }

  // Retry transient server errors
  if (RETRY_STATUS_CODES.includes(response.status) && retryCount < MAX_RETRIES) {
    const backoff = Math.min(1000 * 2 ** retryCount, 10_000);
    console.warn(`[slack-client] ${method} returned ${response.status}, retrying in ${backoff}ms`);
    await sleep(backoff);
    return callSlackApi(botToken, method, body, retryCount + 1);
  }

  const data = (await response.json()) as SlackApiResponse;

  if (!data.ok) {
    console.error(`[slack-client] ${method} error: ${data.error}`);
  }

  return data;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
