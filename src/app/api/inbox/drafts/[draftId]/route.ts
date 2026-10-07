// PATCH  /api/inbox/drafts/[draftId]   — edit pending draft
// DELETE /api/inbox/drafts/[draftId]   — reject pending draft

import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest } from '@/lib/auth';
import { getDraft, rejectDraft, updateDraft } from '@/lib/inbox/db';

interface RouteContext {
  params: Promise<{ draftId: string }>;
}

export async function GET(request: NextRequest, ctx: RouteContext) {
  const user = await authenticateRequest(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { draftId } = await ctx.params;
  const draft = await getDraft(user.userId, draftId);
  if (!draft) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({ data: draft });
}

export async function PATCH(request: NextRequest, ctx: RouteContext) {
  const user = await authenticateRequest(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { draftId } = await ctx.params;
  const body = (await request.json().catch(() => ({}))) as Partial<{
    subject: string;
    bodyText: string;
    toAddr: string;
  }>;
  const patch: { subject?: string; bodyText?: string; toAddr?: string } = {};
  if (typeof body.subject === 'string') patch.subject = body.subject.slice(0, 998);
  if (typeof body.bodyText === 'string') patch.bodyText = body.bodyText.slice(0, 50_000);
  if (typeof body.toAddr === 'string') patch.toAddr = body.toAddr.slice(0, 998);
  const updated = await updateDraft(user.userId, draftId, patch);
  if (!updated) return NextResponse.json({ error: 'Not found or not pending' }, { status: 404 });
  return NextResponse.json({ data: updated });
}

export async function DELETE(request: NextRequest, ctx: RouteContext) {
  const user = await authenticateRequest(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { draftId } = await ctx.params;
  const ok = await rejectDraft(user.userId, draftId);
  if (!ok) return NextResponse.json({ error: 'Not found or not pending' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
