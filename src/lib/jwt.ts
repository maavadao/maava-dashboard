/**
 * Edge-compatible JWT utilities — safe to import in middleware.
 *
 * This file intentionally does NOT import pool/pg or any Node.js-only modules
 * so it can be bundled for the Edge Runtime without crashing the compiler.
 * API routes that need DB-backed auth should import from '@/lib/auth' instead.
 */
import { jwtVerify, SignJWT } from 'jose';
import type { NextRequest } from 'next/server';

const JWT_SECRET = process.env.JWT_SECRET || 'change-this-jwt-secret';
const JWT_ISSUER = 'barrsa-auth';

export interface JWTPayload {
  userId: string;
  email: string;
  subdomain: string | null;
  tenantId: string | null;
}

export interface AuthResolution {
  user: JWTPayload;
  authToken: string;
  source: 'jwt' | 'api-key';
}

/**
 * Validate a JWT token and extract the payload.
 * Works in both Node.js and Edge Runtime (uses `jose` library).
 */
export async function validateJWT(token: string): Promise<JWTPayload | null> {
  try {
    const secret = new TextEncoder().encode(JWT_SECRET);
    const { payload } = await jwtVerify(token, secret, {
      issuer: JWT_ISSUER,
      algorithms: ['HS256'],
    });

    return {
      userId: (payload.userId as string) || (payload.sub as string) || '',
      email: (payload.email as string) || '',
      subdomain: (payload.subdomain as string) || null,
      tenantId: (payload.tenantId as string) || null,
    };
  } catch {
    return null;
  }
}

/**
 * Extract JWT from a request's auth-token cookie or Authorization header.
 */
export function extractJWTFromRequest(request: NextRequest): string | null {
  // 1. Check httpOnly cookie
  const cookie = request.cookies.get('auth-token');
  if (cookie?.value) return cookie.value;

  // 2. Fallback to Authorization header
  const authHeader = request.headers.get('authorization');
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }

  return null;
}

/**
 * Validate JWT from request. Returns null if no valid token found.
 */
export async function authenticateRequest(request: NextRequest): Promise<JWTPayload | null> {
  const token = extractJWTFromRequest(request);
  if (!token) return null;
  return validateJWT(token);
}

/**
 * Validate a transfer token. Returns the payload only if the token
 * is a valid transfer token (has purpose=subdomain-transfer).
 */
export async function validateTransferToken(token: string): Promise<JWTPayload | null> {
  try {
    const secret = new TextEncoder().encode(JWT_SECRET);
    const { payload } = await jwtVerify(token, secret, {
      issuer: JWT_ISSUER,
      algorithms: ['HS256'],
    });

    if (payload.purpose !== 'subdomain-transfer') {
      console.warn('[auth] validateTransferToken: purpose mismatch, got:', payload.purpose);
      return null;
    }

    return {
      userId: (payload.userId as string) || (payload.sub as string) || '',
      email: (payload.email as string) || '',
      subdomain: (payload.subdomain as string) || null,
      tenantId: (payload.tenantId as string) || null,
    };
  } catch (err) {
    console.error('[auth] validateTransferToken failed:', (err as Error).message || err);
    return null;
  }
}

/**
 * Create a JWT token.
 */
export async function createJWT(payload: JWTPayload, expiresIn = '7d'): Promise<string> {
  const secret = new TextEncoder().encode(JWT_SECRET);
  return new SignJWT({
    userId: payload.userId,
    email: payload.email,
    subdomain: payload.subdomain,
    tenantId: payload.tenantId,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setIssuer(JWT_ISSUER)
    .setExpirationTime(expiresIn)
    .setSubject(payload.userId)
    .sign(secret);
}

const CLOUD_MODE = process.env.NEXT_PUBLIC_CLOUD_MODE === 'true';

/**
 * Extracts the authenticated user's ID from a request.
 * Cloud mode: validates JWT (httpOnly cookie or Bearer header) — cannot be spoofed.
 * Local dev mode: reads x-user-id header (convenience for development).
 * Returns null when unauthenticated.
 */
export async function getRequestUserId(request: NextRequest): Promise<string | null> {
  if (CLOUD_MODE) {
    const user = await authenticateRequest(request);
    return user?.userId ?? null;
  }
  const id = request.headers.get('x-user-id');
  return id && id !== 'anonymous' ? id : null;
}
