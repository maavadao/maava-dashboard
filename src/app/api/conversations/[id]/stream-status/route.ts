import { NextRequest, NextResponse } from 'next/server';
import pool from '@/lib/db';
import { getRequestUserId } from '@/lib/auth';

/**
 * GET /api/conversations/[id]/stream-status
 * Returns the streaming state of a conversation so the frontend can poll
 * for content when resuming after a page refresh / device switch.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const userId = await getRequestUserId(request);
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const convId = params.id;

  try {
    // Verify ownership
    const { rows: convRows } = await pool.query(
      `SELECT is_streaming, streaming_started_at FROM conversations WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      [convId, userId]
    );
    if (convRows.length === 0) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const isStreaming = convRows[0].is_streaming === true;
    const startedAt = convRows[0].streaming_started_at as string | null;

    // Stale stream guard: if streaming started > 10 min ago, consider it dead
    if (isStreaming && startedAt) {
      const elapsed = Date.now() - new Date(startedAt).getTime();
      if (elapsed > 10 * 60 * 1000) {
        // Auto-clear stale streaming flag
        await pool.query(
          `UPDATE conversations SET is_streaming = FALSE, streaming_started_at = NULL WHERE id = $1`,
          [convId]
        );
        return NextResponse.json({ isStreaming: false, content: null });
      }
    }

    if (!isStreaming) {
      return NextResponse.json({ isStreaming: false, content: null });
    }

    // Get the latest assistant message content (the one being streamed)
    const { rows: msgRows } = await pool.query(
      `SELECT id, content FROM messages WHERE conversation_id = $1 AND role = 'assistant' ORDER BY created_at DESC LIMIT 1`,
      [convId]
    );

    // Latest per-action live events for this conversation (best-effort)
    let liveEvents: Array<{ id: string; kind: string; status: string; message: string; created_at: string }> = [];
    try {
      const { rows } = await pool.query(
        `SELECT id, kind, status, message, created_at
           FROM agent_action_events
          WHERE conversation_id = $1 AND user_id = $2
          ORDER BY created_at DESC
          LIMIT 8`,
        [convId, userId]
      );
      liveEvents = rows;
    } catch {
      // Table may not exist on older deployments — silently degrade.
    }

    return NextResponse.json({
      isStreaming: true,
      content: msgRows[0]?.content ?? '',
      messageId: msgRows[0]?.id ?? null,
      startedAt,
      liveEvents,
    });
  } catch (err) {
    // is_streaming column may not exist yet — treat as not streaming
    console.error('[stream-status] query error:', err);
    return NextResponse.json({ isStreaming: false, content: null });
  }
}
