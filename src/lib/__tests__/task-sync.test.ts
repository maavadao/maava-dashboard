/**
 * Tests for task-sync.ts — status mappings, ownership enforcement,
 * sync_version concurrency, and seller board creation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock pg pool ─────────────────────────────────────────────────────────────
const mockQuery = vi.fn();
vi.mock('@/lib/db', () => ({
  default: { query: (...args: unknown[]) => mockQuery(...args) },
}));

// ── Mock global fetch (MC backend calls) ─────────────────────────────────────
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// ── Import after mocks are in place ──────────────────────────────────────────
import {
  agentStatusToMC,
  mcStatusToAgent,
  syncMCStatusToAgentTask,
  getDefaultBoard,
  createMCTaskFromAgentTask,
  getOrCreateSellerBoard,
} from '@/lib/task-sync';

beforeEach(() => {
  vi.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. Status mapping tests
// ─────────────────────────────────────────────────────────────────────────────
describe('agentStatusToMC', () => {
  it('maps pending → inbox', () => {
    expect(agentStatusToMC('pending')).toBe('inbox');
  });
  it('maps running → in_progress', () => {
    expect(agentStatusToMC('running')).toBe('in_progress');
  });
  it('maps completed → done', () => {
    expect(agentStatusToMC('completed')).toBe('done');
  });
  it('maps cancelled → cancelled', () => {
    expect(agentStatusToMC('cancelled')).toBe('cancelled');
  });
  it('maps unknown status → inbox (fallback)', () => {
    expect(agentStatusToMC('banana')).toBe('inbox');
  });
});

describe('mcStatusToAgent', () => {
  it('maps inbox → pending', () => {
    expect(mcStatusToAgent('inbox')).toBe('pending');
  });
  it('maps in_progress → running', () => {
    expect(mcStatusToAgent('in_progress')).toBe('running');
  });
  it('maps review → pending (NOT running — human gate)', () => {
    expect(mcStatusToAgent('review')).toBe('pending');
  });
  it('maps done → completed', () => {
    expect(mcStatusToAgent('done')).toBe('completed');
  });
  it('maps cancelled → cancelled', () => {
    expect(mcStatusToAgent('cancelled')).toBe('cancelled');
  });
  it('maps unknown → pending (fallback)', () => {
    expect(mcStatusToAgent('xyz')).toBe('pending');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. syncMCStatusToAgentTask — ownership, concurrency, idempotency
// ─────────────────────────────────────────────────────────────────────────────
describe('syncMCStatusToAgentTask', () => {
  const userId = 'user-123';
  const mcTaskId = 'mc-task-abc';

  it('returns not_found_or_forbidden when no matching row (ownership check)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await syncMCStatusToAgentTask(mcTaskId, 'in_progress', userId);

    expect(result.synced).toBe(false);
    expect(result.error).toBe('not_found_or_forbidden');

    // Verify the query enforces user_id
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain('user_id = $2');
    expect(mockQuery.mock.calls[0][1]).toEqual([mcTaskId, userId]);
  });

  it('skips write when already at target status (idempotent)', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'task-1', status: 'running', sync_version: 3 }],
    });

    const result = await syncMCStatusToAgentTask(mcTaskId, 'in_progress', userId);

    expect(result.synced).toBe(true);
    expect(result.agent_task_id).toBe('task-1');
    // Only 1 query (SELECT) — no UPDATE
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('updates status and bumps sync_version on success', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ id: 'task-1', status: 'pending', sync_version: 0 }],
      })
      .mockResolvedValueOnce({ rowCount: 1 });

    const result = await syncMCStatusToAgentTask(mcTaskId, 'in_progress', userId);

    expect(result.synced).toBe(true);
    expect(result.agent_task_id).toBe('task-1');

    // Verify UPDATE uses sync_version for optimistic concurrency
    const updateSql = mockQuery.mock.calls[1][0] as string;
    expect(updateSql).toContain('sync_version = COALESCE(sync_version, 0) + 1');
    expect(updateSql).toContain('COALESCE(sync_version, 0) = $3');
    // params: [agentStatus, taskId, syncVersion]
    expect(mockQuery.mock.calls[1][1]).toEqual(['running', 'task-1', 0]);
  });

  it('returns version_conflict when concurrent write wins', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ id: 'task-1', status: 'pending', sync_version: 5 }],
      })
      .mockResolvedValueOnce({ rowCount: 0 }); // no rows updated — version mismatch

    const result = await syncMCStatusToAgentTask(mcTaskId, 'done', userId);

    expect(result.synced).toBe(false);
    expect(result.error).toBe('version_conflict');
    expect(result.agent_task_id).toBe('task-1');
  });

  it('returns db_error when query throws', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ id: 'task-1', status: 'pending', sync_version: 0 }],
      })
      .mockRejectedValueOnce(new Error('connection reset'));

    const result = await syncMCStatusToAgentTask(mcTaskId, 'in_progress', userId);

    expect(result.synced).toBe(false);
    expect(result.error).toBe('db_error');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. getDefaultBoard — fetch existing or auto-create
// ─────────────────────────────────────────────────────────────────────────────
describe('getDefaultBoard', () => {
  it('returns existing board when available', async () => {
    const board = { id: 'board-1', name: 'My Board', slug: 'my-board' };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ items: [board], total: 1 }),
      text: async () => '',
    });

    const result = await getDefaultBoard('user-1');

    expect(result).toEqual(board);
    // Should have called /boards?limit=1
    expect(mockFetch.mock.calls[0][0]).toContain('/boards?limit=1');
  });

  it('creates a board when none exist', async () => {
    const created = { id: 'board-new', name: 'Default Board', slug: 'default-board' };
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ items: [], total: 0 }),
        text: async () => '',
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => created,
        text: async () => '',
      });

    const result = await getDefaultBoard('user-1');

    expect(result).toEqual(created);
    // Second call should be POST /boards
    expect(mockFetch.mock.calls[1][1]?.method).toBe('POST');
  });

  it('returns null when MC backend is unreachable', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const result = await getDefaultBoard('user-1');

    expect(result).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. getOrCreateSellerBoard — seller-scoped board
// ─────────────────────────────────────────────────────────────────────────────
describe('getOrCreateSellerBoard', () => {
  it('returns existing seller-* board when found', async () => {
    const sellerBoard = { id: 'b-seller', name: 'Seller Ops', slug: 'seller-abc12345' };
    const otherBoard = { id: 'b-other', name: 'Default', slug: 'default-board' };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ items: [otherBoard, sellerBoard], total: 2 }),
      text: async () => '',
    });

    const result = await getOrCreateSellerBoard('user-abc12345678', 'Cool Shop');

    expect(result).toEqual(sellerBoard);
    // No POST — found existing
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('creates seller board with custom name when none exists', async () => {
    const created = {
      id: 'b-new-seller',
      name: 'Seller Operations: Cool Shop',
      slug: 'seller-user-abc',
    };
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ items: [{ id: 'b-1', name: 'Default', slug: 'default-board' }], total: 1 }),
        text: async () => '',
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => created,
        text: async () => '',
      });

    const result = await getOrCreateSellerBoard('user-abc12345', 'Cool Shop');

    expect(result).toEqual(created);
    // Verify POST body
    const postBody = JSON.parse(mockFetch.mock.calls[1][1]?.body as string);
    expect(postBody.name).toBe('Seller Operations: Cool Shop');
    expect(postBody.slug).toBe('seller-user-abc');
    expect(postBody.board_type).toBe('kanban');
  });

  it('creates generic seller board when sellerName not provided', async () => {
    const created = { id: 'b-x', name: 'Seller Operations', slug: 'seller-user-abc' };
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ items: [], total: 0 }),
        text: async () => '',
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => created,
        text: async () => '',
      });

    const result = await getOrCreateSellerBoard('user-abc12345');

    expect(result).toEqual(created);
    const postBody = JSON.parse(mockFetch.mock.calls[1][1]?.body as string);
    expect(postBody.name).toBe('Seller Operations');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. createMCTaskFromAgentTask — end-to-end sync flow
// ─────────────────────────────────────────────────────────────────────────────
describe('createMCTaskFromAgentTask', () => {
  it('creates MC task and stores link in agent_tasks', async () => {
    const board = { id: 'board-1', name: 'Default', slug: 'default-board' };
    const mcTask = { id: 'mc-task-1', board_id: 'board-1', status: 'inbox', title: 'Do something' };

    // getDefaultBoard → GET /boards (returns board)
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ items: [board], total: 1 }),
      text: async () => '',
    });
    // POST /boards/{id}/tasks
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => mcTask,
      text: async () => '',
    });
    // UPDATE agent_tasks SET mc_task_id...
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });

    const result = await createMCTaskFromAgentTask('user-1', 'agent-task-1', 'Do something');

    expect(result).toEqual({ mcTaskId: 'mc-task-1', mcBoardId: 'board-1' });
    // Verify mc link was stored
    const updateSql = mockQuery.mock.calls[0][0] as string;
    expect(updateSql).toContain('mc_task_id');
    expect(mockQuery.mock.calls[0][1]).toEqual(['mc-task-1', 'board-1', 'agent-task-1']);
  });

  it('truncates long task prompts to 200 chars', async () => {
    const longPrompt = 'A'.repeat(300);
    const board = { id: 'board-1', name: 'Default', slug: 'default-board' };

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ items: [board], total: 1 }),
      text: async () => '',
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 'mc-1', board_id: 'board-1', status: 'inbox', title: 'x' }),
      text: async () => '',
    });
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });

    await createMCTaskFromAgentTask('user-1', 'at-1', longPrompt);

    // Verify title was truncated in the POST body
    const postBody = JSON.parse(mockFetch.mock.calls[1][1]?.body as string);
    expect(postBody.title.length).toBe(200);
    expect(postBody.title.endsWith('...')).toBe(true);
  });

  it('returns null when MC backend is down', async () => {
    // getDefaultBoard fails
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const result = await createMCTaskFromAgentTask('user-1', 'at-1', 'test');

    expect(result).toBeNull();
  });
});
