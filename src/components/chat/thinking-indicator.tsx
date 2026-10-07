/**
 * ThinkingIndicator
 * -----------------
 * Replaces the legacy 3-dot spinner shown while the assistant is generating.
 *
 * Design rationale (5 engagement mechanisms, all opt-in via props):
 *
 *   1. Phased status text ("Reading → Thinking → Composing") — cuts perceived
 *      wait by labelling distinct stages. Driven by elapsed time.
 *   2. Skeleton response shape — three muted bars (100/80/60% width) appear
 *      after 800 ms so the eye fixates on a structure it expects to fill.
 *   3. Live activity pill — surfaces real background work (tool calls,
 *      retrieval, drafting). Falls back silently when the agent has nothing
 *      to show.
 *   4. Reasoning trace — a collapsible disclosure that streams planning
 *      steps. Hidden by default to keep the surface clean for users who
 *      don't want it.
 *   5. Cancel + estimate — appears after 3 s so users always see a way out
 *      and a coarse "remaining" hint. Reduces perceived loss of control.
 *
 * Visual style targets enterprise calm: muted palette, 1 px borders, no
 * cartoonish bouncing dots, no gradients on the chrome itself.
 */
'use client';

import * as React from 'react';
import { Bot, Loader2, Sparkles, X, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

export type ThinkingPhase = 'reading' | 'thinking' | 'composing' | 'finishing';

export interface ReasoningStep {
  id: string;
  /** Short verb-led label ("Searching listings", "Drafting product"). */
  label: string;
  /** Optional details rendered below when the trace is expanded. */
  detail?: string;
  /** Set true once this step is done — switches the bullet to a check. */
  done?: boolean;
}

export interface ThinkingIndicatorProps {
  /** Total elapsed milliseconds since the request was sent. */
  elapsedMs: number;
  /**
   * Optional foreground status text from the agent itself (overrides the
   * phased text). Use this to surface meaningful agent-driven status.
   */
  liveStatus?: string;
  /**
   * Streamed reasoning / tool steps. Drives both the activity pill (most
   * recent step) and the collapsible trace. May be empty.
   */
  steps?: ReasoningStep[];
  /**
   * Coarse "expected total" in seconds, used to render a rough remaining
   * estimate. If omitted, no estimate is shown.
   */
  expectedSeconds?: number;
  /** When provided, renders the cancel link. */
  onCancel?: () => void;
  /** When true, renders a recovery hint after long elapsed time. */
  recovering?: boolean;
}

const PHASES: { phase: ThinkingPhase; label: string; minMs: number }[] = [
  { phase: 'reading', label: 'Reading your message', minMs: 0 },
  { phase: 'thinking', label: 'Thinking', minMs: 1500 },
  { phase: 'composing', label: 'Composing reply', minMs: 4500 },
  { phase: 'finishing', label: 'Finishing up', minMs: 9000 },
];

function pickPhase(elapsedMs: number): ThinkingPhase {
  let current: ThinkingPhase = 'reading';
  for (const p of PHASES) {
    if (elapsedMs >= p.minMs) current = p.phase;
  }
  return current;
}

function phaseLabel(phase: ThinkingPhase): string {
  return PHASES.find((p) => p.phase === phase)?.label ?? '';
}

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  return `${m}m ${rest.toString().padStart(2, '0')}s`;
}

export function ThinkingIndicator({
  elapsedMs,
  liveStatus,
  steps,
  expectedSeconds,
  onCancel,
  recovering,
}: ThinkingIndicatorProps) {
  const [traceOpen, setTraceOpen] = React.useState(false);
  const phase = pickPhase(elapsedMs);
  const showSkeleton = elapsedMs > 800;
  const showCancel = elapsedMs > 3000 && !!onCancel;
  const showEstimate =
    typeof expectedSeconds === 'number' &&
    elapsedMs > 2500 &&
    expectedSeconds * 1000 > elapsedMs;

  const remainingSec = showEstimate
    ? Math.max(1, Math.round(expectedSeconds! - elapsedMs / 1000))
    : null;

  const latestStep = steps && steps.length > 0 ? steps[steps.length - 1] : null;
  const headlineText = liveStatus ?? phaseLabel(phase);

  return (
    <div className="flex gap-3" data-testid="thinking-indicator">
      <div className="h-8 w-8 rounded-xl bg-gradient-to-br from-primary/15 to-violet-500/10 flex items-center justify-center shrink-0 border border-primary/15">
        <Bot className="h-4 w-4 text-primary" />
      </div>

      <div className="min-w-0 flex-1">
        <div className="rounded-2xl px-4 py-3 bg-muted/50 dark:bg-muted/30 border border-border/50 rounded-bl-sm">
          {/* Headline row: phase / elapsed / spinner */}
          <div className="flex items-center gap-2 text-[13px]">
            <Loader2 className="h-3.5 w-3.5 text-muted-foreground animate-spin shrink-0" />
            <span className="font-medium text-foreground/90 truncate">
              {headlineText}
            </span>
            <span
              className="ml-auto text-[11px] tabular-nums text-muted-foreground shrink-0"
              aria-label={`Elapsed time ${formatElapsed(elapsedMs)}`}
            >
              {formatElapsed(elapsedMs)}
              {remainingSec !== null && (
                <span className="text-muted-foreground/60">
                  {' '}· ~{remainingSec}s left
                </span>
              )}
            </span>
          </div>

          {/* Activity pill: latest tool-call / retrieval step. Subtle, monochrome. */}
          {latestStep && (
            <div className="mt-2 inline-flex items-center gap-1.5 rounded-md bg-background/60 dark:bg-background/40 border border-border/40 px-2 py-1 text-[11px] text-muted-foreground">
              <Sparkles className="h-3 w-3 text-primary/70" />
              <span className="truncate max-w-[280px]">{latestStep.label}</span>
            </div>
          )}

          {/* Skeleton response shape — anchors the eye while the agent works */}
          {showSkeleton && (
            <div
              className="mt-3 space-y-1.5"
              role="presentation"
              aria-hidden="true"
            >
              <div className="h-2 w-full rounded-full bg-foreground/5 overflow-hidden relative">
                <div className="absolute inset-0 -translate-x-full animate-shimmer bg-gradient-to-r from-transparent via-foreground/10 to-transparent" />
              </div>
              <div className="h-2 w-4/5 rounded-full bg-foreground/5 overflow-hidden relative">
                <div
                  className="absolute inset-0 -translate-x-full animate-shimmer bg-gradient-to-r from-transparent via-foreground/10 to-transparent"
                  style={{ animationDelay: '120ms' }}
                />
              </div>
              <div className="h-2 w-3/5 rounded-full bg-foreground/5 overflow-hidden relative">
                <div
                  className="absolute inset-0 -translate-x-full animate-shimmer bg-gradient-to-r from-transparent via-foreground/10 to-transparent"
                  style={{ animationDelay: '240ms' }}
                />
              </div>
            </div>
          )}

          {/* Footer row: trace toggle, cancel, recovery hint */}
          {(steps && steps.length > 0) || showCancel || recovering ? (
            <div className="mt-2.5 flex items-center gap-3 text-[11px] text-muted-foreground">
              {steps && steps.length > 0 && (
                <button
                  type="button"
                  onClick={() => setTraceOpen((o) => !o)}
                  className="inline-flex items-center gap-1 hover:text-foreground transition-colors"
                  aria-expanded={traceOpen}
                >
                  <ChevronRight
                    className={cn(
                      'h-3 w-3 transition-transform',
                      traceOpen && 'rotate-90',
                    )}
                  />
                  {traceOpen ? 'Hide reasoning' : `Show reasoning (${steps.length})`}
                </button>
              )}
              {recovering && (
                <span className="inline-flex items-center gap-1">
                  <span className="h-1 w-1 rounded-full bg-amber-500" />
                  Resuming
                </span>
              )}
              {showCancel && (
                <button
                  type="button"
                  onClick={onCancel}
                  className="ml-auto inline-flex items-center gap-1 hover:text-foreground transition-colors"
                >
                  <X className="h-3 w-3" />
                  Cancel
                </button>
              )}
            </div>
          ) : null}

          {/* Reasoning trace — verb-led, monospaced numbering */}
          {traceOpen && steps && steps.length > 0 && (
            <ol className="mt-3 space-y-1.5 border-t border-border/40 pt-2.5 text-[12px]">
              {steps.map((s, i) => (
                <li key={s.id} className="flex items-start gap-2">
                  <span
                    className={cn(
                      'mt-1 h-1.5 w-1.5 rounded-full shrink-0',
                      s.done ? 'bg-emerald-500' : 'bg-primary/50',
                    )}
                    aria-hidden="true"
                  />
                  <div className="min-w-0">
                    <div className="text-foreground/80">
                      <span className="text-muted-foreground/60 tabular-nums mr-1.5">
                        {(i + 1).toString().padStart(2, '0')}
                      </span>
                      {s.label}
                    </div>
                    {s.detail && (
                      <div className="text-muted-foreground text-[11px] mt-0.5 leading-relaxed">
                        {s.detail}
                      </div>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Hook that returns a steadily-updating `elapsedMs` value while `active` is
 * true, and resets back to 0 when it goes false. Updates every 250 ms which
 * is enough granularity for the human eye without churning the React tree.
 */
export function useElapsedMs(active: boolean): number {
  const [elapsed, setElapsed] = React.useState(0);
  const startRef = React.useRef<number | null>(null);

  React.useEffect(() => {
    if (!active) {
      startRef.current = null;
      setElapsed(0);
      return;
    }
    startRef.current = Date.now();
    setElapsed(0);
    const id = setInterval(() => {
      if (startRef.current !== null) {
        setElapsed(Date.now() - startRef.current);
      }
    }, 250);
    return () => clearInterval(id);
  }, [active]);

  return elapsed;
}
