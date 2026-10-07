import { NextRequest, NextResponse } from 'next/server';
import pool from '@/lib/db';
import { getRequestUserId } from '@/lib/auth';

const GATEWAY_URL =
  process.env.GATEWAY_URL ||
  process.env.NEXT_PUBLIC_GATEWAY_URL ||
  '';

/** POST /api/conversations/[id]/generate-title — AI-generate a short title */
export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const userId = await getRequestUserId(request);
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Verify the conversation belongs to this user
  const { rows: convRows } = await pool.query(
    `SELECT id FROM conversations WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
    [params.id, userId]
  ).catch(() => ({ rows: [] as unknown[] }));
  if ((convRows as unknown[]).length === 0) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  // Build auth header for gateway proxy (cookie auth → reconstruct Bearer)
  const cookieToken = request.cookies.get('auth-token')?.value;
  const authHeader = request.headers.get('authorization') || (cookieToken ? `Bearer ${cookieToken}` : null);

  try {
    // Fetch the first few messages for context
    const { rows: messages } = await pool.query(
      `SELECT role, content FROM messages
       WHERE conversation_id = $1
       ORDER BY created_at ASC
       LIMIT 4`,
      [params.id]
    );

    if (messages.length === 0) {
      return NextResponse.json({ error: 'No messages found' }, { status: 404 });
    }

    const context = messages.map((m: { role: string; content: string }) =>
      `${m.role}: ${m.content.slice(0, 200)}`
    ).join('\n');

    let aiEndpoint: string;
    let aiHeaders: Record<string, string>;
    let aiModel: string;

    if (GATEWAY_URL) {
      const base = GATEWAY_URL.replace(/\/+$/, '');
      aiEndpoint = `${base}/v1/chat/completions`;
      aiHeaders = { 'Content-Type': 'application/json', ...(authHeader ? { Authorization: authHeader } : {}) };
      aiModel = 'openclaw';
    } else if (process.env.OPENAI_API_KEY) {
      aiEndpoint = 'https://api.openai.com/v1/chat/completions';
      aiHeaders = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
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
        { error: 'No AI provider configured' },
        { status: 503 },
      );
    }

    const res = await fetch(aiEndpoint, {
      method: 'POST',
      headers: aiHeaders,
      body: JSON.stringify({
        model: aiModel,
        messages: [
          {
            role: 'system',
            content: 'Generate a very short title (3-6 words, no quotes, no punctuation at the end) that summarizes this conversation. Respond with ONLY the title, nothing else.',
          },
          {
            role: 'user',
            content: context,
          },
        ],
        stream: false,
      }),
    });

    if (!res.ok) {
      return NextResponse.json({ error: 'Failed to generate title' }, { status: 502 });
    }

    const data = await res.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    let title = data?.choices?.[0]?.message?.content?.trim() || '';

    // Clean up: remove quotes, limit length
    title = title.replace(/^["']|["']$/g, '').trim();
    if (title.length > 60) title = title.slice(0, 60);
    if (!title) {
      return NextResponse.json({ error: 'Empty title generated' }, { status: 500 });
    }

    // Update the conversation title (ownership re-checked by WHERE clause)
    await pool.query(
      `UPDATE conversations SET title = $1, updated_at = NOW() WHERE id = $2 AND user_id = $3`,
      [title, params.id, userId]
    );

    return NextResponse.json({ title });
  } catch (err) {
    console.error('Generate title error:', err);
    return NextResponse.json({ error: 'Failed to generate title' }, { status: 500 });
  }
}
