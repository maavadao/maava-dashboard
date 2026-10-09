import { NextRequest, NextResponse } from 'next/server';
import pool, { getUserId } from '@/lib/db';
import { authenticateRequest } from '@/lib/auth';
import { encryptSkillValue } from '@/app/api/skills/connections/route';

const DEFAULT_PREINSTALLED_SKILLS = 52;

/** Ensure bundled skills that ship with the gateway are in the skills catalog. */
async function ensureBundledSkillsInCatalog(): Promise<void> {
  // NOTE: There is no UNIQUE(skill_id, source) constraint on `skills`, so we
  // cannot use ON CONFLICT here. Use NOT EXISTS guards instead — idempotent
  // and avoids the 42P10 ("no unique or exclusion constraint matching the
  // ON CONFLICT specification") error that was failing /api/skills with 500.
  await pool.query(
    `INSERT INTO skills (skill_id, name, description, category, installs, source, source_url)
     SELECT v.skill_id, v.name, v.description, v.category, v.installs, v.source, v.source_url
     FROM (VALUES
       ('seller_data_manager', 'Seller Data Manager', 'Direct SQL access to seller tables — products, assets, listings, social accounts, publishing targets, and analytics. Use [SELLER_SQL] blocks for full CRUD on your storefront data.', 'productivity', 5000, 'openclaw-bundled', 'https://maavadao.com'),
       ('zernio_social', 'Zernio Social Media', 'Manage social media accounts and publish content via Zernio — list accounts, create posts, check status, and delete posts on Instagram, Facebook, LinkedIn, Twitter, and TikTok.', 'productivity', 4000, 'openclaw-bundled', 'https://maavadao.com'),
       ('seller_agent', 'Seller Agent', 'AI selling strategist — plans monthly selling strategies, builds marketing campaigns, creates automated promotion schedules with cron jobs for market research and auto-posting.', 'productivity', 4500, 'openclaw-bundled', 'https://maavadao.com'),
       ('marketing_psychology', 'Marketing Psychology', 'Apply psychological principles, mental models, and behavioral science to marketing — anchoring, social proof, scarcity, loss aversion, framing, persuasion, and pricing psychology.', 'ai-ml', 4200, 'openclaw-bundled', 'https://maavadao.com')
     ) AS v(skill_id, name, description, category, installs, source, source_url)
     WHERE NOT EXISTS (
       SELECT 1 FROM skills s
       WHERE s.skill_id = v.skill_id AND s.source = v.source
     )`,
  );
}

async function ensurePreinstalledSkills(userId: string): Promise<void> {
  if (!userId || userId === 'anonymous') return;

  // Ensure bundled skills exist in the catalog (idempotent)
  await ensureBundledSkillsInCatalog();

  const { rows: countRows } = await pool.query(
    `SELECT COUNT(*)::int AS cnt FROM user_skills WHERE user_id = $1`,
    [userId],
  );
  const installedCount = countRows[0]?.cnt ?? 0;
  if (installedCount >= DEFAULT_PREINSTALLED_SKILLS) return;

  const toAdd = DEFAULT_PREINSTALLED_SKILLS - installedCount;
  if (toAdd <= 0) return;

  // Pick the most popular unique skills for a good default out-of-the-box experience.
  // Default skills are installed but toggled OFF — users can enable them manually.
  await pool.query(
    `INSERT INTO user_skills (user_id, skill_id, source, is_active)
     SELECT $1, ranked.skill_id, ranked.source, FALSE
     FROM (
       SELECT DISTINCT ON (s.skill_id)
         s.skill_id,
         s.source,
         s.installs
       FROM skills s
       ORDER BY s.skill_id, s.installs DESC, s.created_at DESC
     ) ranked
     WHERE NOT EXISTS (
       SELECT 1
       FROM user_skills us
       WHERE us.user_id = $1 AND us.skill_id = ranked.skill_id
     )
     ORDER BY ranked.installs DESC
     LIMIT $2
     ON CONFLICT (user_id, skill_id)
     DO NOTHING`,
    [userId, toAdd],
  );

  // Always ensure web_search is installed and ACTIVE for every user
  await pool.query(
    `INSERT INTO user_skills (user_id, skill_id, source, is_active)
     SELECT $1, s.skill_id, s.source, TRUE
     FROM skills s
     WHERE s.skill_id = 'web_search'
     ORDER BY s.installs DESC
     LIMIT 1
     ON CONFLICT (user_id, skill_id)
     DO UPDATE SET is_active = TRUE`,
    [userId],
  );

  // Always ensure seller_agent and marketing_psychology are installed and ACTIVE
  for (const skillId of ['seller_agent', 'marketing_psychology', 'seller_data_manager']) {
    await pool.query(
      `INSERT INTO user_skills (user_id, skill_id, source, is_active)
       SELECT $1, s.skill_id, s.source, TRUE
       FROM skills s
       WHERE s.skill_id = $2
       ORDER BY s.installs DESC
       LIMIT 1
       ON CONFLICT (user_id, skill_id)
       DO UPDATE SET is_active = TRUE`,
      [userId, skillId],
    );
  }

  // Auto-configure platform Brave API key if the user doesn't have one yet
  const platformBraveKey = process.env.BRAVE_API_KEY;
  if (platformBraveKey) {
    const { rows: existingKey } = await pool.query(
      `SELECT 1 FROM user_skill_api_keys WHERE user_id = $1 AND skill_key = 'brave' AND env_key = 'BRAVE_API_KEY' LIMIT 1`,
      [userId],
    );
    if (existingKey.length === 0) {
      const encrypted = encryptSkillValue(platformBraveKey);
      await pool.query(
        `INSERT INTO user_skill_api_keys (user_id, skill_key, env_key, key_value, updated_at)
         VALUES ($1, 'brave', 'BRAVE_API_KEY', $2, now())
         ON CONFLICT (user_id, skill_key, env_key) DO NOTHING`,
        [userId, encrypted],
      );
    }
  }
}

/**
 * GET /api/skills?q=search&category=ai-ml&page=1&limit=24&sort=installs
 * Returns paginated skills with optional full-text search and category filter.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const q = searchParams.get('q')?.trim() || '';
  const category = searchParams.get('category')?.trim() || '';
  const installed = searchParams.get('installed');
  const includeTotal = searchParams.get('includeTotal') === 'true';
  const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10));
  const limit = Math.min(100, Math.max(1, parseInt(searchParams.get('limit') || '24', 10)));
  const sort = searchParams.get('sort') || 'installs'; // installs | name | newest
  const offset = (page - 1) * limit;

  // When filtering by installed, scope to current user's user_skills.
  // IMPORTANT: must match how /api/skills/install resolves userId — prefer
  // the authenticated JWT subject so the install (writer) and the list
  // (reader) cannot diverge to different user_ids when the cached x-user-id
  // header drifts from the JWT.
  const authedUser = await authenticateRequest(request);
  const userId = authedUser?.userId ?? getUserId(request) ?? request.headers.get('x-user-id') ?? 'anonymous';

  const conditions: string[] = [];
  const params: (string | number)[] = [];
  let paramIdx = 1;

  if (q) {
    conditions.push(`(s.name ILIKE $${paramIdx} OR s.skill_id ILIKE $${paramIdx} OR s.source ILIKE $${paramIdx})`);
    params.push(`%${q}%`);
    paramIdx++;
  }

  if (category && category !== 'all') {
    conditions.push(`s.category = $${paramIdx}`);
    params.push(category);
    paramIdx++;
  }

  const source = searchParams.get('source')?.trim() || '';
  if (source && source !== 'all') {
    conditions.push(`s.source = $${paramIdx}`);
    params.push(source);
    paramIdx++;
  }

  // Always LEFT JOIN user_skills to compute is_installed for the current user
  const userIdParamIdx = paramIdx;
  params.push(userId);
  paramIdx++;

  // installed=true        → only active (truly enabled) skills — ground truth is user_skills
  // installed=recommended  → popular catalog skills user hasn't activated — ground truth is skills table
  // (no installed param)   → full catalog browse, hiding already-active skills
  const isInstalled = installed === 'true';
  const isRecommended = installed === 'recommended';

  let fromClause: string;
  let effectiveOrder: string;
  let selectCols: string;

  if (isInstalled) {
    // Start from user_skills (ground truth) and LEFT JOIN skills for metadata.
    // This ensures skills without a catalog entry (e.g. workspace-created) still appear.
    // NOTE: We intentionally do NOT filter by us.is_active here — the Installed
    // tab must show every skill the user has installed (active OR inactive) so
    // they can toggle them. Pre-installed bundled skills are inserted with
    // is_active=FALSE by ensurePreinstalledSkills(); filtering by TRUE made the
    // tab look empty for new users. The toggle state is exposed via is_installed.
    fromClause = `FROM user_skills us
       LEFT JOIN skills s
         ON s.skill_id = us.skill_id
        AND s.source = us.source`;
    conditions.push(`us.user_id = $${userIdParamIdx}`);
    effectiveOrder = 'us.is_active DESC, us.installed_at DESC';
    selectCols = `us.id, us.skill_id, COALESCE(s.name, us.skill_id) AS name, s.description, COALESCE(s.category, 'general') AS category, COALESCE(s.installs, 0) AS installs, us.source, s.source_url, COALESCE(us.is_active, FALSE) AS is_installed`;
  } else {
    // Recommended & Browse Hub: start from skills catalog.
    // LEFT JOIN only ACTIVE user_skills — so inactive/preinstalled skills still appear as recommendations.
    fromClause = `FROM skills s
       LEFT JOIN user_skills us
         ON us.user_id = $${userIdParamIdx}
        AND us.skill_id = s.skill_id
        AND us.is_active = TRUE`;
    // Exclude skills the user already has active
    if (userId !== 'anonymous') {
      conditions.push(`us.id IS NULL`);
    }
    effectiveOrder =
      sort === 'name' ? 's.name ASC' : sort === 'newest' ? 's.created_at DESC' : 's.installs DESC';
    selectCols = `s.id, s.skill_id, s.name, s.description, s.category, s.installs, s.source, s.source_url, FALSE AS is_installed`;
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    if (isInstalled) {
      try {
        await ensurePreinstalledSkills(userId);
      } catch (seedErr) {
        console.error('[skills] ensurePreinstalledSkills failed', { userId, err: String((seedErr as { message?: string }).message ?? seedErr) });
      }
    }

    const dataRes = await pool.query(
      `SELECT ${selectCols}
       ${fromClause}
       ${where}
       ORDER BY ${effectiveOrder}
       LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
      [...params, limit, offset]
    );

    if (isInstalled) {
      console.log('[skills] installed query', {
        userId,
        authedUserId: authedUser?.userId ?? null,
        rows: dataRes.rows.length,
        sampleSkillIds: dataRes.rows.slice(0, 5).map((r: { skill_id: string; is_installed: boolean }) => `${r.skill_id}:${r.is_installed}`),
      });
    }

    let total: number;
    if (includeTotal) {
      const countRes = await pool.query(`SELECT COUNT(*)::int as total ${fromClause} ${where}`, params);
      total = countRes.rows[0]?.total ?? 0;
    } else {
      // Fast path for interactive UIs (skills dialog, filters): avoid COUNT(*) on large tables.
      total = offset + dataRes.rows.length + (dataRes.rows.length === limit ? 1 : 0);
    }

    return NextResponse.json({
      data: dataRes.rows,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        hasMore: dataRes.rows.length === limit,
      },
    });
  } catch (err) {
    // Gracefully handle missing user_skills table (migration pending)
    const msg = String((err as { message?: string }).message ?? '').toLowerCase();
    if (isInstalled && (msg.includes('user_skills') || msg.includes('does not exist') || msg.includes('relation'))) {
      return NextResponse.json({
        data: [],
        pagination: { page, limit, total: 0, totalPages: 0, hasMore: false },
      });
    }
    console.error('Skills query error:', err);
    return NextResponse.json({ error: 'Failed to fetch skills' }, { status: 500 });
  }
}
