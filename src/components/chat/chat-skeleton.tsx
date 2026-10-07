'use client';

import { cn } from '@/lib/utils';

function Pulse({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-md bg-muted/60', className)} />;
}

/**
 * Skeleton that mimics the chat interface layout while history is loading.
 * Renders instantly — no data dependency — so the user sees structure immediately.
 */
export function ChatSkeleton() {
  return (
    <div className="flex flex-col h-full">
      {/* Header skeleton */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-border/40">
        <Pulse className="h-8 w-8 rounded-xl shrink-0" />
        <div className="flex flex-col gap-1.5">
          <Pulse className="h-3.5 w-28" />
          <Pulse className="h-2.5 w-16" />
        </div>
      </div>

      {/* Message area */}
      <div className="flex-1 overflow-hidden px-4 py-6">
        <div className="max-w-3xl mx-auto space-y-6">
          {/* User message (right-aligned) */}
          <div className="flex justify-end">
            <Pulse className="h-10 w-48 rounded-2xl rounded-br-sm" />
          </div>

          {/* Assistant message (left-aligned, longer) */}
          <div className="flex gap-3">
            <Pulse className="h-8 w-8 rounded-xl shrink-0" />
            <div className="flex flex-col gap-2">
              <Pulse className="h-4 w-72" />
              <Pulse className="h-4 w-56" />
              <Pulse className="h-4 w-64" />
            </div>
          </div>

          {/* User message */}
          <div className="flex justify-end">
            <Pulse className="h-10 w-36 rounded-2xl rounded-br-sm" />
          </div>

          {/* Assistant message */}
          <div className="flex gap-3">
            <Pulse className="h-8 w-8 rounded-xl shrink-0" />
            <div className="flex flex-col gap-2">
              <Pulse className="h-4 w-60" />
              <Pulse className="h-4 w-80" />
              <Pulse className="h-4 w-44" />
            </div>
          </div>
        </div>
      </div>

      {/* Input area skeleton */}
      <div className="px-4 pb-4 pt-2">
        <div className="max-w-3xl mx-auto">
          <Pulse className="h-12 w-full rounded-xl" />
        </div>
      </div>
    </div>
  );
}
