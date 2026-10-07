"use client";

import * as React from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Activity, CheckCircle2, AlertTriangle, SkipForward } from "lucide-react";
import { useLiveActions, type LiveActionEvent } from "@/hooks/use-live-actions";
import { cn } from "@/lib/utils";

interface LiveActionsPanelProps {
  conversationId: string | null | undefined;
  className?: string;
  /** Maximum number of events to display. */
  limit?: number;
}

function StatusIcon({ status }: { status: string }) {
  if (status === "error")
    return <AlertTriangle className="h-3.5 w-3.5 text-red-500 shrink-0" />;
  if (status === "skipped")
    return <SkipForward className="h-3.5 w-3.5 text-muted-foreground shrink-0" />;
  return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 shrink-0" />;
}

/**
 * Compact "Live actions" feed for the chat page sidebar / footer.
 * Shows the latest per-action events emitted by the backend
 * (CREATE_PRODUCT, PUBLISH_PRODUCT, SCHEDULE_DELIVERY, …).
 */
export function LiveActionsPanel({
  conversationId,
  className,
  limit = 5,
}: LiveActionsPanelProps) {
  const { events, isStreaming } = useLiveActions({ conversationId });

  const visible: LiveActionEvent[] = events.slice(0, limit);

  if (!conversationId) return null;
  if (visible.length === 0 && !isStreaming) return null;

  return (
    <div
      className={cn(
        "rounded-xl border border-border/60 bg-card/60 backdrop-blur-sm p-3",
        className,
      )}
    >
      <div className="flex items-center gap-2 mb-2">
        <Activity className="h-3.5 w-3.5 text-primary" />
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Live actions
        </span>
        {isStreaming && (
          <span className="ml-auto inline-flex h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
        )}
      </div>

      <ul className="space-y-1.5">
        <AnimatePresence initial={false}>
          {visible.map((evt) => (
            <motion.li
              key={evt.id}
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.18 }}
              className="flex items-start gap-2 text-[12px] text-foreground/90 leading-snug"
              title={`${evt.kind} · ${new Date(evt.created_at).toLocaleTimeString()}`}
            >
              <StatusIcon status={evt.status} />
              <span className="truncate">{evt.message}</span>
            </motion.li>
          ))}
        </AnimatePresence>
      </ul>
    </div>
  );
}
