/**
 * Runtime feature flags for the realtime communication migration.
 *
 * Each flag is read from a `NEXT_PUBLIC_*` env var so it can be
 * toggled per-deployment without a code change.
 *
 * Defaults are conservative (existing behaviour) so nothing changes
 * until a flag is explicitly flipped.
 */

function env(key: string, fallback: string): string {
  if (typeof window !== "undefined") {
    // Client-side: Next.js inlines NEXT_PUBLIC_ vars at build time
    return (process.env as Record<string, string | undefined>)[key] ?? fallback;
  }
  return process.env[key] ?? fallback;
}

export type StreamStatusMode = "sse" | "poll";
export type ImportRealtimeMode = "true" | "false";
export type ControlPanelMode = "ws" | "poll";

export const REALTIME_FLAGS = {
  /** Phase 1 – stream recovery transport: 'sse' uses Server-Sent Events, 'poll' keeps existing setInterval */
  streamStatus: env("NEXT_PUBLIC_REALTIME_STREAM_STATUS", "poll") as StreamStatusMode,
  /** Phase 2 – import job progress via SSE */
  importSse: env("NEXT_PUBLIC_REALTIME_IMPORT_SSE", "false") as ImportRealtimeMode,
  /** Phase 3 – control-panel events via gateway WS */
  controlPanel: env("OPENCLAW_REALTIME_CONTROL_PANEL", "poll") as ControlPanelMode,
} as const;

export function isStreamStatusSSE(): boolean {
  return REALTIME_FLAGS.streamStatus === "sse";
}
