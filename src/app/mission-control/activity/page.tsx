'use client';

import { useMemo, useState, useCallback } from 'react';
import {
  Activity,
  Filter,
  Plus,
  Trash2,
  CheckCircle2,
  Edit3,
  ArrowRight,
  Bot,
  ClipboardList,
} from 'lucide-react';
import { DashboardPageLayout } from '@/components/mc/templates/DashboardPageLayout';
import { useMCActivity, useMCBoards } from '@/hooks/mc';
import type { MCActivityEvent } from '@/lib/mission-control/types';
import { formatRelativeTimestamp } from '@/lib/mc-formatters';

const EVENT_ICONS: Record<string, React.ElementType> = {
  'task.created': Plus,
  'task.updated': Edit3,
  'task.completed': CheckCircle2,
  'task.deleted': Trash2,
  'task.status_changed': ArrowRight,
  'agent.assigned': Bot,
  'board.created': ClipboardList,
  default: Activity,
};

function getEventIcon(eventType: string) {
  return EVENT_ICONS[eventType] || EVENT_ICONS.default;
}

export default function ActivityPage() {
  const [boardFilter, setBoardFilter] = useState('');

  const boardsQuery = useMCBoards({ limit: 100 });
  const activityQuery = useMCActivity({
    board_id: boardFilter || undefined,
    limit: 50,
  }, {
    refetchInterval: 10_000,
  });

  const boards = useMemo(() => boardsQuery.data?.items ?? [], [boardsQuery.data]);
  const events = useMemo(() => activityQuery.data?.items ?? [], [activityQuery.data]);

  // Group events by date
  const grouped = useMemo(() => {
    return events.reduce<Record<string, MCActivityEvent[]>>((acc, ev) => {
      const day = new Date(ev.created_at).toLocaleDateString(undefined, {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      });
      if (!acc[day]) acc[day] = [];
      acc[day].push(ev);
      return acc;
    }, {});
  }, [events]);

  return (
    <DashboardPageLayout
      title="Activity"
      description="Timeline of all actions across your boards and agents."
    >
      {/* Board filter */}
      {boards.length > 0 && (
        <div className="flex items-center gap-2 mb-6">
          <Filter className="h-3.5 w-3.5 text-slate-400" />
          <select
            value={boardFilter}
            onChange={(e) => setBoardFilter(e.target.value)}
            className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-700 focus:outline-none focus:ring-2 focus:ring-[color:var(--mc-accent)]/40"
          >
            <option value="">All Boards</option>
            {boards.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </div>
      )}

      {activityQuery.isLoading ? (
        <div className="flex items-center justify-center py-12">
          <div className="h-6 w-6 border-2 border-[color:var(--mc-accent)] border-t-transparent rounded-full animate-spin" />
        </div>
      ) : events.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-200 p-12 text-center">
          <Activity className="h-12 w-12 text-slate-300 mx-auto mb-3" />
          <p className="text-slate-500">No activity recorded yet.</p>
        </div>
      ) : (
        <div className="space-y-6">
          {Object.entries(grouped).map(([day, dayEvents]) => (
            <div key={day}>
              <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">
                {day}
              </h2>
              <div className="relative border-l-2 border-slate-200 pl-6 space-y-4">
                {dayEvents.map((ev) => {
                  const Icon = getEventIcon(ev.event_type);
                  return (
                    <div key={ev.id} className="relative">
                      <div className="absolute -left-[31px] top-0.5 h-5 w-5 rounded-full bg-white border-2 border-slate-200 flex items-center justify-center">
                        <Icon className="h-2.5 w-2.5 text-slate-400" />
                      </div>
                      <div className="rounded-lg border border-slate-200 bg-white p-3">
                        <div className="flex items-center gap-2 flex-wrap">
                          {ev.actor_name && (
                            <span className="text-xs font-medium text-slate-900">
                              {ev.actor_name}
                            </span>
                          )}
                          <span className="text-xs text-slate-500">
                            {ev.message || ev.event_type.replace(/\./g, ' ')}
                          </span>
                          {ev.board_name && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-slate-100 text-slate-500">
                              {ev.board_name}
                            </span>
                          )}
                        </div>
                        <div className="text-[10px] text-slate-400 mt-1">
                          {formatRelativeTimestamp(ev.created_at)}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </DashboardPageLayout>
  );
}
