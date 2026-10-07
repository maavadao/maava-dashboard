import { NextRequest, NextResponse } from "next/server";

// Server-side only — never exposed to the browser bundle
const GATEWAY_CONFIG_API = (
  process.env.GATEWAY_CONFIG_API_URL || ""
).replace(/\/+$/, "");

function fwdHeaders(req: NextRequest): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const auth = req.headers.get("authorization");
  const tenantId = req.headers.get("x-tenant-id");
  if (auth) headers["Authorization"] = auth;
  if (tenantId) headers["X-Tenant-ID"] = tenantId;
  return headers;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path } = await params;
  const targetPath = path.join("/");

  let body = "{}";
  try {
    body = await request.text();
  } catch {
    // empty body is fine
  }

  try {
    const res = await fetch(`${GATEWAY_CONFIG_API}/${targetPath}`, {
      method: "POST",
      headers: fwdHeaders(request),
      body,
    });
    const data = await res.json().catch(() => ({}));
    return NextResponse.json(data, { status: res.status });
  } catch {
    // Config API not running — return structured 503 instead of ERR_CONNECTION_REFUSED
    return NextResponse.json(
      { success: false, message: "mawaDao Agent config API unreachable", error: "connection_refused" },
      { status: 503 }
    );
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path } = await params;
  const targetPath = path.join("/");

  // Return a graceful empty payload for status/health endpoints when the
  // local mawaDao Agent gateway is not running (cloud mode).
  const GRACEFUL_FALLBACKS: Record<string, unknown> = {
    "channels/status": { success: true, data: [], message: "Gateway not running" },
    "health": { success: true, status: "degraded", message: "Gateway not running" },
    "status": { success: true, data: null, message: "Gateway not running" },
  };

  try {
    const res = await fetch(`${GATEWAY_CONFIG_API}/${targetPath}`, {
      method: "GET",
      headers: fwdHeaders(request),
      signal: AbortSignal.timeout(3000),
    });
    const data = await res.json().catch(() => ({}));
    return NextResponse.json(data, { status: res.status });
  } catch {
    // Return a 200 graceful fallback for known status endpoints so the browser
    // console stays clean in cloud deployments where the gateway isn't running.
    if (targetPath in GRACEFUL_FALLBACKS) {
      return NextResponse.json(GRACEFUL_FALLBACKS[targetPath]);
    }
    return NextResponse.json(
      { success: false, message: "mawaDao Agent config API unreachable", error: "connection_refused" },
      { status: 503 }
    );
  }
}
