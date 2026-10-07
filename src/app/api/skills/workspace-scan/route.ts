import { NextRequest, NextResponse } from 'next/server';
import pool, { getUserId } from '@/lib/db';
import { authenticateRequest } from '@/lib/auth';
import { readUserConfig, SHARED_BUCKET } from '@/lib/gcs';

/**
 * POST /api/skills/workspace-scan
 *
 * Scans the user's GCS workspace for skill folders created by AI agents
 * (e.g. via the skill creator). A workspace folder is identified as a skill
 * if it has an INDEX.md file and is NOT listed in openclaw.json agents.list.
 *
 * For each discovered skill:
 *   1. Inserts into `skills` table with source='workspace-created'
 *   2. Inserts into `user_skills` as active
 *   3. Creates a SKILL.md in the skills/ directory (for gateway discovery)
 *   4. Adds to openclaw.json skills.entries
 *
 * Returns the list of workspace-created skills.
 */

const BUCKET_MANAGER_URL = process.env.BUCKET_MANAGER_URL || '';
const BUCKET_MANAGER_API_SECRET = process.env.BUCKET_MANAGER_API_SECRET || '';

async function bmHeaders(): Promise<Record<string, string>> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (BUCKET_MANAGER_API_SECRET) h['X-Bucket-Manager-Secret'] = BUCKET_MANAGER_API_SECRET;
  // OIDC token for Cloud Run IAM auth
  if (process.env.K_SERVICE) {
    try {
      const metaUrl =
        `http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity` +
        `?audience=${encodeURIComponent(BUCKET_MANAGER_URL)}`;
      const res = await fetch(metaUrl, {
        headers: { 'Metadata-Flavor': 'Google' },
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) h['Authorization'] = `Bearer ${(await res.text()).trim()}`;
    } catch { /* local dev */ }
  }
  return h;
}

interface WorkspaceSkill {
  skill_id: string;
  name: string;
  description: string;
  category: string;
  source: string;
  is_installed: boolean;
}

/** Known agent workspace marker files — folders with these are agent workspaces, not skills */
const AGENT_MARKER_FILES = ['SOUL.md', 'IDENTITY.md', 'HEARTBEAT.md'];

/**
 * Parse a simple title and description from INDEX.md or README.md content.
 */
function parseSkillMetadata(content: string): { name: string; description: string } {
  const lines = content.split('\n');
  let name = '';
  let description = '';

  for (const line of lines) {
    const trimmed = line.trim();
    if (!name && trimmed.startsWith('# ')) {
      name = trimmed.replace(/^#\s+/, '').trim();
      continue;
    }
    if (name && !description && trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('```')) {
      description = trimmed;
      break;
    }
  }

  return { name: name || 'Untitled Skill', description: description || '' };
}

/**
 * Build SKILL.md frontmatter from workspace skill metadata.
 */
function buildSkillMd(slug: string, name: string, description: string): string {
  return [
    '---',
    `name: ${slug}`,
    `description: >`,
    `  ${description || name}`,
    `user-invocable: true`,
    `disable-model-invocation: false`,
    `metadata: {"openclaw":{"emoji":"🛠️","always":false,"skillKey":"${slug}"}}`,
    '---',
    '',
    `# ${name}`,
    '',
    description ? `${description}\n` : '',
    `## Workspace Location`,
    `\`workspace/${slug}/\``,
    '',
  ].join('\n');
}

export async function POST(request: NextRequest) {
  const user = await authenticateRequest(request);
  const userId = user?.userId ?? getUserId(request) ?? request.headers.get('x-user-id') ?? 'anonymous';

  if (userId === 'anonymous') {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
  }

  if (!BUCKET_MANAGER_URL) {
    return NextResponse.json({ error: 'Bucket manager not configured' }, { status: 503 });
  }

  try {
    const headers = await bmHeaders();
    const basePath = `${userId}/mountfolder/workspace`;

    // 1. List all folders in workspace/
    const listUrl = `${BUCKET_MANAGER_URL}/api/v1/buckets/${encodeURIComponent(SHARED_BUCKET)}/folders?path=${encodeURIComponent(basePath)}`;
    const listRes = await fetch(listUrl, { headers, signal: AbortSignal.timeout(10_000) });
    if (!listRes.ok) {
      return NextResponse.json({ skills: [], message: 'Could not list workspace folders' });
    }

    const listData = (await listRes.json()) as { folders?: string[]; files?: unknown[] };
    const folders = listData.folders || [];

    if (folders.length === 0) {
      return NextResponse.json({ skills: [], message: 'No workspace folders found' });
    }

    // 2. Get agents list from openclaw.json to exclude agent workspaces
    const config = (await readUserConfig(userId)) as Record<string, unknown> | null;
    const agentsList: string[] = [];
    if (config?.agents && typeof config.agents === 'object') {
      const agents = config.agents as Record<string, unknown>;
      if (Array.isArray(agents.list)) {
        for (const entry of agents.list) {
          if (typeof entry === 'string') agentsList.push(entry);
          else if (entry && typeof entry === 'object' && 'id' in entry) {
            agentsList.push(String((entry as Record<string, unknown>).id));
          }
        }
      }
    }
    // Always exclude 'main' — it's the default agent workspace
    if (!agentsList.includes('main')) agentsList.push('main');

    const agentSet = new Set(agentsList);

    // 3. For each non-agent folder, check if it has INDEX.md (skill marker)
    const discoveredSkills: WorkspaceSkill[] = [];

    for (const folder of folders) {
      if (agentSet.has(folder)) continue; // skip agent workspaces

      // List folder contents to check for INDEX.md and agent markers
      const folderUrl = `${BUCKET_MANAGER_URL}/api/v1/buckets/${encodeURIComponent(SHARED_BUCKET)}/folders?path=${encodeURIComponent(basePath + '/' + folder)}`;
      let folderData: { files?: { name: string }[]; folders?: string[] };
      try {
        const fRes = await fetch(folderUrl, { headers, signal: AbortSignal.timeout(8000) });
        if (!fRes.ok) continue;
        folderData = await fRes.json();
      } catch {
        continue;
      }

      const fileNames = (folderData.files || []).map((f) => f.name);

      // Skip if it has agent marker files (SOUL.md, IDENTITY.md, etc.)
      if (AGENT_MARKER_FILES.some((m) => fileNames.includes(m))) continue;

      // Must have INDEX.md or README.md to be considered a skill
      const hasIndex = fileNames.includes('INDEX.md');
      const hasReadme = fileNames.includes('README.md');
      if (!hasIndex && !hasReadme) continue;

      // 4. Read INDEX.md (or README.md) to get skill metadata
      const metaFile = hasIndex ? 'INDEX.md' : 'README.md';
      const filePath = `${basePath}/${folder}/${metaFile}`;
      const fileUrl = `${BUCKET_MANAGER_URL}/api/v1/buckets/${encodeURIComponent(SHARED_BUCKET)}/files/${encodeURIComponent(filePath)}`;
      let content = '';
      try {
        const fRes = await fetch(fileUrl, {
          headers: { 'X-Bucket-Manager-Secret': BUCKET_MANAGER_API_SECRET },
          signal: AbortSignal.timeout(8000),
        });
        if (fRes.ok) content = await fRes.text();
      } catch { /* continue with empty content */ }

      const { name, description } = parseSkillMetadata(content);
      const skillId = folder; // use folder name as skill_id

      // 5. Register in skills table (check-then-insert/update since skill_id has no UNIQUE constraint)
      try {
        const { rows: existing } = await pool.query(
          `SELECT id FROM skills WHERE skill_id = $1 AND source = 'workspace-created' LIMIT 1`,
          [skillId]
        );
        if (existing.length > 0) {
          await pool.query(
            `UPDATE skills SET name = $1, description = $2, updated_at = now() WHERE id = $3`,
            [name, description, existing[0].id]
          );
        } else {
          await pool.query(
            `INSERT INTO skills (id, skill_id, name, description, category, source, source_url, installs)
             VALUES (gen_random_uuid()::text, $1, $2, $3, 'workspace', 'workspace-created', NULL, 0)`,
            [skillId, name, description]
          );
        }
      } catch (err) {
        console.error(`[workspace-scan] Failed to insert skill ${skillId}:`, err);
        continue;
      }

      // 6. Install for user (upsert into user_skills)
      try {
        await pool.query(
          `INSERT INTO user_skills (user_id, skill_id, source, is_active)
           VALUES ($1, $2, 'workspace-created', TRUE)
           ON CONFLICT (user_id, skill_id) DO UPDATE SET is_active = TRUE`,
          [userId, skillId]
        );
      } catch (err) {
        console.error(`[workspace-scan] Failed to install skill ${skillId} for user:`, err);
      }

      // 7. Write SKILL.md to skills/ directory (for gateway discovery)
      const skillMd = buildSkillMd(skillId, name, description);
      const skillMdPath = `${userId}/mountfolder/skills/${skillId}/SKILL.md`;
      const skillMdUrl = `${BUCKET_MANAGER_URL}/api/v1/buckets/${encodeURIComponent(SHARED_BUCKET)}/files/${encodeURIComponent(skillMdPath)}`;
      try {
        await fetch(skillMdUrl, {
          method: 'PUT',
          headers,
          body: skillMd,
          signal: AbortSignal.timeout(8000),
        });
      } catch { /* non-fatal */ }

      discoveredSkills.push({
        skill_id: skillId,
        name,
        description,
        category: 'workspace',
        source: 'workspace-created',
        is_installed: true,
      });
    }

    // 8. Update openclaw.json skills.entries for newly discovered skills
    if (discoveredSkills.length > 0 && config) {
      const updated = { ...(config as Record<string, unknown>) };
      const skills = updated.skills && typeof updated.skills === 'object'
        ? { ...(updated.skills as Record<string, unknown>) }
        : {};
      const entries = skills.entries && typeof skills.entries === 'object'
        ? { ...(skills.entries as Record<string, unknown>) }
        : {};

      for (const s of discoveredSkills) {
        if (!entries[s.skill_id]) {
          entries[s.skill_id] = { enabled: true };
        }
      }
      skills.entries = entries;
      updated.skills = skills;

      try {
        const { writeUserConfig } = await import('@/lib/gcs');
        await writeUserConfig(userId, updated);
      } catch (err) {
        console.error('[workspace-scan] Failed to update openclaw.json:', err);
      }
    }

    console.log(
      `[workspace-scan] Found ${discoveredSkills.length} workspace skill(s) for user ${userId}:`,
      discoveredSkills.map((s) => s.skill_id),
    );

    return NextResponse.json({
      skills: discoveredSkills,
      message: discoveredSkills.length > 0
        ? `Found ${discoveredSkills.length} workspace skill(s)`
        : 'No workspace skills found',
    });
  } catch (err) {
    console.error('[workspace-scan] Error:', err);
    return NextResponse.json({ error: 'Workspace scan failed' }, { status: 500 });
  }
}
