'use client';

import { useMemo, useState, useCallback } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CheckCircle2,
  XCircle,
  Clock,
  ShieldCheck,
  Filter,
} from 'lucide-react';
import { DashboardPageLayout } from '@/components/mc/templates/DashboardPageLayout';
import { Card, CardContent } from '@/components/mc/ui/card';
import { MCButton } from '@/components/mc/ui/button';
import { useMCBoards } from '@/hooks/mc';
import {
  mcListApprovals,
  mcApproveApproval,
  mcRejectApproval,
} from '@/lib/mission-control/api';
import type { MCApproval, MCBoard } from '@/lib/mission-control/types';
import { formatRelativeTimestamp } from '@/lib/mc-formatters';

const STATUS_STYLES: Record<string, { icon: React.ElementType; color: string }> = {
  pending:  { icon: Clock,        color: 'text-yellow-500' },
  approved: { icon: CheckCircle2, color: 'text-green-500' },
  rejected: { icon: XCircle,      color: 'text-red-500' },
};

export default function ApprovalsPage() {
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState('pending');
  const [selectedBoardId, setSelectedBoardId] = useState('');

  const boardsQuery = useMCBoards({ limit: 100 });
  const boards = useMemo(() => boardsQuery.data?.items ?? [], [boardsQuery.data]);

  const boardIdsKey = useMemo(() => {
    const ids = boards.map((b) => b.id);
    ids.sort();
    return ids.join(',');
  }, [boards]);

  const approvalsKey = useMemo(
    () => ['mc', 'approvals', 'global', boardIdsKey] as const,
    [boardIdsKey]
  );

  const approvalsQuery = useQuery({
    queryKey: approvalsKey,
    enabled: boards.length > 0,
    refetchInterval: 15_000,
    queryFn: async () => {
      const results = await Promise.allSettled(
        boards.map(async (board) => {
          const res = await mcListApprovals(board.id);
          return res.items;
        })
      );
      const approvals: MCApproval[] = [];
      for (const r of results) {
        if (r.status === 'fulfilled') approvals.push(...r.value);
      }
      return approvals;
    },
  });

  const approvals = useMemo(() => approvalsQuery.data ?? [], [approvalsQuery.data]);

  const filtered = useMemo(() => {
    return approvals.filter((a) => {
      if (statusFilter && a.status !== statusFilter) return false;
      if (selectedBoardId && a.board_id !== selectedBoardId) return false;
      return true;
    });
  }, [approvals, statusFilter, selectedBoardId]);

  const decisionMutation = useMutation({
    mutationFn: async ({ approval, action }: { approval: MCApproval; action: 'approved' | 'rejected' }) => {
      if (action === 'approved') {
        return mcApproveApproval(approval.board_id, approval.id);
      }
      return mcRejectApproval(approval.board_id, approval.id);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: approvalsKey });
    },
  });

  return (
    <DashboardPageLayout
      title="Approvals"
      description="Review and approve actions requested by AI agents."
    >
      {/* Filters */}
      <div className="flex items-center gap-3 flex-wrap mb-6">
        <div className="flex items-center gap-1">
          <Filter className="h-3.5 w-3.5 text-slate-400" />
          <span className="text-xs text-slate-500">Status:</span>
        </div>
        {['', 'pending', 'approved', 'rejected'].map((s) => (
          <button
            key={s}
            onClick={() => setStatusFilter(s)}
            className={`px-3 py-1 rounded-lg text-xs font-medium transition-colors ${
              statusFilter === s
                ? 'bg-[color:var(--mc-accent)] text-white'
                : 'bg-slate-100 text-slate-500 hover:text-slate-700'
            }`}
          >
            {s || 'All'}
          </button>
        ))}
        {boards.length > 1 && (
          <select
            value={selectedBoardId}
            onChange={(e) => setSelectedBoardId(e.target.value)}
            className="ml-auto rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-700 focus:outline-none focus:ring-2 focus:ring-[color:var(--mc-accent)]/40"
          >
            <option value="">All Boards</option>
            {boards.map((b) => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </select>
        )}
      </div>

      {/* Approval List */}
      {approvalsQuery.isLoading ? (
        <div className="flex items-center justify-center py-12">
          <div className="h-6 w-6 border-2 border-[color:var(--mc-accent)] border-t-transparent rounded-full animate-spin" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-200 p-12 text-center">
          <ShieldCheck className="h-12 w-12 text-slate-300 mx-auto mb-3" />
          <p className="text-slate-500">
            {statusFilter === 'pending'
              ? 'No pending approvals'
              : 'No approvals match your filters.'}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map((approval) => {
            const style = STATUS_STYLES[approval.status] || STATUS_STYLES.pending;
            const Icon = style.icon;
            const isPending = approval.status === 'pending';
            return (
              <Card key={approval.id}>
                <CardContent className="flex items-start gap-4 py-4">
                  <div className={`mt-0.5 shrink-0 ${style.color}`}>
                    <Icon className="h-5 w-5" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-semibold text-slate-900">
                        {approval.requested_by_name}
                      </span>
                      <span className="text-xs text-slate-500">requested approval</span>
                      {approval.board_name && (
                        <span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-100 text-slate-500">
                          {approval.board_name}
                        </span>
                      )}
                    </div>
                    {approval.task_title && (
                      <p className="text-xs text-slate-500 mt-1">
                        Task: {approval.task_title}
                      </p>
                    )}
                    {approval.reason && (
                      <p className="text-xs text-slate-500 mt-1 italic">
                        &quot;{approval.reason}&quot;
                      </p>
                    )}
                    {approval.confidence !== null && (
                      <div className="flex items-center gap-1 mt-1">
                        <span className="text-[10px] text-slate-400">Confidence:</span>
                        <div className="h-1.5 w-20 bg-slate-100 rounded-full overflow-hidden">
                          <div
                            className="h-full bg-[color:var(--mc-accent)] rounded-full"
                            style={{ width: `${Math.round((approval.confidence ?? 0) * 100)}%` }}
                          />
                        </div>
                        <span className="text-[10px] text-slate-400">
                          {Math.round((approval.confidence ?? 0) * 100)}%
                        </span>
                      </div>
                    )}
                    <div className="text-[10px] text-slate-400 mt-2">
                      {formatRelativeTimestamp(approval.created_at)}
                      {approval.reviewed_at && (
                        <> &middot; Reviewed {formatRelativeTimestamp(approval.reviewed_at)}</>
                      )}
                    </div>
                  </div>
                  {isPending && (
                    <div className="flex items-center gap-2 shrink-0">
                      <MCButton
                        variant="primary"
                        size="sm"
                        disabled={decisionMutation.isPending}
                        onClick={() => decisionMutation.mutate({ approval, action: 'approved' })}
                        className="bg-green-600 hover:bg-green-700"
                      >
                        Approve
                      </MCButton>
                      <MCButton
                        variant="outline"
                        size="sm"
                        disabled={decisionMutation.isPending}
                        onClick={() => decisionMutation.mutate({ approval, action: 'rejected' })}
                        className="text-red-600 border-red-200 hover:bg-red-50"
                      >
                        Reject
                      </MCButton>
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </DashboardPageLayout>
  );
}
