import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest } from '@/lib/auth';
import { readUserConfig, writeUserConfig, DEFAULT_GATEWAY_CONFIG } from '@/lib/gcs';

/** GET /api/config — fetch user's openclaw.json from GCS */
export async function GET(request: NextRequest) {
  const user = await authenticateRequest(request);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const config = await readUserConfig(user.userId);
    return NextResponse.json({ success: true, config: config ?? DEFAULT_GATEWAY_CONFIG });
  } catch (err) {
    console.error('[api/config GET]', err);
    return NextResponse.json({ success: true, config: DEFAULT_GATEWAY_CONFIG });
  }
}

/** PUT /api/config — persist user's openclaw.json to GCS */
export async function PUT(request: NextRequest) {
  const user = await authenticateRequest(request);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json({ error: 'Config must be a JSON object' }, { status: 400 });
  }

  try {
    await writeUserConfig(user.userId, body);
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('[api/config PUT]', err);
    return NextResponse.json({ error: 'Failed to save config' }, { status: 500 });
  }
}
