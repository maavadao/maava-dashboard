import { NextRequest, NextResponse } from 'next/server';
import { getRequestUserId } from '@/lib/auth';
import { syncMCStatusToAgentTask } from '@/lib/task-sync';

/**
 * POST /api/mission-control/task-sync
 *
 * Called by the frontend when a user manually moves an MC board task
 * (e.g. drag-and-drop on kanban). Syncs the new MC status back to the
 * linked agent_task in the main database.
 *
 * Security: userId is extracted from auth and passed to the sync function
 * which enforces ownership (only the task owner can mutate it).
 *
 * Body: { mc_task_id: string, new_status: string }
 */
export async function POST(request: NextRequest) {
  const userId = await getRequestUserId(request);
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: { mc_task_id?: string; new_status?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { mc_task_id, new_status } = body;
  if (!mc_task_id || !new_status) {
    return NextResponse.json(
      { error: 'mc_task_id and new_status are required' },
      { status: 400 }
    );
  }

  const VALID_MC_STATUSES = new Set([
    'inbox', 'in_progress', 'review', 'done', 'cancelled',
  ]);
  if (!VALID_MC_STATUSES.has(new_status)) {
    return NextResponse.json(
      { error: `Invalid MC status: ${new_status}` },
      { status: 400 }
    );
  }

  try {
    const result = await syncMCStatusToAgentTask(mc_task_id, new_status, userId);

    if (!result.synced && result.error === 'no_linked_task') {
      // MC-only board task with no agent_task counterpart — not an error
      return NextResponse.json(
        { synced: false, error: 'no_linked_task', mc_task_id },
        { status: 200 }
      );
    }

    if (!result.synced && result.error === 'not_found_or_forbidden') {
      return NextResponse.json(
        { synced: false, error: 'not_found_or_forbidden', mc_task_id },
        { status: 403 }
      );
    }

    return NextResponse.json({
      synced: result.synced,
      mc_task_id,
      new_status,
      agent_task_id: result.agent_task_id,
      ...(result.error ? { error: result.error } : {}),
    });
  } catch (err) {
    console.error('[task-sync route] Error:', err);
    return NextResponse.json({ error: 'Sync failed' }, { status: 500 });
  }
}
