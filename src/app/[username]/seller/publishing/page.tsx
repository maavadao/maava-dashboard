'use client';

import { useEffect, useState, useCallback } from 'react';
import { Card, Button, Skeleton } from '@/components/ui';
import {
  Send, Clock, CheckCircle2, AlertCircle, XCircle,
  ExternalLink, Loader2, RefreshCw,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { api } from '@/lib/api';
import type { PublishingJob, PublishingJobStatus } from '@/types';

const STATUS_STYLES: Record<PublishingJobStatus, { icon: typeof Send; color: string; bg: string }> = {
  pending: { icon: Clock, color: 'text-gray-600 dark:text-gray-400', bg: 'bg-gray-100 dark:bg-gray-800' },
  scheduled: { icon: Clock, color: 'text-blue-600 dark:text-blue-400', bg: 'bg-blue-100 dark:bg-blue-900/30' },
  publishing: { icon: Loader2, color: 'text-amber-600 dark:text-amber-400', bg: 'bg-amber-100 dark:bg-amber-900/30' },
  published: { icon: CheckCircle2, color: 'text-emerald-600 dark:text-emerald-400', bg: 'bg-emerald-100 dark:bg-emerald-900/30' },
  failed: { icon: XCircle, color: 'text-red-600 dark:text-red-400', bg: 'bg-red-100 dark:bg-red-900/30' },
  cancelled: { icon: XCircle, color: 'text-gray-600 dark:text-gray-400', bg: 'bg-gray-100 dark:bg-gray-800' },
};

export default function PublishingPage() {
  const [jobs, setJobs] = useState<PublishingJob[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<PublishingJobStatus | 'all'>('all');
  const [cancellingId, setCancellingId] = useState<string | null>(null);

  const loadJobs = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const params: { status?: string } = {};
      if (statusFilter !== 'all') params.status = statusFilter;
      const result = await api.listPublishingJobs(params);
      setJobs(result.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load jobs');
    } finally {
      setIsLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => {
    void loadJobs();
  }, [loadJobs]);

  const handleCancel = useCallback(async (jobId: string) => {
    setCancellingId(jobId);
    try {
      const updated = await api.cancelPublishingJob(jobId);
      setJobs((prev) => prev.map((j) => (j.id === jobId ? updated : j)));
    } catch {
      // ignore cancel errors
    } finally {
      setCancellingId(null);
    }
  }, []);

  const filters: { value: PublishingJobStatus | 'all'; label: string }[] = [
    { value: 'all', label: 'All' },
    { value: 'pending', label: 'Pending' },
    { value: 'scheduled', label: 'Scheduled' },
    { value: 'published', label: 'Published' },
    { value: 'failed', label: 'Failed' },
  ];

  return (
    <div className="p-6 md:p-8 max-w-5xl">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Publishing</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Track and manage your publishing jobs across all channels
          </p>
        </div>
        <Button variant="outline" onClick={loadJobs} className="gap-1.5" disabled={isLoading}>
          <RefreshCw className={cn('h-4 w-4', isLoading && 'animate-spin')} />
          Refresh
        </Button>
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

      {/* Job List */}
      {isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-20 rounded-lg" />
          ))}
        </div>
      ) : jobs.length === 0 ? (
        <Card className="p-8 border border-dashed text-center">
          <Send className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
          <p className="text-sm font-medium text-foreground mb-1">No publishing jobs</p>
          <p className="text-xs text-muted-foreground">
            Publish a listing from a product page to see jobs here.
          </p>
        </Card>
      ) : (
        <div className="space-y-3">
          {jobs.map((job) => {
            const style = STATUS_STYLES[job.status];
            const StatusIcon = style.icon;
            return (
              <Card key={job.id} className="p-4 border border-border">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3 flex-1 min-w-0">
                    <div className={cn('w-8 h-8 rounded-full flex items-center justify-center', style.bg)}>
                      <StatusIcon className={cn('h-4 w-4', style.color, job.status === 'publishing' && 'animate-spin')} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <h3 className="font-medium text-foreground text-sm truncate">
                          {job.productName || 'Product'}
                        </h3>
                        <span className="text-[10px] px-2 py-0.5 rounded-full bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 font-medium">
                          {job.channel}
                        </span>
                      </div>
                      <div className="flex items-center gap-3 mt-0.5">
                        <span className={cn('text-[10px] font-medium', style.color)}>
                          {job.status}
                        </span>
                        {job.scheduledAt && (
                          <span className="text-[10px] text-muted-foreground flex items-center gap-1">
                            <Clock className="h-3 w-3" />
                            {new Date(job.scheduledAt).toLocaleString()}
                          </span>
                        )}
                        {job.publishedAt && (
                          <span className="text-[10px] text-emerald-600 dark:text-emerald-400">
                            Published {new Date(job.publishedAt).toLocaleString()}
                          </span>
                        )}
                      </div>
                      {job.lastError && (
                        <p className="text-[10px] text-red-600 dark:text-red-400 mt-1 truncate">{job.lastError}</p>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 ml-4">
                    {(job.status === 'pending' || job.status === 'scheduled') && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-xs h-7 text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950/30"
                        onClick={() => handleCancel(job.id)}
                        disabled={cancellingId === job.id}
                      >
                        {cancellingId === job.id ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <XCircle className="h-3 w-3" />
                        )}
                        Cancel
                      </Button>
                    )}
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
