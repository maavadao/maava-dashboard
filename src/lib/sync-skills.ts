/**
 * Syncs a user's active skills from the database to their GCS-mounted
 * workspace so the tenant-platform can discover them as SKILL.md files.
 *
 * Architecture:
 *   Dashboard DB (user_skills + skills catalog)
 *     → Fetch real SKILL.md from GitHub source repos (equivalent to `npx clawhub install`)
 *     → GCS bucket: {userId}/mountfolder/skills/{slug}/SKILL.md
 *     → GCS bucket: {userId}/mountfolder/openclaw.json (skills.entries section)
 *     → Live gateway: config.patch notification
 *
 * The tenant-platform's loadWorkspaceSkillEntries() scans the workspace/skills/
 * directory for SKILL.md files. This sync bridges the dashboard UI to that
 * filesystem-based discovery.
 *
 * For each skill, we try to fetch the real SKILL.md from its GitHub source repo
 * (using the `source` owner/repo and `source_url` fields from the skills catalog).
 * If the fetch fails, we fall back to generating a SKILL.md from DB metadata.
 *
 * Called after every skill install / uninstall / toggle / API-key-save.
 * Non-fatal — logs on failure without throwing.
 */

import pool from '@/lib/db';
import { readUserConfig, writeUserConfig, SHARED_BUCKET } from '@/lib/gcs';
import { getSkillApiKeysForUser } from '@/app/api/skills/connections/route';

const STORAGE_URL = process.env.STORAGE_URL || '';
const STORAGE_API_SECRET = process.env.STORAGE_API_SECRET || '';

/** Max size for fetched SKILL.md content (200KB) — reject oversized responses */
const MAX_SKILL_MD_SIZE = 200 * 1024;
/** Timeout for individual GitHub fetch attempts */
const GITHUB_FETCH_TIMEOUT_MS = 8000;
/** Only allow fetching from this domain */
const ALLOWED_RAW_HOST = 'raw.githubusercontent.com';

function bmHeaders(): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (STORAGE_API_SECRET) h['X-Storage-Secret'] = STORAGE_API_SECRET;
  return h;
}

// ── Types ────────────────────────────────────────────────────────────────────

type ActiveSkillRow = {
  skill_id: string;
  name: string;
  description: string | null;
  category: string | null;
  source: string;
  source_url: string | null;
};

// ── GitHub SKILL.md fetching ─────────────────────────────────────────────────

/**
 * Convert a github.com tree/blob URL to a raw.githubusercontent.com URL.
 * e.g. https://github.com/openclaw/skills/tree/main/skills/author/slug/SKILL.md
 *   → https://raw.githubusercontent.com/openclaw/skills/main/skills/author/slug/SKILL.md
 */
function githubTreeToRaw(url: string): string | null {
  const m = url.match(
    /^https:\/\/github\.com\/([^/]+\/[^/]+)\/(?:tree|blob)\/(.+)$/,
  );
  if (!m) return null;
  return `https://${ALLOWED_RAW_HOST}/${m[1]}/${m[2]}`;
}

/**
 * Build candidate raw GitHub URLs to try for a given skill.
 *
 * Two source patterns exist in the DB:
 *
 * 1. awesome-openclaw: source_url points directly to the SKILL.md tree URL
 *    → convert to raw URL directly
 *
 * 2. skills.sh / generic: source = "owner/repo", source_url = repo root URL
 *    → try multiple conventional paths where SKILL.md may live
 */
function buildGitHubCandidateUrls(skill: ActiveSkillRow): string[] {
  const urls: string[] = [];
  const slug = skill.skill_id;

  // Case 1: source_url is a direct tree/blob link to SKILL.md
  if (
    skill.source_url &&
    /\/tree\/|\blob\//.test(skill.source_url) &&
    skill.source_url.endsWith('/SKILL.md')
  ) {
    const raw = githubTreeToRaw(skill.source_url);
    if (raw) urls.push(raw);
  }

  // Case 2: source is "owner/repo" format — try conventional SKILL.md paths
  const ownerRepo = skill.source;
  if (ownerRepo && /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(ownerRepo)) {
    for (const branch of ['main', 'master']) {
      const base = `https://${ALLOWED_RAW_HOST}/${ownerRepo}/${branch}`;
      // Most common: skills/{slug}/SKILL.md (multi-skill repos)
      urls.push(`${base}/skills/${slug}/SKILL.md`);
      // mawa convention: .openclaw/skills/{slug}/SKILL.md
      urls.push(`${base}/.openclaw/skills/${slug}/SKILL.md`);
      // Flat: {slug}/SKILL.md
      urls.push(`${base}/${slug}/SKILL.md`);
      // Single-skill repo: SKILL.md at root
      urls.push(`${base}/SKILL.md`);
    }
  }

  return urls;
}

/**
 * Try to fetch the real SKILL.md from GitHub source.
 * Returns the content string on success, or null if all attempts fail.
 */
async function fetchSkillMdFromGitHub(skill: ActiveSkillRow): Promise<string | null> {
  const urls = buildGitHubCandidateUrls(skill);
  if (urls.length === 0) return null;

  for (const url of urls) {
    try {
      // Validate URL points to allowed host only (prevent SSRF)
      const parsed = new URL(url);
      if (parsed.hostname !== ALLOWED_RAW_HOST) continue;

      const res = await fetch(url, {
        headers: { 'Accept': 'text/plain' },
        signal: AbortSignal.timeout(GITHUB_FETCH_TIMEOUT_MS),
        redirect: 'follow',
      });

      if (!res.ok) continue;

      // Check content-length if available
      const cl = res.headers.get('content-length');
      if (cl && parseInt(cl, 10) > MAX_SKILL_MD_SIZE) {
        console.warn(`[fetchSkillMd] ${skill.skill_id}: response too large (${cl} bytes), skipping`);
        continue;
      }

      const text = await res.text();
      if (text.length > MAX_SKILL_MD_SIZE) continue;

      // Validate it looks like a SKILL.md (has YAML frontmatter or meaningful content)
      if (text.startsWith('---') || text.startsWith('#') || text.length > 100) {
        console.log(`[fetchSkillMd] ${skill.skill_id}: fetched real SKILL.md from ${url}`);
        return text;
      }
    } catch {
      // Timeout or network error — try next URL
    }
  }

  return null;
}

// ── SKILL.md fallback generation ─────────────────────────────────────────────

/**
 * Build a fallback SKILL.md from catalog metadata when the real file can't be
 * fetched from GitHub.
 */
function buildFallbackSkillMd(skill: ActiveSkillRow): string {
  const slug = skill.skill_id;
  const name = skill.name || slug;
  const description = skill.description || `${name} skill`;
  const category = skill.category || 'general';

  const lines = [
    '---',
    `name: ${slug}`,
    `description: >`,
    `  ${description}`,
    `user-invocable: true`,
    `disable-model-invocation: false`,
    `metadata: {"openclaw":{"emoji":"⚡","always":false}}`,
    '---',
    '',
    `# ${name}`,
    '',
    `**Category:** ${category}`,
    '',
    `## What This Skill Does`,
    description,
    '',
    `## When to Use`,
    `- When the user asks about ${name.toLowerCase()} functionality`,
    `- When the conversation topic relates to ${category.toLowerCase()}`,
    '',
  ];

  if (skill.source_url) {
    lines.push(`## Source`, `- ${skill.source_url}`, '');
  }

  return lines.join('\n');
}

/**
 * Get SKILL.md content for a skill: tries to fetch the real file from
 * the GitHub source repo first, falls back to generating from DB metadata.
 */
async function getSkillMdContent(skill: ActiveSkillRow): Promise<string> {
  // Try fetching the real SKILL.md from the source repo
  const real = await fetchSkillMdFromGitHub(skill);
  if (real) return real;

  // Fall back to generated stub
  console.log(`[getSkillMdContent] ${skill.skill_id}: using generated fallback SKILL.md`);
  return buildFallbackSkillMd(skill);
}

// ── GCS file operations ──────────────────────────────────────────────────────

async function writeSkillFile(userId: string, skillSlug: string, content: string): Promise<boolean> {
  if (!STORAGE_URL) return false;
  const filePath = `${userId}/mountfolder/skills/${skillSlug}/SKILL.md`;
  try {
    const res = await fetch(
      `${STORAGE_URL}/api/v1/buckets/${encodeURIComponent(SHARED_BUCKET)}/files/${filePath}`,
      { method: 'PUT', headers: bmHeaders(), body: content },
    );
    return res.ok;
  } catch {
    return false;
  }
}

async function deleteSkillFolder(userId: string, skillSlug: string): Promise<boolean> {
  if (!STORAGE_URL) return false;
  const folderPath = `${userId}/mountfolder/skills/${skillSlug}`;
  try {
    const res = await fetch(
      `${STORAGE_URL}/api/v1/buckets/${encodeURIComponent(SHARED_BUCKET)}/folders/${folderPath}`,
      { method: 'DELETE', headers: bmHeaders() },
    );
    return res.ok;
  } catch {
    return false;
  }
}

// ── Gateway notification ─────────────────────────────────────────────────────

async function getGatewayUrl(subdomain: string | null | undefined): Promise<string | null> {
  if (!subdomain) return null;
  try {
    const result = await pool.query<{ runtime_endpoint: string }>(
      `SELECT runtime_endpoint FROM agents WHERE subdomain = $1 AND runtime_endpoint IS NOT NULL LIMIT 1`,
      [subdomain],
    );
    return result.rows[0]?.runtime_endpoint?.trim() || null;
  } catch {
    return null;
  }
}

async function notifyGateway(
  gatewayUrl: string,
  userJwt: string,
  skillsPatch: Record<string, unknown>,
): Promise<void> {
  try {
    const res = await fetch(`${gatewayUrl}/api/v1/config/patch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${userJwt}`,
      },
      body: JSON.stringify({ raw: JSON.stringify({ skills: skillsPatch }) }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      console.warn(`[syncSkillsToGcs] Gateway config.patch returned HTTP ${res.status}`);
    } else {
      console.log('[syncSkillsToGcs] Gateway notified — skills config updated');
    }
  } catch (err) {
    console.warn('[syncSkillsToGcs] Gateway unreachable (non-fatal):', (err as Error).message);
  }
}

// ── Main sync ────────────────────────────────────────────────────────────────

/**
 * Full skills sync: reads active skills from DB, writes SKILL.md files to GCS,
 * removes stale skill folders, updates openclaw.json with entries config,
 * and notifies the live gateway.
 */
export async function syncSkillsToGcs(
  userId: string,
  subdomain?: string | null,
  userJwt?: string | null,
): Promise<void> {
  if (!STORAGE_URL) {
    console.warn('[syncSkillsToGcs] STORAGE_URL not set — skipping');
    return;
  }

  // 1. Fetch user's active skills with catalog metadata
  let activeSkills: ActiveSkillRow[];
  try {
    const { rows } = await pool.query<ActiveSkillRow>(
      `SELECT s.skill_id, s.name, s.description, s.category, s.source, s.source_url
       FROM user_skills us
       JOIN skills s ON s.skill_id = us.skill_id AND s.source = us.source
       WHERE us.user_id = $1 AND us.is_active = TRUE`,
      [userId],
    );
    activeSkills = rows;
  } catch (err) {
    console.error('[syncSkillsToGcs] DB query failed:', err);
    return;
  }

  // 2. Fetch previously synced skills from GCS folder listing
  let existingSkillSlugs: string[] = [];
  try {
    const listPath = `${userId}/mountfolder/skills`;
    const res = await fetch(
      `${STORAGE_URL}/api/v1/buckets/${encodeURIComponent(SHARED_BUCKET)}/folders/${listPath}`,
      { headers: bmHeaders() },
    );
    if (res.ok) {
      const data = (await res.json()) as { folders?: string[]; files?: string[] };
      existingSkillSlugs = (data.folders || []).map((f: string) =>
        f.replace(/\/$/, '').split('/').pop() || '',
      ).filter(Boolean);
    }
  } catch {
    // First sync — no existing skills directory
  }

  const activeSlugs = new Set(activeSkills.map((s) => s.skill_id));

  // 3. Fetch real SKILL.md from GitHub (or generate fallback) and write to GCS
  const writeResults: string[] = [];
  const fetchedFromGitHub: string[] = [];
  for (const skill of activeSkills) {
    const md = await getSkillMdContent(skill);
    const ok = await writeSkillFile(userId, skill.skill_id, md);
    if (ok) {
      writeResults.push(skill.skill_id);
      // Track which came from GitHub vs fallback
      if (!md.includes('## What This Skill Does')) {
        fetchedFromGitHub.push(skill.skill_id);
      }
    }
  }
  if (writeResults.length > 0) {
    console.log(
      `[syncSkillsToGcs] Wrote ${writeResults.length} SKILL.md files for user ${userId}` +
        (fetchedFromGitHub.length > 0 ? ` (${fetchedFromGitHub.length} fetched from GitHub)` : ''),
    );
  }

  // 4. Remove skill folders that are no longer active
  const staleSlugs = existingSkillSlugs.filter((slug) => !activeSlugs.has(slug));
  for (const slug of staleSlugs) {
    const ok = await deleteSkillFolder(userId, slug);
    if (ok) {
      console.log(`[syncSkillsToGcs] Removed stale skill folder: ${slug}`);
    }
  }

  // 5. Update openclaw.json with skills.entries (env vars + enabled flags)
  let skillApiKeys: Record<string, Record<string, string>> = {};
  try {
    skillApiKeys = await getSkillApiKeysForUser(userId);
  } catch {
    // proceed without API keys
  }

  const skillEntries: Record<string, Record<string, unknown>> = {};
  for (const skill of activeSkills) {
    const entry: Record<string, unknown> = { enabled: true };
    const keys = skillApiKeys[skill.skill_id];
    if (keys && Object.keys(keys).length > 0) {
      entry.env = { ...keys };
    }
    skillEntries[skill.skill_id] = entry;
  }

  let config: Record<string, unknown> = {};
  try {
    const existing = await readUserConfig(userId);
    if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
      config = { ...(existing as Record<string, unknown>) };
    }
  } catch {
    // proceed with empty config
  }

  const existingSkills =
    config.skills && typeof config.skills === 'object' && !Array.isArray(config.skills)
      ? { ...(config.skills as Record<string, unknown>) }
      : {};

  existingSkills.entries = skillEntries;
  config.skills = existingSkills;

  try {
    await writeUserConfig(userId, config);
    console.log(`[syncSkillsToGcs] Updated openclaw.json skills.entries for user ${userId}`);
  } catch (err) {
    console.error('[syncSkillsToGcs] GCS config write failed:', err);
  }

  // 6. Notify the live gateway
  if (userJwt) {
    const gatewayUrl = await getGatewayUrl(subdomain);
    if (gatewayUrl) {
      await notifyGateway(gatewayUrl, userJwt, existingSkills);
    }
  }
}

/**
 * Lightweight sync: only updates openclaw.json skills.entries (for API key changes).
 * Does not re-write SKILL.md files or scan for stale folders.
 */
export async function syncSkillEnvToGcs(
  userId: string,
  subdomain?: string | null,
  userJwt?: string | null,
): Promise<void> {
  if (!STORAGE_URL) return;

  // Fetch active skills
  let activeSlugs: string[];
  try {
    const { rows } = await pool.query<{ skill_id: string }>(
      `SELECT skill_id FROM user_skills WHERE user_id = $1 AND is_active = TRUE`,
      [userId],
    );
    activeSlugs = rows.map((r) => r.skill_id);
  } catch {
    return;
  }

  // Fetch API keys
  let skillApiKeys: Record<string, Record<string, string>> = {};
  try {
    skillApiKeys = await getSkillApiKeysForUser(userId);
  } catch {
    // proceed without
  }

  // Build entries
  const skillEntries: Record<string, Record<string, unknown>> = {};
  for (const slug of activeSlugs) {
    const entry: Record<string, unknown> = { enabled: true };
    const keys = skillApiKeys[slug];
    if (keys && Object.keys(keys).length > 0) {
      entry.env = { ...keys };
    }
    skillEntries[slug] = entry;
  }

  // Update openclaw.json
  let config: Record<string, unknown> = {};
  try {
    const existing = await readUserConfig(userId);
    if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
      config = { ...(existing as Record<string, unknown>) };
    }
  } catch {
    // empty
  }

  const existingSkills =
    config.skills && typeof config.skills === 'object' && !Array.isArray(config.skills)
      ? { ...(config.skills as Record<string, unknown>) }
      : {};

  existingSkills.entries = skillEntries;
  config.skills = existingSkills;

  try {
    await writeUserConfig(userId, config);
  } catch (err) {
    console.error('[syncSkillEnvToGcs] GCS config write failed:', err);
  }

  // Notify gateway
  if (userJwt) {
    const gatewayUrl = await getGatewayUrl(subdomain);
    if (gatewayUrl) {
      await notifyGateway(gatewayUrl, userJwt, existingSkills);
    }
  }
}

// ── Single-skill install (fast path) ─────────────────────────────────────────

/**
 * Install a single skill by fetching its SKILL.md from GitHub and writing to GCS.
 * This is the programmatic equivalent of `npx clawhub install <owner/repo>`.
 *
 * Faster than syncSkillsToGcs() because it only handles one skill without
 * scanning for stale folders or re-syncing all active skills.
 *
 * Returns { fetched: boolean } indicating if the real SKILL.md was found on GitHub.
 */
export async function installSingleSkillToGcs(
  userId: string,
  skillId: string,
  source: string,
  subdomain?: string | null,
  userJwt?: string | null,
): Promise<{ ok: boolean; fetched: boolean }> {
  if (!STORAGE_URL) {
    console.warn('[installSingleSkill] STORAGE_URL not set — skipping');
    return { ok: false, fetched: false };
  }

  // 1. Fetch skill catalog metadata
  let skill: ActiveSkillRow | null = null;
  try {
    const { rows } = await pool.query<ActiveSkillRow>(
      `SELECT skill_id, name, description, category, source, source_url
       FROM skills WHERE skill_id = $1 AND source = $2 LIMIT 1`,
      [skillId, source],
    );
    skill = rows[0] || null;
  } catch (err) {
    console.error('[installSingleSkill] DB query failed:', err);
    return { ok: false, fetched: false };
  }

  if (!skill) {
    console.warn(`[installSingleSkill] Skill ${skillId} not found in catalog`);
    return { ok: false, fetched: false };
  }

  // 2. Fetch real SKILL.md from GitHub (or generate fallback)
  const md = await getSkillMdContent(skill);
  const fetchedFromGitHub = !md.includes('## What This Skill Does');

  // 3. Write to GCS
  const writeOk = await writeSkillFile(userId, skill.skill_id, md);
  if (!writeOk) {
    console.error(`[installSingleSkill] Failed to write SKILL.md for ${skillId}`);
    return { ok: false, fetched: fetchedFromGitHub };
  }

  console.log(
    `[installSingleSkill] Installed ${skillId} for user ${userId}` +
      (fetchedFromGitHub ? ' (real SKILL.md from GitHub)' : ' (generated fallback)'),
  );

  // 4. Update openclaw.json with this skill's entry
  let skillApiKeys: Record<string, Record<string, string>> = {};
  try {
    skillApiKeys = await getSkillApiKeysForUser(userId);
  } catch {
    // proceed without
  }

  let config: Record<string, unknown> = {};
  try {
    const existing = await readUserConfig(userId);
    if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
      config = { ...(existing as Record<string, unknown>) };
    }
  } catch {
    // proceed with empty
  }

  const existingSkills =
    config.skills && typeof config.skills === 'object' && !Array.isArray(config.skills)
      ? { ...(config.skills as Record<string, unknown>) }
      : {};

  const entries =
    existingSkills.entries && typeof existingSkills.entries === 'object'
      ? { ...(existingSkills.entries as Record<string, unknown>) }
      : {};

  const entry: Record<string, unknown> = { enabled: true };
  const keys = skillApiKeys[skillId];
  if (keys && Object.keys(keys).length > 0) {
    entry.env = { ...keys };
  }
  entries[skillId] = entry;
  existingSkills.entries = entries;
  config.skills = existingSkills;

  try {
    await writeUserConfig(userId, config);
    console.log(`[installSingleSkill] Updated openclaw.json for ${skillId}`);
  } catch (err) {
    console.error('[installSingleSkill] GCS config write failed:', err);
  }

  // 5. Notify live gateway
  if (userJwt) {
    const gatewayUrl = await getGatewayUrl(subdomain);
    if (gatewayUrl) {
      await notifyGateway(gatewayUrl, userJwt, existingSkills);
    }
  }

  return { ok: true, fetched: fetchedFromGitHub };
}
