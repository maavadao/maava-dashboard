import {
  useQuery,
  useMutation,
  useQueryClient,
  type UseQueryOptions,
} from '@tanstack/react-query';
import {
  mcListBoards,
  mcGetBoard,
  mcCreateBoard,
  mcUpdateBoard,
  mcDeleteBoard,
  mcListAgents,
  mcListApprovals,
  mcListActivity,
  mcListTasks,
  mcBootstrap,
} from '@/lib/mission-control/api';
import type {
  MCBoard,
  MCAgent,
  MCApproval,
  MCActivityEvent,
  MCTask,
  MCPaginatedResponse,
  MCBoardCreate,
  MCUser,
} from '@/lib/mission-control/types';

// ── Query Keys ───────────────────────────────────────────────────────────────

export const mcKeys = {
  all: ['mc'] as const,
  bootstrap: () => [...mcKeys.all, 'bootstrap'] as const,
  boards: () => [...mcKeys.all, 'boards'] as const,
  boardsList: (params?: { limit?: number; offset?: number }) =>
    [...mcKeys.boards(), 'list', params] as const,
  board: (id: string) => [...mcKeys.boards(), id] as const,
  agents: () => [...mcKeys.all, 'agents'] as const,
  agentsList: (params?: { limit?: number; offset?: number; board_id?: string }) =>
    [...mcKeys.agents(), 'list', params] as const,
  approvals: (boardId: string) => [...mcKeys.all, 'approvals', boardId] as const,
  activity: (params?: { board_id?: string; limit?: number; offset?: number }) =>
    [...mcKeys.all, 'activity', params] as const,
  tasks: (boardId: string) => [...mcKeys.all, 'tasks', boardId] as const,
};

// ── Bootstrap ────────────────────────────────────────────────────────────────

export function useMCBootstrap(
  opts?: Omit<UseQueryOptions<MCUser>, 'queryKey' | 'queryFn'>
) {
  return useQuery({
    queryKey: mcKeys.bootstrap(),
    queryFn: () => mcBootstrap(),
    staleTime: 5 * 60 * 1000,
    ...opts,
  });
}

// ── Boards ───────────────────────────────────────────────────────────────────

export function useMCBoards(
  params?: { limit?: number; offset?: number },
  opts?: Omit<UseQueryOptions<MCPaginatedResponse<MCBoard>>, 'queryKey' | 'queryFn'>
) {
  return useQuery({
    queryKey: mcKeys.boardsList(params),
    queryFn: () => mcListBoards(params),
    ...opts,
  });
}

export function useMCBoard(
  boardId: string,
  opts?: Omit<UseQueryOptions<MCBoard>, 'queryKey' | 'queryFn'>
) {
  return useQuery({
    queryKey: mcKeys.board(boardId),
    queryFn: () => mcGetBoard(boardId),
    enabled: !!boardId,
    ...opts,
  });
}

export function useCreateMCBoard() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: MCBoardCreate) => mcCreateBoard(data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: mcKeys.boards() });
    },
  });
}

export function useUpdateMCBoard() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ boardId, data }: { boardId: string; data: Partial<MCBoardCreate> }) =>
      mcUpdateBoard(boardId, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: mcKeys.boards() });
    },
  });
}

export function useDeleteMCBoard() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (boardId: string) => mcDeleteBoard(boardId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: mcKeys.boards() });
    },
  });
}

// ── Agents ───────────────────────────────────────────────────────────────────

export function useMCAgents(
  params?: { limit?: number; offset?: number; board_id?: string },
  opts?: Omit<UseQueryOptions<MCPaginatedResponse<MCAgent>>, 'queryKey' | 'queryFn'>
) {
  return useQuery({
    queryKey: mcKeys.agentsList(params),
    queryFn: () => mcListAgents(params),
    ...opts,
  });
}

// ── Approvals ────────────────────────────────────────────────────────────────

export function useMCApprovals(
  boardId: string,
  params?: { status?: string },
  opts?: Omit<UseQueryOptions<MCPaginatedResponse<MCApproval>>, 'queryKey' | 'queryFn'>
) {
  return useQuery({
    queryKey: mcKeys.approvals(boardId),
    queryFn: () => mcListApprovals(boardId, params),
    enabled: !!boardId,
    ...opts,
  });
}

// ── Activity ─────────────────────────────────────────────────────────────────

export function useMCActivity(
  params?: { board_id?: string; limit?: number; offset?: number },
  opts?: Omit<UseQueryOptions<MCPaginatedResponse<MCActivityEvent>>, 'queryKey' | 'queryFn'>
) {
  return useQuery({
    queryKey: mcKeys.activity(params),
    queryFn: () => mcListActivity(params),
    ...opts,
  });
}

// ── Tasks ────────────────────────────────────────────────────────────────────

export function useMCTasks(
  boardId: string,
  params?: { limit?: number; offset?: number; status?: string },
  opts?: Omit<UseQueryOptions<MCPaginatedResponse<MCTask>>, 'queryKey' | 'queryFn'>
) {
  return useQuery({
    queryKey: mcKeys.tasks(boardId),
    queryFn: () => mcListTasks(boardId, params),
    enabled: !!boardId,
    ...opts,
  });
}
