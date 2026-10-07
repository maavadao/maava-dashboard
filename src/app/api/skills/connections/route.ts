import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest } from '@/lib/auth';
import pool from '@/lib/db';
import { createCipheriv, createDecipheriv, scryptSync, randomBytes } from 'crypto';
import { syncSkillEnvToGcs } from '@/lib/sync-skills';

const SALT = 'mawadao-skill-connections';
let encKey: Buffer | undefined;
function getEncKey(): Buffer {
  if (!encKey) {
    const secret = process.env.PROVIDER_KEY_SECRET || process.env.JWT_SECRET;
    if (!secret) throw new Error("PROVIDER_KEY_SECRET or JWT_SECRET must be set");
    encKey = scryptSync(secret, SALT, 32);
  }
  return encKey;
}

export function encryptSkillValue(data: string): string {
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-cbc', getEncKey(), iv);
  return `${iv.toString('hex')}:${Buffer.concat([cipher.update(data, 'utf8'), cipher.final()]).toString('hex')}`;
}

function decrypt(data: string): string {
  const [ivHex, encHex] = data.split(':');
  if (!ivHex || !encHex) return '';
  const decipher = createDecipheriv('aes-256-cbc', getEncKey(), Buffer.from(ivHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(encHex, 'hex')), decipher.final()]).toString('utf8');
}

/**
 * Get decrypted skill API keys for a user — internal server-side helper.
 * Returns map of { skillKey → { envKey → decryptedValue } }.
 */
export async function getSkillApiKeysForUser(
  userId: string,
): Promise<Record<string, Record<string, string>>> {
  try {
    const { rows } = await pool.query(
      `SELECT skill_key, env_key, key_value FROM user_skill_api_keys WHERE user_id = $1`,
      [userId],
    );
    const result: Record<string, Record<string, string>> = {};
    for (const row of rows as { skill_key: string; env_key: string; key_value: string }[]) {
      if (!result[row.skill_key]) result[row.skill_key] = {};
      try {
        result[row.skill_key][row.env_key] = decrypt(row.key_value);
      } catch {
        // skip corrupted entries
      }
    }
    return result;
  } catch {
    return {};
  }
}

function resolveUserId(request: NextRequest, user: { userId: string } | null): string | null {
  if (user?.userId) return user.userId;
  const header = request.headers.get('x-user-id');
  if (header && header !== 'anonymous') return header;
  return null;
}

/** GET /api/skills/connections — returns which env_keys are configured per skill (no values) */
export async function GET(request: NextRequest) {
  const user = await authenticateRequest(request);
  const userId = resolveUserId(request, user);
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { rows } = await pool.query(
      `SELECT skill_key, env_key FROM user_skill_api_keys WHERE user_id = $1`,
      [userId],
    );
    // { 'github': ['GITHUB_TOKEN'], 'slack': ['SLACK_BOT_TOKEN'] }
    const connections: Record<string, string[]> = {};
    for (const row of rows as { skill_key: string; env_key: string }[]) {
      if (!connections[row.skill_key]) connections[row.skill_key] = [];
      connections[row.skill_key].push(row.env_key);
    }
    return NextResponse.json({ success: true, connections });
  } catch (e) {
    console.error('[skills/connections] GET error:', e);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}

/** POST /api/skills/connections — upsert a single skill API key */
export async function POST(request: NextRequest) {
  const user = await authenticateRequest(request);
  const userId = resolveUserId(request, user);
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: { skillKey?: string; envKey?: string; value?: string };
  try {
    body = (await request.json()) as { skillKey?: string; envKey?: string; value?: string };
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { skillKey, envKey, value } = body;
  if (!skillKey || !envKey || !value) {
    return NextResponse.json({ error: 'skillKey, envKey, and value are required' }, { status: 400 });
  }
  if (skillKey.length > 100 || envKey.length > 100 || value.length > 4096) {
    return NextResponse.json({ error: 'Input too long' }, { status: 400 });
  }
  // Reject suspicious characters in keys
  if (!/^[a-zA-Z0-9_-]+$/.test(skillKey) || !/^[a-zA-Z0-9_]+$/.test(envKey)) {
    return NextResponse.json({ error: 'Invalid skillKey or envKey format' }, { status: 400 });
  }

  try {
    const encrypted = encryptSkillValue(value);
    await pool.query(
      `INSERT INTO user_skill_api_keys (user_id, skill_key, env_key, key_value, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (user_id, skill_key, env_key) DO UPDATE
         SET key_value = EXCLUDED.key_value, updated_at = now()`,
      [userId, skillKey, envKey, encrypted],
    );

    // Sync env vars to GCS so the tenant-platform picks up the new API key
    const rawJwt = request.cookies.get('auth-token')?.value || null;
    void syncSkillEnvToGcs(userId, user?.subdomain, rawJwt);

    return NextResponse.json({ success: true });
  } catch (e) {
    console.error('[skills/connections] POST error:', e);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}

/** DELETE /api/skills/connections — remove a specific key or all keys for a skill */
export async function DELETE(request: NextRequest) {
  const user = await authenticateRequest(request);
  const userId = resolveUserId(request, user);
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: { skillKey?: string; envKey?: string };
  try {
    body = (await request.json()) as { skillKey?: string; envKey?: string };
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { skillKey, envKey } = body;
  if (!skillKey) {
    return NextResponse.json({ error: 'skillKey is required' }, { status: 400 });
  }

  try {
    if (envKey) {
      await pool.query(
        `DELETE FROM user_skill_api_keys WHERE user_id = $1 AND skill_key = $2 AND env_key = $3`,
        [userId, skillKey, envKey],
      );
    } else {
      await pool.query(
        `DELETE FROM user_skill_api_keys WHERE user_id = $1 AND skill_key = $2`,
        [userId, skillKey],
      );
    }

    // Sync env vars to GCS after key removal
    const rawJwt = request.cookies.get('auth-token')?.value || null;
    void syncSkillEnvToGcs(userId, user?.subdomain, rawJwt);

    return NextResponse.json({ success: true });
  } catch (e) {
    console.error('[skills/connections] DELETE error:', e);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
