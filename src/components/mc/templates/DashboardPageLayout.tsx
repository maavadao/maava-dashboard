'use client';

import type { ReactNode } from 'react';
import { Menu } from 'lucide-react';
import { DashboardShell, useMCSidebar } from '@/components/mc/templates/DashboardShell';
import { DashboardSidebar } from '@/components/mc/organisms/DashboardSidebar';

interface DashboardPageLayoutProps {
  title: string;
  description?: string;
  headerActions?: ReactNode;
  children: ReactNode;
}

function PageHeader({
  title,
  description,
  headerActions,
}: Omit<DashboardPageLayoutProps, 'children'>) {
  const { toggleMobile } = useMCSidebar();

  return (
    <div className="sticky top-0 z-30 flex items-start justify-between gap-4 border-b border-border bg-background/80 px-6 py-4 backdrop-blur-sm">
      <div className="flex items-center gap-3 min-w-0">
        {/* Mobile hamburger — only visible below md */}
        <button
          type="button"
          className="rounded-lg p-2 text-muted-foreground hover:bg-muted md:hidden shrink-0"
          onClick={toggleMobile}
          aria-label="Open sidebar"
        >
          <Menu className="h-5 w-5" />
        </button>
        <div className="min-w-0">
          <h1 className="text-xl font-bold text-foreground">{title}</h1>
          {description ? (
            <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>
          ) : null}
        </div>
      </div>
      {headerActions ? (
        <div className="flex shrink-0 items-center gap-2">{headerActions}</div>
      ) : null}
    </div>
  );
}

export function DashboardPageLayout({
  title,
  description,
  headerActions,
  children,
}: DashboardPageLayoutProps) {
  return (
    <DashboardShell>
      <DashboardSidebar />
      <main className="flex flex-col flex-1 min-w-0 h-full overflow-y-auto">
        <PageHeader title={title} description={description} headerActions={headerActions} />
        <div className="flex-1 p-6">{children}</div>
      </main>
    </DashboardShell>
  );
}
