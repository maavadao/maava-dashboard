'use client';

import type { ReactNode } from 'react';
import { useState } from 'react';
import { QueryClient, QueryClientProvider, keepPreviousData } from '@tanstack/react-query';

export function MCQueryProvider({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Treat data as fresh for 60s — avoids refetch on navigation/back
            staleTime: 60_000,
            // Keep cache around for 10 min so back-navigation is instant
            gcTime: 10 * 60 * 1000,
            // Don't flash loading state when re-fetching — show previous data
            placeholderData: keepPreviousData,
            // Don't refetch on focus — too aggressive for slow MC backend
            refetchOnWindowFocus: false,
            // Don't refetch on remount if still fresh
            refetchOnMount: false,
            retry: 1,
          },
          mutations: {
            retry: 0,
          },
        },
      }),
  );

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
