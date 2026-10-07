// ─── Slack request signature verification ───
// Implements https://api.slack.com/authentication/verifying-requests-from-slack

import { createHmac, timingSafeEqual } from 'crypto';

const SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET || '';
const TIMESTAMP_MAX_AGE_SEC = 300; // 5-minute replay window

export interface SignatureVerificationResult {
  valid: boolean;
  reason?: string;
}

/**
 * Verify the X-Slack-Signature header against the raw request body.
 *
 * @param rawBody - The raw string body of the request (NOT parsed JSON)
 * @param timestamp - Value of X-Slack-Request-Timestamp header
 * @param signature - Value of X-Slack-Signature header
 */
export function verifySlackSignature(
  rawBody: string,
  timestamp: string | null,
  signature: string | null,
): SignatureVerificationResult {
  if (!SIGNING_SECRET) {
    return { valid: false, reason: 'SLACK_SIGNING_SECRET not configured' };
  }

  if (!timestamp || !signature) {
    return { valid: false, reason: 'Missing timestamp or signature headers' };
  }

  // Replay protection
  const ts = Number(timestamp);
  if (Number.isNaN(ts)) {
    return { valid: false, reason: 'Invalid timestamp' };
  }

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > TIMESTAMP_MAX_AGE_SEC) {
    return { valid: false, reason: 'Request timestamp too old (replay protection)' };
  }

  // Compute expected signature
  const sigBasestring = `v0:${timestamp}:${rawBody}`;
  const expectedSig = 'v0=' + createHmac('sha256', SIGNING_SECRET).update(sigBasestring).digest('hex');

  // Timing-safe comparison
  const sigBuffer = Buffer.from(signature, 'utf8');
  const expectedBuffer = Buffer.from(expectedSig, 'utf8');

  if (sigBuffer.length !== expectedBuffer.length) {
    return { valid: false, reason: 'Signature mismatch' };
  }

  if (!timingSafeEqual(sigBuffer, expectedBuffer)) {
    return { valid: false, reason: 'Signature mismatch' };
  }

  return { valid: true };
}
