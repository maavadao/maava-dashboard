'use client';

import * as React from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { cn } from '@/lib/utils';
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
  ArrowLeft,
  Plus,
  Bot,
  Clock,
  AlertTriangle,
  MoreHorizontal,
  Trash2,
  Target,
  Zap,
  AlertCircle,
  MessageSquare,
} from 'lucide-react';
import {
  mcCreateTask,
  mcUpdateTask,
  mcDeleteTask,
} from '@/lib/mission-control';
import { useMCBoard, useMCAgents, useMCTasks, mcKeys } from '@/hooks/mc';
import { useQueryClient } from '@tanstack/react-query';
import type {
  MCTask,
  MCTaskCreate,
  MCTaskStatus,
  MCTaskPriority,
  MCAgent,
} from '@/lib/mission-control';

// ── Constants ────────────────────────────────────────────────────────────────

const KANBAN_COLUMNS: { key: MCTaskStatus; label: string; color: string }[] = [
  { key: 'inbox',       label: 'Inbox',       color: 'bg-gray-400' },
  { key: 'in_progress', label: 'In Progress', color: 'bg-yellow-400' },
  { key: 'review',      label: 'Review',      color: 'bg-purple-400' },
  { key: 'done',        label: 'Done',        color: 'bg-green-400' },
  { key: 'cancelled',   label: 'Cancelled',   color: 'bg-red-400' },
];

/** Allowed drag-and-drop transitions for the task workflow */
const DRAG_TRANSITIONS: Record<MCTaskStatus, MCTaskStatus[]> = {
  inbox:       ['in_progress', 'cancelled'],
  in_progress: ['review', 'cancelled'],
  review:      ['done', 'in_progress', 'cancelled'],
  done:        [],
  cancelled:   ['inbox'],
};

const PRIORITY_STYLES: Record<MCTaskPriority, string> = {
  low:      'text-gray-500',
  medium:   'text-blue-500',
  high:     'text-orange-500',
  critical: 'text-red-600',
};

const PRIORITY_LABELS: Record<MCTaskPriority, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  critical: 'Critical',
};

// ── Create Task Dialog ───────────────────────────────────────────────────────

function CreateTaskDialog({
  open,
  onClose,
  onCreated,
  defaultStatus,
  agents,
  boardId,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (task: MCTask) => void;
  defaultStatus: MCTaskStatus;
  agents: MCAgent[];
  boardId: string;
}) {
  const [title, setTitle] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [priority, setPriority] = React.useState<MCTaskPriority>('medium');
  const [assignedAgentId, setAssignedAgentId] = React.useState<string>('');
  const [dueAt, setDueAt] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  if (!open) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const data: MCTaskCreate = {
        title: title.trim(),
        description: description.trim() || undefined,
        status: defaultStatus,
        priority,
        assigned_agent_id: assignedAgentId || undefined,
        due_at: dueAt || undefined,
      };
      const task = await mcCreateTask(boardId, data);
      onCreated(task);
      setTitle('');
      setDescription('');
      setPriority('medium');
      setAssignedAgentId('');
      setDueAt('');
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create task');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative bg-card rounded-xl border border-border shadow-xl w-full max-w-md p-6">
        <h2 className="text-lg font-semibold mb-4">Create Task</h2>
        {error && (
          <div className="mb-4 rounded-lg border border-red-200 bg-red-50 dark:border-red-800 dark:bg-red-900/20 px-4 py-2 text-sm text-red-700 dark:text-red-400">
            {error}
          </div>
        )}
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="text-sm font-medium text-foreground">Title</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Task title"
              className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
              autoFocus
            />
          </div>
          <div>
            <label className="text-sm font-medium text-foreground">Description</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Details..."
              rows={3}
              className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40 resize-none"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-sm font-medium text-foreground">Priority</label>
              <select
                value={priority}
                onChange={(e) => setPriority(e.target.value as MCTaskPriority)}
                className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
              >
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="critical">Critical</option>
              </select>
            </div>
            <div>
              <label className="text-sm font-medium text-foreground">Due Date</label>
              <input
                type="date"
                value={dueAt}
                onChange={(e) => setDueAt(e.target.value)}
                className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
              />
            </div>
          </div>
          {agents.length > 0 && (
            <div>
              <label className="text-sm font-medium text-foreground">Assign Agent</label>
              <select
                value={assignedAgentId}
                onChange={(e) => setAssignedAgentId(e.target.value)}
                className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
              >
                <option value="">Unassigned</option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-lg border border-input text-sm text-muted-foreground hover:bg-muted transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!title.trim() || saving}
              className="px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-60"
            >
              {saving ? 'Creating...' : 'Create Task'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Draggable Task Card ──────────────────────────────────────────────────────

function DraggableTaskCard({
  task,
  onStatusChange,
  onDelete,
}: {
  task: MCTask;
  onStatusChange: (taskId: string, status: MCTaskStatus) => void;
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
  task: MCTask;
  onStatusChange: (taskId: string, status: MCTaskStatus) => void;
  onDelete: (taskId: string) => void;
  overlay?: boolean;
}) {
  const [menuOpen, setMenuOpen] = React.useState(false);
  const menuRef = React.useRef<HTMLDivElement>(null);
  const router = useRouter();

  React.useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [menuOpen]);

  const allowed = DRAG_TRANSITIONS[task.status];

  const openInChat = async () => {
    setMenuOpen(false);
    try {
      const res = await fetch(`/api/mission-control/task-chat?mc_task_id=${encodeURIComponent(task.id)}`);
      const data = await res.json() as { conversation_id: string | null };
      if (data.conversation_id) {
        router.push(`/c/${data.conversation_id}`);
      }
    } catch {
      // ignore
    }
  };

  return (
    <div
      className={cn(
        'group relative rounded-lg border border-border bg-card p-3 shadow-sm hover:shadow-md transition-shadow cursor-grab active:cursor-grabbing',
        overlay && 'shadow-xl ring-2 ring-primary/30 rotate-[2deg]',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <h4 className="text-sm font-medium text-foreground leading-snug">{task.title}</h4>
        <div className="relative" ref={menuRef}>
          <button
            onClick={(e) => { e.stopPropagation(); setMenuOpen(!menuOpen); }}
            className="p-0.5 rounded opacity-0 group-hover:opacity-100 text-muted-foreground hover:bg-muted transition-all shrink-0"
          >
            <MoreHorizontal className="h-3.5 w-3.5" />
          </button>
          {menuOpen && (
            <div className="absolute right-0 top-6 w-44 rounded-lg border border-border bg-card shadow-lg py-1 z-50">
              {KANBAN_COLUMNS.filter((c) => c.key !== task.status && allowed.includes(c.key)).map(
                (col) => (
                  <button
                    key={col.key}
                    onClick={() => {
                      onStatusChange(task.id, col.key);
                      setMenuOpen(false);
                    }}
                    className="flex items-center gap-2 w-full px-3 py-1.5 text-xs hover:bg-muted transition-colors"
                  >
                    <span className={cn('h-2 w-2 rounded-full', col.color)} />
                    Move to {col.label}
                  </button>
                ),
              )}
              <button
                onClick={openInChat}
                className="flex items-center gap-2 w-full px-3 py-1.5 text-xs hover:bg-muted transition-colors"
              >
                <MessageSquare className="h-3 w-3 text-primary" />
                Open in chat
              </button>
              <div className="border-t border-border my-1" />
              <button
                onClick={() => {
                  onDelete(task.id);
                  setMenuOpen(false);
                }}
                className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
              >
                <Trash2 className="h-3 w-3" />
                Delete
              </button>
            </div>
          )}
        </div>
      </div>

      {task.description && (
        <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{task.description}</p>
      )}

      <div className="flex items-center gap-2 mt-2 flex-wrap">
        <span className={cn('text-[10px] font-medium', PRIORITY_STYLES[task.priority])}>
          {PRIORITY_LABELS[task.priority]}
        </span>
        {task.blocked && (
          <span className="flex items-center gap-0.5 text-[10px] text-red-500 font-medium">
            <AlertTriangle className="h-2.5 w-2.5" />
            Blocked
          </span>
        )}
        {task.assigned_agent_name && (
          <span className="flex items-center gap-0.5 text-[10px] text-muted-foreground">
            <Bot className="h-2.5 w-2.5" />
            {task.assigned_agent_name}
          </span>
        )}
        {task.due_at && (
          <span className="flex items-center gap-0.5 text-[10px] text-muted-foreground">
            <Clock className="h-2.5 w-2.5" />
            {new Date(task.due_at).toLocaleDateString()}
          </span>
        )}
      </div>
    </div>
  );
}

// ── Droppable Column ─────────────────────────────────────────────────────────

function KanbanColumn({
  column,
  tasks,
  isOver,
  onStatusChange,
  onDelete,
  onAddClick,
}: {
  column: (typeof KANBAN_COLUMNS)[number];
  tasks: MCTask[];
  isOver: boolean;
  onStatusChange: (taskId: string, status: MCTaskStatus) => void;
  onDelete: (taskId: string) => void;
  onAddClick: () => void;
}) {
  const { setNodeRef } = useDroppable({ id: column.key });

  return (
    <div
      ref={setNodeRef}
      className={cn(
        'flex flex-col w-[280px] shrink-0 rounded-xl bg-muted/40 border transition-colors duration-200',
        isOver ? 'border-primary/40 bg-primary/5 ring-2 ring-primary/20' : 'border-border/50',
      )}
    >
      {/* Column Header */}
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-border/50">
        <div className="flex items-center gap-2">
          <span className={cn('h-2.5 w-2.5 rounded-full', column.color)} />
          <span className="text-xs font-semibold text-foreground">{column.label}</span>
          <span className="text-[10px] text-muted-foreground bg-muted rounded-full px-1.5 py-0.5">
            {tasks.length}
          </span>
        </div>
        <button
          onClick={onAddClick}
          className="p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-all"
          title={`Add task to ${column.label}`}
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Column Body */}
      <div className="flex-1 overflow-y-auto p-2 space-y-2 min-h-[200px]">
        {tasks.length === 0 ? (
          <p className="text-center text-[10px] text-muted-foreground/50 py-8">
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

// ── Board Detail Page ────────────────────────────────────────────────────────

export default function BoardDetailPage() {
  const params = useParams();
  const router = useRouter();
  const boardId = params.boardId as string;

  const queryClient = useQueryClient();

  // Cached queries — instant on revisit, background-refresh on stale
  const boardQuery = useMCBoard(boardId);
  const agentsQuery = useMCAgents({ limit: 100 });
  const tasksQuery = useMCTasks(boardId, { limit: 200 });

  const board = boardQuery.data ?? null;
  const agents = agentsQuery.data?.items ?? [];

  // Mirror server tasks into local state so optimistic updates work
  const [tasks, setTasks] = React.useState<MCTask[]>([]);
  React.useEffect(() => {
    if (tasksQuery.data?.items) setTasks(tasksQuery.data.items);
  }, [tasksQuery.data]);

  const loading = boardQuery.isLoading || tasksQuery.isLoading;
  const [error, setError] = React.useState<string | null>(null);
  const [syncWarning, setSyncWarning] = React.useState<string | null>(null);
  const [createStatus, setCreateStatus] = React.useState<MCTaskStatus | null>(null);

  // DnD state
  const [activeTask, setActiveTask] = React.useState<MCTask | null>(null);
  const [overColumnId, setOverColumnId] = React.useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  );

  // ── Data loading ─────────────────────────────────────────────────────────
  // Refetch tasks via react-query when active tasks exist
  const loadTasks = React.useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: mcKeys.tasks(boardId) });
  }, [queryClient, boardId]);

  React.useEffect(() => {
    const timer = setInterval(() => {
      const hasActive = tasks.some((t) => t.status === 'in_progress' || t.status === 'review');
      if (hasActive) loadTasks();
    }, 15_000);
    return () => clearInterval(timer);
  }, [tasks, loadTasks]);

  // ── Actions ──────────────────────────────────────────────────────────────

  const handleStatusChange = async (taskId: string, newStatus: MCTaskStatus) => {
    const task = tasks.find((t) => t.id === taskId);
    if (!task) return;
    const oldStatus = task.status;

    // Enforce transitions
    const allowed = DRAG_TRANSITIONS[oldStatus];
    if (!allowed.includes(newStatus)) {
      setError(`Cannot move from "${oldStatus}" to "${newStatus}"`);
      return;
    }

    // Optimistic update
    setTasks((prev) =>
      prev.map((t) => (t.id === taskId ? { ...t, status: newStatus } : t)),
    );
    setError(null);
    setSyncWarning(null);

    try {
      // Step 1: Update MC task (authoritative)
      await mcUpdateTask(boardId, taskId, { status: newStatus });

      // Step 2: Reverse sync to agent_tasks (awaited, not fire-and-forget)
      try {
        const syncRes = await fetch('/api/mission-control/task-sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mc_task_id: taskId, new_status: newStatus }),
        });
        const syncData = await syncRes.json().catch(() => ({ error: 'unknown' }));
        if (!syncRes.ok) {
          console.warn('[kanban] Sync succeeded for MC but failed for agent_tasks:', syncData);
          if (syncData.error === 'not_found_or_forbidden') {
            setSyncWarning('Board updated but agent sync blocked — you may not have permission.');
          } else {
            setSyncWarning('Board updated but agent sync pending — will reconcile on next poll.');
          }
        } else if (syncData.error === 'no_linked_task') {
          // MC-only task — no agent_task to sync, this is fine
          console.log('[kanban] MC-only task, no agent sync needed');
        }
      } catch (syncNetworkErr) {
        console.warn('[kanban] Sync network error:', syncNetworkErr);
        setSyncWarning('Board updated but agent sync pending — will reconcile on next poll.');
      }
    } catch {
      // MC update itself failed — revert optimistic update
      setTasks((prev) =>
        prev.map((t) => (t.id === taskId ? { ...t, status: oldStatus } : t)),
      );
      setError('Failed to update task status. Please try again.');
    }
  };

  const handleDeleteTask = async (taskId: string) => {
    setTasks((prev) => prev.filter((t) => t.id !== taskId));
    try {
      await mcDeleteTask(boardId, taskId);
    } catch {
      loadTasks();
    }
  };

  // ── DnD handlers ────────────────────────────────────────────────────────

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
    const colKeys = KANBAN_COLUMNS.map((c) => c.key) as string[];
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
    const colKeys = KANBAN_COLUMNS.map((c) => c.key) as string[];
    let targetStatus: MCTaskStatus;

    if (colKeys.includes(overId)) {
      targetStatus = overId as MCTaskStatus;
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

  // ── Render ───────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full min-h-[400px]">
        <div className="h-8 w-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!board) {
    return (
      <div className="p-8 text-center">
        <p className="text-muted-foreground">Board not found.</p>
        <Link
          href="/mission-control/boards"
          className="text-primary text-sm mt-2 inline-block hover:underline"
        >
          Back to boards
        </Link>
      </div>
    );
  }

  const tasksByStatus = KANBAN_COLUMNS.map((col) => ({
    ...col,
    tasks: tasks.filter((t) => t.status === col.key),
  }));

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="p-6 border-b border-border">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <Link
                href="/mission-control/boards"
                className="text-muted-foreground hover:text-foreground transition-colors"
              >
                <ArrowLeft className="h-4 w-4" />
              </Link>
              <h1 className="text-xl font-bold text-foreground">{board.name}</h1>
              <span className="text-[10px] px-2 py-0.5 rounded-full font-medium bg-primary/10 text-primary capitalize">
                {board.board_type}
              </span>
            </div>
            {board.objective && (
              <p className="text-sm text-muted-foreground flex items-center gap-1.5 ml-6">
                <Target className="h-3.5 w-3.5 shrink-0" />
                {board.objective}
              </p>
            )}
          </div>
          <div className="flex items-center gap-3 text-xs text-muted-foreground shrink-0">
            <span>{tasks.length} tasks</span>
            <span>{agents.length} agents</span>
            {board.autonomy_enabled && (
              <span className="flex items-center gap-1 text-green-600">
                <Zap className="h-3 w-3" />
                Auto
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div className="mx-4 mt-3 flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 dark:border-red-800 dark:bg-red-900/20 px-4 py-2 text-sm text-red-700 dark:text-red-400">
          <AlertCircle className="h-4 w-4 shrink-0" />
          {error}
          <button onClick={() => setError(null)} className="ml-auto text-red-500 hover:text-red-700">
            &times;
          </button>
        </div>
      )}

      {/* Sync warning banner */}
      {syncWarning && (
        <div className="mx-4 mt-2 flex items-center gap-2 rounded-lg border border-yellow-200 bg-yellow-50 dark:border-yellow-800 dark:bg-yellow-900/20 px-4 py-2 text-sm text-yellow-700 dark:text-yellow-400">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          {syncWarning}
          <button onClick={() => setSyncWarning(null)} className="ml-auto text-yellow-500 hover:text-yellow-700">
            &times;
          </button>
        </div>
      )}

      {/* Kanban Board with DnD */}
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
            {tasksByStatus.map((col) => (
              <KanbanColumn
                key={col.key}
                column={col}
                tasks={col.tasks}
                isOver={overColumnId === col.key}
                onStatusChange={handleStatusChange}
                onDelete={handleDeleteTask}
                onAddClick={() => setCreateStatus(col.key)}
              />
            ))}
          </div>
        </div>

        <DragOverlay>
          {activeTask ? (
            <TaskCardInner
              task={activeTask}
              onStatusChange={handleStatusChange}
              onDelete={handleDeleteTask}
              overlay
            />
          ) : null}
        </DragOverlay>
      </DndContext>

      {/* Create Task Dialog */}
      {createStatus && (
        <CreateTaskDialog
          open={true}
          onClose={() => setCreateStatus(null)}
          onCreated={(task) => setTasks((prev) => [...prev, task])}
          defaultStatus={createStatus}
          agents={agents}
          boardId={boardId}
        />
      )}
    </div>
  );
}
