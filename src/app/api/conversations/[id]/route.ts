import { NextRequest, NextResponse } from 'next/server';
import pool from '@/lib/db';
import { getRequestUserId } from '@/lib/auth';

/** GET /api/conversations/[id] — get a single conversation (ownership enforced) */
export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const userId = await getRequestUserId(request);
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const { rows } = await pool.query(
      `SELECT id, user_id, title, created_at, updated_at
       FROM conversations
       WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      [params.id, userId]
    );
    if (rows.length === 0) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
    }
    return NextResponse.json({ conversation: rows[0] });
  } catch (err) {
    console.error('Get conversation error:', err);
    return NextResponse.json({ error: 'Failed to get conversation' }, { status: 500 });
  }
}

/** PATCH /api/conversations/[id] — update title (ownership enforced) */
export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const userId = await getRequestUserId(request);
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const body = await request.json() as { title?: string };
    if (!body.title?.trim()) {
      return NextResponse.json({ error: 'Title is required' }, { status: 400 });
    }
    const { rows } = await pool.query(
      `UPDATE conversations
       SET title = $1, updated_at = NOW()
       WHERE id = $2 AND user_id = $3 AND deleted_at IS NULL
       RETURNING id, title, updated_at`,
      [body.title.trim(), params.id, userId]
    );
    if (rows.length === 0) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
    }
    return NextResponse.json({ conversation: rows[0] });
  } catch (err) {
    console.error('Update conversation error:', err);
    return NextResponse.json({ error: 'Failed to update conversation' }, { status: 500 });
  }
}

/** DELETE /api/conversations/[id] — hard-delete conversation + messages (ownership enforced) */
export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const userId = await getRequestUserId(request);
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Verify ownership
    const { rowCount } = await client.query(
      `SELECT 1 FROM conversations WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      [params.id, userId]
    );
    if (rowCount === 0) {
      await client.query('ROLLBACK');
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
    }
    // Delete messages first, then the conversation
    await client.query(`DELETE FROM messages WHERE conversation_id = $1`, [params.id]);
    await client.query(`DELETE FROM conversations WHERE id = $1 AND user_id = $2`, [params.id, userId]);
    await client.query('COMMIT');
    return NextResponse.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Delete conversation error:', err);
    return NextResponse.json({ error: 'Failed to delete conversation' }, { status: 500 });
  } finally {
    client.release();
  }
}
