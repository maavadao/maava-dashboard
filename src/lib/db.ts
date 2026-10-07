import { Pool } from 'pg';
import type { NextRequest } from 'next/server';

const rawConnString = process.env.DATABASE_URL ?? '';

// Singleton pool — shared across all API routes
const pool = new Pool({
  connectionString: rawConnString.replace(/[?&]sslmode=[^&]*/g, '').replace(/[?&]$/, ''),
  ssl: { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 5000,
});

// Prevent uncaughtException when Supabase pooler silently drops idle connections.
pool.on('error', (err) => {
  console.error('[db] Idle client error (safe to ignore ECONNRESET):', err.message);
});

/**
 * Execute a query within a transaction that sets the RLS user context.
 * Required for tables with FORCE ROW LEVEL SECURITY + app.current_user_id policies.
 *
 * NOTE: SET LOCAL does not support $1 parameterized queries in PostgreSQL,
 * so we validate userId format and use escaped string interpolation.
 */
export async function queryWithRLS(
  userId: string,
  sql: string,
  params?: unknown[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<{ rows: any[] }> {
  // Validate userId is a safe UUID or Supabase auth ID (alphanumeric + hyphens)
  if (!/^[a-zA-Z0-9_-]+$/.test(userId)) {
    throw new Error(`[queryWithRLS] Invalid userId format: ${userId.slice(0, 50)}`);
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // SET LOCAL does not support $1 params — use validated string with proper escaping
    await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [userId]);
    const result = await client.query(sql, params);
    await client.query('COMMIT');
    return { rows: result.rows };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Run schema migrations idempotently on pool startup
pool.connect()
  .then(async (client) => {
    try {
      await client.query(`ALTER TABLE IF EXISTS conversations ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL`);
      await client.query(`ALTER TABLE IF EXISTS conversations ADD COLUMN IF NOT EXISTS agent_id TEXT DEFAULT NULL`);
      await client.query(`ALTER TABLE IF EXISTS messages ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_conversations_user_updated ON conversations(user_id, updated_at DESC) WHERE deleted_at IS NULL`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_messages_conv_created_live ON messages(conversation_id, created_at ASC) WHERE deleted_at IS NULL`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_messages_conv_created ON messages(conversation_id, created_at ASC)`);
      await client.query(`
        CREATE TABLE IF NOT EXISTS user_skills (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id TEXT NOT NULL,
          skill_id TEXT NOT NULL,
          source TEXT NOT NULL DEFAULT '',
          is_active BOOLEAN NOT NULL DEFAULT TRUE,
          installed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (user_id, skill_id)
        )
      `);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_user_skills_user ON user_skills(user_id) WHERE is_active = TRUE`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_user_skills_lookup ON user_skills(user_id, skill_id, source)`);
      await client.query(`
        CREATE TABLE IF NOT EXISTS user_chat_preferences (
          user_id TEXT PRIMARY KEY,
          selected_model TEXT NOT NULL DEFAULT 'openclaw',
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      /* Skills catalog — community skill cards browsed from Skills Hub */
      await client.query(`
        CREATE TABLE IF NOT EXISTS skills (
          id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          skill_id    TEXT NOT NULL,
          name        TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          category    TEXT NOT NULL DEFAULT 'general',
          installs    INTEGER NOT NULL DEFAULT 0,
          source      TEXT NOT NULL DEFAULT '',
          source_url  TEXT NOT NULL DEFAULT '',
          created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (skill_id, source)
        )
      `);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_skills_category ON skills(category)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_skills_installs ON skills(installs DESC)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_skills_category_installs ON skills(category, installs DESC)`);
      /* Marketplace agents catalog */
      await client.query(`
        CREATE TABLE IF NOT EXISTS marketplace_agents (
          id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          slug              TEXT UNIQUE NOT NULL,
          name              TEXT NOT NULL,
          description       TEXT NOT NULL DEFAULT '',
          short_description TEXT NOT NULL DEFAULT '',
          category          TEXT NOT NULL DEFAULT 'general',
          developer         TEXT NOT NULL DEFAULT '',
          price             NUMERIC(10,2) NOT NULL DEFAULT 0,
          price_label       TEXT NOT NULL DEFAULT 'Free',
          rating            NUMERIC(3,2) NOT NULL DEFAULT 0,
          review_count      INTEGER NOT NULL DEFAULT 0,
          total_installs    INTEGER NOT NULL DEFAULT 0,
          version           TEXT NOT NULL DEFAULT '1.0.0',
          verified          BOOLEAN NOT NULL DEFAULT FALSE,
          tags              TEXT[] NOT NULL DEFAULT '{}',
          integrations      TEXT[] NOT NULL DEFAULT '{}',
          capabilities      TEXT[] NOT NULL DEFAULT '{}',
          key_benefits      JSONB NOT NULL DEFAULT '[]',
          about             TEXT NOT NULL DEFAULT '',
          icon_url          TEXT,
          created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_marketplace_agents_category ON marketplace_agents(category)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_marketplace_agents_rating ON marketplace_agents(rating DESC)`);

      /* Agent architecture columns (SOUL/SKILL/HEARTBEAT/CHANNEL) on marketplace_agents */
      await client.query(`ALTER TABLE marketplace_agents ADD COLUMN IF NOT EXISTS soul_config JSONB DEFAULT '{}'::jsonb`);
      await client.query(`ALTER TABLE marketplace_agents ADD COLUMN IF NOT EXISTS skills_config JSONB DEFAULT '[]'::jsonb`);
      await client.query(`ALTER TABLE marketplace_agents ADD COLUMN IF NOT EXISTS heartbeat_config JSONB DEFAULT '{}'::jsonb`);
      await client.query(`ALTER TABLE marketplace_agents ADD COLUMN IF NOT EXISTS channels_config JSONB DEFAULT '{}'::jsonb`);
      await client.query(`ALTER TABLE marketplace_agents ADD COLUMN IF NOT EXISTS system_prompt TEXT DEFAULT ''`);
      await client.query(`ALTER TABLE marketplace_agents ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true`);
      await client.query(`ALTER TABLE marketplace_agents ADD COLUMN IF NOT EXISTS model TEXT DEFAULT 'openclaw'`);
      await client.query(`ALTER TABLE marketplace_agents ADD COLUMN IF NOT EXISTS creator_id TEXT`);
      await client.query(`ALTER TABLE marketplace_agents ADD COLUMN IF NOT EXISTS is_public BOOLEAN DEFAULT true`);
      await client.query(`ALTER TABLE marketplace_agents ADD COLUMN IF NOT EXISTS max_runtime_hours INTEGER DEFAULT 0`);
      await client.query(`ALTER TABLE marketplace_agents ADD COLUMN IF NOT EXISTS pricing JSONB NOT NULL DEFAULT '{"education":{"price":"free"},"individuals":{"price":"free"},"business":{"price":"free"}}'::jsonb`);

      /* User installed agents */
      await client.query(`
        CREATE TABLE IF NOT EXISTS user_installed_agents (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id TEXT NOT NULL,
          agent_id UUID NOT NULL,
          is_active BOOLEAN NOT NULL DEFAULT true,
          config_overrides JSONB DEFAULT '{}'::jsonb,
          installed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          last_used_at TIMESTAMPTZ,
          UNIQUE (user_id, agent_id)
        )
      `);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_user_installed_agents_user ON user_installed_agents(user_id) WHERE is_active = true`);

      /* Agent tasks */
      await client.query(`
        CREATE TABLE IF NOT EXISTS agent_tasks (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id TEXT NOT NULL,
          agent_id UUID NOT NULL,
          conversation_id TEXT,
          task_prompt TEXT NOT NULL,
          task_type TEXT NOT NULL DEFAULT 'one-shot',
          status TEXT NOT NULL DEFAULT 'pending',
          result TEXT,
          error TEXT,
          progress INTEGER DEFAULT 0,
          started_at TIMESTAMPTZ,
          completed_at TIMESTAMPTZ,
          scheduled_for TIMESTAMPTZ,
          heartbeat_interval TEXT,
          last_heartbeat_at TIMESTAMPTZ,
          next_heartbeat_at TIMESTAMPTZ,
          max_runtime_hours INTEGER DEFAULT 24,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_agent_tasks_user ON agent_tasks(user_id)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_agent_tasks_status ON agent_tasks(status) WHERE status IN ('pending', 'running')`);

      /* MC bridge columns — link agent_tasks to Mission Control board tasks */
      await client.query(`ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS mc_task_id TEXT`);
      await client.query(`ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS mc_board_id TEXT`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_agent_tasks_mc_task ON agent_tasks(mc_task_id) WHERE mc_task_id IS NOT NULL`);

      /* Optimistic concurrency version for MC ↔ agent_task sync */
      await client.query(`ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS sync_version INTEGER NOT NULL DEFAULT 0`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_agent_tasks_mc_sync ON agent_tasks(mc_task_id, sync_version) WHERE mc_task_id IS NOT NULL`);

      /* Agent memory */
      await client.query(`
        CREATE TABLE IF NOT EXISTS agent_memory (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          agent_id UUID NOT NULL,
          user_id TEXT NOT NULL,
          memory_type TEXT NOT NULL DEFAULT 'conversation',
          content TEXT NOT NULL,
          metadata JSONB DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_agent_memory_agent_user ON agent_memory(agent_id, user_id)`);

      /* Agent channel connections */
      await client.query(`
        CREATE TABLE IF NOT EXISTS agent_channels (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id TEXT NOT NULL,
          agent_id TEXT,
          channel_type VARCHAR(50) NOT NULL,
          channel_name VARCHAR(255),
          credentials JSONB NOT NULL DEFAULT '{}',
          metadata JSONB DEFAULT '{}',
          is_active BOOLEAN NOT NULL DEFAULT true,
          connected_at TIMESTAMPTZ,
          last_error TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (user_id, channel_type)
        )
      `);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_agent_channels_user ON agent_channels(user_id) WHERE is_active = true`);

      /* Provider API keys — encrypted storage for OpenAI, Anthropic, etc. */
      await client.query(`
        CREATE TABLE IF NOT EXISTS provider_keys (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id UUID NOT NULL,
          provider VARCHAR(50) NOT NULL,
          api_key TEXT NOT NULL,
          label VARCHAR(255),
          is_active BOOLEAN NOT NULL DEFAULT TRUE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (user_id, provider)
        )
      `);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_provider_keys_user ON provider_keys(user_id) WHERE is_active = true`);

      await client.query(`
        CREATE TABLE IF NOT EXISTS user_onboarding_preferences (
          user_id TEXT PRIMARY KEY,
          interests TEXT[] NOT NULL DEFAULT '{}',
          provider TEXT NOT NULL DEFAULT 'moonshot',
          onboarding_completed_at TIMESTAMPTZ,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      /* Skill connection API keys — encrypted storage for per-skill integrations */
      await client.query(`
        CREATE TABLE IF NOT EXISTS user_skill_api_keys (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id TEXT NOT NULL,
          skill_key TEXT NOT NULL,
          env_key TEXT NOT NULL,
          key_value TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (user_id, skill_key, env_key)
        )
      `);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_user_skill_api_keys_user ON user_skill_api_keys(user_id)`);

      /* Slack OAuth workspace installations */
      await client.query(`
        CREATE TABLE IF NOT EXISTS slack_connections (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          mawadao_user_id TEXT NOT NULL,
          slack_team_id VARCHAR(64) NOT NULL,
          slack_team_name VARCHAR(255),
          slack_bot_token TEXT NOT NULL,
          slack_bot_user_id VARCHAR(64),
          slack_authed_user_id VARCHAR(64),
          slack_scope TEXT,
          slack_enterprise_id VARCHAR(64),
          slack_installed_by_user_id VARCHAR(64),
          slack_app_id VARCHAR(64),
          is_active BOOLEAN NOT NULL DEFAULT TRUE,
          metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (slack_team_id, mawadao_user_id)
        )
      `);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_slack_connections_mawadao_user_id ON slack_connections(mawadao_user_id) WHERE is_active = true`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_slack_connections_slack_team_id ON slack_connections(slack_team_id) WHERE is_active = true`);

      /* Slack identity links — bind individual Slack users to mawaDao users for shared workspaces */
      await client.query(`
        CREATE TABLE IF NOT EXISTS slack_identity_links (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          mawadao_user_id TEXT NOT NULL,
          slack_team_id VARCHAR(64) NOT NULL,
          slack_user_id VARCHAR(64) NOT NULL,
          slack_channel_id VARCHAR(64),
          linked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (slack_team_id, slack_user_id)
        )
      `);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_slack_identity_links_team ON slack_identity_links(slack_team_id)`);

      /* Slack event deduplication log */
      await client.query(`
        CREATE TABLE IF NOT EXISTS slack_event_log (
          event_id VARCHAR(64) PRIMARY KEY,
          team_id VARCHAR(64) NOT NULL,
          processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_slack_event_log_processed ON slack_event_log(processed_at)`);

      /* Inbox accounts — Gmail / Outlook OAuth installations per user */
      await client.query(`
        CREATE TABLE IF NOT EXISTS inbox_accounts (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id TEXT NOT NULL,
          provider TEXT NOT NULL CHECK (provider IN ('gmail', 'outlook')),
          account_email TEXT NOT NULL,
          display_name TEXT,
          scopes TEXT[] NOT NULL DEFAULT '{}',
          token_ciphertext TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked', 'error')),
          last_error TEXT,
          last_synced_at TIMESTAMPTZ,
          metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (user_id, provider, account_email)
        )
      `);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_inbox_accounts_user ON inbox_accounts(user_id) WHERE status = 'active'`);

      /* Inbox AI policy per account (1:1 with inbox_accounts) */
      await client.query(`
        CREATE TABLE IF NOT EXISTS inbox_ai_policies (
          account_id UUID PRIMARY KEY REFERENCES inbox_accounts(id) ON DELETE CASCADE,
          mode TEXT NOT NULL DEFAULT 'approval_required' CHECK (mode IN ('off', 'approval_required', 'autonomous')),
          can_send BOOLEAN NOT NULL DEFAULT FALSE,
          can_reply BOOLEAN NOT NULL DEFAULT FALSE,
          can_forward BOOLEAN NOT NULL DEFAULT FALSE,
          can_delete BOOLEAN NOT NULL DEFAULT FALSE,
          can_archive BOOLEAN NOT NULL DEFAULT FALSE,
          can_label BOOLEAN NOT NULL DEFAULT FALSE,
          approval_required_for_send BOOLEAN NOT NULL DEFAULT TRUE,
          max_actions_per_hour INTEGER NOT NULL DEFAULT 20,
          excluded_addresses TEXT[] NOT NULL DEFAULT '{}',
          excluded_labels TEXT[] NOT NULL DEFAULT '{}',
          allowed_label_targets TEXT[] NOT NULL DEFAULT '{}',
          custom_instructions TEXT NOT NULL DEFAULT '',
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);

      /* Inbox OAuth state — short-lived CSRF tokens for OAuth round-trips (defence in depth alongside signed JWT state) */
      await client.query(`
        CREATE TABLE IF NOT EXISTS inbox_oauth_states (
          state_token TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          provider TEXT NOT NULL CHECK (provider IN ('gmail', 'outlook')),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          consumed_at TIMESTAMPTZ
        )
      `);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_inbox_oauth_states_created ON inbox_oauth_states(created_at)`);

      /* Inbox drafts — AI-generated reply drafts pending user approval */
      await client.query(`
        CREATE TABLE IF NOT EXISTS inbox_drafts (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id TEXT NOT NULL,
          account_id UUID NOT NULL REFERENCES inbox_accounts(id) ON DELETE CASCADE,
          source_message_id TEXT NOT NULL,
          source_thread_id TEXT,
          to_addr TEXT NOT NULL,
          subject TEXT NOT NULL,
          body_text TEXT NOT NULL,
          model TEXT,
          status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'rejected')),
          metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          sent_at TIMESTAMPTZ
        )
      `);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_inbox_drafts_user_status ON inbox_drafts(user_id, status, created_at DESC)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_inbox_drafts_account ON inbox_drafts(account_id)`);
    } catch (e) {
      console.error('[db] Auto-migration error:', e);
    } finally {
      client.release();
    }
  })
  .catch((e) => console.error('[db] Failed to connect for auto-migration:', e));

export default pool;

/**
 * Extract the authenticated user's ID from a request.
 * Reads from the `x-user-id` header set by the frontend.
 * Returns null when the header is absent or equals "anonymous".
 */
export function getUserId(request: NextRequest): string | null {
  const id = request.headers.get('x-user-id');
  if (!id || id === 'anonymous') return null;
  return id;
}
