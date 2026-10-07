'use client';

import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { usePathname } from '@/lib/member-path';

/* ── Sidebar state context ─────────────────────────────────────────────────── */

interface SidebarState {
  collapsed: boolean;
  toggleCollapse: () => void;
  mobileOpen: boolean;
  toggleMobile: () => void;
}

const SidebarCtx = createContext<SidebarState>({
  collapsed: false,
  toggleCollapse: () => {},
  mobileOpen: false,
  toggleMobile: () => {},
});

export const useMCSidebar = () => useContext(SidebarCtx);

/* ── Shell ──────────────────────────────────────────────────────────────────── */

export function DashboardShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  // Close mobile sidebar on navigation
  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  // Close on Escape
  useEffect(() => {
    if (!mobileOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMobileOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [mobileOpen]);

  const toggleCollapse = useCallback(() => setCollapsed((c) => !c), []);
  const toggleMobile = useCallback(() => setMobileOpen((o) => !o), []);

  return (
    <SidebarCtx.Provider value={{ collapsed, toggleCollapse, mobileOpen, toggleMobile }}>
      <div className="flex h-screen bg-background overflow-hidden">
        {/* Mobile backdrop */}
        {mobileOpen && (
          <div
            className="fixed inset-0 z-40 bg-black/40 md:hidden"
            onClick={toggleMobile}
            aria-hidden="true"
          />
        )}
        {children}
      </div>
    </SidebarCtx.Provider>
  );
}
