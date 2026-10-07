/**
 * Action Block Filter — strips [CREATE_PRODUCT], [UPDATE_PRODUCT], [CREATE_TASK],
 * etc. from text that is sent to the frontend, while preserving the full text
 * for backend processing.
 *
 * Two modes:
 *   1. Stateful streaming filter — `createActionBlockFilter()` returns an object
 *      whose `.filter(chunk)` and `.flush()` methods are called per-chunk.
 *   2. One-shot regex strip — `stripActionBlocks(text)` for complete text.
 */

/** All supported action block tag names. */
const ACTION_TAGS = [
  'CREATE_PRODUCT',
  'UPDATE_PRODUCT',
  'PUBLISH_PRODUCT',
  'CREATE_TASK',
  'UPDATE_TASK',
  'DELIVER',
  'SCHEDULE_DELIVERY',
  'SELLER_SQL',
  'ZERNIO_API',
  'CAMPAIGN_PLAN',
] as const;

/** Regex that matches ANY opening action tag (e.g. `[CREATE_PRODUCT]` or `[ZERNIO_API:14]`). */
const ACTION_OPEN_RE = new RegExp(
  `\\[(${ACTION_TAGS.join('|')})(?::\\d+)?\\]`,
);

// ─── One-shot strip (for non-streaming / complete text) ─────────────────────

const ACTION_BLOCK_RE = new RegExp(
  `\\[(${ACTION_TAGS.join('|')})(?::\\d+)?\\][\\s\\S]*?\\[\\/\\1\\]`,
  'gi',
);

/**
 * Strip all action blocks from a complete text string.
 * Safe for both full assistant messages and stored DB content.
 */
export function stripActionBlocks(text: string): string {
  return text
    .replace(ACTION_BLOCK_RE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ─── Stateful streaming filter ──────────────────────────────────────────────

export interface ActionBlockFilter {
  /** Feed a chunk of streamed text. Returns the portion safe for the client. */
  filter(chunk: string): string;
  /** Flush any held buffer at stream end. Returns remaining safe text. */
  flush(): string;
}

/**
 * Create a stateful action-block filter for streaming use.
 *
 * During streaming, text arrives in arbitrary-size chunks. The filter buffers
 * text when it detects a potential opening tag and suppresses everything
 * between `[TAG]` and `[/TAG]`.
 *
 * `fullText` accumulation must happen BEFORE calling `.filter()` so the
 * backend retains the complete response (with blocks) for processing.
 */
export function createActionBlockFilter(): ActionBlockFilter {
  let state: 'normal' | 'in_block' = 'normal';
  let activeTag = '';
  let holdBuf = ''; // holds text that might contain a partial opening or closing tag

  function filter(chunk: string): string {
    holdBuf += chunk;
    let output = '';
    let safety = 0;

    while (holdBuf.length > 0 && safety++ < 200) {
      if (state === 'in_block') {
        const closeTag = `[/${activeTag}]`;
        const closeIdx = holdBuf.indexOf(closeTag);
        if (closeIdx !== -1) {
          // Found closing tag — discard block content + tag, resume normal
          holdBuf = holdBuf.slice(closeIdx + closeTag.length);
          state = 'normal';
          activeTag = '';
          continue;
        }
        // Not yet closed. Keep tail that could be partial close tag.
        // Max close tag length is `[/SCHEDULE_DELIVERY]` = 21 chars.
        if (holdBuf.length > 25) {
          holdBuf = holdBuf.slice(-25);
        }
        break; // wait for more data
      }

      // ── state === 'normal' ──
      const openMatch = ACTION_OPEN_RE.exec(holdBuf);
      if (openMatch && openMatch.index !== undefined) {
        // Emit text before the opening tag
        output += holdBuf.slice(0, openMatch.index);
        holdBuf = holdBuf.slice(openMatch.index + openMatch[0].length);
        state = 'in_block';
        activeTag = openMatch[1];
        continue;
      }

      // No opening tag found. Check for partial opening tag at the end.
      // A `[` near the end might be start of `[SCHEDULE_DELIVERY]` (20 chars) or `[ZERNIO_API:14]` (15+ chars).
      const lastBracket = holdBuf.lastIndexOf('[');
      if (lastBracket !== -1 && holdBuf.length - lastBracket < 26) {
        // Could be partial tag — hold it, emit everything before
        output += holdBuf.slice(0, lastBracket);
        holdBuf = holdBuf.slice(lastBracket);
        break;
      }

      // Safe to emit everything
      output += holdBuf;
      holdBuf = '';
      break;
    }

    return output;
  }

  function flush(): string {
    if (state === 'in_block') {
      // Block was never closed — discard buffered block content
      holdBuf = '';
      return '';
    }
    const result = holdBuf;
    holdBuf = '';
    return result;
  }

  return { filter, flush };
}
