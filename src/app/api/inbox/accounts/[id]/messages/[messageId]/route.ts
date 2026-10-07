// GET   /api/inbox/accounts/[id]/messages/[messageId]   → full message + body
// PATCH /api/inbox/accounts/[id]/messages/[messageId]   → modify labels (mark read, archive, etc.)

import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest } from '@/lib/auth';
import { getInboxAccount } from '@/lib/inbox/db';
import {
  getGmailMessage,
  modifyGmailMessage,
  GmailAuthError,
  GmailApiError,
} from '@/lib/inbox/gmail-api';

interface RouteContext {
  params: Promise<{ id: string; messageId: string }>;
}

export async function GET(request: NextRequest, ctx: RouteContext) {
  const user = await authenticateRequest(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id, messageId } = await ctx.params;
  const account = await getInboxAccount(user.userId, id);
  if (!account) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (account.provider !== 'gmail') {
    return NextResponse.json({ error: `Provider ${account.provider} not yet supported` }, { status: 501 });
  }

  try {
    const message = await getGmailMessage(user.userId, id, messageId);
    return NextResponse.json({ data: message });
  } catch (err) {
    if (err instanceof GmailAuthError) {
      return NextResponse.json({ error: err.message, code: 'reauth_required' }, { status: 401 });
    }
    if (err instanceof GmailApiError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error('[inbox/messages/:id][GET]', err);
    return NextResponse.json({ error: 'Failed to load message' }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest, ctx: RouteContext) {
  const user = await authenticateRequest(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id, messageId } = await ctx.params;
  const account = await getInboxAccount(user.userId, id);
  if (!account) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (account.provider !== 'gmail') {
    return NextResponse.json({ error: `Provider ${account.provider} not yet supported` }, { status: 501 });
  }

  let body: { addLabelIds?: unknown; removeLabelIds?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const sanitiseList = (v: unknown): string[] | undefined =>
    Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, 50) : undefined;
  const addLabelIds = sanitiseList(body.addLabelIds);
  const removeLabelIds = sanitiseList(body.removeLabelIds);
  if (!addLabelIds && !removeLabelIds) {
    return NextResponse.json({ error: 'addLabelIds or removeLabelIds required' }, { status: 400 });
  }

  try {
    await modifyGmailMessage(user.userId, id, messageId, { addLabelIds, removeLabelIds });
    return NextResponse.json({ success: true });
  } catch (err) {
    if (err instanceof GmailAuthError) {
      return NextResponse.json({ error: err.message, code: 'reauth_required' }, { status: 401 });
    }
    if (err instanceof GmailApiError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error('[inbox/messages/:id][PATCH]', err);
    return NextResponse.json({ error: 'Failed to modify message' }, { status: 500 });
  }
}
