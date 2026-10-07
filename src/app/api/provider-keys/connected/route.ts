import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest } from "@/lib/auth";
import pool from "@/lib/db";
import { createDecipheriv, scryptSync } from "crypto";

const ENC_SECRET = process.env.PROVIDER_KEY_SECRET || process.env.JWT_SECRET || "barrsa-default-secret-change-me";
const ENC_KEY = scryptSync(ENC_SECRET, "barrsa-provider-keys", 32);

function decrypt(data: string): string {
  const [ivHex, encHex] = data.split(":");
  if (!ivHex || !encHex) return "";
  const decipher = createDecipheriv("aes-256-cbc", ENC_KEY, Buffer.from(ivHex, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(encHex, "hex")), decipher.final()]).toString("utf8");
}

/** Get decrypted provider keys for a user (internal helper) */
export async function getProviderKeysForUser(userId: string): Promise<Record<string, string>> {
  try {
    const result = await pool.query(
      `SELECT provider, api_key FROM provider_keys WHERE user_id = $1 AND is_active = true`,
      [userId],
    );
    const keys: Record<string, string> = {};
    for (const row of result.rows) {
      try {
        keys[row.provider] = decrypt(row.api_key);
      } catch {
        // Skip corrupted keys
      }
    }
    return keys;
  } catch {
    return {};
  }
}

/** GET /api/provider-keys/connected — which providers are connected (no key values) */
export async function GET(request: NextRequest) {
  const user = await authenticateRequest(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await pool.query(
      `SELECT provider FROM provider_keys WHERE user_id = $1 AND is_active = true`,
      [user.userId],
    );
    const providers = result.rows.map((r) => r.provider as string);
    return NextResponse.json({ success: true, providers });
  } catch {
    return NextResponse.json({ success: true, providers: [] });
  }
}
