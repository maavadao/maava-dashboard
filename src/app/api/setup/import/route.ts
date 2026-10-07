/**
 * POST /api/setup/import — Upload local OpenClaw data to the user's cloud backend.
 *
 * Accepts a multipart/form-data request with a ZIP file containing:
 *   - openclaw.json (main config)
 *   - agents/ (agent data, sessions)
 *   - credentials/ (provider API keys)
 *   - workspace/ (workspace files)
 *
 * Streams the ZIP to the user's Cloud Run backend for extraction.
 */
import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest, createJWT } from "@/lib/auth";
import { resolveTenantBackend } from "@/lib/tenant-lookup";
import { checkRateLimit, RATE_LIMITS } from "@/lib/rate-limit";

const MAX_UPLOAD_SIZE = 100 * 1024 * 1024; // 100 MB

/** Validate backend URL to prevent SSRF */
const ALLOWED_BACKEND = [
  /^https:\/\/[a-z0-9-]+\.run\.app\/?/,
  /^https:\/\/[a-z0-9-]+\.a\.run\.app\/?/,
  /^http:\/\/localhost:\d+\/?/,
];
function isAllowedUrl(url: string): boolean {
  return ALLOWED_BACKEND.some((p) => p.test(url));
}

export async function POST(request: NextRequest) {
  const user = await authenticateRequest(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!user.subdomain) {
    return NextResponse.json(
      { error: "No workspace provisioned. Complete onboarding first." },
      { status: 400 }
    );
  }

  // Rate limit: 10 imports per hour per user
  const rl = checkRateLimit(user.userId, RATE_LIMITS.import);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many import attempts. Please try again later." },
      { status: 429 }
    );
  }

  // Resolve tenant backend
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

  // Check content-length
  const contentLength = parseInt(request.headers.get("content-length") || "0", 10);
  if (contentLength > MAX_UPLOAD_SIZE) {
    return NextResponse.json(
      { error: `Upload too large. Maximum size is ${MAX_UPLOAD_SIZE / 1024 / 1024} MB.` },
      { status: 413 }
    );
  }

  // Forward the request body to the backend's import endpoint
  const body = await request.arrayBuffer();
  const contentType = request.headers.get("content-type") || "application/octet-stream";

  try {
    // Create a fresh short-lived JWT from the validated claims so the backend
    // never sees an expired or stale cookie token.
    const freshToken = await createJWT(user, '5m');

    const backendRes = await fetch(`${tenant.backendUrl}/api/v1/data/import`, {
      method: "POST",
      headers: {
        "Content-Type": contentType,
        "X-Tenant-ID": tenant.tenantId,
        Authorization: `Bearer ${freshToken}`,
      },
      body,
    });

    if (!backendRes.ok) {
      const errText = await backendRes.text().catch(() => "Import failed");
      return NextResponse.json(
        { error: errText },
        { status: backendRes.status }
      );
    }

    const result = await backendRes.json().catch(() => ({ success: true }));
    return NextResponse.json(result);
  } catch (err) {
    console.error("[import] Backend request failed:", err);
    return NextResponse.json(
      { error: "Failed to connect to your workspace backend" },
      { status: 502 }
    );
  }
}
