import { createHash } from 'crypto';
import { jwtVerify, SignJWT } from 'jose';
import type { NextRequest } from 'next/server';
import pool from '@/lib/db';

const JWT_SECRET = process.env.JWT_SECRET || 'change-this-jwt-secret';
const JWT_ISSUER = 'barrsa-auth';
const AUTH_DEBUG = process.env.AUTH_DEBUG === 'true';

if (!process.env.JWT_SECRET) {
  // eslint-disable-next-line no-console
  console.warn('[auth] JWT_SECRET not set — using insecure default. Auth will fail in production.');
}

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
  } catch (err) {
    if (AUTH_DEBUG) {
      // eslint-disable-next-line no-console
      console.warn('[auth] validateJWT failed:', (err as Error)?.message);
    }
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
 * Resolve auth from either a signed JWT session or a Barrsa API key.
 * API-key auth is used by non-OAuth dashboard sessions.
 */
export async function authenticateRequestOrApiKey(
  request: NextRequest,
): Promise<AuthResolution | null> {
  const bearer = request.headers.get('authorization');
  const token = extractJWTFromRequest(request);

  if (token) {
    const user = await validateJWT(token);
    if (user) {
      return { user, authToken: token, source: 'jwt' };
    }
  }

  if (!bearer?.startsWith('Bearer ')) return null;
  const apiKey = bearer.slice(7).trim();
  if (!apiKey) return null;

  const apiKeyHash = createHash('sha256').update(apiKey).digest('hex');

  try {
    const userResult = await pool.query<{
      id: string;
      email: string;
      subdomain: string | null;
      tenant_id: string | null;
    }>(
      `SELECT u.id, u.email, t.subdomain, t.id AS tenant_id
         FROM users u
         LEFT JOIN tenants t ON t.user_id = u.id AND t.status = 'active'
        WHERE u.api_key_hash = $1
          AND u.is_active = true
        LIMIT 1`,
      [apiKeyHash],
    );

    const userRow = userResult.rows[0];
    if (userRow) {
      const user: JWTPayload = {
        userId: userRow.id,
        email: userRow.email,
        subdomain: userRow.subdomain,
        tenantId: userRow.tenant_id,
      };
      const authToken = await createJWT(user);
      return { user, authToken, source: 'api-key' };
    }

    const agentResult = await pool.query<{
      id: string;
      name: string;
      user_id: string | null;
      subdomain: string | null;
      tenant_id: string | null;
    }>(
      `SELECT a.id, a.name, a.user_id, a.subdomain, t.id AS tenant_id
         FROM agents a
         LEFT JOIN tenants t ON t.subdomain = a.subdomain AND t.status = 'active'
        WHERE a.api_key_hash = $1
        LIMIT 1`,
      [apiKeyHash],
    );

    const agentRow = agentResult.rows[0];
    if (agentRow) {
      const user: JWTPayload = {
        userId: agentRow.user_id || agentRow.id,
        email: `${agentRow.name}@agent.local`,
        subdomain: agentRow.subdomain,
        tenantId: agentRow.tenant_id,
      };
      const authToken = await createJWT(user);
      return { user, authToken, source: 'api-key' };
    }
  } catch {
    return null;
  }

  return null;
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
 * Create a JWT token (server-side only, for testing or token refresh).
 */
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
