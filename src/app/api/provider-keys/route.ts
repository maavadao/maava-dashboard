import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest } from "@/lib/auth";
import pool from "@/lib/db";
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "crypto";

const ALLOWED_PROVIDERS = ["openai", "anthropic", "google", "moonshot"];

const SALT = "mawadao-provider-keys";
let encKey: Buffer | undefined;
function getEncKey(): Buffer {
  if (!encKey) {
    const secret = process.env.PROVIDER_KEY_SECRET || process.env.JWT_SECRET;
    if (!secret) throw new Error("PROVIDER_KEY_SECRET or JWT_SECRET must be set");
    encKey = scryptSync(secret, SALT, 32);
  }
  return encKey;
}

function encrypt(text: string): string {
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-cbc", getEncKey(), iv);
  const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return iv.toString("hex") + ":" + encrypted.toString("hex");
}

function decrypt(data: string): string {
  const [ivHex, encHex] = data.split(":");
  if (!ivHex || !encHex) return "";
  const decipher = createDecipheriv("aes-256-cbc", getEncKey(), Buffer.from(ivHex, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(encHex, "hex")), decipher.final()]).toString("utf8");
}

function mask(key: string): string {
  if (key.length <= 12) return "****";
  return key.slice(0, 8) + "..." + key.slice(-4);
}

/** GET /api/provider-keys — list saved provider keys (masked) */
export async function GET(request: NextRequest) {
  const user = await authenticateRequest(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await pool.query(
      `SELECT id, provider, api_key, label, is_active, created_at, updated_at
       FROM provider_keys WHERE user_id = $1 ORDER BY provider ASC`,
      [user.userId],
    );

    const keys = result.rows.map((row) => ({
      id: row.id,
      provider: row.provider,
      maskedKey: mask(decrypt(row.api_key)),
      label: row.label,
      isActive: row.is_active,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));

    return NextResponse.json({ success: true, providers: keys });
  } catch (err) {
    console.error("[api/provider-keys GET]", err);
    return NextResponse.json({ success: true, providers: [] });
  }
}

/** POST /api/provider-keys — upsert a provider API key */
export async function POST(request: NextRequest) {
  const user = await authenticateRequest(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const provider = String(body.provider || "").toLowerCase().trim();
  const apiKey = String(body.apiKey || "").trim();
  const label = body.label ? String(body.label).trim().slice(0, 255) : null;

  if (!ALLOWED_PROVIDERS.includes(provider)) {
    return NextResponse.json(
      { error: `Invalid provider. Allowed: ${ALLOWED_PROVIDERS.join(", ")}` },
      { status: 400 },
    );
  }

  if (!apiKey || apiKey.length < 10) {
    return NextResponse.json({ error: "API key must be at least 10 characters" }, { status: 400 });
  }

  try {
    const encrypted = encrypt(apiKey);
    const result = await pool.query(
      `INSERT INTO provider_keys (user_id, provider, api_key, label, is_active)
       VALUES ($1, $2, $3, $4, true)
       ON CONFLICT (user_id, provider)
       DO UPDATE SET api_key = EXCLUDED.api_key, label = EXCLUDED.label, is_active = true, updated_at = NOW()
       RETURNING id, provider, label, is_active, created_at, updated_at`,
      [user.userId, provider, encrypted, label],
    );

    const row = result.rows[0];
    return NextResponse.json({
      success: true,
      provider: {
        id: row.id,
        provider: row.provider,
        maskedKey: mask(apiKey),
        label: row.label,
        isActive: row.is_active,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      },
    });
  } catch (err) {
    console.error("[api/provider-keys POST]", err);
    return NextResponse.json({ error: "Failed to save provider key" }, { status: 500 });
  }
}

/** PATCH /api/provider-keys — toggle a provider's is_active flag */
export async function PATCH(request: NextRequest) {
  const user = await authenticateRequest(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const provider = String(body.provider || "").toLowerCase().trim();
  const isActive = Boolean(body.isActive);

  if (!ALLOWED_PROVIDERS.includes(provider)) {
    return NextResponse.json(
      { error: `Invalid provider. Allowed: ${ALLOWED_PROVIDERS.join(", ")}` },
      { status: 400 },
    );
  }

  try {
    // If deactivating, ensure at least one other provider stays active
    if (!isActive) {
      const activeResult = await pool.query(
        `SELECT provider FROM provider_keys WHERE user_id = $1 AND is_active = true AND provider != $2`,
        [user.userId, provider],
      );
      if (activeResult.rowCount === 0) {
        return NextResponse.json(
          { error: "At least one provider must remain active" },
          { status: 400 },
        );
      }
    }

    const result = await pool.query(
      `UPDATE provider_keys SET is_active = $3, updated_at = NOW()
       WHERE user_id = $1 AND provider = $2
       RETURNING id, provider, is_active`,
      [user.userId, provider, isActive],
    );

    if (result.rowCount === 0) {
      return NextResponse.json({ error: "Provider key not found" }, { status: 404 });
    }

    return NextResponse.json({ success: true, provider: result.rows[0] });
  } catch (err) {
    console.error("[api/provider-keys PATCH]", err);
    return NextResponse.json({ error: "Failed to toggle provider" }, { status: 500 });
  }
}

/** DELETE /api/provider-keys?provider=openai — remove a provider key */
export async function DELETE(request: NextRequest) {
  const user = await authenticateRequest(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const provider = request.nextUrl.searchParams.get("provider")?.toLowerCase().trim();
  if (!provider || !ALLOWED_PROVIDERS.includes(provider)) {
    return NextResponse.json({ error: "Invalid or missing provider parameter" }, { status: 400 });
  }

  try {
    const result = await pool.query(
      "DELETE FROM provider_keys WHERE user_id = $1 AND provider = $2 RETURNING id",
      [user.userId, provider],
    );

    if (result.rowCount === 0) {
      return NextResponse.json({ error: "Provider key not found" }, { status: 404 });
    }

    return NextResponse.json({ success: true, deleted: true });
  } catch (err) {
    console.error("[api/provider-keys DELETE]", err);
    return NextResponse.json({ error: "Failed to delete provider key" }, { status: 500 });
  }
}
