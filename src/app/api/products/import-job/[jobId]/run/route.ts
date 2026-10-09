import { NextRequest, NextResponse } from 'next/server';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { randomUUID } from 'crypto';
import pool, { queryWithRLS } from '@/lib/db';
import { resolveTenantBackend } from '@/lib/tenant-lookup';
import { SHARED_BUCKET } from '@/lib/gcs';
import {
  IMPORT_AGENT_SYSTEM_PROMPT,
  buildImportUserPrompt,
} from '@/lib/import-prompts';

// Force Node.js runtime (not Edge) — required for child_process
export const runtime = 'nodejs';

const execFileAsync = promisify(execFile);

const STORAGE_URL = process.env.STORAGE_URL || '';
const LIGHTPANDA_BIN = process.env.LIGHTPANDA_BIN || `${process.env.HOME || '/root'}/.local/bin/lightpanda`;
const STORAGE_API_SECRET = process.env.STORAGE_API_SECRET || '';
const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET || '';

// Valid pricing_model values in the DB
const VALID_PRICING_MODELS = new Set([
  'one_time', 'subscription', 'custom', 'free', 'contact',
]);

function mapPricingModel(raw: string | null | undefined): string {
  if (!raw) return 'one_time';
  const lower = raw.toLowerCase().trim();
  if (VALID_PRICING_MODELS.has(lower)) return lower;
  // Map aliases from the agent
  if (lower === 'license') return 'one_time';
  if (lower === 'custom_quote') return 'custom';
  if (lower === 'unknown') return 'one_time';
  return 'one_time';
}

async function bmHeaders(): Promise<Record<string, string>> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (STORAGE_API_SECRET) h['X-Storage-Secret'] = STORAGE_API_SECRET;
  // Attach OIDC identity token for Cloud Run IAM
  if (process.env.K_SERVICE) {
    try {
      const metaUrl =
        `http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity` +
        `?audience=${encodeURIComponent(STORAGE_URL)}`;
      const res = await fetch(metaUrl, {
        headers: { 'Metadata-Flavor': 'Google' },
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) {
        const token = (await res.text()).trim();
        h['Authorization'] = `Bearer ${token}`;
      }
    } catch { /* local dev */ }
  }
  return h;
}

// Anti-bot signals to detect challenge/captcha pages
const ANTI_BOT_SIGNALS = [
  'captcha', 'challenge', 'cf-browser-verification', 'cloudflare',
  'just a moment', 'verify you are human', 'enable javascript',
  'access denied', 'bot detection', 'please turn javascript on',
  'distil_r_blocked', 'px-captcha',
];

function detectAntiBot(html: string): string | null {
  const lower = html.toLowerCase();
  return ANTI_BOT_SIGNALS.find(sig => lower.includes(sig)) || null;
}

/**
 * Normalize marketplace URLs for better scraping:
 *  - Convert mobile URLs to desktop (m.bonanza.com → www.bonanza.com)
 *  - Strip tracking params
 */
function normalizeMarketplaceUrl(url: string): string {
  try {
    const u = new URL(url);
    // Bonanza: mobile site has stricter Cloudflare, use desktop
    if (u.hostname === 'm.bonanza.com') {
      u.hostname = 'www.bonanza.com';
    }
    // Etsy: mobile to desktop
    if (u.hostname === 'm.etsy.com') {
      u.hostname = 'www.etsy.com';
    }
    return u.toString();
  } catch {
    return url;
  }
}

/**
 * Pre-scrape a URL using three methods in order:
 *   1. Lightpanda headless browser (JS rendering)
 *   2. curl (different TLS fingerprint than Node.js)
 *   3. Node.js fetch (last resort)
 * Returns page content or null if all methods failed.
 */
async function preScrapeUrl(rawUrl: string): Promise<string | null> {
  const url = normalizeMarketplaceUrl(rawUrl);
  if (url !== rawUrl) console.error(`[pre-scrape] Normalized URL: ${rawUrl} → ${url}`);
  // ── Method 1: Lightpanda headless browser ──
  try {
    console.error(`[pre-scrape] Trying Lightpanda for ${url}`);
    const { stdout, stderr: lpStderr } = await execFileAsync(
      LIGHTPANDA_BIN,
      [
        'fetch',
        '--dump', 'markdown',
        '--wait-until', 'networkidle',
        '--wait-ms', '5000',
        '--log-level', 'info',
        url,
      ],
      { timeout: 45_000, maxBuffer: 5 * 1024 * 1024 },
    );
    if (lpStderr) console.error(`[pre-scrape] Lightpanda stderr: ${lpStderr.slice(0, 800)}`);

    // Check Lightpanda stderr for challenge/anti-bot indicators
    const stderrLower = (lpStderr || '').toLowerCase();
    const stderrChallenge = stderrLower.includes('challenge-platform') ||
      stderrLower.includes('challenge_page') || stderrLower.includes('captcha');

    if (stdout && stdout.length > 1000 && !stderrChallenge) {
      // Also check the markdown content itself for anti-bot signals
      const antiBot = detectAntiBot(stdout);
      if (antiBot) {
        console.error(`[pre-scrape] Lightpanda anti-bot detected for ${url} (matched: "${antiBot}")`);
      } else {
        console.error(`[pre-scrape] Lightpanda success for ${url} (${stdout.length} chars)`);
        return stdout;
      }
    } else if (stderrChallenge) {
      console.error(`[pre-scrape] Lightpanda hit Cloudflare challenge for ${url} (${stdout?.length ?? 0} chars, challenge in stderr)`);
    } else {
      console.error(`[pre-scrape] Lightpanda returned too little content (${stdout?.length ?? 0} chars)`);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[pre-scrape] Lightpanda failed for ${url}: ${msg.slice(0, 300)}`);
  }

  // ── Method 2: curl (OpenSSL TLS fingerprint, different from Node.js) ──
  try {
    console.error(`[pre-scrape] Trying curl for ${url}`);
    const { stdout: curlOut, stderr: curlErr } = await execFileAsync(
      'curl',
      [
        '-L', '-s', '-S',
        '--max-time', '15',
        '-H', 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        '-H', 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        '-H', 'Accept-Language: en-US,en;q=0.5',
        '-H', 'Sec-Fetch-Dest: document',
        '-H', 'Sec-Fetch-Mode: navigate',
        '-H', 'Sec-Fetch-Site: none',
        '-H', 'Sec-Fetch-User: ?1',
        '-H', 'Upgrade-Insecure-Requests: 1',
        url,
      ],
      { timeout: 20_000, maxBuffer: 5 * 1024 * 1024 },
    );
    if (curlErr) console.error(`[pre-scrape] curl stderr: ${curlErr.slice(0, 300)}`);
    if (curlOut && curlOut.length > 500) {
      const antiBot = detectAntiBot(curlOut);
      if (antiBot) {
        console.error(`[pre-scrape] curl anti-bot detected for ${url} (matched: "${antiBot}")`);
      } else {
        console.error(`[pre-scrape] curl success for ${url} (${curlOut.length} chars)`);
        return curlOut;
      }
    } else {
      console.error(`[pre-scrape] curl returned too little content (${curlOut?.length ?? 0} chars)`);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[pre-scrape] curl failed for ${url}: ${msg.slice(0, 300)}`);
  }

  // ── Method 3: Node.js fetch (last resort) ──
  try {
    console.error(`[pre-scrape] Trying HTTP fetch for ${url}`);
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
      signal: AbortSignal.timeout(15_000),
      redirect: 'follow',
    });
    if (res.ok) {
      const html = await res.text();
      console.error(`[pre-scrape] HTTP response for ${url}: ${html.length} chars, status ${res.status}`);
      const antiBot = detectAntiBot(html);
      if (antiBot) {
        console.error(`[pre-scrape] HTTP anti-bot detected for ${url} (matched: "${antiBot}")`);
        return null;
      }
      if (html.length > 500) {
        console.error(`[pre-scrape] HTTP fetch success for ${url} (${html.length} chars)`);
        return html;
      }
      console.error(`[pre-scrape] HTTP response too short for ${url} (${html.length} chars)`);
    } else {
      console.error(`[pre-scrape] HTTP fetch returned ${res.status} for ${url}`);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[pre-scrape] HTTP fetch failed for ${url}: ${msg.slice(0, 300)}`);
  }

  // ── Method 4: Wayback Machine (archive.org cached snapshot) ──
  try {
    console.error(`[pre-scrape] Trying Wayback Machine for ${url}`);
    // Use CDX API to find the most recent successful snapshot
    const cdxUrl =
      `https://web.archive.org/cdx/search/cdx` +
      `?url=${encodeURIComponent(url)}&output=json&limit=1` +
      `&fl=timestamp,statuscode&filter=statuscode:200&sort=reverse`;
    const cdxRes = await fetch(cdxUrl, {
      signal: AbortSignal.timeout(60_000),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MaavadaoBot/1.0)' },
    });
    if (cdxRes.ok) {
      const cdxData = await cdxRes.json() as string[][];
      // CDX returns [[header_row], [timestamp, statuscode], ...]
      if (Array.isArray(cdxData) && cdxData.length > 1) {
        const timestamp = cdxData[1][0];
        console.error(`[pre-scrape] Wayback Machine snapshot found: ${timestamp} for ${url}`);
        // id_ suffix = raw original content (no Wayback toolbar injected)
        const archiveUrl = `https://web.archive.org/web/${timestamp}id_/${url}`;
        const archiveRes = await fetch(archiveUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          },
          signal: AbortSignal.timeout(120_000),
          redirect: 'follow',
        });
        if (archiveRes.ok) {
          const html = await archiveRes.text();
          // Skip anti-bot check: CDX statuscode:200 filter already excludes
          // challenge pages, and real pages may reference cloudflare CDN URLs
          // which would false-positive the generic anti-bot detector.
          if (html.length > 2000) {
            console.error(`[pre-scrape] Wayback Machine success for ${url} (${html.length} chars, snapshot: ${timestamp})`);
            return html;
          } else {
            console.error(`[pre-scrape] Wayback Machine response too short for ${url} (${html.length} chars)`);
          }
        } else {
          console.error(`[pre-scrape] Wayback Machine fetch returned ${archiveRes.status} for ${url}`);
        }
      } else {
        console.error(`[pre-scrape] Wayback Machine has no snapshots for ${url}`);
      }
    } else {
      console.error(`[pre-scrape] Wayback Machine CDX API returned ${cdxRes.status}`);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[pre-scrape] Wayback Machine failed for ${url}: ${msg.slice(0, 300)}`);
  }

  return null;
}

async function updateJobStatus(
  jobId: string,
  status: string,
  extra?: Record<string, unknown>,
) {
  const sets = ['status = $2', 'updated_at = NOW()'];
  const vals: unknown[] = [jobId, status];
  let idx = 3;
  if (extra) {
    for (const [col, val] of Object.entries(extra)) {
      sets.push(`${col} = $${idx}`);
      vals.push(val);
      idx++;
    }
  }
  await pool.query(`UPDATE import_jobs SET ${sets.join(', ')} WHERE id = $1`, vals);
}

/**
 * POST /api/products/import-job/[jobId]/run
 *
 * Internal-only endpoint that executes the import pipeline:
 * 1. Resolve tenant backend for maava gateway
 * 1.5. Pre-scrape submitted links (Lightpanda → HTTP fallback)
 * 2. Call maava gateway (non-streaming) with scraped content + prompt
 * 3. Parse structured JSON response
 * 4. Save raw JSON to bucket
 * 5. Ingest products into the products table
 * 6. Update job status throughout
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
) {
  // Verify internal secret
  const secret = request.headers.get('X-Internal-Secret');
  if (!INTERNAL_API_SECRET || secret !== INTERNAL_API_SECRET) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const { jobId } = await params;

  // Load the job
  const jobResult = await pool.query(
    `SELECT j.id, j.user_id, j.seller_profile_id, j.submitted_links, j.status
     FROM import_jobs j
     WHERE j.id = $1`,
    [jobId],
  );

  if (jobResult.rows.length === 0) {
    return NextResponse.json({ error: 'Job not found' }, { status: 404 });
  }

  const job = jobResult.rows[0];

  // Don't re-run completed/running jobs
  if (job.status !== 'queued') {
    return NextResponse.json({ error: `Job is already ${job.status}` }, { status: 409 });
  }

  // Mark as running
  await updateJobStatus(jobId, 'running', { started_at: new Date().toISOString() });

  try {
    // ── Step 1: Resolve tenant backend for maava gateway ──
    const userRow = await pool.query(
      `SELECT t.subdomain FROM tenants t WHERE t.user_id = $1 AND t.status = 'active' LIMIT 1`,
      [job.user_id],
    );
    const subdomain = userRow.rows[0]?.subdomain;
    if (!subdomain) {
      throw new Error('User has no subdomain / tenant');
    }

    const tenant = await resolveTenantBackend(subdomain);
    if (!tenant?.backendUrl) {
      throw new Error('Could not resolve tenant backend');
    }

    // ── Step 1.5: Pre-scrape submitted links ──
    // Try to fetch page content before sending to AI, so the AI can
    // structure data even if it can't access anti-bot-protected pages.
    const links = job.submitted_links as string[];
    console.error(`[import-worker] Starting pre-scrape for ${links.length} link(s)`);
    const preScrapedContent: Array<{ url: string; markdown: string }> = [];
    for (const link of links) {
      try {
        const content = await preScrapeUrl(link);
        if (content) {
          preScrapedContent.push({ url: link, markdown: content });
        } else {
          console.error(`[import-worker] Pre-scrape returned null for ${link}`);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[import-worker] Pre-scrape exception for ${link}: ${msg}`);
      }
    }
    console.error(`[import-worker] Pre-scraped ${preScrapedContent.length}/${links.length} links successfully`);

    // If we couldn't scrape ANY of the submitted links, fail fast.
    // The AI can't browse the web, so sending bare URLs is pointless.
    if (preScrapedContent.length === 0) {
      throw new Error(
        `Could not access the marketplace page(s). The site may be blocking automated access. ` +
        `Try pasting individual product URLs instead of shop pages, or use a different marketplace. ` +
        `URLs attempted: ${links.join(', ')}`,
      );
    }

    // ── Step 2: Call maava gateway (non-streaming) ──
    const gatewayUrl = `${tenant.backendUrl.replace(/\/+$/, '')}/v1/chat/completions`;
    const messages = [
      { role: 'system', content: IMPORT_AGENT_SYSTEM_PROMPT },
      {
        role: 'user',
        content: buildImportUserPrompt({
          userId: job.user_id,
          sellerProfileId: job.seller_profile_id,
          links: job.submitted_links,
          preScrapedContent: preScrapedContent.length > 0 ? preScrapedContent : undefined,
        }),
      },
    ];

    const authHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (tenant.gatewayToken) {
      authHeaders['Authorization'] = `Bearer ${tenant.gatewayToken}`;
    }

    console.error(`[import-worker] Calling AI gateway at ${gatewayUrl} (prompt ~${JSON.stringify(messages).length} chars)`);
    const aiStart = Date.now();
    const gatewayRes = await fetch(gatewayUrl, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        model: 'openclaw',
        messages,
        stream: false,
      }),
      signal: AbortSignal.timeout(300_000), // 5 min for large pages
    });

    if (!gatewayRes.ok) {
      const errText = await gatewayRes.text().catch(() => '');
      throw new Error(`Gateway returned HTTP ${gatewayRes.status}: ${errText.slice(0, 500)}`);
    }

    const gatewayData = await gatewayRes.json();
    const rawContent = gatewayData?.choices?.[0]?.message?.content?.trim();
    console.error(`[import-worker] AI response received in ${((Date.now() - aiStart) / 1000).toFixed(1)}s (${rawContent?.length ?? 0} chars)`);

    if (!rawContent) {
      throw new Error('Gateway returned empty content');
    }

    // ── Step 3: Parse JSON response ──
    let parsed: {
      success: boolean;
      products?: Array<Record<string, unknown>>;
      errors?: Array<{ input_url: string; reason: string }>;
    };

    try {
      // Try direct parse first
      parsed = JSON.parse(rawContent);
    } catch {
      // Try extracting from code fences
      const match = rawContent.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
      if (match) {
        parsed = JSON.parse(match[1].trim());
      } else {
        throw new Error('Failed to parse agent response as JSON');
      }
    }

    if (!parsed.products || !Array.isArray(parsed.products)) {
      throw new Error('Agent response missing products array');
    }

    // ── Step 4: Save raw JSON to bucket ──
    await updateJobStatus(jobId, 'saving_raw_file');

    const rawFileName = `market-imports/${jobId}.json`;
    const bucketPath = `${job.user_id}/mountfolder/${rawFileName}`;

    if (STORAGE_URL) {
      await updateJobStatus(jobId, 'uploading_to_bucket', {
        raw_workspace_path: rawFileName,
      });

      const putRes = await fetch(
        `${STORAGE_URL}/api/v1/buckets/${encodeURIComponent(SHARED_BUCKET)}/files/${bucketPath}`,
        {
          method: 'PUT',
          headers: await bmHeaders(),
          body: JSON.stringify(parsed, null, 2),
          signal: AbortSignal.timeout(15_000),
        },
      );

      if (putRes.ok) {
        await updateJobStatus(jobId, 'uploading_to_bucket', {
          raw_bucket_path: `gs://${SHARED_BUCKET}/${bucketPath}`,
        });
      } else {
        console.error(`[import-worker] Bucket upload failed: HTTP ${putRes.status}`);
        // Non-fatal — continue with DB ingestion
      }
    }

    // ── Step 5: Ingest products into DB ──
    await updateJobStatus(jobId, 'ingesting_to_db');

    // Ensure seller_profile_id exists (auto-create if null)
    let sellerProfileId = job.seller_profile_id;
    if (!sellerProfileId) {
      console.error('[import-worker] seller_profile_id is null, auto-creating...');
      const spResult = await queryWithRLS(
        job.user_id,
        `SELECT id FROM seller_profiles WHERE user_id = $1 LIMIT 1`,
        [job.user_id],
      );
      if (spResult.rows.length > 0) {
        sellerProfileId = spResult.rows[0].id;
      } else {
        sellerProfileId = randomUUID();
        await queryWithRLS(
          job.user_id,
          `INSERT INTO seller_profiles (id, user_id, business_name, approval_required)
           VALUES ($1, $2, 'My Store', false)
           ON CONFLICT (user_id) DO UPDATE SET id = seller_profiles.id
           RETURNING id`,
          [sellerProfileId, job.user_id],
        );
        // Re-fetch in case ON CONFLICT returned the existing one
        const refetch = await queryWithRLS(
          job.user_id,
          `SELECT id FROM seller_profiles WHERE user_id = $1 LIMIT 1`,
          [job.user_id],
        );
        sellerProfileId = refetch.rows[0]?.id ?? sellerProfileId;
      }
      console.error(`[import-worker] Using seller_profile_id: ${sellerProfileId}`);
    }

    let productCount = 0;
    let errorCount = 0;
    const errorMessages: string[] = [];

    for (const product of parsed.products) {
      try {
        const name = String(product.name || '').trim();
        if (!name) {
          errorCount++;
          errorMessages.push('Skipped product with empty name');
          continue;
        }

        const metadata = (product.metadata as Record<string, unknown>) || {};
        const sourceUrl = String(metadata.source_product_url || '');

        // target_audience: agent returns array, DB expects TEXT
        let targetAudience: string | null = null;
        if (Array.isArray(product.target_audience)) {
          targetAudience = product.target_audience.join(', ');
        } else if (typeof product.target_audience === 'string') {
          targetAudience = product.target_audience;
        }

        // Upsert: dedup by user_id + metadata->>'source_product_url'
        const validProductTypes = new Set(['digital', 'physical', 'service', 'hybrid']);
        const productType = validProductTypes.has(String(product.product_type || ''))
          ? String(product.product_type)
          : 'digital';

        const upsertResult = await queryWithRLS(
          job.user_id,
          `INSERT INTO products (
             user_id, seller_profile_id, name, summary, description,
             price, pricing_model, currency, deliverables,
             target_audience, tags, status, metadata, product_type
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'draft', $12, $13)
           ON CONFLICT (user_id, (metadata->>'source_product_url'))
             WHERE metadata->>'source_product_url' IS NOT NULL AND metadata->>'source_product_url' != ''
           DO UPDATE SET
             name = EXCLUDED.name,
             summary = EXCLUDED.summary,
             description = EXCLUDED.description,
             price = EXCLUDED.price,
             pricing_model = EXCLUDED.pricing_model,
             currency = EXCLUDED.currency,
             deliverables = EXCLUDED.deliverables,
             target_audience = EXCLUDED.target_audience,
             tags = EXCLUDED.tags,
             metadata = EXCLUDED.metadata,
             product_type = EXCLUDED.product_type,
             updated_at = NOW()
           RETURNING id`,
          [
            job.user_id,
            sellerProfileId,
            name,
            product.summary || null,
            product.description || null,
            product.price != null ? Number(product.price) : null,
            mapPricingModel(product.pricing_model as string),
            product.currency || 'USD',
            Array.isArray(product.deliverables) ? product.deliverables : [],
            targetAudience,
            Array.isArray(product.tags) ? product.tags : [],
            { ...metadata, import_job_id: jobId },
            productType,
          ],
        );

        if (upsertResult.rows.length > 0) {
          productCount++;
        }
      } catch (err) {
        errorCount++;
        const msg = err instanceof Error ? err.message : String(err);
        errorMessages.push(`Product "${product.name}": ${msg.slice(0, 200)}`);
        console.error('[import-worker] product insert error:', msg);
      }
    }

    // Count agent-side errors too
    if (parsed.errors && Array.isArray(parsed.errors)) {
      for (const e of parsed.errors) {
        errorCount++;
        errorMessages.push(`Agent error for ${e.input_url}: ${e.reason}`);
      }
    }

    // ── Step 6: Mark complete ──
    await updateJobStatus(jobId, 'completed', {
      product_count: productCount,
      error_count: errorCount,
      error_message: errorMessages.length > 0 ? errorMessages.join('\n') : null,
      completed_at: new Date().toISOString(),
    });

    return NextResponse.json({
      success: true,
      productCount,
      errorCount,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[import-worker] Job ${jobId} failed:`, message);

    await updateJobStatus(jobId, 'failed', {
      error_message: message.slice(0, 2000),
      completed_at: new Date().toISOString(),
    }).catch(() => {});

    return NextResponse.json({ error: message }, { status: 500 });
  }
}
