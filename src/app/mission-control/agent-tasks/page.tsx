'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { cn } from '@/lib/utils';
import { DashboardPageLayout } from '@/components/mc/templates/DashboardPageLayout';
import {
  DndContext,
  DragOverlay,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  useDroppable,
  useDraggable,
} from '@dnd-kit/core';
import type { DragStartEvent, DragEndEvent, DragOverEvent } from '@dnd-kit/core';
import {
  Bot,
  Clock,
  RotateCcw,
  X,
  Trash2,
  MessageSquare,
  ArrowLeft,
  RefreshCw,
  AlertCircle,
  Loader2,
  Inbox,
  Search,
  MoreHorizontal,
  SortAsc,
  SortDesc,
  Calendar,
} from 'lucide-react';

// ── Types ────────────────────────────────────────────────────────────────────

interface AgentTask {
  id: string;
  user_id: string;
  agent_id: string;
  conversation_id: string | null;
  task_prompt: string;
  task_type: 'one-shot' | 'recurring';
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  result: string | null;
  error: string | null;
  progress: number;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
  agent_name: string;
  agent_slug: string;
  agent_category: string;
}

type TaskStatus = AgentTask['status'];
type ViewMode = 'board' | 'list';
type SortField = 'created_at' | 'updated_at' | 'agent_name';
type SortDir = 'asc' | 'desc';

// ── Constants (matching MC board design) ─────────────────────────────────────

const COLUMNS: { key: TaskStatus; label: string; color: string }[] = [
  { key: 'pending',   label: 'Pending',     color: 'bg-gray-400' },
  { key: 'running',   label: 'In Progress', color: 'bg-yellow-400' },
  { key: 'completed', label: 'Done',        color: 'bg-green-500' },
  { key: 'failed',    label: 'Failed',      color: 'bg-red-500' },
  { key: 'cancelled', label: 'Cancelled',   color: 'bg-gray-300' },
];

const TYPE_STYLES: Record<string, string> = {
  'one-shot': 'text-blue-500',
  recurring:  'text-orange-500',
};

const TYPE_LABELS: Record<string, string> = {
  'one-shot': 'ONE-SHOT',
  recurring:  'RECURRING',
};

/** Which statuses a task can be dragged TO from its current status */
const DRAG_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  pending:   ['cancelled'],
  running:   ['cancelled'],
  completed: [],
  failed:    ['pending'],
  cancelled: ['pending'],
};

// ── API helpers ──────────────────────────────────────────────────────────────

async function fetchTasks(): Promise<AgentTask[]> {
  const res = await fetch('/api/agents/tasks');
  if (!res.ok) throw new Error('Failed to load tasks');
  const data = (await res.json()) as { tasks: AgentTask[] };
  return data.tasks;
}

async function updateTaskStatus(
  taskId: string,
  status: 'cancelled' | 'pending',
): Promise<AgentTask> {
  const res = await fetch(`/api/agents/tasks/${encodeURIComponent(taskId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({ error: 'Unknown error' }))) as { error: string };
    throw new Error(err.error);
  }
  return ((await res.json()) as { task: AgentTask }).task;
}

async function deleteTask(taskId: string): Promise<void> {
  const res = await fetch(`/api/agents/tasks/${encodeURIComponent(taskId)}`, {
    method: 'DELETE',
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({ error: 'Unknown error' }))) as { error: string };
    throw new Error(err.error);
  }
}

// ── Utilities ────────────────────────────────────────────────────────────────

function formatDate(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return `${diffDay}d ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// ── Draggable Task Card (MC board style) ─────────────────────────────────────

function DraggableTaskCard({
  task,
  onStatusChange,
  onDelete,
}: {
  task: AgentTask;
  onStatusChange: (taskId: string, status: TaskStatus) => void;
  onDelete: (taskId: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: task.id,
    data: { task },
  });

  const style: React.CSSProperties = transform
    ? { transform: `translate(${transform.x}px, ${transform.y}px)`, opacity: isDragging ? 0.4 : 1 }
    : {};

  return (
    <div ref={setNodeRef} style={style} {...listeners} {...attributes}>
      <TaskCardInner task={task} onStatusChange={onStatusChange} onDelete={onDelete} />
    </div>
  );
}

/** Pure presentational card — used both in columns and DragOverlay */
function TaskCardInner({
  task,
  onStatusChange,
  onDelete,
  overlay,
}: {
  task: AgentTask;
  onStatusChange: (taskId: string, status: TaskStatus) => void;
  onDelete: (taskId: string) => void;
  overlay?: boolean;
}) {
  const [menuOpen, setMenuOpen] = React.useState(false);
  const menuRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [menuOpen]);

  const prompt = task.task_prompt;
  const isLong = prompt.length > 120;
  const [expanded, setExpanded] = React.useState(false);
  const displayPrompt = isLong && !expanded ? prompt.slice(0, 120) + '\u2026' : prompt;

  return (
    <div
      className={cn(
        'group relative rounded-lg border border-slate-200 bg-white p-3 shadow-sm hover:shadow-md transition-shadow cursor-grab active:cursor-grabbing',
        overlay && 'shadow-xl ring-2 ring-blue-500/30 rotate-[2deg]',
      )}
    >
      {/* Title row */}
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-medium text-slate-900 leading-snug">
          {displayPrompt}
          {isLong && (
            <button
              onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
              className="ml-1 text-[10px] text-blue-600 hover:underline font-medium"
            >
              {expanded ? 'less' : 'more'}
            </button>
          )}
        </p>
        <div className="relative" ref={menuRef}>
          <button
            onClick={(e) => { e.stopPropagation(); setMenuOpen(!menuOpen); }}
            className="p-0.5 rounded opacity-0 group-hover:opacity-100 text-slate-400 hover:bg-slate-100 transition-all shrink-0"
          >
            <MoreHorizontal className="h-3.5 w-3.5" />
          </button>
          {menuOpen && (
            <div className="absolute right-0 top-6 w-44 rounded-lg border border-slate-200 bg-white shadow-lg py-1 z-50">
              {COLUMNS.filter((c) => c.key !== task.status).map((col) => {
                const allowed = DRAG_TRANSITIONS[task.status];
                const canMove = allowed.includes(col.key);
                if (!canMove) return null;
                return (
                  <button
                    key={col.key}
                    onClick={() => { onStatusChange(task.id, col.key); setMenuOpen(false); }}
                    className="flex items-center gap-2 w-full px-3 py-1.5 text-xs hover:bg-slate-100 transition-colors"
                  >
                    <span className={cn('h-2 w-2 rounded-full', col.color)} />
                    Move to {col.label}
                  </button>
                );
              })}
              {task.conversation_id && (
                <Link
                  href={`/?conversation=${task.conversation_id}`}
                  onClick={() => setMenuOpen(false)}
                  className="flex items-center gap-2 w-full px-3 py-1.5 text-xs hover:bg-slate-100 transition-colors"
                >
                  <MessageSquare className="h-3 w-3 text-blue-600" />
                  Open in chat
                </Link>
              )}
              {(task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') && (
                <>
                  <div className="border-t border-slate-200 my-1" />
                  <button
                    onClick={() => { onDelete(task.id); setMenuOpen(false); }}
                    className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-red-600 hover:bg-red-50 transition-colors"
                  >
                    <Trash2 className="h-3 w-3" />
                    Delete
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Progress bar (running) */}
      {task.status === 'running' && task.progress > 0 && (
        <div className="mt-2 h-1.5 rounded-full bg-slate-100 overflow-hidden">
          <div
            className="h-full bg-yellow-400 rounded-full transition-all duration-300"
            style={{ width: `${task.progress}%` }}
          />
        </div>
      )}

      {/* Error snippet (failed) */}
      {task.status === 'failed' && task.error && (
        <p className="mt-2 text-[11px] text-red-600 bg-red-50 rounded-md px-2 py-1 line-clamp-2">
          {task.error}
        </p>
      )}

      {/* Meta row — matches MC card style */}
      <div className="flex items-center gap-2 mt-2 flex-wrap">
        <span className={cn('text-[10px] font-semibold uppercase tracking-wide', TYPE_STYLES[task.task_type] || 'text-gray-500')}>
          {TYPE_LABELS[task.task_type] || task.task_type}
        </span>
        {task.agent_category && (
          <span className="flex items-center gap-1 text-[10px] text-slate-500">
            <span className="h-1.5 w-1.5 rounded-full bg-blue-400" />
            {task.agent_category}
          </span>
        )}
        {task.conversation_id && (
          <span className="flex items-center gap-1 text-[10px] text-slate-500">
            <span className="h-1.5 w-1.5 rounded-full bg-green-400" />
            Chat
          </span>
        )}
      </div>

      {/* Agent + time */}
      <div className="flex items-center gap-2 mt-1.5">
        <span className="flex items-center gap-1 text-[10px] text-slate-500">
          <Bot className="h-2.5 w-2.5" />
          {task.agent_name}
        </span>
        <span className="flex items-center gap-1 text-[10px] text-slate-500 ml-auto">
          <Clock className="h-2.5 w-2.5" />
          {formatDate(task.created_at)}
        </span>
      </div>
    </div>
  );
}

// ── Droppable Column (MC board style) ────────────────────────────────────────

function KanbanColumn({
  column,
  tasks,
  isOver,
  onStatusChange,
  onDelete,
}: {
  column: (typeof COLUMNS)[number];
  tasks: AgentTask[];
  isOver: boolean;
  onStatusChange: (taskId: string, status: TaskStatus) => void;
  onDelete: (taskId: string) => void;
}) {
  const { setNodeRef } = useDroppable({ id: column.key });

  return (
    <div
      ref={setNodeRef}
      className={cn(
        'flex flex-col w-[280px] shrink-0 rounded-xl bg-slate-50 border transition-colors duration-200',
        isOver ? 'border-blue-300 bg-blue-50/50 ring-2 ring-blue-200' : 'border-slate-200',
      )}
    >
      {/* Column Header — matches MC design */}
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-slate-200">
        <div className="flex items-center gap-2">
          <span className={cn('h-2.5 w-2.5 rounded-full', column.color)} />
          <span className="text-xs font-semibold text-slate-900">{column.label}</span>
          <span className="text-[10px] text-slate-500 bg-slate-100 rounded-full px-1.5 py-0.5">
            {tasks.length}
          </span>
        </div>
      </div>

      {/* Column Body */}
      <div className="flex-1 overflow-y-auto p-2 space-y-2 min-h-[200px]">
        {tasks.length === 0 ? (
          <p className="text-center text-[10px] text-slate-400 py-8">
            {isOver ? 'Drop here' : 'No tasks'}
          </p>
        ) : (
          tasks.map((task) => (
            <DraggableTaskCard
              key={task.id}
              task={task}
              onStatusChange={onStatusChange}
              onDelete={onDelete}
            />
          ))
        )}
      </div>
    </div>
  );
}

// ── List View Row ────────────────────────────────────────────────────────────

function ListRow({
  task,
  onStatusChange,
  onDelete,
}: {
  task: AgentTask;
  onStatusChange: (taskId: string, status: TaskStatus) => void;
  onDelete: (taskId: string) => void;
}) {
  const canCancel = task.status === 'pending' || task.status === 'running';
  const canRetry = task.status === 'failed' || task.status === 'cancelled';
  const canDelete = task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled';
  const col = COLUMNS.find((c) => c.key === task.status);

  return (
    <div className="group flex items-center gap-4 px-4 py-3 border-b border-slate-200 hover:bg-slate-50 transition-colors">
      {/* Status dot + label */}
      <span className="flex items-center gap-1.5 shrink-0 w-24">
        <span className={cn('h-2 w-2 rounded-full', col?.color ?? 'bg-gray-400')} />
        <span className="text-[10px] font-medium text-slate-500">{col?.label}</span>
      </span>

      {/* Prompt */}
      <div className="flex-1 min-w-0">
        <p className="text-sm text-slate-900 truncate">{task.task_prompt}</p>
        {task.status === 'failed' && task.error && (
          <p className="text-[11px] text-red-500 truncate mt-0.5">{task.error}</p>
        )}
      </div>

      {/* Type badge */}
      <span className={cn('text-[10px] font-semibold uppercase shrink-0 w-20 text-center', TYPE_STYLES[task.task_type] || 'text-gray-500')}>
        {TYPE_LABELS[task.task_type] || task.task_type}
      </span>

      {/* Agent */}
      <span className="flex items-center gap-1 text-xs text-slate-500 shrink-0 w-32 truncate">
        <Bot className="h-3 w-3 shrink-0" />
        {task.agent_name}
      </span>

      {/* Date */}
      <span className="flex items-center gap-1 text-xs text-slate-500 shrink-0 w-24">
        <Calendar className="h-3 w-3" />
        {formatDate(task.created_at)}
      </span>

      {/* Progress (running) */}
      {task.status === 'running' && task.progress > 0 ? (
        <div className="w-16 shrink-0">
          <div className="h-1.5 rounded-full bg-slate-100 overflow-hidden">
            <div className="h-full bg-yellow-400 rounded-full" style={{ width: `${task.progress}%` }} />
          </div>
          <p className="text-[9px] text-slate-500 text-center mt-0.5">{task.progress}%</p>
        </div>
      ) : (
        <div className="w-16 shrink-0" />
      )}

      {/* Actions */}
      <div className="flex items-center gap-1 shrink-0">
        {task.conversation_id && (
          <Link
            href={`/?conversation=${task.conversation_id}`}
            className="p-1.5 rounded-md text-slate-400 hover:text-blue-600 hover:bg-slate-100 transition-colors opacity-0 group-hover:opacity-100"
            title="Open in chat"
          >
            <MessageSquare className="h-3.5 w-3.5" />
          </Link>
        )}
        {canCancel && (
          <button
            onClick={() => onStatusChange(task.id, 'cancelled')}
            className="p-1.5 rounded-md text-slate-400 hover:text-yellow-600 hover:bg-slate-100 transition-colors opacity-0 group-hover:opacity-100"
            title="Cancel"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
        {canRetry && (
          <button
            onClick={() => onStatusChange(task.id, 'pending')}
            className="p-1.5 rounded-md text-slate-400 hover:text-blue-600 hover:bg-slate-100 transition-colors opacity-0 group-hover:opacity-100"
            title="Retry"
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </button>
        )}
        {canDelete && (
          <button
            onClick={() => onDelete(task.id)}
            className="p-1.5 rounded-md text-slate-400 hover:text-red-600 hover:bg-slate-100 transition-colors opacity-0 group-hover:opacity-100"
            title="Delete"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}

// ── Main page ────────────────────────────────────────────────────────────────

export default function AgentTasksPage() {
  const router = useRouter();
  const [tasks, setTasks] = React.useState<AgentTask[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [refreshing, setRefreshing] = React.useState(false);

  // View & filters
  const [view, setView] = React.useState<ViewMode>('board');
  const [searchQuery, setSearchQuery] = React.useState('');
  const [agentFilter, setAgentFilter] = React.useState('');
  const [statusFilter, setStatusFilter] = React.useState('');
  const [typeFilter, setTypeFilter] = React.useState('');
  const [sortField, setSortField] = React.useState<SortField>('created_at');
  const [sortDir, setSortDir] = React.useState<SortDir>('desc');

  // DnD
  const [activeTask, setActiveTask] = React.useState<AgentTask | null>(null);
  const [overColumnId, setOverColumnId] = React.useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  );

  // ── Data loading ───────────────────────────────────────────────────────────

  const load = React.useCallback(async (showRefreshing = false) => {
    if (showRefreshing) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      setTasks(await fetchTasks());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load tasks');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
    const timer = setInterval(() => {
      setTasks((prev) => {
        if (prev.some((t) => t.status === 'pending' || t.status === 'running')) void load(true);
        return prev;
      });
    }, 15_000);
    return () => clearInterval(timer);
  }, [load]);

  // ── Actions ────────────────────────────────────────────────────────────────

  const handleStatusChange = async (taskId: string, newStatus: TaskStatus) => {
    const task = tasks.find((t) => t.id === taskId);
    if (!task) return;
    const oldStatus = task.status;

    // Optimistic
    setTasks((prev) => prev.map((t) => (t.id === taskId ? { ...t, status: newStatus } : t)));

    try {
      await updateTaskStatus(taskId, newStatus as 'cancelled' | 'pending');
    } catch (err) {
      setTasks((prev) => prev.map((t) => (t.id === taskId ? { ...t, status: oldStatus } : t)));
      setError(err instanceof Error ? err.message : 'Failed to update task');
    }
  };

  const handleDelete = async (taskId: string) => {
    try {
      await deleteTask(taskId);
      setTasks((prev) => prev.filter((t) => t.id !== taskId));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete task');
    }
  };

  // ── DnD handlers ──────────────────────────────────────────────────────────

  const handleDragStart = (event: DragStartEvent) => {
    const task = tasks.find((t) => t.id === event.active.id);
    if (task) setActiveTask(task);
  };

  const handleDragOver = (event: DragOverEvent) => {
    const overId = event.over?.id as string | undefined;
    if (!overId) {
      setOverColumnId(null);
      return;
    }
    const colKeys = COLUMNS.map((c) => c.key) as string[];
    if (colKeys.includes(overId)) {
      setOverColumnId(overId);
    } else {
      const overTask = tasks.find((t) => t.id === overId);
      setOverColumnId(overTask?.status ?? null);
    }
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const dragged = activeTask;
    setActiveTask(null);
    setOverColumnId(null);

    if (!dragged || !event.over) return;

    const overId = event.over.id as string;
    const colKeys = COLUMNS.map((c) => c.key) as string[];
    let targetStatus: TaskStatus;

    if (colKeys.includes(overId)) {
      targetStatus = overId as TaskStatus;
    } else {
      const overTask = tasks.find((t) => t.id === overId);
      if (!overTask) return;
      targetStatus = overTask.status;
    }

    if (targetStatus === dragged.status) return;

    const allowed = DRAG_TRANSITIONS[dragged.status];
    if (!allowed.includes(targetStatus)) {
      setError(`Cannot move from "${dragged.status}" to "${targetStatus}"`);
      return;
    }

    void handleStatusChange(dragged.id, targetStatus);
  };

  const handleDragCancel = () => {
    setActiveTask(null);
    setOverColumnId(null);
  };

  // ── Computed ───────────────────────────────────────────────────────────────

  const agents = React.useMemo(() => {
    const map = new Map<string, string>();
    for (const t of tasks) map.set(t.agent_id, t.agent_name);
    const result: { id: string; name: string }[] = [];
    map.forEach((name, id) => result.push({ id, name }));
    return result;
  }, [tasks]);

  const filtered = React.useMemo(() => {
    let list = tasks;
    if (agentFilter) list = list.filter((t) => t.agent_id === agentFilter);
    if (statusFilter) list = list.filter((t) => t.status === statusFilter);
    if (typeFilter) list = list.filter((t) => t.task_type === typeFilter);
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      list = list.filter(
        (t) =>
          t.task_prompt.toLowerCase().includes(q) ||
          t.agent_name.toLowerCase().includes(q) ||
          (t.error && t.error.toLowerCase().includes(q)),
      );
    }
    return list;
  }, [tasks, agentFilter, statusFilter, typeFilter, searchQuery]);

  const sortedFiltered = React.useMemo(() => {
    const sorted = [...filtered];
    sorted.sort((a, b) => {
      let cmp: number;
      if (sortField === 'agent_name') cmp = a.agent_name.localeCompare(b.agent_name);
      else cmp = new Date(a[sortField]).getTime() - new Date(b[sortField]).getTime();
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return sorted;
  }, [filtered, sortField, sortDir]);

  const byStatus = React.useMemo(() => {
    const map: Record<string, AgentTask[]> = {};
    for (const col of COLUMNS) map[col.key] = [];
    for (const t of filtered) {
      if (map[t.status]) map[t.status].push(t);
    }
    return map;
  }, [filtered]);

  const statusCounts = React.useMemo(() => {
    const counts: Record<string, number> = {};
    for (const t of tasks) counts[t.status] = (counts[t.status] || 0) + 1;
    return counts;
  }, [tasks]);

  const totalActive = tasks.filter((t) => t.status === 'pending' || t.status === 'running').length;
  const hasFilters = !!agentFilter || !!statusFilter || !!typeFilter || !!searchQuery;

  const clearFilters = () => {
    setSearchQuery('');
    setAgentFilter('');
    setStatusFilter('');
    setTypeFilter('');
  };

  const toggleSort = (field: SortField) => {
    if (sortField === field) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSortField(field);
      setSortDir('desc');
    }
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  const headerActions = (
    <div className="flex items-center gap-2 shrink-0">
      {totalActive > 0 && (
        <span className="flex items-center gap-1 text-xs font-medium text-yellow-700 bg-yellow-100 rounded-full px-2.5 py-0.5">
          <Loader2 className="h-3 w-3 animate-spin" />
          {totalActive} active
        </span>
      )}
      <div className="flex rounded-lg border border-slate-200 overflow-hidden">
        <button
          onClick={() => setView('board')}
          className={cn(
            'px-3 py-1.5 text-sm font-medium transition-colors',
            view === 'board'
              ? 'bg-blue-600 text-white'
              : 'text-slate-500 hover:bg-slate-100',
          )}
        >
          Board
        </button>
        <button
          onClick={() => setView('list')}
          className={cn(
            'px-3 py-1.5 text-sm font-medium transition-colors',
            view === 'list'
              ? 'bg-blue-600 text-white'
              : 'text-slate-500 hover:bg-slate-100',
          )}
        >
          List
        </button>
      </div>
      <button
        onClick={() => void load(true)}
        disabled={refreshing}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 text-sm text-slate-500 hover:bg-slate-100 transition-colors disabled:opacity-60"
      >
        <RefreshCw className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')} />
        Refresh
      </button>
    </div>
  );

  return (
    <DashboardPageLayout
      title="Agent Tasks"
      description="Monitor and control tasks dispatched to your installed agents."
      headerActions={headerActions}
    >
    <div className="flex flex-col h-full">

        {/* Filters */}
        <div className="flex items-center gap-2 px-6 py-4 flex-wrap border-b border-slate-200">
          <div className="relative flex-1 max-w-xs">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400" />
            <input
              type="text"
              placeholder="Search tasks..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-8 pr-3 py-1.5 rounded-lg border border-slate-200 bg-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/40"
            />
          </div>
          {agents.length > 0 && (
            <select
              value={agentFilter}
              onChange={(e) => setAgentFilter(e.target.value)}
              className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/40"
            >
              <option value="">All agents</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          )}
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/40"
          >
            <option value="">All statuses</option>
            {COLUMNS.map((c) => (
              <option key={c.key} value={c.key}>
                {c.label}
              </option>
            ))}
          </select>
          <select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
            className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/40"
          >
            <option value="">All types</option>
            <option value="one-shot">One-shot</option>
            <option value="recurring">Recurring</option>
          </select>
          {hasFilters && (
            <button onClick={clearFilters} className="text-xs text-blue-600 hover:underline px-2 py-1">
              Clear filters
            </button>
          )}

          {/* Status counts */}
          <div className="flex items-center gap-1.5 ml-auto">
            {COLUMNS.map((col) => {
              const count = statusCounts[col.key] || 0;
              if (count === 0) return null;
              return (
                <button
                  key={col.key}
                  onClick={() => setStatusFilter(statusFilter === col.key ? '' : col.key)}
                  className={cn(
                    'flex items-center gap-1 text-[10px] font-medium rounded-full px-2 py-0.5 transition-all border',
                    statusFilter === col.key
                      ? 'border-blue-300 bg-blue-50 text-blue-700'
                      : 'border-slate-200 bg-slate-50 text-slate-500 hover:bg-slate-100',
                  )}
                >
                  <span className={cn('h-1.5 w-1.5 rounded-full', col.color)} />
                  {count}
                </button>
              );
            })}
          </div>
        </div>

      {/* Error banner */}
      {error && (
        <div className="shrink-0 mx-6 mt-4 flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-700">
          <AlertCircle className="h-4 w-4 shrink-0" />
          {error}
          <button onClick={() => setError(null)} className="ml-auto text-red-400 hover:text-red-600">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Content */}
      {loading ? (
        <div className="flex items-center justify-center flex-1">
          <Loader2 className="h-8 w-8 animate-spin text-slate-400" />
        </div>
      ) : tasks.length === 0 ? (
        <div className="flex flex-col items-center justify-center flex-1 text-center gap-3">
          <Inbox className="h-12 w-12 text-slate-300" />
          <p className="text-lg font-medium text-slate-500">No agent tasks yet</p>
          <p className="text-sm text-slate-400 max-w-sm">
            Tasks are created when you ask agents to perform work in chat, or when scheduled
            heartbeat tasks run.
          </p>
          <Link
            href="/"
            className="mt-2 flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 transition-colors"
          >
            <MessageSquare className="h-4 w-4" />
            Go to Chat
          </Link>
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center flex-1 text-center gap-2 py-16">
          <Search className="h-8 w-8 text-slate-300" />
          <p className="text-sm text-slate-500">No tasks match your filters.</p>
          <button onClick={clearFilters} className="text-xs text-blue-600 hover:underline">
            Clear filters
          </button>
        </div>
      ) : view === 'board' ? (
        /* ── Board view with DnD ── */
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={handleDragStart}
          onDragOver={handleDragOver}
          onDragEnd={handleDragEnd}
          onDragCancel={handleDragCancel}
        >
          <div className="flex-1 overflow-x-auto p-4">
            <div className="flex gap-3 min-w-max h-full">
              {COLUMNS.map((col) => (
                <KanbanColumn
                  key={col.key}
                  column={col}
                  tasks={byStatus[col.key] ?? []}
                  isOver={overColumnId === col.key}
                  onStatusChange={handleStatusChange}
                  onDelete={handleDelete}
                />
              ))}
            </div>
          </div>
          <DragOverlay dropAnimation={null}>
            {activeTask ? (
              <div className="w-[260px]">
                <TaskCardInner
                  task={activeTask}
                  onStatusChange={handleStatusChange}
                  onDelete={handleDelete}
                  overlay
                />
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
      ) : (
        /* ── List view ── */
        <div className="flex-1 overflow-auto p-6">
          <div className="flex items-center gap-4 px-4 py-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500 border-b border-slate-200">
            <span className="w-24">Status</span>
            <span className="flex-1">Task</span>
            <span className="w-20 text-center">Type</span>
            <button
              onClick={() => toggleSort('agent_name')}
              className="flex items-center gap-1 w-32 hover:text-slate-900 transition-colors"
            >
              Agent
              {sortField === 'agent_name' &&
                (sortDir === 'asc' ? <SortAsc className="h-3 w-3" /> : <SortDesc className="h-3 w-3" />)}
            </button>
            <button
              onClick={() => toggleSort('created_at')}
              className="flex items-center gap-1 w-24 hover:text-slate-900 transition-colors"
            >
              Date
              {sortField === 'created_at' &&
                (sortDir === 'asc' ? <SortAsc className="h-3 w-3" /> : <SortDesc className="h-3 w-3" />)}
            </button>
            <span className="w-16" />
            <span className="w-28" />
          </div>
          <div className="rounded-xl border border-slate-200 overflow-hidden mt-1">
            {sortedFiltered.map((task) => (
              <ListRow
                key={task.id}
                task={task}
                onStatusChange={handleStatusChange}
                onDelete={handleDelete}
              />
            ))}
          </div>
        </div>
      )}
    </div>
    </DashboardPageLayout>
  );
}