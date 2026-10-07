import { NextRequest, NextResponse } from 'next/server';
import pool, { getUserId } from '@/lib/db';

const GATEWAY_URL =
  process.env.GATEWAY_URL ||
  process.env.NEXT_PUBLIC_GATEWAY_URL ||
  '';

/**
 * POST /api/agents/generate — Generate an agent from a natural language prompt.
 * Uses the LLM to produce SOUL/SKILL/HEARTBEAT/CHANNEL configuration,
 * then inserts the agent into marketplace_agents.
 */
export async function POST(request: NextRequest) {
  const userId = getUserId(request);
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const authHeader = request.headers.get('authorization');
  if (!authHeader) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: { prompt: string; name?: string; category?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { prompt } = body;
  if (!prompt || typeof prompt !== 'string' || prompt.trim().length < 10) {
    return NextResponse.json({ error: 'Prompt must be at least 10 characters' }, { status: 400 });
  }

  // Ask the LLM to generate agent configuration from the prompt
  const systemInstructions = `You are an AI agent architect. Given a user's description of what they want an AI agent to do, generate a complete agent configuration in JSON format.

Return ONLY valid JSON with exactly this structure (no markdown, no explanation):
{
  "name": "Short agent name (2-5 words)",
  "slug": "kebab-case-slug",
  "short_description": "One-line description (max 100 chars)",
  "description": "Detailed description (2-3 sentences)",
  "category": "one of: customer-support, sales, writing, coding, data, hr, finance, operations, legal, creative",
  "tags": ["tag1", "tag2", "tag3"],
  "capabilities": ["capability1", "capability2", "capability3"],
  "integrations": [],
  "key_benefits": [
    {"title": "Benefit 1", "description": "Short description"},
    {"title": "Benefit 2", "description": "Short description"}
  ],
  "system_prompt": "You are [agent role]. Your purpose is [purpose]. You communicate in [style]. Your core principles are: [principles]. When given a task, you [approach].",
  "soul_config": {
    "identity": "Who the agent is",
    "purpose": "Primary mission",
    "communication_style": "How it communicates",
    "principles": ["principle1", "principle2"],
    "personality_traits": ["trait1", "trait2"]
  },
  "skills_config": [
    {
      "name": "Skill name",
      "description": "What this skill does",
      "trigger": "When to use this skill",
      "instructions": "Step-by-step instructions"
    }
  ],
  "heartbeat_config": {
    "enabled": false,
    "interval": "30m",
    "checks": ["What to check periodically"],
    "active_hours": "9am-10pm"
  },
  "channels_config": {
    "web": {"enabled": true},
    "discord": {"enabled": false},
    "slack": {"enabled": false},
    "telegram": {"enabled": false}
  },
  "model": "openclaw",
  "max_runtime_hours": 0
}

Rules:
- The system_prompt should be detailed and actionable (200-500 words)
- Skills should be specific to the agent's purpose
- Set heartbeat.enabled=true only if the agent needs proactive monitoring
- max_runtime_hours: 0 = on-demand only, >0 = can run as background task for that many hours
- Be creative but practical`;

  try {
    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

    let aiEndpoint: string;
    let aiHeaders: Record<string, string>;
    let aiModel: string;

    if (GATEWAY_URL) {
      const base = GATEWAY_URL.replace(/\/+$/, '');
      aiEndpoint = `${base}/v1/chat/completions`;
      aiHeaders = { 'Content-Type': 'application/json', Authorization: authHeader };
      aiModel = 'openclaw';
    } else if (OPENAI_API_KEY) {
      aiEndpoint = 'https://api.openai.com/v1/chat/completions';
      aiHeaders = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      };
      aiModel = 'gpt-4o-mini';
    } else if (process.env.MOONSHOT_API_KEY) {
      aiEndpoint = 'https://api.moonshot.ai/v1/chat/completions';
      aiHeaders = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.MOONSHOT_API_KEY}`,
      };
      aiModel = 'kimi-k2.5';
    } else {
      return NextResponse.json(
        { error: 'No AI provider configured. Set GATEWAY_URL, OPENAI_API_KEY, or MOONSHOT_API_KEY.' },
        { status: 503 },
      );
    }

    const res = await fetch(aiEndpoint, {
      method: 'POST',
      headers: aiHeaders,
      body: JSON.stringify({
        model: aiModel,
        messages: [
          { role: 'system', content: systemInstructions },
          { role: 'user', content: prompt },
        ],
        stream: false,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error('LLM generation failed:', res.status, errText);
      return NextResponse.json(
        { error: 'Failed to generate agent configuration. Please try again.' },
        { status: 502 }
      );
    }

    const data = await res.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    const rawContent = data?.choices?.[0]?.message?.content?.trim() || '';

    // Extract JSON from response (handle markdown code blocks)
    let jsonStr = rawContent;
    const jsonMatch = rawContent.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
    if (jsonMatch) {
      jsonStr = jsonMatch[1].trim();
    }

    let agentConfig: Record<string, unknown>;
    try {
      agentConfig = JSON.parse(jsonStr);
    } catch {
      console.error('Failed to parse LLM response as JSON:', rawContent.slice(0, 500));
      return NextResponse.json(
        { error: 'Failed to parse agent configuration. Please try a different prompt.' },
        { status: 422 }
      );
    }

    // Override with user-provided values if any
    if (body.name) agentConfig.name = body.name;
    if (body.category) agentConfig.category = body.category;

    // Generate a unique slug
    const baseSlug = String(agentConfig.slug || agentConfig.name || 'agent')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 50);
    const slug = `${baseSlug}-${Date.now().toString(36)}`;

    // Insert into marketplace_agents
    const { rows } = await pool.query(
      `INSERT INTO marketplace_agents (
        slug, name, description, short_description, category, developer,
        price, price_label, tags, integrations, capabilities, key_benefits,
        about, system_prompt, soul_config, skills_config, heartbeat_config,
        channels_config, model, creator_id, is_public, max_runtime_hours, verified
      ) VALUES (
        $1, $2, $3, $4, $5, $6,
        0, 'Free', $7, $8, $9, $10,
        $11, $12, $13, $14, $15,
        $16, $17, $18, true, $19, false
      ) RETURNING *`,
      [
        slug,
        String(agentConfig.name || 'Custom Agent').slice(0, 200),
        String(agentConfig.description || ''),
        String(agentConfig.short_description || '').slice(0, 200),
        String(agentConfig.category || 'operations'),
        'User Generated',
        agentConfig.tags || [],
        agentConfig.integrations || [],
        agentConfig.capabilities || [],
        JSON.stringify(agentConfig.key_benefits || []),
        String(agentConfig.description || ''),
        String(agentConfig.system_prompt || ''),
        JSON.stringify(agentConfig.soul_config || {}),
        JSON.stringify(agentConfig.skills_config || []),
        JSON.stringify(agentConfig.heartbeat_config || {}),
        JSON.stringify(agentConfig.channels_config || {}),
        String(agentConfig.model || 'openclaw'),
        userId,
        Number(agentConfig.max_runtime_hours) || 0,
      ]
    );

    // Auto-install for the creator
    await pool.query(
      `INSERT INTO user_installed_agents (user_id, agent_id, is_active)
       VALUES ($1, $2, true)
       ON CONFLICT (user_id, agent_id) DO UPDATE SET is_active = true`,
      [userId, rows[0].id]
    );

    return NextResponse.json({ agent: rows[0] }, { status: 201 });
  } catch (err) {
    console.error('Agent generation error:', err);
    return NextResponse.json(
      { error: 'Failed to generate agent' },
      { status: 500 }
    );
  }
}
