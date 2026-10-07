import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest } from '@/lib/auth';
import { writeUserConfig } from '@/lib/gcs';
import AdmZip from 'adm-zip';

/**
 * POST /api/config/import — import a workspace ZIP.
 *
 * Accepts:
 *   - Content-Type: application/zip   (raw binary body)
 *   - Content-Type: multipart/form-data  (field name: "file")
 *
 * What gets imported:
 *   - openclaw.json → written to GCS bucket config/openclaw.json
 */
export async function POST(request: NextRequest) {
  const user = await authenticateRequest(request);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // --- receive ZIP bytes ---
  const contentType = request.headers.get('content-type') ?? '';
  let zipBuffer: Buffer;

  try {
    if (contentType.includes('multipart/form-data')) {
      const formData = await request.formData();
      const file = formData.get('file') as File | null;
      if (!file) {
        return NextResponse.json({ error: 'No file field in form data' }, { status: 400 });
      }
      zipBuffer = Buffer.from(await file.arrayBuffer());
    } else {
      zipBuffer = Buffer.from(await request.arrayBuffer());
    }
  } catch {
    return NextResponse.json({ error: 'Failed to read request body' }, { status: 400 });
  }

  if (zipBuffer.length === 0) {
    return NextResponse.json({ error: 'Empty file' }, { status: 400 });
  }

  if (zipBuffer.length > 100 * 1024 * 1024) {
    return NextResponse.json({ error: 'File too large (max 100 MB)' }, { status: 413 });
  }

  // --- parse ZIP ---
  let zip: AdmZip;
  try {
    zip = new AdmZip(zipBuffer);
  } catch {
    return NextResponse.json({ error: 'Invalid or corrupted ZIP file' }, { status: 400 });
  }

  let importedItems = 0;

  // Import openclaw.json → GCS
  const openclawEntry = zip.getEntry('openclaw.json');
  if (openclawEntry) {
    let config: unknown;
    try {
      config = JSON.parse(openclawEntry.getData().toString('utf-8'));
    } catch {
      return NextResponse.json(
        { error: 'Invalid JSON in openclaw.json inside ZIP' },
        { status: 400 },
      );
    }

    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      return NextResponse.json(
        { error: 'openclaw.json must be a JSON object' },
        { status: 400 },
      );
    }

    await writeUserConfig(user.userId, config);
    importedItems++;
  }

  return NextResponse.json({
    success: true,
    message: `Import completed (${importedItems} item${importedItems !== 1 ? 's' : ''})`,
    itemCount: importedItems,
  });
}
