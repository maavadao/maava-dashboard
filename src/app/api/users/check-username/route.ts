import { NextRequest, NextResponse } from "next/server";

const API_BASE = process.env.BARRSA_API_URL;

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const username = searchParams.get("username");

    if (!username) {
      return NextResponse.json(
        { error: "Username is required" },
        { status: 400 }
      );
    }

    const response = await fetch(
      `${API_BASE}/users/check-username?username=${encodeURIComponent(username)}`,
      { headers: { "Content-Type": "application/json" } }
    );

    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
