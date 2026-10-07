'use client';

import { useMemo } from 'react';
import { DashboardPageLayout } from '@/components/mc/templates/DashboardPageLayout';
import { AgentsTable } from '@/components/mc/tables/AgentsTable';
import { useMCAgents, useMCBoards } from '@/hooks/mc';

export default function AgentsPage() {
  const agentsQuery = useMCAgents({ limit: 200 });
  const boardsQuery = useMCBoards({ limit: 200 });

  const agents = useMemo(() => agentsQuery.data?.items ?? [], [agentsQuery.data]);
  const boards = useMemo(() => boardsQuery.data?.items ?? [], [boardsQuery.data]);

  return (
    <DashboardPageLayout
      title="Agents"
      description={`${agents.length} agent${agents.length === 1 ? '' : 's'} total.`}
    >
      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <AgentsTable
          agents={agents}
          boards={boards}
          isLoading={agentsQuery.isLoading}
        />
      </div>

      {agentsQuery.error ? (
        <p className="mt-4 text-sm text-red-500">
          {agentsQuery.error.message}
        </p>
      ) : null}
    </DashboardPageLayout>
  );
}
