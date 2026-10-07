'use client';

import NextLink from 'next/link';
import { forwardRef, type ComponentProps } from 'react';
import { useMemberUsername, withMember } from '@/lib/member-path';

/** next/link that keeps internal paths inside the member's /<username> space. */
const Link = forwardRef<HTMLAnchorElement, ComponentProps<typeof NextLink>>(function MemberLink(
  { href, ...props },
  ref,
) {
  const username = useMemberUsername();
  const resolved =
    typeof href === 'string'
      ? withMember(username, href)
      : href.pathname
        ? { ...href, pathname: withMember(username, href.pathname) }
        : href;
  return <NextLink ref={ref} href={resolved} {...props} />;
});

export default Link;
