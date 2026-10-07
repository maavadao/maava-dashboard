import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * POST /api/provider-keys/test
 * Body: { provider: string; apiKey: string }
 *
 * Validates the given API key against the provider's API.
 * Returns { valid: true } or { valid: false, error: string }.
 */
export async function POST(request: NextRequest) {
  let body: { provider?: string; apiKey?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ valid: false, error: "Invalid request body" }, { status: 400 });
  }

  const { provider, apiKey } = body;

  if (!provider || typeof provider !== "string") {
    return NextResponse.json({ valid: false, error: "Missing provider" }, { status: 400 });
  }
  if (!apiKey || typeof apiKey !== "string" || !apiKey.trim()) {
    return NextResponse.json({ valid: false, error: "Missing API key" }, { status: 400 });
  }

  const key = apiKey.trim();

  try {
    switch (provider) {
      case "openai": {
        const res = await fetch("https://api.openai.com/v1/models?limit=1", {
          headers: { Authorization: `Bearer ${key}` },
          signal: AbortSignal.timeout(8000),
        });
        if (res.ok) return NextResponse.json({ valid: true });
        const data = await res.json().catch(() => ({})) as { error?: { message?: string } };
        return NextResponse.json({ valid: false, error: data?.error?.message || `HTTP ${res.status}` });
      }

      case "anthropic": {
        const res = await fetch("https://api.anthropic.com/v1/models?limit=1", {
          headers: {
            "x-api-key": key,
            "anthropic-version": "2023-06-01",
          },
          signal: AbortSignal.timeout(8000),
        });
        if (res.ok) return NextResponse.json({ valid: true });
        const data = await res.json().catch(() => ({})) as { error?: { message?: string } };
        return NextResponse.json({ valid: false, error: data?.error?.message || `HTTP ${res.status}` });
      }

      case "google": {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}&pageSize=1`,
          { signal: AbortSignal.timeout(8000) },
        );
        if (res.ok) return NextResponse.json({ valid: true });
        const data = await res.json().catch(() => ({})) as { error?: { message?: string } };
        return NextResponse.json({ valid: false, error: data?.error?.message || `HTTP ${res.status}` });
      }

      case "moonshot": {
        const res = await fetch("https://api.moonshot.ai/v1/models", {
          headers: { Authorization: `Bearer ${key}` },
          signal: AbortSignal.timeout(8000),
        });
        if (res.ok) return NextResponse.json({ valid: true });
        const data = await res.json().catch(() => ({})) as { error?: { message?: string } };
        return NextResponse.json({ valid: false, error: data?.error?.message || `HTTP ${res.status}` });
      }

      default:
        return NextResponse.json({ valid: false, error: `Unknown provider: ${provider}` }, { status: 400 });
    }
  } catch (err) {
    const msg = (err as Error).message || "Network error";
    return NextResponse.json({ valid: false, error: msg });
  }
}
