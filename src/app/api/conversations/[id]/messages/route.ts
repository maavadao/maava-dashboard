import { NextRequest, NextResponse } from 'next/server';
import pool from '@/lib/db';
import { getRequestUserId } from '@/lib/auth';

/** Verify the conversation exists and belongs to the requesting user. */
async function verifyOwnership(conversationId: string, userId: string): Promise<boolean> {
  try {
    const { rows } = await pool.query(
      `SELECT id FROM conversations WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      [conversationId, userId]
    );
    return rows.length > 0;
  } catch {
    return false;
  }
}

/** GET /api/conversations/[id]/messages — load all messages for a conversation */
export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const userId = await getRequestUserId(request);
  console.log('[messages GET] convId:', params.id, 'resolvedUserId:', userId, 'x-user-id header:', request.headers.get('x-user-id'));
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const isOwner = await verifyOwnership(params.id, userId);
  console.log('[messages GET] ownership check:', isOwner, 'convId:', params.id, 'userId:', userId);
  if (!isOwner) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  try {
    const { rows } = await pool.query(
      `SELECT id, role, content, created_at FROM messages
       WHERE conversation_id = $1 AND deleted_at IS NULL
       ORDER BY created_at ASC`,
      [params.id]
    );
    console.log('[messages GET] found', rows.length, 'messages (with deleted_at filter) for conv:', params.id);
    // Also check without deleted_at filter to see if there are soft-deleted messages
    const { rows: allRows } = await pool.query(
      `SELECT id, role, content, created_at, deleted_at FROM messages
       WHERE conversation_id = $1
       ORDER BY created_at ASC`,
      [params.id]
    );
    if (allRows.length !== rows.length) {
      console.log('[messages GET] WARNING: total messages (incl deleted):', allRows.length, 'vs live:', rows.length, 'for conv:', params.id);
    }
    // Also return the agentId stored on the conversation (for session restore)
    let agentId: string | null = null;
    try {
      const convRes = await pool.query(
        `SELECT agent_id FROM conversations WHERE id = $1`,
        [params.id]
      );
      agentId = convRes.rows[0]?.agent_id ?? null;
    } catch { /* agent_id column may not exist yet */ }
    let isStreaming = false;
    try {
      const streamRes = await pool.query(
        `SELECT is_streaming FROM conversations WHERE id = $1`,
        [params.id]
      );
      isStreaming = streamRes.rows[0]?.is_streaming === true;
    } catch { /* is_streaming column may not exist yet */ }
    return NextResponse.json({ messages: rows, agentId, isStreaming });
  } catch (firstErr) {
    console.error('[messages GET] primary query failed (deleted_at filter):', firstErr);
    // Fallback: deleted_at column may not exist yet (migration pending)
    try {
      const { rows } = await pool.query(
        `SELECT id, role, content, created_at FROM messages
         WHERE conversation_id = $1
         ORDER BY created_at ASC`,
        [params.id]
      );
      console.log('[messages GET] fallback query found', rows.length, 'messages for conv:', params.id);
      let agentId: string | null = null;
      try {
        const convRes = await pool.query(
          `SELECT agent_id FROM conversations WHERE id = $1`,
          [params.id]
        );
        agentId = convRes.rows[0]?.agent_id ?? null;
      } catch { /* agent_id column may not exist yet */ }
      let isStreaming = false;
      try {
        const streamRes = await pool.query(
          `SELECT is_streaming FROM conversations WHERE id = $1`,
          [params.id]
        );
        isStreaming = streamRes.rows[0]?.is_streaming === true;
      } catch { /* is_streaming column may not exist yet */ }
      return NextResponse.json({ messages: rows, agentId, isStreaming });
    } catch (err2) {
      console.error('[messages GET] fallback query also failed:', err2);
      return NextResponse.json({ error: 'Failed to get messages' }, { status: 500 });
    }
  }
}

/** POST /api/conversations/[id]/messages — save a message */
export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const userId = await getRequestUserId(request);
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  if (!(await verifyOwnership(params.id, userId))) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  try {
    const body = await request.json() as { role: string; content: string };
    if (!body.role || !body.content) {
      return NextResponse.json({ error: 'role and content are required' }, { status: 400 });
    }
    const { rows } = await pool.query(
      `INSERT INTO messages (conversation_id, role, content) VALUES ($1, $2, $3) RETURNING id, role, content, created_at`,
      [params.id, body.role, body.content]
    );
    await pool.query(`UPDATE conversations SET updated_at = NOW() WHERE id = $1`, [params.id]);
    return NextResponse.json({ message: rows[0] }, { status: 201 });
  } catch (err) {
    console.error('Save message error:', err);
    return NextResponse.json({ error: 'Failed to save message' }, { status: 500 });
  }
}
