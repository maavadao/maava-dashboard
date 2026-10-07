import { NextRequest, NextResponse } from 'next/server';
import pool from '@/lib/db';
import { createJWT, getRequestUserId } from '@/lib/auth';

// ── Tenant platform provisioning ─────────────────────────────────────────────

const BUCKET_MANAGER_URL = process.env.BUCKET_MANAGER_URL || '';
const BUCKET_MANAGER_API_SECRET = process.env.BUCKET_MANAGER_API_SECRET || '';
const GCS_BUCKET =
  process.env.GCS_SHARED_BUCKET || process.env.GCS_BUCKET || 'mawadao-agent-data';

function stripApiV1(url: string): string {
  return url.replace(/\/api\/v1\/?$/, '').replace(/\/$/, '');
}

type MarketplaceAgentFull = {
  name: string;
  slug: string;
  soul_config: Record<string, unknown> | null;
  heartbeat_config: Record<string, unknown> | null;
  skills_config: Array<{ slug?: string; name?: string; content?: string }> | null;
  system_prompt: string | null;
  description: string | null;
  category: string | null;
  developer: string | null;
};

function buildSoulMd(a: MarketplaceAgentFull): string {
  if (typeof a.soul_config?.content === 'string' && a.soul_config.content.trim()) {
    return a.soul_config.content;
  }
  const core = a.system_prompt || a.description || '';
  const lines = [
    `# SOUL.md — ${a.name}`,
    '',
    '## Who You Are',
    `You are **${a.name}**, an AI agent specialized in ${a.category || 'general'} tasks.`,
  ];
  if (core) lines.push('', '## Core Instructions', core);
  lines.push(
    '', '## Core Values',
    '- Be helpful, accurate, and concise',
    '- Stay focused on your area of expertise',
    '- Communicate clearly and professionally',
  );
  return lines.join('\n');
}

function buildIdentityMd(a: MarketplaceAgentFull): string {
  const lines = ['# IDENTITY.md', '', '## Core', `- Name: ${a.name}`];
  if (a.category) lines.push(`- Category: ${a.category}`);
  if (a.developer) lines.push(`- Developer: ${a.developer}`);
  lines.push('', '## Purpose', a.description || a.name);
  lines.push('', '## Communication Style', '- Professional and helpful', '- Clear and concise');
  return lines.join('\n');
}

function buildHeartbeatMd(a: MarketplaceAgentFull): string {
  if (typeof a.heartbeat_config?.content === 'string' && a.heartbeat_config.content.trim()) {
    return a.heartbeat_config.content;
  }
  return [
    `# HEARTBEAT.md — ${a.name}`, '',
    '## Status',
    `Agent **${a.name}** is active and ready to receive tasks.`,
    '', '## Standard Operating Procedure',
    '1. Read the incoming request carefully',
    '2. Apply your core instructions from SOUL.md',
    '3. Respond clearly and helpfully',
  ].join('\n');
}

function buildAgentsMd(a: MarketplaceAgentFull): string {
  return [
    `# AGENTS.md — ${a.name}`, '', '## About This Agent',
    a.description || a.name,
    '', '## Capabilities',
    `This agent specializes in ${a.category || 'general'} tasks.`,
    '', '## Notes',
    '- Installed from the mawaDao marketplace',
    `- Developer: ${a.developer || 'Unknown'}`,
  ].join('\n');
}

function buildMemoryMd(): string {
  return '# MEMORY.md\n\n_(Initialized — context will build over time.)_';
}

/**
 * When the REST API is unavailable (older backend), add the agent directly
 * to the gateway config (openclaw.json) via the GCS bucket-manager.
 */
async function addAgentToGcsConfig(
  userId: string,
  agentSlug: string,
  agentName: string,
): Promise<boolean> {
  if (!BUCKET_MANAGER_URL) {
    console.warn('[gcs-config] skip — BUCKET_MANAGER_URL is empty');
    return false;
  }
  const gcsHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
  if (BUCKET_MANAGER_API_SECRET) gcsHeaders['X-Bucket-Manager-Secret'] = BUCKET_MANAGER_API_SECRET;

  const configGcsPath = `${userId}/mountfolder/openclaw.json`;
  const configUrl = `${BUCKET_MANAGER_URL}/api/v1/buckets/${encodeURIComponent(GCS_BUCKET)}/files/${configGcsPath}`;

  // Read current config
  let config: Record<string, unknown>;
  try {
    const getResp = await fetch(configUrl, { headers: gcsHeaders, signal: AbortSignal.timeout(10_000) });
    if (getResp.ok) {
      config = await getResp.json() as Record<string, unknown>;
    } else {
      console.log('[gcs-config] no existing config (status', getResp.status, ') — creating fresh');
      config = {};
    }
  } catch {
    console.log('[gcs-config] failed to read existing config — creating fresh');
    config = {};
  }

  // Add agent to agents.list, preserving the "main" default agent
  const agents = (config.agents ?? {}) as Record<string, unknown>;
  const list = Array.isArray(agents.list) ? [...agents.list] : [];
  const workspace = `/home/node/.openclaw/workspace-${agentSlug}`;

  // Ensure "main" agent always exists in the list (gateway requires it
  // once the list is non-empty; an empty list auto-resolves to ["main"])
  const hasMain = list.some((e: Record<string, unknown>) => e?.id === 'main');
  if (!hasMain) {
    const defaultWorkspace = (agents as Record<string, unknown>).defaults
      ? ((agents as Record<string, unknown>).defaults as Record<string, unknown>)?.workspace
      : undefined;
    list.unshift({
      id: 'main',
      name: 'main',
      workspace: (typeof defaultWorkspace === 'string' && defaultWorkspace) || '/home/node/.openclaw/workspace',
    });
  }

  const alreadyExists = list.some(
    (e: Record<string, unknown>) => e?.id === agentSlug,
  );
  if (!alreadyExists) {
    list.push({ id: agentSlug, name: agentName, workspace });
  }
  config.agents = { ...agents, list };

  // Write updated config back to GCS
  try {
    const putResp = await fetch(configUrl, {
      method: 'PUT',
      headers: gcsHeaders,
      body: JSON.stringify(config, null, 2),
      signal: AbortSignal.timeout(15_000),
    });
    const putBody = await putResp.text().catch(() => '');
    console.log('[gcs-config] PUT openclaw.json →', putResp.status, putBody.slice(0, 300));
    return putResp.ok;
  } catch (err: unknown) {
    console.error('[gcs-config] PUT openclaw.json THREW:', (err as Error)?.message);
    return false;
  }
}

/**
 * Writes SOUL.md, IDENTITY.md, HEARTBEAT.md, AGENTS.md, MEMORY.md to the
 * tenant-platform local workspace and mirrors each file to GCS.
 */
async function seedAgentWorkspaceFiles(
  base: string,
  headers: Record<string, string>,
  userId: string,
  agent: MarketplaceAgentFull,
  restApiAvailable = true,
): Promise<void> {
  console.log('[seed] START — agent:', agent.slug, 'base:', base, 'userId:', userId);
  console.log('[seed] ENV check — BUCKET_MANAGER_URL:', BUCKET_MANAGER_URL || '(empty)',
    'BUCKET_MANAGER_API_SECRET:', BUCKET_MANAGER_API_SECRET ? '(set)' : '(empty)',
    'GCS_BUCKET:', GCS_BUCKET);

  const workspaceFiles = [
    { name: 'SOUL.md',      content: buildSoulMd(agent) },
    { name: 'IDENTITY.md',  content: buildIdentityMd(agent) },
    { name: 'HEARTBEAT.md', content: buildHeartbeatMd(agent) },
    { name: 'AGENTS.md',    content: buildAgentsMd(agent) },
    { name: 'MEMORY.md',    content: buildMemoryMd() },
  ];

  const gcsHeaders: Record<string, string> = { 'Content-Type': 'text/plain; charset=utf-8' };
  if (BUCKET_MANAGER_API_SECRET) gcsHeaders['X-Bucket-Manager-Secret'] = BUCKET_MANAGER_API_SECRET;

  for (const file of workspaceFiles) {
    // Write to tenant-platform local disk via REST (only when available)
    if (restApiAvailable) {
      const fileSetUrl = `${base}/api/v1/agents/files/set`;
      const fileSetBody = { agentId: agent.slug, name: file.name, content: file.content };
      console.log('[seed] files.set request:', fileSetUrl, '{ agentId:', agent.slug, ', name:', file.name, ', contentLen:', file.content.length, '}');
      try {
        const resp = await fetch(fileSetUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify(fileSetBody),
          signal: AbortSignal.timeout(10_000),
        });
        const body = await resp.text().catch(() => '');
        console.log('[seed] files.set', file.name, '→', resp.status, body.slice(0, 300));
      } catch (err: unknown) {
        console.error('[seed] files.set', file.name, 'THREW:', (err as Error)?.message);
      }
    } else {
      console.log('[seed] files.set SKIP —', file.name, '(REST API unavailable)');
    }

    // Mirror to GCS via bucket-manager (fallback if GCSFuse is not mounted)
    if (BUCKET_MANAGER_URL) {
      const gcsPath = `${userId}/mountfolder/workspace-${agent.slug}/${file.name}`;
      const gcsUrl = `${BUCKET_MANAGER_URL}/api/v1/buckets/${encodeURIComponent(GCS_BUCKET)}/files/${gcsPath}`;
      console.log('[seed] GCS PUT:', gcsUrl);
      try {
        const gcsResp = await fetch(gcsUrl, {
          method: 'PUT', headers: gcsHeaders, body: file.content, signal: AbortSignal.timeout(15_000),
        });
        const gcsBody = await gcsResp.text().catch(() => '');
        console.log('[seed] GCS', file.name, '→', gcsResp.status, gcsBody.slice(0, 300));
      } catch (err: unknown) {
        console.error('[seed] GCS', file.name, 'THREW:', (err as Error)?.message);
      }
    } else {
      console.warn('[seed] GCS skip — BUCKET_MANAGER_URL is empty');
    }
  }

  // Seed any skills from skills_config
  const skills = Array.isArray(agent.skills_config) ? agent.skills_config : [];
  console.log('[seed] skills to seed:', skills.length);
  for (const skill of skills) {
    if (!skill.slug || !skill.content) {
      console.log('[seed] skip skill — missing slug or content:', JSON.stringify(skill)?.slice(0, 200));
      continue;
    }
    if (BUCKET_MANAGER_URL) {
      const gcsPath = `${userId}/mountfolder/skills/${skill.slug}/SKILL.md`;
      const gcsUrl = `${BUCKET_MANAGER_URL}/api/v1/buckets/${encodeURIComponent(GCS_BUCKET)}/files/${gcsPath}`;
      console.log('[seed] GCS skill PUT:', gcsUrl);
      try {
        const resp = await fetch(gcsUrl, {
          method: 'PUT', headers: gcsHeaders, body: skill.content, signal: AbortSignal.timeout(15_000),
        });
        const body = await resp.text().catch(() => '');
        console.log('[seed] GCS skill', skill.slug, '→', resp.status, body.slice(0, 300));
      } catch (err: unknown) {
        console.error('[seed] GCS skill', skill.slug, 'THREW:', (err as Error)?.message);
      }
    }
  }

  console.log('[seed] DONE — all files processed for', agent.slug);
}

async function provisionAgentInTenantPlatform(
  userId: string,
  marketplaceAgentId: string,
): Promise<void> {
  console.log('[provision] START — userId:', userId, 'agentId:', marketplaceAgentId);

  // 1. Fetch full marketplace agent data
  const { rows: [agent] } = await pool.query<MarketplaceAgentFull>(
    `SELECT name, slug, soul_config, heartbeat_config, skills_config,
            system_prompt, description, category, developer
       FROM marketplace_agents WHERE id = $1`,
    [marketplaceAgentId],
  );
  if (!agent) {
    throw new Error(`Marketplace agent not found: ${marketplaceAgentId}`);
  }
  console.log('[provision] 1/6 agent data:', agent.slug, agent.name,
    'soul_config:', JSON.stringify(agent.soul_config)?.slice(0, 200),
    'heartbeat_config:', JSON.stringify(agent.heartbeat_config)?.slice(0, 200),
    'skills_config:', JSON.stringify(agent.skills_config)?.slice(0, 200));

  // 2. Fetch tenant gateway URL + user email
  const { rows: [tenant] } = await pool.query<{
    backend_url: string | null;
    subdomain: string;
    email: string;
  }>(
    `SELECT t.backend_url, t.subdomain, u.email
       FROM tenants t
       JOIN users u ON u.id = t.user_id
      WHERE t.user_id = $1 AND t.status = 'active'`,
    [userId],
  );
  if (!tenant) {
    throw new Error(`No active tenant for user: ${userId}`);
  }
  const hasGateway = !!tenant.backend_url;
  console.log('[provision] 2/6 tenant:', tenant.subdomain, 'backend_url:', tenant.backend_url || '(none — GCS-only mode)');

  // 3. Short-lived service JWT (60 s)
  const jwt = await createJWT(
    { userId, email: tenant.email, subdomain: tenant.subdomain, tenantId: tenant.subdomain },
    '60s',
  );
  console.log('[provision] 3/6 JWT created, length:', jwt.length);

  const base = hasGateway ? stripApiV1(tenant.backend_url!) : '';
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${jwt}`,
    'X-Tenant-ID': tenant.subdomain,
  };

  // 4. Create agent (slug → stable agent ID)
  //    Best-effort: older tenant backends may not have REST routes yet.
  //    The critical path is GCS file seeding (step 6) which works independently.
  let restApiAvailable = hasGateway;
  if (hasGateway) {
    console.log('[provision] 4/6 calling agents.create:', `${base}/api/v1/agents/create`, '{ name:', agent.slug, '}');
    try {
      const createResp = await fetch(`${base}/api/v1/agents/create`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ name: agent.slug, workspace: `/home/node/.openclaw/workspace-${agent.slug}` }),
        signal: AbortSignal.timeout(10_000),
      });
      const createBody = await createResp.text().catch(() => '');
      console.log('[provision] 4/6 agents.create response:', createResp.status, createBody);
      if (createResp.status === 404) {
        console.warn('[provision] 4/6 REST API not available on tenant backend (404) — will rely on GCS seeding');
        restApiAvailable = false;
      } else if (!createResp.ok && createResp.status !== 409) {
        console.warn('[provision] 4/6 agents.create non-fatal failure:', createResp.status, createBody);
      }
    } catch (err: unknown) {
      console.warn('[provision] 4/6 agents.create network error (non-fatal):', (err as Error)?.message);
      restApiAvailable = false;
    }
  } else {
    console.log('[provision] 4/6 skipping agents.create — no gateway backend_url');
    restApiAvailable = false;
  }

  // 5. Set human-readable display name (skip if REST API unavailable)
  if (restApiAvailable) {
    console.log('[provision] 5/6 calling agents.update:', agent.slug, '→', agent.name);
    const updateResp = await fetch(`${base}/api/v1/agents/update`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ agentId: agent.slug, name: agent.name }),
      signal: AbortSignal.timeout(10_000),
    }).catch((err) => { console.error('[provision] 5/6 agents.update error:', err?.message); return null; });
    if (updateResp) {
      const updateBody = await updateResp.text().catch(() => '');
      console.log('[provision] 5/6 agents.update response:', updateResp.status, updateBody);
    }
  } else {
    console.log('[provision] 5/6 skipping agents.update — REST API not available');
  }

  // 5b. Register agent in openclaw.json via GCS (always — this is the source of truth
  //     the gateway reads; the REST agents.create/update endpoints may not exist yet)
  if (BUCKET_MANAGER_URL) {
    console.log('[provision] 5b/6 adding agent to openclaw.json via GCS…');
    const configOk = await addAgentToGcsConfig(userId, agent.slug, agent.name);
    if (!configOk) {
      console.warn(`[provision] 5b/6 Failed to add agent "${agent.slug}" to gateway config via GCS (non-fatal)`);
    }
  }

  // 6. Seed workspace files (SOUL.md, IDENTITY.md, HEARTBEAT.md, AGENTS.md, MEMORY.md + skills)
  console.log('[provision] 6/6 seeding workspace files…');
  await seedAgentWorkspaceFiles(base, headers, userId, agent, restApiAvailable);

  console.log('[provision] DONE — agent fully provisioned:', agent.slug, 'for user', userId);
}

async function deprovisionAgentFromTenantPlatform(
  userId: string,
  marketplaceAgentId: string,
): Promise<void> {
  const { rows: [agent] } = await pool.query<{ slug: string }>(
    `SELECT slug FROM marketplace_agents WHERE id = $1`,
    [marketplaceAgentId],
  );
  if (!agent) return;

  const { rows: [tenant] } = await pool.query<{
    backend_url: string | null;
    subdomain: string;
    email: string;
  }>(
    `SELECT t.backend_url, t.subdomain, u.email
       FROM tenants t
       JOIN users u ON u.id = t.user_id
      WHERE t.user_id = $1 AND t.status = 'active'`,
    [userId],
  );
  if (!tenant) return;

  // Delete from tenant-platform REST API (only if gateway is available)
  if (tenant.backend_url) {
    const jwt = await createJWT(
      { userId, email: tenant.email, subdomain: tenant.subdomain, tenantId: tenant.subdomain },
      '60s',
    );
    const base = stripApiV1(tenant.backend_url);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${jwt}`,
      'X-Tenant-ID': tenant.subdomain,
    };

    await fetch(`${base}/api/v1/agents/delete`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ agentId: agent.slug, deleteFiles: true }),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => {});
  }

  // Remove agent from openclaw.json config via GCS
  if (BUCKET_MANAGER_URL) {
    const gcsHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
    if (BUCKET_MANAGER_API_SECRET) gcsHeaders['X-Bucket-Manager-Secret'] = BUCKET_MANAGER_API_SECRET;

    const configGcsPath = `${userId}/mountfolder/openclaw.json`;
    const configUrl = `${BUCKET_MANAGER_URL}/api/v1/buckets/${encodeURIComponent(GCS_BUCKET)}/files/${configGcsPath}`;
    try {
      const getResp = await fetch(configUrl, { headers: gcsHeaders, signal: AbortSignal.timeout(10_000) });
      if (getResp.ok) {
        const config = await getResp.json() as Record<string, unknown>;
        const agents = (config.agents ?? {}) as Record<string, unknown>;
        if (Array.isArray(agents.list)) {
          const before = agents.list.length;
          const filtered = (agents.list as Record<string, unknown>[]).filter(
            (e) => e?.id !== agent.slug,
          );
          if (filtered.length < before) {
            agents.list = filtered;
            config.agents = { ...agents };
            await fetch(configUrl, {
              method: 'PUT',
              headers: gcsHeaders,
              body: JSON.stringify(config, null, 2),
              signal: AbortSignal.timeout(15_000),
            });
            console.log('[deprovision] removed', agent.slug, 'from openclaw.json');
          }
        }
      }
    } catch (err: unknown) {
      console.error('[deprovision] failed to update openclaw.json:', (err as Error)?.message);
    }

    // Delete GCS workspace folder
    const gcsFolder = `${userId}/mountfolder/workspace-${agent.slug}`;
    const gcsUrl = `${BUCKET_MANAGER_URL}/api/v1/buckets/${encodeURIComponent(GCS_BUCKET)}/folders/${gcsFolder}`;
    const delHeaders: Record<string, string> = {};
    if (BUCKET_MANAGER_API_SECRET) delHeaders['X-Bucket-Manager-Secret'] = BUCKET_MANAGER_API_SECRET;
    await fetch(gcsUrl, {
      method: 'DELETE',
      headers: delHeaders,
      signal: AbortSignal.timeout(15_000),
    }).catch(() => {});
  }
}

/**
 * GET /api/agents/installed — list user's installed agents
 * POST /api/agents/installed — install an agent (body: { agent_id })
 * DELETE /api/agents/installed — uninstall an agent (body: { agent_id })
 */

export async function GET(request: NextRequest) {
  const userId = await getRequestUserId(request);
  console.log('[GET /api/agents/installed] userId:', userId ?? '(none — 401)');
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { rows } = await pool.query(
      `SELECT
        uia.id as install_id,
        uia.agent_id,
        uia.is_active,
        uia.installed_at,
        uia.last_used_at,
        uia.config_overrides,
        ma.id,
        ma.slug,
        ma.name,
        ma.short_description,
        ma.description,
        ma.category,
        ma.developer,
        ma.icon_url,
        ma.verified,
        ma.system_prompt,
        ma.soul_config,
        ma.skills_config,
        ma.heartbeat_config,
        ma.channels_config,
        ma.model,
        ma.max_runtime_hours
      FROM user_installed_agents uia
      JOIN marketplace_agents ma ON ma.id = uia.agent_id
      WHERE uia.user_id = $1 AND uia.is_active = true
      ORDER BY uia.last_used_at DESC NULLS LAST, uia.installed_at DESC`,
      [userId]
    );

    console.log('[GET /api/agents/installed] Found', rows.length, 'agents for user', userId);
    return NextResponse.json({ agents: rows });
  } catch (err) {
    console.error('[GET /api/agents/installed] DB error:', err);
    return NextResponse.json({ error: 'Failed to list installed agents' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const userId = await getRequestUserId(request);
  console.log('[POST /api/agents/installed] userId:', userId ?? '(none — 401)');
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: { agent_id: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  if (!body.agent_id) {
    return NextResponse.json({ error: 'agent_id is required' }, { status: 400 });
  }

  try {
    // Verify agent exists
    const { rows: agentRows } = await pool.query(
      `SELECT id FROM marketplace_agents WHERE id = $1`,
      [body.agent_id]
    );
    if (agentRows.length === 0) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
    }

    // Install (upsert)
    await pool.query(
      `INSERT INTO user_installed_agents (user_id, agent_id, is_active)
       VALUES ($1, $2, true)
       ON CONFLICT (user_id, agent_id) DO UPDATE SET is_active = true, installed_at = now()`,
      [userId, body.agent_id]
    );

    // Increment install count
    await pool.query(
      `UPDATE marketplace_agents SET total_installs = total_installs + 1 WHERE id = $1`,
      [body.agent_id]
    );

    console.log('[POST /api/agents/installed] Installed agent', body.agent_id, 'for user', userId);

    // Provision in tenant gateway — retry once on transient failure
    let provisionOk = false;
    let provisionErr: string | undefined;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await provisionAgentInTenantPlatform(userId, body.agent_id);
        provisionOk = true;
        break;
      } catch (err: unknown) {
        provisionErr = (err as Error)?.message ?? String(err);
        console.error(`[POST /api/agents/installed] provision attempt ${attempt}/2 FAILED:`, provisionErr);
        if (attempt < 2) {
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
    }

    if (!provisionOk) {
      // Roll back DB changes — agent was not actually provisioned
      console.error('[POST /api/agents/installed] provision permanently failed, rolling back DB');
      await pool.query(
        `UPDATE user_installed_agents SET is_active = false WHERE user_id = $1 AND agent_id = $2`,
        [userId, body.agent_id],
      );
      await pool.query(
        `UPDATE marketplace_agents SET total_installs = GREATEST(total_installs - 1, 0) WHERE id = $1`,
        [body.agent_id],
      );
      return NextResponse.json(
        { error: `Agent provisioning failed: ${provisionErr}` },
        { status: 502 },
      );
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('[POST /api/agents/installed] DB error:', err);
    return NextResponse.json({ error: 'Failed to install agent' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  const userId = await getRequestUserId(request);
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: { agent_id: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  if (!body.agent_id) {
    return NextResponse.json({ error: 'agent_id is required' }, { status: 400 });
  }

  try {
    await pool.query(
      `UPDATE user_installed_agents SET is_active = false WHERE user_id = $1 AND agent_id = $2`,
      [userId, body.agent_id]
    );

    // Remove from tenant gateway (awaited so serverless doesn't kill process)
    try {
      await deprovisionAgentFromTenantPlatform(userId, body.agent_id);
    } catch (err: unknown) {
      console.warn('[DELETE /api/agents/installed] tenant deprovision warning:', (err as Error)?.message ?? err);
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('Uninstall agent error:', err);
    return NextResponse.json({ error: 'Failed to uninstall agent' }, { status: 500 });
  }
}
