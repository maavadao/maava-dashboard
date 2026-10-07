'use client';

import { useEffect } from 'react';
import { ThemeProvider } from 'next-themes';
import { configApi } from '@/lib/config-api';
import { useAuthStore } from '@/store';

/** One-time cloud mode initializer — runs before any page renders. */
function CloudModeInit() {
  // Detect cloud mode from env or hostname and wire up configApi
  useEffect(() => {
    const isCloud =
      process.env.NEXT_PUBLIC_CLOUD_MODE === 'true' ||
      (typeof window !== 'undefined' && window.location.hostname.endsWith('.mawadao.com'));
    if (isCloud) {
      configApi.setCloudMode(true);
    }
  }, []);

  // Keep configApi auth token in sync with zustand session token
  const apiKey = useAuthStore((s) => s.apiKey);
  useEffect(() => {
    if (apiKey) configApi.setAuthToken(apiKey);
  }, [apiKey]);

  return null;
}

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <CloudModeInit />
      {children}
    </ThemeProvider>
  );
}
