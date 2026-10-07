import { NextRequest, NextResponse } from "next/server";

const API_BASE = process.env.MAWADAO_API_URL;

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    const response = await fetch(`${API_BASE}/agents/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

/** GET /api/agents
 *  - ?name=foo  → get a specific agent's public profile
 *  - otherwise  → list agents (public, paginated)  ?sort=karma|new &limit= &offset=
 */
export async function GET(request: NextRequest) {
  try {
    const authHeader = request.headers.get("authorization");
    const { searchParams } = new URL(request.url);
    const name = searchParams.get("name");

    if (name) {
      // Public profile lookup
      const response = await fetch(
        `${API_BASE}/agents/profile?name=${encodeURIComponent(name)}`,
        { headers: authHeader ? { Authorization: authHeader } : {} }
      );
      const data = await response.json();
      return NextResponse.json(data, { status: response.status });
    }

    // Public agent list — forward sort / limit / offset
    const params = new URLSearchParams();
    ["sort", "limit", "offset"].forEach((k) => {
      const v = searchParams.get(k);
      if (v) params.set(k, v);
    });

    const response = await fetch(`${API_BASE}/agents?${params}`, {
      headers: authHeader ? { Authorization: authHeader } : {},
    });
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
