// GET /api/inbox/accounts/[id]/policy
// PUT /api/inbox/accounts/[id]/policy
//
// Returns or updates the AI handling policy for a single inbox account.
// All fields are optional in the PUT body; missing fields are left unchanged.

import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest } from '@/lib/auth';
import { getInboxAccount, updatePolicy } from '@/lib/inbox/db';
import type { InboxAiPolicy } from '@/lib/inbox/types';

const ALLOWED_MODES: InboxAiPolicy['mode'][] = ['off', 'approval_required', 'autonomous'];

function sanitisePatch(body: unknown): Partial<InboxAiPolicy> {
  if (!body || typeof body !== 'object') return {};
  const b = body as Record<string, unknown>;
  const out: Partial<InboxAiPolicy> = {};

  if (typeof b.mode === 'string' && (ALLOWED_MODES as string[]).includes(b.mode)) {
    out.mode = b.mode as InboxAiPolicy['mode'];
  }
  for (const k of [
    'can_send',
    'can_reply',
    'can_forward',
    'can_delete',
    'can_archive',
    'can_label',
    'approval_required_for_send',
  ] as const) {
    if (typeof b[k] === 'boolean') (out as Record<string, unknown>)[k] = b[k];
  }
  if (typeof b.max_actions_per_hour === 'number' && Number.isFinite(b.max_actions_per_hour)) {
    out.max_actions_per_hour = Math.max(0, Math.min(1000, Math.floor(b.max_actions_per_hour)));
  }
  for (const k of ['excluded_addresses', 'excluded_labels', 'allowed_label_targets'] as const) {
    if (Array.isArray(b[k])) {
      (out as Record<string, unknown>)[k] = (b[k] as unknown[])
        .filter((x) => typeof x === 'string')
        .map((s) => (s as string).trim())
        .filter(Boolean)
        .slice(0, 200);
    }
  }
  if (typeof b.custom_instructions === 'string') {
    out.custom_instructions = b.custom_instructions.slice(0, 4000);
  }
  return out;
}

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, ctx: RouteContext) {
  const user = await authenticateRequest(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await ctx.params;
  const account = await getInboxAccount(user.userId, id);
  if (!account) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({ data: account.policy });
}

export async function PUT(request: NextRequest, ctx: RouteContext) {
  const user = await authenticateRequest(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await ctx.params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const patch = sanitisePatch(body);
  try {
    const updated = await updatePolicy(user.userId, id, patch);
    if (!updated) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ data: updated });
  } catch (err) {
    console.error('[inbox/policy][PUT]', err);
    return NextResponse.json({ error: 'Failed to update policy' }, { status: 500 });
  }
}
