/**
 * POST /api/channels/deliver
 * 
 * Delivers a message to the user's linked channels.
 * Called by the AI chat post-processing when it detects a [DELIVER] block.
 *
 * Body: { text, platforms?: string[], channelId?: string }
 */
import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest } from '@/lib/auth';
import { deliverMessage, getLinkedChannels, type ChannelPlatform } from '@/lib/channel-delivery';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const VALID_PLATFORMS = new Set(['slack', 'telegram', 'discord', 'whatsapp']);

export async function POST(request: NextRequest) {
  const user = await authenticateRequest(request);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) {
    return NextResponse.json({ error: 'text is required' }, { status: 400 });
  }

  // Parse target platforms
  const rawPlatforms = Array.isArray(body.platforms) ? body.platforms : [];
  const platforms = rawPlatforms
    .filter((p): p is string => typeof p === 'string' && VALID_PLATFORMS.has(p.toLowerCase()))
    .map(p => p.toLowerCase() as ChannelPlatform);

  const targets = platforms.length > 0
    ? platforms.map(p => ({
        platform: p,
        channelId: typeof body.channelId === 'string' ? body.channelId : undefined,
      }))
    : undefined;

  try {
    const results = await deliverMessage({
      userId: user.userId,
      text,
      targets,
      sourceContext: 'ai-chat',
    });

    return NextResponse.json({ ok: true, results });
  } catch (err: any) {
    console.error('[api/channels/deliver]', err);
    return NextResponse.json({ error: 'Delivery failed' }, { status: 500 });
  }
}

/**
 * GET /api/channels/deliver
 * 
 * Returns the user's linked channels — used by the AI to know what's available.
 */
export async function GET(request: NextRequest) {
  const user = await authenticateRequest(request);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const channels = await getLinkedChannels(user.userId);
    return NextResponse.json({ channels });
  } catch (err: any) {
    console.error('[api/channels/deliver GET]', err);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
