import { NextRequest, NextResponse } from 'next/server';
import pool from '@/lib/db';

/** GET /api/marketplace-agents/[slug] — get a single marketplace agent by slug */
export async function GET(
  request: NextRequest,
  { params }: { params: { slug: string } }
) {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM marketplace_agents WHERE slug = $1`,
      [params.slug]
    );
    if (rows.length === 0) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
    }
    return NextResponse.json({ agent: rows[0] });
  } catch (err) {
    console.error('Get agent error:', err);
    return NextResponse.json({ error: 'Failed to get agent' }, { status: 500 });
  }
}
