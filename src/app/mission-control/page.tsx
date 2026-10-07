'use client';

import { useMemo, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  ArrowUpRight,
  Bot,
  ClipboardList,
  LayoutGrid,
  Shield,
  Activity,
  Zap,
} from 'lucide-react';
import { DashboardPageLayout } from '@/components/mc/templates/DashboardPageLayout';
import { Card, CardHeader, CardContent } from '@/components/mc/ui/card';
import { StatusDot } from '@/components/mc/atoms/StatusDot';
import { useMCBoards, useMCAgents, useMCActivity } from '@/hooks/mc';
import { mcListApprovals } from '@/lib/mission-control/api';
import type { MCBoard, MCActivityEvent } from '@/lib/mission-control/types';
import { formatRelativeTimestamp } from '@/lib/mc-formatters';

function MetricCard({
  label,
  value,
  icon: Icon,
  href,
}: {
  label: string;
  value: string | number;
  icon: React.ElementType;
  href: string;
}) {
  return (
    <Link href={href} className="group">
      <Card className="transition-shadow hover:shadow-md">
        <CardContent className="flex items-center gap-4 py-4">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[color:var(--mc-accent-soft)]">
            <Icon className="h-5 w-5 text-[color:var(--mc-accent)]" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-2xl font-bold text-slate-900">{value}</p>
            <p className="text-xs text-slate-500">{label}</p>
          </div>
          <ArrowUpRight className="h-4 w-4 text-slate-400 opacity-0 group-hover:opacity-100 transition-opacity" />
        </CardContent>
      </Card>
    </Link>
  );
}

function BoardRow({ board }: { board: MCBoard }) {
  return (
    <Link
      href={`/mission-control/boards/${board.id}`}
      className="flex items-center gap-3 rounded-lg px-3 py-2.5 hover:bg-slate-50 transition-colors"
    >
      <StatusDot variant="agent" status={board.status === 'active' ? 'active' : 'inactive'} />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-slate-900 truncate">{board.name}</p>
        {board.objective && (
          <p className="text-xs text-slate-500 truncate">{board.objective}</p>
        )}
      </div>
      <div className="flex items-center gap-3 text-xs text-slate-400">
        <span className="flex items-center gap-1">
          <ClipboardList className="h-3 w-3" /> {board.task_count ?? 0}
        </span>
        <span className="flex items-center gap-1">
          <Bot className="h-3 w-3" /> {board.agent_count ?? 0}
        </span>
      </div>
    </Link>
  );
}

function ActivityRow({ event }: { event: MCActivityEvent }) {
  return (
    <div className="flex items-start gap-3 py-2.5">
      <div className="mt-0.5 h-6 w-6 rounded-full bg-slate-100 flex items-center justify-center shrink-0">
        <Activity className="h-3 w-3 text-slate-400" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm text-slate-700">
          {event.actor_name && (
            <span className="font-medium">{event.actor_name}</span>
          )}{' '}
          {event.message || event.event_type.replace(/\./g, ' ')}
        </p>
        <p className="text-xs text-slate-400 mt-0.5">
          {event.board_name && (
            <span className="text-[color:var(--mc-accent)]">{event.board_name}</span>
          )}
          {event.board_name && ' · '}
          {formatRelativeTimestamp(event.created_at)}
        </p>
      </div>
    </div>
  );
}

export default function MissionControlPage() {
  const boardsQuery = useMCBoards({ limit: 20 });
  const agentsQuery = useMCAgents({ limit: 100 });
  const activityQuery = useMCActivity({ limit: 10 });

  const boards = useMemo(() => boardsQuery.data?.items ?? [], [boardsQuery.data]);
  const agents = useMemo(() => agentsQuery.data?.items ?? [], [agentsQuery.data]);
  const activity = useMemo(() => activityQuery.data?.items ?? [], [activityQuery.data]);

  const activeBoards = boards.filter((b) => b.status === 'active').length;
  const activeAgents = agents.filter((a) => a.is_active !== false).length;

  // Fetch pending approvals count across all boards
  const [pendingApprovals, setPendingApprovals] = useState<number>(0);
  useEffect(() => {
    if (boards.length === 0) return;
    let cancelled = false;
    Promise.allSettled(
      boards.map((b) => mcListApprovals(b.id, { status: 'pending' }))
    ).then((results) => {
      if (cancelled) return;
      let count = 0;
      for (const r of results) {
        if (r.status === 'fulfilled') count += r.value.items.length;
      }
      setPendingApprovals(count);
    });
    return () => { cancelled = true; };
  }, [boards]);

  // Fetch agent tasks count
  const [agentTasksCount, setAgentTasksCount] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch('/api/agents/tasks')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        const tasks = Array.isArray(data) ? data : data.tasks ?? [];
        setAgentTasksCount(tasks.length);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  return (
    <DashboardPageLayout
      title="Dashboard"
      description="Overview of your Mission Control workspace."
    >
      {/* Metric cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <MetricCard
          label="Active Boards"
          value={activeBoards}
          icon={LayoutGrid}
          href="/mission-control/boards"
        />
        <MetricCard
          label="Agents"
          value={agents.length}
          icon={Bot}
          href="/mission-control/agents"
        />
        <MetricCard
          label="Pending Approvals"
          value={pendingApprovals}
          icon={Shield}
          href="/mission-control/approvals"
        />
        <MetricCard
          label="Agent Tasks"
          value={agentTasksCount ?? '—'}
          icon={Zap}
          href="/mission-control/agent-tasks"
        />
      </div>

      {/* Boards + Activity */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Boards */}
        <div className="lg:col-span-2">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-slate-900">Boards</h2>
                <Link
                  href="/mission-control/boards"
                  className="text-xs text-[color:var(--mc-accent)] hover:underline"
                >
                  View all
                </Link>
              </div>
            </CardHeader>
            <CardContent>
              {boardsQuery.isLoading ? (
                <div className="flex items-center justify-center py-8">
                  <div className="h-6 w-6 border-2 border-[color:var(--mc-accent)] border-t-transparent rounded-full animate-spin" />
                </div>
              ) : boards.length === 0 ? (
                <div className="text-center py-8">
                  <LayoutGrid className="h-8 w-8 text-slate-300 mx-auto mb-2" />
                  <p className="text-sm text-slate-500">No boards yet</p>
                </div>
              ) : (
                <div className="divide-y divide-slate-100">
                  {boards.slice(0, 8).map((board) => (
                    <BoardRow key={board.id} board={board} />
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Recent Activity */}
        <div>
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-slate-900">Recent Activity</h2>
                <Link
                  href="/mission-control/activity"
                  className="text-xs text-[color:var(--mc-accent)] hover:underline"
                >
                  View all
                </Link>
              </div>
            </CardHeader>
            <CardContent>
              {activityQuery.isLoading ? (
                <div className="flex items-center justify-center py-8">
                  <div className="h-6 w-6 border-2 border-[color:var(--mc-accent)] border-t-transparent rounded-full animate-spin" />
                </div>
              ) : activity.length === 0 ? (
                <div className="text-center py-8">
                  <Activity className="h-8 w-8 text-slate-300 mx-auto mb-2" />
                  <p className="text-sm text-slate-500">No recent activity</p>
                </div>
              ) : (
                <div className="divide-y divide-slate-100">
                  {activity.map((event) => (
                    <ActivityRow key={event.id} event={event} />
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </DashboardPageLayout>
  );
}
