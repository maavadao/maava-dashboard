import * as React from "react";
import type { UIMessage } from "ai";
import { isStreamStatusSSE } from "@/lib/feature-flags";

/**
 * Stream-recovery status payload (shared between SSE and polling).
 */
interface StreamStatusData {
  isStreaming: boolean;
  content?: string | null;
  messageId?: string | null;
  startedAt?: string | null;
}

type SetMessages = React.Dispatch<React.SetStateAction<UIMessage[]>>;

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Apply polled / pushed content to the last assistant message (or append a
 *  fresh one if the last message is the user's — covers the multi-tab race
 *  where the placeholder hasn't been created locally yet). */
function applyContent(
  setMessages: SetMessages,
  content: string | null | undefined,
  /** If true, only update when the new content is longer than the current text. */
  onlyIfLonger = false,
  messageId?: string | null,
) {
  if (!content) return;
  setMessages((prev) => {
    const updated = [...prev];
    const lastIdx = updated.length - 1;

    // No assistant message yet (e.g. tab 2 opened mid-stream before the
    // placeholder got persisted) — append one so the user sees the response.
    if (lastIdx < 0 || updated[lastIdx].role !== "assistant") {
      updated.push({
        id: messageId || `recovered-${Date.now()}`,
        role: "assistant",
        parts: [{ type: "text" as const, text: content }],
      } as UIMessage);
      return updated;
    }

    if (onlyIfLonger) {
      const currentText =
        updated[lastIdx].parts
          ?.filter((p): p is { type: "text"; text: string } => p.type === "text")
          .map((p) => p.text)
          .join("") ?? "";
      if (content.length <= currentText.length) return prev;
    }

    updated[lastIdx] = {
      ...updated[lastIdx],
      parts: [{ type: "text" as const, text: content }],
    };
    return updated;
  });
}

// ── SSE-based stream recovery (Phase 1) ─────────────────────────────────────

function useSSEStreamRecovery(
  conversationId: string | undefined,
  userId: string,
  setMessages: SetMessages,
  isStreamRecovery: boolean,
): { recovering: boolean; setRecovering: React.Dispatch<React.SetStateAction<boolean>> } {
  const [recovering, setRecovering] = React.useState(isStreamRecovery);

  React.useEffect(() => {
    if (!recovering || !conversationId) return;

    const evtSource = new EventSource(
      `/api/conversations/${encodeURIComponent(conversationId)}/stream-events`,
    );

    function handleStatus(e: MessageEvent) {
      try {
        const data: StreamStatusData = JSON.parse(e.data);
        applyContent(setMessages, data.content, false, data.messageId);
        if (!data.isStreaming) {
          setRecovering(false);
        }
      } catch {
        /* malformed frame — ignore */
      }
    }

    function handleDone(e: MessageEvent) {
      try {
        const data: StreamStatusData = JSON.parse(e.data);
        applyContent(setMessages, data.content, false, data.messageId);
      } catch {
        /* ignore */
      }
      setRecovering(false);
    }

    function handleError() {
      // EventSource auto-reconnects on transient failures.
      // If the server is truly gone, close after a few attempts.
      evtSource.close();
      setRecovering(false);
    }

    evtSource.addEventListener("status", handleStatus);
    evtSource.addEventListener("done", handleDone);
    evtSource.addEventListener("timeout", handleDone);
    evtSource.addEventListener("error", handleError);

    return () => {
      evtSource.close();
    };
  }, [recovering, conversationId, userId, setMessages]);

  return { recovering, setRecovering };
}

// ── Polling-based stream recovery (existing behaviour) ──────────────────────

function usePollStreamRecovery(
  conversationId: string | undefined,
  userId: string,
  setMessages: SetMessages,
  isStreamRecovery: boolean,
): { recovering: boolean; setRecovering: React.Dispatch<React.SetStateAction<boolean>> } {
  const [recovering, setRecovering] = React.useState(isStreamRecovery);

  React.useEffect(() => {
    if (!recovering || !conversationId) return;
    let cancelled = false;

    const poll = async () => {
      try {
        const res = await fetch(
          `/api/conversations/${conversationId}/stream-status`,
          { headers: { "x-user-id": userId } },
        );
        if (!res.ok || cancelled) return;
        const data: StreamStatusData = await res.json();
        if (cancelled) return;
        applyContent(setMessages, data.content, false, data.messageId);
        if (!data.isStreaming) {
          setRecovering(false);
        }
      } catch {
        /* polling error — retry next interval */
      }
    };

    poll();
    const timer = setInterval(poll, 1500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [recovering, conversationId, userId, setMessages]);

  return { recovering, setRecovering };
}

// ── Public hook (feature-flag routed) ───────────────────────────────────────

/**
 * Unified stream-recovery hook.
 *
 * When `NEXT_PUBLIC_REALTIME_STREAM_STATUS=sse` → uses SSE push.
 * Otherwise → uses the existing 1.5 s polling loop (default, safe).
 */
export function useStreamRecovery(
  conversationId: string | undefined,
  userId: string,
  setMessages: SetMessages,
  isStreamRecovery: boolean,
) {
  if (isStreamStatusSSE()) {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    return useSSEStreamRecovery(conversationId, userId, setMessages, isStreamRecovery);
  }
  // eslint-disable-next-line react-hooks/rules-of-hooks
  return usePollStreamRecovery(conversationId, userId, setMessages, isStreamRecovery);
}

// ── Post-stream DB sync ─────────────────────────────────────────────────────

/**
 * After streaming ends, action blocks may still be processing server-side.
 * This hook briefly polls (or uses SSE) to catch the final DB content.
 *
 * When SSE mode is active, we open a short-lived SSE connection that
 * auto-closes once the server confirms `isStreaming = false`.
 */
export function usePostStreamSync(
  conversationId: string | undefined,
  userId: string,
  status: string,
  setMessages: SetMessages,
) {
  const armedRef = React.useRef(false);

  React.useEffect(() => {
    if (status === "streaming") {
      armedRef.current = true;
      return;
    }
    if (status !== "ready" || !armedRef.current || !conversationId) return;
    armedRef.current = false;

    if (isStreamStatusSSE()) {
      // SSE mode: open connection, wait for done, then close
      const evtSource = new EventSource(
        `/api/conversations/${encodeURIComponent(conversationId)}/stream-events`,
      );

      function handleEvent(e: MessageEvent) {
        try {
          const data: StreamStatusData = JSON.parse(e.data);
          applyContent(setMessages, data.content, true, data.messageId);
          if (!data.isStreaming) {
            evtSource.close();
          }
        } catch {
          /* ignore */
        }
      }

      evtSource.addEventListener("status", handleEvent);
      evtSource.addEventListener("done", (e) => {
        handleEvent(e);
        evtSource.close();
      });
      evtSource.addEventListener("timeout", () => evtSource.close());
      evtSource.addEventListener("error", () => evtSource.close());

      return () => {
        evtSource.close();
      };
    }

    // Polling fallback (existing behaviour)
    let cancelled = false;
    let pollCount = 0;
    const maxPolls = 20;

    const syncPoll = async () => {
      if (cancelled || pollCount >= maxPolls) {
        if (syncTimer) clearInterval(syncTimer);
        return;
      }
      pollCount++;
      try {
        const res = await fetch(
          `/api/conversations/${conversationId}/stream-status`,
          { headers: { "x-user-id": userId } },
        );
        if (!res.ok || cancelled) return;
        const data: StreamStatusData = await res.json();
        if (cancelled) return;
        applyContent(setMessages, data.content, true, data.messageId);
        if (!data.isStreaming) {
          if (syncTimer) clearInterval(syncTimer);
        }
      } catch {
        /* best-effort */
      }
    };

    const syncTimer = setInterval(syncPoll, 1500);
    syncPoll();
    return () => {
      cancelled = true;
      clearInterval(syncTimer);
    };
  }, [status, conversationId, userId, setMessages]);
}
