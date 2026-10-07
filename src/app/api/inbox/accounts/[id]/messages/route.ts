// GET /api/inbox/accounts/[id]/messages
//   Query: q, labelIds (comma), pageToken, maxResults
// Returns paginated message metadata for the connected account.

import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest } from '@/lib/auth';
import { getInboxAccount } from '@/lib/inbox/db';
import { listGmailMessages, GmailAuthError, GmailApiError } from '@/lib/inbox/gmail-api';

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, ctx: RouteContext) {
  const user = await authenticateRequest(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await ctx.params;
  const account = await getInboxAccount(user.userId, id);
  if (!account) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const url = new URL(request.url);
  const q = url.searchParams.get('q') ?? undefined;
  const pageToken = url.searchParams.get('pageToken') ?? undefined;
  const maxResults = Number(url.searchParams.get('maxResults') ?? '25') || 25;
  const labelIdsRaw = url.searchParams.get('labelIds') ?? '';
  const labelIds = labelIdsRaw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  try {
    if (account.provider !== 'gmail') {
      return NextResponse.json({ error: `Provider ${account.provider} not yet supported` }, { status: 501 });
    }
    const data = await listGmailMessages(user.userId, id, { q, pageToken, maxResults, labelIds });
    return NextResponse.json({ data });
  } catch (err) {
    if (err instanceof GmailAuthError) {
      return NextResponse.json({ error: err.message, code: 'reauth_required' }, { status: 401 });
    }
    if (err instanceof GmailApiError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error('[inbox/messages][GET]', err);
    return NextResponse.json({ error: 'Failed to load messages' }, { status: 500 });
  }
}
