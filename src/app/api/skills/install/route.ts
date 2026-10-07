import { NextRequest, NextResponse } from 'next/server';
import pool, { getUserId } from '@/lib/db';
import { authenticateRequest } from '@/lib/auth';
import { installSingleSkillToGcs } from '@/lib/sync-skills';

/**
 * POST /api/skills/install
 * Adds a skill to the current user's installed skills and bumps the global install counter.
 * Fetches the real SKILL.md from the GitHub source repo (equivalent of `npx clawhub install`)
 * and writes it to GCS so the tenant-platform discovers the skill.
 */
export async function POST(request: NextRequest) {
  const user = await authenticateRequest(request);
  const userId = user?.userId ?? getUserId(request) ?? request.headers.get('x-user-id') ?? 'anonymous';
  try {
    const body = await request.json();
    const { skillId, source } = body as { skillId: string; source: string };

    if (!skillId || !source) {
      return NextResponse.json({ error: 'skillId and source are required' }, { status: 400 });
    }

    // Upsert into user_skills (idempotent)
    await pool.query(
      `INSERT INTO user_skills (user_id, skill_id, source, is_active)
       VALUES ($1, $2, $3, TRUE)
       ON CONFLICT (user_id, skill_id) DO UPDATE SET is_active = TRUE, source = EXCLUDED.source`,
      [userId, skillId, source]
    );

    // Bump global install counter on the skills catalog (best-effort — non-fatal)
    try {
      await pool.query(
        `UPDATE skills SET installs = installs + 1, updated_at = now()
         WHERE skill_id = $1 AND source = $2`,
        [skillId, source]
      );
    } catch {
      // skills catalog table may not exist yet — counter update is non-critical
    }

    // Fetch the real SKILL.md from GitHub and write to GCS
    // This is the programmatic equivalent of: npx clawhub install <owner/repo>
    const rawJwt = request.cookies.get('auth-token')?.value || null;
    void installSingleSkillToGcs(userId, skillId, source, user?.subdomain, rawJwt);

    return NextResponse.json({
      success: true,
      skillId,
      source,
      message: `Skill "${skillId}" installed successfully`,
    });
  } catch (err) {
    console.error('Install error:', err);
    return NextResponse.json({ error: 'Failed to install skill' }, { status: 500 });
  }
}
