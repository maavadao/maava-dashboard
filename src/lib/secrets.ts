/**
 * A secret from the environment, encoded for signing and verifying. Read when it's used (not at
 * import, so builds work without it) and never replaced by a default: a missing secret throws, so
 * tokens are rejected instead of being checked against a value anyone can read.
 */
export function secretKey(...names: string[]): Uint8Array {
  for (const name of names) {
    const value = process.env[name];
    if (value) return new TextEncoder().encode(value);
  }
  throw new Error(`${names.join(' or ')} must be set`);
}
