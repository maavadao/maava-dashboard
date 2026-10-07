/**
 * GET /api/debug/gcs
 *
 * Diagnostic endpoint — tests the full bucket-manager / GCS write path.
 * Returns step-by-step results so you can pinpoint exactly where the failure is.
 *
 * Requires a valid user JWT (same as all other /api routes).
 */
import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest } from "@/lib/auth";

const BUCKET_MANAGER_URL = process.env.BUCKET_MANAGER_URL || "";
const BUCKET_MANAGER_API_SECRET = process.env.BUCKET_MANAGER_API_SECRET || "";
const SHARED_BUCKET = process.env.GCS_SHARED_BUCKET || "barrsa-prod-tentant-platform-data";

async function fetchOidcToken(audience: string): Promise<{ token: string | null; error: string | null }> {
  if (!process.env.K_SERVICE) return { token: null, error: "K_SERVICE not set (not on Cloud Run)" };
  try {
    const res = await fetch(
      `http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=${encodeURIComponent(audience)}`,
      { headers: { "Metadata-Flavor": "Google" }, signal: AbortSignal.timeout(3000) }
    );
    if (!res.ok) return { token: null, error: `Metadata server returned HTTP ${res.status}` };
    const token = (await res.text()).trim();
    return { token: token.slice(0, 20) + "…[truncated]", error: null };
  } catch (e) {
    return { token: null, error: String(e) };
  }
}

async function testBmEndpoint(url: string, headers: Record<string, string>): Promise<{ status: number | null; body: string; error: string | null }> {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
    const body = await res.text();
    return { status: res.status, body: body.slice(0, 500), error: null };
  } catch (e) {
    return { status: null, body: "", error: String(e) };
  }
}

export async function GET(request: NextRequest) {
  const user = await authenticateRequest(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const results: Record<string, unknown> = {};

  // 1. Env vars
  results.env = {
    BUCKET_MANAGER_URL: BUCKET_MANAGER_URL || "(empty — NOT SET)",
    BUCKET_MANAGER_API_SECRET: BUCKET_MANAGER_API_SECRET ? "(set)" : "(empty)",
    GCS_SHARED_BUCKET: SHARED_BUCKET,
    K_SERVICE: process.env.K_SERVICE || "(not set — local dev)",
    NODE_ENV: process.env.NODE_ENV,
  };

  if (!BUCKET_MANAGER_URL) {
    return NextResponse.json({ ...results, conclusion: "BUCKET_MANAGER_URL is not set — all GCS writes will fail" });
  }

  // 2. OIDC token
  const oidc = await fetchOidcToken(BUCKET_MANAGER_URL);
  results.oidcToken = oidc;

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (BUCKET_MANAGER_API_SECRET) headers["X-Bucket-Manager-Secret"] = BUCKET_MANAGER_API_SECRET;
  if (oidc.token) {
    // Reconstruct full token for actual use - fetch again
    try {
      const res = await fetch(
        `http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=${encodeURIComponent(BUCKET_MANAGER_URL)}`,
        { headers: { "Metadata-Flavor": "Google" }, signal: AbortSignal.timeout(3000) }
      );
      if (res.ok) headers["Authorization"] = `Bearer ${(await res.text()).trim()}`;
    } catch { /* ignore */ }
  }

  // 3. Test root endpoint (unauthenticated GET — should always return 200 if reachable)
  results.rootPing = await testBmEndpoint(`${BUCKET_MANAGER_URL}/`, {});

  // 4. Test bucket list (GET — no secret required)
  results.bucketList = await testBmEndpoint(
    `${BUCKET_MANAGER_URL}/api/v1/buckets`,
    headers
  );

  // 5. Test read user's config file
  const filePath = `${user.userId}/mountfolder/openclaw.json`;
  results.readTest = await testBmEndpoint(
    `${BUCKET_MANAGER_URL}/api/v1/buckets/${encodeURIComponent(SHARED_BUCKET)}/files/${filePath}`,
    headers
  );

  // 6. Test write (PUT) with a minimal probe value
  const writeUrl = `${BUCKET_MANAGER_URL}/api/v1/buckets/${encodeURIComponent(SHARED_BUCKET)}/files/${filePath}`;
  let writeResult: Record<string, unknown>;
  try {
    const existing = (results.readTest as { status: number; body: string }).status === 200
      ? (results.readTest as { body: string }).body
      : null;

    // Only write back exactly what we read (or skip if we couldn't read)
    // We intentionally do NOT overwrite with test data to avoid corrupting the file.
    // Instead, write a separate diagnostic probe file.
    const probeUrl = `${BUCKET_MANAGER_URL}/api/v1/buckets/${encodeURIComponent(SHARED_BUCKET)}/files/${user.userId}/mountfolder/.openclaw-probe`;
    const writeRes = await fetch(probeUrl, {
      method: "PUT",
      headers,
      body: JSON.stringify({ probe: true, ts: new Date().toISOString() }),
      signal: AbortSignal.timeout(10_000),
    });
    const writeBody = await writeRes.text();
    writeResult = { status: writeRes.status, body: writeBody.slice(0, 500), error: null };
    if (writeRes.ok) {
      // Clean up probe file
      await fetch(probeUrl, { method: "DELETE", headers, signal: AbortSignal.timeout(5000) }).catch(() => {});
    }
    void existing; // unused — only read to check status
  } catch (e) {
    writeResult = { status: null, body: "", error: String(e) };
  }
  results.writeTest = writeResult;

  // Conclusion
  const readOk = (results.readTest as { status: number }).status === 200 || (results.readTest as { status: number }).status === 404;
  const writeOk = (results.writeTest as { status: number }).status === 200;
  results.conclusion = writeOk
    ? "✅ Bucket-manager is reachable and GCS writes work correctly"
    : readOk
    ? `❌ Read works but WRITE failed (HTTP ${(results.writeTest as { status: number }).status}) — check bucket-manager GCS credentials or IAM`
    : `❌ Cannot reach bucket-manager — check BUCKET_MANAGER_URL and Cloud Run IAM`;

  return NextResponse.json(results, { status: 200 });
}
