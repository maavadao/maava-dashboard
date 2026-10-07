/**
 * product-actions.ts — Direct DB product creation from chat action blocks.
 *
 * Replaces the old external-API approach (POST to SELLER_API_BASE) with a
 * direct `pool.query()` INSERT so products are guaranteed to land in the
 * database regardless of whether the external seller service is reachable.
 */

import pool from '@/lib/db';
import type { PoolClient } from 'pg';
import { randomUUID } from 'crypto';

// ── Types ──────────────────────────────────────────────────────────────────

export interface ChatProductPayload {
  name: string;
  summary?: string;
  description?: string;
  price?: string;
  pricingModel?: string;
  currency?: string;
  targetAudience?: string;
  categoryId?: string;
  tags?: string[];
  deliverables?: string[];
  productType?: string;
}

export interface CreateProductResult {
  id: string;
  name: string;
  status: string;
  requiresReview: boolean;
  missingFields: string[];
}

// ── Helpers ────────────────────────────────────────────────────────────────

const VALID_PRICING_MODELS = ['one_time', 'subscription', 'custom', 'free', 'contact'] as const;

function normalizePricingModel(raw?: string): string {
  if (!raw) return 'one_time';
  const lower = raw.toLowerCase().replace(/[\s-]+/g, '_');
  if ((VALID_PRICING_MODELS as readonly string[]).includes(lower)) return lower;
  if (lower.includes('free') || lower === '0') return 'free';
  return 'one_time';
}

function normalizePrice(raw?: string): number | null {
  if (!raw) return null;
  const cleaned = raw.replace(/[^0-9.]/g, '');
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : Math.round(num * 100) / 100;
}

function detectMissingFields(p: ChatProductPayload): string[] {
  const missing: string[] = [];
  if (!p.name) missing.push('name');
  if (!p.price && normalizePricingModel(p.pricingModel) !== 'free') missing.push('price');
  if (!p.summary && !p.description) missing.push('summary');
  return missing;
}

/**
 * Resolve or auto-create a seller_profile for the given user.
 * Products require a seller_profile_id (NOT NULL FK), so we ensure one exists.
 */
async function ensureSellerProfile(client: PoolClient, userId: string): Promise<string> {
  // Try to find existing profile
  console.log(`[product-actions] ensureSellerProfile: looking up userId=${userId}`);
  const { rows: existing } = await client.query(
    `SELECT id FROM seller_profiles WHERE user_id = $1 LIMIT 1`,
    [userId],
  );
  if (existing.length > 0) {
    console.log(`[product-actions] ensureSellerProfile: found existing profile id=${existing[0].id}`);
    return existing[0].id;
  }

  // Auto-create a minimal seller profile
  console.log(`[product-actions] ensureSellerProfile: no profile found, creating new one...`);
  const profileId = randomUUID();
  await client.query(
    `INSERT INTO seller_profiles (id, user_id, business_name, approval_required)
     VALUES ($1, $2, $3, false)
     ON CONFLICT (user_id) DO UPDATE SET id = seller_profiles.id
     RETURNING id`,
    [profileId, userId, 'My Store'],
  );

  // Re-fetch in case ON CONFLICT returned the existing one
  const { rows: refetch } = await client.query(
    `SELECT id FROM seller_profiles WHERE user_id = $1 LIMIT 1`,
    [userId],
  );
  const finalId = refetch[0]?.id ?? profileId;
  console.log(`[product-actions] ensureSellerProfile: created/confirmed profile id=${finalId}`);
  return finalId;
}

/**
 * Resolve category_id from slug or name if a UUID wasn't provided.
 */
async function resolveCategoryId(client: PoolClient, raw?: string): Promise<string | null> {
  if (!raw) return null;
  // Already a UUID?
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) {
    return raw;
  }
  // Try slug or name match
  const { rows } = await client.query(
    `SELECT id FROM seller_categories
     WHERE LOWER(slug) = LOWER($1) OR LOWER(name) = LOWER($1)
     LIMIT 1`,
    [raw.trim()],
  );
  return rows[0]?.id ?? null;
}

// ── Main entry point ───────────────────────────────────────────────────────

/**
 * Create a product directly in the database from a chat action block.
 *
 * - Auto-creates seller_profile if missing
 * - Validates & normalizes fields
 * - Sets `requires_review = true` if critical fields are missing
 * - Returns the created product info
 */
export async function createProductFromChat(
  userId: string,
  payload: ChatProductPayload,
  sourceContext?: Record<string, unknown>,
  idempotencyKey?: string,
): Promise<CreateProductResult> {
  console.log(`[product-actions] ─── createProductFromChat START ─── userId=${userId} name="${payload.name}" idempotencyKey="${idempotencyKey}"`);
  console.log(`[product-actions] Payload: ${JSON.stringify(payload).slice(0, 500)}`);

  const client = await pool.connect();
  try {
    // Begin transaction and set RLS user context
    await client.query('BEGIN');
    // SET LOCAL does not support $1 params — use set_config() which does
    await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [userId]);
    console.log(`[product-actions] RLS context set: app.current_user_id = ${userId}`);

    // Idempotency check — if same key already created, return existing
    if (idempotencyKey) {
      console.log(`[product-actions] Checking idempotency key: "${idempotencyKey}"`);
      const { rows: dup } = await client.query(
        `SELECT id, name, status, requires_review, missing_fields
         FROM products
         WHERE user_id = $1 AND idempotency_key = $2`,
        [userId, idempotencyKey],
      );
      if (dup.length > 0) {
        console.log(`[product-actions] ⚡ Idempotent hit: product ${dup[0].id} already exists for key=${idempotencyKey}`);
        await client.query('COMMIT');
        return {
          id: dup[0].id,
          name: dup[0].name,
          status: dup[0].status,
          requiresReview: dup[0].requires_review ?? false,
          missingFields: dup[0].missing_fields ?? [],
        };
      }
      console.log(`[product-actions] No idempotency hit — proceeding with creation`);
    }

    console.log(`[product-actions] Ensuring seller profile for userId=${userId}...`);
    const sellerProfileId = await ensureSellerProfile(client, userId);
    console.log(`[product-actions] Seller profile: id=${sellerProfileId}`);

    const categoryId = await resolveCategoryId(client, payload.categoryId);
    console.log(`[product-actions] Category: raw="${payload.categoryId}" resolved=${categoryId}`);

    const pricingModel = normalizePricingModel(payload.pricingModel);
    const price = normalizePrice(payload.price);
    const missingFields = detectMissingFields(payload);
    const requiresReview = missingFields.length > 0;
    const productId = randomUUID();

    console.log(`[product-actions] Inserting product: id=${productId} price=${price} model=${pricingModel} review=${requiresReview} missing=[${missingFields.join(',')}]`);

    await client.query(
      `INSERT INTO products (
         id, user_id, seller_profile_id, category_id,
         name, summary, description,
         price, pricing_model, currency,
         deliverables, target_audience, tags,
         status, metadata,
         source_context, requires_review, missing_fields,
         idempotency_key, product_type
       ) VALUES (
         $1, $2, $3, $4,
         $5, $6, $7,
         $8, $9, $10,
         $11, $12, $13,
         'draft', $14,
         $15, $16, $17,
         $18, $19
       )`,
      [
        productId,
        userId,
        sellerProfileId,
        categoryId,
        payload.name,
        payload.summary || null,
        payload.description || null,
        price,
        pricingModel,
        payload.currency || 'USD',
        payload.deliverables ?? [],
        payload.targetAudience || null,
        payload.tags ?? [],
        JSON.stringify({}),       // metadata
        sourceContext ? JSON.stringify(sourceContext) : null,
        requiresReview,
        missingFields,
        idempotencyKey || null,
        payload.productType || null,
      ],
    );

    await client.query('COMMIT');

    console.log(`[product-actions] ✅ Product INSERT successful: id=${productId} name="${payload.name}" price=${price} review=${requiresReview} missing=[${missingFields}]`);
    console.log(`[product-actions] ─── createProductFromChat END (success) ───`);

    return {
      id: productId,
      name: payload.name,
      status: 'draft',
      requiresReview,
      missingFields,
    };
  } catch (dbErr) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(`[product-actions] ❌ DB error: ${(dbErr as Error)?.message}`);
    console.error(`[product-actions] Full error:`, dbErr);
    throw dbErr;
  } finally {
    client.release();
  }
}
