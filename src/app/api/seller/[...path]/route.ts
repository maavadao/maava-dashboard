import { NextRequest, NextResponse } from "next/server";
import { authenticateRequestOrApiKey } from "@/lib/auth";

const CONFIGURATION_API = (
  process.env.MAWADAO_API_URL || "https://mawadao.com/api/v1"
).replace(/\/+$/, "");

/**
 * Catch-all proxy for /api/seller/* → mawa-api /api/v1/seller/*
 *
 * Authenticates the request, then forwards the ORIGINAL bearer token
 * so the mawa-api can validate it natively (supports both
 * mawadao_ API keys and Go-auth JWTs).
 */

function buildHeaders(
  request: NextRequest,
  userId: string,
  rawToken: string | null
): Headers {
  const headers = new Headers();
  headers.set(
    "Content-Type",
    request.headers.get("content-type") || "application/json"
  );
  headers.set("X-User-ID", userId);

  // Forward the original token so mawa-api can authenticate natively
  if (rawToken) {
    headers.set("Authorization", `Bearer ${rawToken}`);
  }

  const tenantId = request.headers.get("x-tenant-id");
  if (tenantId) {
    headers.set("X-Tenant-ID", tenantId);
  }

  return headers;
}

async function handleRequest(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path } = await params;
  const targetPath = `seller/${path.join("/")}`;

  // Public endpoints that don't require auth
  const PUBLIC_PATHS = [
    "seller/categories",
    "seller/marketplace/browse",
    "seller/orders/webhook/payment",
  ];
  const isPublic = PUBLIC_PATHS.some(
    (p) => targetPath === p || targetPath.startsWith(`${p}?`)
  );

  let userId = "";
  let rawToken: string | null = null;

  if (!isPublic) {
    const auth = await authenticateRequestOrApiKey(request);
    if (!auth) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    userId = auth.user.userId;
    // Prefer the explicit Authorization header (mawadao_ API key or manual JWT).
    // Fall back to auth.authToken which covers cookie-authenticated sessions
    // (the JWT from the auth-token cookie, forwarded so mawa-api can
    // authenticate natively without needing to read cookies itself).
    const authHeader = request.headers.get("authorization");
    rawToken = authHeader?.startsWith("Bearer ")
      ? authHeader.slice(7)
      : auth.authToken;
  }

  // Forward query parameters
  const search = request.nextUrl.searchParams.toString();
  const qs = search ? `?${search}` : "";
  const targetUrl = `${CONFIGURATION_API}/${targetPath}${qs}`;

  console.log(`[api/seller] ${request.method} ${targetPath} → ${targetUrl} userId=${userId || 'public'} hasToken=${!!rawToken}`);

  try {
    const body =
      request.method !== "GET" && request.method !== "HEAD"
        ? await request.arrayBuffer()
        : undefined;

    if (body && body.byteLength > 0) {
      console.log(`[api/seller] ${request.method} ${targetPath} bodySize=${body.byteLength}`);
    }

    const res = await fetch(targetUrl, {
      method: request.method,
      headers: buildHeaders(request, userId, rawToken),
      body,
    });

    console.log(`[api/seller] ${request.method} ${targetPath} → status=${res.status}`);

    const contentType = res.headers.get("content-type");
    const responseHeaders = new Headers();
    if (contentType) responseHeaders.set("Content-Type", contentType);

    const responseBody = await res.arrayBuffer();
    if (!res.ok) {
      const errPreview = new TextDecoder().decode(responseBody.slice(0, 500));
      console.error(`[api/seller] ${request.method} ${targetPath} FAILED: status=${res.status} body=${errPreview}`);
    }
    return new NextResponse(responseBody, {
      status: res.status,
      headers: responseHeaders,
    });
  } catch (err) {
    console.error("[api/seller] Proxy error:", err);
    return NextResponse.json(
      { error: "Seller service unavailable" },
      { status: 503 }
    );
  }
}

export const GET = handleRequest;
export const POST = handleRequest;
export const PUT = handleRequest;
export const DELETE = handleRequest;
export const PATCH = handleRequest;
