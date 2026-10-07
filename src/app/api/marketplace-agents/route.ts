import { NextRequest, NextResponse } from 'next/server';
import pool, { getUserId } from '@/lib/db';
import { parseAgentPricing, pricingSummary, type Pricing } from '@/lib/pricing';

const VALID_CATEGORIES = [
  'education', 'customer-support', 'sales', 'writing', 'coding', 'data',
  'hr', 'finance', 'operations', 'legal', 'creative',
];

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** POST /api/marketplace-agents — create a new marketplace agent */
export async function POST(request: NextRequest) {
  try {
    const userId = getUserId(request);
    if (!userId) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }

    const body = await request.json();
    const { name, description, short_description, category, tags, integrations, capabilities, price, pricing: rawPricing } = body;

    if (!name || typeof name !== 'string' || name.trim().length < 2) {
      return NextResponse.json({ error: 'Name is required (min 2 chars)' }, { status: 400 });
    }
    if (!description || typeof description !== 'string' || description.trim().length < 10) {
      return NextResponse.json({ error: 'Description is required (min 10 chars)' }, { status: 400 });
    }
    if (!category || !VALID_CATEGORIES.includes(category)) {
      return NextResponse.json({ error: `Category must be one of: ${VALID_CATEGORIES.join(', ')}` }, { status: 400 });
    }

    const slug = slugify(name.trim());
    if (!slug) {
      return NextResponse.json({ error: 'Name must contain alphanumeric characters' }, { status: 400 });
    }

    const { rows: existing } = await pool.query('SELECT id FROM marketplace_agents WHERE slug = $1', [slug]);
    if (existing.length > 0) {
      return NextResponse.json({ error: 'An agent with a similar name already exists' }, { status: 409 });
    }

    // Price and usage per type of user; agents are always free for education.
    // A bare `price` from older clients becomes the monthly business price.
    let pricing: Pricing;
    if (rawPricing !== undefined) {
      const parsed = parseAgentPricing(rawPricing);
      if ('error' in parsed) {
        return NextResponse.json({ error: parsed.error }, { status: 400 });
      }
      pricing = parsed.pricing;
    } else {
      const legacy = typeof price === 'number' && price > 0 ? price : 0;
      pricing = {
        education: { price: 'free' },
        individuals: { price: 'free' },
        business: legacy > 0 ? { price: 'paid', amount: legacy, currency: 'USD', period: 'month' } : { price: 'free' },
      };
    }
    const agentPrice = pricing.business.price === 'paid' ? pricing.business.amount ?? 0 : 0;
    const priceLabel = pricingSummary(pricing);

    const { rows } = await pool.query(
      `INSERT INTO marketplace_agents
        (slug, name, description, short_description, category, developer,
         price, price_label, rating, review_count, total_installs, version,
         verified, tags, integrations, capabilities, pricing)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0,0,0,'1.0.0',false,$9,$10,$11,$12)
       RETURNING *`,
      [
        slug,
        name.trim(),
        description.trim(),
        (short_description || '').trim() || description.trim().slice(0, 120),
        category,
        'Community',
        agentPrice,
        priceLabel,
        Array.isArray(tags) ? tags : [],
        Array.isArray(integrations) ? integrations : [],
        Array.isArray(capabilities) ? capabilities : [],
        JSON.stringify(pricing),
      ]
    );

    return NextResponse.json({ agent: rows[0] }, { status: 201 });
  } catch (err) {
    console.error('Create marketplace agent error:', err);
    return NextResponse.json({ error: 'Failed to create agent' }, { status: 500 });
  }
}

/** GET /api/marketplace-agents — list marketplace agents */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const search = searchParams.get('search') || '';
  const category = searchParams.get('category') || '';
  const sort = searchParams.get('sort') || 'rating';
  const limit = Math.min(parseInt(searchParams.get('limit') || '50', 10), 100);
  const offset = parseInt(searchParams.get('offset') || '0', 10);

  try {
    const conditions: string[] = [];
    const params: (string | number)[] = [];
    let paramIdx = 1;

    if (search) {
      conditions.push(`(name ILIKE $${paramIdx} OR description ILIKE $${paramIdx} OR tags::text ILIKE $${paramIdx})`);
      params.push(`%${search}%`);
      paramIdx++;
    }
    if (category) {
      conditions.push(`category = $${paramIdx}`);
      params.push(category);
      paramIdx++;
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    let orderBy = 'rating DESC, review_count DESC';
    if (sort === 'installs') orderBy = 'total_installs DESC';
    else if (sort === 'newest') orderBy = 'created_at DESC';
    else if (sort === 'name') orderBy = 'name ASC';
    else if (sort === 'price') orderBy = 'price ASC';

    const limitParamIdx = paramIdx++;
    const offsetParamIdx = paramIdx++;
    params.push(limit, offset);

    const query = `
      SELECT id, slug, name, short_description, description, category, developer,
             price, price_label, pricing, rating, review_count, total_installs, version,
             verified, tags, integrations, icon_url, created_at
      FROM marketplace_agents
      ${where}
      ORDER BY ${orderBy}
      LIMIT $${limitParamIdx} OFFSET $${offsetParamIdx}
    `;

    const { rows } = await pool.query(query, params);

    return NextResponse.json({
      agents: rows,
      pagination: {
        total: offset + rows.length + (rows.length === limit ? 1 : 0),
        limit,
        offset,
        hasMore: rows.length === limit,
      },
    });
  } catch (err) {
    console.error('List marketplace agents error:', err);
    return NextResponse.json({
      agents: [],
      pagination: { total: 0, limit, offset, hasMore: false },
    });
  }
}
