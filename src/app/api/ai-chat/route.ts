import { NextRequest, NextResponse } from "next/server";
import pool, { queryWithRLS } from "@/lib/db";
import { authenticateRequest } from "@/lib/auth";
import { resolveTenantBackend } from "@/lib/tenant-lookup";
import { getProviderKeysForUser } from "@/app/api/provider-keys/connected/route";
import { getSkillApiKeysForUser } from "@/app/api/skills/connections/route";
import { getLinkedChannels, deliverMessage, type DeliveryTarget, type ChannelPlatform } from "@/lib/channel-delivery";
import { createMCTaskFromAgentTask, syncAgentStatusToMC, startMCTaskForConversation, finishMCTaskForConversation } from "@/lib/task-sync";
import { createActionBlockFilter, stripActionBlocks } from "@/lib/action-block-filter";
import { createProductFromChat, type ChatProductPayload } from "@/lib/product-actions";
import { createDraft, getDraft, markDraftSent, getInboxAccount } from "@/lib/inbox/db";
import { sendGmailReply } from "@/lib/inbox/gmail-api";

// Force dynamic rendering — never cache this route handler.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 600; // 10 min — agent tool-use conversations can run long

const GATEWAY_URL =
  process.env.GATEWAY_URL ||
  process.env.NEXT_PUBLIC_GATEWAY_URL ||
  "";

const OPENCLAW_GATEWAY_TOKEN =
  process.env.OPENCLAW_GATEWAY_TOKEN ||
  process.env.NEXT_PUBLIC_GATEWAY_TOKEN ||
  "";

const CLOUD_MODE = process.env.NEXT_PUBLIC_CLOUD_MODE === "true";

// Direct provider fallback — used when no local gateway is running.
// Set OPENAI_API_KEY, ANTHROPIC_API_KEY, or MOONSHOT_API_KEY in .env.local to use direct mode.
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MOONSHOT_API_KEY = process.env.MOONSHOT_API_KEY;
const BRAVE_API_KEY = process.env.BRAVE_API_KEY;

// Seller / Configuration API base URL (used by action block processors)
const SELLER_API_BASE = (process.env.MAWADAO_API_URL || 'https://mawadao.com/api/v1').replace(/\/+$/, '');

// ── Bucket-manager helpers (for workspace image discovery) ────────────────
const STORAGE_URL = process.env.STORAGE_URL || '';
const STORAGE_API_SECRET = process.env.STORAGE_API_SECRET || '';
const SHARED_BUCKET = process.env.GCS_SHARED_BUCKET || 'mawa-data';
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);

async function bmHeaders(): Promise<Record<string, string>> {
  const h: Record<string, string> = {};
  if (STORAGE_API_SECRET) h['X-Storage-Secret'] = STORAGE_API_SECRET;
  if (process.env.K_SERVICE) {
    try {
      const metaUrl =
        `http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity` +
        `?audience=${encodeURIComponent(STORAGE_URL)}`;
      const res = await fetch(metaUrl, {
        headers: { 'Metadata-Flavor': 'Google' },
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) h['Authorization'] = `Bearer ${(await res.text()).trim()}`;
    } catch { /* local dev fallback */ }
  }
  return h;
}

/**
 * List all image files in a user's GCS workspace via mawa-storage.
 * Returns file names (e.g. ["deer.png", "giraffe.png"]).
 */
async function listWorkspaceImages(userId: string): Promise<string[]> {
  if (!STORAGE_URL) return [];
  try {
    const folderPath = `${userId}/mountfolder/workspace`;
    const url = `${STORAGE_URL}/api/v1/buckets/${encodeURIComponent(SHARED_BUCKET)}/folders?path=${encodeURIComponent(folderPath)}`;
    const headers = await bmHeaders();
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
    if (!res.ok) {
      console.warn(`[user-media] mawa-storage list failed: ${res.status}`);
      return [];
    }
    const data = await res.json() as { files?: { name: string; size: number }[] };
    return (data.files || [])
      .map(f => f.name)
      .filter(name => {
        const ext = name.split('.').pop()?.toLowerCase() || '';
        return IMAGE_EXTENSIONS.has(ext);
      });
  } catch (err) {
    console.warn('[user-media] Failed to list workspace images:', (err as Error)?.message);
    return [];
  }
}

// ── AI SDK v6 UIMessage types ─────────────────────────────────────────────
type UIMessagePart =
  | { type: "text"; text: string }
  | { type: "file"; url: string; mediaType: string; filename?: string }
  | { type: "step-start" }
  | { type: "reasoning"; reasoning: string }
  | { type: string; [key: string]: unknown };

interface UIMessage {
  id?: string;
  role: string;
  parts?: UIMessagePart[];
  content?: string; // legacy support
  [key: string]: unknown;
}

type OpenAIContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

type OpenAIMessage =
  | { role: string; content: string }
  | { role: string; content: OpenAIContentPart[] };

/**
 * Transform MEDIA:/home/node/.openclaw/workspace/... lines into markdown image syntax.
 * Used for non-streaming responses where the line-by-line stream processor isn't used.
 */
function transformMediaLines(text: string): string {
  return text.replace(
    /MEDIA:\s*\/home\/node\/\.openclaw\/workspace\/(.+)/g,
    (_match, filePath: string) => {
      const fn = filePath.trim().replace(/[`"']+$/g, '');
      return `![${fn}](/api/media/workspace/${encodeURIComponent(fn)})`;
    },
  );
}

function extractLastUserText(messages: UIMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg.role === 'user') {
      return extractText(msg).trim();
    }
  }
  return '';
}

/**
 * Normalize a skill ID for matching: lowercase, replace dashes with underscores.
 */
function normalizeSkillId(id: string): string {
  return String(id).toLowerCase().replace(/[-\s]/g, '_');
}

/**
 * Check if any of the target skill IDs are present in the active skills list.
 * Uses normalized matching so 'browser-use', 'browser_use', 'browseruse' all match.
 */
function hasSkill(skills: string[], ...targets: string[]): boolean {
  if (!Array.isArray(skills) || skills.length === 0) return false;
  const normalizedSkills = skills.map(normalizeSkillId);
  return targets.some(t => {
    const nt = normalizeSkillId(t);
    return normalizedSkills.some(s => s === nt || s.includes(nt) || nt.includes(s));
  });
}

function extractWeatherLocation(query: string): string | null {
  const q = query.trim();
  if (!q) return null;

  // Common patterns: "weather in baku", "what is the weather in london now"
  const inMatch = q.match(/\bweather\s+(?:in|at|for)\s+([^?.!,\n]+)/i);
  if (inMatch?.[1]) return inMatch[1].trim();

  // Pattern: "baku weather"
  const suffixMatch = q.match(/^([^?.!,\n]+)\s+weather\b/i);
  if (suffixMatch?.[1]) return suffixMatch[1].trim();

  // Pattern: temperature/forecast/climate in <location>
  const tempMatch = q.match(/\b(?:temperature|forecast|climate|rain|snow|wind)\s+(?:in|at|for)\s+([^?.!,\n]+)/i);
  if (tempMatch?.[1]) return tempMatch[1].trim();

  // If user asks generic weather, default to null and let model ask follow-up.
  return null;
}

async function buildWeatherSkillSystemContext(userText: string): Promise<string | null> {
  const location = extractWeatherLocation(userText);
  if (!location) {
    return null;
  }

  const encoded = encodeURIComponent(location.replace(/\s+/g, '+'));

  // Try JSON format first for rich data, fall back to text format
  try {
    const jsonUrl = `https://wttr.in/${encoded}?format=j1`;
    const res = await fetch(jsonUrl, {
      method: 'GET',
      headers: { 'User-Agent': 'curl/7.68.0' },
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const data = await res.json() as {
        current_condition?: Array<{
          temp_C?: string; temp_F?: string;
          FeelsLikeC?: string; FeelsLikeF?: string;
          humidity?: string; windspeedKmph?: string; winddir16Point?: string;
          weatherDesc?: Array<{ value?: string }>;
          uvIndex?: string; visibility?: string; pressure?: string;
          cloudcover?: string; precipMM?: string;
        }>;
        nearest_area?: Array<{ areaName?: Array<{ value?: string }>; country?: Array<{ value?: string }> }>;
      };
      const cc = data?.current_condition?.[0];
      const area = data?.nearest_area?.[0];
      if (cc) {
        const areaName = area?.areaName?.[0]?.value || location;
        const country = area?.country?.[0]?.value || '';
        const desc = cc.weatherDesc?.[0]?.value || 'Unknown';
        const lines = [
          `Weather skill is enabled. Live weather data fetched successfully for ${areaName}${country ? ', ' + country : ''}.`,
          '',
          `Current conditions:`,
          `- Weather: ${desc}`,
          `- Temperature: ${cc.temp_C}°C (${cc.temp_F}°F)`,
          `- Feels like: ${cc.FeelsLikeC}°C (${cc.FeelsLikeF}°F)`,
          `- Humidity: ${cc.humidity}%`,
          `- Wind: ${cc.windspeedKmph} km/h ${cc.winddir16Point}`,
          cc.uvIndex ? `- UV Index: ${cc.uvIndex}` : '',
          cc.visibility ? `- Visibility: ${cc.visibility} km` : '',
          cc.pressure ? `- Pressure: ${cc.pressure} mb` : '',
          cc.cloudcover ? `- Cloud cover: ${cc.cloudcover}%` : '',
          cc.precipMM && cc.precipMM !== '0.0' ? `- Precipitation: ${cc.precipMM} mm` : '',
          '',
          'IMPORTANT: Use this real-time weather data directly in your answer. Do NOT say you cannot access weather or offer to look it up — the data is already here.',
        ].filter(Boolean);
        return lines.join('\n');
      }
    }
  } catch {
    // JSON fetch failed, try simple text format
  }

  // Fallback to simple text format
  try {
    const textUrl = `https://wttr.in/${encoded}?format=%l:+%c+%t+feels+like+%f+humidity+%h+wind+%w`;
    const res = await fetch(textUrl, {
      method: 'GET',
      headers: { 'User-Agent': 'curl/7.68.0' },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const weatherLine = (await res.text()).trim();
    if (!weatherLine) return null;

    return [
      'Weather skill is enabled. Live weather fetched via wttr.in.',
      `Live weather now: ${weatherLine}`,
      'IMPORTANT: Use this real-time weather data directly in your answer. Do NOT say you cannot access weather.',
    ].join('\n');
  } catch {
    return null;
  }
}

function stripHtmlTags(input: string): string {
  return input
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeSearchResultUrl(rawUrl: string): string {
  const url = rawUrl.trim();
  if (!url) return url;

  // DuckDuckGo result redirects carry the real URL in `uddg`.
  if (url.startsWith('//duckduckgo.com/l/?') || url.startsWith('https://duckduckgo.com/l/?')) {
    try {
      const absolute = url.startsWith('//') ? `https:${url}` : url;
      const parsed = new URL(absolute);
      const uddg = parsed.searchParams.get('uddg');
      if (uddg) {
        return decodeURIComponent(uddg);
      }
    } catch {
      // keep original
    }
  }

  if (url.startsWith('//')) {
    return `https:${url}`;
  }
  return url;
}

type SearchResult = {
  title: string;
  url: string;
  snippet?: string;
};

type BrowserUseLookup = {
  results: SearchResult[];
  error?: string;
};

type BraveSearchResponse = {
  web?: {
    results?: Array<{
      title?: string;
      url?: string;
      description?: string;
    }>;
  };
};

function parseDuckDuckGoResults(html: string, limit = 5): SearchResult[] {
  const results: SearchResult[] = [];
  const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>|<div[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/div>)?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null && results.length < limit) {
    const url = stripHtmlTags(m[1] ?? '');
    const title = stripHtmlTags(m[2] ?? '');
    const snippet = stripHtmlTags(m[3] ?? m[4] ?? '');
    if (!url || !title) continue;
    results.push({ title, url: normalizeSearchResultUrl(url), snippet: snippet || undefined });
  }
  return results;
}

async function fetchBraveSearchResults(query: string, limit: number, apiKey: string): Promise<SearchResult[]> {
  const url = new URL('https://api.search.brave.com/res/v1/web/search');
  url.searchParams.set('q', query);
  url.searchParams.set('count', String(Math.max(1, Math.min(limit, 10))));

  const res = await fetch(url, {
    headers: {
      'Accept': 'application/json',
      'X-Subscription-Token': apiKey,
    },
    signal: AbortSignal.timeout(8000),
  });

  if (!res.ok) {
    throw new Error(`brave search failed (${res.status})`);
  }

  const data = await res.json() as BraveSearchResponse;
  return (data.web?.results ?? [])
    .map((result) => ({
      title: (result.title ?? '').trim(),
      url: (result.url ?? '').trim(),
      snippet: (result.description ?? '').trim() || undefined,
    }))
    .filter((result) => result.title && result.url)
    .slice(0, limit);
}

async function fetchBrowserUseFindings(query: string, limit = 5, braveApiKey?: string): Promise<BrowserUseLookup> {
  const q = query.trim();
  if (!q) return { results: [], error: 'empty query' };

  if (braveApiKey) {
    try {
      const results = await fetchBraveSearchResults(q, limit, braveApiKey);
      if (results.length > 0) {
        return { results };
      }
    } catch {
      // Fall through to DuckDuckGo fallback.
    }
  }

  const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(q)}`;
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
      },
    });
    if (!res.ok) return { results: [], error: `search failed (${res.status})` };

    const html = await res.text();
    return { results: parseDuckDuckGoResults(html, limit) };
  } catch {
    return { results: [], error: 'search unavailable' };
  }
}

function isLikelyBrowserTaskQuery(query: string): boolean {
  const q = query.toLowerCase();
  if (!q.trim()) return false;
  return (
    q.includes('go to ') ||
    q.includes('search ') ||
    q.includes('find ') ||
    q.includes('most viewed') ||
    q.includes('top ') ||
    q.includes('.com') ||
    q.includes('youtube') ||
    q.includes('booking')
  );
}

function formatBrowserUseDirectAnswer(query: string, findings: BrowserUseLookup): string {
  if (findings.results.length === 0) {
    return [
      `## Browser-Use Results`,
      `I could not retrieve live browser-search results for: "${query}".`,
      '',
      'Browser-use is enabled, but live browsing is unavailable right now.',
      'Please try again in a moment or provide a direct URL to inspect.',
    ].join('\n\n');
  }

  const lines = findings.results
    .slice(0, 5)
    .map(
      (r, i) => {
        const title = r.title.replace(/\|/g, '\\|');
        const snippet = (r.snippet ?? '').replace(/\|/g, '\\|');
        return `| ${i + 1} | [${title}](${r.url}) | ${snippet} |`;
      },
    );

  return [
    `## Browser-Use Results`,
    `Query: **${query}**`,
    '',
    '| # | Result | Snippet |',
    '|---|---|---|',
    ...lines,
    '',
    'Note: Only fetched live results are listed (no fabricated prices/ratings/views).',
  ].join('\n\n');
}

async function buildBrowserUseSkillSystemContext(userText: string, braveApiKey?: string): Promise<string | null> {
  const query = userText.trim();
  if (!query) return null;

  try {
    const findings = await fetchBrowserUseFindings(query, 5, braveApiKey);
    if (findings.results.length === 0) {
      return [
        'Browser-use skill is enabled, but no live web results were fetched for this query.',
        'Do NOT fabricate specific listings or prices. Ask the user to refine the query or provide direct target site details.',
      ].join('\n');
    }

    const lines = findings.results.map((r, i) => `${i + 1}. ${r.title}\n   URL: ${r.url}${r.snippet ? `\n   Snippet: ${r.snippet}` : ''}`);
    return [
      'Browser-use skill is enabled. Use the following LIVE web findings as evidence:',
      ...lines,
      'Rules: (1) Do not invent prices/ratings/listings not present in findings. (2) If exact data requested is missing, say so explicitly and propose next browsing step.',
    ].join('\n');
  } catch {
    return [
      'Browser-use skill is enabled, but live browsing is currently unavailable.',
      'Do NOT fabricate specific factual results. Clearly state the limitation and ask for retry/permission.',
    ].join('\n');
  }
}

/**
 * Extract plain text from a UIMessage (for DB storage / preview).
 * Includes file content for text-based files so conversation history is useful.
 */
function extractText(msg: UIMessage): string {
  if (msg.parts) {
    const chunks: string[] = [];
    for (const p of msg.parts) {
      if (p.type === "text") {
        chunks.push((p as { type: "text"; text: string }).text);
      } else if (p.type === "file") {
        const fp = p as { type: "file"; url: string; mediaType: string; filename?: string };
        if (fp.mediaType?.startsWith("image/")) {
          chunks.push(`[Image: ${fp.filename || "image"}]`);
        } else if (isTextBasedMedia(fp.mediaType, fp.filename)) {
          const decoded = decodeDataUrlToText(fp.url, 50_000); // smaller cap for DB
          if (decoded.trim()) {
            chunks.push(`--- File: ${fp.filename || "file"} ---\n${decoded}\n--- End of file ---`);
          } else {
            chunks.push(`[Attached: ${fp.filename || "file"} (${fp.mediaType})]`);
          }
        } else {
          chunks.push(`[Attached: ${fp.filename || "file"} (${fp.mediaType})]`);
        }
      }
    }
    return chunks.join("\n");
  }
  return typeof msg.content === "string" ? msg.content : "";
}

/**
 * Fire-and-forget: ask the gateway to generate a short title for a conversation.
 */
async function generateTitle(conversationId: string, authHeader: string): Promise<void> {
  const { rows: messages } = await pool.query(
    `SELECT role, content FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC LIMIT 4`,
    [conversationId]
  );
  if (messages.length === 0) return;

  const context = messages
    .map((m: { role: string; content: string }) => `${m.role}: ${m.content.slice(0, 200)}`)
    .join("\n");

  const base = GATEWAY_URL.replace(/\/+$/, "");
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: authHeader },
    body: JSON.stringify({
      model: "openclaw",
      messages: [
        {
          role: "system",
          content:
            "Generate a very short title (3-6 words, no quotes, no punctuation at the end) that summarizes this conversation. Respond with ONLY the title, nothing else.",
        },
        { role: "user", content: context },
      ],
      stream: false,
    }),
  });

  if (!res.ok) return;

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  let title = data?.choices?.[0]?.message?.content?.trim() || "";
  title = title.replace(/^["']|["']$/g, "").trim();
  if (title.length > 60) title = title.slice(0, 60);
  if (!title) return;

  await pool.query(
    `UPDATE conversations SET title = $1, updated_at = NOW() WHERE id = $2`,
    [title, conversationId]
  );
}

// ── Streaming-state helpers (stream-recovery on page refresh) ──────────────

/** Ensure the streaming columns exist (safe idempotent migration). */
let _streamColsMigrated = false;
async function ensureStreamingColumns(): Promise<void> {
  if (_streamColsMigrated) return;
  try {
    await pool.query(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS is_streaming BOOLEAN DEFAULT FALSE`);
    await pool.query(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS streaming_started_at TIMESTAMPTZ DEFAULT NULL`);
    _streamColsMigrated = true;
  } catch { /* column already exists or table doesn't exist yet */ }
}

/** Insert a placeholder assistant message and mark conversation as streaming. Returns the new message id. */
async function startStreamingMessage(conversationId: string): Promise<string | null> {
  try {
    await ensureStreamingColumns();
    const { rows } = await pool.query(
      `INSERT INTO messages (conversation_id, role, content) VALUES ($1, 'assistant', '') RETURNING id`,
      [conversationId]
    );
    const msgId = rows[0]?.id as string;
    await pool.query(
      `UPDATE conversations SET is_streaming = TRUE, streaming_started_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [conversationId]
    );
    return msgId;
  } catch (e) {
    console.error('[streaming] Failed to start streaming message:', e);
    return null;
  }
}

/** Update the streaming message content in DB (periodic save). */
async function updateStreamingContent(messageId: string, content: string): Promise<void> {
  try {
    // Strip action-block tags before persisting — the user UI renders DB content
    // verbatim, so storing raw tags would leak [CREATE_PRODUCT] / [PUBLISH_PRODUCT]
    // / [CAMPAIGN_PLAN] / [ZERNIO_API] blocks into the chat history.
    const safeContent = stripActionBlocks(content);
    await pool.query(`UPDATE messages SET content = $1 WHERE id = $2`, [safeContent, messageId]);
  } catch { /* best-effort */ }
}

/** Finalize the streaming message and clear the streaming flag. */
async function finishStreamingMessage(conversationId: string, messageId: string | null, finalContent: string): Promise<void> {
  try {
    if (messageId && finalContent) {
      // Persist a SANITIZED copy so reloads don't reveal action-block plumbing.
      const safeContent = stripActionBlocks(finalContent);
      const result = await pool.query(`UPDATE messages SET content = $1 WHERE id = $2`, [safeContent, messageId]);
      console.log('[streaming] finishStreamingMessage: updated msgId:', messageId, 'rawLen:', finalContent.length, 'savedLen:', safeContent.length, 'rowCount:', result.rowCount);
    } else if (messageId && !finalContent) {
      // Empty response — remove the placeholder
      await pool.query(`DELETE FROM messages WHERE id = $1`, [messageId]);
      console.log('[streaming] finishStreamingMessage: deleted empty placeholder msgId:', messageId);
    } else {
      console.warn('[streaming] finishStreamingMessage: no-op. msgId:', messageId, 'contentLen:', finalContent?.length ?? 0);
    }
    await pool.query(
      `UPDATE conversations SET is_streaming = FALSE, streaming_started_at = NULL, updated_at = NOW() WHERE id = $1`,
      [conversationId]
    );
  } catch (e) {
    console.error('[streaming] Failed to finish streaming message. convId:', conversationId, 'msgId:', messageId, 'contentLen:', finalContent?.length ?? 0, 'error:', e);
  }
}

// ── Post-processing: detect [DELIVER] / [SCHEDULE_DELIVERY] blocks ─────

interface ParsedDeliverBlock { platform: string; text: string }
interface ParsedScheduleBlock { schedule: string; platform: string; name: string; text: string }

function parseDeliverBlocks(fullText: string): ParsedDeliverBlock[] {
  const blocks: ParsedDeliverBlock[] = [];
  const re = /\[DELIVER\]([\s\S]*?)\[\/DELIVER\]/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(fullText)) !== null) {
    const body = m[1].trim();
    let platform = '';
    let text = '';

    // Try multi-line format first: "platform: X\ntext: Y"
    const platformMatch = body.match(/^\s*platform:\s*(.+)$/m);
    const textMatch = body.match(/^\s*text:\s*([\s\S]*)$/m);
    if (platformMatch && textMatch) {
      // Platform might be "telegram text: ..." if both are on the same line
      const rawPlatform = platformMatch[1].trim();
      if (/\btext:/i.test(rawPlatform)) {
        // Same-line format: "platform: telegram text: message here"
        const parts = rawPlatform.match(/^(\S+)\s+text:\s*(.*)$/i);
        if (parts) {
          platform = parts[1].toLowerCase();
          // text is the remainder after "text:" on that line + any subsequent lines
          const afterFirstLine = body.substring(body.indexOf(rawPlatform) + rawPlatform.length).trim();
          text = ((parts[2] || '') + '\n' + afterFirstLine).trim();
        }
      } else {
        platform = rawPlatform.toLowerCase();
        text = textMatch[1].trim();
      }
    } else {
      // Fallback: try "platform: X text: Y" all on one blob
      const inlineMatch = body.match(/platform:\s*(\S+)\s+text:\s*([\s\S]*)/i);
      if (inlineMatch) {
        platform = inlineMatch[1].toLowerCase();
        text = inlineMatch[2].trim();
      }
    }
    if (platform && text) {
      console.log(`[parseDeliverBlocks] parsed: platform=${platform}, textLen=${text.length}`);
      blocks.push({ platform, text });
    } else {
      console.warn(`[parseDeliverBlocks] failed to parse block body: ${body.slice(0, 200)}`);
    }
  }
  return blocks;
}

function parseScheduleBlocks(fullText: string): ParsedScheduleBlock[] {
  const blocks: ParsedScheduleBlock[] = [];
  const re = /\[SCHEDULE_DELIVERY\]([\s\S]*?)\[\/SCHEDULE_DELIVERY\]/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(fullText)) !== null) {
    const body = m[1].trim();
    const schedule = body.match(/^\s*schedule:\s*(.+)$/m)?.[1]?.trim() || '';
    const rawPlatform = body.match(/^\s*platform:\s*(.+)$/m)?.[1]?.trim() || '';
    const platform = rawPlatform.toLowerCase().split(/\s/)[0] || '';
    const name = body.match(/^\s*name:\s*(.+)$/m)?.[1]?.trim() || 'Scheduled Delivery';
    const textMatch = body.match(/^\s*text:\s*([\s\S]*)$/m);
    const text = textMatch?.[1]?.trim() || '';
    if (schedule && platform && text) {
      console.log(`[parseScheduleBlocks] parsed: schedule=${schedule}, platform=${platform}, name=${name}`);
      blocks.push({ schedule, platform, name, text });
    } else {
      console.warn(`[parseScheduleBlocks] failed to parse block body: ${body.slice(0, 200)}`);
    }
  }
  return blocks;
}

function normalizeCron(schedule: string): string {
  const s = schedule.toLowerCase().trim();
  if (s === 'daily') return '0 9 * * *';
  if (s === 'hourly') return '0 * * * *';
  if (s === 'weekly') return '0 9 * * 1';
  if (s === 'monthly') return '0 9 1 * *';
  return schedule; // assume it's already a cron expression
}

async function processDeliveryBlocks(fullText: string, userId: string): Promise<void> {
  // 1. Immediate deliveries
  const deliverBlocks = parseDeliverBlocks(fullText);
  for (const block of deliverBlocks) {
    try {
      const targets: DeliveryTarget[] = block.platform === 'all'
        ? [] // empty = all linked channels
        : [{ platform: block.platform as ChannelPlatform }];

      const results = await deliverMessage({
        userId,
        text: block.text,
        targets: targets.length > 0 ? targets : undefined,
        sourceContext: 'ai-chat',
      });
      console.log('[ai-chat][deliver] results:', JSON.stringify(results));
    } catch (err) {
      console.error('[ai-chat][deliver] failed:', err);
    }
  }

  // 2. Scheduled deliveries
  const scheduleBlocks = parseScheduleBlocks(fullText);
  for (const block of scheduleBlocks) {
    try {
      const cronExpr = normalizeCron(block.schedule);
      const platforms = block.platform === 'all'
        ? ['slack', 'telegram']
        : [block.platform];

      await pool.query(
        `INSERT INTO scheduled_deliveries (user_id, name, message_template, cron_expression, platforms)
         VALUES ($1, $2, $3, $4, $5)`,
        [userId, block.name, block.text, cronExpr, JSON.stringify(platforms)],
      );
      console.log('[ai-chat][schedule] created:', block.name, cronExpr, platforms);
    } catch (err) {
      console.error('[ai-chat][schedule] failed:', err);
    }
  }
}

// ── Post-processing: detect [CREATE_PRODUCT] / [CREATE_TASK] blocks ────

interface ParsedCreateProductBlock {
  name: string;
  summary?: string;
  description?: string;
  price?: string;
  pricingModel?: string;
  currency?: string;
  targetAudience?: string;
  categoryId?: string;
  productType?: string;
}

interface ParsedCreateTaskBlock {
  agentId?: string;
  agentName?: string;
  taskPrompt: string;
  taskType?: string;
  heartbeatInterval?: string;
  maxRuntimeHours?: number;
}

/** Generic key: value parser for action blocks. Handles multi-line values. */
function parseKeyValueBlock(body: string): Record<string, string> {
  const fields: Record<string, string> = {};
  const lines = body.split('\n');
  let currentKey = '';
  let currentValue = '';
  for (const line of lines) {
    const kv = line.match(/^\s*([\w_]+):\s*(.*)/);
    if (kv) {
      if (currentKey) fields[currentKey] = currentValue.trim();
      currentKey = kv[1];
      currentValue = kv[2];
    } else if (currentKey) {
      currentValue += '\n' + line;
    }
  }
  if (currentKey) fields[currentKey] = currentValue.trim();
  return fields;
}

function parseCreateProductBlocks(fullText: string): ParsedCreateProductBlock[] {
  const blocks: ParsedCreateProductBlock[] = [];
  const re = /\[CREATE_PRODUCT\]([\s\S]*?)\[\/CREATE_PRODUCT\]/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(fullText)) !== null) {
    const f = parseKeyValueBlock(m[1].trim());
    const name = f.name || '';
    if (name) {
      console.log(`[parseCreateProductBlocks] parsed: name="${name}" price=${f.price || 'N/A'} model=${f.pricing_model || 'N/A'}`);
      blocks.push({
        name,
        summary: f.summary,
        description: f.description,
        price: f.price,
        pricingModel: f.pricing_model,
        currency: f.currency,
        targetAudience: f.target_audience,
        categoryId: f.category_id,
        productType: f.product_type,
      });
    } else {
      console.warn(`[parseCreateProductBlocks] missing 'name' in block: ${m[1].slice(0, 200)}`);
    }
  }
  return blocks;
}

function parseCreateTaskBlocks(fullText: string): ParsedCreateTaskBlock[] {
  const blocks: ParsedCreateTaskBlock[] = [];
  const re = /\[CREATE_TASK\]([\s\S]*?)\[\/CREATE_TASK\]/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(fullText)) !== null) {
    const f = parseKeyValueBlock(m[1].trim());
    const taskPrompt = f.task_prompt || '';
    const agentId = f.agent_id;
    const agentName = f.agent_name;
    if (taskPrompt && (agentId || agentName)) {
      const maxHStr = f.max_runtime_hours;
      console.log(`[parseCreateTaskBlocks] parsed: agent=${agentId || agentName} type=${f.task_type || 'one-shot'}`);
      blocks.push({
        agentId,
        agentName,
        taskPrompt,
        taskType: f.task_type,
        heartbeatInterval: f.heartbeat_interval,
        maxRuntimeHours: maxHStr ? parseInt(maxHStr, 10) : undefined,
      });
    } else {
      console.warn(`[parseCreateTaskBlocks] missing fields in block: ${m[1].slice(0, 200)}`);
    }
  }
  return blocks;
}

/**
 * Extract all image URLs from an AI response and persist them to user_media.
 * This ensures every generated image is saved to the user's media library,
 * regardless of whether a product is created in the same message.
 */
async function persistDetectedMedia(fullText: string, userId: string): Promise<{ url: string; fileName: string }[]> {
  const mediaUrls: { url: string; fileName: string }[] = [];

  // Pattern 1: markdown image syntax pointing at our media proxy
  const mdImgRe = /!\[([^\]]*)\]\((\/api\/media\/workspace\/[^)]+)\)/gi;
  let match: RegExpExecArray | null;
  while ((match = mdImgRe.exec(fullText)) !== null) {
    const fileName = match[1] || match[2].split('/').pop() || 'image.png';
    mediaUrls.push({ url: match[2], fileName });
  }

  // Pattern 2: raw MEDIA: lines (in case transform didn't fire)
  const mediaLineRe = /\*\*MEDIA:\*\*\s*(\/[^\s]+)/gi;
  while ((match = mediaLineRe.exec(fullText)) !== null) {
    const rawPath = match[1];
    const fileName = rawPath.split('/').pop() || 'image.png';
    const url = rawPath.startsWith('/home/node/.openclaw/workspace/')
      ? '/api/media/workspace/' + rawPath.replace('/home/node/.openclaw/workspace/', '')
      : rawPath;
    if (!mediaUrls.some(i => i.url === url)) {
      mediaUrls.push({ url, fileName });
    }
  }

  // Pattern 3: raw MEDIA: lines WITHOUT bold (gateway sometimes emits plain MEDIA:)
  const rawMediaRe = /\bMEDIA:\s*\/home\/node\/\.openclaw\/workspace\/(.+)/gi;
  while ((match = rawMediaRe.exec(fullText)) !== null) {
    const fileName = match[1].trim().replace(/[`"']+$/g, '');
    const url = `/api/media/workspace/${encodeURIComponent(fileName)}`;
    if (!mediaUrls.some(i => i.url === url)) {
      mediaUrls.push({ url, fileName });
    }
  }

  // Fallback: query GCS workspace via mawa-storage for images not found in text.
  // The gateway LLM doesn't always echo the MEDIA: path; this catches those cases.
  try {
    const workspaceFiles = await listWorkspaceImages(userId);
    if (workspaceFiles.length > 0) {
      console.log(`[user-media] GCS workspace has ${workspaceFiles.length} image(s)`);
      for (const name of workspaceFiles) {
        const url = `/api/media/workspace/${encodeURIComponent(name)}`;
        if (!mediaUrls.some(i => i.url === url)) {
          // Check if already in user_media before adding to the list
          const existing = await queryWithRLS(userId,
            `SELECT id FROM user_media WHERE user_id = $1 AND file_url = $2`,
            [userId, url]
          );
          if (existing.rows.length === 0) {
            mediaUrls.push({ url, fileName: name });
            console.log(`[user-media] GCS fallback discovered: ${name}`);
          }
        }
      }
    }
  } catch (err) {
    console.warn('[user-media] GCS workspace fallback error:', (err as Error)?.message);
  }

  if (mediaUrls.length === 0) return [];

  console.log(`[user-media] Persisting ${mediaUrls.length} detected image(s) for user ${userId}`);
  const persisted: { url: string; fileName: string }[] = [];
  for (const img of mediaUrls) {
    try {
      // Deduplicate: skip if same file_url already exists for this user
      const existing = await queryWithRLS(userId,
        `SELECT id FROM user_media WHERE user_id = $1 AND file_url = $2`,
        [userId, img.url]
      );
      if (existing.rows.length > 0) {
        console.log(`[user-media] Skipping duplicate: ${img.fileName}`);
        persisted.push(img); // still return it — it exists
        continue;
      }
      const ext = img.fileName.split('.').pop()?.toLowerCase() || '';
      const mimeMap: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' };
      const mimeType = mimeMap[ext] || 'image/png';
      await queryWithRLS(userId,
        `INSERT INTO user_media (user_id, file_url, file_name, mime_type, source, generation_prompt)
         VALUES ($1, $2, $3, $4, 'ai_generated', $5)`,
        [userId, img.url, img.fileName, mimeType, `AI-generated image: ${img.fileName}`]
      );
      console.log(`[user-media] ✅ Saved: ${img.fileName}`);
      persisted.push(img);
    } catch (err) {
      console.error(`[user-media] ❌ Failed to save "${img.fileName}":`, (err as Error)?.message);
    }
  }
  return persisted;
}

async function processSellerBlocks(fullText: string, userId: string, _authToken: string | null): Promise<void> {
  console.log(`[seller-action] ─── processSellerBlocks START ─── userId=${userId}`);
  const productBlocks = parseCreateProductBlocks(fullText);
  console.log(`[seller-action] Parsed ${productBlocks.length} CREATE_PRODUCT block(s)`);
  if (productBlocks.length === 0) {
    // Log the raw regex match attempt for debugging
    const rawMatch = fullText.match(/\[CREATE_PRODUCT\]([\s\S]*?)\[\/CREATE_PRODUCT\]/i);
    console.log(`[seller-action] Raw regex match: ${rawMatch ? 'found, content=' + rawMatch[1].slice(0, 300) : 'NO MATCH'}`);
    console.log(`[seller-action] ─── processSellerBlocks END (no blocks) ───`);
    return;
  }

  // Extract image URLs from the full AI response text (before action blocks)
  // Patterns: ![filename](/api/media/workspace/file.png) or **MEDIA:** /path/to/file
  const imageUrls: { url: string; fileName: string }[] = [];
  const mdImgRe = /!\[([^\]]*)\]\((\/api\/media\/workspace\/[^)]+)\)/gi;
  let imgMatch: RegExpExecArray | null;
  while ((imgMatch = mdImgRe.exec(fullText)) !== null) {
    const fileName = imgMatch[1] || imgMatch[2].split('/').pop() || 'image.png';
    imageUrls.push({ url: imgMatch[2], fileName });
  }
  const mediaLineRe = /\*\*MEDIA:\*\*\s*(\/[^\s]+)/gi;
  while ((imgMatch = mediaLineRe.exec(fullText)) !== null) {
    const rawPath = imgMatch[1];
    const fileName = rawPath.split('/').pop() || 'image.png';
    // Convert gateway filesystem path to API URL
    const url = rawPath.startsWith('/home/node/.openclaw/workspace/')
      ? '/api/media/workspace/' + rawPath.replace('/home/node/.openclaw/workspace/', '')
      : rawPath;
    // Avoid duplicates (same URL already captured via markdown image)
    if (!imageUrls.some(i => i.url === url)) {
      imageUrls.push({ url, fileName });
    }
  }
  console.log(`[seller-action] Extracted ${imageUrls.length} image URL(s) from fullText`);

  for (let i = 0; i < productBlocks.length; i++) {
    const block = productBlocks[i];
    try {
      console.log(`[seller-action] Block #${i}: name="${block.name}" summary="${block.summary?.slice(0, 100)}" price="${block.price}" model="${block.pricingModel}" currency="${block.currency}"`);
      console.log(`[seller-action] Block #${i}: description="${block.description?.slice(0, 200)}" audience="${block.targetAudience?.slice(0, 100)}" categoryId="${block.categoryId}"`);
      const payload: ChatProductPayload = {
        name: block.name,
        summary: block.summary,
        description: block.description,
        price: block.price,
        pricingModel: block.pricingModel,
        currency: block.currency,
        targetAudience: block.targetAudience,
        categoryId: block.categoryId,
        productType: block.productType,
      };
      // Use product name as idempotency key to prevent duplicate creation
      const idempotencyKey = `chat:${block.name.toLowerCase().replace(/\s+/g, '-').slice(0, 100)}`;
      console.log(`[seller-action] Block #${i}: idempotencyKey="${idempotencyKey}" — calling createProductFromChat...`);
      const result = await createProductFromChat(userId, payload, { source: 'chat' }, idempotencyKey);
      console.log(`[seller-action] Block #${i}: ✅ Product created: id=${result.id} name="${result.name}" status=${result.status} review=${result.requiresReview} missing=[${result.missingFields.join(',')}]`);

      // ── Auto-create product_assets from extracted images ──
      if (imageUrls.length > 0) {
        for (let j = 0; j < imageUrls.length; j++) {
          const img = imageUrls[j];
          try {
            await queryWithRLS(userId,
              `INSERT INTO product_assets (product_id, user_id, asset_type, file_url, file_name, is_generated, generation_prompt, sort_order)
               VALUES ($1, $2, 'image', $3, $4, true, $5, $6)
               ON CONFLICT DO NOTHING`,
              [result.id, userId, img.url, img.fileName, `AI-generated for product: ${block.name}`, j],
            );
            console.log(`[seller-action] Block #${i}: ✅ Asset #${j} created: file="${img.fileName}" url="${img.url}"`);
            // Link in user_media too
            await queryWithRLS(userId,
              `UPDATE user_media SET product_id = $1 WHERE user_id = $2 AND file_url = $3 AND product_id IS NULL`,
              [result.id, userId, img.url],
            );
          } catch (assetErr) {
            console.error(`[seller-action] Block #${i}: ❌ Asset creation error for "${img.fileName}":`, (assetErr as Error)?.message);
          }
        }
      }

      // ── Also pull unlinked user_media images into this product ──
      // This catches images generated in earlier messages that weren't part of a product yet
      if (imageUrls.length === 0) {
        try {
          const { rows: unlinkedMedia } = await queryWithRLS(userId,
            `SELECT id, file_url, file_name, mime_type, generation_prompt
             FROM user_media WHERE user_id = $1 AND product_id IS NULL
             ORDER BY created_at DESC LIMIT 10`,
            [userId]
          );
          if (unlinkedMedia.length > 0) {
            console.log(`[seller-action] Block #${i}: Found ${unlinkedMedia.length} unlinked user_media image(s) — linking to product ${result.id}`);
            for (let j = 0; j < unlinkedMedia.length; j++) {
              const media = unlinkedMedia[j];
              try {
                await queryWithRLS(userId,
                  `INSERT INTO product_assets (product_id, user_id, asset_type, file_url, file_name, mime_type, is_generated, generation_prompt, sort_order)
                   VALUES ($1, $2, 'image', $3, $4, $5, $6, $7, $8)
                   ON CONFLICT DO NOTHING`,
                  [result.id, userId, media.file_url, media.file_name, media.mime_type, !!media.generation_prompt, media.generation_prompt, j],
                );
                await queryWithRLS(userId,
                  `UPDATE user_media SET product_id = $1 WHERE id = $2`,
                  [result.id, media.id],
                );
                console.log(`[seller-action] Block #${i}: ✅ Linked user_media #${j}: "${media.file_name}"`);
              } catch (linkErr) {
                console.error(`[seller-action] Block #${i}: ❌ Failed to link user_media "${media.file_name}":`, (linkErr as Error)?.message);
              }
            }
            // Also update imageUrls for the listing_output below
            imageUrls.push(...unlinkedMedia.map((m: { file_url: string; file_name: string }) => ({ url: m.file_url, fileName: m.file_name || 'image.png' })));
          }
        } catch (mediaErr) {
          console.error(`[seller-action] Block #${i}: ❌ Failed to fetch unlinked user_media:`, (mediaErr as Error)?.message);
        }
      }

      // ── Auto-create marketplace listing_output ──
      try {
        const mediaUrlsArr = imageUrls.map(img => img.url);
        await queryWithRLS(userId,
          `INSERT INTO listing_outputs (product_id, channel, title, body, hashtags, media_urls, metadata)
           VALUES ($1, 'marketplace', $2, $3, $4, $5, $6)`,
          [result.id, block.name, block.description || block.summary || '', [], mediaUrlsArr, {}],
        );
        console.log(`[seller-action] Block #${i}: ✅ Marketplace listing created for product ${result.id}`);
      } catch (listingErr) {
        console.error(`[seller-action] Block #${i}: ❌ Listing creation error:`, (listingErr as Error)?.message);
      }

    } catch (err) {
      console.error(`[seller-action] Block #${i}: ❌ Product creation error:`, err);
      console.error(`[seller-action] Block #${i}: Error details: name="${block.name}" message="${(err as Error)?.message}" stack="${(err as Error)?.stack?.split('\n').slice(0, 3).join(' | ')}"`);
    }
  }
  console.log(`[seller-action] ─── processSellerBlocks END ───`);
}

async function processTaskBlocks(fullText: string, userId: string): Promise<void> {
  const taskBlocks = parseCreateTaskBlocks(fullText);
  for (const block of taskBlocks) {
    try {
      // Resolve agent_id from name/slug if not provided directly
      let agentId = block.agentId;
      if (!agentId && block.agentName) {
        const { rows } = await pool.query(
          `SELECT id FROM marketplace_agents WHERE LOWER(slug) = LOWER($1) OR LOWER(name) = LOWER($1) LIMIT 1`,
          [block.agentName],
        );
        agentId = rows[0]?.id;
        if (!agentId) {
          console.error(`[task-action] Agent not found: "${block.agentName}"`);
          continue;
        }
        console.log(`[task-action] Resolved agent "${block.agentName}" → id=${agentId}`);
      }
      if (!agentId) {
        console.error('[task-action] No agent_id or agent_name provided');
        continue;
      }

      const taskType = block.taskType || 'one-shot';
      const heartbeat = taskType === 'recurring' ? (block.heartbeatInterval || '30m') : null;
      const maxHours = block.maxRuntimeHours || 24;

      console.log(`[task-action] Creating task: agent=${agentId} type=${taskType} user=${userId}`);
      const { rows } = await pool.query(
        `INSERT INTO agent_tasks (
           user_id, agent_id, task_prompt, task_type,
           status, heartbeat_interval, max_runtime_hours
         ) VALUES ($1, $2, $3, $4, 'pending', $5, $6)
         RETURNING *`,
        [userId, agentId, block.taskPrompt, taskType, heartbeat, maxHours],
      );
      const task = rows[0];
      console.log(`[task-action] Task created: id=${task?.id} status=${task?.status}`);

      // Sync to Mission Control board
      try {
        const mcLink = await createMCTaskFromAgentTask(userId, task.id, block.taskPrompt);
        if (mcLink) {
          console.log(`[task-action] MC sync: task ${task.id} → MC ${mcLink.mcTaskId}`);
        }
      } catch (mcErr) {
        console.warn('[task-action] MC sync failed (non-critical):', mcErr);
      }
    } catch (err) {
      console.error('[task-action] Task creation error:', err);
    }
  }
}

// ── [UPDATE_PRODUCT] block parser + processor ──────────────────────────────

interface ParsedUpdateProductBlock {
  productId?: string;
  productName?: string;
  name?: string;
  summary?: string;
  description?: string;
  price?: string;
  pricingModel?: string;
  status?: string;
  categoryId?: string;
}

function parseUpdateProductBlocks(fullText: string): ParsedUpdateProductBlock[] {
  const blocks: ParsedUpdateProductBlock[] = [];
  const re = /\[UPDATE_PRODUCT\]([\s\S]*?)\[\/UPDATE_PRODUCT\]/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(fullText)) !== null) {
    const f = parseKeyValueBlock(m[1].trim());
    const productId = f.product_id;
    const productName = f.product_name;
    if (productId || productName) {
      console.log(`[parseUpdateProductBlocks] parsed: id=${productId || 'N/A'} name=${productName || 'N/A'}`);
      blocks.push({
        productId,
        productName,
        name: f.name,
        summary: f.summary,
        description: f.description,
        price: f.price,
        pricingModel: f.pricing_model,
        status: f.status,
        categoryId: f.category_id,
      });
    } else {
      console.warn(`[parseUpdateProductBlocks] missing product_id or product_name: ${m[1].slice(0, 200)}`);
    }
  }
  return blocks;
}

async function processUpdateProductBlocks(fullText: string, userId: string, authToken: string | null): Promise<void> {
  const blocks = parseUpdateProductBlocks(fullText);
  for (const block of blocks) {
    try {
      // Resolve product_id from product_name if needed
      let productId = block.productId;
      if (!productId && block.productName) {
        const { rows } = await pool.query(
          `SELECT id FROM products WHERE user_id = $1 AND LOWER(name) = LOWER($2) LIMIT 1`,
          [userId, block.productName],
        );
        productId = rows[0]?.id;
        if (!productId) {
          console.error(`[seller-action] Product not found by name: "${block.productName}"`);
          continue;
        }
        console.log(`[seller-action] Resolved product "${block.productName}" → id=${productId}`);
      }

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'X-User-ID': userId,
      };
      if (authToken) headers['Authorization'] = authToken;

      const body: Record<string, unknown> = {};
      if (block.name) body.name = block.name;
      if (block.summary) body.summary = block.summary;
      if (block.description) body.description = block.description;
      if (block.price) body.price = block.price;
      if (block.pricingModel) body.pricingModel = block.pricingModel;
      if (block.status) body.status = block.status;
      if (block.categoryId) body.categoryId = block.categoryId;

      if (Object.keys(body).length === 0) {
        console.warn(`[seller-action] UPDATE_PRODUCT block has no fields to update`);
        continue;
      }

      console.log(`[seller-action] Updating product ${productId}: ${JSON.stringify(body)}`);
      const res = await fetch(`${SELLER_API_BASE}/seller/products/${productId}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify(body),
      });

      if (res.ok) {
        console.log(`[seller-action] Product updated: id=${productId}`);
      } else {
        const errText = await res.text();
        console.error(`[seller-action] Update product FAILED: status=${res.status} body=${errText.slice(0, 500)}`);
      }
    } catch (err) {
      console.error('[seller-action] Product update error:', err);
    }
  }
}

// ── [PUBLISH_PRODUCT] block parser + processor ─────────────────────────────

interface ParsedPublishProductBlock {
  productId?: string;
  productName?: string;
  platform: string;
  caption?: string;
  imageUrl?: string;
  listingOutputId?: string;
  publishingTargetId?: string;
}

function parsePublishProductBlocks(fullText: string): ParsedPublishProductBlock[] {
  const blocks: ParsedPublishProductBlock[] = [];
  const re = /\[PUBLISH_PRODUCT\]([\s\S]*?)\[\/PUBLISH_PRODUCT\]/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(fullText)) !== null) {
    const f = parseKeyValueBlock(m[1].trim());
    const platform = f.platform || f.channel || '';
    if (platform && (f.product_id || f.product_name)) {
      console.log(`[parsePublishProductBlocks] parsed: product=${f.product_id || f.product_name} platform=${platform}`);
      blocks.push({
        productId: f.product_id,
        productName: f.product_name,
        platform,
        caption: f.caption,
        imageUrl: f.image_url,
        listingOutputId: f.listing_output_id,
        publishingTargetId: f.publishing_target_id,
      });
    } else {
      console.warn(`[parsePublishProductBlocks] missing fields: ${m[1].slice(0, 200)}`);
    }
  }
  return blocks;
}

async function processPublishBlocks(fullText: string, userId: string, authToken: string | null, conversationId: string | null): Promise<void> {
  console.log(`[publish-action] ─── processPublishBlocks START ─── userId=${userId}`);
  const blocks = parsePublishProductBlocks(fullText);
  console.log(`[publish-action] Parsed ${blocks.length} PUBLISH_PRODUCT block(s)`);
  if (blocks.length === 0) {
    const rawMatch = fullText.match(/\[PUBLISH_PRODUCT\]([\s\S]*?)\[\/PUBLISH_PRODUCT\]/i);
    console.log(`[publish-action] Raw regex match: ${rawMatch ? 'found, content=' + rawMatch[1].slice(0, 300) : 'NO MATCH'}`);
    console.log(`[publish-action] ─── processPublishBlocks END (no blocks) ───`);
    return;
  }
  const resultSummaries: string[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    try {
      console.log(`[publish-action] Block #${i}: productId="${block.productId}" productName="${block.productName}" platform="${block.platform}" caption="${block.caption?.slice(0, 100)}" imageUrl="${block.imageUrl?.slice(0, 100)}"`);
      let productId = block.productId;
      if (!productId && block.productName) {
        console.log(`[publish-action] Block #${i}: Looking up product by name="${block.productName}" for userId=${userId}`);
        const { rows } = await queryWithRLS(
          userId,
          `SELECT id FROM products WHERE user_id = $1 AND LOWER(name) = LOWER($2) LIMIT 1`,
          [userId, block.productName],
        );
        productId = rows[0]?.id;
        if (!productId) {
          console.error(`[publish-action] Block #${i}: ❌ Product not found for publishing: "${block.productName}"`);
          resultSummaries.push(`**${block.platform}**: ❌ Could not publish — product "${block.productName}" not found in your catalog.`);
          continue;
        }
        console.log(`[publish-action] Block #${i}: Resolved product name → id=${productId}`);
      }

      // ── Auto-resolve publishingTargetId from platform (must have valid Zernio account) ──
      let publishingTargetId = block.publishingTargetId;
      if (!publishingTargetId && block.platform) {
        // Map AI platform names to publishing_targets.target_type values
        const platformToTargetType: Record<string, string[]> = {
          instagram: ['instagram_account', 'instagram'],
          facebook: ['facebook_page', 'facebook'],
          linkedin: ['linkedin_page', 'linkedin'],
          twitter: ['twitter_account', 'twitter'],
          tiktok: ['tiktok_account', 'tiktok'],
        };
        const targetTypes = platformToTargetType[block.platform.toLowerCase()] || [block.platform];
        console.log(`[publish-action] Block #${i}: Looking up publishing target for platform="${block.platform}" targetTypes=[${targetTypes}]`);
        // Only pick targets whose social account has a valid platform_account_id (Zernio requires it)
        const { rows: targetRows } = await queryWithRLS(
          userId,
          `SELECT pt.id, csa.platform_account_id FROM publishing_targets pt
           JOIN connected_social_accounts csa ON pt.social_account_id = csa.id
           WHERE pt.user_id = $1 AND pt.is_active = true AND csa.is_active = true
             AND csa.platform_account_id IS NOT NULL
             AND (pt.target_type = ANY($2) OR LOWER(csa.platform) = LOWER($3))
           ORDER BY pt.is_default DESC, pt.created_at ASC
           LIMIT 1`,
          [userId, targetTypes, block.platform],
        );
        if (targetRows.length > 0) {
          publishingTargetId = targetRows[0].id;
          console.log(`[publish-action] Block #${i}: ✅ Resolved publishing target: id=${publishingTargetId} platform_account_id=${targetRows[0].platform_account_id}`);
        } else {
          console.error(`[publish-action] Block #${i}: ❌ No publishing target with valid Zernio account ID found for platform="${block.platform}". User needs to reconnect the social account.`);
          resultSummaries.push(`**${block.platform}**: ❌ No connected ${block.platform} account with a valid Zernio link. Connect or reconnect the account at /seller/social-accounts.`);
          continue;
        }
      }

      // ── Auto-create listing_output for the platform with caption ──
      let listingOutputId = block.listingOutputId;
      if (!listingOutputId && productId && block.caption) {
        try {
          // Fetch product assets for media_urls
          const { rows: assetRows } = await queryWithRLS(
            userId,
            `SELECT file_url FROM product_assets WHERE product_id = $1 ORDER BY sort_order ASC`,
            [productId],
          );
          const mediaUrls = assetRows.map((r: { file_url: string }) => r.file_url);

          // Parse caption into title and body — first line is title, rest is body
          const captionLines = block.caption.split('\n');
          const title = captionLines[0]?.trim() || block.productName || '';
          const body = captionLines.slice(1).join('\n').trim() || block.caption;

          // Extract hashtags from caption
          const hashtagMatches = block.caption.match(/#\w+/g) || [];

          const { rows: loRows } = await queryWithRLS(
            userId,
            `INSERT INTO listing_outputs (product_id, channel, title, body, hashtags, media_urls)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING id`,
            [productId, block.platform, title, body, hashtagMatches, mediaUrls],
          );
          if (loRows.length > 0) {
            listingOutputId = loRows[0].id;
            console.log(`[publish-action] Block #${i}: ✅ Created listing_output: id=${listingOutputId} channel=${block.platform} mediaUrls=${mediaUrls.length}`);
          }
        } catch (loErr) {
          console.error(`[publish-action] Block #${i}: ❌ listing_output creation error:`, (loErr as Error)?.message);
        }
      }

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'X-User-ID': userId,
      };
      if (authToken) headers['Authorization'] = authToken;

      const body: Record<string, unknown> = {
        productId,
        channel: block.platform,
      };
      if (listingOutputId) body.listingOutputId = listingOutputId;
      if (publishingTargetId) body.publishingTargetId = publishingTargetId;

      const publishUrl = `${SELLER_API_BASE}/seller/publishing/publish`;
      console.log(`[publish-action] Block #${i}: POST ${publishUrl} body=${JSON.stringify(body).slice(0, 500)}`);
      const res = await fetch(publishUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });

      if (res.ok) {
        const data = await res.json() as { data?: { job?: { id?: string; status?: string } } };
        const jobId = data?.data?.job?.id ?? 'unknown';
        console.log(`[publish-action] Block #${i}: ✅ Publish job created: jobId=${jobId} full=${JSON.stringify(data).slice(0, 300)}`);
        resultSummaries.push(`**${block.platform}**: ✅ Publish job queued (jobId: \`${jobId}\`). Track delivery in /seller/publishing.`);
      } else {
        const errText = await res.text();
        console.error(`[publish-action] Block #${i}: ❌ Publish FAILED: status=${res.status} url=${publishUrl} body=${errText.slice(0, 500)}`);
        let errMsg = `HTTP ${res.status}`;
        try {
          const j = JSON.parse(errText) as { error?: string; message?: string };
          errMsg = j.error || j.message || errMsg;
        } catch { /* keep raw */ }
        resultSummaries.push(`**${block.platform}**: ❌ Publish failed — ${errMsg}`);
      }
    } catch (err) {
      console.error(`[publish-action] Block #${i}: ❌ Publish error:`, err);
      resultSummaries.push(`**${block.platform}**: ❌ Publish error — ${(err as Error)?.message ?? 'unknown error'}`);
    }
  }
  if (conversationId && resultSummaries.length > 0) {
    const resultMessage = `📤 **Publishing Status**\n\n${resultSummaries.join('\n\n')}\n\n_This is the real status of the publishing request. Treat any earlier prose claiming "posted" as a queued intent only._`;
    try {
      await pool.query(
        `INSERT INTO messages (conversation_id, role, content) VALUES ($1, 'assistant', $2)`,
        [conversationId, resultMessage]
      );
      console.log(`[publish-action] Saved publish status message to conversation ${conversationId}`);
    } catch (err) {
      console.error(`[publish-action] Failed to save publish status message:`, (err as Error)?.message);
    }
  }
  console.log(`[publish-action] ─── processPublishBlocks END ───`);
}

// ── [SELLER_SQL] block parser + processor ──────────────────────────────────

interface ParsedSellerSqlBlock {
  operation: string;
  table: string;
  description: string;
  sql: string;
  params: unknown[];
  confirm: boolean;
}

const SELLER_SQL_ALLOWED_TABLES = new Set([
  'seller_profiles', 'seller_categories', 'products', 'product_versions',
  'product_assets', 'listing_outputs', 'connected_social_accounts',
  'publishing_targets', 'publishing_jobs', 'publishing_results',
  'approval_requests', 'promotion_rules', 'campaign_runs',
]);

const SELLER_SQL_READONLY_TABLES = new Set(['seller_categories']);

function parseSellerSqlBlocks(fullText: string): ParsedSellerSqlBlock[] {
  const blocks: ParsedSellerSqlBlock[] = [];
  const regex = /\[SELLER_SQL\]([\s\S]*?)\[\/SELLER_SQL\]/gi;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(fullText)) !== null) {
    const inner = m[1];
    const get = (key: string): string => {
      const kr = new RegExp(`^${key}:\\s*(.+)$`, 'mi');
      return kr.exec(inner)?.[1]?.trim() ?? '';
    };
    // sql may be multi-line: capture everything from "sql: " to the next known key or end
    const sqlMatch = inner.match(/^sql:\s*([\s\S]*?)(?=^(?:params|confirm):|\[\/SELLER_SQL\])/mi);
    const sqlValue = sqlMatch?.[1]?.trim() ?? get('sql');
    let params: unknown[] = [];
    try {
      const raw = get('params');
      if (raw) params = JSON.parse(raw);
    } catch { /* keep empty */ }
    blocks.push({
      operation: get('operation').toUpperCase(),
      table: get('table'),
      description: get('description'),
      sql: sqlValue,
      params,
      confirm: get('confirm').toLowerCase() === 'true',
    });
  }
  return blocks;
}

async function processSellerSqlBlocks(fullText: string, userId: string, conversationId: string | null): Promise<void> {
  console.log(`[seller-sql] ─── processSellerSqlBlocks START ─── userId=${userId} convId=${conversationId}`);
  const blocks = parseSellerSqlBlocks(fullText);
  console.log(`[seller-sql] Parsed ${blocks.length} SELLER_SQL block(s)`);
  if (blocks.length === 0) return;

  const resultSummaries: string[] = [];

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    try {
      console.log(`[seller-sql] Block #${i}: op=${block.operation} table="${block.table}" desc="${block.description}" confirm=${block.confirm}`);
      console.log(`[seller-sql] Block #${i}: sql=${block.sql.slice(0, 300)}`);
      console.log(`[seller-sql] Block #${i}: params=${JSON.stringify(block.params).slice(0, 300)}`);

      // ── Security validations ──
      if (!SELLER_SQL_ALLOWED_TABLES.has(block.table)) {
        console.error(`[seller-sql] Block #${i}: ❌ REJECTED — table "${block.table}" not in allowed list`);
        resultSummaries.push(`Query #${i + 1} (${block.description || block.operation}): ❌ Rejected — table "${block.table}" not allowed`);
        continue;
      }
      if (!['SELECT', 'INSERT', 'UPDATE', 'DELETE'].includes(block.operation)) {
        console.error(`[seller-sql] Block #${i}: ❌ REJECTED — operation "${block.operation}" not allowed`);
        resultSummaries.push(`Query #${i + 1} (${block.description || block.operation}): ❌ Rejected — operation "${block.operation}" not allowed`);
        continue;
      }
      if (SELLER_SQL_READONLY_TABLES.has(block.table) && block.operation !== 'SELECT') {
        console.error(`[seller-sql] Block #${i}: ❌ REJECTED — table "${block.table}" is READ-ONLY, cannot ${block.operation}`);
        resultSummaries.push(`Query #${i + 1} (${block.description || block.operation}): ❌ Rejected — table "${block.table}" is read-only`);
        continue;
      }
      // Block DDL keywords
      const ddlPattern = /\b(CREATE\s+TABLE|ALTER\s+TABLE|DROP\s+TABLE|TRUNCATE|CREATE\s+INDEX|DROP\s+INDEX)\b/i;
      if (ddlPattern.test(block.sql)) {
        console.error(`[seller-sql] Block #${i}: ❌ REJECTED — DDL detected in SQL`);
        resultSummaries.push(`Query #${i + 1} (${block.description || block.operation}): ❌ Rejected — DDL not allowed`);
        continue;
      }
      // Block access to token columns
      if (/access_token_enc|refresh_token_enc/i.test(block.sql)) {
        console.error(`[seller-sql] Block #${i}: ❌ REJECTED — attempted access to encrypted token columns`);
        resultSummaries.push(`Query #${i + 1} (${block.description || block.operation}): ❌ Rejected — encrypted token columns not accessible`);
        continue;
      }
      // Ensure DELETE has a WHERE clause
      if (block.operation === 'DELETE' && !/\bWHERE\b/i.test(block.sql)) {
        console.error(`[seller-sql] Block #${i}: ❌ REJECTED — DELETE without WHERE clause`);
        resultSummaries.push(`Query #${i + 1} (${block.description || block.operation}): ❌ Rejected — DELETE requires WHERE clause`);
        continue;
      }
      // Block queries referencing non-allowed tables (basic check)
      const fromPattern = /\b(?:FROM|JOIN|INTO|UPDATE)\s+(\w+)/gi;
      let tableMatch: RegExpExecArray | null;
      let tableSafe = true;
      while ((tableMatch = fromPattern.exec(block.sql)) !== null) {
        const refTable = tableMatch[1].toLowerCase();
        if (!SELLER_SQL_ALLOWED_TABLES.has(refTable) && !['json_build_object', 'json_agg', 'count', 'json_build_array'].includes(refTable)) {
          console.error(`[seller-sql] Block #${i}: ❌ REJECTED — references non-allowed table "${refTable}"`);
          resultSummaries.push(`Query #${i + 1} (${block.description || block.operation}): ❌ Rejected — references disallowed table "${refTable}"`);
          tableSafe = false;
          break;
        }
      }
      if (!tableSafe) continue;

      // Replace {{USER_ID}} placeholder in params
      const resolvedParams = block.params.map(p =>
        typeof p === 'string' ? p.replace(/\{\{USER_ID\}\}/g, userId) : p
      );

      const { rows } = await queryWithRLS(userId, block.sql, resolvedParams);
      console.log(`[seller-sql] Block #${i}: ✅ Success — ${rows.length} row(s) returned/affected`);

      // Build a human-readable result summary
      const desc = block.description || `${block.operation} on ${block.table}`;
      if (block.operation === 'SELECT') {
        if (rows.length === 0) {
          resultSummaries.push(`**${desc}**: No results found.`);
        } else {
          // Format as JSON, cap at ~4000 chars to stay within reasonable message size
          const jsonStr = JSON.stringify(rows, null, 2);
          const capped = jsonStr.length > 4000 ? jsonStr.slice(0, 4000) + `\n... (${rows.length} total rows, truncated)` : jsonStr;
          resultSummaries.push(`**${desc}** (${rows.length} row${rows.length !== 1 ? 's' : ''}):\n\`\`\`json\n${capped}\n\`\`\``);
        }
      } else {
        // INSERT/UPDATE/DELETE — report affected count
        resultSummaries.push(`**${desc}**: ✅ Success — ${rows.length} row(s) affected.`);
      }

      if (rows.length > 0 && rows.length <= 5) {
        console.log(`[seller-sql] Block #${i}: results=${JSON.stringify(rows).slice(0, 1000)}`);
      } else if (rows.length > 5) {
        console.log(`[seller-sql] Block #${i}: first 3 results=${JSON.stringify(rows.slice(0, 3)).slice(0, 500)}... (${rows.length} total)`);
      }
    } catch (err) {
      console.error(`[seller-sql] Block #${i}: ❌ Execution error:`, (err as Error)?.message);
      resultSummaries.push(`Query #${i + 1} (${block.description || block.operation}): ❌ Error — ${(err as Error)?.message}`);
    }
  }

  // Save results as a follow-up message so the user sees them and the AI can reference them
  if (conversationId && resultSummaries.length > 0) {
    const resultMessage = `📊 **Seller Data Query Results**\n\n${resultSummaries.join('\n\n')}`;
    try {
      await pool.query(
        `INSERT INTO messages (conversation_id, role, content) VALUES ($1, 'assistant', $2)`,
        [conversationId, resultMessage]
      );
      console.log(`[seller-sql] Saved result message to conversation ${conversationId}, len=${resultMessage.length}`);
    } catch (err) {
      console.error(`[seller-sql] Failed to save result message:`, (err as Error)?.message);
    }
  }

  console.log(`[seller-sql] ─── processSellerSqlBlocks END ───`);
}

// ── [ZERNIO_API] block parser + processor ──────────────────────────────────

interface ParsedZernioApiBlock {
  action: string;
  description: string;
  params: Record<string, unknown>;
}

const ZERNIO_ALLOWED_ACTIONS = new Set([
  'list_accounts', 'create_post', 'get_post', 'delete_post', 'list_profiles',
]);

// ── Platform content-length enforcement ────────────────────────────────────
// The AI repeatedly ignores the per-platform character limits in the system
// prompt and Zernio rejects the resulting posts. Enforce server-side before
// calling the proxy. Twitter counts every URL as 23 chars regardless of
// actual length, so we approximate URL length when measuring.
const PLATFORM_CONTENT_LIMIT: Record<string, number> = {
  twitter: 280,
  x: 280,
  threads: 500,
  pinterest: 500,
  googlebusiness: 1500,
  google_business: 1500,
  linkedin: 3000,
  instagram: 2200,
  tiktok: 2200,
  youtube: 5000,
  facebook: 63206,
};

const TWITTER_URL_LEN = 23;
const URL_REGEX = /https?:\/\/\S+/g;

function tweetLength(text: string): number {
  // Twitter/X t.co wraps every URL to 23 chars regardless of original length.
  let len = text.length;
  const urls = text.match(URL_REGEX) || [];
  for (const u of urls) {
    len = len - u.length + TWITTER_URL_LEN;
  }
  return len;
}

/**
 * Truncate `content` so it fits the platform limit while preserving any
 * trailing hashtags / @mentions and a final URL when possible. Adds an
 * ellipsis. For Twitter, accounts for t.co URL wrapping.
 */
function truncateForPlatform(content: string, platform: string): { text: string; truncated: boolean } {
  const limit = PLATFORM_CONTENT_LIMIT[platform.toLowerCase()];
  if (!limit) return { text: content, truncated: false };

  const isTwitter = platform.toLowerCase() === 'twitter' || platform.toLowerCase() === 'x';
  const measure = (s: string) => (isTwitter ? tweetLength(s) : s.length);
  if (measure(content) <= limit) return { text: content, truncated: false };

  // Try to preserve trailing hashtag block / final URL
  const tailMatch = content.match(/(\n+|\s+)((?:#[\w\u00C0-\uFFFF]+(?:\s+|$))+|https?:\/\/\S+)\s*$/);
  let head = content;
  let tail = '';
  if (tailMatch) {
    tail = tailMatch[2].trim();
    head = content.slice(0, content.length - tailMatch[0].length).trim();
  }

  const ellipsis = '…';
  const tailWithSep = tail ? `\n\n${tail}` : '';
  // Binary-search the largest head that fits limit when combined with tail+ellipsis
  const tailCost = measure(tailWithSep) + measure(ellipsis);
  const headBudget = limit - tailCost;
  if (headBudget <= 10) {
    // Tail alone is already too big; just hard-cut the original content.
    let cut = content;
    while (measure(cut) > limit - 1 && cut.length > 1) {
      cut = cut.slice(0, Math.max(1, cut.length - Math.ceil((measure(cut) - limit + 1))));
    }
    return { text: cut.replace(/\s+\S*$/, '').trim() + ellipsis, truncated: true };
  }
  let lo = 0, hi = head.length, best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (measure(head.slice(0, mid)) <= headBudget) { best = mid; lo = mid + 1; }
    else { hi = mid - 1; }
  }
  let cutHead = head.slice(0, best).replace(/\s+\S*$/, '').trim();
  if (!cutHead) cutHead = head.slice(0, Math.max(1, headBudget - 1));
  return { text: `${cutHead}${ellipsis}${tailWithSep}`, truncated: true };
}

interface CreatePostPlatformEntry { platform?: string; accountId?: string }

/**
 * Mutates a Zernio create_post params object so each platform's `content`
 * fits the platform's character limit. Returns a list of human-readable
 * notes describing any truncation that occurred so we can surface it to
 * the user.
 *
 * Zernio create_post takes a single `content` field for ALL platforms in
 * the same call. When platforms have different limits we MUST split the
 * call \u2014 the current implementation truncates to the strictest limit
 * across all targeted platforms (so a single post to Instagram + Twitter
 * gets truncated to 280 chars). The AI is instructed in the system prompt
 * to issue separate [ZERNIO_API] blocks per platform when caption length
 * matters; this is the safety net.
 */
function enforcePlatformContentLimits(params: Record<string, unknown>): string[] {
  const notes: string[] = [];
  const content = typeof params.content === 'string' ? params.content : '';
  if (!content) return notes;

  const platformsRaw = params.platforms;
  if (!Array.isArray(platformsRaw) || platformsRaw.length === 0) return notes;
  const platforms = (platformsRaw as CreatePostPlatformEntry[])
    .map(p => (p?.platform || '').toLowerCase().trim())
    .filter(Boolean);
  if (platforms.length === 0) return notes;

  // Pick the smallest applicable limit \u2014 safest single-content fit.
  let strictest: { platform: string; limit: number } | null = null;
  for (const p of platforms) {
    const limit = PLATFORM_CONTENT_LIMIT[p];
    if (!limit) continue;
    if (!strictest || limit < strictest.limit) strictest = { platform: p, limit };
  }
  if (!strictest) return notes;

  const result = truncateForPlatform(content, strictest.platform);
  if (result.truncated) {
    params.content = result.text;
    notes.push(`Caption was longer than ${strictest.platform}'s ${strictest.limit}-char limit \u2014 truncated to fit.`);
    console.log(`[zernio-api] enforcePlatformContentLimits: truncated for ${strictest.platform} (limit=${strictest.limit})`);
  }
  return notes;
}

function parseZernioApiBlocks(fullText: string): ParsedZernioApiBlock[] {
  const blocks: ParsedZernioApiBlock[] = [];
  // Accept [ZERNIO_API] or [ZERNIO_API:N] (AI sometimes adds a numeric suffix)
  const regex = /\[ZERNIO_API(?::\d+)?\]([\s\S]*?)\[\/ZERNIO_API\]/gi;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(fullText)) !== null) {
    const inner = m[1];
    const get = (key: string): string => {
      const kr = new RegExp(`^${key}:\\s*(.+)$`, 'mi');
      return kr.exec(inner)?.[1]?.trim() ?? '';
    };

    // Parse multi-line params: find "params:" then extract everything until end of block
    let params: Record<string, unknown> = {};
    try {
      const paramsMatch = inner.match(/^params:\s*(.*)/mis);
      if (paramsMatch) {
        let raw = paramsMatch[1].trim();
        // If it starts with { find the matching }
        if (raw.startsWith('{')) {
          let depth = 0;
          let end = -1;
          for (let i = 0; i < raw.length; i++) {
            if (raw[i] === '{') depth++;
            else if (raw[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
          }
          if (end >= 0) raw = raw.slice(0, end + 1);
        }
        if (raw) params = JSON.parse(raw);
      }
    } catch (e) {
      console.error('[zernio-api] Failed to parse params JSON:', (e as Error)?.message);
    }
    blocks.push({
      action: get('action').toLowerCase(),
      description: get('description'),
      params,
    });
  }
  return blocks;
}

async function processZernioApiBlocks(
  fullText: string,
  userId: string,
  authToken: string | null,
  conversationId: string | null,
): Promise<void> {
  console.log(`[zernio-api] ─── processZernioApiBlocks START ─── userId=${userId}`);
  const blocks = parseZernioApiBlocks(fullText);
  console.log(`[zernio-api] Parsed ${blocks.length} ZERNIO_API block(s)`);
  if (blocks.length === 0) return;

  const resultSummaries: string[] = [];

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    try {
      console.log(`[zernio-api] Block #${i}: action="${block.action}" desc="${block.description}" params=${JSON.stringify(block.params).slice(0, 300)}`);

      if (!ZERNIO_ALLOWED_ACTIONS.has(block.action)) {
        console.error(`[zernio-api] Block #${i}: ❌ REJECTED — action "${block.action}" not allowed`);
        resultSummaries.push(`**${block.description || block.action}**: ❌ Rejected — action "${block.action}" not allowed`);
        continue;
      }

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'X-User-ID': userId,
      };
      if (authToken) headers['Authorization'] = authToken;

      // Enforce per-platform character limits BEFORE calling Zernio. The AI
      // routinely ignores the prompt-level limits (e.g. tweets > 280 chars),
      // and Zernio rejects oversized posts. Truncate to the strictest limit
      // among the requested platforms, preserving trailing hashtags / URL.
      let truncationNotes: string[] = [];
      if (block.action === 'create_post') {
        truncationNotes = enforcePlatformContentLimits(block.params);
      }

      const proxyUrl = `${SELLER_API_BASE}/seller/zernio/proxy`;
      console.log(`[zernio-api] Block #${i}: POST ${proxyUrl}`);

      const res = await fetch(proxyUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          action: block.action,
          params: block.params,
        }),
      });

      const data = await res.json().catch(() => null);

      if (res.ok) {
        const desc = block.description || block.action;
        const jsonStr = JSON.stringify(data?.data ?? data, null, 2);
        const capped = jsonStr.length > 4000
          ? jsonStr.slice(0, 4000) + '\n... (truncated)'
          : jsonStr;
        const noteSuffix = truncationNotes.length > 0
          ? `\n\n_ℹ️ ${truncationNotes.join(' ')}_`
          : '';
        resultSummaries.push(`**${desc}**:\n\`\`\`json\n${capped}\n\`\`\`${noteSuffix}`);
        console.log(`[zernio-api] Block #${i}: ✅ Success — response length=${jsonStr.length}`);
      } else {
        // Extract detailed error message — include providerResponse if available
        let errMsg = data?.error || data?.message || `HTTP ${res.status}`;
        if (data?.providerResponse) {
          const pr = data.providerResponse;
          const detail = pr.message || pr.error || (Array.isArray(pr.errors) ? pr.errors.map((e: unknown) => typeof e === 'string' ? e : (e as Record<string, string>)?.message || JSON.stringify(e)).join('; ') : '');
          if (detail && !errMsg.includes(detail)) errMsg += ` — ${detail}`;
        }
        console.error(`[zernio-api] Block #${i}: ❌ FAILED — ${errMsg}`);
        resultSummaries.push(`**${block.description || block.action}**: ❌ Error — ${errMsg}`);
      }
    } catch (err) {
      console.error(`[zernio-api] Block #${i}: ❌ Error:`, (err as Error)?.message);
      resultSummaries.push(`**${block.description || block.action}**: ❌ Error — ${(err as Error)?.message}`);
    }
  }

  if (conversationId && resultSummaries.length > 0) {
    const resultMessage = `📱 **Zernio API Results**\n\n${resultSummaries.join('\n\n')}`;
    try {
      await pool.query(
        `INSERT INTO messages (conversation_id, role, content) VALUES ($1, 'assistant', $2)`,
        [conversationId, resultMessage],
      );
      console.log(`[zernio-api] Saved result message to conversation ${conversationId}`);
    } catch (err) {
      console.error(`[zernio-api] Failed to save result message:`, (err as Error)?.message);
    }
  }

  console.log(`[zernio-api] ─── processZernioApiBlocks END ───`);
}

// ── [UPDATE_TASK] block parser + processor ─────────────────────────────────

interface ParsedUpdateTaskBlock {
  taskId?: string;
  taskPrompt?: string;  // used for lookup
  newStatus: string;
}

function parseUpdateTaskBlocks(fullText: string): ParsedUpdateTaskBlock[] {
  const blocks: ParsedUpdateTaskBlock[] = [];
  const re = /\[UPDATE_TASK\]([\s\S]*?)\[\/UPDATE_TASK\]/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(fullText)) !== null) {
    const f = parseKeyValueBlock(m[1].trim());
    const newStatus = f.status || f.new_status || '';
    if (newStatus) {
      console.log(`[parseUpdateTaskBlocks] parsed: taskId=${f.task_id || 'N/A'} status=${newStatus}`);
      blocks.push({
        taskId: f.task_id,
        taskPrompt: f.task_prompt,
        newStatus,
      });
    } else {
      console.warn(`[parseUpdateTaskBlocks] missing status: ${m[1].slice(0, 200)}`);
    }
  }
  return blocks;
}

async function processUpdateTaskBlocks(
  fullText: string,
  userId: string,
  gatewayUrl: string | null,
  gatewayToken: string | null,
): Promise<void> {
  const blocks = parseUpdateTaskBlocks(fullText);
  for (const block of blocks) {
    try {
      // Resolve task_id from task_prompt if needed
      let taskId = block.taskId;
      if (!taskId && block.taskPrompt) {
        const { rows } = await pool.query(
          `SELECT id FROM agent_tasks WHERE user_id = $1 AND task_prompt ILIKE $2 LIMIT 1`,
          [userId, `%${block.taskPrompt.slice(0, 50)}%`],
        );
        taskId = rows[0]?.id;
        if (!taskId) {
          console.error(`[task-action] Task not found by prompt: "${block.taskPrompt?.slice(0, 50)}"`);
          continue;
        }
      }
      if (!taskId) {
        console.error('[task-action] No task_id or task_prompt for UPDATE_TASK');
        continue;
      }

      const VALID_STATUSES = ['pending', 'running', 'completed', 'cancelled'];
      if (!VALID_STATUSES.includes(block.newStatus)) {
        console.error(`[task-action] Invalid status: "${block.newStatus}"`);
        continue;
      }

      // Check current status and validate transition
      const { rows: existing } = await pool.query(
        `SELECT id, status, task_prompt, agent_id FROM agent_tasks WHERE id = $1 AND user_id = $2`,
        [taskId, userId],
      );
      if (existing.length === 0) {
        console.error(`[task-action] Task not found or not owned: ${taskId}`);
        continue;
      }

      const task = existing[0];
      const validTransitions: Record<string, string[]> = {
        pending: ['running', 'cancelled'],
        running: ['completed', 'cancelled'],
        failed: ['pending'],
        cancelled: ['pending'],
        completed: [],
      };
      const allowed = validTransitions[task.status as string] ?? [];
      if (!allowed.includes(block.newStatus)) {
        console.error(`[task-action] Invalid transition: ${task.status} → ${block.newStatus} for task ${taskId}`);
        continue;
      }

      // Update agent_tasks status
      const extraFields =
        block.newStatus === 'running' ? ', started_at = COALESCE(started_at, NOW())'
        : block.newStatus === 'completed' ? ', completed_at = NOW(), progress = 100'
        : block.newStatus === 'pending' ? ', error = NULL, result = NULL, progress = 0, started_at = NULL, completed_at = NULL'
        : block.newStatus === 'cancelled' ? ', completed_at = NOW()'
        : '';

      await pool.query(
        `UPDATE agent_tasks SET status = $1, updated_at = NOW()${extraFields}
         WHERE id = $2 AND user_id = $3`,
        [block.newStatus, taskId, userId],
      );
      console.log(`[task-action] Task ${taskId} status updated: ${task.status} → ${block.newStatus}`);

      // Sync to MC (non-blocking)
      syncAgentStatusToMC(userId, taskId, block.newStatus).catch(err =>
        console.warn('[task-action] MC sync failed on UPDATE_TASK:', err)
      );

      // If task is being started (→ running), dispatch to mawa gateway
      if (block.newStatus === 'running' && gatewayUrl) {
        dispatchTaskToGateway(taskId, task.task_prompt as string, gatewayUrl, gatewayToken).catch(err =>
          console.error('[task-action] Gateway dispatch failed:', err)
        );
      }
    } catch (err) {
      console.error('[task-action] Task update error:', err);
    }
  }
}

/**
 * Dispatch a task to the mawa gateway for execution.
 * Sends the task prompt as a chat message — the gateway treats it as a new conversation.
 */
async function dispatchTaskToGateway(
  taskId: string,
  taskPrompt: string,
  gatewayUrl: string,
  gatewayToken: string | null
): Promise<void> {
  const chatUrl = `${gatewayUrl.replace(/\/+$/, '')}/v1/chat/completions`;
  console.log(`[task-dispatch] Dispatching task ${taskId} to gateway: ${chatUrl}`);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (gatewayToken) headers['Authorization'] = `Bearer ${gatewayToken}`;

  const res = await fetch(chatUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: 'openclaw',
      messages: [
        { role: 'system', content: `You are executing an agent task (task_id: ${taskId}). Complete the task and report your result.` },
        { role: 'user', content: taskPrompt },
      ],
      stream: false,
      max_tokens: 16384,
    }),
    signal: AbortSignal.timeout(120_000), // 2 min timeout for task execution
  });

  if (res.ok) {
    const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
    const result = data?.choices?.[0]?.message?.content || '';
    console.log(`[task-dispatch] Task ${taskId} completed via gateway, result length: ${result.length}`);

    // Update agent_tasks with result
    await pool.query(
      `UPDATE agent_tasks SET status = 'completed', result = $1, completed_at = NOW(), progress = 100, updated_at = NOW()
       WHERE id = $2`,
      [result.slice(0, 50000), taskId],
    );

    // Sync completion to MC
    syncAgentStatusToMC('', taskId, 'completed').catch(() => {});
  } else {
    const errText = await res.text();
    console.error(`[task-dispatch] Task ${taskId} gateway failed: status=${res.status} body=${errText.slice(0, 500)}`);

    // Mark task as failed
    await pool.query(
      `UPDATE agent_tasks SET status = 'failed', error = $1, updated_at = NOW()
       WHERE id = $2`,
      [errText.slice(0, 2000), taskId],
    );
    syncAgentStatusToMC('', taskId, 'failed').catch(() => {});
  }
}

// ── [CAMPAIGN_PLAN] block parser + processor ───────────────────────────────

/**
 * Convert a CAMPAIGN_PLAN post entry (day="Monday", suggestedTime="10:00 AM",
 * week=1) into an absolute UTC ISO timestamp for the next occurrence,
 * starting from `baseDate` (the campaign start = next Monday at 00:00 UTC).
 * Returns null if the inputs are unparseable.
 */
function computeScheduledFor(
  baseDate: Date,
  week: number,
  day: string,
  suggestedTime: string | undefined,
): string | null {
  const dayMap: Record<string, number> = {
    monday: 0, mon: 0,
    tuesday: 1, tue: 1, tues: 1,
    wednesday: 2, wed: 2,
    thursday: 3, thu: 3, thur: 3, thurs: 3,
    friday: 4, fri: 4,
    saturday: 5, sat: 5,
    sunday: 6, sun: 6,
  };
  const dayIdx = dayMap[(day || '').toLowerCase().trim()];
  if (dayIdx === undefined) return null;
  const weekIdx = Math.max(1, Number(week) || 1) - 1;

  // Parse "10:00 AM" / "10:00" / "9:30 PM" / "22:00"
  let hours = 9;
  let minutes = 0;
  if (suggestedTime) {
    const m = suggestedTime.trim().match(/^(\d{1,2}):?(\d{2})?\s*(am|pm)?$/i);
    if (m) {
      hours = parseInt(m[1], 10);
      minutes = m[2] ? parseInt(m[2], 10) : 0;
      const meridiem = m[3]?.toLowerCase();
      if (meridiem === 'pm' && hours < 12) hours += 12;
      if (meridiem === 'am' && hours === 12) hours = 0;
    }
  }
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;

  const scheduled = new Date(baseDate.getTime());
  scheduled.setUTCDate(scheduled.getUTCDate() + weekIdx * 7 + dayIdx);
  scheduled.setUTCHours(hours, minutes, 0, 0);

  // Never schedule in the past — push to next week if needed.
  const now = new Date();
  if (scheduled.getTime() <= now.getTime() + 60_000) {
    scheduled.setUTCDate(scheduled.getUTCDate() + 7);
  }
  return scheduled.toISOString();
}

/** Compute next Monday 00:00 UTC from `from`. */
function nextMondayUtc(from: Date): Date {
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  const dow = d.getUTCDay(); // Sun=0, Mon=1
  const daysUntilMon = ((1 - dow) + 7) % 7 || 7;
  d.setUTCDate(d.getUTCDate() + daysUntilMon);
  return d;
}

interface CampaignPostEntry {
  day?: string;
  platform?: string;
  contentType?: string;
  topic?: string;
  caption?: string;
  hashtags?: string[];
  suggestedTime?: string;
  mediaUrls?: string[];
}
interface CampaignWeekEntry {
  week?: number;
  theme?: string;
  posts?: CampaignPostEntry[];
}

async function scheduleCampaignPosts(
  planData: Record<string, unknown>,
  userId: string,
  authToken: string | null,
  campaignRunId: string | null,
): Promise<{ scheduled: number; skipped: number; failed: number; details: string[] }> {
  const weeklyPlan = (planData.weeklyPlan as CampaignWeekEntry[] | undefined) ?? [];
  const summary = { scheduled: 0, skipped: 0, failed: 0, details: [] as string[] };

  if (!Array.isArray(weeklyPlan) || weeklyPlan.length === 0) {
    summary.details.push('Plan contained no `weeklyPlan` entries — nothing to schedule.');
    return summary;
  }

  // Resolve user's connected Zernio social accounts ONCE
  let socialRows: Array<{ platform: string; platform_account_id: string | null; account_name: string | null }> = [];
  try {
    const r = await queryWithRLS(
      userId,
      `SELECT platform, platform_account_id, account_name
         FROM connected_social_accounts
        WHERE user_id = $1 AND is_active = true AND platform_account_id IS NOT NULL`,
      [userId],
    );
    socialRows = r.rows;
  } catch (err) {
    console.error('[campaign-plan] Failed to fetch connected_social_accounts:', (err as Error)?.message);
    summary.details.push('❌ Could not look up your connected social accounts — nothing scheduled.');
    return summary;
  }
  const accountByPlatform = new Map<string, { id: string; name: string | null }>();
  for (const r of socialRows) {
    const key = (r.platform || '').toLowerCase();
    if (!key || !r.platform_account_id) continue;
    if (!accountByPlatform.has(key)) {
      accountByPlatform.set(key, { id: r.platform_account_id, name: r.account_name });
    }
  }

  const baseDate = nextMondayUtc(new Date());
  const proxyUrl = `${SELLER_API_BASE}/seller/zernio/proxy`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'X-User-ID': userId };
  if (authToken) headers['Authorization'] = authToken;

  for (const week of weeklyPlan) {
    const weekNum = Number(week?.week) || 1;
    const posts = Array.isArray(week?.posts) ? week!.posts! : [];
    for (const post of posts) {
      const platform = (post.platform || '').toLowerCase().trim();
      if (!platform) { summary.skipped++; continue; }

      const acct = accountByPlatform.get(platform);
      if (!acct) {
        summary.skipped++;
        summary.details.push(`⏭️ Skipped W${weekNum} ${post.day} — no connected ${platform} account.`);
        continue;
      }

      const scheduledFor = computeScheduledFor(baseDate, weekNum, post.day || '', post.suggestedTime);
      if (!scheduledFor) {
        summary.skipped++;
        summary.details.push(`⏭️ Skipped W${weekNum} ${post.day} (${platform}) — unparseable day/time.`);
        continue;
      }

      const captionParts = [post.caption || post.topic || ''];
      if (Array.isArray(post.hashtags) && post.hashtags.length > 0) {
        captionParts.push(post.hashtags.map(h => h.startsWith('#') ? h : `#${h}`).join(' '));
      }
      let content = captionParts.filter(Boolean).join('\n\n').trim();
      if (!content) {
        summary.skipped++;
        summary.details.push(`⏭️ Skipped W${weekNum} ${post.day} (${platform}) — empty caption.`);
        continue;
      }

      // Enforce per-platform character limit (Zernio rejects oversized posts).
      const truncated = truncateForPlatform(content, platform);
      if (truncated.truncated) {
        content = truncated.text;
        console.log(`[campaign-plan] Truncated W${weekNum} ${post.day} (${platform}) caption to fit limit`);
      }

      try {
        const res = await fetch(proxyUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            action: 'create_post',
            params: {
              platforms: [{ platform, accountId: acct.id }],
              content,
              scheduledFor,
              ...(Array.isArray(post.mediaUrls) && post.mediaUrls.length > 0 ? { mediaUrls: post.mediaUrls } : {}),
              ...(campaignRunId ? { externalRef: `campaign:${campaignRunId}:w${weekNum}:${post.day}` } : {}),
            },
          }),
        });
        if (res.ok) {
          summary.scheduled++;
          summary.details.push(`✅ W${weekNum} ${post.day} (${platform}) → ${new Date(scheduledFor).toUTCString()}`);
        } else {
          summary.failed++;
          const errText = (await res.text()).slice(0, 200);
          summary.details.push(`❌ W${weekNum} ${post.day} (${platform}) — HTTP ${res.status}: ${errText}`);
        }
      } catch (err) {
        summary.failed++;
        summary.details.push(`❌ W${weekNum} ${post.day} (${platform}) — ${(err as Error)?.message ?? 'network error'}`);
      }
    }
  }

  return summary;
}

async function processCampaignPlanBlocks(
  fullText: string,
  userId: string,
  authToken: string | null,
  conversationId: string | null,
): Promise<void> {
  console.log(`[campaign-plan] ─── processCampaignPlanBlocks START ─── userId=${userId}`);
  const regex = /\[CAMPAIGN_PLAN\]([\s\S]*?)\[\/CAMPAIGN_PLAN\]/gi;
  const blocks: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = regex.exec(fullText)) !== null) {
    blocks.push(m[1]);
  }
  if (blocks.length === 0) {
    console.log(`[campaign-plan] ─── processCampaignPlanBlocks END (no blocks) ───`);
    return;
  }

  for (let i = 0; i < blocks.length; i++) {
    const inner = blocks[i];
    console.log(`[campaign-plan] Block #${i}: parsing...`);

    // Extract simple key: value fields
    const get = (key: string): string => {
      const kr = new RegExp(`^${key}:\\s*(.+)$`, 'mi');
      return kr.exec(inner)?.[1]?.trim() ?? '';
    };

    // Extract the JSON object for weekly_plan (brace-depth tracking)
    let weeklyPlanJson = '[]';
    const wpStart = inner.indexOf('"weeklyPlan"');
    const wpStart2 = wpStart === -1 ? inner.indexOf('"weekly_plan"') : wpStart;
    if (wpStart2 !== -1) {
      // Find the opening bracket after the key
      const arrStart = inner.indexOf('[', wpStart2);
      if (arrStart !== -1) {
        let depth = 0;
        let arrEnd = arrStart;
        for (let j = arrStart; j < inner.length; j++) {
          if (inner[j] === '[') depth++;
          else if (inner[j] === ']') {
            depth--;
            if (depth === 0) { arrEnd = j + 1; break; }
          }
        }
        weeklyPlanJson = inner.slice(arrStart, arrEnd);
      }
    }

    // Also try to extract the whole JSON blob if the AI outputs pure JSON
    let planData: Record<string, unknown> | null = null;
    // Try parsing the whole inner content as JSON first
    const jsonMatch = inner.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        planData = JSON.parse(jsonMatch[0]);
      } catch { /* fallback to field extraction */ }
    }

    if (!planData) {
      // Fallback: parse individual fields
      let weeklyPlan: unknown[] = [];
      try { weeklyPlan = JSON.parse(weeklyPlanJson); } catch { /* empty */ }

      const platformsStr = get('platforms');
      const platforms = platformsStr
        ? platformsStr.split(',').map((s: string) => s.trim().replace(/["\[\]]/g, ''))
        : [];

      const pillarsStr = get('content_pillars') || get('contentPillars');
      const pillars = pillarsStr
        ? pillarsStr.split(',').map((s: string) => s.trim().replace(/["\[\]]/g, ''))
        : [];

      const kpisStr = get('kpis');
      const kpis = kpisStr
        ? kpisStr.split(',').map((s: string) => s.trim().replace(/["\[\]]/g, ''))
        : [];

      planData = {
        type: 'campaign_plan',
        campaignName: get('campaign_name') || get('name') || 'Marketing Campaign',
        brandName: get('brand_name') || get('brand') || '',
        goal: get('goal') || '',
        targetAudience: get('target_audience') || get('targetAudience') || '',
        platforms,
        duration: get('duration') || '',
        contentPillars: pillars,
        weeklyPlan,
        kpis,
      };
    }

    // Ensure the type field
    planData.type = 'campaign_plan';
    if (!planData.campaignName && planData.campaign_name) {
      planData.campaignName = planData.campaign_name;
    }
    if (!planData.brandName && planData.brand_name) {
      planData.brandName = planData.brand_name;
    }
    if (!planData.targetAudience && planData.target_audience) {
      planData.targetAudience = planData.target_audience;
    }
    if (!planData.contentPillars && planData.content_pillars) {
      planData.contentPillars = planData.content_pillars;
    }
    if (!planData.weeklyPlan && planData.weekly_plan) {
      planData.weeklyPlan = planData.weekly_plan;
    }

    console.log(`[campaign-plan] Block #${i}: creating campaign_run with run_type=campaign_plan`);

    try {
      const CONFIG_API_URL = (process.env.NEXT_PUBLIC_CONFIG_API_URL || process.env.CONFIG_API_URL || '').replace(/\/+$/, '');
      const INTERNAL_SECRET = process.env.INTERNAL_API_SECRET || '';

      // mawa-api mounts the seller router under /api/v1
      const campaignsUrl = CONFIG_API_URL.endsWith('/api/v1')
        ? `${CONFIG_API_URL}/seller/campaigns`
        : `${CONFIG_API_URL}/api/v1/seller/campaigns`;

      const res = await fetch(campaignsUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${INTERNAL_SECRET}`,
          'X-User-ID': userId,
        },
        body: JSON.stringify({
          runType: 'campaign_plan',
          status: 'completed',
          summary: planData,
        }),
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        console.error(`[campaign-plan] Block #${i}: API error ${res.status}: ${errText.slice(0, 500)}`);
        if (conversationId) {
          await pool.query(
            `INSERT INTO messages (conversation_id, role, content) VALUES ($1, 'assistant', $2)`,
            [conversationId, `📅 **Campaign "${planData.campaignName ?? 'Marketing Campaign'}"**\n\n❌ Could not save the campaign — ${res.status}. The plan was not stored and no posts were scheduled.`],
          ).catch(() => {});
        }
      } else {
        const result = await res.json().catch(() => null);
        const campaignRunId = result?.data?.id ?? null;
        console.log(`[campaign-plan] Block #${i}: ✅ Created campaign_run id=${campaignRunId}`);

        // Now iterate the weekly plan and schedule each post via Zernio.
        const sched = await scheduleCampaignPosts(planData, userId, authToken, campaignRunId);
        console.log(`[campaign-plan] Block #${i}: scheduling summary scheduled=${sched.scheduled} skipped=${sched.skipped} failed=${sched.failed}`);

        if (conversationId) {
          const header = `📅 **Campaign "${planData.campaignName ?? 'Marketing Campaign'}" saved.**`;
          const tally = `• Scheduled: **${sched.scheduled}**\n• Skipped: **${sched.skipped}**\n• Failed: **${sched.failed}**`;
          const detailLines = sched.details.slice(0, 25).join('\n');
          const moreNote = sched.details.length > 25 ? `\n\n_(\u2026 ${sched.details.length - 25} more entries)_` : '';
          const tail = sched.scheduled === 0
            ? `\n\n⚠️ No posts were actually scheduled. Connect a social account at /seller/social-accounts to enable auto-posting, then re-create the campaign.`
            : `\n\nView at /seller/campaigns. Scheduled posts will be auto-published by Zernio at their scheduled times.`;
          const resultMessage = `${header}\n\n${tally}${detailLines ? `\n\n\`\`\`\n${detailLines}\n\`\`\`` : ''}${moreNote}${tail}`;
          try {
            await pool.query(
              `INSERT INTO messages (conversation_id, role, content) VALUES ($1, 'assistant', $2)`,
              [conversationId, resultMessage],
            );
          } catch (err) {
            console.error('[campaign-plan] Failed to save status message:', (err as Error)?.message);
          }
        }
      }
    } catch (err) {
      console.error(`[campaign-plan] Block #${i}: ❌ Error:`, err);
    }
  }

  console.log(`[campaign-plan] ─── processCampaignPlanBlocks END ───`);
}

// ── Inbox draft / send action blocks (mawadao-inbox skill) ─────────────────

function parseBlocks(fullText: string, tag: string): string[] {
  const re = new RegExp(`\\[${tag}\\]([\\s\\S]*?)\\[/${tag}\\]`, 'g');
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(fullText)) !== null) out.push(m[1]);
  return out;
}

function parseBlockFields(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = body.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const m = /^\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(\|)?\s*(.*)$/.exec(line);
    if (!m) { i++; continue; }
    const key = m[1];
    const isMultiline = m[2] === '|';
    const inline = m[3];
    if (isMultiline) {
      const collected: string[] = [];
      let j = i + 1;
      const baseIndent = (lines[j]?.match(/^(\s*)/)?.[1].length) ?? 0;
      while (j < lines.length) {
        const next = lines[j];
        if (next.trim() === '') { collected.push(''); j++; continue; }
        const indent = (next.match(/^(\s*)/)?.[1].length) ?? 0;
        if (indent < baseIndent || /^\s*[a-zA-Z_][a-zA-Z0-9_]*\s*:/.test(next)) break;
        collected.push(next.slice(baseIndent));
        j++;
      }
      out[key] = collected.join('\n').trim();
      i = j;
    } else {
      out[key] = inline.trim();
      i++;
    }
  }
  return out;
}

async function processInboxDraftBlocks(fullText: string, userId: string): Promise<void> {
  const blocks = parseBlocks(fullText, 'INBOX_DRAFT');
  if (blocks.length === 0) return;
  console.log(`[inbox-draft] Processing ${blocks.length} block(s) for user ${userId}`);
  for (const body of blocks) {
    try {
      const f = parseBlockFields(body);
      if (!f.account_id || !f.message_id || !f.subject || !f.body) {
        console.warn('[inbox-draft] Missing required fields', Object.keys(f));
        continue;
      }
      const account = await getInboxAccount(userId, f.account_id);
      if (!account) { console.warn(`[inbox-draft] Account ${f.account_id} not found for user ${userId}`); continue; }
      await createDraft({
        userId,
        accountId: f.account_id,
        sourceMessageId: f.message_id,
        sourceThreadId: f.thread_id || null,
        toAddr: f.to || account.account_email,
        subject: f.subject,
        bodyText: f.body,
        model: 'openclaw',
        metadata: { source: 'chat', tone: f.tone || null, cc: f.cc || null },
      });
      console.log(`[inbox-draft] Created draft for message ${f.message_id}`);
    } catch (err) {
      console.error('[inbox-draft] Failed:', (err as Error)?.message);
    }
  }
}

async function processInboxSendDraftBlocks(fullText: string, userId: string): Promise<void> {
  const blocks = parseBlocks(fullText, 'INBOX_SEND_DRAFT');
  if (blocks.length === 0) return;
  console.log(`[inbox-send] Processing ${blocks.length} block(s) for user ${userId}`);
  for (const body of blocks) {
    try {
      const f = parseBlockFields(body);
      if (!f.draft_id) { console.warn('[inbox-send] Missing draft_id'); continue; }
      const draft = await getDraft(userId, f.draft_id);
      if (!draft) { console.warn(`[inbox-send] Draft ${f.draft_id} not found`); continue; }
      if (draft.status !== 'pending') { console.warn(`[inbox-send] Draft ${f.draft_id} status=${draft.status}, skipping`); continue; }
      const account = await getInboxAccount(userId, draft.account_id);
      if (!account) { console.warn(`[inbox-send] Account ${draft.account_id} not found`); continue; }
      const policy = (account.policy ?? {}) as { can_send?: boolean };
      if (!policy.can_send) {
        console.warn(`[inbox-send] Account policy disallows sending; draft ${f.draft_id} requires manual approval`);
        continue;
      }
      if (account.provider !== 'gmail') {
        console.warn(`[inbox-send] Provider ${account.provider} not yet supported via chat send`);
        continue;
      }
      await sendGmailReply(userId, draft.account_id, {
        fromAddress: account.account_email,
        to: draft.to_addr,
        subject: draft.subject,
        bodyText: draft.body_text,
        threadId: draft.source_thread_id ?? undefined,
        inReplyTo: draft.source_message_id ?? undefined,
      });
      await markDraftSent(userId, f.draft_id);
      console.log(`[inbox-send] Sent draft ${f.draft_id}`);
    } catch (err) {
      console.error('[inbox-send] Failed:', (err as Error)?.message);
    }
  }
}

// ── Unified action block processor ─────────────────────────────────────────

interface ActionBlockContext {
  userId: string;
  authToken: string | null;
  gatewayUrl: string | null;
  gatewayToken: string | null;
  conversationId: string | null;
}

async function processAllActionBlocks(fullText: string, ctx: ActionBlockContext): Promise<void> {
  console.log(`[action-blocks] ─── processAllActionBlocks START ─── userId=${ctx.userId} textLen=${fullText.length}`);

  // Always persist any detected media images to user_media library.
  // Await this BEFORE seller/publish blocks so unlinked-media fallback can find them.
  let detectedImages: { url: string; fileName: string }[] = [];
  try {
    detectedImages = await persistDetectedMedia(fullText, ctx.userId);
  } catch (err) {
    console.error('[action-blocks] persistDetectedMedia failed:', err);
  }

  // If images were found (e.g. via GCS fallback) but not in the text, inject markdown
  // into the saved DB message so the frontend renders them.
  if (detectedImages.length > 0 && ctx.conversationId) {
    const missingFromText = detectedImages.filter(img =>
      !fullText.includes(img.url) && !fullText.includes(decodeURIComponent(img.url))
    );
    if (missingFromText.length > 0) {
      const imageMarkdown = '\n\n' + missingFromText.map(img =>
        `![${img.fileName}](${img.url})`
      ).join('\n');
      console.log(`[action-blocks] Injecting ${missingFromText.length} image(s) into saved message`);
      try {
        // Update the latest assistant message in this conversation to include images
        await pool.query(
          `UPDATE messages SET content = content || $1
           WHERE id = (
             SELECT id FROM messages
             WHERE conversation_id = $2 AND role = 'assistant'
             ORDER BY created_at DESC LIMIT 1
           )`,
          [imageMarkdown, ctx.conversationId]
        );
      } catch (err) {
        console.warn('[action-blocks] Failed to inject image markdown into message:', (err as Error)?.message);
      }
    }
  }

  // Log a snippet of the raw text for debugging (first 500 chars + last 500 chars)
  const head = fullText.slice(0, 500).replace(/\n/g, '\\n');
  const tail = fullText.length > 1000 ? fullText.slice(-500).replace(/\n/g, '\\n') : '';
  console.log(`[action-blocks] fullText head: ${head}`);
  if (tail) console.log(`[action-blocks] fullText tail: ${tail}`);

  // Check which block tags are present
  const tags = ['CREATE_PRODUCT', 'UPDATE_PRODUCT', 'PUBLISH_PRODUCT', 'CREATE_TASK', 'UPDATE_TASK', 'DELIVER', 'SCHEDULE_DELIVERY', 'SELLER_SQL', 'ZERNIO_API', 'CAMPAIGN_PLAN', 'INBOX_DRAFT', 'INBOX_SEND_DRAFT'];
  const found = tags.filter(t => fullText.includes(`[${t}]`));
  const closed = tags.filter(t => fullText.includes(`[/${t}]`));
  console.log(`[action-blocks] Tags found (open): [${found.join(', ')}]  Tags found (close): [${closed.join(', ')}]`);

  if (found.length === 0) {
    console.log(`[action-blocks] No action blocks detected in AI response. AI did NOT output any structured blocks.`);
    return;
  }

  const promises: Promise<void>[] = [];

  if (fullText.includes('[DELIVER]') || fullText.includes('[SCHEDULE_DELIVERY]')) {
    promises.push(processDeliveryBlocks(fullText, ctx.userId));
  }
  if (fullText.includes('[CREATE_PRODUCT]')) {
    console.log(`[action-blocks] → Dispatching processSellerBlocks (CREATE_PRODUCT)`);
    promises.push(processSellerBlocks(fullText, ctx.userId, ctx.authToken));
  }
  if (fullText.includes('[UPDATE_PRODUCT]')) {
    console.log(`[action-blocks] → Dispatching processUpdateProductBlocks (UPDATE_PRODUCT)`);
    promises.push(processUpdateProductBlocks(fullText, ctx.userId, ctx.authToken));
  }
  if (fullText.includes('[PUBLISH_PRODUCT]')) {
    console.log(`[action-blocks] → Dispatching processPublishBlocks (PUBLISH_PRODUCT)`);
    promises.push(processPublishBlocks(fullText, ctx.userId, ctx.authToken, ctx.conversationId));
  }
  if (fullText.includes('[CREATE_TASK]')) {
    console.log(`[action-blocks] → Dispatching processTaskBlocks (CREATE_TASK)`);
    promises.push(processTaskBlocks(fullText, ctx.userId));
  }
  if (fullText.includes('[UPDATE_TASK]')) {
    console.log(`[action-blocks] → Dispatching processUpdateTaskBlocks (UPDATE_TASK)`);
    promises.push(processUpdateTaskBlocks(fullText, ctx.userId, ctx.gatewayUrl, ctx.gatewayToken));
  }
  if (fullText.includes('[SELLER_SQL]')) {
    console.log(`[action-blocks] → Dispatching processSellerSqlBlocks (SELLER_SQL)`);
    promises.push(processSellerSqlBlocks(fullText, ctx.userId, ctx.conversationId));
  }
  if (/\[ZERNIO_API(?::\d+)?\]/i.test(fullText)) {
    console.log(`[action-blocks] → Dispatching processZernioApiBlocks (ZERNIO_API)`);
    promises.push(processZernioApiBlocks(fullText, ctx.userId, ctx.authToken, ctx.conversationId));
  }
  if (fullText.includes('[CAMPAIGN_PLAN]')) {
    console.log(`[action-blocks] → Dispatching processCampaignPlanBlocks (CAMPAIGN_PLAN)`);
    promises.push(processCampaignPlanBlocks(fullText, ctx.userId, ctx.authToken, ctx.conversationId));
  }
  if (fullText.includes('[INBOX_DRAFT]')) {
    console.log(`[action-blocks] → Dispatching processInboxDraftBlocks (INBOX_DRAFT)`);
    promises.push(processInboxDraftBlocks(fullText, ctx.userId));
  }
  if (fullText.includes('[INBOX_SEND_DRAFT]')) {
    console.log(`[action-blocks] → Dispatching processInboxSendDraftBlocks (INBOX_SEND_DRAFT)`);
    promises.push(processInboxSendDraftBlocks(fullText, ctx.userId));
  }

  console.log(`[action-blocks] Waiting for ${promises.length} processor(s)...`);
  const results = await Promise.allSettled(promises);
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      console.error(`[action-blocks] Processor #${i} REJECTED:`, r.reason);
    } else {
      console.log(`[action-blocks] Processor #${i} fulfilled`);
    }
  });
  console.log(`[action-blocks] ─── processAllActionBlocks END ───`);
}

/**
 * Convert a UIMessage (AI SDK v6) to OpenAI-compatible message.
 * Images become image_url parts; other files become text mentions.
 */
/**
 * Attempt to decode a data-URL into a UTF-8 string.
 * Returns the decoded text on success, or an empty string if the URL is
 * not a data-URL or the content is not valid UTF-8 text.
 * Caps output at ~200 KB to avoid blowing up context windows.
 */
function decodeDataUrlToText(dataUrl: string, maxBytes = 200_000): string {
  if (!dataUrl.startsWith('data:')) return '';
  try {
    const commaIdx = dataUrl.indexOf(',');
    if (commaIdx === -1) return '';
    const meta = dataUrl.slice(0, commaIdx); // e.g. "data:text/plain;base64"
    const raw = dataUrl.slice(commaIdx + 1);
    const buf = meta.includes(';base64')
      ? Buffer.from(raw, 'base64')
      : Buffer.from(decodeURIComponent(raw), 'utf-8');
    if (buf.length > maxBytes) return buf.slice(0, maxBytes).toString('utf-8') + '\n[…truncated]';
    return buf.toString('utf-8');
  } catch {
    return '';
  }
}

/** Media types (and extensions) that are safe to decode as text. */
function isTextBasedMedia(mediaType: string, filename?: string): boolean {
  if (mediaType.startsWith('text/')) return true;
  if (['application/json', 'application/xml', 'application/javascript',
       'application/typescript', 'application/x-yaml', 'application/yaml',
       'application/x-sh', 'application/sql', 'application/graphql',
       'application/x-httpd-php', 'application/xhtml+xml',
       'application/csv'].includes(mediaType)) return true;
  if (filename && /\.(md|txt|csv|tsv|json|jsonl|js|jsx|ts|tsx|py|rb|go|rs|java|c|cpp|h|hpp|cs|swift|kt|scala|r|sh|bash|zsh|fish|ps1|bat|cmd|sql|html|htm|css|scss|sass|less|xml|yaml|yml|toml|ini|cfg|conf|env|log|diff|patch|gitignore|dockerfile|makefile|cmake|gradle|sbt|pom|gemfile|gemspec|rakefile|pipfile|requirements|lock|editorconfig)$/i.test(filename)) return true;
  return false;
}

function uiMessageToOpenAI(msg: UIMessage): OpenAIMessage {
  console.log(`[IMG-DEBUG][uiMessageToOpenAI] role=${msg.role} parts=${msg.parts?.length ?? 0} contentType=${typeof msg.content} contentLen=${typeof msg.content === 'string' ? msg.content.length : 'N/A'}`);
  if (msg.parts) {
    msg.parts.forEach((p, i) => {
      if (p.type === 'file') {
        const fp = p as { type: 'file'; url: string; mediaType: string; filename?: string };
        console.log(`[IMG-DEBUG][uiMessageToOpenAI]   part[${i}] type=file mediaType=${fp.mediaType} filename=${fp.filename} urlPrefix=${fp.url?.substring(0, 40)}... urlLen=${fp.url?.length}`);
      } else {
        console.log(`[IMG-DEBUG][uiMessageToOpenAI]   part[${i}] type=${p.type}`);
      }
    });
  }

  if (!msg.parts || msg.parts.length === 0) {
    console.log(`[IMG-DEBUG][uiMessageToOpenAI] => no parts, returning plain content`);
    return { role: msg.role, content: typeof msg.content === "string" ? msg.content : "" };
  }

  const fileParts = msg.parts.filter(
    (p): p is { type: "file"; url: string; mediaType: string; filename?: string } =>
      p.type === "file"
  );

  if (fileParts.length === 0) {
    console.log(`[IMG-DEBUG][uiMessageToOpenAI] => no file parts, text-only`);
    const text = msg.parts
      .filter((p) => p.type === "text")
      .map((p) => (p as { type: "text"; text: string }).text)
      .join("");
    return { role: msg.role, content: text };
  }

  console.log(`[IMG-DEBUG][uiMessageToOpenAI] => ${fileParts.length} file part(s) found, building multi-part content`);

  // Mixed: text + files
  const content: OpenAIContentPart[] = [];
  for (const part of msg.parts) {
    if (part.type === "text") {
      content.push({ type: "text", text: (part as { type: "text"; text: string }).text });
    } else if (part.type === "file") {
      const fp = part as { type: "file"; url: string; mediaType: string; filename?: string };
      if (fp.mediaType?.startsWith("image/")) {
        // Images: pass data URL directly — supported by OpenAI & compatible APIs
        console.log(`[IMG-DEBUG][uiMessageToOpenAI]   => adding image_url part: mediaType=${fp.mediaType} urlLen=${fp.url?.length}`);
        content.push({ type: "image_url", image_url: { url: fp.url } });
      } else if (isTextBasedMedia(fp.mediaType, fp.filename)) {
        // Text-based files: decode and include actual content
        const decoded = decodeDataUrlToText(fp.url);
        if (decoded.trim()) {
          content.push({
            type: "text",
            text: `--- File: ${fp.filename || "file"} (${fp.mediaType}) ---\n${decoded}\n--- End of file ---`,
          });
        } else {
          content.push({
            type: "text",
            text: `[Attached: ${fp.filename || "file"} (${fp.mediaType}) — could not decode content]`,
          });
        }
      } else {
        // Binary files (pdf, docx, etc.) — try to decode in case it's actually text
        const decoded = decodeDataUrlToText(fp.url);
        if (decoded.trim() && !decoded.includes('\ufffd')) {
          content.push({
            type: "text",
            text: `--- File: ${fp.filename || "file"} (${fp.mediaType}) ---\n${decoded}\n--- End of file ---`,
          });
        } else {
          content.push({
            type: "text",
            text: `[Attached binary file: ${fp.filename || "file"} (${fp.mediaType}) — content cannot be displayed as text]`,
          });
        }
      }
    }
  }
  console.log(`[IMG-DEBUG][uiMessageToOpenAI] => RESULT: role=${msg.role} contentParts=${content.length} types=[${content.map(c => c.type).join(',')}]`);
  return { role: msg.role, content };
}

/**
 * Convert OpenAI-format messages to Anthropic messages API body.
 * System messages are extracted to the top-level `system` param.
 */
function buildAnthropicBody(messages: OpenAIMessage[], model: string): Record<string, unknown> {
  const systemParts: string[] = [];
  const conversation: Array<{ role: string; content: string | Array<Record<string, unknown>> }> = [];

  for (const m of messages) {
    if (m.role === 'system') {
      const text = typeof m.content === 'string'
        ? m.content
        : (m.content as Array<{ type: string; text?: string }>)
            .filter(p => p.type === 'text').map(p => p.text ?? '').join('');
      if (text) systemParts.push(text);
    } else if (typeof m.content === 'string') {
      conversation.push({ role: m.role, content: m.content });
    } else {
      // Multi-part content — may contain text + image_url parts
      const parts = m.content as Array<Record<string, unknown>>;
      const hasImages = parts.some(p => p.type === 'image_url');
      if (!hasImages) {
        // Text-only: join into a single string
        const text = parts.filter(p => p.type === 'text').map(p => String(p.text ?? '')).join('');
        conversation.push({ role: m.role, content: text });
      } else {
        // Convert image_url parts to Anthropic image blocks
        const anthropicParts: Array<Record<string, unknown>> = [];
        for (const part of parts) {
          if (part.type === 'text') {
            anthropicParts.push({ type: 'text', text: String(part.text ?? '') });
          } else if (part.type === 'image_url') {
            const imgUrl = String((part.image_url as Record<string, unknown>)?.url ?? '');
            if (imgUrl.startsWith('data:')) {
              const match = imgUrl.match(/^data:([\w/+.-]+);base64,(.+)$/);
              if (match) {
                anthropicParts.push({
                  type: 'image',
                  source: { type: 'base64', media_type: match[1], data: match[2] },
                });
              }
            } else {
              anthropicParts.push({
                type: 'image',
                source: { type: 'url', url: imgUrl },
              });
            }
          }
        }
        conversation.push({ role: m.role, content: anthropicParts });
      }
    }
  }

  return {
    model,
    ...(systemParts.length > 0 ? { system: systemParts.join('\n\n') } : {}),
    messages: conversation,
    max_tokens: 16384,
    stream: true,
  };
}

/**
 * Proxy chat completions to mawa gateway (or directly to an AI provider).
 * Accepts AI SDK v6 useChat format { messages: UIMessage[], model, conversationId, skills }.
 * Converts UIMessages to OpenAI-compatible format, persists to DB, streams response.
 *
 * Provider routing (in priority order):
 *   1. GATEWAY_URL → mawa gateway  (full agent pipeline)
 *   2. OPENAI_API_KEY  → direct OpenAI  (OpenAI-compatible SSE)
 *   3. ANTHROPIC_API_KEY → direct Anthropic  (Anthropic SSE format)
 */

// GET is intentionally exported so Next.js registers this file as a route handler.
export async function GET() {
  return NextResponse.json({ ok: true, message: 'ai-chat route is available; use POST to send messages.' });
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      Allow: 'GET, POST, OPTIONS',
    },
  });
}

export async function POST(request: NextRequest) {
  // In cloud mode, authenticate via httpOnly cookie (browser) or Authorization header (API).
  // In local mode, require the Authorization header.
  let authHeader = request.headers.get("authorization");
  let authenticatedUserId: string | undefined;

  // Track whether the proxy path already saved the user message to DB
  // so the direct fallback path can skip the duplicate save.
  let proxyUserMsgSaved = false;

  if (CLOUD_MODE) {
    const user = await authenticateRequest(request);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    authenticatedUserId = user.userId;

    // Ensure authHeader is available for downstream use (proxy, title generation).
    // In cloud mode browsers rely on cookie auth, so the header may be absent.
    if (!authHeader) {
      const cookieToken = request.cookies.get('auth-token')?.value;
      if (cookieToken) authHeader = `Bearer ${cookieToken}`;
    }

    // Only proxy if the tenant actually has a dedicated backend URL
    if (user.subdomain) {
      const tenant = await resolveTenantBackend(user.subdomain);
      if (tenant?.backendUrl) {
        try {
          // Parse the request body to convert UI messages to OpenAI format
          const clonedRequest = request.clone();
          const proxyRawBody = await clonedRequest.json() as Record<string, unknown>;
          // ── IMG-DEBUG: log raw incoming messages ──
          const rawMsgs = (proxyRawBody.messages ?? []) as UIMessage[];
          console.log(`[IMG-DEBUG][proxy] incoming request: ${rawMsgs.length} message(s), bodyKeys=[${Object.keys(proxyRawBody).join(',')}]`);
          rawMsgs.forEach((m, i) => {
            console.log(`[IMG-DEBUG][proxy]   msg[${i}] role=${m.role} parts=${m.parts?.length ?? 0} contentLen=${typeof m.content === 'string' ? m.content.length : 'N/A'}`);
            if (m.parts) {
              m.parts.forEach((p, j) => {
                if (p.type === 'file') {
                  const fp = p as { type: 'file'; url: string; mediaType: string; filename?: string };
                  console.log(`[IMG-DEBUG][proxy]     part[${j}] FILE mediaType=${fp.mediaType} filename=${fp.filename} urlLen=${fp.url?.length} urlStart=${fp.url?.substring(0, 50)}`);
                } else {
                  console.log(`[IMG-DEBUG][proxy]     part[${j}] type=${p.type}`);
                }
              });
            }
          });

          const proxyMessages = rawMsgs.map(uiMessageToOpenAI);
          const proxyModel = (proxyRawBody.model as string | undefined) ?? 'openclaw';
          const proxyConversationId = proxyRawBody.conversationId as string | undefined;
          const proxyAgentId = proxyRawBody.agentId as string | undefined;

          // Inject agent identity as a system message when an agent is selected
          let finalProxyMessages = proxyMessages;
          if (proxyAgentId) {
            try {
              const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(proxyAgentId);
              const { rows: agentRows } = await pool.query(
                isUuid
                  ? `SELECT system_prompt, soul_config, skills_config, name, description, capabilities FROM marketplace_agents WHERE id = $1`
                  : `SELECT system_prompt, soul_config, skills_config, name, description, capabilities FROM marketplace_agents WHERE slug = $1`,
                [proxyAgentId]
              );
              if (agentRows.length > 0) {
                const agent = agentRows[0];
                const parts: string[] = [];
                if (agent.system_prompt) parts.push(agent.system_prompt);
                if (agent.soul_config) {
                  const soul = typeof agent.soul_config === 'string' ? JSON.parse(agent.soul_config) : agent.soul_config;
                  if (soul.identity) parts.push(`Identity: ${soul.identity}`);
                  if (soul.purpose) parts.push(`Purpose: ${soul.purpose}`);
                  if (soul.communication_style) parts.push(`Communication style: ${soul.communication_style}`);
                  if (Array.isArray(soul.principles) && soul.principles.length > 0) {
                    parts.push(`Core principles: ${soul.principles.join('; ')}`);
                  }
                }
                if (parts.length === 0) {
                  if (agent.description) parts.push(agent.description);
                  if (Array.isArray(agent.capabilities) && agent.capabilities.length > 0) {
                    parts.push(`Capabilities: ${agent.capabilities.join(', ')}`);
                  }
                }
                if (agent.skills_config) {
                  const sk = typeof agent.skills_config === 'string' ? JSON.parse(agent.skills_config) : agent.skills_config;
                  if (Array.isArray(sk) && sk.length > 0) {
                    const skillNames = sk.map((s: { name?: string }) => s.name).filter(Boolean).join(', ');
                    if (skillNames) parts.push(`Available skills: ${skillNames}`);
                  }
                }
                if (parts.length > 0) {
                  const agentSystemPrompt = `You are ${agent.name}. ${parts.join('\n')}`;
                  finalProxyMessages = [{ role: 'system', content: agentSystemPrompt }, ...proxyMessages];
                }
              }
            } catch (agentErr) {
              console.warn('[chat] Failed to inject agent identity for proxy:', agentErr);
            }
          }

          // ── Save the user message to DB BEFORE proxying ──────────────
          const proxyRawMessages = (proxyRawBody.messages ?? []) as UIMessage[];
          if (proxyConversationId && proxyRawMessages.length > 0) {
            const lastProxyMsg = proxyRawMessages[proxyRawMessages.length - 1];
            if (lastProxyMsg.role === 'user') {
              const userText = extractText(lastProxyMsg);
              const previewTitle = userText.slice(0, 60) + (userText.length > 60 ? '…' : '');
              try {
                await pool.query(
                  `INSERT INTO messages (conversation_id, role, content) VALUES ($1, $2, $3)`,
                  [proxyConversationId, 'user', userText]
                );
                await pool.query(
                  `UPDATE conversations
                     SET title = CASE
                       WHEN title IS NULL OR title = '' OR title = 'New Chat' THEN $1
                       ELSE title
                     END,
                         updated_at = NOW()
                   WHERE id = $2`,
                  [previewTitle || 'New Chat', proxyConversationId]
                );
                proxyUserMsgSaved = true;
                console.log('[chat][proxy] saved user message to DB for conv:', proxyConversationId);
                // Mirror to Mission Control so every conversation appears
                // on the user's MC board, not just CREATE_TASK action blocks.
                if (authenticatedUserId) {
                  startMCTaskForConversation(authenticatedUserId, proxyConversationId, userText)
                    .catch(err => console.warn('[chat][proxy] MC conversation mirror failed:', err));
                }
              } catch (dbErr) {
                console.error('[chat][proxy] failed to save user message:', dbErr);
              }
            }
          } else {
            console.warn('[chat][proxy] no conversationId or no messages — user msg NOT saved. convId:', proxyConversationId, 'msgCount:', proxyRawMessages.length);
          }

          // ── Web search injection for CLOUD_MODE proxy path ──────────────
          // When the user has web_search skill active, inject live search
          // results into context so the model has current web data available.
          const proxySkills = proxyRawBody.skills as string[] | undefined;
          let proxyHasWebSearch = Array.isArray(proxySkills) && hasSkill(proxySkills, 'web_search', 'web-search', 'websearch');

          // If skills weren't sent in payload, check user's active skills from DB
          if (!proxyHasWebSearch && authenticatedUserId) {
            try {
              const { rows: wsRows } = await pool.query(
                `SELECT 1 FROM user_skills WHERE user_id = $1 AND skill_id = 'web_search' AND is_active = TRUE LIMIT 1`,
                [authenticatedUserId],
              );
              proxyHasWebSearch = wsRows.length > 0;
            } catch { /* ignore */ }
          }

          const proxyLastUserText = proxyHasWebSearch ? (() => {
            for (let i = finalProxyMessages.length - 1; i >= 0; i--) {
              const m = finalProxyMessages[i];
              if (m.role === 'user') {
                return typeof m.content === 'string'
                  ? m.content
                  : Array.isArray(m.content)
                    ? (m.content as Array<{ type: string; text?: string }>).filter(p => p.type === 'text').map(p => p.text ?? '').join('')
                    : '';
              }
            }
            return '';
          })() : '';

          if (proxyLastUserText) {
            const isSearchQuery = /\b(search|find|look up|what is|who is|latest|news|current|today|how to|where|when|why|how|score|result|match|game|weather|price|stock)\b/i.test(proxyLastUserText);
            if (isSearchQuery) {
              try {
                // Resolve Brave API key: user DB keys > skill connections > server env
                let proxyBraveKey = BRAVE_API_KEY;
                if (!proxyBraveKey && authenticatedUserId) {
                  try {
                    const userDbKeys = await getProviderKeysForUser(authenticatedUserId);
                    proxyBraveKey = userDbKeys.brave || undefined;
                  } catch { /* ignore */ }
                  if (!proxyBraveKey) {
                    try {
                      const userSkillKeys = await getSkillApiKeysForUser(authenticatedUserId);
                      proxyBraveKey = userSkillKeys.brave?.BRAVE_API_KEY || undefined;
                    } catch { /* ignore */ }
                  }
                }
                const searchResults = await fetchBrowserUseFindings(proxyLastUserText, 5, proxyBraveKey);
                if (searchResults.results.length > 0) {
                  const lines = searchResults.results.map((r, i) =>
                    `${i + 1}. ${r.title}\n   URL: ${r.url}${r.snippet ? `\n   Snippet: ${r.snippet}` : ''}`
                  );
                  const searchSystemMsg: OpenAIMessage = {
                    role: 'system',
                    content: `Live web search results for the user's query:\n${lines.join('\n')}\n\nUse these results to answer the user's question with current information. Cite sources when relevant. Do NOT say you cannot search the web — these are real, live results.`,
                  };
                  finalProxyMessages = [searchSystemMsg, ...finalProxyMessages];
                  console.log(`[chat][proxy] injected ${searchResults.results.length} search results for query: "${proxyLastUserText.slice(0, 80)}"`);
                }
              } catch (searchErr) {
                console.warn('[chat][proxy] web search injection failed:', searchErr);
              }
            }
          }

          // ── Inject linked channels context into proxy path ──────────────
          // Without this the gateway AI has no idea which channels the user
          // has linked, so it falls back to asking for bot tokens / chat IDs.
          if (authenticatedUserId) {
            try {
              const proxyLinked = await getLinkedChannels(authenticatedUserId);
              const proxyActive = proxyLinked.filter(c => c.isActive);
              let proxyChannelCtx: string;
              if (proxyActive.length > 0) {
                const chList = proxyActive.map(c => `- ${c.displayName} (${c.platform})`).join('\n');
                proxyChannelCtx = [
                  '[Channel Delivery Rules]',
                  '',
                  'CRITICAL — NEVER ask the user to create a Telegram bot, visit @BotFather, get a bot token, provide a chat ID, or any developer setup.',
                  'NEVER ask for Slack app tokens, Discord bot tokens, or any developer portal credentials.',
                  'NEVER ask for the user\'s Telegram username, user ID, or phone number for sending messages.',
                  'The platform handles ALL channel connections automatically via the /channels page.',
                  '',
                  'The user has these channels connected and active:',
                  chList,
                  '',
                  'To send a message to a channel, output EXACTLY this block format (each field MUST be on its own line):',
                  '',
                  '[DELIVER]',
                  'platform: telegram',
                  'text: Your message here',
                  '[/DELIVER]',
                  '',
                  'IMPORTANT FORMAT RULES:',
                  '- [DELIVER] must be on its own line with NOTHING after it.',
                  '- "platform:" must be on the NEXT line by itself.',
                  '- "text:" must be on its own line. The message content follows on the same line and can continue on additional lines.',
                  '- [/DELIVER] must be on its own line.',
                  '- Do NOT put platform: and text: on the same line as [DELIVER].',
                  '',
                  'For scheduled/recurring delivery (same format rules apply):',
                  '',
                  '[SCHEDULE_DELIVERY]',
                  'schedule: daily',
                  'platform: telegram',
                  'name: My schedule',
                  'text: Your recurring message',
                  '[/SCHEDULE_DELIVERY]',
                  '',
                  'CRITICAL — [SCHEDULE_DELIVERY] ONLY supports chat channels: slack, telegram, discord, whatsapp, all.',
                  'Do NOT use platform: twitter / instagram / facebook / linkedin / tiktok — those are NOT chat channels and the schedule will fail with "cron delivery target is missing".',
                  'For social media scheduling, use [ZERNIO_API] action: create_post with the "scheduledFor" parameter instead.',
                  'Only emit [SCHEDULE_DELIVERY] when the platform is in the User\'s Linked Channels list above.',
                  '',
                  'If the user asks to send something to a platform listed above, just use the [DELIVER] block immediately. Do NOT ask any questions — just send it.',
                  'If the user asks for a platform NOT listed above, tell them: "That channel isn\'t connected yet. Go to your [Channels page](/channels) to link it — it takes 30 seconds."',
                ].join('\n');
              } else {
                proxyChannelCtx = [
                  '[Channel Delivery Rules]',
                  '',
                  'CRITICAL — NEVER ask the user to create a Telegram bot, visit @BotFather, get a bot token, provide a chat ID, or any developer setup.',
                  'NEVER ask for Slack app tokens, Discord bot tokens, or any developer portal credentials.',
                  'The platform handles ALL channel connections via the /channels page.',
                  '',
                  'The user has NO channels linked yet.',
                  'If they ask to send/deliver something via Telegram, Slack, Discord, or WhatsApp, tell them:',
                  '"That channel isn\'t connected yet. Go to your [Channels page](/channels) to link it — it takes 30 seconds."',
                  'Do NOT output [DELIVER] or [SCHEDULE_DELIVERY] blocks when no channels are linked.',
                ].join('\n');
              }
              finalProxyMessages = [{ role: 'system', content: proxyChannelCtx }, ...finalProxyMessages];
              console.log(`[chat][proxy] injected channel context: ${proxyActive.length} active channel(s)`);
            } catch (chErr) {
              console.warn('[chat][proxy] failed to inject channel context:', chErr);
            }
          }

          // ── Auto image-generation skill context ──────────────────────
          // When nano-banana-pro (or similar image generation skill) is active,
          // instruct the AI to use it automatically for image requests.
          {
            let hasImageSkill = Array.isArray(proxySkills) && hasSkill(proxySkills, 'nano_banana', 'nano-banana', 'nano_banana_pro', 'nano-banana-pro');
            if (!hasImageSkill && authenticatedUserId) {
              try {
                const { rows: imgSkillRows } = await pool.query(
                  `SELECT 1 FROM user_skills WHERE user_id = $1 AND skill_id ILIKE '%nano_banana%' AND is_active = TRUE LIMIT 1`,
                  [authenticatedUserId],
                );
                hasImageSkill = imgSkillRows.length > 0;
              } catch { /* ignore */ }
            }
            if (hasImageSkill) {
              const imageSkillCtx = [
                '[Image Generation Rules]',
                '',
                'You have the nano-banana-pro image generation skill installed and active.',
                'When the user asks you to create, generate, draw, design, or make an image, picture, photo, illustration, poster, logo, banner, or any visual content:',
                '- ALWAYS use the nano-banana-pro skill automatically to generate the image.',
                '- Do NOT ask the user to say "nano banana" or mention any skill name.',
                '- Do NOT say you cannot generate images — you CAN, via the nano-banana-pro skill.',
                '- Just proceed directly with generation based on the user\'s description.',
              ].join('\n');
              finalProxyMessages = [{ role: 'system', content: imageSkillCtx }, ...finalProxyMessages];
              console.log('[chat][proxy] injected auto image-gen skill context');
            }
          }

          // ── CRITICAL: Inject base system prompt into proxy path ─────────
          // Detailed action-block specs live as built-in skills in the mawa
          // gateway (`skills/mawadao-seller/SKILL.md`, `skills/mawadao-inbox/SKILL.md`,
          // …). The gateway loads the relevant SKILL on demand. Here we only
          // remind the model the skills exist and surface the absolute hard rules.
          {
            const proxyBasePrompt = [
              'You are an AI assistant powered by mawa — the personal AI platform on mawaDao.',
              '',
              '## Built-in mawaDao skills (loaded on demand by the gateway)',
              '- **mawadao-seller** — products, publishing to social media (Zernio), marketing campaigns, channel delivery, seller-data SQL. Activate when the user mentions products, listings, publishing, posting, social media, sales, campaigns, marketing, channels, or seller data. Action blocks: [CREATE_PRODUCT], [UPDATE_PRODUCT], [PUBLISH_PRODUCT], [DELIVER], [SCHEDULE_DELIVERY], [SELLER_SQL], [ZERNIO_API], [CAMPAIGN_PLAN].',
              '- **mawadao-inbox** — read / draft / send replies for connected Gmail or Outlook inboxes. Activate when the user mentions email, inbox, reply, draft. Action blocks: [INBOX_DRAFT], [INBOX_SEND_DRAFT].',
              'Always rely on the skill for the full block specification — do NOT duplicate its instructions inline in this conversation.',
              '',
              '## Hard rules (always enforced — never override)',
              '- Posting / publishing to social media is ONLY possible via `[PUBLISH_PRODUCT]` or `[ZERNIO_API]`. No other skill or tool can post. Never claim a post is "live", "published", or "successful" — the platform appends the real status as a follow-up message.',
              '- Creating a product is ONLY possible via `[CREATE_PRODUCT]`.',
              '- Sending an email is ONLY possible via `[INBOX_SEND_DRAFT]` after the user has approved a draft AND the account policy allows automated send.',
              '- `/channels` = chat bots (Telegram, Slack, Discord, WhatsApp). `/seller/social-accounts` = Zernio social media (Instagram, Facebook, LinkedIn, Twitter, TikTok, …). NEVER confuse the two.',
              '- `[SCHEDULE_DELIVERY]` only supports chat platforms. For social-media scheduling, use `[ZERNIO_API]` with `scheduledFor`.',
              '- NEVER ask the user to create bots, fetch tokens, or visit developer portals — mawaDao handles all OAuth at /channels and /seller/social-accounts.',
              '- The user does NOT see action blocks. Always write a friendly confirmation OUTSIDE the block.',
              '',
              '## Style',
              'Be helpful, concise, and accurate. Use Markdown when appropriate. When an agent persona is selected, follow its personality.',
            ].join('\n');
            finalProxyMessages = [{ role: 'system', content: proxyBasePrompt }, ...finalProxyMessages];
            console.log(`[chat][proxy] ✅ injected proxy base system prompt (${proxyBasePrompt.length} chars)`);
          }

          // ── Inject connected social accounts into proxy path ────────────
          if (authenticatedUserId) {
            try {
              console.log(`[chat][proxy][context] Querying connected_social_accounts for userId=${authenticatedUserId}`);
              const { rows: proxySocialRows } = await queryWithRLS(
                authenticatedUserId,
                `SELECT id, platform, account_name, provider, is_active
                 FROM connected_social_accounts
                 WHERE user_id = $1 AND is_active = true
                 ORDER BY platform`,
                [authenticatedUserId],
              );
              console.log(`[chat][proxy][context] Social accounts query returned ${proxySocialRows.length} row(s)`);
              let proxySocialCtx: string;
              if (proxySocialRows.length > 0) {
                proxySocialRows.forEach((a: { id: string; platform: string; account_name?: string; provider: string }, idx: number) => {
                  console.log(`[chat][proxy][context]   social[${idx}]: platform=${a.platform} name=${a.account_name} provider=${a.provider} id=${a.id}`);
                });
                const list = proxySocialRows.map((a: { id: string; platform: string; account_name?: string; provider: string }) =>
                  `- ${a.platform}: ${a.account_name || 'unnamed'} (id: ${a.id}, provider: ${a.provider})`
                ).join('\n');
                proxySocialCtx = `[User's Connected Social Accounts for POSTING/PUBLISHING]\nThese social media accounts are connected via Zernio and available for publishing product listings, images, and marketing content:\n${list}\n\nUse the platform name in [PUBLISH_PRODUCT] blocks. For any platform NOT listed here, tell the user to connect it first at /seller/social-accounts.`;
              } else {
                proxySocialCtx = `[User's Connected Social Accounts for POSTING/PUBLISHING]\nThe user has NO social media accounts connected for publishing. If they ask to post or publish to Instagram, Facebook, LinkedIn, Twitter etc., tell them to visit /seller/social-accounts to connect their accounts via Zernio first. Do NOT output [PUBLISH_PRODUCT] blocks.`;
              }
              finalProxyMessages = [{ role: 'system', content: proxySocialCtx }, ...finalProxyMessages];
              console.log(`[chat][proxy][context] ✅ Social accounts context injected (${proxySocialCtx.length} chars)`);
            } catch (err) {
              console.warn('[chat][proxy][context] ❌ Failed to fetch connected social accounts:', (err as Error)?.message);
            }
          }

          // ── Inject seller products into proxy path ──────────────────────
          if (authenticatedUserId) {
            try {
              console.log(`[chat][proxy][context] Querying products for userId=${authenticatedUserId}`);
              const { rows: proxyProdRows } = await queryWithRLS(
                authenticatedUserId,
                `SELECT id, name, summary, price, pricing_model, status
                 FROM products
                 WHERE user_id = $1
                 ORDER BY created_at DESC LIMIT 30`,
                [authenticatedUserId],
              );
              console.log(`[chat][proxy][context] Products query returned ${proxyProdRows.length} row(s)`);
              let proxyProdCtx: string;
              if (proxyProdRows.length > 0) {
                proxyProdRows.forEach((p: { id: string; name: string; price?: string; status: string }, idx: number) => {
                  console.log(`[chat][proxy][context]   product[${idx}]: id=${p.id} name="${p.name}" price=${p.price} status=${p.status}`);
                });
                const list = proxyProdRows.map((p: { id: string; name: string; summary?: string; price?: string; pricing_model?: string; status: string }) =>
                  `- [id: ${p.id}] "${p.name}" — ${p.price || 'N/A'} ${p.pricing_model || ''} (${p.status})${p.summary ? ': ' + p.summary.slice(0, 80) : ''}`
                ).join('\n');
                proxyProdCtx = `[User's Seller Products]\nThe user has these products:\n${list}\n\nUse the product id or name in [UPDATE_PRODUCT] or [PUBLISH_PRODUCT] blocks. Never guess product IDs — only use the ones listed here.`;
              } else {
                proxyProdCtx = `[User's Seller Products]\nThe user has no seller products yet. If they ask to update or publish a product, suggest they create one first using [CREATE_PRODUCT].`;
              }
              finalProxyMessages = [{ role: 'system', content: proxyProdCtx }, ...finalProxyMessages];
              console.log(`[chat][proxy][context] ✅ Products context injected (${proxyProdCtx.length} chars)`);
            } catch (err) {
              console.warn('[chat][proxy][context] ❌ Failed to fetch seller products:', (err as Error)?.message);
            }
          }

          // ── Inject available agents into proxy path ─────────────────────
          if (authenticatedUserId) {
            try {
              const { rows: proxyAgentRows } = await pool.query(
                `SELECT DISTINCT ma.id, ma.name, ma.slug, ma.category
                 FROM marketplace_agents ma
                 WHERE ma.is_active = true
                 ORDER BY ma.name LIMIT 50`,
              );
              let proxyAgentCtx: string;
              if (proxyAgentRows.length > 0) {
                const list = proxyAgentRows.map((a: { name: string; slug: string; category: string }) =>
                  `- ${a.name} (slug: ${a.slug}, category: ${a.category})`
                ).join('\n');
                proxyAgentCtx = `[Available Agents]\nThese agents are available for task assignment:\n${list}\n\nUse the agent name or slug in [CREATE_TASK] blocks.`;
              } else {
                proxyAgentCtx = `[Available Agents]\nNo agents are currently available.`;
              }
              finalProxyMessages = [{ role: 'system', content: proxyAgentCtx }, ...finalProxyMessages];
            } catch (err) {
              console.warn('[chat][proxy][context] Failed to fetch available agents:', err);
            }
          }

          // ── Diagnostic: log image parts in proxy messages ──
          const imagePartCount = finalProxyMessages.reduce((count, m) => {
            if (typeof m.content === 'string' || !Array.isArray(m.content)) return count;
            return count + (m.content as Array<{type: string}>).filter(p => p.type === 'image_url').length;
          }, 0);
          if (imagePartCount > 0) {
            console.log(`[chat][proxy][images] Found ${imagePartCount} image_url part(s) in proxy messages`);
          }

          // ── IMG-DEBUG: detailed pre-proxy logging ──
          console.log(`[IMG-DEBUG][proxy] finalProxyMessages count: ${finalProxyMessages.length}`);
          finalProxyMessages.forEach((m, i) => {
            if (typeof m.content === 'string') {
              console.log(`[IMG-DEBUG][proxy]   finalMsg[${i}] role=${m.role} content=string(${m.content.length})`);
            } else if (Array.isArray(m.content)) {
              const types = (m.content as Array<{type: string}>).map(p => p.type);
              const imgParts = (m.content as Array<{type: string; image_url?: {url?: string}}>).filter(p => p.type === 'image_url');
              console.log(`[IMG-DEBUG][proxy]   finalMsg[${i}] role=${m.role} content=array(${(m.content as unknown[]).length}) types=[${types.join(',')}]`);
              imgParts.forEach((ip, j) => {
                console.log(`[IMG-DEBUG][proxy]     image_url[${j}] urlLen=${ip.image_url?.url?.length} urlStart=${ip.image_url?.url?.substring(0, 50)}`);
              });
            }
          });

          const proxyPayload = JSON.stringify({
            model: proxyModel,
            messages: finalProxyMessages,
            stream: true,
            max_tokens: 16384,
          });

          const targetUrl = `${tenant.backendUrl.replace(/\/+$/, "")}/v1/chat/completions`;
          console.log(`[IMG-DEBUG][proxy] PAYLOAD SIZE: ${(proxyPayload.length / 1024).toFixed(1)}KB (raw JSON length: ${proxyPayload.length})`);
          console.log(`[chat] Proxying to tenant backend: ${targetUrl} convId: ${proxyConversationId} payloadSize: ${(proxyPayload.length / 1024).toFixed(1)}KB${imagePartCount > 0 ? ` (${imagePartCount} image(s))` : ''}`);  

          // Gateway auth: prefer per-tenant token from DB, fall back to global env.
          // The literal '1' fallback exists because some pre-prod tenants were
          // provisioned without a token; warn so it's visible in logs and can
          // be fixed by setting tenants.gateway_token or OPENCLAW_GATEWAY_TOKEN.
          let gwToken = tenant.gatewayToken || OPENCLAW_GATEWAY_TOKEN;
          if (!gwToken) {
            console.warn(`[chat][proxy] No gateway token configured for tenant ${tenant.subdomain} — using placeholder. Set tenants.gateway_token or OPENCLAW_GATEWAY_TOKEN env.`);
            gwToken = '1';
          }

          // Phase A stopgap (RFC: Resilient Long-Running Chat):
          // Abort if the tenant backend doesn't respond within 120 seconds.
          // Cloud Run cold starts on the per-tenant service can occasionally take
          // 60-90s (gcsfuse mount + container init + first LLM token), so the
          // previous 60s ceiling caused premature 502s on the first message after
          // scale-to-zero. This only bounds time-to-first-byte, not stream length.
          const proxyAbort = new AbortController();
          const proxyFetchStart = Date.now();
          const PROXY_INIT_TIMEOUT_MS = 120_000;
          const proxyTimeout = setTimeout(() => {
            console.error(`[chat][proxy][FETCH-ABORT] convId=${conversationId?.slice(0, 8) ?? 'none'} gateway fetch ABORTED after ${PROXY_INIT_TIMEOUT_MS}ms — targetUrl=${targetUrl}`);
            proxyAbort.abort();
          }, PROXY_INIT_TIMEOUT_MS);

          let backendRes: Response;
          try {
            backendRes = await fetch(targetUrl, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${gwToken}`,
                "X-Tenant-ID": tenant.tenantId,
                ...(proxyConversationId ? { "X-OpenClaw-Session-Key": proxyConversationId } : {}),
              },
              body: proxyPayload,
              signal: proxyAbort.signal,
            });
          } finally {
            clearTimeout(proxyTimeout);
          }

          if (!backendRes.ok) {
            const errText = await backendRes.text().catch(() => '');
            console.error(`[chat] Tenant backend returned ${backendRes.status} for ${targetUrl}: ${errText}`);
            return NextResponse.json(
              { error: `Your AI backend returned an error (${backendRes.status}). Please check that your mawa instance is running correctly.` },
              { status: 502 },
            );
          } else {
            const contentType = backendRes.headers.get("content-type") || "";

            // SSE stream from tenant backend — convert to plain text for AI SDK
            if (backendRes.body && contentType.includes("text/event-stream")) {
              const backendStream = backendRes.body;
              let fullText = "";
              // Create placeholder message & mark conversation as streaming
              const streamMsgId = proxyConversationId ? await startStreamingMessage(proxyConversationId) : null;
              const textStream = new ReadableStream({
                async start(controller) {
                  let clientGone = false;
                  let lastDbSave = Date.now();
                  const MAX_CONTINUATIONS = 5;
                  const STREAM_READ_TIMEOUT_MS = 300_000; // 5 min — no data = stale stream
                  let currentStream: ReadableStream<Uint8Array> | null = backendStream;
                  let continuationCount = 0;
                  const streamStartTime = Date.now();
                  let chunkCount = 0;
                  let lastChunkTime = Date.now();
                  let timedOut = false;
                  let lastProgressLog = Date.now();
                  const logId = proxyConversationId?.slice(0, 8) ?? 'no-conv';
                  console.log(`[chat][proxy][stream-start] convId=${logId} startTime=${new Date().toISOString()}`);

                  // ── MEDIA line detection & conversion ────────────────────
                  // Gateway tools emit "MEDIA:/home/node/.openclaw/workspace/file.png"
                  // which is a container-local path. We convert these to markdown
                  // image syntax pointing at our media proxy route.
                  const MEDIA_PREFIX = 'MEDIA:';
                  let mediaLineBuf = '';
                  const actionFilter = createActionBlockFilter();

                  function transformMediaLine(line: string): string {
                    const m = line.match(/MEDIA:\s*\/home\/node\/\.openclaw\/workspace\/(.+)/);
                    if (m) {
                      const fn = m[1].trim().replace(/[`"']+$/g, '');
                      const before = line.slice(0, m.index);
                      const after = line.slice(m.index! + m[0].length);
                      return `${before}![${fn}](/api/media/workspace/${encodeURIComponent(fn)})${after}`;
                    }
                    return line;
                  }

                  function processStreamChunk(chunk: string): string {
                    mediaLineBuf += chunk;
                    let emit = '';
                    // Process all complete lines
                    let nlIdx;
                    while ((nlIdx = mediaLineBuf.indexOf('\n')) !== -1) {
                      const line = mediaLineBuf.slice(0, nlIdx);
                      mediaLineBuf = mediaLineBuf.slice(nlIdx + 1);
                      emit += (/\bMEDIA:\s*\/home\/node\//.test(line) ? transformMediaLine(line) : line) + '\n';
                    }
                    // Remaining buffer: partial line — hold if it could be MEDIA
                    if (mediaLineBuf) {
                      const couldBeMedia = mediaLineBuf.length <= MEDIA_PREFIX.length
                        ? MEDIA_PREFIX.startsWith(mediaLineBuf)
                        : mediaLineBuf.startsWith(MEDIA_PREFIX);
                      if (!couldBeMedia) {
                        emit += mediaLineBuf;
                        mediaLineBuf = '';
                      }
                    }
                    return emit;
                  }

                  function flushMediaBuf(): string {
                    if (!mediaLineBuf) return '';
                    const result = /\bMEDIA:\s*\/home\/node\//.test(mediaLineBuf)
                      ? transformMediaLine(mediaLineBuf)
                      : mediaLineBuf;
                    mediaLineBuf = '';
                    return result;
                  }
                  // ── End MEDIA helpers ─────────────────────────────────────

                  try {
                    // Outer loop: handles auto-continuation when model hits token limit
                    while (currentStream && continuationCount <= MAX_CONTINUATIONS) {
                      const reader = currentStream.getReader();
                      const decoder = new TextDecoder();
                      let buffer = "";
                      let lastFinishReason = "";

                      while (true) {
                        // Race the read against a timeout — if the upstream stalls,
                        // we close gracefully instead of hanging forever.
                        const readTimeout = new Promise<{ done: true; value: undefined }>(resolve =>
                          setTimeout(() => resolve({ done: true, value: undefined }), STREAM_READ_TIMEOUT_MS)
                        );
                        const readStart = Date.now();
                        const { done, value } = await Promise.race([reader.read(), readTimeout]);
                        if (done) {
                          if (!value) {
                            // Timeout or natural end — check which
                            const sinceLast = Date.now() - lastChunkTime;
                            if (sinceLast >= STREAM_READ_TIMEOUT_MS - 500) {
                              timedOut = true;
                              console.error(`[chat][proxy][TIMEOUT] convId=${logId} NO DATA for ${sinceLast}ms — stream killed by read timeout. chunks=${chunkCount} chars=${fullText.length} elapsed=${Date.now() - streamStartTime}ms`);
                              // Send a visible indicator so the user knows the stream was cut
                              if (!clientGone) {
                                const notice = '\n\n---\n⚠️ *The AI backend stopped responding (timed out after ~5 minutes of silence). This usually means the model got stuck on an internal operation. Please try again — shorter or simpler prompts are more reliable.*';
                                try { controller.enqueue(new TextEncoder().encode(notice)); fullText += notice; } catch { clientGone = true; }
                              }
                            } else {
                              console.log(`[chat][proxy][stream-done] convId=${logId} natural end. chunks=${chunkCount} chars=${fullText.length} elapsed=${Date.now() - streamStartTime}ms`);
                            }
                          }
                          const tail = decoder.decode();
                          if (tail) buffer += tail;
                          break;
                        }
                        chunkCount++;
                        lastChunkTime = Date.now();
                        // Log progress every 15s
                        if (Date.now() - lastProgressLog > 15_000) {
                          lastProgressLog = Date.now();
                          console.log(`[chat][proxy][progress] convId=${logId} chunks=${chunkCount} chars=${fullText.length} elapsed=${Date.now() - streamStartTime}ms readLatency=${Date.now() - readStart}ms`);
                        }
                        buffer += decoder.decode(value, { stream: true });
                        const lines = buffer.split("\n");
                        buffer = lines.pop() ?? "";
                        for (const line of lines) {
                          const trimmed = line.trim();
                          if (!trimmed || !trimmed.startsWith("data: ")) continue;
                          const data = trimmed.slice(6);
                          if (data === "[DONE]") {
                            console.log(`[chat][proxy][DONE-signal] convId=${logId} received [DONE]. chunks=${chunkCount} chars=${fullText.length}`);
                            continue;
                          }
                          try {
                            const parsed = JSON.parse(data) as Record<string, unknown>;
                            const choices = parsed.choices as Array<{ delta?: { content?: string }; finish_reason?: string | null }> | undefined;
                            const content = choices?.[0]?.delta?.content;
                            if (choices?.[0]?.finish_reason) {
                              lastFinishReason = choices[0].finish_reason;
                              console.log(`[chat][proxy][finish-reason] convId=${logId} reason="${lastFinishReason}" chars=${fullText.length}`);
                            }
                            if (content) {
                              const emitted = processStreamChunk(content);
                              if (emitted) {
                                fullText += emitted;
                                const filtered = actionFilter.filter(emitted);
                                if (filtered && !clientGone) {
                                  try { controller.enqueue(new TextEncoder().encode(filtered)); } catch { clientGone = true; console.warn(`[chat][proxy][client-gone] convId=${logId} client disconnected at chars=${fullText.length}`); }
                                }
                              }
                            }
                          } catch (parseErr) {
                            console.warn(`[chat][proxy][parse-error] convId=${logId} chunk=${chunkCount} data=${data.slice(0, 200)}`, parseErr);
                          }
                        }
                        // Periodic DB save (every 3 s)
                        if (streamMsgId && Date.now() - lastDbSave > 3000 && fullText) {
                          lastDbSave = Date.now();
                          updateStreamingContent(streamMsgId, fullText).catch(() => {});
                        }
                      }
                      // Process any remaining buffer
                      if (buffer.trim()) {
                        const trimmed = buffer.trim();
                        if (trimmed.startsWith("data: ")) {
                          const data = trimmed.slice(6);
                          if (data !== "[DONE]") {
                            try {
                              const parsed = JSON.parse(data) as Record<string, unknown>;
                              const choices = parsed.choices as Array<{ delta?: { content?: string }; finish_reason?: string | null }> | undefined;
                              const content = choices?.[0]?.delta?.content;
                              if (choices?.[0]?.finish_reason) {
                                lastFinishReason = choices[0].finish_reason;
                                console.log(`[chat][proxy][finish-reason-tail] convId=${logId} reason="${lastFinishReason}"`);
                              }
                              if (content) {
                                const emitted = processStreamChunk(content);
                                if (emitted) {
                                  fullText += emitted;
                                  const filtered = actionFilter.filter(emitted);
                                  if (filtered && !clientGone) {
                                    try { controller.enqueue(new TextEncoder().encode(filtered)); } catch { clientGone = true; }
                                  }
                                }
                              }
                            } catch { /* skip malformed */ }
                          }
                        }
                      }

                      // Auto-continuation: if model stopped due to max tokens, continue generating
                      if (lastFinishReason === 'length' && fullText && !clientGone) {
                        continuationCount++;
                        console.log(`[chat][proxy] auto-continue #${continuationCount} — finish_reason=length, accumulated ${fullText.length} chars`);
                        try {
                          const contMessages = [
                            ...finalProxyMessages,
                            { role: 'assistant', content: fullText },
                            { role: 'user', content: 'Continue exactly where you left off. Do not repeat anything already said.' },
                          ];
                          const contPayload = JSON.stringify({
                            model: proxyModel,
                            messages: contMessages,
                            stream: true,
                            max_tokens: 16384,
                          });
                          const contAbort = new AbortController();
                          const contTimeout = setTimeout(() => contAbort.abort(), 120_000);
                          let contRes: Response;
                          try {
                            contRes = await fetch(targetUrl, {
                              method: "POST",
                              headers: {
                                "Content-Type": "application/json",
                                Authorization: `Bearer ${gwToken}`,
                                "X-Tenant-ID": tenant.tenantId,
                                ...(proxyConversationId ? { "X-OpenClaw-Session-Key": proxyConversationId } : {}),
                              },
                              body: contPayload,
                              signal: contAbort.signal,
                            });
                          } finally {
                            clearTimeout(contTimeout);
                          }
                          if (contRes.ok && contRes.body) {
                            currentStream = contRes.body;
                            continue;
                          }
                        } catch (contErr) {
                          console.warn(`[chat][proxy] auto-continue #${continuationCount} failed:`, contErr);
                        }
                      }
                      currentStream = null;
                    }

                    // Flush any MEDIA content remaining in the line buffer
                    const flushed = flushMediaBuf();
                    if (flushed) {
                      fullText += flushed;
                      const filtered = actionFilter.filter(flushed);
                      if (filtered && !clientGone) {
                        try { controller.enqueue(new TextEncoder().encode(filtered)); } catch { clientGone = true; }
                      }
                    }
                    // Flush any remaining text held by the action block filter
                    const actionFlushed = actionFilter.flush();
                    if (actionFlushed && !clientGone) {
                      try { controller.enqueue(new TextEncoder().encode(actionFlushed)); } catch { clientGone = true; }
                    }
                  } catch (err) {
                    console.error(`[chat][proxy][STREAM-ERROR] convId=${logId} error=${(err as Error)?.message} chars=${fullText.length} chunks=${chunkCount} elapsed=${Date.now() - streamStartTime}ms`, err);
                    if (!clientGone) { try { controller.error(err); } catch { /* already closed */ } }
                  } finally {
                    // Detect images via GCS fallback and inject into the stream BEFORE closing
                    if (fullText && authenticatedUserId && !clientGone) {
                      try {
                        const streamImages = await persistDetectedMedia(fullText, authenticatedUserId);
                        const missing = streamImages.filter(img =>
                          !fullText.includes(img.url) && !fullText.includes(decodeURIComponent(img.url))
                        );
                        if (missing.length > 0) {
                          const imgMd = '\n\n' + missing.map(img => `![${img.fileName}](/api/media/workspace/${encodeURIComponent(img.fileName)})`).join('\n');
                          try { controller.enqueue(new TextEncoder().encode(imgMd)); } catch { clientGone = true; }
                          fullText += imgMd;
                          console.log(`[chat][proxy] Streamed ${missing.length} image(s) into response`);
                        }
                      } catch (imgErr) {
                        console.warn('[chat][proxy] image detection before close failed:', (imgErr as Error)?.message);
                      }
                    }
                    if (!clientGone) { try { controller.close(); } catch { /* stream already errored */ } }
                    const totalMs = Date.now() - streamStartTime;
                    console.log(`[chat][proxy][stream-final] convId=${logId} chars=${fullText.length} chunks=${chunkCount} duration=${totalMs}ms timedOut=${timedOut} clientGone=${clientGone} continuations=${continuationCount}`);
                    // Save final content immediately (keep is_streaming = TRUE so recovery polling continues)
                    if (proxyConversationId && streamMsgId && fullText) {
                      await updateStreamingContent(streamMsgId, fullText);
                    }
                    // Await action blocks BEFORE clearing is_streaming flag
                    if (fullText && authenticatedUserId) {
                      try {
                        await processAllActionBlocks(fullText, {
                          userId: authenticatedUserId,
                          authToken: authHeader || null,
                          gatewayUrl: tenant.backendUrl || null,
                          gatewayToken: gwToken || null,
                          conversationId: proxyConversationId || null,
                        });
                      } catch (err) {
                        console.error('[ai-chat][proxy-stream] action block processing failed:', err);
                      }
                    }
                    // NOW finalize streaming state (sets is_streaming = FALSE)
                    if (proxyConversationId) {
                      await finishStreamingMessage(proxyConversationId, streamMsgId, fullText);
                      // Close the MC mirror task for this conversation.
                      if (authenticatedUserId) {
                        finishMCTaskForConversation(authenticatedUserId, proxyConversationId, 'done')
                          .catch(err => console.warn('[chat][proxy] MC finish failed:', err));
                      }
                    }
                  }
                },
              });

              return new NextResponse(textStream, {
                headers: {
                  "Content-Type": "text/plain; charset=utf-8",
                  "Cache-Control": "no-cache, no-transform",
                  Connection: "keep-alive",
                  // Disable proxy buffering (nginx / GCLB) so tokens reach the
                  // browser as soon as the worker emits them. Without this an
                  // upstream proxy can hold the response until close, which on
                  // long agent runs surfaces as a stalled UI then a 503.
                  "X-Accel-Buffering": "no",
                },
              });
            }

            // Non-streaming JSON response — extract content
            const data = await backendRes.json() as {
              choices?: Array<{ message?: { content?: string } }>;
            };
            const respContent = data?.choices?.[0]?.message?.content ?? "";
            // Save assistant response for non-streaming proxy
            if (proxyConversationId && respContent) {
              console.log('[chat][proxy][non-stream] saving assistant message. convId:', proxyConversationId, 'len:', respContent.length);
              pool.query(
                `INSERT INTO messages (conversation_id, role, content) VALUES ($1, $2, $3)`,
                [proxyConversationId, 'assistant', respContent]
              ).catch((err: unknown) => console.error('[chat][proxy][non-stream] failed to save assistant message:', err));
            }
            // Post-process action blocks for non-streaming response
            if (respContent && authenticatedUserId) {
              processAllActionBlocks(respContent, {
                userId: authenticatedUserId,
                authToken: authHeader || null,
                gatewayUrl: tenant.backendUrl || null,
                gatewayToken: gwToken || null,
                conversationId: proxyConversationId || null,
              }).catch(err =>
                console.error('[ai-chat][proxy-non-stream] action block processing failed:', err)
              );
            }
            return new NextResponse(stripActionBlocks(transformMediaLines(respContent)), {
              headers: { "Content-Type": "text/plain; charset=utf-8" },
            });
          }
        } catch (err) {
          const errMsg = (err as Error).message;
          const isTimeout = errMsg?.includes('abort') || errMsg?.includes('timeout');
          console.error(`[chat] Cloud chat proxy ${isTimeout ? 'TIMEOUT' : 'error'}:`, errMsg,
            '| backendUrl:', tenant.backendUrl, '| Tip: if URL is stale, re-provision or update tenants.backend_url in DB');
          return NextResponse.json(
            { error: isTimeout
                ? 'Your AI backend is taking too long to respond. It may be starting up — please try again in a moment.'
                : 'Failed to reach your AI backend. Please check that your mawa instance is running.' },
            { status: 504 },
          );
        }
      } else {
        console.error('[chat] No backend URL for tenant:', user.subdomain);
        return NextResponse.json(
          { error: 'Your mawa backend is not provisioned yet. Please contact support or re-provision your instance.' },
          { status: 503 },
        );
      }
    } else {
      console.error('[chat] Cloud user without subdomain, userId:', user.userId);
      return NextResponse.json(
        { error: 'No mawa instance is linked to your account. Please complete onboarding first.' },
        { status: 503 },
      );
    }
  } else {
    // Local mode: require Authorization header
    if (!authHeader) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }
  // ── End auth ──────────────────────────────────────────────────────

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const conversationId = body.conversationId as string | undefined;
  const rawMessages = (body.messages ?? []) as UIMessage[];
  const model = (body.model as string | undefined) ?? "openclaw";
  const skills = body.skills as string[] | undefined;
  const agentId = body.agentId as string | undefined;
  const useCaseGuide = (body.useCaseGuide as string | undefined)?.trim();

  // ── Settings overrides from the client (Settings UI → no server restart needed) ─
  const overrideGatewayUrl   = (body.overrideGatewayUrl   as string | undefined)?.trim();
  const overrideGatewayToken = (body.overrideGatewayToken as string | undefined)?.trim();
  const overrideOpenaiKey     = (body.overrideOpenaiKey     as string | undefined)?.trim();
  const overrideAnthropicKey  = (body.overrideAnthropicKey  as string | undefined)?.trim();

  // Fetch user's saved provider keys from the DB (encrypted → decrypted)
  let dbKeys: Record<string, string> = {};
  if (authenticatedUserId) {
    try {
      dbKeys = await getProviderKeysForUser(authenticatedUserId);
    } catch (err) {
      console.warn('[ai-chat] Failed to fetch provider keys from DB:', err);
    }
  }

  // Fetch user's skill connection API keys from the DB
  let skillApiKeys: Record<string, Record<string, string>> = {};
  if (authenticatedUserId) {
    try {
      skillApiKeys = await getSkillApiKeysForUser(authenticatedUserId);
    } catch (err) {
      console.warn('[ai-chat] Failed to fetch skill API keys from DB:', err);
    }
  }

  // Effective config — client override > DB key > server .env vars
  const EFF_GATEWAY_URL   = overrideGatewayUrl   || GATEWAY_URL;
  const EFF_GATEWAY_TOKEN = overrideGatewayToken || OPENCLAW_GATEWAY_TOKEN;
  const EFF_OPENAI        = overrideOpenaiKey     || dbKeys.openai     || OPENAI_API_KEY;
  const EFF_ANTHROPIC     = overrideAnthropicKey  || dbKeys.anthropic  || ANTHROPIC_API_KEY;
  const EFF_MOONSHOT      = dbKeys.moonshot || MOONSHOT_API_KEY;
  const EFF_BRAVE         = dbKeys.brave || skillApiKeys.brave?.BRAVE_API_KEY || BRAVE_API_KEY;

  // Normalize: support both {parts} (AI SDK v6) and {content} (legacy)
  const uiMessages: UIMessage[] = rawMessages.map((m) => ({
    ...m,
    parts: m.parts ?? (m.content ? [{ type: "text", text: m.content as string }] : []),
  }));

  // Save the latest user message to DB (skip if the proxy path already saved it)
  console.log('[ai-chat] conversationId:', conversationId, 'messages:', uiMessages.length, 'userId:', authenticatedUserId ?? 'local', 'proxyUserMsgSaved:', proxyUserMsgSaved);
  if (conversationId && uiMessages.length > 0 && !proxyUserMsgSaved) {
    const lastMsg = uiMessages[uiMessages.length - 1];
    if (lastMsg.role === "user") {
      const textContent = extractText(lastMsg);
      const previewTitle = textContent.slice(0, 60) + (textContent.length > 60 ? "…" : "");
      console.log('[ai-chat] saving user message to DB. convId:', conversationId, 'preview:', previewTitle);
      void (async () => {
        try {
          await pool.query(
            `INSERT INTO messages (conversation_id, role, content) VALUES ($1, $2, $3)`,
            [conversationId, "user", textContent]
          );
          await pool.query(
            `UPDATE conversations
               SET title = CASE
                 WHEN title IS NULL OR title = '' OR title = 'New Chat' THEN $1
                 ELSE title
               END,
                   updated_at = NOW()
             WHERE id = $2`,
            [previewTitle || 'New Chat', conversationId]
          );
          console.log('[ai-chat] user message saved OK for conv:', conversationId);
          // Mirror this conversation into Mission Control so every chat
          // (not just seller-campaign tasks) shows up on the user's board.
          if (authenticatedUserId) {
            startMCTaskForConversation(authenticatedUserId, conversationId, textContent)
              .catch(err => console.warn('[ai-chat] MC conversation mirror failed:', err));
          }
        } catch (err) {
          console.error('[ai-chat] FAILED to save user message:', err);
        }
      })();
    } else {
      console.log('[ai-chat] last message role is not user, skipping save. role:', lastMsg.role);
    }
  } else {
    console.warn('[ai-chat] NOT saving user msg — conversationId:', conversationId, 'msgCount:', uiMessages.length);
  }

  // Convert UIMessages → OpenAI format
  let openAIMessages: OpenAIMessage[] = uiMessages
    .filter((m) => m.role === "user" || m.role === "assistant" || m.role === "system")
    .map(uiMessageToOpenAI);

  const hasBrowserUseSkill = Array.isArray(skills) && hasSkill(skills, 'browser_use', 'browser-use', 'browseruse', 'web_scraper');
  const hasWeatherSkill = Array.isArray(skills) && hasSkill(skills, 'weather', 'weather_forecast');
  const hasWebSearchSkill = Array.isArray(skills) && hasSkill(skills, 'web_search', 'web-search', 'websearch');
  const hasTranslateSkill = Array.isArray(skills) && hasSkill(skills, 'translate', 'translator', 'language_translator');
  const hasCodeInterpreterSkill = Array.isArray(skills) && hasSkill(skills, 'code_interpreter', 'code-interpreter', 'codeinterpreter');
  const hasCalculatorSkill = Array.isArray(skills) && hasSkill(skills, 'calculator');

  const lastUserTextForSkills = extractLastUserText(uiMessages);

  // ── Base system prompt: mawa platform context ──────────────────────
  const baseSystemPrompt = [
    'You are an AI assistant powered by mawa — the personal AI platform on mawaDao.',
    '',
    '## Platform Overview',
    'mawa is a self-hosted, multi-channel AI assistant that bridges messaging channels to AI agents.',
    'Supported channels: WhatsApp, Telegram, Slack, Discord, Signal, iMessage, Microsoft Teams, Matrix, Zalo, WebChat, and more.',
    'It runs a Gateway (control plane on port 18789) that manages agents, sessions, skills, and model routing.',
    '',
    '## Architecture',
    '- **Gateway**: Central control plane — manages agents, sessions, model routing, and tool execution.',
    '- **Agents**: AI personas with a SOUL (identity/personality), SKILLS (capabilities), HEARTBEAT (scheduled tasks), and CHANNELS (messaging integrations).',
    '- **Sessions**: Persistent conversations with context memory. Sessions can be continued across channels.',
    '- **Skills**: Modular tools agents can use — weather, browser-use, GitHub, coding, image generation, web search, file analysis, and 50+ more.',
    '- **Models**: GPT-4o, Claude, Gemini, Llama, Mistral, and 300+ models via Moonshot. Supports failover between providers.',
    '',
    '## Agent Architecture (SOUL/SKILL/HEARTBEAT/CHANNEL)',
    '- **SOUL**: Agent identity — name, personality, communication style, core principles, and purpose.',
    '- **SKILL**: Activated capabilities — e.g., web search, code execution, file analysis, translation.',
    '- **HEARTBEAT**: Scheduled/periodic tasks the agent runs automatically (cron jobs, polling, webhooks).',
    '- **CHANNEL**: Messaging platform connections — each agent can be on multiple channels simultaneously.',
    '',
    '## Skills System',
    'Skills are modular capabilities users can enable. Categories include:',
    '- AI/ML: web search, code interpreter, image analysis, sentiment, summarization, document Q&A, translation, speech-to-text, semantic search, OCR',
    '- Frontend: React, Vue.js, CSS/Tailwind, accessibility, web performance, SEO, web scraping',
    '- Backend: REST testing, SQL, GraphQL, Docker, Redis, microservices, webhooks',
    '- DevOps: CI/CD, Kubernetes, Terraform, log analysis, monitoring',
    '- Data: CSV analysis, JSON tools, data validation, chart building, ETL',
    '- Security: dependency scanning, OWASP guide, secret detection, SSL analysis, pen testing',
    '- Testing: unit test generation, E2E (Playwright/Cypress), mocking, coverage',
    '- Writing: blog writing, grammar, doc generation, content planning',
    '- Productivity: meeting notes, task management, email writing',
    '- General: calculator, timezone converter, unit converter, regex helper, code search',
    '',
    '## Social Media & Publishing Tools',
    '',
    '### Zernio — The Default Social Media Skill (MUST USE)',
    'Zernio is a ClawHub skill for social media automation via natural language. It supports posting to Twitter/X, Instagram, Facebook, LinkedIn, TikTok, YouTube, Pinterest, Reddit, Bluesky, Threads, Google Business, Telegram, Snapchat, WhatsApp (14+ platforms).',
    '',
    '**Skill Name:** `zernio-api`',
    '**ClawHub:** https://clawhub.ai/mikipalet/zernio-api',
    '**Install Command:** `npx clawhub@latest install mikipalet/zernio-api`',
    '**Auth:** Bearer token via `ZERNIO_API_KEY` environment variable',
    '**API Base URL:** https://zernio.com/api/v1',
    '**Get API Key:** https://zernio.com/dashboard/api-keys (key starts with `sk_`)',
    '',
    '**Zernio Capabilities:**',
    '- Profiles: create and manage brand profiles',
    '- Account Connections: OAuth flows for connecting social accounts',
    '- Posts: create, schedule, bulk upload, retry failed posts, cross-post to multiple platforms',
    '- Media: presigned URL uploads for images and video',
    '- Queue Management: manage queue slots for scheduled publishing',
    '- Webhooks: delivery/status event notifications',
    '- Analytics: post performance data (impressions, likes, retweets, etc.)',
    '- First-comment automation',
    '',
    '**Setup Steps (guide user through these):**',
    '1. Install the skill: `npx clawhub@latest install mikipalet/zernio-api`',
    '2. Add API key: `echo \'ZERNIO_API_KEY=sk_your_key_here\' >> ~/.openclaw/.env` (get key from https://zernio.com/dashboard/api-keys)',
    '3. Restart mawa: `openclaw restart`',
    '4. Connect social accounts via OAuth (the skill handles this — just say "connect my Twitter account")',
    '',
    '**Usage Examples (natural language):**',
    '- "Post \'Just shipped a new feature!\' to Twitter"',
    '- "Schedule a LinkedIn post for tomorrow at 9am"',
    '- "Cross-post to Twitter, LinkedIn, and Bluesky"',
    '- "Show me my recent posts"',
    '- "Retry all my failed posts"',
    '- "Connect my Instagram account"',
    '- "How did my last Twitter post perform?"',
    '',
    '**Troubleshooting:**',
    '- "Skill not found": Reinstall with `npx clawhub@latest install mikipalet/zernio-api`',
    '- "ZERNIO_API_KEY not set": Check ~/.openclaw/.env, ensure key starts with `sk_`',
    '- Auth errors (401): Verify key at https://zernio.com/dashboard/api-keys, restart mawa',
    '- Rate limits (429): Space out posts or upgrade Zernio plan',
    '',
    '### Other Social Media Skills (alternatives)',
    '- **PostFast**: ClawHub-native cross-platform scheduling. Simpler, good for basic X/LinkedIn scheduling.',
    '- **Post Bridge Social Manager**: Chat-driven posting workflows. Good for conversational post creation.',
    '',
    '### CRITICAL RULES FOR SOCIAL MEDIA TASKS:',
    '- ALWAYS recommend installing the Zernio skill (`zernio-api`) for any social media posting, scheduling, or automation task.',
    '- NEVER tell the user to go to developer.twitter.com, linkedin.com/developers, or any platform\'s developer portal to get API keys manually.',
    '- NEVER suggest building custom Python/Node scripts for posting. The Zernio skill handles everything.',
    '- The user only needs: (1) install the skill, (2) get a Zernio API key, (3) connect their social accounts through the skill\'s OAuth flow.',
    '- When building a social media agent, the posting step MUST use Zernio — not raw API calls.',
    '- If a social media automation workflow needs posting, add `zernio-api` as a required skill and guide the user through setup.',
    '',
    '## Integration Modes (How to Connect External Services)',
    'mawa supports 5 integration modes in order of preference:',
    '',
    '### A) Native Channel (inbound + outbound messaging)',
    'Built-in bidirectional adapters: Slack, Discord, Telegram, WhatsApp, Signal, iMessage, Teams, Matrix, Zalo, WebChat.',
    'The platform manages all channel connections — users connect via the /channels page (OAuth, login widgets, etc.).',
    'NEVER ask users to create bots, get bot tokens, visit @BotFather, or go to any developer portal. That is all handled by the platform.',
    'Use for: users chatting WITH the agent FROM that platform, AND the agent sending messages TO the user on that platform.',
    '',
    '### B) Composio Toolkit (outbound SaaS actions)',
    'Managed integration layer with 980+ pre-built toolkits. Handles OAuth flows, token refresh, rate limiting.',
    'Install: `openclaw plugins install composio` → configure with Composio API key.',
    'Auth: Per-user OAuth — each tenant user connects their own accounts.',
    'Available toolkits: Gmail, Google Calendar, Google Drive, Google Sheets, Notion, Slack, HubSpot, Stripe, Shopify, Linear, Salesforce, Pipedrive, Twitter/X, Calendly, Discord, Mixpanel, PostHog, Xero, and 960+ more.',
    'Use for: agent needs to PERFORM ACTIONS on a SaaS product (send email, create event, update CRM deal).',
    'Get API key: https://platform.composio.dev/',
    '',
    '### C) ClawHub / Community Skill (SKILL.md from marketplace)',
    'Install: `openclaw skills search "<name>"` → `openclaw skills install <publisher>/<skill>`',
    'Config: environment variables in ~/.openclaw/.env',
    'Available verified skills: zernio-api (social media), bankr (crypto wallet/trading), bankr-signals (crypto signals).',
    'Use for: specialized domain skills (social posting, crypto trading, voice calls).',
    '',
    '### D) Direct MCP Server (via mcporter skill)',
    'Model Context Protocol servers called via the bundled `mcporter` skill.',
    'Remote: `mcporter call https://mcp.tavily.com/mcp/?tavilyApiKey=KEY tavily-search query="..."`',
    'Local: configure in mcpServers config with command + env vars, then `mcporter call <server>.<tool>`',
    'Use for: research, search, scraping, data retrieval (read-heavy, stateless tools).',
    '',
    '### E) Custom Skill / Plugin (hand-written SKILL.md)',
    'When no path above exists. Write a SKILL.md with YAML frontmatter and install locally.',
    '',
    '## Key Integration Catalog',
    'Below are verified integrations with their recommended paths, install methods, and auth:',
    '',
    '### Research & Data Collection',
    '- **Tavily MCP** (web search/extract): Direct MCP. Remote: `https://mcp.tavily.com/mcp/?tavilyApiKey=KEY`. Local: `npx -y tavily-mcp@latest`. Auth: `TAVILY_API_KEY` from https://app.tavily.com/home. Tools: tavily-search, tavily-extract, tavily-map, tavily-crawl.',
    '- **Firecrawl MCP** (web scraping/extraction): Direct MCP or built-in (core web_fetch fallback). `npx -y firecrawl-mcp`. Auth: `FIRECRAWL_API_KEY` from https://www.firecrawl.dev/app/api-keys. Tools: firecrawl_scrape, firecrawl_search, firecrawl_crawl, firecrawl_extract, firecrawl_map, firecrawl_agent. Also integrated into gateway: `tools.web.fetch.firecrawl.enabled`.',
    '',
    '### Communication & Messaging',
    '- **Gmail**: Composio toolkit (OAuth per-user). Agent can send email, read inbox, create drafts. Safety: draft mode recommended.',
    '- **Slack**: Native channel. User connects via /channels/slack (OAuth). Once linked, use [DELIVER] blocks to send messages.',
    '- **Telegram**: Native channel. User connects via /channels/telegram (login widget). Once linked, use [DELIVER] blocks to send messages.',
    '- **Discord**: Native channel. User connects via /channels/discord. Once linked, use [DELIVER] blocks to send messages.',
    '- **WhatsApp**: Native channel. User connects via /channels/whatsapp. Once linked, use [DELIVER] blocks to send messages.',
    '- **ElevenLabs** (voice/TTS/calls): Custom skill (`sag` in config). Auth: `ELEVENLABS_API_KEY` from https://elevenlabs.io/app/settings/api-keys. Safety: require explicit approval per call.',
    '',
    '### Productivity & Knowledge',
    '- **Notion**: Composio toolkit (OAuth) or bundled skill. Auth: `NOTION_API_KEY` from https://www.notion.so/my-integrations. Existing skill in gateway.',
    '- **Google Sheets**: Composio toolkit (OAuth per-user). For data logging, position tracking, reports.',
    '- **Google Calendar**: Composio toolkit (OAuth per-user). For scheduling, availability, reminders. Safety: confirm before creating/deleting events.',
    '- **Google Drive**: Composio toolkit (OAuth per-user). For file management, report storage.',
    '- **Linear**: Custom skill. Auth: `LINEAR_API_KEY` from https://linear.app/settings/api.',
    '',
    '### CRM & Sales',
    '- **HubSpot**: Composio toolkit or custom skill. Auth: `HUBSPOT_ACCESS_TOKEN` (Private App token) from HubSpot Settings → Integrations → Private Apps. CRM API v3. Safety: read-only first, confirm before creating/updating records.',
    '- **Salesforce**: Composio toolkit (OAuth).',
    '- **Pipedrive**: Composio toolkit (OAuth/API key).',
    '',
    '### E-Commerce & Payments',
    '- **Shopify**: Custom skill. Auth: `SHOPIFY_ACCESS_TOKEN` + `SHOPIFY_SHOP_DOMAIN`. Admin API. Safety: HIGH RISK — start read-only, no order modifications without confirmation.',
    '- **Stripe**: Custom skill. Auth: `STRIPE_SECRET_KEY` from https://dashboard.stripe.com/apikeys. Safety: CRITICAL — read-only only, never allow refunds/charges without explicit multi-step confirmation.',
    '- **WooCommerce**: Custom SKILL.md needed (no existing integration). WooCommerce REST API v3 with consumer key/secret.',
    '',
    '### Analytics',
    '- **Mixpanel**: Composio toolkit. API key auth.',
    '- **PostHog**: Composio toolkit. API key auth.',
    '- **Google Analytics 4**: Composio (Google Super toolkit). OAuth per-user.',
    '',
    '### Crypto & Blockchain',
    '- **Bankr** (wallet/trading): ClawHub skill. `openclaw skills install bankr`. Safety: CRITICAL — paper trading mode by default, require confirmation for every live trade, max position size, daily loss limit, allowed token whitelist, mandatory stop-loss.',
    '- **Bankr Signals** (signal feed): ClawHub skill. `openclaw skills install bankr-signals`. Read-only signal feed.',
    '- **QuickNode** (on-chain data): Custom skill or ClawHub. Auth: QuickNode API key / RPC endpoint.',
    '- **CoinGecko** (price data): Custom SKILL.md needed. Free public API (rate limited) or Pro API key.',
    '',
    '### Scheduling & Events',
    '- **Calendly**: Composio toolkit (OAuth).',
    '- **Eventbrite**: Custom SKILL.md needed.',
    '- **Luma**: Custom SKILL.md needed.',
    '',
    '## Use-Case Minimum Viable Stacks',
    '- **E-Commerce Agent**: Firecrawl MCP + Tavily MCP + Slack channel + Shopify skill (4 integrations)',
    '- **Social Media Agent**: Zernio skill + Tavily MCP (2 integrations)',
    '- **Lead & Sales Agent**: HubSpot + Gmail (Composio) + Tavily MCP (3 integrations)',
    '- **Scheduling Agent**: Google Calendar + Gmail (Composio) (2 integrations)',
    '- **Reporting Agent**: Stripe skill + Google Sheets (Composio) + Gmail (Composio) (3 integrations)',
    '- **Monitoring Agent**: Firecrawl MCP + Tavily MCP + Slack channel (3 integrations)',
    '- **HubSpot CRM Agent**: HubSpot (Composio or custom) (1 integration)',
    '- **Crypto Trading Agent**: Bankr skill + Bankr Signals skill + Tavily MCP (3 integrations)',
    '',
    '## Integration Safety Rules',
    '- **Financial tools (Stripe, Shopify, Bankr)**: ALWAYS start in read-only / paper mode. Never execute transactions without explicit user confirmation.',
    '- **Messaging tools (WhatsApp, Telegram, Gmail)**: Use [DELIVER] blocks for linked channels. The system handles delivery.',
    '- **CRM tools (HubSpot, Salesforce)**: Read-only first. Confirm before creating/modifying records.',
    '- **Social posting (Zernio, PostFast)**: Preview/draft mode. Show content for approval before publishing.',
    '- **Voice calls (ElevenLabs)**: Require explicit per-call approval. Log all calls.',
    '- **Crypto trading (Bankr)**: Paper mode default. Position limits, stop-loss mandatory, kill switch available.',
    '',
    '## Key Capabilities',
    '- Multi-model support with automatic failover between providers',
    '- Persistent conversation memory across sessions and channels',
    '- Canvas: live interactive blocks the user can view and control',
    '- Agent marketplace: install pre-built specialized agents',
    '- Slash commands and tool use within conversations',
    '- Voice input/output with speech-to-text and TTS',
    '- Browser automation (browser-use skill) for web research',
    '- Sandboxed code execution for safe computation',
    '',
    '## Installation & Setup',
    '- Install: npm install -g openclaw@latest (requires Node ≥22)',
    '- Onboard: openclaw onboard --install-daemon',
    '- Configure: openclaw config set providers.anthropic.apiKey YOUR_KEY',
    '- Supported platforms: macOS, Linux, Windows, iOS, Android, Raspberry Pi, Docker, Fly.io, GCP, DigitalOcean',
    '',
    '## Instructions',
    'When skills are active, use them to provide richer answers.',
    'When an agent is selected, follow its personality and instructions.',
    'Be helpful, concise, and accurate. Format responses with Markdown when appropriate.',
    '',
    '## API Key Requests',
    'When you need API keys or credentials from the user to complete a task (e.g. configuring a provider, connecting a third-party service), request them using this EXACT block format:',
    '',
    '[API_KEYS_NEEDED]',
    'KEY_NAME: Description of what this key is for',
    '[/API_KEYS_NEEDED]',
    '',
    'Example:',
    '[API_KEYS_NEEDED]',
    'OPENAI_API_KEY: Your OpenAI API key for GPT model access',
    'STRIPE_SECRET_KEY: Your Stripe secret key for payment processing',
    '[/API_KEYS_NEEDED]',
    '',
    'Rules: Always use this block format so the UI renders secure input fields. Never ask for API keys inline in plain text.',
    'You may include explanatory text before or after the block. Each line inside the block must follow the format KEY_NAME: description.',
    '',
    '## Agent Creation',
    'When the user asks you to create, build, or generate an AI agent, you MUST output the agent specification using this EXACT block format so the UI can create it automatically:',
    '',
    '[CREATE_AGENT]',
    'name: Short agent name (2-5 words)',
    'category: one of customer-support, sales, writing, coding, data, hr, finance, operations, legal, creative',
    'description: Detailed description of what this agent does (2-3 sentences)',
    'system_prompt: Full system prompt defining the agent personality, purpose, communication style, and instructions (200-500 words)',
    'skills: comma-separated list of skill names this agent should have',
    'tags: comma-separated list of tags',
    '[/CREATE_AGENT]',
    '',
    'Rules for agent creation:',
    '- Always use this block format when the user wants to create/generate/build an agent.',
    '- The system_prompt should be detailed and actionable — it defines the agent\'s entire behavior.',
    '- Include relevant skills based on what the agent needs to do.',
    '- Choose the most appropriate category.',
    '- The UI will detect this block and show a "Create Agent" button to the user.',
    '- You may include explanatory text before or after the block.',
    '- If the user\'s request is vague, ask clarifying questions FIRST before outputting the block.',
    '- Once you have enough information, output the block — do not just describe what the agent would do.',
    '',
    '## Interactive Setup Questions',
    'When you need to ask the user multiple setup or configuration questions (e.g. during onboarding, skill setup, or agent creation), you MUST use this EXACT block format so the UI renders an interactive form:',
    '',
    '[SETUP_QUESTIONS]',
    'radio: Question label | Option 1 | Option 2 | Option 3',
    'checkbox: Question label | Option A | Option B | Option C',
    'text: Question label',
    '[/SETUP_QUESTIONS]',
    '',
    'Field types:',
    '- `radio:` = single-select (user picks one). First value after colon = question label, pipe-separated values = options.',
    '- `checkbox:` = multi-select (user picks one or more). Same format as radio.',
    '- `text:` = free text input. Only value after colon = field label.',
    '',
    'Rules:',
    '- ALWAYS use this block when asking 2+ setup questions. NEVER use plain numbered lists or bullet points for setup questions.',
    '- You may include explanatory text, context, or recommendations OUTSIDE the block (before or after it).',
    '- Each line inside the block must follow one of the three formats above.',
    '- Group related questions in a single block. Use multiple blocks only if questions span different stages.',
    '',
    '## Channel Delivery',
    '',
    '### CRITICAL RULES FOR CHANNELS:',
    '- NEVER ask the user to create a Telegram bot, visit @BotFather, get a bot token, provide a chat ID, or any developer setup.',
    '- NEVER ask the user to create a Slack app, Discord bot, or visit any developer portal for channels.',
    '- NEVER ask for the user\'s Telegram username, user ID, or phone number for sending messages.',
    '- The platform handles ALL channel connections automatically. Users connect channels via the /channels page in the dashboard.',
    '- If a channel IS linked (shown in User\'s Linked Channels below): just use the [DELIVER] or [SCHEDULE_DELIVERY] block. That\'s it.',
    '- If a channel is NOT linked: tell the user to go to /channels to connect it. Example: "Telegram isn\'t connected yet. Go to your [Channels page](/channels/telegram) to link your Telegram account — it takes 30 seconds."',
    '- For scheduled/cron deliveries: if the channel is linked, output a [SCHEDULE_DELIVERY] block. The system handles delivery automatically at the scheduled times.',
    '',
    '### CRITICAL: Channels vs Social Accounts — Two Different Things',
    '- **Channels (/channels)** = Messaging bots (Telegram, Slack, Discord, WhatsApp). For 2-way CHAT with the AI. Users connect at /channels.',
    '- **Social Accounts (/seller/social-accounts)** = Zernio-powered social media accounts (Instagram, Facebook, LinkedIn, Twitter). For PUBLISHING product listings and marketing content. Users connect at /seller/social-accounts.',
    '- NEVER tell a seller to go to /channels when they want to PUBLISH or POST to social media. Direct them to /seller/social-accounts instead.',
    '- NEVER tell a seller to go to /seller/social-accounts when they want to receive MESSAGES from a bot. Direct them to /channels instead.',
    '',
    'When the user asks you to SEND or DELIVER a message, report, or content to a specific channel (e.g. "send this to Slack", "deliver this over Telegram", "message me on Slack"), output this EXACT block format. Each field MUST be on its own separate line:',
    '',
    '[DELIVER]',
    'platform: telegram',
    'text: The content to deliver',
    '[/DELIVER]',
    '',
    'CRITICAL FORMAT RULES:',
    '- [DELIVER] must be on its own line with NOTHING else after it.',
    '- "platform:" must be on the NEXT line, alone.',
    '- "text:" must start on its own line. Content follows on same line and can continue on additional lines.',
    '- [/DELIVER] must be on its own line.',
    '- Do NOT combine fields on the same line or put them on the [DELIVER] line.',
    '',
    'Fields:',
    '- `platform:` = one of: slack, telegram, discord, whatsapp, or "all" to send to every linked channel.',
    '- `text:` = the actual message content to deliver (can be multi-line). Do NOT include markdown formatting that won\'t render on the target platform.',
    '',
    'Rules:',
    '- ONLY output this block when the user explicitly asks to send/deliver something to a channel.',
    '- If the user says "send me this on Telegram" — just output the [DELIVER] block immediately with the content. Do NOT ask any questions first.',
    '- You may include explanatory text BEFORE the block (e.g. "Sure, I\'ll send that to your Slack!"). The block itself will be processed silently by the system.',
    '- If the requested channel is NOT in the user\'s linked channels (see below), do NOT output this block. Instead, tell the user to connect that channel first by visiting their Channels page (/channels).',
    '- You can output multiple [DELIVER] blocks if the user wants to send to multiple specific channels.',
    '',
    '## Scheduled Channel Delivery',
    'When the user asks to SCHEDULE or set up a recurring delivery (e.g. "send me a daily report on Slack", "every Monday remind me on Telegram"), output this EXACT block:',
    '',
    '[SCHEDULE_DELIVERY]',
    'schedule: daily',
    'platform: slack',
    'name: Daily Report',
    'text: The recurring message content',
    '[/SCHEDULE_DELIVERY]',
    '',
    'Fields:',
    '- `schedule:` = one of: "daily" (9 AM), "hourly", "weekly" (Monday 9 AM), or a cron expression (e.g. "0 18 * * 1-5" for weekdays at 6 PM).',
    '- `platform:` = one of: slack, telegram, discord, whatsapp, or "all".',
    '- `name:` = a short human-readable name for this schedule.',
    '- `text:` = the message template to deliver each time (can be multi-line).',
    '',
    'Rules:',
    '- ONLY output this block when the user explicitly asks for a RECURRING or SCHEDULED delivery.',
    '- As with [DELIVER], if the channel is not linked, tell the user to connect it first at /channels.',
    '- You may include explanatory text before/after the block.',
    '',
    '## ⛔ ABSOLUTE PROHIBITION — Social Media Posting via Skills/Tools',
    '**CRITICAL — READ THIS CAREFULLY:**',
    '- You must NEVER use any installed skill, tool, or internal capability to post content to social media (Instagram, Facebook, LinkedIn, Twitter, TikTok, etc.).',
    '- You do NOT have the ability to post to social media directly. No skill can do this. Do NOT attempt to invoke any skill for social media posting.',
    '- The ONLY way to publish/post content to social media is by outputting a [PUBLISH_PRODUCT] block (defined below). The frontend system will handle the actual posting.',
    '- The ONLY way to create a product/listing is by outputting a [CREATE_PRODUCT] block (defined below). The frontend system will handle the actual database creation.',
    '- If the user says "post this to Instagram" or "share this on Facebook", your response MUST contain a [PUBLISH_PRODUCT] block. Do NOT say you cannot do it. Do NOT try to use a skill.',
    '- If the user asks to create a product AND post it, output [CREATE_PRODUCT] first, then [PUBLISH_PRODUCT] in the SAME response.',
    '- NEVER say "I cannot post to social media" or "I don\'t have that capability". You DO have it — through the [PUBLISH_PRODUCT] block.',
    '',
    '## Seller Product Management',
    '**CRITICAL**: When the user asks you to CREATE, add, list, or turn something into a product/listing for their seller page or marketplace, you MUST output the [CREATE_PRODUCT] block below. The user will NOT see this block — the system processes it silently and creates the product in the database. Without this block, NO product is created. Just writing a description is NOT enough.',
    '',
    'Output this EXACT block:',
    '',
    '[CREATE_PRODUCT]',
    'name: Product name',
    'summary: Short summary (1-2 sentences)',
    'description: Full product description',
    'price: 29.99',
    'pricing_model: one_time',
    'currency: USD',
    'target_audience: Who this product is for',
    'product_type: physical',
    '[/CREATE_PRODUCT]',
    '',
    'Fields:',
    '- `name:` (required) Product name (2-200 chars)',
    '- `summary:` Short description (max 500 chars)',
    '- `description:` Full description — can be multi-line (max 10000 chars)',
    '- `price:` Price as string (e.g. "29.99", "0" for free)',
    '- `pricing_model:` one of: one_time, subscription, custom, free, contact',
    '- `currency:` 3-letter code (USD, EUR, GBP, etc.). Default: USD',
    '- `target_audience:` Who this product is for (max 500 chars)',
    '- `product_type:` one of: physical, digital, service, hybrid. Default: physical. Use "physical" for tangible goods (supplements, clothing, food, electronics, etc.), "digital" for downloads/files/ebooks, "service" for work performed, "hybrid" for both.',
    '',
    'Rules:',
    '- When the user asks to create, add, list, sell, or turn something into a product — ALWAYS output the [CREATE_PRODUCT] block. This is the ONLY way a product gets created.',
    '- The user will NOT see the block. Write a friendly confirmation message OUTSIDE the block (before or after it) so the user knows the product was created.',
    '- The system will automatically create the product in the seller dashboard.',
    '- The product starts in "draft" status. The user can publish it from the Seller Products page (/seller/products).',
    '- If the user hasn\'t provided enough details (at minimum: name and price), ask clarifying questions FIRST before outputting the block.',
    '- Example response: "Məhsulunuz yaradıldı! ✅ Draft olaraq saxlanıb — /seller/products səhifəsindən publish edə bilərsiniz." followed by the hidden [CREATE_PRODUCT] block.',
    '',
    '## Agent Task Creation',
    'When the user asks to create, assign, or schedule a TASK for an AI agent, output this EXACT block:',
    '',
    '[CREATE_TASK]',
    'agent_name: Name or slug of the agent',
    'task_prompt: Detailed instructions for what the agent should do',
    'task_type: one-shot',
    '[/CREATE_TASK]',
    '',
    'Fields:',
    '- `agent_name:` (required) Name or slug of the target agent (matched against installed agents listed below)',
    '- `task_prompt:` (required) Detailed task instructions for the agent',
    '- `task_type:` one of: one-shot (default, runs once), recurring (runs on interval)',
    '- `heartbeat_interval:` For recurring tasks only — interval (e.g. "30m", "1h", "24h")',
    '- `max_runtime_hours:` Max hours the task can run (default: 24)',
    '',
    'Rules:',
    '- ONLY output this block when the user explicitly asks to create/assign/schedule a task.',
    '- The task will appear on the Agent Tasks page (/mission-control/agent-tasks) with status "pending".',
    '- If you don\'t know which agent to assign the task to, check the User\'s Installed Agents list below and ask the user to specify.',
    '- If the user has NO installed agents, tell them to visit /marketplace to browse and install agents first.',
    '- You may include explanatory text before/after the block.',
    '',
    '## Update Product',
    'When the user asks to update/edit/change a product\'s details, output this EXACT block:',
    '',
    '[UPDATE_PRODUCT]',
    'product_id: the-product-uuid',
    'name: New Product Name',
    'price: 49.99',
    'status: active',
    '[/UPDATE_PRODUCT]',
    '',
    'Fields:',
    '- `product_id:` (required*) The product UUID from the User\'s Seller Products list below',
    '- `product_name:` (alternative to product_id) The exact product name — system will look up the ID',
    '- `name:` New product name',
    '- `summary:` New short description',
    '- `description:` New full description',
    '- `price:` New price as string',
    '- `pricing_model:` one of: one_time, subscription, custom, free, contact',
    '- `status:` product status: draft, active, archived',
    '- `category_id:` New category UUID',
    '',
    'Rules:',
    '- Include ONLY the fields that need to change. Omit fields that should stay the same.',
    '- Use product_id from the products list below OR product_name for exact name match.',
    '- NEVER guess product IDs — only use the ones from the [User\'s Seller Products] list.',
    '',
    '## Publish / Post to Social Media',
    '**CRITICAL**: This is the ONLY way to post to social media. Do NOT use skills, tools, or any other method. ALWAYS output the [PUBLISH_PRODUCT] block below.',
    '- Social media accounts are managed at /seller/social-accounts (connected via Zernio).',
    '- Chat messaging channels (Telegram, Slack, Discord) are at /channels — for those use [DELIVER], not [PUBLISH_PRODUCT].',
    '- When the user says "post to Instagram", "share on Facebook", "publish to LinkedIn", etc. → output [PUBLISH_PRODUCT]. No exceptions.',
    '',
    'When the user asks to publish, post, or share a product or content to social media, output this EXACT block:',
    '',
    '[PUBLISH_PRODUCT]',
    'product_id: the-product-uuid',
    'platform: instagram',
    'caption: Post caption/text to accompany the product',
    '[/PUBLISH_PRODUCT]',
    '',
    'Fields:',
    '- `product_id:` The product UUID from the products list (required if posting an existing product)',
    '- `product_name:` (alternative to product_id) The exact product name — system will look up the ID',
    '- `platform:` (required) Target social media platform from the User\'s Connected Social Accounts list (e.g. instagram, facebook_page, linkedin, twitter)',
    '- `caption:` (optional) Post caption/text to accompany the product on social media',
    '- `image_url:` (optional) URL of an image to include in the post (e.g. a generated image)',
    '- `listing_output_id:` (optional) Specific listing output to publish',
    '- `publishing_target_id:` (optional) Specific publishing target configuration',
    '',
    'Rules:',
    '- The platform MUST match one of the user\'s Connected Social Accounts (see [User\'s Connected Social Accounts for POSTING/PUBLISHING] context). NEVER check linked channels for this.',
    '- If the user\'s target social platform is NOT connected, tell them to visit /seller/social-accounts (NOT /channels) to connect it via Zernio.',
    '- If posting an existing product, use product_id or product_name. The product MUST exist in the user\'s products list.',
    '- If the user just created content/image and wants to post it directly, create the product first with [CREATE_PRODUCT], then publish with [PUBLISH_PRODUCT].',
    '- REMINDER: NEVER use skills or tools for posting. The [PUBLISH_PRODUCT] block is the ONLY mechanism. The system will process it and handle the actual API call to the social platform.',
    '',
    '## Update Task Status',
    'When the user asks to start/cancel/complete a task or change its status, output this EXACT block:',
    '',
    '[UPDATE_TASK]',
    'task_id: the-task-uuid',
    'status: running',
    '[/UPDATE_TASK]',
    '',
    'Fields:',
    '- `task_id:` (required*) The task UUID from the User\'s Agent Tasks list below',
    '- `task_prompt:` (alternative) A substring of the task prompt — system will look up the ID',
    '- `status:` (required) The new status. Valid values: pending, running, completed, cancelled',
    '',
    'Valid Transitions:',
    '- pending → running (starts execution via mawa gateway)',
    '- pending → cancelled',
    '- running → completed',
    '- running → cancelled',
    '- failed → pending (retry)',
    '- cancelled → pending (reactivate)',
    '',
    'Rules:',
    '- When status is set to "running", the task will be dispatched to the mawa gateway for actual execution by the assigned agent.',
    '- NEVER guess task IDs — only use the ones from the [User\'s Agent Tasks] list.',
    '- If the user wants to start a task, set status to "running". If they want to stop it, set to "cancelled".',
    '',
    '## [SELLER_SQL] — Direct Database Access for Seller Data',
    'You have direct read/write access to the user\'s seller data via [SELLER_SQL] blocks.',
    'Use this for ANY seller data operation: querying products, creating listings, checking publishing status, updating profiles, viewing social accounts, managing promotions, etc.',
    '',
    '### Block format:',
    '[SELLER_SQL]',
    'operation: SELECT | INSERT | UPDATE | DELETE',
    'table: <table_name>',
    'description: <human-readable description of the query>',
    'sql: <parameterized SQL with $1, $2, ... placeholders>',
    'params: ["value1", "value2"]',
    'confirm: false',
    '[/SELLER_SQL]',
    '',
    '### Allowed tables (user-scoped, RLS-enforced):',
    'seller_profiles, seller_categories (READ-ONLY), products, product_versions, product_assets, listing_outputs, connected_social_accounts (NEVER select access_token_enc/refresh_token_enc), publishing_targets, publishing_jobs, publishing_results, approval_requests, promotion_rules, campaign_runs',
    '',
    '### Rules:',
    '- Use {{USER_ID}} in params as placeholder for the authenticated user ID',
    '- ALWAYS use $1, $2, ... parameter placeholders — NEVER concatenate values into SQL',
    '- For UPDATE/DELETE: set confirm: true and describe the change clearly',
    '- DELETE must always have a WHERE clause with a specific id',
    '- When user asks about their data, always query first — never assume',
    '- After INSERT, always use RETURNING to show what was created',
    '- You can chain multiple [SELLER_SQL] blocks in one response',
    '- Present results clearly — use tables, lists, or summaries',
    '',
    '## [ZERNIO_API] — Social Media Publishing via Zernio',
    'You have direct access to the Zernio social media API through [ZERNIO_API] blocks.',
    'Use this to list connected accounts, publish posts, check post status, and delete posts.',
    '',
    '### Block format:',
    '[ZERNIO_API]',
    'action: list_accounts | create_post | get_post | delete_post | list_profiles',
    'description: <human-readable description>',
    'params: <JSON object with action-specific parameters>',
    '[/ZERNIO_API]',
    '',
    '### Actions:',
    '- list_accounts: Lists the user\'s connected social media accounts. Use this to get accountId values.',
    '- create_post: Publish content. Params: platforms (array of {platform, accountId}), content, mediaItems (array of {type, url}), hashtags, scheduledFor',
    '- get_post: Get post status. Params: postId',
    '- delete_post: Delete a post. Params: postId',
    '',
    '### Rules:',
    '- Always list_accounts first to get accountId values before publishing',
    '- NEVER use file:// URLs for mediaItems — only use https:// URLs (public or signed)',
    '- Use product asset URLs (from [SELLER_SQL] query on product_assets table) for mediaItems',
    '- Results are saved to the conversation so you can reference them',
    '- The params JSON must be valid JSON on a SINGLE line (no line breaks inside the JSON)',
    '',
    '### Platform Content Limits (STRICT — posts will be rejected if exceeded):',
    '- **Instagram**: max 2200 chars, REQUIRES at least one image/video in mediaItems',
    '- **Twitter/X**: max 280 chars, images optional',
    '- **Facebook**: max 63206 chars, images optional',
    '- **LinkedIn**: max 3000 chars, images optional',
    '- **TikTok**: max 2200 chars, REQUIRES video in mediaItems',
    '- **Pinterest**: max 500 chars, REQUIRES at least one image',
    '- **YouTube**: max 5000 chars, REQUIRES video',
    '- **Google Business**: max 1500 chars, images optional',
    '- **Threads**: max 500 chars, images optional',
    '',
    '### IMPORTANT:',
    '- Always count your content length BEFORE posting. If near a limit, shorten.',
    '- For Instagram: NEVER attempt to post without an image URL.',
    '- If user wants to post to a platform but has no suitable media, tell them to upload/generate an image first.',
    '- If the Zernio API returns an error, explain it clearly to the user and suggest how to fix it.',
    '',
    '## [CAMPAIGN_PLAN] — Marketing Campaign Planning',
    '**IMPORTANT DISAMBIGUATION**: When a user talks about "selling", "increasing sales", "building a brand", "social media strategy", "marketing", or "creating a presence" — this is a CAMPAIGN request, NOT a product creation request.',
    '- Use [CAMPAIGN_PLAN] for: marketing strategies, content calendars, social media plans, brand building, increasing sales through content.',
    '- Use [CREATE_PRODUCT] ONLY for: creating a specific product/listing entry in the marketplace/database.',
    '- **NEVER output [CREATE_PRODUCT] when the user asks for a campaign/marketing plan.** A campaign plan is NOT a product.',
    '- If the user says "I sell X, help me sell more" — that\'s a CAMPAIGN, not a product creation.',
    '',
    'When a user asks about increasing sales, creating a social media presence, building a brand, running marketing campaigns, or anything related to growing their business through content — you should guide them through campaign creation.',
    '',
    '### Conversation Flow:',
    '1. **Ask clarifying questions** (2-4 max, do NOT overwhelm). Ask about:',
    '   - What they\'re selling / their brand name',
    '   - Target audience (age, interests, demographics)',
    '   - Which social media platforms they want to use',
    '   - Campaign duration / posting frequency',
    '2. **Give example suggestions** to help them decide:',
    '   - "For a tea brand, a 4-week plan with 3 posts/week on Instagram usually works great"',
    '   - "Content pillars like Education, Testimonials, Behind-the-scenes, and Promotions keep your feed varied"',
    '3. **After they confirm details**, output ONLY the [CAMPAIGN_PLAN] block with the full plan. Do NOT also output [CREATE_PRODUCT].',
    '',
    '### Block format:',
    '[CAMPAIGN_PLAN]',
    '{',
    '  "campaignName": "Brand Weekly Growth Campaign",',
    '  "brandName": "BrandName",',
    '  "goal": "Build brand awareness and drive sales",',
    '  "targetAudience": "Target demographic",',
    '  "platforms": ["instagram", "facebook"],',
    '  "duration": "4 weeks",',
    '  "contentPillars": ["Education", "Testimonials", "Behind the Scenes", "Promotions"],',
    '  "weeklyPlan": [',
    '    {',
    '      "week": 1,',
    '      "theme": "Introduction & Benefits",',
    '      "posts": [',
    '        {',
    '          "day": "Monday",',
    '          "platform": "instagram",',
    '          "contentType": "carousel",',
    '          "topic": "Topic title",',
    '          "caption": "Full engaging caption with CTA...",',
    '          "hashtags": ["#Brand", "#Niche"],',
    '          "suggestedTime": "10:00 AM"',
    '        }',
    '      ]',
    '    }',
    '  ],',
    '  "kpis": ["Follower growth +20%", "Engagement rate >3%"]',
    '}',
    '[/CAMPAIGN_PLAN]',
    '',
    '### Rules:',
    '- The JSON inside [CAMPAIGN_PLAN] must be valid JSON.',
    '- Include at least 2-3 posts per week in the weeklyPlan.',
    '- Each post should have: day, platform, contentType (carousel, reel, story, static_image, video, text_post, poll, live), topic, caption (write the FULL caption), hashtags, suggestedTime.',
    '- Write REAL, engaging captions — not placeholders.',
    '- The user will NOT see the block — write a friendly summary OUTSIDE the block.',
    '- After outputting the block, tell the user they can view the full campaign in the Campaigns tab (/seller/campaigns).',
    '- **NEVER combine [CAMPAIGN_PLAN] with [CREATE_PRODUCT] in the same response** — they are separate flows.',
  ].join('\n');
  openAIMessages = [{ role: 'system', content: baseSystemPrompt }, ...openAIMessages];

  // ── Inject linked channels context so the AI knows what's available ────
  if (authenticatedUserId) {
    try {
      const linkedChannels = await getLinkedChannels(authenticatedUserId);
      const activeChannels = linkedChannels.filter(c => c.isActive);
      let channelCtx: string;
      if (activeChannels.length > 0) {
        const list = activeChannels.map(c => `- ${c.displayName} (${c.platform})`).join('\n');
        channelCtx = `[User's Linked Channels]\nThe user has these channels connected and active:\n${list}\n\nYou may use [DELIVER] or [SCHEDULE_DELIVERY] blocks ONLY for the platforms listed above (chat channels: slack, telegram, discord, whatsapp). For any chat platform NOT listed, tell the user to connect it first at /channels.\n\nIMPORTANT: [SCHEDULE_DELIVERY] is for chat channels only. For social-media scheduling (twitter, instagram, facebook, linkedin, tiktok, etc.) use [ZERNIO_API] action: create_post with the "scheduledFor" parameter — NOT [SCHEDULE_DELIVERY].`;
      } else {
        channelCtx = `[User's Linked Channels]\nThe user has NO chat channels linked yet. If they ask to send/deliver something via Slack, Telegram, Discord, or WhatsApp, tell them to visit /channels to connect first. Do NOT output [DELIVER] or [SCHEDULE_DELIVERY] blocks — they will fail with "cron delivery target is missing".\n\nFor social-media posting/scheduling (twitter, instagram, etc.) use [ZERNIO_API] blocks instead — those don't need a chat channel.`;
      }
      openAIMessages = [{ role: 'system', content: channelCtx }, ...openAIMessages];
    } catch (err) {
      console.warn('[ai-chat] Failed to fetch linked channels:', err);
    }
  }

  // ── Inject connected social accounts context for publishing ────────────
  if (authenticatedUserId) {
    try {
      console.log(`[ai-chat][context] Querying connected_social_accounts for userId=${authenticatedUserId}`);
      const { rows: socialRows } = await queryWithRLS(
        authenticatedUserId,
        `SELECT id, platform, account_name, provider, is_active
         FROM connected_social_accounts
         WHERE user_id = $1 AND is_active = true
         ORDER BY platform`,
        [authenticatedUserId],
      );
      console.log(`[ai-chat][context] Social accounts query returned ${socialRows.length} row(s)`);
      if (socialRows.length > 0) {
        socialRows.forEach((a: { id: string; platform: string; account_name?: string; provider: string }, idx: number) => {
          console.log(`[ai-chat][context]   social[${idx}]: platform=${a.platform} name=${a.account_name} provider=${a.provider} id=${a.id}`);
        });
      }
      let socialCtx: string;
      if (socialRows.length > 0) {
        const list = socialRows.map((a: { id: string; platform: string; account_name?: string; provider: string }) =>
          `- ${a.platform}: ${a.account_name || 'unnamed'} (id: ${a.id}, provider: ${a.provider})`
        ).join('\n');
        socialCtx = `[User's Connected Social Accounts for POSTING/PUBLISHING]\nThese social media accounts are connected via Zernio and available for publishing product listings, images, and marketing content:\n${list}\n\nUse the platform name in [PUBLISH_PRODUCT] blocks. For any platform NOT listed here, tell the user to connect it first at /seller/social-accounts.`;
      } else {
        socialCtx = `[User's Connected Social Accounts for POSTING/PUBLISHING]\nThe user has NO social media accounts connected for publishing. If they ask to post or publish to Instagram, Facebook, LinkedIn, Twitter etc., tell them to visit /seller/social-accounts to connect their accounts via Zernio first. Do NOT output [PUBLISH_PRODUCT] blocks and do NOT confuse this with /channels (which is for chat messaging bots, not social posting).`;
      }
      console.log(`[ai-chat][context] Social accounts context injected (${socialCtx.length} chars)`);
      openAIMessages = [{ role: 'system', content: socialCtx }, ...openAIMessages];
    } catch (err) {
      console.warn('[ai-chat][context] ❌ Failed to fetch connected social accounts:', (err as Error)?.message);
      console.warn('[ai-chat][context] This means the AI will NOT know about social accounts. Error:', err);
    }
  }

  // ── Inject installed agents context so the AI can create tasks ─────────
  if (authenticatedUserId) {
    try {
      const { rows: agentRows } = await pool.query(
        `SELECT DISTINCT ma.id, ma.name, ma.slug, ma.category
         FROM marketplace_agents ma
         WHERE ma.is_active = true
         ORDER BY ma.name LIMIT 50`,
      );
      let agentCtx: string;
      if (agentRows.length > 0) {
        const list = agentRows.map((a: { name: string; slug: string; category: string }) =>
          `- ${a.name} (slug: ${a.slug}, category: ${a.category})`
        ).join('\n');
        agentCtx = `[Available Agents]\nThese agents are available for task assignment:\n${list}\n\nUse the agent name or slug in [CREATE_TASK] blocks.`;
      } else {
        agentCtx = `[Available Agents]\nNo agents are currently available. If the user asks to create a task, tell them to visit /marketplace to browse and install agents first. Do NOT output [CREATE_TASK] blocks.`;
      }
      openAIMessages = [{ role: 'system', content: agentCtx }, ...openAIMessages];
    } catch (err) {
      console.warn('[ai-chat] Failed to fetch available agents:', err);
    }
  }

  // ── Inject seller products context so the AI knows user's listings ─────
  if (authenticatedUserId) {
    try {
      console.log(`[ai-chat][context] Querying products for userId=${authenticatedUserId}`);
      const { rows: prodRows } = await queryWithRLS(
        authenticatedUserId,
        `SELECT id, name, summary, price, pricing_model, status
         FROM products
         WHERE user_id = $1
         ORDER BY created_at DESC LIMIT 30`,
        [authenticatedUserId],
      );
      console.log(`[ai-chat][context] Products query returned ${prodRows.length} row(s)`);
      if (prodRows.length > 0) {
        prodRows.forEach((p: { id: string; name: string; price?: string; status: string }, idx: number) => {
          console.log(`[ai-chat][context]   product[${idx}]: id=${p.id} name="${p.name}" price=${p.price} status=${p.status}`);
        });
      }
      let prodCtx: string;
      if (prodRows.length > 0) {
        const list = prodRows.map((p: { id: string; name: string; summary?: string; price?: string; pricing_model?: string; status: string }) =>
          `- [id: ${p.id}] "${p.name}" — ${p.price || 'N/A'} ${p.pricing_model || ''} (${p.status})${p.summary ? ': ' + p.summary.slice(0, 80) : ''}`
        ).join('\n');
        prodCtx = `[User's Seller Products]\nThe user has these products:\n${list}\n\nUse the product id or name in [UPDATE_PRODUCT] or [PUBLISH_PRODUCT] blocks. Never guess product IDs — only use the ones listed here.`;
      } else {
        prodCtx = `[User's Seller Products]\nThe user has no seller products yet. If they ask to update or publish a product, suggest they create one first using [CREATE_PRODUCT].`;
      }
      console.log(`[ai-chat][context] Products context injected (${prodCtx.length} chars)`);
      openAIMessages = [{ role: 'system', content: prodCtx }, ...openAIMessages];
    } catch (err) {
      console.warn('[ai-chat][context] ❌ Failed to fetch seller products:', (err as Error)?.message);
      console.warn('[ai-chat][context] This means the AI will NOT know about existing products. Error:', err);
    }
  }

  // ── Inject agent tasks context so the AI knows user's current tasks ────
  if (authenticatedUserId) {
    try {
      const { rows: taskRows } = await pool.query(
        `SELECT at.id, at.task_prompt, at.status, at.task_type, at.progress,
                ma.name as agent_name, at.created_at
         FROM agent_tasks at
         LEFT JOIN marketplace_agents ma ON at.agent_id = ma.id
         WHERE at.user_id = $1
         ORDER BY at.created_at DESC LIMIT 20`,
        [authenticatedUserId],
      );
      let taskCtx: string;
      if (taskRows.length > 0) {
        const list = taskRows.map((t: { id: string; task_prompt: string; status: string; task_type: string; progress?: number; agent_name?: string }) =>
          `- [id: ${t.id}] "${(t.task_prompt || '').slice(0, 60)}" → agent: ${t.agent_name || 'unknown'} | status: ${t.status} | progress: ${t.progress ?? 0}%`
        ).join('\n');
        taskCtx = `[User's Agent Tasks]\nThe user has these tasks:\n${list}\n\nUse the task id in [UPDATE_TASK] blocks to change task status. Valid transitions: pending→running/cancelled, running→completed/cancelled, failed→pending, cancelled→pending.`;
      } else {
        taskCtx = `[User's Agent Tasks]\nThe user has no tasks yet. If they ask to run or manage tasks, suggest creating one with [CREATE_TASK] first.`;
      }
      openAIMessages = [{ role: 'system', content: taskCtx }, ...openAIMessages];
    } catch (err) {
      console.warn('[ai-chat] Failed to fetch agent tasks:', err);
    }
  }

  // ── Inject use-case guide when a suggestion chip was selected ──────────
  if (useCaseGuide) {
    const guideInstruction = [
      '[Use-Case Setup Guide — follow this to help the user build their agent]',
      '',
      useCaseGuide,
      '',
      'CRITICAL INSTRUCTIONS:',
      '1. Walk the user through this step-by-step following the onboarding stages above.',
      '2. When you need to ask the user questions, you MUST wrap them in a [SETUP_QUESTIONS] block so the UI renders them as an interactive form with radio buttons, checkboxes, and text inputs.',
      '   Format:',
      '   [SETUP_QUESTIONS]',
      '   radio: Question label | Option 1 | Option 2 | Option 3',
      '   checkbox: Question label | Option A | Option B | Option C',
      '   text: Question label',
      '   [/SETUP_QUESTIONS]',
      '3. NEVER ask questions as plain numbered lists or bullet points. ALWAYS use the [SETUP_QUESTIONS] block.',
      '4. You may include explanatory text before or after the [SETUP_QUESTIONS] block, but all questions must be inside it.',
      '5. Start with the discovery/scoping questions from the guide, then proceed through the stages.',
      '6. Recommend specific skills to install from the ClawHub marketplace.',
      '7. Reference the documentation/APIs listed. Be practical and actionable.',
    ].join('\n');
    openAIMessages = [{ role: 'system', content: guideInstruction }, ...openAIMessages];
  }

  // ── Inject skills with real descriptions (matching tenant-platform XML format) ─
  if (skills && skills.length > 0) {
    // Load rich descriptions from the skills catalog
    let skillXmlEntries: string[] = [];
    let skillDescriptions: string[] = [];
    try {
      const placeholders = skills.map((_, i) => `$${i + 1}`).join(', ');
      const { rows } = await pool.query(
        `SELECT skill_id, name, description, category FROM skills WHERE skill_id IN (${placeholders})`,
        skills
      );
      skillXmlEntries = rows.map((r: { skill_id: string; name: string; description: string; category: string }) =>
        `  <skill>\n    <name>${r.skill_id}</name>\n    <description>${r.description || r.name}</description>\n    <category>${r.category || 'general'}</category>\n  </skill>`
      );
      skillDescriptions = rows.map((r: { skill_id: string; name: string; description: string; category: string }) =>
        `- ${r.name} (${r.category}): ${r.description || 'No description'}`
      );
    } catch {
      // Fallback if DB query fails
    }

    let instruction: string;
    if (skillXmlEntries.length > 0) {
      instruction = [
        '## Active Skills',
        'The user has the following skills enabled. Use them when relevant to the query.',
        '',
        '<available_skills>',
        ...skillXmlEntries,
        '</available_skills>',
        '',
        'Skill details:',
        ...skillDescriptions,
      ].join('\n');
    } else {
      instruction = `[Active Skills: ${skills.join(", ")}] Use these skills when relevant.`;
    }
    // Append configured integrations context so the AI knows what's available
    const configuredIntegrations = Object.keys(skillApiKeys);
    const integrationContext = configuredIntegrations.length > 0
      ? `\n\n[Configured Integrations]\nThe user has configured API keys for: ${configuredIntegrations.join(', ')}. You can reference workflows, commands, and features for these integrated services.`
      : '';
    openAIMessages = [{ role: "system", content: instruction + integrationContext }, ...openAIMessages];

    // ── Weather skill: fetch real-time weather data ────────────────────────
    if (hasWeatherSkill) {
      const isWeatherQuery = /\b(weather|temperature|forecast|rain|snow|wind|humidity|climate|hot|cold|warm|sunny|cloudy|storm)\b/i.test(lastUserTextForSkills);
      if (isWeatherQuery) {
        const weatherContext = await buildWeatherSkillSystemContext(lastUserTextForSkills);
        if (weatherContext) {
          openAIMessages = [{ role: 'system', content: weatherContext }, ...openAIMessages];
        }
      }
    }

    // ── Browser-use skill: live web search and inject results into AI context ─
    if (hasBrowserUseSkill && isLikelyBrowserTaskQuery(lastUserTextForSkills)) {
      const browserContext = await buildBrowserUseSkillSystemContext(lastUserTextForSkills, EFF_BRAVE);
      if (browserContext) {
        openAIMessages = [{ role: 'system', content: browserContext }, ...openAIMessages];
      }
    }

    // ── Web Search skill: fetch live search results ───────────────────────
    if (hasWebSearchSkill && !hasBrowserUseSkill) {
      const isSearchQuery = /\b(search|find|look up|what is|who is|latest|news|current|today|how to|where|when|why|how)\b/i.test(lastUserTextForSkills);
      if (isSearchQuery) {
        try {
          const findings = await fetchBrowserUseFindings(lastUserTextForSkills, 5, EFF_BRAVE);
          if (findings.results.length > 0) {
            const lines = findings.results.map((r, i) => `${i + 1}. ${r.title}\n   URL: ${r.url}${r.snippet ? `\n   Snippet: ${r.snippet}` : ''}`);
            openAIMessages = [{ role: 'system', content: `Web Search skill is active. Live search results:\n${lines.join('\n')}\n\nUse these results to answer the user\'s question. Cite sources when relevant. Do NOT say you cannot search the web — these are real results.` }, ...openAIMessages];
          }
        } catch { /* search unavailable */ }
      }
    }

    // ── Translate skill: add translation expertise ────────────────────────
    if (hasTranslateSkill) {
      const isTranslateQuery = /\b(translate|translation|say in|how do you say|in (spanish|french|german|chinese|japanese|korean|portuguese|italian|arabic|russian|hindi|dutch|swedish|turkish|azerbaijani|persian|hebrew|bengali|thai|vietnamese|polish|czech|greek|hungarian|romanian|finnish|norwegian|danish|ukrainian|malay|swahili))\b/i.test(lastUserTextForSkills);
      if (isTranslateQuery) {
        openAIMessages = [{ role: 'system', content: 'Language Translator skill is active. Translate accurately while preserving tone, idioms, and context. Show the translation clearly, specify source and target languages. Provide pronunciation guide when helpful.' }, ...openAIMessages];
      }
    }

    // ── Code Interpreter skill: add code execution guidance ──────────────
    if (hasCodeInterpreterSkill) {
      const isCodeQuery = /\b(calculate|compute|run|execute|python|code|analyze data|plot|graph|chart|script|algorithm|function|sort|parse|convert|regex|format)\b/i.test(lastUserTextForSkills);
      if (isCodeQuery) {
        openAIMessages = [{ role: 'system', content: 'Code Interpreter skill is active. Write clear, well-commented code. For calculations show step-by-step work. For data analysis present results in tables. Use markdown code blocks with language tags. Explain outputs clearly.' }, ...openAIMessages];
      }
    }

    // ── Calculator skill: math and computation ───────────────────────────
    if (hasCalculatorSkill) {
      const isMathQuery = /\b(calculate|math|sum|average|percentage|percent|multiply|divide|add|subtract|square root|power|factorial|convert|how much|how many|total|equation|formula)\b/i.test(lastUserTextForSkills);
      if (isMathQuery) {
        openAIMessages = [{ role: 'system', content: 'Calculator skill is active. Show calculations step-by-step. Display formulas and intermediate results. Format numbers with appropriate precision.' }, ...openAIMessages];
      }
    }
  }

  // ── Inject agent SOUL/SKILL system prompt when an agent is selected ────
  if (agentId) {
    try {
      // Support both UUID ids and slug-based agent selection
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(agentId);
      const { rows } = await pool.query(
        isUuid
          ? `SELECT system_prompt, soul_config, skills_config, name, description, capabilities FROM marketplace_agents WHERE id = $1`
          : `SELECT system_prompt, soul_config, skills_config, name, description, capabilities FROM marketplace_agents WHERE slug = $1`,
        [agentId]
      );
      if (rows.length > 0) {
        const agent = rows[0];
        const parts: string[] = [];

        if (agent.system_prompt) {
          parts.push(agent.system_prompt);
        }

        if (agent.soul_config) {
          const soul = typeof agent.soul_config === 'string' ? JSON.parse(agent.soul_config) : agent.soul_config;
          if (soul.identity) parts.push(`Identity: ${soul.identity}`);
          if (soul.purpose) parts.push(`Purpose: ${soul.purpose}`);
          if (soul.communication_style) parts.push(`Communication style: ${soul.communication_style}`);
          if (Array.isArray(soul.principles) && soul.principles.length > 0) {
            parts.push(`Core principles: ${soul.principles.join('; ')}`);
          }
        }

        if (agent.skills_config) {
          const sk = typeof agent.skills_config === 'string' ? JSON.parse(agent.skills_config) : agent.skills_config;
          if (Array.isArray(sk) && sk.length > 0) {
            const skillNames = sk.map((s: { name?: string }) => s.name).filter(Boolean).join(', ');
            if (skillNames) parts.push(`Available skills: ${skillNames}`);
          }
        }

        // Fallback: if no system_prompt or soul_config, use description + capabilities
        if (parts.length === 0) {
          if (agent.description) parts.push(agent.description);
          if (Array.isArray(agent.capabilities) && agent.capabilities.length > 0) {
            parts.push(`Capabilities: ${agent.capabilities.join(', ')}`);
          }
        }

        if (parts.length > 0) {
          const agentSystemPrompt = `You are ${agent.name}. ${parts.join('\n')}`;
          openAIMessages = [{ role: 'system', content: agentSystemPrompt }, ...openAIMessages];
        }
      }
    } catch (err) {
      console.error('Failed to load agent config:', err);
    }
  }

  // ── Route to the appropriate AI provider ────────────────────────────────
  let aiEndpoint: string;
  let aiHeaders: Record<string, string>;
  let aiModel = model;
  let useAnthropicMode = false;

  // ── Select provider ────────────────────────────────────────────────────────
  // Priority:
  //   1. mawa gateway — primary when configured.
  //      Routes through the gateway's agent pipeline (skills, context management, etc.)
  //      The model param selects a gateway agent ("openclaw:agentId"); unknown IDs default to agent "main".
  //   2. Direct OpenAI — when the model is an OpenAI model and OPENAI_API_KEY is set.
  //   3. Direct Anthropic — when the model is an Anthropic model and ANTHROPIC_API_KEY is set.

  const isLocalGateway = !!EFF_GATEWAY_URL;
  let useGateway = false;

  const isOpenAIModel = aiModel.startsWith('openai/')
    || aiModel.match(/^(gpt-[0-9]|o[0-9]|babbage|davinci|text-)/i) !== null;
  const isAnthropicModel = aiModel.startsWith('anthropic/') || aiModel.startsWith('claude-');

  if (isLocalGateway) {
    // mawa gateway — primary AI backend (runs the full agent pipeline)
    const base = EFF_GATEWAY_URL.replace(/\/+$/, '');
    aiEndpoint = `${base}/v1/chat/completions`;
    aiHeaders = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${EFF_GATEWAY_TOKEN}`,
      ...(conversationId ? { 'X-OpenClaw-Session-Key': conversationId } : {}),
    };
    useGateway = true;
    console.log(`[chat] mawa gateway → model=${aiModel}`);

  } else if (isOpenAIModel && EFF_OPENAI) {
    aiEndpoint = 'https://api.openai.com/v1/chat/completions';
    aiHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${EFF_OPENAI}` };
    aiModel = aiModel.startsWith('openai/') ? aiModel.slice(7) : aiModel;
    if (!aiModel.match(/^(gpt-[0-9]|o[0-9]|babbage|davinci|text-)/i)) aiModel = 'gpt-4o';
    console.log(`[chat] OpenAI direct request → model=${aiModel}`);

  } else if (isAnthropicModel && EFF_ANTHROPIC) {
    aiEndpoint = 'https://api.anthropic.com/v1/messages';
    aiHeaders = {
      'Content-Type': 'application/json',
      'x-api-key': EFF_ANTHROPIC,
      'anthropic-version': '2023-06-01',
    };
    useAnthropicMode = true;
    aiModel = aiModel.startsWith('anthropic/') ? aiModel.slice(10) : aiModel;
    if (!aiModel.startsWith('claude-')) aiModel = 'claude-3-5-sonnet-20241022';
    console.log(`[chat] Anthropic direct request → model=${aiModel}`);

  } else if (EFF_OPENAI) {
    aiEndpoint = 'https://api.openai.com/v1/chat/completions';
    aiHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${EFF_OPENAI}` };
    if (!aiModel.match(/^(gpt-[0-9]|o[0-9]|babbage|davinci|text-)/i)) aiModel = 'gpt-4o';
    console.log(`[chat] OpenAI fallback direct request → model=${aiModel}`);

  } else if (EFF_ANTHROPIC) {
    aiEndpoint = 'https://api.anthropic.com/v1/messages';
    aiHeaders = {
      'Content-Type': 'application/json',
      'x-api-key': EFF_ANTHROPIC,
      'anthropic-version': '2023-06-01',
    };
    useAnthropicMode = true;
    if (!aiModel.startsWith('claude-')) aiModel = 'claude-3-5-sonnet-20241022';
    console.log(`[chat] Anthropic fallback direct request → model=${aiModel}`);

  } else if (EFF_MOONSHOT) {
    // Moonshot API is OpenAI-compatible
    aiEndpoint = 'https://api.moonshot.ai/v1/chat/completions';
    aiHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${EFF_MOONSHOT}` };
    aiModel = 'kimi-k2.5';
    console.log(`[chat] Moonshot fallback direct request → model=${aiModel}`);

  } else {
    // No keys configured at all
    return NextResponse.json(
      { error: 'No AI provider configured. Set OPENAI_API_KEY, ANTHROPIC_API_KEY, or MOONSHOT_API_KEY in your environment, or configure keys in Settings → mawa Chat.' },
      { status: 503 },
    );
  }

  const requestBody = useAnthropicMode
    ? buildAnthropicBody(openAIMessages, aiModel)
    : { model: aiModel, messages: openAIMessages, stream: true, max_tokens: 16384 };

  const capturedConversationId = conversationId;

  async function callAI(endpoint: string, headers: Record<string, string>, body: Record<string, unknown>) {
    return fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body) });
  }

  try {
    let res: Response;

    // Try primary endpoint; if the local gateway is unreachable (not running),
    // transparently fall back to OpenAI so the chat still works.
    try {
      res = await callAI(aiEndpoint, aiHeaders, requestBody);
      console.log(`[chat] AI response ← status=${res.status} model=${aiModel}`);
    } catch (primaryErr) {
      if (useGateway && EFF_OPENAI) {
        // Gateway connection failed (e.g. not started) — fall back to OpenAI direct
        console.log(`[chat] Gateway unreachable (${(primaryErr as Error).message}), falling back to OpenAI`);
        const fallbackModel = aiModel.match(/^(gpt-[0-9]|o[0-9]|babbage|davinci|text-)/i) ? aiModel : 'gpt-4o';
        res = await callAI(
          'https://api.openai.com/v1/chat/completions',
          { 'Content-Type': 'application/json', Authorization: `Bearer ${EFF_OPENAI}` },
          { model: fallbackModel, messages: openAIMessages, stream: true, max_tokens: 16384 },
        );
        console.log(`[chat] OpenAI fallback ← status=${res.status}`);
      } else if (useGateway && EFF_MOONSHOT) {
        // Gateway connection failed — fall back to Moonshot (OpenAI-compatible)
        console.log(`[chat] Gateway unreachable (${(primaryErr as Error).message}), falling back to Moonshot`);
        res = await callAI(
          'https://api.moonshot.ai/v1/chat/completions',
          { 'Content-Type': 'application/json', Authorization: `Bearer ${EFF_MOONSHOT}` },
          { model: 'kimi-k2.5', messages: openAIMessages, stream: true, max_tokens: 16384 },
        );
        console.log(`[chat] Moonshot fallback ← status=${res.status}`);
      } else {
        throw primaryErr;
      }
    }

    if (!res.ok) {
      const errBody = await res.text();
      let message: string;
      try {
        const parsed = JSON.parse(errBody) as {
          error?: string | { message?: string };
        };
        const err = parsed?.error;
        message =
          typeof err === "string"
            ? err
            : err && typeof err === "object" && typeof err.message === "string"
            ? err.message
            : res.status === 401
            ? "Authentication failed. Please log in again."
            : res.status === 404
            ? `Model not available with the current API key. Try selecting Mistral 7B.`
            : res.status === 402
            ? "Insufficient credits. Please add credits to your AI provider account."
            : res.status === 429
            ? (errBody.includes('insufficient_quota') || errBody.includes('exceeded your current quota')
                ? "The AI provider's quota is exhausted. Please switch models or add credits."
                : "Rate limit hit. Please wait a moment and try again.")
            : res.status === 502 || res.status === 503
            ? "AI provider is unavailable. Please try again later."
            : res.status >= 500
            ? "AI provider server error. Please try again later."
            : errBody || `Request failed (${res.status})`;
      } catch {
        message =
          res.status === 401
            ? "Authentication failed. Please log in again."
            : res.status === 404
            ? `Model not available with the current API key. Try selecting Mistral 7B.`
            : res.status === 429
            ? "Rate limit or quota exhausted. Try switching to Mistral 7B."
            : res.status >= 500
            ? "AI provider server error. Please try again later."
            : errBody || `Request failed (${res.status})`;
      }
      return NextResponse.json({ error: message }, { status: res.status });
    }

    const contentType = res.headers.get("content-type") ?? "";
    const isStream = contentType.includes("text/event-stream");

    if (isStream) {
      const stream = res.body;
      if (!stream) {
        return NextResponse.json(
          { error: "No response body" },
          { status: 502 }
        );
      }

      // Convert SSE (OpenAI format) to plain text stream for AI SDK TextStreamChatTransport
      // Create placeholder message & mark conversation as streaming
      const directStreamMsgId = capturedConversationId ? await startStreamingMessage(capturedConversationId) : null;
      const textStream = new ReadableStream({
        async start(controller) {
          let fullResponse = "";
          let clientGone = false;
          const actionFilter = createActionBlockFilter();
          let lastDbSave = Date.now();
          const MAX_CONTINUATIONS = 5;
          const STREAM_READ_TIMEOUT_MS = 300_000; // 5 min — no data = stale stream
          let currentStream: ReadableStream<Uint8Array> | null = stream;
          let continuationCount = 0;
          const streamStartTime = Date.now();
          let chunkCount = 0;
          let lastChunkTime = Date.now();
          let timedOut = false;
          let lastProgressLog = Date.now();
          const logId = capturedConversationId?.slice(0, 8) ?? 'no-conv';
          console.log(`[ai-chat][direct][stream-start] convId=${logId} model=${aiModel} gateway=${useGateway} anthropic=${useAnthropicMode} startTime=${new Date().toISOString()}`);

          try {
            // Outer loop: handles auto-continuation when model hits token limit
            while (currentStream && continuationCount <= MAX_CONTINUATIONS) {
              const reader = currentStream.getReader();
              const decoder = new TextDecoder();
              let buffer = "";
              let lastFinishReason = "";

              // Inner loop: read one SSE stream to completion
              while (true) {
                // Race the read against a timeout — if the upstream stalls,
                // we close gracefully instead of hanging forever.
                const readTimeout = new Promise<{ done: true; value: undefined }>(resolve =>
                  setTimeout(() => resolve({ done: true, value: undefined }), STREAM_READ_TIMEOUT_MS)
                );
                const readStart = Date.now();
                const { done, value } = await Promise.race([reader.read(), readTimeout]);
                if (done) {
                  if (!value) {
                    const sinceLast = Date.now() - lastChunkTime;
                    if (sinceLast >= STREAM_READ_TIMEOUT_MS - 500) {
                      timedOut = true;
                      console.error(`[ai-chat][direct][TIMEOUT] convId=${logId} NO DATA for ${sinceLast}ms — stream killed by read timeout. chunks=${chunkCount} chars=${fullResponse.length} elapsed=${Date.now() - streamStartTime}ms`);
                      // Send a visible indicator so the user knows the stream was cut
                      if (!clientGone) {
                        const notice = '\n\n---\n⚠️ *The AI backend stopped responding (timed out after ~5 minutes of silence). This usually means the model got stuck on an internal operation. Please try again — shorter or simpler prompts are more reliable.*';
                        try { controller.enqueue(new TextEncoder().encode(notice)); fullResponse += notice; } catch { clientGone = true; }
                      }
                    } else {
                      console.log(`[ai-chat][direct][stream-done] convId=${logId} natural end. chunks=${chunkCount} chars=${fullResponse.length} elapsed=${Date.now() - streamStartTime}ms`);
                    }
                  }
                  const tail = decoder.decode();
                  if (tail) buffer += tail;
                  break;
                }

                chunkCount++;
                lastChunkTime = Date.now();
                // Log progress every 15s
                if (Date.now() - lastProgressLog > 15_000) {
                  lastProgressLog = Date.now();
                  console.log(`[ai-chat][direct][progress] convId=${logId} chunks=${chunkCount} chars=${fullResponse.length} elapsed=${Date.now() - streamStartTime}ms readLatency=${Date.now() - readStart}ms`);
                }

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split("\n");
                buffer = lines.pop() ?? "";

                for (const line of lines) {
                  const trimmed = line.trim();
                  if (!trimmed || !trimmed.startsWith("data: ")) continue;
                  const data = trimmed.slice(6);
                  if (data === "[DONE]") {
                    console.log(`[ai-chat][direct][DONE-signal] convId=${logId} received [DONE]. chunks=${chunkCount} chars=${fullResponse.length}`);
                    continue;
                  }

                  try {
                    const parsed = JSON.parse(data) as Record<string, unknown>;
                    let content: string | undefined;
                    if (useAnthropicMode) {
                      const delta = parsed.delta as { type?: string; text?: string; stop_reason?: string } | undefined;
                      if (parsed.type === 'content_block_delta' && delta?.type === 'text_delta') {
                        content = delta.text || undefined;
                      }
                      // Anthropic signals end via message_delta
                      if (parsed.type === 'message_delta' && delta?.stop_reason) {
                        lastFinishReason = delta.stop_reason === 'max_tokens' ? 'length' : delta.stop_reason;
                        console.log(`[ai-chat][direct][finish-reason] convId=${logId} reason="${lastFinishReason}" (anthropic) chars=${fullResponse.length}`);
                      }
                    } else {
                      const choices = parsed.choices as Array<{ delta?: { content?: string }; finish_reason?: string | null }> | undefined;
                      content = choices?.[0]?.delta?.content;
                      if (choices?.[0]?.finish_reason) {
                        lastFinishReason = choices[0].finish_reason;
                        console.log(`[ai-chat][direct][finish-reason] convId=${logId} reason="${lastFinishReason}" chars=${fullResponse.length}`);
                      }
                    }
                    if (content) {
                      fullResponse += content;
                      const filtered = actionFilter.filter(content);
                      if (filtered && !clientGone) {
                        try { controller.enqueue(new TextEncoder().encode(filtered)); } catch { clientGone = true; console.warn(`[ai-chat][direct][client-gone] convId=${logId} client disconnected at chars=${fullResponse.length}`); }
                      }
                    }
                  } catch (parseErr) {
                    console.warn(`[ai-chat][direct][parse-error] convId=${logId} chunk=${chunkCount} data=${data.slice(0, 200)}`, parseErr);
                  }
                }
                // Periodic DB save (every 3 s)
                if (directStreamMsgId && Date.now() - lastDbSave > 3000 && fullResponse) {
                  lastDbSave = Date.now();
                  updateStreamingContent(directStreamMsgId, fullResponse).catch(() => {});
                }
              }
              // Process any remaining buffer (last SSE line without trailing newline)
              if (buffer.trim()) {
                const trimmed = buffer.trim();
                if (trimmed.startsWith("data: ")) {
                  const data = trimmed.slice(6);
                  if (data !== "[DONE]") {
                    try {
                      const parsed = JSON.parse(data) as Record<string, unknown>;
                      let content: string | undefined;
                      if (useAnthropicMode) {
                        const delta = parsed.delta as { type?: string; text?: string; stop_reason?: string } | undefined;
                        if (parsed.type === 'content_block_delta' && delta?.type === 'text_delta') {
                          content = delta.text || undefined;
                        }
                        if (parsed.type === 'message_delta' && delta?.stop_reason) {
                          lastFinishReason = delta.stop_reason === 'max_tokens' ? 'length' : delta.stop_reason;
                          console.log(`[ai-chat][direct][finish-reason-tail] convId=${logId} reason="${lastFinishReason}"`);
                        }
                      } else {
                        const choices = parsed.choices as Array<{ delta?: { content?: string }; finish_reason?: string | null }> | undefined;
                        content = choices?.[0]?.delta?.content;
                        if (choices?.[0]?.finish_reason) {
                          lastFinishReason = choices[0].finish_reason;
                          console.log(`[ai-chat][direct][finish-reason-tail] convId=${logId} reason="${lastFinishReason}"`);
                        }
                      }
                      if (content) {
                        fullResponse += content;
                        const filtered = actionFilter.filter(content);
                        if (filtered && !clientGone) {
                          try { controller.enqueue(new TextEncoder().encode(filtered)); } catch { clientGone = true; }
                        }
                      }
                    } catch { /* skip malformed */ }
                  }
                }
              }

              // Auto-continuation: if model stopped due to max tokens, continue generating
              if (lastFinishReason === 'length' && fullResponse && !clientGone) {
                continuationCount++;
                console.log(`[ai-chat][stream] auto-continue #${continuationCount} — finish_reason=length, accumulated ${fullResponse.length} chars`);
                try {
                  const contMessages = [
                    ...openAIMessages,
                    { role: 'assistant', content: fullResponse },
                    { role: 'user', content: 'Continue exactly where you left off. Do not repeat anything already said.' },
                  ];
                  const contBody = useAnthropicMode
                    ? { ...buildAnthropicBody(contMessages as OpenAIMessage[], aiModel) }
                    : { model: aiModel, messages: contMessages, stream: true, max_tokens: 16384 };
                  const contRes = await callAI(aiEndpoint, aiHeaders, contBody);
                  if (contRes.ok && contRes.body) {
                    currentStream = contRes.body;
                    continue; // loop back to read the new stream
                  }
                } catch (contErr) {
                  console.warn(`[ai-chat][stream] auto-continue #${continuationCount} failed:`, contErr);
                }
              }
              // Either finish_reason was "stop", or continuation failed — we're done
              currentStream = null;
            }
          } catch (err) {
            console.error(`[ai-chat][direct][STREAM-ERROR] convId=${logId} error=${(err as Error)?.message} chars=${fullResponse.length} chunks=${chunkCount} elapsed=${Date.now() - streamStartTime}ms`, err);
            if (!clientGone) { try { controller.error(err); } catch { /* already closed */ } }
          } finally {
            // Flush any remaining text held by the action block filter
            const actionFlushed = actionFilter.flush();
            if (actionFlushed && !clientGone) {
              try { controller.enqueue(new TextEncoder().encode(actionFlushed)); } catch { clientGone = true; }
            }
            // Detect images via GCS fallback and inject into the stream BEFORE closing
            if (fullResponse && authenticatedUserId && !clientGone) {
              try {
                const streamImages = await persistDetectedMedia(fullResponse, authenticatedUserId);
                const missing = streamImages.filter(img =>
                  !fullResponse.includes(img.url) && !fullResponse.includes(decodeURIComponent(img.url))
                );
                if (missing.length > 0) {
                  const imgMd = '\n\n' + missing.map(img => `![${img.fileName}](/api/media/workspace/${encodeURIComponent(img.fileName)})`).join('\n');
                  try { controller.enqueue(new TextEncoder().encode(imgMd)); } catch { clientGone = true; }
                  fullResponse += imgMd;
                  console.log(`[ai-chat][direct] Streamed ${missing.length} image(s) into response`);
                }
              } catch (imgErr) {
                console.warn('[ai-chat][direct] image detection before close failed:', (imgErr as Error)?.message);
              }
            }
            if (!clientGone) { try { controller.close(); } catch { /* stream already errored */ } }
            const totalMs = Date.now() - streamStartTime;
            console.log(`[ai-chat][direct][stream-final] convId=${logId} chars=${fullResponse.length} chunks=${chunkCount} duration=${totalMs}ms timedOut=${timedOut} clientGone=${clientGone} continuations=${continuationCount}`);
            // Save final content immediately (keep is_streaming = TRUE so recovery polling continues)
            if (capturedConversationId && directStreamMsgId && fullResponse) {
              await updateStreamingContent(directStreamMsgId, fullResponse);
            }
            // Await action blocks BEFORE clearing is_streaming flag
            if (fullResponse && authenticatedUserId) {
              try {
                await processAllActionBlocks(fullResponse, {
                  userId: authenticatedUserId,
                  authToken: authHeader || null,
                  gatewayUrl: GATEWAY_URL || null,
                  gatewayToken: OPENCLAW_GATEWAY_TOKEN || null,
                  conversationId: capturedConversationId || null,
                });
              } catch (err) {
                console.error('[ai-chat][direct-stream] action block processing failed:', err);
              }
            }
            // NOW finalize streaming state + generate title
            if (capturedConversationId) {
              await finishStreamingMessage(capturedConversationId, directStreamMsgId, fullResponse);
              // Close the MC mirror task for this conversation.
              if (authenticatedUserId) {
                finishMCTaskForConversation(authenticatedUserId, capturedConversationId, 'done')
                  .catch(err => console.warn('[ai-chat][direct] MC finish failed:', err));
              }
              if (fullResponse) {
                try {
                  const { rows } = await pool.query(
                    `SELECT title FROM conversations WHERE id = $1`,
                    [capturedConversationId]
                  );
                  const t = String(rows[0]?.title ?? '').trim().toLowerCase();
                  if (!t || t === 'new chat') {
                    generateTitle(capturedConversationId, authHeader!).catch(() => {});
                  }
                } catch { /* title generation is best-effort */ }
              }
            }
          }
        },
      });

      return new NextResponse(textStream, {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    }

    // Non-streaming: extract content and return as plain text
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data?.choices?.[0]?.message?.content ?? "";
    // Save assistant response to DB
    if (conversationId && content) {
      pool.query(
        `INSERT INTO messages (conversation_id, role, content) VALUES ($1, $2, $3)`,
        [conversationId, "assistant", content]
      ).catch((e) => console.error("Failed to save assistant message:", e));
    }
    // Post-process action blocks for direct mode non-streaming
    if (content && authenticatedUserId) {
      processAllActionBlocks(content, {
        userId: authenticatedUserId,
        authToken: authHeader || null,
        gatewayUrl: GATEWAY_URL || null,
        gatewayToken: OPENCLAW_GATEWAY_TOKEN || null,
        conversationId: conversationId || null,
      }).catch(err =>
        console.error('[ai-chat][direct-non-stream] action block processing failed:', err)
      );
    }
    return new NextResponse(stripActionBlocks(transformMediaLines(content)), {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  } catch (err) {
    console.error("Chat proxy error:", err);
    const isNetwork =
      err instanceof TypeError && (err as Error).message?.includes("fetch");
    return NextResponse.json(
      {
        error: isNetwork
          ? "Cannot reach the AI backend. Make sure the mawa gateway is running or your API keys are set."
          : "AI backend unreachable. Please try again later.",
      },
      { status: 502 }
    );
  }
}
