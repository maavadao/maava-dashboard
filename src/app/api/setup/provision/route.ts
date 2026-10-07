/**
 * POST /api/setup/provision — Provisions a new tenant.
 *
 * Flow:
 *   1. Validate JWT (user must be authenticated)
 *   2. Check subdomain availability
 *   3. Create tenant record in DB (status: provisioning)
 *   4. Call Cloud Run Deployer to create backend service
 *   5. Update tenant record with backend URL (status: active)
 *   6. Return new tenant info + updated JWT
 */
import { NextRequest, NextResponse } from "next/server";
import { randomUUID, randomBytes } from "crypto";
import pool from "@/lib/db";
import { authenticateRequest, createJWT } from "@/lib/auth";
import { isSubdomainAvailable } from "@/lib/tenant-lookup";
import { invalidateBackendUrl } from "@/lib/redis";
import { checkRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { encryptSkillValue } from "@/app/api/skills/connections/route";
import { syncSkillEnvToGcs } from "@/lib/sync-skills";

const DEPLOYER_URL =
  process.env.CLOUD_RUN_DEPLOYER_URL || "";
const DEPLOYER_API_SECRET = process.env.DEPLOYER_API_SECRET || "";

/** Reserved subdomains that cannot be claimed */
const RESERVED = new Set([
  "www", "api", "auth", "admin", "app", "mail", "ftp",
  "blog", "docs", "help", "support", "status", "cdn",
  "static", "assets", "media", "images", "test", "staging",
  "dev", "demo", "beta", "dashboard", "console", "panel",
]);

/**
 * GET /api/setup/provision — Redirects browser navigation to the onboarding page.
 */
export function GET() {
  return NextResponse.redirect(
    new URL("/?step=subdomain", process.env.NEXT_PUBLIC_AUTH_URL || "https://barrsa.com"),
    { status: 302 }
  );
}

export async function POST(request: NextRequest) {
  // Authenticate
  const user = await authenticateRequest(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Already has a tenant?
  if (user.subdomain) {
    return NextResponse.json(
      { error: "You already have a tenant provisioned", subdomain: user.subdomain },
      { status: 409 }
    );
  }

  // Rate limit: 3 provisions per hour per user
  const rl = checkRateLimit(user.userId, RATE_LIMITS.provision);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many provisioning attempts. Please try again later." },
      { status: 429 }
    );
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const subdomain = (body.subdomain as string || "").toLowerCase().trim();

  // Validate subdomain format
  if (!subdomain || !/^[a-z][a-z0-9-]{1,61}[a-z0-9]$/.test(subdomain)) {
    return NextResponse.json(
      { error: "Subdomain must be 3-63 chars, start with a letter, contain only lowercase letters, numbers, and hyphens" },
      { status: 400 }
    );
  }

  if (RESERVED.has(subdomain)) {
    return NextResponse.json(
      { error: "This subdomain is reserved" },
      { status: 400 }
    );
  }

  // Check availability
  const available = await isSubdomainAvailable(subdomain);
  if (!available) {
    return NextResponse.json(
      { error: "This subdomain is already taken" },
      { status: 409 }
    );
  }

  const tenantId = randomUUID();
  const gatewayToken = randomBytes(32).toString("hex");

  // Create tenant record (status: provisioning)
  try {
    await pool.query(
      `INSERT INTO tenants (id, user_id, subdomain, region, gateway_token, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'provisioning', NOW(), NOW())`,
      [tenantId, user.userId, subdomain, "europe-west1", gatewayToken]
    );
  } catch (err: unknown) {
    const pgErr = err as { code?: string };
    if (pgErr.code === "23505") {
      return NextResponse.json(
        { error: "This subdomain is already taken" },
        { status: 409 }
      );
    }
    console.error("Failed to create tenant record:", err);
    return NextResponse.json(
      { error: "Failed to create tenant" },
      { status: 500 }
    );
  }

  // Call Cloud Run Deployer
  let serviceUrl: string;
  let deployData: { success?: boolean; serviceUrl?: string; gcsBucket?: string; serviceName?: string } | null = null;
  try {
    const deployRes = await fetch(`${DEPLOYER_URL}/tenants/provision`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(DEPLOYER_API_SECRET ? { "X-Deployer-Secret": DEPLOYER_API_SECRET } : {}),
      },
      body: JSON.stringify({
        subdomain,
        userId: user.userId,
        tenantId,
        gatewayToken,
        region: "europe-west1",
      }),
    });

    if (!deployRes.ok) {
      const errBody = await deployRes.text();
      throw new Error(`Deployer returned ${deployRes.status}: ${errBody}`);
    }

    deployData = (await deployRes.json()) as { success?: boolean; serviceUrl?: string; gcsBucket?: string; serviceName?: string };
    serviceUrl = deployData.serviceUrl || "";

    if (!serviceUrl) {
      throw new Error("Deployer returned OK but no serviceUrl in response");
    }
  } catch (err) {
    console.error("Cloud Run deployment failed:", err);
    // Mark tenant as error
    await pool.query(
      `UPDATE tenants SET status = 'suspended', updated_at = NOW() WHERE id = $1`,
      [tenantId]
    );
    return NextResponse.json(
      { error: "Backend provisioning failed. Please try again later." },
      { status: 502 }
    );
  }

  // Update tenant with backend URL and mark active
  const serviceName = deployData?.serviceName || `barrsa-${subdomain}`;
  const storageBucket = deployData?.gcsBucket || `barrsa-prod-tentant-platform-data`;
  await pool.query(
    `UPDATE tenants SET
       backend_url = $1,
       cloud_run_service_name = $2,
       storage_bucket = $3,
       status = 'active',
       updated_at = NOW()
     WHERE id = $4`,
    [serviceUrl, serviceName, storageBucket, tenantId]
  );

  // Invalidate any cached lookup
  await invalidateBackendUrl(subdomain);

  // ── Auto-provision web_search (Brave) skill for the new user ────────────
  // Install web_search as ACTIVE so every new tenant can search out of the box.
  try {
    await pool.query(
      `INSERT INTO user_skills (user_id, skill_id, source, is_active)
       SELECT $1, s.skill_id, s.source, TRUE
       FROM skills s
       WHERE s.skill_id = 'web_search'
       ORDER BY s.installs DESC
       LIMIT 1
       ON CONFLICT (user_id, skill_id)
       DO UPDATE SET is_active = TRUE`,
      [user.userId],
    );

    // Auto-configure platform Brave API key if available
    const platformBraveKey = process.env.BRAVE_API_KEY;
    if (platformBraveKey) {
      const encrypted = encryptSkillValue(platformBraveKey);
      await pool.query(
        `INSERT INTO user_skill_api_keys (user_id, skill_key, env_key, key_value, updated_at)
         VALUES ($1, 'brave', 'BRAVE_API_KEY', $2, now())
         ON CONFLICT (user_id, skill_key, env_key) DO UPDATE
           SET key_value = EXCLUDED.key_value, updated_at = now()`,
        [user.userId, encrypted],
      );
    }

    // Push skill config + API key to GCS so the gateway picks it up
    void syncSkillEnvToGcs(user.userId, subdomain);
    console.log(`[provision] auto-provisioned web_search skill for user ${user.userId}`);
  } catch (skillErr) {
    // Non-fatal — tenant still works, user can enable manually
    console.warn('[provision] auto-provision web_search failed:', skillErr);
  }

  // Issue updated JWT with subdomain + tenantId
  const newToken = await createJWT({
    userId: user.userId,
    email: user.email,
    subdomain,
    tenantId,
  });

  // Set the new JWT cookie
  const response = NextResponse.json({
    success: true,
    tenant: {
      id: tenantId,
      subdomain,
      backendUrl: serviceUrl,
      storageBucket,
      region: "europe-west1",
    },
  });

  response.cookies.set("auth-token", newToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 7 * 24 * 60 * 60,
    domain: process.env.NODE_ENV === "production" ? ".barrsa.com" : undefined,
  });

  return response;
}
