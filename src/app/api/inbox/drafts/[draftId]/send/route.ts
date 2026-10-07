// POST /api/inbox/drafts/[draftId]/send
// Approves and sends a pending AI-generated reply via the connected provider.

import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest } from '@/lib/auth';
import {
  getDraft,
  getInboxAccount,
  markDraftSent,
} from '@/lib/inbox/db';
import {
  getGmailMessage,
  sendGmailReply,
  GmailApiError,
  GmailAuthError,
} from '@/lib/inbox/gmail-api';

interface RouteContext {
  params: Promise<{ draftId: string }>;
}

export async function POST(request: NextRequest, ctx: RouteContext) {
  const user = await authenticateRequest(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { draftId } = await ctx.params;
  const draft = await getDraft(user.userId, draftId);
  if (!draft) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (draft.status !== 'pending') {
    return NextResponse.json({ error: 'Draft is not pending' }, { status: 409 });
  }
  const account = await getInboxAccount(user.userId, draft.account_id);
  if (!account) return NextResponse.json({ error: 'Account not found' }, { status: 404 });
  if (account.provider !== 'gmail') {
    return NextResponse.json({ error: 'Provider not supported yet' }, { status: 501 });
  }
  if (!account.policy.can_send) {
    return NextResponse.json(
      { error: 'Sending is disabled in this account policy' },
      { status: 403 },
    );
  }

  try {
    // Pull threading headers from the source message so the reply is threaded.
    let inReplyTo: string | null = null;
    let references: string | null = null;
    try {
      const src = await getGmailMessage(user.userId, draft.account_id, draft.source_message_id);
      inReplyTo = src.headers['message-id'] || null;
      references = src.headers['references']
        ? `${src.headers['references']} ${inReplyTo ?? ''}`.trim()
        : inReplyTo;
    } catch (e) {
      console.warn('[inbox/draft/send] could not load source headers', e);
    }

    const result = await sendGmailReply(user.userId, draft.account_id, {
      fromAddress: account.account_email,
      to: draft.to_addr,
      subject: draft.subject,
      bodyText: draft.body_text,
      threadId: draft.source_thread_id,
      inReplyTo,
      references,
    });
    await markDraftSent(user.userId, draftId);
    return NextResponse.json({ data: { id: result.id, threadId: result.threadId } });
  } catch (err) {
    if (err instanceof GmailAuthError) {
      return NextResponse.json({ error: err.message, code: 'reauth_required' }, { status: 401 });
    }
    if (err instanceof GmailApiError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error('[inbox/draft/send]', err);
    return NextResponse.json({ error: 'Failed to send reply' }, { status: 500 });
  }
}
