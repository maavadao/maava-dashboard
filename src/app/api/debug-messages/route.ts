import { NextRequest, NextResponse } from 'next/server';
import pool from '@/lib/db';

/**
 * Temporary diagnostic endpoint — dumps DB state for debugging missing messages.
 * DELETE THIS FILE after the issue is resolved.
 *
 * Usage: GET /api/debug-messages?conv=<conversation_id>
 *    or: GET /api/debug-messages  (overview of all conversations & messages)
 */
export async function GET(request: NextRequest) {
  const convId = request.nextUrl.searchParams.get('conv');

  try {
    const result: Record<string, unknown> = {};

    // 1. Total conversations and messages counts
    const convCount = await pool.query(`SELECT COUNT(*)::int AS cnt FROM conversations`);
    const msgCount = await pool.query(`SELECT COUNT(*)::int AS cnt FROM messages`);
    result.totalConversations = convCount.rows[0]?.cnt ?? 0;
    result.totalMessages = msgCount.rows[0]?.cnt ?? 0;

    // 2. Recent conversations with their message counts
    const recentConvs = await pool.query(
      `SELECT c.id, c.user_id, c.title, c.created_at, c.updated_at, c.deleted_at,
              (SELECT COUNT(*)::int FROM messages m WHERE m.conversation_id = c.id) AS msg_count,
              (SELECT COUNT(*)::int FROM messages m WHERE m.conversation_id = c.id AND m.deleted_at IS NULL) AS live_msg_count
       FROM conversations c
       ORDER BY c.created_at DESC
       LIMIT 20`
    );
    result.recentConversations = recentConvs.rows;

    // 3. If a specific conversation is requested, show its messages
    if (convId) {
      const convDetail = await pool.query(
        `SELECT * FROM conversations WHERE id = $1`,
        [convId]
      );
      result.targetConversation = convDetail.rows[0] ?? null;

      const msgs = await pool.query(
        `SELECT id, conversation_id, role, LEFT(content, 100) AS content_preview, created_at, deleted_at
         FROM messages
         WHERE conversation_id = $1
         ORDER BY created_at ASC`,
        [convId]
      );
      result.targetMessages = msgs.rows;
    }

    // 4. Show a sample of messages with their conversation_ids (to see if they're orphaned)
    const sampleMsgs = await pool.query(
      `SELECT m.id, m.conversation_id, m.role, LEFT(m.content, 80) AS content_preview, m.created_at, m.deleted_at
       FROM messages m
       ORDER BY m.created_at DESC
       LIMIT 20`
    );
    result.recentMessages = sampleMsgs.rows;

    // 5. Check if conversations table has the expected columns
    const cols = await pool.query(
      `SELECT column_name, data_type FROM information_schema.columns
       WHERE table_name = 'messages'
       ORDER BY ordinal_position`
    );
    result.messagesTableColumns = cols.rows;

    const convCols = await pool.query(
      `SELECT column_name, data_type FROM information_schema.columns
       WHERE table_name = 'conversations'
       ORDER BY ordinal_position`
    );
    result.conversationsTableColumns = convCols.rows;

    // 6. Check column defaults (crucial: does messages.id have gen_random_uuid()?)
    const colDefaults = await pool.query(
      `SELECT column_name, column_default, is_nullable
       FROM information_schema.columns
       WHERE table_name = 'messages'
       ORDER BY ordinal_position`
    );
    result.messagesColumnDefaults = colDefaults.rows;

    const convColDefaults = await pool.query(
      `SELECT column_name, column_default, is_nullable
       FROM information_schema.columns
       WHERE table_name = 'conversations'
       ORDER BY ordinal_position`
    );
    result.conversationsColumnDefaults = convColDefaults.rows;

    // 7. Try a test INSERT into messages and see if it succeeds
    // Use a known conversation id from the data
    const testConvId = 'bde8ddc8-0461-43fb-9c6d-4b95c2769e86';
    try {
      const insertResult = await pool.query(
        `INSERT INTO messages (conversation_id, role, content)
         VALUES ($1, $2, $3)
         RETURNING id, conversation_id, role, created_at`,
        [testConvId, 'user', '__debug_test_message__']
      );
      result.testInsert = { success: true, row: insertResult.rows[0] };
      // Clean up the test message
      if (insertResult.rows[0]?.id) {
        await pool.query(`DELETE FROM messages WHERE id = $1`, [insertResult.rows[0].id]);
        result.testInsert.cleaned = true;
      }
    } catch (insertErr) {
      result.testInsert = { success: false, error: String(insertErr) };
    }

    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    console.error('[debug-messages] error:', err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
