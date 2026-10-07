/**
 * Tests for mission-control/api.ts — mcListAgents MC-backend-first with local fallback
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock global fetch ────────────────────────────────────────────────────────
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { mcListAgents } from '@/lib/mission-control/api';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('mcListAgents', () => {
  it('returns MC backend agents when available (maps fields correctly)', async () => {
    const mcResponse = {
      items: [
        {
          id: '11111111-1111-1111-1111-111111111111',
          name: 'Ops Triage Lead',
          status: 'active',
          board_id: 'board-abc',
          gateway_id: 'gw-xyz',
          is_board_lead: true,
          is_gateway_main: false,
          identity_template: 'You are a triage lead.',
          created_at: '2026-01-01T00:00:00Z',
          last_seen_at: '2026-04-01T12:00:00Z',
        },
      ],
      total: 1,
      limit: 200,
      offset: 0,
    };

    // MC proxy call — goes through /api/mission-control/agents
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => mcResponse,
      text: async () => JSON.stringify(mcResponse),
    });

    const result = await mcListAgents();

    expect(result.total).toBe(1);
    const agent = result.items[0];
    expect(agent.name).toBe('Ops Triage Lead');
    expect(agent.source).toBe('mc_backend');
    expect(agent.board_id).toBe('board-abc');
    expect(agent.gateway_id).toBe('gw-xyz');
    expect(agent.is_board_lead).toBe(true);
    expect(agent.is_active).toBe(true); // status === 'active'
    expect(agent.mc_status).toBe('active');
    expect(agent.description).toBe('You are a triage lead.');
    expect(agent.slug).toBe('ops-triage-lead'); // derived from name
  });

  it('falls back to local /api/agents/installed when MC backend fails', async () => {
    const localAgents = [
      {
        id: 'local-1',
        install_id: 'inst-1',
        agent_id: 'ag-1',
        slug: 'my-agent',
        name: 'My Agent',
        short_description: null,
        description: null,
        category: 'general',
        developer: null,
        icon_url: null,
        verified: false,
        is_active: true,
        installed_at: '2026-01-01T00:00:00Z',
        last_used_at: null,
        model: 'openclaw',
      },
    ];

    // First call (MC proxy) fails
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 502,
      text: async () => 'Bad Gateway',
      statusText: 'Bad Gateway',
    });
    // Second call (local fallback)
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ agents: localAgents }),
    });

    const result = await mcListAgents({ limit: 100 });

    expect(result.total).toBe(1);
    expect(result.items[0].name).toBe('My Agent');
    expect(result.items[0].source).toBe('local_db');
    expect(result.limit).toBe(100);
  });

  it('returns empty when both MC backend and local fail', async () => {
    // MC proxy fails
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => 'error',
      statusText: 'error',
    });
    // Local fails too
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({}),
    });

    const result = await mcListAgents();

    expect(result.items).toEqual([]);
    expect(result.total).toBe(0);
  });

  it('passes board_id query param to MC backend', async () => {
    const mcResponse = { items: [], total: 0, limit: 50, offset: 0 };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => mcResponse,
      text: async () => JSON.stringify(mcResponse),
    });

    await mcListAgents({ board_id: 'board-999', limit: 50 });

    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain('board_id=board-999');
    expect(url).toContain('limit=50');
  });

  it('handles network error on MC backend gracefully', async () => {
    // MC backend — fetch throws (network error)
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    // Local fallback
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ agents: [{ id: 'a', name: 'Fallback Agent', slug: 'fb' }] }),
    });

    const result = await mcListAgents();

    expect(result.items.length).toBe(1);
    expect(result.items[0].source).toBe('local_db');
  });
});
