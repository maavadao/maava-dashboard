import { NextRequest, NextResponse } from 'next/server';
import pool, { getUserId } from '@/lib/db';
import { authenticateRequest } from '@/lib/auth';
import { syncSkillsToGcs } from '@/lib/sync-skills';

/**
 * POST /api/skills/uninstall
 * Removes a skill from the current user's installed skills.
 * After DB delete, syncs to GCS so the tenant-platform removes the stale SKILL.md.
 */
export async function POST(request: NextRequest) {
  const user = await authenticateRequest(request);
  const userId = user?.userId ?? getUserId(request) ?? request.headers.get('x-user-id') ?? 'anonymous';
  try {
    const body = await request.json();
    const { skillId, source } = body as { skillId: string; source?: string };

    if (!skillId) {
      return NextResponse.json({ error: 'skillId is required' }, { status: 400 });
    }

    const result = source
      ? await pool.query(
          `DELETE FROM user_skills
           WHERE user_id = $1 AND skill_id = $2 AND source = $3
           RETURNING skill_id, source`,
          [userId, skillId, source],
        )
      : await pool.query(
          `DELETE FROM user_skills
           WHERE user_id = $1 AND skill_id = $2
           RETURNING skill_id, source`,
          [userId, skillId],
        );

    if (result.rowCount === 0) {
      return NextResponse.json({ error: 'Skill not found for this user' }, { status: 404 });
    }

    // Sync to GCS — removes the SKILL.md and updates openclaw.json
    const rawJwt = request.cookies.get('auth-token')?.value || null;
    void syncSkillsToGcs(userId, user?.subdomain, rawJwt);

    return NextResponse.json({
      success: true,
      skillId: result.rows[0].skill_id,
      source: result.rows[0].source,
      message: `Skill "${skillId}" uninstalled successfully`,
    });
  } catch (err) {
    console.error('Uninstall error:', err);
    return NextResponse.json({ error: 'Failed to uninstall skill' }, { status: 500 });
  }
}
