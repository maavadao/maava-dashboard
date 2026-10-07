import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest } from '@/lib/auth';
import pool from '@/lib/db';

/**
 * POST /api/products/import-job — Create a new marketplace import job.
 * Body: { links: string[] }
 *
 * GET /api/products/import-job — List import jobs for the current user.
 */

export async function POST(request: NextRequest) {
  const user = await authenticateRequest(request);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: { links?: string[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const links = body.links;
  if (!Array.isArray(links) || links.length === 0) {
    return NextResponse.json({ error: 'links must be a non-empty array of URLs' }, { status: 400 });
  }

  if (links.length > 20) {
    return NextResponse.json({ error: 'Maximum 20 links per import job' }, { status: 400 });
  }

  // Basic URL validation
  const validLinks: string[] = [];
  for (const link of links) {
    if (typeof link !== 'string') continue;
    const trimmed = link.trim();
    if (!trimmed) continue;
    try {
      const parsed = new URL(trimmed);
      if (!['http:', 'https:'].includes(parsed.protocol)) continue;
      validLinks.push(trimmed);
    } catch {
      // skip invalid URLs
    }
  }

  if (validLinks.length === 0) {
    return NextResponse.json({ error: 'No valid URLs provided' }, { status: 400 });
  }

  // Look up seller_profile_id for the user
  let sellerProfileId: string | null = null;
  try {
    const spResult = await pool.query(
      `SELECT id FROM seller_profiles WHERE user_id = $1 LIMIT 1`,
      [user.userId],
    );
    if (spResult.rows.length > 0) {
      sellerProfileId = spResult.rows[0].id;
    }
  } catch (err) {
    console.error('[import-job] seller profile lookup failed:', err);
  }

  // Create import job row
  const result = await pool.query(
    `INSERT INTO import_jobs (user_id, seller_profile_id, submitted_links, status)
     VALUES ($1, $2, $3, 'queued')
     RETURNING id, status, created_at`,
    [user.userId, sellerProfileId, validLinks],
  );

  const job = result.rows[0];

  // Fire-and-forget: trigger the import worker
  // Derive base URL from the incoming request when NEXT_PUBLIC_SITE_URL is not set
  const baseUrl =
    process.env.NEXT_PUBLIC_SITE_URL ||
    `${request.nextUrl.protocol}//${request.nextUrl.host}`;
  const workerUrl = `${baseUrl}/api/products/import-job/${job.id}/run`;
  fetch(workerUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-Secret': process.env.INTERNAL_API_SECRET || '',
    },
    // No AbortSignal — this is fire-and-forget; the worker runs independently
  }).catch((err) => {
    console.error('[import-job] Failed to trigger worker:', err);
  });

  return NextResponse.json({
    id: job.id,
    status: job.status,
    linkCount: validLinks.length,
    createdAt: job.created_at,
  }, { status: 201 });
}

export async function GET(request: NextRequest) {
  const user = await authenticateRequest(request);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const result = await pool.query(
    `SELECT id, submitted_links, status, product_count, error_count,
            error_message, started_at, completed_at, created_at, updated_at
     FROM import_jobs
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT 50`,
    [user.userId],
  );

  const jobs = result.rows.map((r) => ({
    id: r.id,
    submittedLinks: r.submitted_links,
    status: r.status,
    productCount: r.product_count,
    errorCount: r.error_count,
    errorMessage: r.error_message,
    startedAt: r.started_at,
    completedAt: r.completed_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));

  return NextResponse.json({ data: jobs });
}
