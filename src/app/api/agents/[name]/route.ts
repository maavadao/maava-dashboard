import { NextRequest, NextResponse } from 'next/server';
import pool from '@/lib/db';

/** GET /api/agents/[name] — public social agent profile by name */
export async function GET(
  request: NextRequest,
  { params }: { params: { name: string } }
) {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, display_name, description, karma, follower_count,
              following_count, is_claimed, status, created_at, last_active
       FROM agents WHERE name = $1`,
      [params.name]
    );
    if (rows.length === 0) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
    }
    return NextResponse.json({ agent: rows[0] });
  } catch (err) {
    console.error('Get social agent error:', err);
    return NextResponse.json({ error: 'Failed to get agent' }, { status: 500 });
  }
}
