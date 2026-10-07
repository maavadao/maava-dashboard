import { NextRequest, NextResponse } from 'next/server';
import pool from '@/lib/db';
import { getRequestUserId } from '@/lib/auth';

/** GET /api/conversations — list all conversations for a user */
export async function GET(request: NextRequest) {
  const userId = await getRequestUserId(request);
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  try {
    const { rows } = await pool.query(
      `WITH selected AS (
         SELECT c.id, c.title, c.created_at, c.updated_at,
                COALESCE(c.is_streaming, FALSE) AS is_streaming
         FROM conversations c
         WHERE c.user_id = $1 AND c.deleted_at IS NULL
         ORDER BY c.updated_at DESC
         LIMIT 100
       )
       SELECT s.id, s.title, s.created_at, s.updated_at, s.is_streaming,
              COALESCE(m.cnt, 0)::int AS message_count
       FROM selected s
       LEFT JOIN (
         SELECT m.conversation_id, COUNT(*)::int AS cnt
         FROM messages m
         WHERE m.deleted_at IS NULL
           AND m.conversation_id IN (SELECT id FROM selected)
         GROUP BY m.conversation_id
       ) m ON m.conversation_id = s.id
       ORDER BY s.updated_at DESC`,
      [userId]
    );
    return NextResponse.json({ conversations: rows });
  } catch {
    // Fallback: deleted_at column may not exist yet (migration pending)
    try {
      const { rows } = await pool.query(
        `WITH selected AS (
           SELECT c.id, c.title, c.created_at, c.updated_at,
                  COALESCE(c.is_streaming, FALSE) AS is_streaming
           FROM conversations c
           WHERE c.user_id = $1
           ORDER BY c.updated_at DESC
           LIMIT 100
         )
         SELECT s.id, s.title, s.created_at, s.updated_at, s.is_streaming,
                COALESCE(m.cnt, 0)::int AS message_count
         FROM selected s
         LEFT JOIN (
           SELECT m.conversation_id, COUNT(*)::int AS cnt
           FROM messages m
           WHERE m.conversation_id IN (SELECT id FROM selected)
           GROUP BY m.conversation_id
         ) m ON m.conversation_id = s.id
         ORDER BY s.updated_at DESC`,
        [userId]
      );
      return NextResponse.json({ conversations: rows });
    } catch (err2) {
      console.error('List conversations error:', err2);
      return NextResponse.json({ error: 'Failed to list conversations' }, { status: 500 });
    }
  }
}

/** POST /api/conversations — create a new conversation */
export async function POST(request: NextRequest) {
  const userId = await getRequestUserId(request);
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  try {
    const body = await request.json() as { title?: string; agentId?: string };
    const title = body.title || 'New Chat';
    const agentId = body.agentId ?? null;
    try {
      const { rows } = await pool.query(
        `INSERT INTO conversations (user_id, title, agent_id) VALUES ($1, $2, $3) RETURNING id, title, created_at, updated_at`,
        [userId, title, agentId]
      );
      return NextResponse.json({ conversation: rows[0] }, { status: 201 });
    } catch {
      // agent_id column may not exist yet — fall back to basic insert
      const { rows } = await pool.query(
        `INSERT INTO conversations (user_id, title) VALUES ($1, $2) RETURNING id, title, created_at, updated_at`,
        [userId, title]
      );
      return NextResponse.json({ conversation: rows[0] }, { status: 201 });
    }
  } catch (err) {
    console.error('Create conversation error:', err);
    return NextResponse.json({ error: 'Failed to create conversation' }, { status: 500 });
  }
}
