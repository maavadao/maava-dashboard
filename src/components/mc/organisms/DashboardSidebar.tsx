'use client';

import * as React from 'react';
import Link from '@/components/member-link';
import { usePathname } from '@/lib/member-path';
import {
  Activity,
  BarChart3,
  Bot,
  CheckCircle2,
  LayoutGrid,
  ClipboardList,
  MessageSquare,
  Settings,
  ChevronDown,
  LogOut,
  PanelLeftClose,
  PanelLeft,
  Zap,
  X,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAuth } from '@/hooks';
import { ROUTES, APP_NAME } from '@/lib/constants';
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui';
import { useMCSidebar } from '@/components/mc/templates/DashboardShell';

const MC = '/mission-control';

/* ── Sidebar nav item (matches tenant SidebarItem) ─────────────────────────── */

function NavItem({
  href,
  icon: Icon,
  label,
  isActive,
  collapsed,
}: {
  href: string;
  icon: React.ElementType;
  label: string;
  isActive: boolean;
  collapsed?: boolean;
}) {
  return (
    <Link
      href={href}
      className={cn(
        'flex items-center rounded-lg text-sm font-medium transition-colors w-full',
        collapsed ? 'justify-center px-2 py-2.5' : 'gap-3 px-3 py-2.5',
        isActive
          ? 'bg-mawadao-50 dark:bg-primary/10 text-primary'
          : 'text-muted-foreground hover:text-foreground hover:bg-muted',
      )}
      title={collapsed ? label : undefined}
    >
      <Icon className="h-[18px] w-[18px] shrink-0" />
      {!collapsed && <span className="flex-1 truncate">{label}</span>}
    </Link>
  );
}

/* ── Section divider ────────────────────────────────────────────────────────── */

function NavSection({ label, collapsed }: { label: string; collapsed?: boolean }) {
  if (collapsed) return <div className="my-2 mx-2 h-px bg-border" />;
  return (
    <p className="px-3 pt-5 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
      {label}
    </p>
  );
}

/* ── User card (matches tenant SidebarUserCard) ─────────────────────────────── */

function UserCard({ compact }: { compact?: boolean }) {
  const { user, agent, logout } = useAuth();
  const displayName = user?.displayName || user?.username || agent?.displayName || agent?.name || 'User';
  const avatarUrl = user?.avatarUrl || agent?.avatarUrl;
  const initials = displayName.slice(0, 2).toUpperCase();
  const [open, setOpen] = React.useState(false);
  const wrapperRef = React.useRef<HTMLDivElement>(null);

  // Close dropdown when clicking outside
  React.useEffect(() => {
    if (!open) return;
    const handleOutside = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleOutside);
    return () => document.removeEventListener('mousedown', handleOutside);
  }, [open]);

  return (
    <div className="relative" ref={wrapperRef}>
      <button
        type="button"
        onClick={() => {
          if (compact) return;        // prevent dropdown when collapsed
          setOpen(!open);
        }}
        className={cn(
          'flex items-center gap-2 w-full rounded-lg transition-colors text-left hover:bg-muted',
          compact ? 'justify-center px-2 py-2 cursor-default' : 'px-2 py-2',
        )}
      >
        <Avatar className="h-8 w-8 shrink-0">
          <AvatarImage src={avatarUrl} />
          <AvatarFallback className="bg-mawadao-100 text-mawadao-700 text-xs font-medium">
            {initials}
          </AvatarFallback>
        </Avatar>
        {!compact && (
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium truncate">{displayName}</p>
            <p className="text-xs text-muted-foreground truncate">
              {user?.email || 'Agent account'}
            </p>
          </div>
        )}
        {!compact && (
          <ChevronDown
            className={cn(
              'h-3.5 w-3.5 text-muted-foreground transition-transform shrink-0',
              open && 'rotate-180',
            )}
          />
        )}
      </button>

      {open && !compact && (
        <div className="absolute bottom-full left-0 right-0 mb-1 rounded-xl border border-border bg-card shadow-elevated p-1.5 animate-scale-in z-50 min-w-[180px]">
          <Link
            href={ROUTES.SETTINGS}
            onClick={() => setOpen(false)}
            className="flex items-center gap-2.5 px-3 py-2 text-sm rounded-lg hover:bg-muted transition-colors text-foreground"
          >
            <Settings className="h-4 w-4 text-muted-foreground" />
            Settings
          </Link>
          <button
            onClick={() => {
              logout();
              setOpen(false);
            }}
            className="flex items-center gap-2.5 px-3 py-2 text-sm rounded-lg hover:bg-muted transition-colors w-full text-left text-red-600 dark:text-red-400"
          >
            <LogOut className="h-4 w-4" />
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

/* ── Navigation links (shared between desktop & mobile) ─────────────────────── */

function SidebarNav({ collapsed }: { collapsed?: boolean }) {
  const pathname = usePathname();

  return (
    <nav className={cn('flex-1 overflow-y-auto', collapsed ? 'px-2' : 'px-3 space-y-0.5')}>
      <NavSection label="Overview" collapsed={collapsed} />
      <NavItem href={MC} icon={BarChart3} label="Dashboard" isActive={pathname === MC || pathname === `${MC}/`} collapsed={collapsed} />
      <NavItem href={`${MC}/activity`} icon={Activity} label="Live feed" isActive={pathname.startsWith(`${MC}/activity`)} collapsed={collapsed} />
      <NavItem href={`${MC}/agent-tasks`} icon={Zap} label="Agent Tasks" isActive={pathname.startsWith(`${MC}/agent-tasks`)} collapsed={collapsed} />

      <NavSection label="Boards" collapsed={collapsed} />
      <NavItem href={`${MC}/boards`} icon={LayoutGrid} label="Boards" isActive={pathname.startsWith(`${MC}/boards`)} collapsed={collapsed} />
      <NavItem href={`${MC}/approvals`} icon={CheckCircle2} label="Approvals" isActive={pathname.startsWith(`${MC}/approvals`)} collapsed={collapsed} />

      <NavSection label="Administration" collapsed={collapsed} />
      <NavItem href={`${MC}/agents`} icon={Bot} label="Agents" isActive={pathname.startsWith(`${MC}/agents`)} collapsed={collapsed} />

      {/* Divider + quick links */}
      {!collapsed ? <div className="my-3 mx-1 h-px bg-border" /> : <div className="my-2 mx-2 h-px bg-border" />}

      <NavItem href="/" icon={MessageSquare} label="Back to Chat" isActive={false} collapsed={collapsed} />
      <NavItem href={ROUTES.SETTINGS} icon={Settings} label="Settings" isActive={false} collapsed={collapsed} />
    </nav>
  );
}

/* ── Main export ────────────────────────────────────────────────────────────── */

export function DashboardSidebar() {
  const { collapsed, toggleCollapse, mobileOpen, toggleMobile } = useMCSidebar();

  return (
    <>
      {/* ── Desktop sidebar ── */}
      <aside
        className={cn(
          'hidden md:flex flex-col h-screen border-r border-border bg-gradient-to-b from-background to-muted/30 sticky top-0 overflow-y-auto transition-all duration-300 ease-in-out',
          collapsed ? 'w-[68px] min-w-[68px]' : 'w-[260px] min-w-[260px]',
        )}
      >
        {/* Logo */}
        {collapsed ? (
          <div className="flex justify-center py-5 px-2">
            <button
              type="button"
              onClick={toggleCollapse}
              className="h-8 w-8 rounded-lg bg-primary flex items-center justify-center shrink-0 hover:bg-primary/90 transition-colors"
              title="Expand sidebar"
            >
              <PanelLeft className="h-4 w-4 text-white" />
            </button>
          </div>
        ) : (
          <div className="flex items-center justify-between px-5 py-5">
            <Link href={ROUTES.HOME} className="flex items-center gap-2.5">
              <div className="h-8 w-8 rounded-lg bg-primary flex items-center justify-center shrink-0">
                <span className="text-white font-bold text-sm">m</span>
              </div>
              <span className="text-lg font-bold text-foreground">{APP_NAME}</span>
            </Link>
            <button
              type="button"
              onClick={toggleCollapse}
              className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
              title="Collapse sidebar"
            >
              <PanelLeftClose className="h-4 w-4" />
            </button>
          </div>
        )}

        <SidebarNav collapsed={collapsed} />

        {/* User card */}
        <div className={cn('border-t border-border', collapsed ? 'p-2' : 'p-3')}>
          <UserCard compact={collapsed} />
        </div>
      </aside>

      {/* ── Mobile sidebar (slides in from left) ── */}
      {mobileOpen && (
        <aside className="fixed left-0 top-0 z-50 flex flex-col h-full w-[280px] border-r border-border bg-card shadow-xl md:hidden animate-slide-in-left">
          {/* Mobile header with close button */}
          <div className="flex items-center justify-between px-5 py-5">
            <Link href={ROUTES.HOME} className="flex items-center gap-2.5">
              <div className="h-8 w-8 rounded-lg bg-primary flex items-center justify-center shrink-0">
                <span className="text-white font-bold text-sm">m</span>
              </div>
              <span className="text-lg font-bold text-foreground">{APP_NAME}</span>
            </Link>
            <button
              type="button"
              onClick={toggleMobile}
              className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <SidebarNav />

          <div className="border-t border-border p-3">
            <UserCard />
          </div>
        </aside>
      )}
    </>
  );
}
