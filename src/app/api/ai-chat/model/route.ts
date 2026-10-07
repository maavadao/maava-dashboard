import { NextRequest, NextResponse } from 'next/server';
import pool, { getUserId } from '@/lib/db';

const DEFAULT_MODEL = 'openclaw';

function isMissingRelation(err: unknown): boolean {
  const msg = String((err as { message?: string })?.message ?? '').toLowerCase();
  return msg.includes('does not exist') || msg.includes('relation') || msg.includes('user_chat_preferences');
}

async function ensurePreferencesTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_chat_preferences (
      user_id TEXT PRIMARY KEY,
      selected_model TEXT NOT NULL DEFAULT 'openclaw',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

/**
 * GET /api/ai-chat/model
 * Returns current user's preferred chat model.
 */
export async function GET(request: NextRequest) {
  const userId = getUserId(request) ?? request.headers.get('x-user-id') ?? 'anonymous';
  try {
    const { rows } = await pool.query(
      `SELECT selected_model FROM user_chat_preferences WHERE user_id = $1`,
      [userId],
    );

    return NextResponse.json({
      model: rows[0]?.selected_model ?? DEFAULT_MODEL,
    });
  } catch (err) {
    if (isMissingRelation(err)) {
      try {
        await ensurePreferencesTable();
      } catch {
        // ignore create-table failure and fall back to default
      }
    }
    console.error('Get chat model preference error:', err);
    return NextResponse.json({ model: DEFAULT_MODEL });
  }
}

/**
 * PUT /api/ai-chat/model
 * Persist current user's preferred chat model.
 */
export async function PUT(request: NextRequest) {
  const userId = getUserId(request) ?? request.headers.get('x-user-id') ?? 'anonymous';
  try {
    const body = await request.json() as { model?: string };
    const model = body.model?.trim();

    if (!model) {
      return NextResponse.json({ error: 'model is required' }, { status: 400 });
    }

    try {
      await pool.query(
        `INSERT INTO user_chat_preferences (user_id, selected_model, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (user_id)
         DO UPDATE SET selected_model = EXCLUDED.selected_model, updated_at = NOW()`,
        [userId, model],
      );
    } catch (err) {
      if (!isMissingRelation(err)) throw err;
      await ensurePreferencesTable();
      await pool.query(
        `INSERT INTO user_chat_preferences (user_id, selected_model, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (user_id)
         DO UPDATE SET selected_model = EXCLUDED.selected_model, updated_at = NOW()`,
        [userId, model],
      );
    }

    return NextResponse.json({ success: true, model });
  } catch (err) {
    console.error('Save chat model preference error:', err);
    return NextResponse.json({ error: 'Failed to save model preference' }, { status: 500 });
  }
}
