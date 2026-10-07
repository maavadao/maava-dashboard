import { NextRequest, NextResponse } from 'next/server';
import pool, { getUserId } from '@/lib/db';
import { authenticateRequest } from '@/lib/auth';
import { syncSkillsToGcs } from '@/lib/sync-skills';

/**
 * POST /api/skills/toggle
 * Toggles a skill's active status in the current user's installed skills.
 * After DB update, syncs to GCS so the tenant-platform adds/removes the SKILL.md.
 */
export async function POST(request: NextRequest) {
  const user = await authenticateRequest(request);
  const userId = user?.userId ?? getUserId(request) ?? request.headers.get('x-user-id') ?? 'anonymous';
  try {
    const body = await request.json();
    const { skillId, source, enabled } = body as { skillId: string; source?: string; enabled: boolean };

    if (!skillId || typeof enabled !== 'boolean') {
      return NextResponse.json({ error: 'skillId and enabled (boolean) are required' }, { status: 400 });
    }

    const result = source
      ? await pool.query(
          `UPDATE user_skills SET is_active = $1
           WHERE user_id = $2 AND skill_id = $3 AND source = $4
           RETURNING skill_id, source, is_active`,
          [enabled, userId, skillId, source],
        )
      : await pool.query(
          `UPDATE user_skills SET is_active = $1
           WHERE user_id = $2 AND skill_id = $3
           RETURNING skill_id, source, is_active`,
          [enabled, userId, skillId],
        );

    if (result.rowCount === 0) {
      return NextResponse.json({ error: 'Skill not installed for this user' }, { status: 404 });
    }

    // Sync to GCS — adds or removes SKILL.md based on new enabled state
    const rawJwt = request.cookies.get('auth-token')?.value || null;
    void syncSkillsToGcs(userId, user?.subdomain, rawJwt);

    return NextResponse.json({
      success: true,
      skill: {
        skill_id: result.rows[0].skill_id,
        source: result.rows[0].source,
        is_installed: result.rows[0].is_active,
      },
    });
  } catch (err) {
    console.error('Toggle error:', err);
    return NextResponse.json({ error: 'Failed to toggle skill' }, { status: 500 });
  }
}
