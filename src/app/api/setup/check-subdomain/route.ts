import { NextRequest, NextResponse } from "next/server";
import { isSubdomainAvailable } from "@/lib/tenant-lookup";
import { checkRateLimit, RATE_LIMITS } from "@/lib/rate-limit";

/** Reserved subdomains that cannot be claimed */
const RESERVED = new Set([
  "www", "api", "auth", "admin", "app", "mail", "ftp",
  "blog", "docs", "help", "support", "status", "cdn",
  "static", "assets", "media", "images", "test", "staging",
  "dev", "demo", "beta", "dashboard", "console", "panel",
]);

const SUBDOMAIN_REGEX = /^[a-z][a-z0-9-]{1,61}[a-z0-9]$/;

export async function GET(request: NextRequest) {
  // Rate limit by IP: 30 checks per minute
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const rl = checkRateLimit(ip, RATE_LIMITS.subdomainCheck);
  if (!rl.allowed) {
    return NextResponse.json(
      { available: false, reason: "Too many requests" },
      { status: 429 }
    );
  }

  const { searchParams } = new URL(request.url);
  const subdomain = (searchParams.get("subdomain") || "").toLowerCase().trim();

  if (!subdomain || !SUBDOMAIN_REGEX.test(subdomain)) {
    return NextResponse.json(
      { available: false, reason: "Invalid format" },
      { status: 200 }
    );
  }

  if (RESERVED.has(subdomain)) {
    return NextResponse.json(
      { available: false, reason: "Reserved" },
      { status: 200 }
    );
  }

  const available = await isSubdomainAvailable(subdomain);
  return NextResponse.json({ available });
}
