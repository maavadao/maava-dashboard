'use client';

import type { ReactNode } from 'react';

/**
 * Auth adapter — replaces @clerk/nextjs imports.
 * Users are already authenticated to reach the mawadao-agent-dashboard,
 * so we always treat them as "signed in".
 */

export function SignedIn({ children }: { children: ReactNode }) {
  return children as React.ReactElement;
}

export function SignedOut({ children: _children }: { children: ReactNode }) {
  return null;
}

export function SignInButton({ children: _children }: { children?: ReactNode }) {
  return null;
}

export function SignOutButton({ children: _children }: { children?: ReactNode }) {
  return null;
}

export function useAuth() {
  return { isSignedIn: true as const, isLoaded: true as const };
}

export function useUser() {
  return {
    isLoaded: true as const,
    isSignedIn: true as const,
    user: { fullName: 'Operator', primaryEmailAddress: { emailAddress: '' } },
  };
}
