/**
 * GET /api/setup/export — Download a ZIP backup of the user's cloud workspace data.
 *
 * Proxies to the user's Cloud Run backend GET /api/v1/data/export,
 * streaming the ZIP response back to the client.
 */
import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest, createJWT } from "@/lib/auth";
import { resolveTenantBackend } from "@/lib/tenant-lookup";
import { checkRateLimit, RATE_LIMITS } from "@/lib/rate-limit";

/** Validate backend URL to prevent SSRF */
const ALLOWED_BACKEND = [
  /^https:\/\/[a-z0-9-]+\.run\.app\/?/,
  /^https:\/\/[a-z0-9-]+\.a\.run\.app\/?/,
  /^http:\/\/localhost:\d+\/?/,
];
function isAllowedUrl(url: string): boolean {
  return ALLOWED_BACKEND.some((p) => p.test(url));
}

export async function GET(request: NextRequest) {
  const user = await authenticateRequest(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!user.subdomain) {
    return NextResponse.json(
      { error: "No workspace provisioned" },
      { status: 400 }
    );
  }

  // Rate limit: 20 exports per hour per user
  const rl = checkRateLimit(user.userId, RATE_LIMITS.export);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many export attempts. Please try again later." },
      { status: 429 }
    );
  }

  const tenant = await resolveTenantBackend(user.subdomain);
  if (!tenant) {
    return NextResponse.json(
      { error: "Workspace not found or inactive" },
      { status: 404 }
    );
  }

  if (!isAllowedUrl(tenant.backendUrl)) {
    return NextResponse.json(
      { error: "Backend URL validation failed" },
      { status: 502 }
    );
  }

  try {
    // Create a fresh short-lived JWT from the validated claims so the backend
    // never sees an expired or stale cookie token.
    const freshToken = await createJWT(user, '5m');

    const backendRes = await fetch(`${tenant.backendUrl}/api/v1/data/export`, {
      headers: {
        "X-Tenant-ID": tenant.tenantId,
        Authorization: `Bearer ${freshToken}`,
      },
    });

    if (!backendRes.ok) {
      const errText = await backendRes.text().catch(() => "Export failed");
      return NextResponse.json({ error: errText }, { status: backendRes.status });
    }

    // Stream the ZIP back to the client
    const headers = new Headers();
    headers.set("Content-Type", "application/zip");
    const disposition = backendRes.headers.get("Content-Disposition");
    headers.set(
      "Content-Disposition",
      disposition || `attachment; filename="mawadao-export-${Date.now()}.zip"`
    );
    const contentLength = backendRes.headers.get("Content-Length");
    if (contentLength) {
      headers.set("Content-Length", contentLength);
    }

    return new NextResponse(backendRes.body, {
      status: 200,
      headers,
    });
  } catch (err) {
    console.error("[export] Backend request failed:", err);
    return NextResponse.json(
      { error: "Failed to connect to your workspace backend" },
      { status: 502 }
    );
  }
}
