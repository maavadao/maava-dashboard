"use client";

import * as React from "react";

export interface LiveActionEvent {
  id: string;
  kind: string;
  status: string; // success | error | skipped
  message: string;
  created_at: string;
}

interface UseLiveActionsOptions {
  conversationId: string | null | undefined;
  /** Poll interval in ms while the conversation is active. */
  intervalMs?: number;
  /** When false, the hook stops polling. */
  enabled?: boolean;
}

/**
 * useLiveActions — poll `/api/conversations/[id]/stream-status` for the
 * latest per-action events emitted server-side by `ActionExecutorService`.
 *
 * Keeps the chat sidebar "Live actions" feed in sync without requiring SSE.
 * Polling is paused automatically when the tab is hidden.
 */
export function useLiveActions({
  conversationId,
  intervalMs = 4000,
  enabled = true,
}: UseLiveActionsOptions): {
  events: LiveActionEvent[];
  isStreaming: boolean;
} {
  const [events, setEvents] = React.useState<LiveActionEvent[]>([]);
  const [isStreaming, setIsStreaming] = React.useState(false);

  React.useEffect(() => {
    if (!enabled || !conversationId) {
      setEvents([]);
      setIsStreaming(false);
      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      if (cancelled) return;
      if (typeof document !== "undefined" && document.hidden) {
        timer = setTimeout(tick, intervalMs);
        return;
      }
      try {
        const res = await fetch(
          `/api/conversations/${encodeURIComponent(conversationId)}/stream-status`,
          { cache: "no-store", credentials: "include" },
        );
        if (res.ok) {
          const data = await res.json();
          if (!cancelled) {
            if (Array.isArray(data.liveEvents)) setEvents(data.liveEvents);
            setIsStreaming(Boolean(data.isStreaming));
          }
        }
      } catch {
        /* network blip — retry on next tick */
      } finally {
        if (!cancelled) timer = setTimeout(tick, intervalMs);
      }
    };

    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [conversationId, intervalMs, enabled]);

  return { events, isStreaming };
}
