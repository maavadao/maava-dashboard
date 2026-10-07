// GET /api/inbox/accounts/[id]/labels — list Gmail labels for the connected account.

import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest } from '@/lib/auth';
import { getInboxAccount } from '@/lib/inbox/db';
import { listGmailLabels, GmailAuthError, GmailApiError } from '@/lib/inbox/gmail-api';

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, ctx: RouteContext) {
  const user = await authenticateRequest(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await ctx.params;
  const account = await getInboxAccount(user.userId, id);
  if (!account) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (account.provider !== 'gmail') {
    return NextResponse.json({ error: `Provider ${account.provider} not yet supported` }, { status: 501 });
  }

  try {
    const labels = await listGmailLabels(user.userId, id);
    return NextResponse.json({ data: labels });
  } catch (err) {
    if (err instanceof GmailAuthError) {
      return NextResponse.json({ error: err.message, code: 'reauth_required' }, { status: 401 });
    }
    if (err instanceof GmailApiError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error('[inbox/labels][GET]', err);
    return NextResponse.json({ error: 'Failed to load labels' }, { status: 500 });
  }
}
