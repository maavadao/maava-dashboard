// Inbox token encryption (AES-256-GCM).
// Used to encrypt OAuth refresh/access tokens at rest in `inbox_accounts.token_ciphertext`.
//
// The key is a 32-byte secret in INBOX_TOKEN_ENCRYPTION_KEY (base64, hex or 32 characters).
// There is no fallback: without a valid key, encrypting and decrypting throw.
//
// Ciphertext format (base64 of: 12-byte IV || 16-byte auth tag || ciphertext bytes).

import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;

function loadKey(): Buffer {
  const raw = process.env.INBOX_TOKEN_ENCRYPTION_KEY;
  if (raw) {
    const base64 = Buffer.from(raw, 'base64');
    if (base64.length === 32) return base64;
    const hex = Buffer.from(raw, 'hex');
    if (hex.length === 32) return hex;
    if (raw.length === 32) return Buffer.from(raw, 'utf8');
  }
  throw new Error('INBOX_TOKEN_ENCRYPTION_KEY must be set to a 32-byte key (base64, hex or 32 characters)');
}

// Loaded on first use, so the app builds and starts without it until inbox features are used.
let key: Buffer | undefined;
const getKey = () => (key ??= loadKey());

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, getKey(), iv);
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
  const decipher = createDecipheriv(ALGO, getKey(), iv);
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
