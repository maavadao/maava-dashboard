'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import { REALTIME_FLAGS } from '@/lib/feature-flags';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  Button,
} from '@/components/ui';
import {
  Plus,
  X,
  Download,
  Loader2,
  CheckCircle2,
  AlertCircle,
  Link2,
} from 'lucide-react';

type JobStatus =
  | 'idle'
  | 'submitting'
  | 'queued'
  | 'running'
  | 'saving_raw_file'
  | 'uploading_to_bucket'
  | 'ingesting_to_db'
  | 'completed'
  | 'failed';

interface JobInfo {
  id: string;
  status: JobStatus;
  productCount: number;
  errorCount: number;
  errorMessage: string | null;
}

const STATUS_LABELS: Record<string, string> = {
  queued: 'Queued — waiting to start…',
  running: 'Scanning marketplace links…',
  saving_raw_file: 'Saving raw data…',
  uploading_to_bucket: 'Uploading to storage…',
  ingesting_to_db: 'Importing products to database…',
  completed: 'Import complete!',
  failed: 'Import failed',
};

export function ImportMarketModal({
  open,
  onOpenChange,
  onImportComplete,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImportComplete?: () => void;
}) {
  const [links, setLinks] = useState<string[]>(['']);
  const [agreedCopyright, setAgreedCopyright] = useState(false);
  const [job, setJob] = useState<JobInfo | null>(null);
  const [phase, setPhase] = useState<'form' | 'progress'>('form');
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const evtSourceRef = useRef<EventSource | null>(null);

  // Clean up polling / SSE on unmount
  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      if (evtSourceRef.current) evtSourceRef.current.close();
    };
  }, []);

  const resetForm = useCallback(() => {
    setLinks(['']);
    setAgreedCopyright(false);
    setJob(null);
    setPhase('form');
    setError(null);
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    if (evtSourceRef.current) {
      evtSourceRef.current.close();
      evtSourceRef.current = null;
    }
  }, []);

  const handleClose = useCallback(
    (isOpen: boolean) => {
      if (!isOpen) {
        resetForm();
      }
      onOpenChange(isOpen);
    },
    [onOpenChange, resetForm],
  );

  const addLink = () => {
    if (links.length >= 20) return;
    setLinks((prev) => [...prev, '']);
  };

  const removeLink = (index: number) => {
    setLinks((prev) => prev.filter((_, i) => i !== index));
  };

  const updateLink = (index: number, value: string) => {
    setLinks((prev) => prev.map((l, i) => (i === index ? value : l)));
  };

  const validLinks = links
    .map((l) => l.trim())
    .filter((l) => {
      try {
        const u = new URL(l);
        return ['http:', 'https:'].includes(u.protocol);
      } catch {
        return false;
      }
    });

  const canSubmit = validLinks.length > 0 && agreedCopyright;

  const startPoll = useCallback((jobId: string) => {
    // ── SSE mode ──
    if (REALTIME_FLAGS.importSse === 'true') {
      if (evtSourceRef.current) evtSourceRef.current.close();
      const es = new EventSource(`/api/products/import-job/${encodeURIComponent(jobId)}/events`);
      evtSourceRef.current = es;

      function handleData(e: MessageEvent) {
        try {
          const data = JSON.parse(e.data);
          setJob({
            id: data.id,
            status: data.status,
            productCount: data.productCount ?? 0,
            errorCount: data.errorCount ?? 0,
            errorMessage: data.errorMessage ?? null,
          });
          if (data.status === 'completed' || data.status === 'failed') {
            es.close();
            evtSourceRef.current = null;
            if (data.status === 'completed') onImportComplete?.();
          }
        } catch { /* ignore */ }
      }

      es.addEventListener('progress', handleData);
      es.addEventListener('done', handleData);
      es.addEventListener('error', () => {
        // On SSE error, fall back silently — user can refresh
        es.close();
        evtSourceRef.current = null;
      });
      return;
    }

    // ── Polling mode (default) ──
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/products/import-job/${jobId}`);
        if (!res.ok) return;
        const data = await res.json();
        setJob({
          id: data.id,
          status: data.status,
          productCount: data.productCount ?? 0,
          errorCount: data.errorCount ?? 0,
          errorMessage: data.errorMessage ?? null,
        });
        if (data.status === 'completed' || data.status === 'failed') {
          if (pollRef.current) clearInterval(pollRef.current);
          pollRef.current = null;
          if (data.status === 'completed') {
            onImportComplete?.();
          }
        }
      } catch {
        // ignore transient errors
      }
    }, 2000);
  }, [onImportComplete]);

  const handleSubmit = async () => {
    setError(null);
    setPhase('progress');
    setJob({ id: '', status: 'submitting', productCount: 0, errorCount: 0, errorMessage: null });

    try {
      const res = await fetch('/api/products/import-job', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ links: validLinks }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Request failed (${res.status})`);
      }

      const data = await res.json();
      setJob({
        id: data.id,
        status: data.status || 'queued',
        productCount: 0,
        errorCount: 0,
        errorMessage: null,
      });
      startPoll(data.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
      setPhase('form');
      setJob(null);
    }
  };

  const isRunning =
    job &&
    !['completed', 'failed', 'idle', 'submitting'].includes(job.status) &&
    job.status !== 'submitting';

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-[540px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Download className="h-5 w-5" />
            Import from my market
          </DialogTitle>
          <DialogDescription>
            Paste your marketplace shop or product URLs. We&apos;ll use AI to
            extract your product listings and import them as drafts.
          </DialogDescription>
        </DialogHeader>

        {phase === 'form' && (
          <>
            {/* Link inputs */}
            <div className="space-y-2 max-h-[300px] overflow-y-auto pr-1">
              {links.map((link, i) => (
                <div key={i} className="flex items-center gap-2">
                  <div className="relative flex-1">
                    <Link2 className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <input
                      type="url"
                      placeholder="https://etsy.com/shop/my-store"
                      value={link}
                      onChange={(e) => updateLink(i, e.target.value)}
                      className="w-full pl-9 pr-3 py-2 rounded-lg border border-border bg-background text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/40 transition-all"
                    />
                  </div>
                  {links.length > 1 && (
                    <button
                      type="button"
                      onClick={() => removeLink(i)}
                      className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  )}
                </div>
              ))}
            </div>

            {links.length < 20 && (
              <button
                type="button"
                onClick={addLink}
                className="flex items-center gap-1.5 text-sm text-primary hover:text-primary/80 font-medium transition-colors"
              >
                <Plus className="h-3.5 w-3.5" />
                Add another link
              </button>
            )}

            {/* Copyright agreement */}
            <label className="flex items-start gap-3 mt-2 p-3 rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800/40 cursor-pointer">
              <input
                type="checkbox"
                checked={agreedCopyright}
                onChange={(e) => setAgreedCopyright(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-border"
              />
              <span className="text-xs text-amber-800 dark:text-amber-300 leading-relaxed">
                I confirm that I own or have the right to import these products.
                Only publicly visible product data will be extracted. Products
                will be imported as drafts for review.
              </span>
            </label>

            {error && (
              <div className="p-2.5 rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800/50 flex items-start gap-2 text-xs text-red-700 dark:text-red-400">
                <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                {error}
              </div>
            )}

            <DialogFooter>
              <Button variant="outline" onClick={() => handleClose(false)}>
                Cancel
              </Button>
              <Button
                disabled={!canSubmit}
                onClick={handleSubmit}
                className="gap-1.5"
              >
                <Download className="h-4 w-4" />
                Start Import ({validLinks.length} link{validLinks.length !== 1 ? 's' : ''})
              </Button>
            </DialogFooter>
          </>
        )}

        {phase === 'progress' && job && (
          <div className="py-4 space-y-4">
            {/* Status indicator */}
            <div className="flex items-center gap-3">
              {job.status === 'completed' ? (
                <CheckCircle2 className="h-6 w-6 text-emerald-500" />
              ) : job.status === 'failed' ? (
                <AlertCircle className="h-6 w-6 text-red-500" />
              ) : (
                <Loader2 className="h-6 w-6 text-primary animate-spin" />
              )}
              <div>
                <p className="text-sm font-medium text-foreground">
                  {STATUS_LABELS[job.status] || 'Processing…'}
                </p>
                {(isRunning || job.status === 'submitting') && (
                  <p className="text-xs text-muted-foreground mt-0.5">
                    This may take a minute or two depending on the number of products.
                  </p>
                )}
              </div>
            </div>

            {/* Progress steps */}
            <div className="space-y-1.5 pl-1">
              {[
                { key: 'running', label: 'Scanning marketplace pages' },
                { key: 'saving_raw_file', label: 'Saving raw data' },
                { key: 'uploading_to_bucket', label: 'Uploading to storage' },
                { key: 'ingesting_to_db', label: 'Importing to database' },
              ].map((step) => {
                const stepOrder = ['queued', 'running', 'saving_raw_file', 'uploading_to_bucket', 'ingesting_to_db', 'completed'];
                const currentIdx = stepOrder.indexOf(job.status);
                const stepIdx = stepOrder.indexOf(step.key);
                const isDone = currentIdx > stepIdx;
                const isActive = currentIdx === stepIdx;

                return (
                  <div key={step.key} className="flex items-center gap-2 text-xs">
                    {isDone ? (
                      <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
                    ) : isActive ? (
                      <Loader2 className="h-3.5 w-3.5 text-primary animate-spin" />
                    ) : (
                      <div className="h-3.5 w-3.5 rounded-full border border-border" />
                    )}
                    <span
                      className={
                        isDone
                          ? 'text-emerald-600 dark:text-emerald-400'
                          : isActive
                            ? 'text-foreground font-medium'
                            : 'text-muted-foreground'
                      }
                    >
                      {step.label}
                    </span>
                  </div>
                );
              })}
            </div>

            {/* Results */}
            {job.status === 'completed' && (
              <div className="p-3 rounded-lg bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800/40">
                <p className="text-sm text-emerald-700 dark:text-emerald-300 font-medium">
                  {job.productCount} product{job.productCount !== 1 ? 's' : ''} imported as draft
                  {job.errorCount > 0 && (
                    <span className="text-amber-600 dark:text-amber-400 font-normal ml-1">
                      ({job.errorCount} skipped)
                    </span>
                  )}
                </p>
              </div>
            )}

            {job.status === 'failed' && (
              <div className="p-3 rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800/50">
                <p className="text-sm text-red-700 dark:text-red-400">
                  {job.errorMessage || 'An unexpected error occurred. Please try again.'}
                </p>
              </div>
            )}

            <DialogFooter>
              {(job.status === 'completed' || job.status === 'failed') && (
                <>
                  {job.status === 'failed' && (
                    <Button
                      variant="outline"
                      onClick={() => {
                        setPhase('form');
                        setJob(null);
                        setError(null);
                      }}
                    >
                      Try Again
                    </Button>
                  )}
                  <Button onClick={() => handleClose(false)}>
                    {job.status === 'completed' ? 'Done' : 'Close'}
                  </Button>
                </>
              )}
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
