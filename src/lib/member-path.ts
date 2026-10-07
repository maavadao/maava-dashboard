'use client';

import { useMemo } from 'react';
import {
  useParams,
  usePathname as useNextPathname,
  useRouter as useNextRouter,
} from 'next/navigation';

// Every member-space page lives under /<username>. Code inside the app keeps
// using plain paths like "/channels"; these helpers add and strip the prefix.

/** First path segments served at the root of the member space, not under /<username>. */
const ROOT_SEGMENTS = new Set(['api', 'auth', '_next']);

/** Prefix an internal path with /<username>. External URLs and root paths are left alone. */
export function withMember(username: string | undefined, href: string): string {
  if (!username || !href.startsWith('/') || href.startsWith('//')) return href;
  if (href === '/') return `/${username}`;
  if (href.startsWith('/?') || href.startsWith('/#')) return `/${username}${href.slice(1)}`;
  const first = href.slice(1).split(/[/?#]/)[0];
  if (ROOT_SEGMENTS.has(first) || first === username) return href;
  return `/${username}${href}`;
}

/** The member whose space is being viewed, from the /<username> route segment. */
export function useMemberUsername(): string | undefined {
  const params = useParams<{ username?: string }>();
  return typeof params?.username === 'string' ? params.username : undefined;
}

/** Like next/navigation's usePathname, without the /<username> prefix. */
export function usePathname(): string {
  const pathname = useNextPathname();
  const username = useMemberUsername();
  if (!username || !pathname) return pathname;
  if (pathname === `/${username}`) return '/';
  return pathname.startsWith(`/${username}/`) ? pathname.slice(username.length + 1) : pathname;
}

type AppRouter = ReturnType<typeof useNextRouter>;

/** Like next/navigation's useRouter, but push/replace/prefetch stay inside the member's space. */
export function useRouter(): AppRouter {
  const router = useNextRouter();
  const username = useMemberUsername();
  return useMemo(
    () => ({
      ...router,
      push: (href, options) => router.push(withMember(username, href), options),
      replace: (href, options) => router.replace(withMember(username, href), options),
      prefetch: (href, options) => router.prefetch(withMember(username, href), options),
    }),
    [router, username],
  );
}

/** For window.location redirects outside React: prefix with the member in the current URL. */
export function toMemberPath(href: string): string {
  if (typeof window === 'undefined') return href;
  const first = window.location.pathname.split('/')[1];
  return first && !ROOT_SEGMENTS.has(first) ? withMember(first, href) : href;
}
