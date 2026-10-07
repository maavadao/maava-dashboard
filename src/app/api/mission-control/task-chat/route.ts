import { NextRequest, NextResponse } from 'next/server';
import { getRequestUserId } from '@/lib/auth';
import pool from '@/lib/db';

/**
 * GET /api/mission-control/task-chat?mc_task_id=<uuid>
 *
 * Looks up the conversation_id linked to an MC board task via the
 * agent_tasks bridge table. Returns { conversation_id } if found.
 */
export async function GET(request: NextRequest) {
  const userId = await getRequestUserId(request);
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const mcTaskId = request.nextUrl.searchParams.get('mc_task_id');
  if (!mcTaskId) {
    return NextResponse.json(
      { error: 'mc_task_id query parameter is required' },
      { status: 400 },
    );
  }

  try {
    // First check the agent_tasks bridge (long-running agent tasks created
    // via CREATE_TASK action blocks).
    const { rows } = await pool.query(
      `SELECT conversation_id FROM agent_tasks
       WHERE mc_task_id = $1 AND user_id = $2
       LIMIT 1`,
      [mcTaskId, userId],
    );

    if (rows.length > 0 && rows[0].conversation_id) {
      return NextResponse.json({ conversation_id: rows[0].conversation_id });
    }

    // Fall back to the conversation-level link (every chat conversation
    // is mirrored to MC, not just agent tasks). This is what makes the
    // "Open in chat" action work for ALL task types.
    const { rows: convRows } = await pool.query(
      `SELECT id FROM conversations
       WHERE mc_task_id = $1 AND user_id = $2
       LIMIT 1`,
      [mcTaskId, userId],
    );

    if (convRows.length > 0) {
      return NextResponse.json({ conversation_id: convRows[0].id });
    }

    return NextResponse.json({ conversation_id: null });
  } catch (err) {
    console.error('[task-chat route] Error:', err);
    return NextResponse.json({ error: 'Lookup failed' }, { status: 500 });
  }
}
