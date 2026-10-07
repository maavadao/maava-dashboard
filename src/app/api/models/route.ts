import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest } from "@/lib/auth";
import { readUserConfig } from "@/lib/gcs";

export const dynamic = "force-dynamic";

type ModelEntry = { id: string; name: string; provider: string; contextWindow?: number };

/* ── Extract models from user's openclaw.json config ───────────────────── */

function extractModelsFromConfig(config: Record<string, unknown>): ModelEntry[] {
  const models: ModelEntry[] = [];
  const seen = new Set<string>();

  // 1. Get models from agents.defaults.models (map of id → { alias })
  const agents = config.agents as Record<string, unknown> | undefined;
  const defaults = agents?.defaults as Record<string, unknown> | undefined;
  const modelsMap = defaults?.models as Record<string, { alias?: string }> | undefined;

  if (modelsMap && typeof modelsMap === "object") {
    for (const [id, meta] of Object.entries(modelsMap)) {
      if (typeof id !== "string" || seen.has(id)) continue;
      seen.add(id);
      const provider = id.includes("/") ? id.split("/")[0] : "unknown";
      models.push({
        id,
        name: meta?.alias || id.split("/").pop() || id,
        provider,
      });
    }
  }

  // 2. Ensure primary model and fallbacks are included
  const modelConfig = defaults?.model as { primary?: string; fallbacks?: string[] } | string | undefined;
  const primary = typeof modelConfig === "string" ? modelConfig : modelConfig?.primary;
  const fallbacks = typeof modelConfig === "object" ? modelConfig?.fallbacks ?? [] : [];

  for (const id of [primary, ...fallbacks]) {
    if (!id || typeof id !== "string" || seen.has(id)) continue;
    seen.add(id);
    const provider = id.includes("/") ? id.split("/")[0] : "unknown";
    models.push({ id, name: id.split("/").pop() || id, provider });
  }

  // 3. Get models from models.providers.*.models[]
  const modelsSection = config.models as Record<string, unknown> | undefined;
  const providers = modelsSection?.providers as Record<string, { models?: Array<{ id: string; name?: string; contextWindow?: number }> }> | undefined;

  if (providers && typeof providers === "object") {
    for (const [providerName, providerDef] of Object.entries(providers)) {
      for (const m of providerDef?.models ?? []) {
        const fullId = m.id.includes("/") ? m.id : `${providerName}/${m.id}`;
        if (seen.has(fullId)) continue;
        seen.add(fullId);
        models.push({ id: fullId, name: m.name || m.id, provider: providerName, contextWindow: m.contextWindow });
      }
    }
  }

  return models;
}

/* ── Main GET handler ──────────────────────────────────────────────────── */

/**
 * GET /api/models
 *
 * Returns models configured in the user's openclaw.json (from GCS).
 * These are the real, usable models for this tenant.
 */
export async function GET(request: NextRequest) {
  const user = await authenticateRequest(request).catch(() => null);

  console.log(`[models] GET — user=${user?.userId ?? "anon"}`);

  if (!user?.userId) {
    return NextResponse.json({ models: [], source: "none" });
  }

  // Read user's openclaw.json from GCS
  try {
    const config = await readUserConfig(user.userId);
    if (config && typeof config === "object" && !Array.isArray(config)) {
      const models = extractModelsFromConfig(config as Record<string, unknown>);
      if (models.length > 0) {
        console.log(`[models] source=config count=${models.length} ids=[${models.map(m => m.id).join(",")}]`);
        return NextResponse.json({ models, source: "config" });
      }
    }
  } catch (err) {
    console.warn("[models] Failed to read GCS config:", (err as Error).message);
  }

  console.log("[models] no config models found, returning empty");
  return NextResponse.json({ models: [], source: "none" });
}

