// Mission Control API client — proxies through Next.js API routes
import type {
  MCBoard,
  MCBoardCreate,
  MCTask,
  MCTaskCreate,
  MCTaskUpdate,
  MCAgent,
  MCApproval,
  MCActivityEvent,
  MCPaginatedResponse,
  MCUser,
  MCTaskComment,
} from './types';

const MC_API_PREFIX = '/api/mission-control';

async function mcFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${MC_API_PREFIX}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`Mission Control API error ${res.status}: ${text}`);
  }
  return res.json();
}

// ── Auth / Bootstrap ─────────────────────────────────────────────────────────

export async function mcBootstrap(): Promise<MCUser> {
  return mcFetch<MCUser>('/auth/bootstrap', { method: 'POST' });
}

// ── Boards ───────────────────────────────────────────────────────────────────

export async function mcListBoards(params?: {
  limit?: number;
  offset?: number;
}): Promise<MCPaginatedResponse<MCBoard>> {
  const qs = new URLSearchParams();
  if (params?.limit) qs.set('limit', String(params.limit));
  if (params?.offset) qs.set('offset', String(params.offset));
  const q = qs.toString();
  return mcFetch<MCPaginatedResponse<MCBoard>>(`/boards${q ? `?${q}` : ''}`);
}

export async function mcGetBoard(boardId: string): Promise<MCBoard> {
  return mcFetch<MCBoard>(`/boards/${encodeURIComponent(boardId)}`);
}

export async function mcCreateBoard(data: MCBoardCreate): Promise<MCBoard> {
  return mcFetch<MCBoard>('/boards', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function mcUpdateBoard(
  boardId: string,
  data: Partial<MCBoardCreate>
): Promise<MCBoard> {
  return mcFetch<MCBoard>(`/boards/${encodeURIComponent(boardId)}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
}

export async function mcDeleteBoard(boardId: string): Promise<void> {
  await mcFetch<unknown>(`/boards/${encodeURIComponent(boardId)}`, {
    method: 'DELETE',
  });
}

// ── Tasks ────────────────────────────────────────────────────────────────────

export async function mcListTasks(
  boardId: string,
  params?: { limit?: number; offset?: number; status?: string }
): Promise<MCPaginatedResponse<MCTask>> {
  const qs = new URLSearchParams();
  if (params?.limit) qs.set('limit', String(params.limit));
  if (params?.offset) qs.set('offset', String(params.offset));
  if (params?.status) qs.set('status', params.status);
  const q = qs.toString();
  return mcFetch<MCPaginatedResponse<MCTask>>(
    `/boards/${encodeURIComponent(boardId)}/tasks${q ? `?${q}` : ''}`
  );
}

export async function mcGetTask(boardId: string, taskId: string): Promise<MCTask> {
  return mcFetch<MCTask>(
    `/boards/${encodeURIComponent(boardId)}/tasks/${encodeURIComponent(taskId)}`
  );
}

export async function mcCreateTask(boardId: string, data: MCTaskCreate): Promise<MCTask> {
  return mcFetch<MCTask>(`/boards/${encodeURIComponent(boardId)}/tasks`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function mcUpdateTask(
  boardId: string,
  taskId: string,
  data: MCTaskUpdate
): Promise<MCTask> {
  return mcFetch<MCTask>(
    `/boards/${encodeURIComponent(boardId)}/tasks/${encodeURIComponent(taskId)}`,
    {
      method: 'PATCH',
      body: JSON.stringify(data),
    }
  );
}

export async function mcDeleteTask(boardId: string, taskId: string): Promise<void> {
  await mcFetch<unknown>(
    `/boards/${encodeURIComponent(boardId)}/tasks/${encodeURIComponent(taskId)}`,
    { method: 'DELETE' }
  );
}

export async function mcAddTaskComment(
  boardId: string,
  taskId: string,
  content: string
): Promise<MCTaskComment> {
  return mcFetch<MCTaskComment>(
    `/boards/${encodeURIComponent(boardId)}/tasks/${encodeURIComponent(taskId)}/comments`,
    {
      method: 'POST',
      body: JSON.stringify({ content }),
    }
  );
}

// ── Agents ───────────────────────────────────────────────────────────────────

/**
 * Map an MC backend agent response into the shared MCAgent shape.
 * Fields that don't exist on the backend are set to safe defaults.
 */
function mapMCBackendAgent(raw: Record<string, unknown>): MCAgent {
  const id = String(raw.id ?? '');
  return {
    id,
    install_id: id,
    agent_id: id,
    slug: String(raw.name ?? '').toLowerCase().replace(/\s+/g, '-'),
    name: String(raw.name ?? 'Unnamed'),
    short_description: null,
    description: typeof raw.identity_template === 'string' ? raw.identity_template : null,
    category: null,
    developer: null,
    icon_url: null,
    verified: false,
    is_active: raw.status === 'active',
    installed_at: typeof raw.created_at === 'string' ? raw.created_at : new Date().toISOString(),
    last_used_at: typeof raw.last_seen_at === 'string' ? raw.last_seen_at : null,
    model: null,
    board_id: typeof raw.board_id === 'string' ? raw.board_id : null,
    gateway_id: typeof raw.gateway_id === 'string' ? raw.gateway_id : null,
    mc_status: typeof raw.status === 'string' ? raw.status : null,
    is_board_lead: raw.is_board_lead === true,
    is_gateway_main: raw.is_gateway_main === true,
    last_seen_at: typeof raw.last_seen_at === 'string' ? raw.last_seen_at : null,
    source: 'mc_backend',
  };
}

export async function mcListAgents(params?: {
  limit?: number;
  offset?: number;
  board_id?: string;
}): Promise<MCPaginatedResponse<MCAgent>> {
  const limit = params?.limit ?? 200;
  const offset = params?.offset ?? 0;

  // Try MC backend first
  try {
    const qs = new URLSearchParams();
    if (params?.limit) qs.set('limit', String(params.limit));
    if (params?.offset) qs.set('offset', String(params.offset));
    if (params?.board_id) qs.set('board_id', params.board_id);
    const q = qs.toString();
    const mcResult = await mcFetch<{ items: Record<string, unknown>[]; total: number; limit: number; offset: number }>(
      `/agents${q ? `?${q}` : ''}`
    );
    return {
      items: mcResult.items.map(mapMCBackendAgent),
      total: mcResult.total,
      limit: mcResult.limit,
      offset: mcResult.offset,
    };
  } catch {
    // MC backend unavailable — fall back to local installed agents
  }

  // Fallback: local DB shim
  const res = await fetch('/api/agents/installed');
  if (!res.ok) return { items: [], total: 0, limit, offset };
  const data = (await res.json()) as { agents?: MCAgent[] };
  const agents = (data.agents ?? []).map((a) => ({ ...a, source: 'local_db' as const }));
  const sliced = agents.slice(offset, offset + limit);
  return { items: sliced, total: agents.length, limit, offset };
}

// ── Approvals ────────────────────────────────────────────────────────────────

export async function mcListApprovals(
  boardId: string,
  params?: { status?: string }
): Promise<MCPaginatedResponse<MCApproval>> {
  const qs = new URLSearchParams();
  if (params?.status) qs.set('status', params.status);
  const q = qs.toString();
  return mcFetch<MCPaginatedResponse<MCApproval>>(
    `/boards/${encodeURIComponent(boardId)}/approvals${q ? `?${q}` : ''}`
  );
}

export async function mcApproveApproval(
  boardId: string,
  approvalId: string
): Promise<MCApproval> {
  return mcFetch<MCApproval>(
    `/boards/${encodeURIComponent(boardId)}/approvals/${encodeURIComponent(approvalId)}`,
    {
      method: 'PATCH',
      body: JSON.stringify({ status: 'approved' }),
    }
  );
}

export async function mcRejectApproval(
  boardId: string,
  approvalId: string,
  reason?: string
): Promise<MCApproval> {
  return mcFetch<MCApproval>(
    `/boards/${encodeURIComponent(boardId)}/approvals/${encodeURIComponent(approvalId)}`,
    {
      method: 'PATCH',
      body: JSON.stringify({ status: 'rejected', reason }),
    }
  );
}

// ── Activity ─────────────────────────────────────────────────────────────────

export async function mcListActivity(params?: {
  board_id?: string;
  limit?: number;
  offset?: number;
}): Promise<MCPaginatedResponse<MCActivityEvent>> {
  const qs = new URLSearchParams();
  if (params?.board_id) qs.set('board_id', params.board_id);
  if (params?.limit) qs.set('limit', String(params.limit));
  if (params?.offset) qs.set('offset', String(params.offset));
  const q = qs.toString();
  return mcFetch<MCPaginatedResponse<MCActivityEvent>>(`/activity${q ? `?${q}` : ''}`);
}


