// POST /api/channels/slack/events
// Receives Slack Events API webhooks. This endpoint must be public (no auth).
//
// IMPORTANT: We use dynamic imports for slack-signature and slack-router so that
// the url_verification challenge (required for initial Slack app setup) can
// succeed even if the DB pool or other heavy deps aren't configured yet.

import { NextRequest, NextResponse } from 'next/server';
import type { SlackEventPayload, SlackEventCallback } from '@/types/slack';

// Force Node.js runtime (not Edge) — required for crypto, pg, etc.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    return NextResponse.json({ error: 'Failed to read body' }, { status: 400 });
  }

  // Parse payload first — url_verification must respond immediately
  let payload: SlackEventPayload;
  try {
    payload = JSON.parse(rawBody) as SlackEventPayload;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  // ── url_verification challenge ──
  // Slack sends this during initial app setup. We respond with the challenge
  // value immediately — no heavy imports required.
  if (payload.type === 'url_verification') {
    return NextResponse.json({ challenge: payload.challenge });
  }

  // ── event_callback — lazy-load heavy dependencies ──
  if (payload.type === 'event_callback') {
    const eventPayload = payload as SlackEventCallback;

    // Verify request signature (lazy import so url_verification never crashes)
    try {
      const { verifySlackSignature } = await import('@/lib/slack-signature');
      const timestamp = request.headers.get('x-slack-request-timestamp');
      const signature = request.headers.get('x-slack-signature');
      const verification = verifySlackSignature(rawBody, timestamp, signature);
      if (!verification.valid) {
        console.warn(`[slack/events] Signature verification failed: ${verification.reason}`);
        return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
      }
    } catch (err) {
      console.error('[slack/events] Signature verification module error:', err);
      return NextResponse.json({ error: 'Internal error' }, { status: 500 });
    }

    // Respond immediately with 200 to prevent Slack retries,
    // then process the event asynchronously
    try {
      const { routeSlackEvent } = await import('@/lib/slack-router');
      routeSlackEvent(eventPayload).catch((err) => {
        console.error('[slack/events] Event routing error:', err);
      });
    } catch (err) {
      console.error('[slack/events] Event router module error:', err);
    }

    return NextResponse.json({ ok: true });
  }

  // Unknown event type — acknowledge to prevent retries
  console.warn(`[slack/events] Unknown event type: ${(payload as Record<string, unknown>).type}`);
  return NextResponse.json({ ok: true });
}
