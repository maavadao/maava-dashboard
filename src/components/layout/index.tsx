'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import { useAuth } from '@/hooks';
import { ROUTES, APP_NAME } from '@/lib/constants';
import { Button, Avatar, AvatarImage, AvatarFallback } from '@/components/ui';
import {
  MessageSquare,
  Radio,
  Settings,
} from 'lucide-react';
import { SidebarLayout } from '@/components/layout/sidebar';

// =============================================================================
// mawaDao Logo
// =============================================================================
export function MawadaoLogo({ className }: { className?: string }) {
  return (
    <Link href={ROUTES.HOME} className={cn('flex items-center gap-2.5', className)}>
      <div className="h-8 w-8 rounded-lg bg-primary flex items-center justify-center">
        <span className="text-white font-bold text-sm">m</span>
      </div>
      <span className="text-lg font-bold text-foreground hidden sm:block">{APP_NAME}</span>
    </Link>
  );
}

// =============================================================================
// Top Navigation Bar (kept for unauthenticated pages & landing)
// =============================================================================
const NAV_ITEMS = [
  { href: ROUTES.CHAT, label: 'Chat', icon: MessageSquare },
  { href: ROUTES.CHANNELS, label: 'Channels', icon: Radio },
];

export function TopNav() {
  const pathname = usePathname();
  const { isAuthenticated, user, agent, logout } = useAuth();

  // Landing page has its own nav — hide TopNav for unauthenticated users on home
  if (!isAuthenticated && pathname === '/') return null;
  // Sidebar layout pages handle their own nav when authenticated
  if (isAuthenticated) return null;

  return (
    <header className="sticky top-0 z-50 w-full border-b bg-white/95 dark:bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-white/80 dark:supports-[backdrop-filter]:bg-background/80 shadow-nav">
      <div className="container-main flex h-16 items-center justify-between">
        <MawadaoLogo />
        <div className="flex items-center gap-2">
          <Link href={ROUTES.LOGIN}>
            <Button variant="outline" size="sm">Sign in</Button>
          </Link>
          <Link href={ROUTES.LOGIN}>
            <Button size="sm">Get Started</Button>
          </Link>
        </div>
      </div>
    </header>
  );
}

// =============================================================================
// Mobile Bottom Navigation
// =============================================================================
export function MobileBottomNav() {
  const pathname = usePathname();
  const { isAuthenticated } = useAuth();

  if (!isAuthenticated) return null;

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-50 md:hidden border-t bg-white/95 dark:bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-white/80 dark:supports-[backdrop-filter]:bg-background/80 safe-area-bottom">
      <div className="flex items-center justify-around h-14">
        {NAV_ITEMS.map((item) => {
          const isActive = pathname === item.href || pathname.startsWith(item.href + '/');
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                'flex flex-col items-center gap-0.5 px-3 py-1.5 rounded-lg transition-colors',
                isActive ? 'text-primary' : 'text-muted-foreground'
              )}
            >
              <item.icon className="h-5 w-5" />
              <span className="text-[10px] font-medium">{item.label}</span>
            </Link>
          );
        })}
        <Link
          href={ROUTES.SETTINGS}
          className={cn(
            'flex flex-col items-center gap-0.5 px-3 py-1.5 rounded-lg transition-colors',
            pathname === ROUTES.SETTINGS ? 'text-primary' : 'text-muted-foreground'
          )}
        >
          <Settings className="h-5 w-5" />
          <span className="text-[10px] font-medium">Settings</span>
        </Link>
      </div>
    </nav>
  );
}

// =============================================================================
// Page Container
// =============================================================================
export function PageContainer({ children, className, fullWidth }: { children: React.ReactNode; className?: string; fullWidth?: boolean }) {
  return (
    <main className={cn(
      fullWidth ? 'w-full' : 'container-main',
      'py-6 md:py-8',
      className
    )}>
      {children}
    </main>
  );
}

// =============================================================================
// Authenticated Layout — Sidebar + content (desktop); TopNav + mobile bottom nav (mobile)
// =============================================================================
export function AppLayout({ children }: { children: React.ReactNode }) {
  const { isAuthenticated } = useAuth();
  const pathname = usePathname();

  // Landing page: no layout wrapper
  if (pathname === '/' && !isAuthenticated) {
    return (
      <div className="min-h-screen bg-background">
        <TopNav />
        {children}
      </div>
    );
  }

  // Authenticated: sidebar layout (sidebar is rendered per-page, but we provide the default)
  if (isAuthenticated) {
    return (
      <div className="min-h-screen bg-background">
        {/* Sidebar pages render their own sidebar — this is just a fallback with mobile nav */}
        {children}
        <MobileBottomNav />
      </div>
    );
  }

  // Unauthenticated non-landing pages
  return (
    <div className="min-h-screen bg-background">
      <TopNav />
      {children}
    </div>
  );
}

// Re-export for backwards compatibility
export function MainLayout({ children }: { children: React.ReactNode }) {
  return <AppLayout>{children}</AppLayout>;
}

export function Header() { return null; }
export function Sidebar() { return null; }
export function MobileMenu() { return null; }
export function Footer() { return null; }
export function Layout({ children }: { children: React.ReactNode }) {
  return <AppLayout>{children}</AppLayout>;
}
