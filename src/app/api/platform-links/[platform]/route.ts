import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest } from "@/lib/auth";
import pool from "@/lib/db";

interface RouteContext {
  params: Promise<{ platform: string }>;
}

/** DELETE /api/platform-links/[platform] — unlink a SaaS platform account */
export async function DELETE(request: NextRequest, context: RouteContext) {
  const user = await authenticateRequest(request);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { platform } = await context.params;

  try {
    const result = await pool.query(
      'DELETE FROM platform_channel_links WHERE user_id = $1 AND platform = $2 RETURNING id',
      [user.userId, platform],
    );

    if (result.rowCount === 0) {
      return NextResponse.json({ error: 'Platform link not found' }, { status: 404 });
    }

    return new NextResponse(null, { status: 204 });
  } catch (err) {
    console.error('[api/platform-links DELETE]', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
