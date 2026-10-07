import { NextRequest, NextResponse } from 'next/server';
import pool from '@/lib/db';
import { getRequestUserId } from '@/lib/auth';

function isMissingRelation(err: unknown): boolean {
  const msg = String((err as { message?: string })?.message ?? '').toLowerCase();
  return msg.includes('does not exist') || msg.includes('relation') || msg.includes('user_onboarding_preferences');
}

async function ensureTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_onboarding_preferences (
      user_id TEXT PRIMARY KEY,
      interests TEXT[] NOT NULL DEFAULT '{}',
      provider TEXT NOT NULL DEFAULT 'moonshot',
      onboarding_completed_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

/**
 * GET /api/user-preferences
 * Returns the current user's onboarding preferences.
 */
export async function GET(request: NextRequest) {
  const userId = await getRequestUserId(request);
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const { rows } = await pool.query(
      `SELECT interests, provider, onboarding_completed_at FROM user_onboarding_preferences WHERE user_id = $1`,
      [userId],
    );

    if (rows.length === 0) {
      return NextResponse.json({ interests: [], provider: 'moonshot' });
    }

    return NextResponse.json({
      interests: rows[0].interests ?? [],
      provider: rows[0].provider ?? 'moonshot',
      onboardingCompletedAt: rows[0].onboarding_completed_at,
    });
  } catch (err) {
    if (isMissingRelation(err)) {
      try { await ensureTable(); } catch { /* ignore */ }
    }
    console.error('Get user preferences error:', err);
    return NextResponse.json({ interests: [], provider: 'moonshot' });
  }
}

/**
 * PUT /api/user-preferences
 * Persist the current user's onboarding preferences (interests, provider).
 */
export async function PUT(request: NextRequest) {
  const userId = await getRequestUserId(request);
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const body = await request.json() as { interests?: string[]; provider?: string };

    const interests = Array.isArray(body.interests)
      ? body.interests.filter((i): i is string => typeof i === 'string').slice(0, 20)
      : undefined;

    const provider = typeof body.provider === 'string' ? body.provider.trim() : undefined;

    if (!interests && !provider) {
      return NextResponse.json({ error: 'interests or provider is required' }, { status: 400 });
    }

    const setClauses: string[] = ['updated_at = NOW()', 'onboarding_completed_at = COALESCE(user_onboarding_preferences.onboarding_completed_at, NOW())'];
    const insertCols = ['user_id'];
    const insertVals = ['$1'];
    const params: (string | string[])[] = [userId];
    let idx = 2;

    if (interests !== undefined) {
      insertCols.push('interests');
      insertVals.push(`$${idx}`);
      setClauses.push(`interests = $${idx}`);
      params.push(interests);
      idx++;
    }

    if (provider !== undefined) {
      insertCols.push('provider');
      insertVals.push(`$${idx}`);
      setClauses.push(`provider = $${idx}`);
      params.push(provider);
      idx++;
    }

    const sql = `
      INSERT INTO user_onboarding_preferences (${insertCols.join(', ')})
      VALUES (${insertVals.join(', ')})
      ON CONFLICT (user_id)
      DO UPDATE SET ${setClauses.join(', ')}
    `;

    try {
      await pool.query(sql, params);
    } catch (err) {
      if (!isMissingRelation(err)) throw err;
      await ensureTable();
      await pool.query(sql, params);
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('Save user preferences error:', err);
    return NextResponse.json({ error: 'Failed to save preferences' }, { status: 500 });
  }
}
