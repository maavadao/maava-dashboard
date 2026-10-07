'use client';

import { useEffect, useRef } from 'react';
import { MCQueryProvider } from '@/components/mc/providers/MCQueryProvider';
import { GlobalLoader } from '@/components/mc/ui/global-loader';

function MCBootstrap() {
  const ran = useRef(false);
  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    // Bootstrap MC user/org and gateway registration on first visit
    fetch('/api/mission-control/gateway-bootstrap', { method: 'POST' })
      .then((r) => r.json())
      .then((d) => {
        if (d.status) console.log('[mc] bootstrap:', d.status);
      })
      .catch(() => {});
  }, []);
  return null;
}

export default function MissionControlLayout({ children }: { children: React.ReactNode }) {
  return (
    <MCQueryProvider>
      <MCBootstrap />
      <GlobalLoader />
      <div className="mc-root">{children}</div>
    </MCQueryProvider>
  );
}
