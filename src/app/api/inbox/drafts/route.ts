// GET /api/inbox/drafts?status=pending&accountId=...
// Lists the user's AI-generated reply drafts.

import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest } from '@/lib/auth';
import { listDrafts } from '@/lib/inbox/db';

export async function GET(request: NextRequest) {
  const user = await authenticateRequest(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const url = new URL(request.url);
  const statusParam = url.searchParams.get('status');
  const accountId = url.searchParams.get('accountId') ?? undefined;
  const limit = Math.min(Number(url.searchParams.get('limit') ?? '50') || 50, 200);
  const status =
    statusParam === 'pending' || statusParam === 'sent' || statusParam === 'rejected'
      ? statusParam
      : undefined;

  const drafts = await listDrafts(user.userId, { status, accountId, limit });
  return NextResponse.json({ data: drafts });
}
