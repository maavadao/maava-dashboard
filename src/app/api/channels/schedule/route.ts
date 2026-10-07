/**
 * POST /api/channels/schedule
 * 
 * Creates a scheduled delivery — sends a message to the user's channel(s) on a cron/interval.
 * Called when the AI detects a [SCHEDULE_DELIVERY] block.
 *
 * Body: { text, schedule, platforms?: string[], name?: string }
 *   schedule: "daily" | "hourly" | "weekly" | cron expression
 *
 * GET /api/channels/schedule
 *   Lists the user's scheduled deliveries.
 *
 * DELETE /api/channels/schedule?id=<uuid>
 *   Cancels a scheduled delivery.
 */
import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest } from '@/lib/auth';
import pool from '@/lib/db';
import type { ChannelPlatform } from '@/lib/channel-delivery';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const VALID_PLATFORMS = new Set(['slack', 'telegram', 'discord', 'whatsapp']);

/** Convert friendly schedule names to cron expressions */
function normalizeCron(schedule: string): string {
  const lower = schedule.trim().toLowerCase();
  switch (lower) {
    case 'daily':       return '0 9 * * *';       // 9 AM UTC daily
    case 'hourly':      return '0 * * * *';
    case 'weekly':      return '0 9 * * 1';       // Monday 9 AM UTC
    case 'every 6h':    return '0 */6 * * *';
    case 'every 12h':   return '0 */12 * * *';
    case 'every minute': return '* * * * *';       // testing
    default:
      // Assume it's already a cron expression
      return schedule.trim();
  }
}

// ─── Ensure scheduled_deliveries table exists ──────────────────────────

let _tableReady = false;
async function ensureTable(): Promise<void> {
  if (_tableReady) return;
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS scheduled_deliveries (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name VARCHAR(255),
        message_template TEXT NOT NULL,
        cron_expression VARCHAR(128) NOT NULL,
        platforms JSONB NOT NULL DEFAULT '[]'::jsonb,
        is_active BOOLEAN NOT NULL DEFAULT true,
        last_run_at TIMESTAMPTZ,
        next_run_at TIMESTAMPTZ,
        run_count INT NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_scheduled_deliveries_user_id
        ON scheduled_deliveries(user_id) WHERE is_active = true
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_scheduled_deliveries_next_run
        ON scheduled_deliveries(next_run_at) WHERE is_active = true
    `);
    _tableReady = true;
  } catch { /* table likely exists */ _tableReady = true; }
}

// ─── POST: create a new scheduled delivery ─────────────────────────────

export async function POST(request: NextRequest) {
  const user = await authenticateRequest(request);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const text = typeof body.text === 'string' ? body.text.trim() : '';
  const schedule = typeof body.schedule === 'string' ? body.schedule.trim() : '';
  const name = typeof body.name === 'string' ? body.name.trim() : 'Scheduled message';

  if (!text) return NextResponse.json({ error: 'text is required' }, { status: 400 });
  if (!schedule) return NextResponse.json({ error: 'schedule is required' }, { status: 400 });

  const cronExpr = normalizeCron(schedule);

  const rawPlatforms = Array.isArray(body.platforms) ? body.platforms : [];
  const platforms = rawPlatforms.filter(
    (p): p is string => typeof p === 'string' && VALID_PLATFORMS.has(p.toLowerCase()),
  );

  try {
    await ensureTable();

    const result = await pool.query(
      `INSERT INTO scheduled_deliveries (user_id, name, message_template, cron_expression, platforms)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [user.userId, name, text, cronExpr, JSON.stringify(platforms)],
    );

    console.log(`[schedule] Created delivery "${name}" for user ${user.userId}, cron=${cronExpr}, platforms=${platforms.join(',') || 'all'}`);

    return NextResponse.json({
      ok: true,
      schedule: {
        id: result.rows[0].id,
        name: result.rows[0].name,
        cronExpression: result.rows[0].cron_expression,
        platforms,
        isActive: true,
        createdAt: result.rows[0].created_at,
      },
    }, { status: 201 });
  } catch (err: any) {
    console.error('[api/channels/schedule POST]', err);
    return NextResponse.json({ error: 'Failed to create schedule' }, { status: 500 });
  }
}

// ─── GET: list scheduled deliveries ────────────────────────────────────

export async function GET(request: NextRequest) {
  const user = await authenticateRequest(request);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    await ensureTable();

    const result = await pool.query(
      `SELECT id, name, message_template, cron_expression, platforms,
              is_active, last_run_at, next_run_at, run_count, created_at
       FROM scheduled_deliveries
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [user.userId],
    );

    return NextResponse.json({
      schedules: result.rows.map(r => ({
        id: r.id,
        name: r.name,
        messageTemplate: r.message_template,
        cronExpression: r.cron_expression,
        platforms: r.platforms,
        isActive: r.is_active,
        lastRunAt: r.last_run_at,
        nextRunAt: r.next_run_at,
        runCount: r.run_count,
        createdAt: r.created_at,
      })),
    });
  } catch (err: any) {
    console.error('[api/channels/schedule GET]', err);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}

// ─── DELETE: cancel a scheduled delivery ───────────────────────────────

export async function DELETE(request: NextRequest) {
  const user = await authenticateRequest(request);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');
  if (!id) {
    return NextResponse.json({ error: 'id is required' }, { status: 400 });
  }

  try {
    await ensureTable();

    const result = await pool.query(
      `DELETE FROM scheduled_deliveries WHERE id = $1 AND user_id = $2 RETURNING id`,
      [id, user.userId],
    );

    if (result.rowCount === 0) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    return NextResponse.json({ ok: true });
  } catch (err: any) {
    console.error('[api/channels/schedule DELETE]', err);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
