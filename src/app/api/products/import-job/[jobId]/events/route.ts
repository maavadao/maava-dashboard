import { NextRequest } from "next/server";
import { authenticateRequest } from "@/lib/auth";
import pool from "@/lib/db";

/**
 * GET /api/products/import-job/[jobId]/events
 *
 * Server-Sent Events endpoint that pushes import-job status changes.
 * Replaces the 2 s setInterval polling in ImportMarketModal.
 *
 * Feature flag: NEXT_PUBLIC_REALTIME_IMPORT_SSE=true
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const POLL_INTERVAL_MS = 2_000;
const HEARTBEAT_INTERVAL_MS = 15_000;
const MAX_LIFETIME_MS = 10 * 60 * 1000; // 10 min (jobs can be slow)

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const user = await authenticateRequest(request);
  if (!user) {
    return new Response("Unauthorized", { status: 401 });
  }

  const { jobId } = await params;

  // Verify job belongs to user
  const { rows } = await pool.query(
    `SELECT id FROM import_jobs WHERE id = $1 AND user_id = $2`,
    [jobId, user.userId],
  );
  if (rows.length === 0) {
    return new Response("Not found", { status: 404 });
  }

  const encoder = new TextEncoder();
  const startTime = Date.now();

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;

      function send(event: string, data: Record<string, unknown>) {
        if (closed) return;
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      }

      function heartbeat() {
        if (closed) return;
        controller.enqueue(encoder.encode(": heartbeat\n\n"));
      }

      function close() {
        if (closed) return;
        closed = true;
        clearInterval(pollTimer);
        clearInterval(heartbeatTimer);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }

      async function tick() {
        if (closed) return;

        if (Date.now() - startTime > MAX_LIFETIME_MS) {
          send("timeout", { reason: "max_lifetime" });
          close();
          return;
        }

        try {
          const { rows: jobRows } = await pool.query(
            `SELECT id, status, product_count, error_count, error_message
             FROM import_jobs WHERE id = $1 AND user_id = $2`,
            [jobId, user.userId],
          );

          if (jobRows.length === 0) {
            send("error", { message: "not_found" });
            close();
            return;
          }

          const r = jobRows[0];
          const payload = {
            id: r.id,
            status: r.status,
            productCount: r.product_count ?? 0,
            errorCount: r.error_count ?? 0,
            errorMessage: r.error_message ?? null,
          };

          const terminal = r.status === "completed" || r.status === "failed";
          send(terminal ? "done" : "progress", payload);

          if (terminal) {
            close();
          }
        } catch (err) {
          console.error("[import-job-events] query error:", err);
          send("error", { message: "internal error" });
          close();
        }
      }

      tick();
      const pollTimer = setInterval(tick, POLL_INTERVAL_MS);
      const heartbeatTimer = setInterval(heartbeat, HEARTBEAT_INTERVAL_MS);

      request.signal.addEventListener("abort", () => {
        close();
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
