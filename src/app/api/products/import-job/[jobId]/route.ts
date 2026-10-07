import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest } from '@/lib/auth';
import pool from '@/lib/db';

/**
 * GET /api/products/import-job/[jobId] — Get status of a single import job.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const user = await authenticateRequest(request);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { jobId } = await params;

  const result = await pool.query(
    `SELECT id, submitted_links, status, product_count, error_count,
            error_message, raw_workspace_path, raw_bucket_path,
            started_at, completed_at, created_at, updated_at
     FROM import_jobs
     WHERE id = $1 AND user_id = $2`,
    [jobId, user.userId],
  );

  if (result.rows.length === 0) {
    return NextResponse.json({ error: 'Import job not found' }, { status: 404 });
  }

  const r = result.rows[0];
  return NextResponse.json({
    id: r.id,
    submittedLinks: r.submitted_links,
    status: r.status,
    productCount: r.product_count,
    errorCount: r.error_count,
    errorMessage: r.error_message,
    rawWorkspacePath: r.raw_workspace_path,
    rawBucketPath: r.raw_bucket_path,
    startedAt: r.started_at,
    completedAt: r.completed_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  });
}
