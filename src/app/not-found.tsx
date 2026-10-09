'use client';

import { useEffect } from 'react';

const ROOT_DOMAIN = process.env.NEXT_PUBLIC_ROOT_DOMAIN || 'maavadao.com';
const LOGIN_URL = `https://${ROOT_DOMAIN}/auth/login`;

/**
 * Custom 404 handler — redirects to maavadao.com login instead of showing
 * Next.js's default "This page could not be found" error.
 *
 * This catches any 404s that middleware doesn't intercept (e.g. direct visits
 * to non-existent paths on a subdomain).
 */
export default function NotFound() {
  useEffect(() => {
    window.location.replace(LOGIN_URL);
  }, []);

  // Render nothing — the redirect fires immediately on mount.
  return null;
}
