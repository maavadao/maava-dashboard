/**
 * GET /api/backend-status
 *
 * Lightweight endpoint that checks whether the authenticated user's tenant
 * backend is deployed and reachable. Used by the chat UI to determine if the
 * input should be enabled or if a provisioning overlay should be shown.
 */
import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest } from "@/lib/auth";
import { resolveTenantBackend } from "@/lib/tenant-lookup";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const user = await authenticateRequest(request);
  if (!user) {
    return NextResponse.json({ ready: false, reason: "unauthenticated" }, { status: 401 });
  }

  if (!user.subdomain) {
    return NextResponse.json({ ready: false, reason: "no-subdomain" });
  }

  const tenant = await resolveTenantBackend(user.subdomain);
  if (!tenant?.backendUrl) {
    return NextResponse.json({ ready: false, reason: "provisioning" });
  }

  return NextResponse.json({ ready: true });
}
