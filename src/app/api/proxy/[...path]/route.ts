/**
 * Generic API proxy — forwards authenticated requests to the user's Cloud Run backend.
 *
 * Path: /api/proxy/[...path]
 * Example: /api/proxy/v1/config/get → https://<user-backend>.run.app/api/v1/config/get
 *
 * Flow:
 *   1. Validate JWT (from cookie or Authorization header)
 *   2. Resolve backend URL via tenant-lookup (Redis cache → DB)
 *   3. Forward request with X-Tenant-ID, Authorization headers
 *   4. Stream response back to client
 */
import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest } from "@/lib/auth";
import { resolveTenantBackend } from "@/lib/tenant-lookup";
import { checkRateLimit, RATE_LIMITS } from "@/lib/rate-limit";

const CLOUD_MODE = process.env.NEXT_PUBLIC_CLOUD_MODE === "true";

/**
 * Upstream fetch ceiling for proxied requests. Long enough to absorb a
 * Cloud Run cold start (gcsfuse mount + container init can take ~60–90s on
 * first hit) but bounded so a hung tenant gateway can't pin a Next.js
 * worker indefinitely.
 */
const PROXY_FETCH_TIMEOUT_MS = 120_000;

/**
 * Allowlist of backend URL patterns to prevent SSRF.
 *
 * Cloud Run emits two hostname formats:
 *   - Legacy: `{service}-{hash}-{regionAbbr}.a.run.app`
 *             (e.g. `maavadao-foo-abc123-ew.a.run.app`)
 *   - New:    `{service}-{projectNumber}.{region}.run.app`
 *             (e.g. `maavadao-foo-12345.europe-west1.run.app`)
 *
 * The new format contains a dot in the subdomain (`.europe-west1.`) so the
 * previous `[a-z0-9-]+\.run\.app` pattern silently rejected every newly
 * provisioned tenant URL — surfacing as a 502 "Backend URL is not allowed".
 */
const ALLOWED_BACKEND_PATTERNS = [
  /^https:\/\/[a-z0-9-]+\.a\.run\.app(?:\/|$)/,                    // Cloud Run legacy
  /^https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.run\.app(?:\/|$)/,           // Cloud Run new format (service.region.run.app)
  /^https:\/\/[a-z0-9-]+\.run\.app(?:\/|$)/,                       // Cloud Run short form (no region)
  /^http:\/\/localhost:\d+(?:\/|$)/,                                // Local dev only
];

function isAllowedBackendUrl(url: string): boolean {
  return ALLOWED_BACKEND_PATTERNS.some((p) => p.test(url));
}

/** Paths that must not be proxied (internal-only endpoints) */
const BLOCKED_PATHS = [
  "/healthz", "/readyz", "/api/v1/health",
  "/data/import", "/data/export",  // Use dedicated endpoints instead
];

async function proxyRequest(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  // Cloud mode is required for proxy routing
  if (!CLOUD_MODE) {
    return NextResponse.json(
      { error: "Proxy routing is only available in cloud mode" },
      { status: 404 }
    );
  }

  // Authenticate
  const user = await authenticateRequest(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!user.subdomain) {
    return NextResponse.json(
      { error: "No tenant provisioned. Complete onboarding first." },
      { status: 403 }
    );
  }

  // Rate limit: 120 requests per minute per user
  const rl = checkRateLimit(user.userId, RATE_LIMITS.proxy);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Rate limit exceeded. Please slow down." },
      { status: 429 }
    );
  }

  // Resolve backend URL
  const tenant = await resolveTenantBackend(user.subdomain);
  if (!tenant || !tenant.backendUrl) {
    return NextResponse.json(
      { error: "Backend not available. Your instance may still be provisioning." },
      { status: 503 }
    );
  }

  // SSRF protection: verify backend URL is an allowed destination
  if (!isAllowedBackendUrl(tenant.backendUrl)) {
    console.error(`[proxy] Blocked SSRF attempt to ${tenant.backendUrl}`);
    return NextResponse.json(
      { error: "Backend URL is not allowed" },
      { status: 502 }
    );
  }

  // Build target URL
  const { path } = await params;
  const targetPath = `/api/${path.join("/")}`;

  // Block internal-only paths
  if (BLOCKED_PATHS.some((bp) => targetPath.startsWith(bp))) {
    return NextResponse.json(
      { error: "This endpoint is not accessible via proxy" },
      { status: 403 }
    );
  }

  const targetUrl = new URL(targetPath, tenant.backendUrl);

  // Forward query parameters
  const searchParams = request.nextUrl.searchParams.toString();
  if (searchParams) {
    targetUrl.search = searchParams;
  }

  // Forward request
  const headers = new Headers();
  headers.set("Content-Type", request.headers.get("content-type") || "application/json");
  headers.set("X-Tenant-ID", tenant.tenantId);
  // Note: Next.js 15 removed `request.ip`. Forwarded-For is best-effort from
  // upstream proxy headers; missing header is fine for backend logging.
  const xff = request.headers.get("x-forwarded-for");
  if (xff) headers.set("X-Forwarded-For", xff);

  // Forward auth token
  const authHeader = request.headers.get("authorization");
  if (authHeader) {
    headers.set("Authorization", authHeader);
  } else {
    const token = request.cookies.get("auth-token")?.value;
    if (token) {
      headers.set("Authorization", `Bearer ${token}`);
    }
  }

  // Bound the upstream call so a wedged tenant gateway can never pin this
  // request indefinitely. Tied to the client AbortSignal so a user nav-away
  // also tears down the upstream socket.
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), PROXY_FETCH_TIMEOUT_MS);
  // Forward client cancellation
  const onClientAbort = () => abort.abort();
  request.signal.addEventListener("abort", onClientAbort, { once: true });

  try {
    const body =
      request.method !== "GET" && request.method !== "HEAD"
        ? await request.arrayBuffer()
        : undefined;

    const backendResponse = await fetch(targetUrl.toString(), {
      method: request.method,
      headers,
      body,
      signal: abort.signal,
    });

    // Stream the response back
    const responseHeaders = new Headers();
    const contentType = backendResponse.headers.get("content-type");
    if (contentType) responseHeaders.set("Content-Type", contentType);
    // `no-transform` prevents intermediate proxies (GCLB / nginx) from
    // gzipping or rewriting SSE chunks, which can break delta delivery.
    responseHeaders.set("Cache-Control", "no-cache, no-transform");

    // Stream if the backend is streaming
    if (
      backendResponse.body &&
      (contentType?.includes("text/event-stream") ||
        contentType?.includes("text/plain"))
    ) {
      // Disable proxy buffering so tokens reach the browser as soon as the
      // worker emits them. Without this an upstream proxy can hold the
      // response until close, surfacing as a stalled UI.
      responseHeaders.set("Connection", "keep-alive");
      responseHeaders.set("X-Accel-Buffering", "no");
      // Once we hand the body to NextResponse, leaving the per-request
      // timeout active would abort the stream mid-flight. Clear it; the
      // upstream client cancel listener still propagates user disconnects.
      clearTimeout(timeout);
      return new NextResponse(backendResponse.body, {
        status: backendResponse.status,
        headers: responseHeaders,
      });
    }

    // Non-streaming: forward body as-is
    const responseBody = await backendResponse.arrayBuffer();
    return new NextResponse(responseBody, {
      status: backendResponse.status,
      headers: responseHeaders,
    });
  } catch (err) {
    const aborted = (err as Error)?.name === "AbortError" || abort.signal.aborted;
    console.error("Proxy error:", aborted ? "upstream aborted/timeout" : err);
    return NextResponse.json(
      {
        error: aborted
          ? "Backend took too long to respond. It may be starting up — please try again."
          : "Backend unreachable. Please try again later.",
      },
      { status: aborted ? 504 : 502 },
    );
  } finally {
    clearTimeout(timeout);
    request.signal.removeEventListener("abort", onClientAbort);
  }
}

export const GET = proxyRequest;
export const POST = proxyRequest;
export const PUT = proxyRequest;
export const DELETE = proxyRequest;
export const PATCH = proxyRequest;
