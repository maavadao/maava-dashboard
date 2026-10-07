import { NextResponse } from 'next/server';
import pool from '@/lib/db';

/**
 * GET /api/skills/categories
 * Returns distinct categories with counts.
 */
export async function GET() {
  try {
    const res = await pool.query(
      `SELECT category, COUNT(*)::int as count
       FROM skills
       GROUP BY category
       ORDER BY count DESC`
    );

    return NextResponse.json({ categories: res.rows });
  } catch (err) {
    const msg = String((err as { message?: string }).message ?? '').toLowerCase();
    if (msg.includes('does not exist') || msg.includes('relation') || msg.includes('skill')) {
      return NextResponse.json({ categories: [] });
    }
    console.error('Categories query error:', err);
    return NextResponse.json({ error: 'Failed to fetch categories' }, { status: 500 });
  }
}
