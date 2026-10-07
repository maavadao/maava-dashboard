/**
 * Task Sync — bidirectional bridge between agent_tasks (Main DB) and
 * Mission Control board tasks (MC backend).
 *
 * Status mappings:
 *   agent_tasks → MC:  pending→inbox, running→in_progress, completed→done, cancelled→cancelled
 *   MC → agent_tasks:  inbox→pending, in_progress→running, review→pending, done→completed, cancelled→cancelled
 *
 * Key invariants:
 *   - All MC→agent_task sync writes require userId for ownership enforcement (P0 security)
 *   - Sync writes use sync_version for optimistic concurrency (P1 idempotency)
 *   - review maps to pending (human gate: agent must stop, not keep running)
 */

import pool from '@/lib/db';

const MC_BACKEND_URL = process.env.MISSION_CONTROL_API_URL || 'http://localhost:8000';
const MC_AUTH_TOKEN = process.env.MISSION_CONTROL_AUTH_TOKEN || '';

// ── Structured logging ───────────────────────────────────────────────────────

function syncLog(level: 'info' | 'warn' | 'error', data: Record<string, unknown>) {
  const entry = {
    component: 'task-sync',
    timestamp: new Date().toISOString(),
    level,
    ...data,
  };
  if (level === 'error') console.error(JSON.stringify(entry));
  else if (level === 'warn') console.warn(JSON.stringify(entry));
  else console.log(JSON.stringify(entry));
}

// ── Sync result type ─────────────────────────────────────────────────────────

export interface SyncResult {
  synced: boolean;
  error?: 'not_found_or_forbidden' | 'version_conflict' | 'db_error' | 'no_linked_task';
  agent_task_id?: string;
}

// ── Status mappings ──────────────────────────────────────────────────────────

const AGENT_TO_MC_STATUS: Record<string, string> = {
  pending: 'inbox',
  running: 'in_progress',
  completed: 'done',
  failed: 'inbox', // failed tasks stay in inbox with an error note
  cancelled: 'cancelled',
};

const MC_TO_AGENT_STATUS: Record<string, string> = {
  inbox: 'pending',
  in_progress: 'running',
  review: 'pending',   // review = paused for human; agent must NOT be executing
  done: 'completed',
  cancelled: 'cancelled',
};

export function agentStatusToMC(agentStatus: string): string {
  return AGENT_TO_MC_STATUS[agentStatus] || 'inbox';
}

export function mcStatusToAgent(mcStatus: string): string {
  return MC_TO_AGENT_STATUS[mcStatus] || 'pending';
}

// ── MC Backend helpers ───────────────────────────────────────────────────────

async function mcBackendFetch<T>(
  path: string,
  userId: string,
  init?: RequestInit
): Promise<T | null> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'X-Forwarded-User-Id': userId,
  };
  if (MC_AUTH_TOKEN) {
    headers['Authorization'] = `Bearer ${MC_AUTH_TOKEN}`;
  }

  try {
    const res = await fetch(`${MC_BACKEND_URL}/api/v1${path}`, {
      ...init,
      headers: { ...headers, ...init?.headers },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      console.error(`[task-sync] MC backend ${res.status}: ${text}`);
      return null;
    }
    return res.json() as Promise<T>;
  } catch (err) {
    console.error('[task-sync] MC backend unreachable:', err);
    return null;
  }
}

// ── Get or create a default board ────────────────────────────────────────────

interface MCBoardResponse {
  id: string;
  name: string;
  slug: string;
}

interface MCBoardsList {
  items: MCBoardResponse[];
  total: number;
}

/**
 * Retrieve the user's default MC board. If no boards exist, create one.
 */
export async function getDefaultBoard(userId: string): Promise<MCBoardResponse | null> {
  const boards = await mcBackendFetch<MCBoardsList>('/boards?limit=1', userId);
  if (boards && boards.items.length > 0) {
    return boards.items[0];
  }

  // Auto-create a default board
  const created = await mcBackendFetch<MCBoardResponse>('/boards', userId, {
    method: 'POST',
    body: JSON.stringify({
      name: 'Default Board',
      slug: 'default-board',
      description: 'Auto-created board for task management',
      board_type: 'kanban',
    }),
  });
  return created;
}

// ── Create MC task from agent_task ───────────────────────────────────────────

interface MCTaskResponse {
  id: string;
  board_id: string;
  status: string;
  title: string;
}

/**
 * Create a corresponding MC board task for an agent_task.
 * Returns the MC task ID if successful.
 */
export async function createMCTaskFromAgentTask(
  userId: string,
  agentTaskId: string,
  taskPrompt: string,
  agentName?: string
): Promise<{ mcTaskId: string; mcBoardId: string } | null> {
  const board = await getDefaultBoard(userId);
  if (!board) {
    console.error('[task-sync] Could not find or create default board');
    return null;
  }

  const title = taskPrompt.length > 200
    ? taskPrompt.substring(0, 197) + '...'
    : taskPrompt;

  const mcTask = await mcBackendFetch<MCTaskResponse>(
    `/boards/${encodeURIComponent(board.id)}/tasks`,
    userId,
    {
      method: 'POST',
      body: JSON.stringify({
        title,
        description: taskPrompt,
        status: 'inbox',
        priority: 'medium',
      }),
    }
  );

  if (!mcTask) {
    console.error('[task-sync] Failed to create MC task');
    return null;
  }

  // Store the MC link in agent_tasks
  try {
    await pool.query(
      `UPDATE agent_tasks SET mc_task_id = $1, mc_board_id = $2, updated_at = NOW()
       WHERE id = $3`,
      [mcTask.id, board.id, agentTaskId]
    );
  } catch (err) {
    syncLog('error', {
      operation: 'createMCTaskFromAgentTask',
      agent_task_id: agentTaskId,
      mc_task_id: mcTask.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return { mcTaskId: mcTask.id, mcBoardId: board.id };
}

// ── Sync agent_task status → MC task ─────────────────────────────────────────

/**
 * When an agent_task status changes, push the update to the MC board task.
 */
export async function syncAgentStatusToMC(
  userId: string,
  agentTaskId: string,
  newAgentStatus: string,
  errorMessage?: string
): Promise<boolean> {
  // Look up the MC link
  const { rows } = await pool.query(
    `SELECT mc_task_id, mc_board_id FROM agent_tasks WHERE id = $1`,
    [agentTaskId]
  );
  if (rows.length === 0 || !rows[0].mc_task_id || !rows[0].mc_board_id) {
    return false; // No MC link — nothing to sync
  }

  const { mc_task_id, mc_board_id } = rows[0];
  const mcStatus = agentStatusToMC(newAgentStatus);

  const updatePayload: Record<string, unknown> = { status: mcStatus };

  // If the agent task failed, add a comment with the error
  if (newAgentStatus === 'failed' && errorMessage) {
    // First update status, then add comment
    await mcBackendFetch(
      `/boards/${encodeURIComponent(mc_board_id)}/tasks/${encodeURIComponent(mc_task_id)}/comments`,
      userId,
      {
        method: 'POST',
        body: JSON.stringify({
          content: `⚠️ Task failed: ${errorMessage}`,
        }),
      }
    );
  }

  const result = await mcBackendFetch(
    `/boards/${encodeURIComponent(mc_board_id)}/tasks/${encodeURIComponent(mc_task_id)}`,
    userId,
    {
      method: 'PATCH',
      body: JSON.stringify(updatePayload),
    }
  );

  return result !== null;
}

// ── Sync MC task status → agent_task ─────────────────────────────────────────

/**
 * When an MC board task status changes (e.g. manual drag on kanban),
 * push the mapped status back to the agent_task.
 *
 * SECURITY: userId is required and enforced — only the owner of the
 * agent_task can mutate it via this sync path.
 *
 * IDEMPOTENCY: Uses sync_version for optimistic concurrency.
 * If the row has been modified since we read it, we return version_conflict
 * rather than overwriting.
 */
export async function syncMCStatusToAgentTask(
  mcTaskId: string,
  newMCStatus: string,
  userId: string
): Promise<SyncResult> {
  const agentStatus = mcStatusToAgent(newMCStatus);

  // Look up the agent_task by MC task ID — ownership enforced via user_id
  const { rows } = await pool.query(
    `SELECT id, status, COALESCE(sync_version, 0) AS sync_version
     FROM agent_tasks
     WHERE mc_task_id = $1 AND user_id = $2`,
    [mcTaskId, userId]
  );

  if (rows.length === 0) {
    // Distinguish: is the mc_task_id simply not linked (MC-only task) vs. forbidden?
    const { rows: anyRows } = await pool.query(
      `SELECT id FROM agent_tasks WHERE mc_task_id = $1 LIMIT 1`,
      [mcTaskId]
    );
    if (anyRows.length === 0) {
      // No agent_task has this mc_task_id — it's an MC-only board task, not an error
      syncLog('info', {
        operation: 'syncMCStatusToAgentTask',
        mc_task_id: mcTaskId,
        result: 'no_linked_task',
      });
      return { synced: false, error: 'no_linked_task' };
    }
    // Row exists but belongs to a different user
    syncLog('warn', {
      operation: 'syncMCStatusToAgentTask',
      mc_task_id: mcTaskId,
      user_id: userId,
      result: 'not_found_or_forbidden',
    });
    return { synced: false, error: 'not_found_or_forbidden' };
  }

  const current = rows[0];

  // Idempotent: if already at target status, skip the write
  if (current.status === agentStatus) {
    syncLog('info', {
      operation: 'syncMCStatusToAgentTask',
      mc_task_id: mcTaskId,
      agent_task_id: current.id,
      result: 'already_at_target',
      status: agentStatus,
    });
    return { synced: true, agent_task_id: current.id };
  }

  // Determine which fields to update based on new status
  let extraSql = '';
  if (agentStatus === 'running' && current.status === 'pending') {
    extraSql = ', started_at = NOW()';
  } else if (agentStatus === 'completed') {
    extraSql = ', completed_at = NOW(), progress = 100';
  } else if (agentStatus === 'pending' && ['failed', 'cancelled'].includes(current.status)) {
    // Retry/re-queue: clear error state
    extraSql = ', error = NULL, result = NULL, progress = 0, started_at = NULL, completed_at = NULL';
  } else if (agentStatus === 'cancelled') {
    extraSql = ', completed_at = NOW()';
  }

  try {
    const result = await pool.query(
      `UPDATE agent_tasks
       SET status = $1, updated_at = NOW(), sync_version = COALESCE(sync_version, 0) + 1${extraSql}
       WHERE id = $2 AND COALESCE(sync_version, 0) = $3`,
      [agentStatus, current.id, current.sync_version]
    );

    if (result.rowCount === 0) {
      // Another write won the race — expected, not an error
      syncLog('warn', {
        operation: 'syncMCStatusToAgentTask',
        mc_task_id: mcTaskId,
        agent_task_id: current.id,
        target_status: agentStatus,
        result: 'version_conflict',
        sync_version: current.sync_version,
      });
      return { synced: false, error: 'version_conflict', agent_task_id: current.id };
    }

    syncLog('info', {
      operation: 'syncMCStatusToAgentTask',
      mc_task_id: mcTaskId,
      agent_task_id: current.id,
      old_status: current.status,
      new_status: agentStatus,
      mc_status: newMCStatus,
      sync_version: current.sync_version + 1,
    });
    return { synced: true, agent_task_id: current.id };
  } catch (err) {
    syncLog('error', {
      operation: 'syncMCStatusToAgentTask',
      mc_task_id: mcTaskId,
      agent_task_id: current.id,
      target_status: agentStatus,
      error: err instanceof Error ? err.message : String(err),
      sync_version: current.sync_version,
    });
    return { synced: false, error: 'db_error', agent_task_id: current.id };
  }
}

// ── Seller board helpers ─────────────────────────────────────────────────────

/**
 * Get or create a seller-specific MC board.
 * Prefers a board whose slug starts with "seller-"; falls back to getDefaultBoard
 * if no seller board exists and creates one with the seller's business name.
 */
export async function getOrCreateSellerBoard(
  userId: string,
  sellerName?: string
): Promise<MCBoardResponse | null> {
  // Fetch boards and look for a seller-scoped one
  const boards = await mcBackendFetch<MCBoardsList>('/boards?limit=50', userId);
  if (boards && boards.items.length > 0) {
    const sellerBoard = boards.items.find((b) => b.slug.startsWith('seller-'));
    if (sellerBoard) return sellerBoard;
    // No seller board — fall through to create
  }

  const boardName = sellerName
    ? `Seller Operations: ${sellerName}`
    : 'Seller Operations';
  const slug = `seller-${userId.substring(0, 8)}`;

  const created = await mcBackendFetch<MCBoardResponse>('/boards', userId, {
    method: 'POST',
    body: JSON.stringify({
      name: boardName,
      slug,
      description: `Operations board for ${sellerName || 'seller'}`,
      board_type: 'kanban',
    }),
  });

  if (created) {
    syncLog('info', {
      operation: 'getOrCreateSellerBoard',
      user_id: userId,
      board_id: created.id,
      board_name: boardName,
    });
  }

  return created;
}

// ── Conversation-level MC bridge ─────────────────────────────────────────────
//
// Every chat conversation gets a Mission Control task (regardless of task
// type — seller campaigns, plain chat, code help, anything). The MC task
// opens with the first user message ("in_progress") and closes when the
// assistant finishes responding ("done") or when the request errors
// ("cancelled"). This lets users see and re-enter every conversation from
// Mission Control via the existing "Open in chat" action on each task card.

let _convMcColsMigrated = false;
async function ensureConversationMCColumns(): Promise<void> {
  if (_convMcColsMigrated) return;
  try {
    await pool.query(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS mc_task_id UUID DEFAULT NULL`);
    await pool.query(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS mc_board_id UUID DEFAULT NULL`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_conversations_mc_task_id ON conversations(mc_task_id) WHERE mc_task_id IS NOT NULL`);
    _convMcColsMigrated = true;
  } catch (err) {
    syncLog('warn', {
      operation: 'ensureConversationMCColumns',
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Create (or reuse) a Mission Control task for a chat conversation.
 *
 * - Idempotent per conversation: if the conversation already has an
 *   `mc_task_id`, the existing link is returned and status is bumped to
 *   `in_progress` (covers follow-up turns in the same conversation).
 * - The task lives on the user's default board so every chat shows up in
 *   one consistent place users already know.
 *
 * Best-effort: never throws. Returns null when MC backend is unreachable.
 */
export async function startMCTaskForConversation(
  userId: string,
  conversationId: string,
  prompt: string
): Promise<{ mcTaskId: string; mcBoardId: string } | null> {
  if (!userId || !conversationId) return null;

  await ensureConversationMCColumns();

  // Check for an existing link
  try {
    const { rows } = await pool.query(
      `SELECT mc_task_id, mc_board_id FROM conversations WHERE id = $1 AND user_id = $2`,
      [conversationId, userId]
    );
    if (rows.length > 0 && rows[0].mc_task_id && rows[0].mc_board_id) {
      const mcTaskId = rows[0].mc_task_id as string;
      const mcBoardId = rows[0].mc_board_id as string;
      // Re-open the task — a follow-up message means activity is back in progress
      await mcBackendFetch(
        `/boards/${encodeURIComponent(mcBoardId)}/tasks/${encodeURIComponent(mcTaskId)}`,
        userId,
        { method: 'PATCH', body: JSON.stringify({ status: 'in_progress' }) }
      );
      return { mcTaskId, mcBoardId };
    }
  } catch (err) {
    syncLog('warn', {
      operation: 'startMCTaskForConversation.lookup',
      conversation_id: conversationId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const board = await getDefaultBoard(userId);
  if (!board) return null;

  const trimmed = (prompt || '').trim();
  const title = trimmed.length === 0
    ? 'New chat'
    : trimmed.length > 200 ? trimmed.substring(0, 197) + '...' : trimmed;

  const mcTask = await mcBackendFetch<MCTaskResponse>(
    `/boards/${encodeURIComponent(board.id)}/tasks`,
    userId,
    {
      method: 'POST',
      body: JSON.stringify({
        title,
        description: trimmed,
        status: 'in_progress',
        priority: 'medium',
      }),
    }
  );

  if (!mcTask) return null;

  // Persist the link so future turns reuse it and MC → chat lookup works.
  try {
    await pool.query(
      `UPDATE conversations
         SET mc_task_id = $1, mc_board_id = $2, updated_at = NOW()
       WHERE id = $3 AND user_id = $4`,
      [mcTask.id, board.id, conversationId, userId]
    );
  } catch (err) {
    syncLog('warn', {
      operation: 'startMCTaskForConversation.persist',
      conversation_id: conversationId,
      mc_task_id: mcTask.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  syncLog('info', {
    operation: 'startMCTaskForConversation',
    conversation_id: conversationId,
    mc_task_id: mcTask.id,
    mc_board_id: board.id,
  });
  return { mcTaskId: mcTask.id, mcBoardId: board.id };
}

/**
 * Mark a conversation's MC task as finished (`done`) or aborted
 * (`cancelled`). Best-effort — never throws.
 */
export async function finishMCTaskForConversation(
  userId: string,
  conversationId: string,
  outcome: 'done' | 'cancelled' = 'done',
  errorMessage?: string
): Promise<void> {
  if (!userId || !conversationId) return;
  try {
    const { rows } = await pool.query(
      `SELECT mc_task_id, mc_board_id FROM conversations WHERE id = $1 AND user_id = $2`,
      [conversationId, userId]
    );
    if (rows.length === 0 || !rows[0].mc_task_id || !rows[0].mc_board_id) return;
    const mcTaskId = rows[0].mc_task_id as string;
    const mcBoardId = rows[0].mc_board_id as string;

    if (outcome === 'cancelled' && errorMessage) {
      await mcBackendFetch(
        `/boards/${encodeURIComponent(mcBoardId)}/tasks/${encodeURIComponent(mcTaskId)}/comments`,
        userId,
        { method: 'POST', body: JSON.stringify({ content: `⚠️ ${errorMessage}` }) }
      );
    }

    await mcBackendFetch(
      `/boards/${encodeURIComponent(mcBoardId)}/tasks/${encodeURIComponent(mcTaskId)}`,
      userId,
      { method: 'PATCH', body: JSON.stringify({ status: outcome }) }
    );
  } catch (err) {
    syncLog('warn', {
      operation: 'finishMCTaskForConversation',
      conversation_id: conversationId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
