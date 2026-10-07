import { NextRequest, NextResponse } from 'next/server';
import pool from '@/lib/db';
import { getRequestUserId } from '@/lib/auth';
import { createMCTaskFromAgentTask } from '@/lib/task-sync';

/**
 * GET /api/agents/tasks — list user's agent tasks
 * POST /api/agents/tasks — create a new task for an agent
 */

export async function GET(request: NextRequest) {
  const userId = await getRequestUserId(request);
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const status = request.nextUrl.searchParams.get('status');

  try {
    let query = `
      SELECT t.*, ma.name as agent_name, ma.slug as agent_slug, ma.category as agent_category
      FROM agent_tasks t
      JOIN marketplace_agents ma ON ma.id = t.agent_id
      WHERE t.user_id = $1
    `;
    const params: (string | null)[] = [userId];

    if (status) {
      query += ` AND t.status = $2`;
      params.push(status);
    }

    query += ` ORDER BY t.created_at DESC LIMIT 50`;

    const { rows } = await pool.query(query, params);
    return NextResponse.json({ tasks: rows });
  } catch (err) {
    console.error('List tasks error:', err);
    return NextResponse.json({ error: 'Failed to list tasks' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const userId = await getRequestUserId(request);
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: {
    agent_id: string;
    task_prompt: string;
    task_type?: string;
    conversation_id?: string;
    heartbeat_interval?: string;
    max_runtime_hours?: number;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  console.log(`[api/tasks] POST create task: userId=${userId} agent_id=${body.agent_id} type=${body.task_type || 'one-shot'} prompt="${(body.task_prompt || '').slice(0, 100)}"`);

  if (!body.agent_id || !body.task_prompt) {
    console.warn('[api/tasks] Missing required fields: agent_id or task_prompt');
    return NextResponse.json({ error: 'agent_id and task_prompt are required' }, { status: 400 });
  }

  try {
    const taskType = body.task_type || 'one-shot';
    const heartbeatInterval = taskType === 'recurring' ? (body.heartbeat_interval || '30m') : null;
    const maxHours = body.max_runtime_hours || 24;

    const { rows } = await pool.query(
      `INSERT INTO agent_tasks (
        user_id, agent_id, conversation_id, task_prompt, task_type,
        status, heartbeat_interval, max_runtime_hours
      ) VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7)
      RETURNING *`,
      [
        userId,
        body.agent_id,
        body.conversation_id || null,
        body.task_prompt,
        taskType,
        heartbeatInterval,
        maxHours,
      ]
    );

    const task = rows[0];

    // Sync to Mission Control board — create a corresponding MC task.
    // Awaited so the response includes the MC link and callers know if sync failed.
    let mcLink: { mcTaskId: string; mcBoardId: string } | null = null;
    let mcSyncError: string | null = null;
    try {
      mcLink = await createMCTaskFromAgentTask(userId, task.id, body.task_prompt);
      if (mcLink) {
        console.log(`[task-sync] Agent task ${task.id} → MC task ${mcLink.mcTaskId} on board ${mcLink.mcBoardId}`);
      }
    } catch (err) {
      mcSyncError = err instanceof Error ? err.message : 'Unknown MC sync error';
      console.error('[task-sync] MC sync failed:', err);
    }

    return NextResponse.json({
      task,
      mc_task_id: mcLink?.mcTaskId ?? null,
      mc_board_id: mcLink?.mcBoardId ?? null,
      mc_sync_warning: mcSyncError,
    }, { status: 201 });
  } catch (err) {
    console.error('Create task error:', err);
    return NextResponse.json({ error: 'Failed to create task' }, { status: 500 });
  }
}
