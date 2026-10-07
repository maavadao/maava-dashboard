// GET    /api/inbox/accounts          → list current user's connected inbox accounts
// DELETE /api/inbox/accounts?id=...    → soft-revoke (status = 'revoked')

import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest } from '@/lib/auth';
import { disconnectInboxAccount, listInboxAccounts } from '@/lib/inbox/db';

export async function GET(request: NextRequest) {
  const user = await authenticateRequest(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  try {
    const accounts = await listInboxAccounts(user.userId);
    return NextResponse.json({ data: accounts });
  } catch (err) {
    console.error('[inbox/accounts][GET]', err);
    return NextResponse.json({ error: 'Failed to load inbox accounts' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  const user = await authenticateRequest(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const id = new URL(request.url).searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 });

  try {
    const ok = await disconnectInboxAccount(user.userId, id);
    if (!ok) return NextResponse.json({ error: 'Account not found' }, { status: 404 });
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('[inbox/accounts][DELETE]', err);
    return NextResponse.json({ error: 'Failed to disconnect account' }, { status: 500 });
  }
}
