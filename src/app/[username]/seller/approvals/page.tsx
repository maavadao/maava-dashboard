'use client';

import { useEffect, useState, useCallback } from 'react';
import { Card, Button, Skeleton } from '@/components/ui';
import {
  CheckCircle2, XCircle, Clock, AlertCircle, Loader2, Eye,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { api } from '@/lib/api';
import type { ApprovalRequest, ApprovalStatus } from '@/types';

export default function ApprovalsPage() {
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<ApprovalStatus | 'all'>('all');
  const [reviewingId, setReviewingId] = useState<string | null>(null);

  const loadApprovals = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const params: { status?: string } = {};
      if (statusFilter !== 'all') params.status = statusFilter;
      const result = await api.listApprovalRequests(params);
      setApprovals(result.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load approvals');
    } finally {
      setIsLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => {
    void loadApprovals();
  }, [loadApprovals]);

  const handleReview = useCallback(async (approvalId: string, status: 'approved' | 'rejected', notes?: string) => {
    setReviewingId(approvalId);
    try {
      const updated = await api.reviewApproval(approvalId, { status, reviewerNotes: notes });
      setApprovals((prev) => prev.map((a) => (a.id === approvalId ? updated : a)));
    } catch {
      // silently fail
    } finally {
      setReviewingId(null);
    }
  }, []);

  const filters: { value: ApprovalStatus | 'all'; label: string }[] = [
    { value: 'all', label: 'All' },
    { value: 'pending', label: 'Pending' },
    { value: 'approved', label: 'Approved' },
    { value: 'rejected', label: 'Rejected' },
  ];

  return (
    <div className="p-6 md:p-8 max-w-5xl">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-foreground">Approvals</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Review and approve listings, visuals, and publishing requests before they go live
        </p>
      </div>

      {error && (
        <div className="mb-6 p-3 rounded-xl bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800/50 flex items-start gap-2 text-sm text-red-700 dark:text-red-400">
          <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
          {error}
        </div>
      )}

      {/* Filters */}
      <div className="flex items-center gap-1 p-1 bg-muted rounded-xl mb-6 w-fit">
        {filters.map((f) => (
          <button
            key={f.value}
            type="button"
            onClick={() => setStatusFilter(f.value)}
            className={cn(
              'px-4 py-1.5 rounded-lg text-[12px] font-semibold transition-all duration-200',
              statusFilter === f.value
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* Approval List */}
      {isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-24 rounded-lg" />
          ))}
        </div>
      ) : approvals.length === 0 ? (
        <Card className="p-8 border border-dashed text-center">
          <CheckCircle2 className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
          <p className="text-sm font-medium text-foreground mb-1">No approval requests</p>
          <p className="text-xs text-muted-foreground">
            {statusFilter === 'pending'
              ? "No pending approvals — you're all caught up!"
              : 'Approval requests will appear here when listings or publications need review.'}
          </p>
        </Card>
      ) : (
        <div className="space-y-3">
          {approvals.map((approval) => (
            <Card key={approval.id} className="p-4 border border-border">
              <div className="flex items-start justify-between">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span
                      className={cn(
                        'text-[10px] px-2 py-0.5 rounded-full font-medium',
                        approval.requestType === 'listing'
                          ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400'
                          : approval.requestType === 'publish'
                            ? 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400'
                            : approval.requestType === 'visual'
                              ? 'bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-400'
                              : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400',
                      )}
                    >
                      {approval.requestType}
                    </span>
                    <h3 className="font-medium text-foreground text-sm truncate">
                      {approval.productName || 'Product'}
                    </h3>
                    <span
                      className={cn(
                        'text-[10px] px-2 py-0.5 rounded-full font-medium',
                        approval.status === 'pending'
                          ? 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400'
                          : approval.status === 'approved'
                            ? 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400'
                            : 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400',
                      )}
                    >
                      {approval.status}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Submitted {new Date(approval.submittedAt).toLocaleString()}
                    {approval.reviewedAt && ` · Reviewed ${new Date(approval.reviewedAt).toLocaleString()}`}
                  </p>
                  {approval.reviewerNotes && (
                    <p className="text-xs text-muted-foreground mt-1 italic">&ldquo;{approval.reviewerNotes}&rdquo;</p>
                  )}
                </div>

                {approval.status === 'pending' && (
                  <div className="flex items-center gap-2 ml-4">
                    <Button
                      variant="outline"
                      size="sm"
                      className="text-xs h-7 gap-1 text-emerald-600 border-emerald-200 hover:bg-emerald-50 dark:hover:bg-emerald-950/30"
                      onClick={() => handleReview(approval.id, 'approved')}
                      disabled={reviewingId === approval.id}
                    >
                      {reviewingId === approval.id ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <CheckCircle2 className="h-3 w-3" />
                      )}
                      Approve
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="text-xs h-7 gap-1 text-red-600 border-red-200 hover:bg-red-50 dark:hover:bg-red-950/30"
                      onClick={() => handleReview(approval.id, 'rejected')}
                      disabled={reviewingId === approval.id}
                    >
                      <XCircle className="h-3 w-3" />
                      Reject
                    </Button>
                  </div>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
