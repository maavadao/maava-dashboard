import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest } from '@/lib/auth';
import pool from '@/lib/db';
import { readUserConfig, DEFAULT_OPENCLAW_CONFIG } from '@/lib/gcs';
import AdmZip from 'adm-zip';

/** GET /api/config/export — download user's workspace as a ZIP archive */
export async function GET(request: NextRequest) {
  const user = await authenticateRequest(request);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    // 1. Read openclaw.json from GCS (fall back to default on miss)
    const openclawConfig = (await readUserConfig(user.userId)) ?? DEFAULT_OPENCLAW_CONFIG;

    // 2. Fetch channel metadata from DB (credentials are NOT exported)
    const channelsResult = await pool.query(
      `SELECT channel_type, channel_name, is_active, connected_at, metadata
       FROM agent_channels
       WHERE user_id = $1 AND is_active = true
       ORDER BY created_at ASC`,
      [user.userId],
    );

    const channelsMeta = channelsResult.rows.map((row) => ({
      channelType: row.channel_type,
      channelName: row.channel_name,
      isActive: row.is_active,
      connectedAt: row.connected_at,
      metadata: row.metadata,
    }));

    // 3. Build in-memory ZIP
    const zip = new AdmZip();

    zip.addFile(
      'openclaw.json',
      Buffer.from(JSON.stringify(openclawConfig, null, 2), 'utf-8'),
    );

    zip.addFile(
      'channels.json',
      Buffer.from(
        JSON.stringify(
          { channels: channelsMeta, exportedAt: new Date().toISOString() },
          null,
          2,
        ),
        'utf-8',
      ),
    );

    zip.addFile(
      'README.md',
      Buffer.from(
        [
          '# mawaDao Config Export',
          '',
          `Exported: ${new Date().toISOString()}`,
          `User: ${user.subdomain ?? user.userId}`,
          '',
          '## Files',
          '- **openclaw.json** — gateway and agent configuration',
          '- **channels.json** — connected channel metadata (credentials not included for security)',
          '',
          '## Import',
          'Upload this ZIP via Settings → Data → Import Data.',
        ].join('\n'),
        'utf-8',
      ),
    );

    const zipBuffer = zip.toBuffer();
    const slug = user.subdomain ?? user.userId;
    const filename = `mawadao-${slug}-${Date.now()}.zip`;

    return new NextResponse(new Uint8Array(zipBuffer), {
      status: 200,
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length': String(zipBuffer.byteLength),
      },
    });
  } catch (err) {
    console.error('[api/config/export]', err);
    return NextResponse.json({ error: 'Export failed' }, { status: 500 });
  }
}
