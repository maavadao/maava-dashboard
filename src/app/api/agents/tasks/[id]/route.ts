import { NextRequest, NextResponse } from 'next/server';
import pool from '@/lib/db';
import { getRequestUserId } from '@/lib/auth';
import { syncAgentStatusToMC } from '@/lib/task-sync';

const ALLOWED_STATUSES = new Set(['cancelled', 'pending', 'running', 'completed']);
const ALLOWED_STATUSES_LIST = 'cancelled, pending, running, completed';

/**
 * PATCH /api/agents/tasks/[id]
 * Update the status of an agent task.
 * Allowed transitions:
 *   pending   → cancelled
 *   running   → cancelled
 *   failed    → pending  (retry)
 *   cancelled → pending  (re-queue)
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const userId = await getRequestUserId(request);
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const taskId = params.id;

  let body: { status?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const newStatus = body.status;
  if (!newStatus || !ALLOWED_STATUSES.has(newStatus)) {
    return NextResponse.json(
      { error: `Invalid status. Allowed: ${ALLOWED_STATUSES_LIST}` },
      { status: 400 }
    );
  }

  try {
    // Fetch task — must belong to this user
    const { rows: existing } = await pool.query(
      `SELECT id, status FROM agent_tasks WHERE id = $1 AND user_id = $2`,
      [taskId, userId]
    );

    if (existing.length === 0) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    const currentStatus: string = existing[0].status;

    // Validate allowed transitions
    const validTransitions: Record<string, string[]> = {
      pending: ['running', 'cancelled'],
      running: ['completed', 'cancelled'],
      failed: ['pending'],
      cancelled: ['pending'],
      completed: [], // terminal state
    };
    const allowed = validTransitions[currentStatus] ?? [];
    if (!allowed.includes(newStatus)) {
      return NextResponse.json(
        { error: `Cannot transition from '${currentStatus}' to '${newStatus}'` },
        { status: 422 }
      );
    }

    const extraFields =
      newStatus === 'running'
        ? ', started_at = COALESCE(started_at, NOW())'
        : newStatus === 'completed'
        ? ', completed_at = NOW(), progress = 100'
        : newStatus === 'pending'
        ? ', error = NULL, result = NULL, progress = 0, started_at = NULL, completed_at = NULL'
        : newStatus === 'cancelled'
        ? ', completed_at = NOW()'
        : '';

    const { rows } = await pool.query(
      `UPDATE agent_tasks
          SET status = $1, updated_at = NOW()${extraFields}
        WHERE id = $2 AND user_id = $3
        RETURNING *`,
      [newStatus, taskId, userId]
    );

    // Sync status change to Mission Control board task (non-blocking)
    syncAgentStatusToMC(userId, taskId, newStatus)
      .catch((err) => console.error('[task-sync] MC sync failed on PATCH:', err));

    return NextResponse.json({ task: rows[0] });
  } catch (err) {
    console.error('Update task error:', err);
    return NextResponse.json({ error: 'Failed to update task' }, { status: 500 });
  }
}

/**
 * DELETE /api/agents/tasks/[id]
 * Hard-delete a completed, failed, or cancelled task.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const userId = await getRequestUserId(request);
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const taskId = params.id;

  try {
    const { rowCount } = await pool.query(
      `DELETE FROM agent_tasks
        WHERE id = $1 AND user_id = $2
          AND status IN ('completed', 'failed', 'cancelled')`,
      [taskId, userId]
    );

    if (!rowCount) {
      return NextResponse.json(
        { error: 'Task not found or cannot be deleted in its current state' },
        { status: 404 }
      );
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('Delete task error:', err);
    return NextResponse.json({ error: 'Failed to delete task' }, { status: 500 });
  }
}
