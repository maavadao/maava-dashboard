// Inbox token encryption (AES-256-GCM).
// Used to encrypt OAuth refresh/access tokens at rest in `inbox_accounts.token_ciphertext`.
//
// The key MUST be a 32-byte secret provided as base64 in INBOX_TOKEN_ENCRYPTION_KEY.
// In dev only, falls back to a deterministic dev key derived from JWT_SECRET so the
// service still boots — production deployments must set INBOX_TOKEN_ENCRYPTION_KEY.
//
// Ciphertext format (base64 of: 12-byte IV || 16-byte auth tag || ciphertext bytes).

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;

function loadKey(): Buffer {
  const raw = process.env.INBOX_TOKEN_ENCRYPTION_KEY;
  if (raw) {
    try {
      const buf = Buffer.from(raw, 'base64');
      if (buf.length === 32) return buf;
      // Allow hex too
      const hex = Buffer.from(raw, 'hex');
      if (hex.length === 32) return hex;
      // Allow raw 32-char string
      if (raw.length === 32) return Buffer.from(raw, 'utf8');
    } catch {
      // fall through to dev fallback
    }
    // eslint-disable-next-line no-console
    console.warn('[inbox/crypto] INBOX_TOKEN_ENCRYPTION_KEY is set but not a valid 32-byte base64/hex value — falling back.');
  }
  // Deterministic dev fallback derived from JWT_SECRET. NOT secure for production.
  const seed = process.env.JWT_SECRET || 'change-this-jwt-secret';
  // eslint-disable-next-line no-console
  console.warn('[inbox/crypto] Using insecure derived dev key. Set INBOX_TOKEN_ENCRYPTION_KEY (32 bytes base64) in production.');
  return createHash('sha256').update(`barrsa-inbox-token::${seed}`).digest();
}

const KEY = loadKey();

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, KEY, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

export function decryptSecret(ciphertextB64: string): string {
  const buf = Buffer.from(ciphertextB64, 'base64');
  if (buf.length < IV_LEN + TAG_LEN) {
    throw new Error('[inbox/crypto] Ciphertext too short');
  }
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const enc = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv(ALGO, KEY, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
  return dec.toString('utf8');
}

/** Convenience: encrypt a JSON-serialisable token bundle. */
export function encryptTokenBundle(bundle: unknown): string {
  return encryptSecret(JSON.stringify(bundle));
}

export function decryptTokenBundle<T = unknown>(ciphertextB64: string): T {
  return JSON.parse(decryptSecret(ciphertextB64)) as T;
}
