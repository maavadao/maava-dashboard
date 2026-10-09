import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest } from '@/lib/auth';

/**
 * GET /api/media/workspace/:path*
 *
 * Proxy that serves workspace files (images, media) from the maava-storage.
 * Maps: /api/media/workspace/filename.png
 *   →  STORAGE/api/v1/buckets/{SHARED_BUCKET}/files/{tenantId}/mountfolder/workspace/filename.png
 *
 * Authenticates the user and resolves their tenant before proxying.
 */

const STORAGE_URL = process.env.STORAGE_URL || '';
const STORAGE_API_SECRET = process.env.STORAGE_API_SECRET || '';
const SHARED_BUCKET = process.env.GCS_SHARED_BUCKET || 'maava-data';

async function bmHeaders(): Promise<Record<string, string>> {
  const h: Record<string, string> = {};
  if (STORAGE_API_SECRET) h['X-Storage-Secret'] = STORAGE_API_SECRET;
  if (process.env.K_SERVICE) {
    try {
      const metaUrl =
        `http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity` +
        `?audience=${encodeURIComponent(STORAGE_URL)}`;
      const res = await fetch(metaUrl, {
        headers: { 'Metadata-Flavor': 'Google' },
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) h['Authorization'] = `Bearer ${(await res.text()).trim()}`;
    } catch { /* local dev fallback */ }
  }
  return h;
}

const MIME_MAP: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  mp4: 'video/mp4',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
};

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  if (!STORAGE_URL) {
    return NextResponse.json({ error: 'Media service unavailable' }, { status: 503 });
  }

  // Authenticate
  const user = await authenticateRequest(req);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const userId = user.userId;
  if (!userId) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 });
  }

  const { path } = await params;
  const filePath = path.join('/');

  // Validate: no path traversal
  if (filePath.includes('..') || filePath.startsWith('/')) {
    return NextResponse.json({ error: 'Invalid path' }, { status: 400 });
  }

  // Build maava-storage URL:
  // {tenantId}/mountfolder/workspace/{filePath}
  const gcsPath = `${userId}/mountfolder/workspace/${filePath}`;
  const bmUrl = `${STORAGE_URL}/api/v1/buckets/${encodeURIComponent(SHARED_BUCKET)}/files/${gcsPath}`;

  try {
    const headers = await bmHeaders();
    const bmRes = await fetch(bmUrl, {
      headers,
      signal: AbortSignal.timeout(15_000),
    });

    if (!bmRes.ok) {
      if (bmRes.status === 404) {
        return NextResponse.json({ error: 'File not found' }, { status: 404 });
      }
      return NextResponse.json({ error: 'Failed to fetch file' }, { status: bmRes.status });
    }

    // Determine content type from extension
    const ext = filePath.split('.').pop()?.toLowerCase() || '';
    const contentType = MIME_MAP[ext] || bmRes.headers.get('content-type') || 'application/octet-stream';

    const body = bmRes.body;
    if (!body) {
      return NextResponse.json({ error: 'Empty response' }, { status: 502 });
    }

    return new NextResponse(body, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=3600, immutable',
        ...(bmRes.headers.get('content-length')
          ? { 'Content-Length': bmRes.headers.get('content-length')! }
          : {}),
      },
    });
  } catch (err) {
    console.error('[media-proxy] Error fetching file:', err);
    return NextResponse.json({ error: 'Failed to proxy file' }, { status: 502 });
  }
}
