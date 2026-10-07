'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { cn } from '@/lib/utils';
import { useAuth } from '@/hooks';
import { useSkillsStore } from '@/store';
import { ROUTES, APP_NAME } from '@/lib/constants';
import { Avatar, AvatarImage, AvatarFallback, Button, Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui';
import {
  MessageSquare,
  Bell,
  Radio,
  Settings,
  Search,
  Plus,
  Pin,
  CreditCard,
  Shield,
  ChevronDown,
  LogOut,
  User,
  Palette,
  Sparkles,
  PanelLeftClose,
  PanelLeft,
  Trash2,
  Pencil,
  Check,
  Rocket,
  LayoutDashboard,
  ClipboardList,
  Bot,
  CheckCircle2,
  Activity,
  X,
  HardDrive,
  Store,
  KeyRound,
  Settings2,
  ArrowLeft,
  Zap,
  ShoppingBag,
  Package,
  Send,
  CalendarClock,
  Share2,
  Eye,
  Wallet,
  Menu,
  Inbox,
  Mail,
  ShieldCheck,
  Star,
  FileText,
  AlertOctagon,
  Tag,
} from 'lucide-react';
import useSWR from 'swr';
import { getSkillConnectionRequirements, type ConnectionRequirement } from '@/lib/skill-connections';

// =============================================================================
// Sidebar Shell — consistent frame for all sidebar variants
// =============================================================================
function SidebarShell({
  children,
  className,
  collapsed = false,
}: {
  children: React.ReactNode;
  className?: string;
  collapsed?: boolean;
}) {
  return (
    <aside
      className={cn(
        'hidden md:flex flex-col h-screen border-r border-border bg-gradient-to-b from-background to-muted/30 sticky top-0 overflow-y-auto transition-all duration-300 ease-in-out',
        collapsed ? 'w-[68px] min-w-[68px]' : 'w-[260px] min-w-[260px]',
        className
      )}
    >
      {children}
    </aside>
  );
}

// Sidebar logo header with collapse toggle
function SidebarLogo({ collapsed, onToggleCollapse }: { collapsed?: boolean; onToggleCollapse?: () => void }) {
  if (collapsed) {
    return (
      <div className="flex justify-center py-5 px-2">
        <button
          type="button"
          onClick={onToggleCollapse}
          className="h-8 w-8 rounded-lg bg-primary flex items-center justify-center shrink-0 hover:bg-primary/90 transition-colors"
          title="Expand sidebar"
        >
          <PanelLeft className="h-4 w-4 text-white" />
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between px-5 py-5">
      <Link href={ROUTES.HOME} className="flex items-center gap-2.5">
        <div className="h-8 w-8 rounded-lg bg-primary flex items-center justify-center shrink-0">
          <span className="text-white font-bold text-sm">B</span>
        </div>
        <span className="text-lg font-bold text-foreground">{APP_NAME}</span>
      </Link>
      {onToggleCollapse && (
        <button
          type="button"
          onClick={onToggleCollapse}
          className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          title="Collapse sidebar"
        >
          <PanelLeftClose className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}

// Sidebar nav item
function SidebarItem({
  href,
  icon: Icon,
  label,
  isActive,
  badge,
  onClick,
  external,
  collapsed,
}: {
  href?: string;
  icon: React.ElementType;
  label: string;
  isActive?: boolean;
  badge?: string | number;
  onClick?: () => void;
  external?: boolean;
  collapsed?: boolean;
}) {
  const classes = cn(
    'flex items-center rounded-lg text-sm font-medium transition-colors w-full',
    collapsed ? 'justify-center px-2 py-2.5' : 'justify-start text-left gap-3 px-3 py-2.5',
    isActive
      ? 'bg-barrsa-50 dark:bg-primary/10 text-primary'
      : 'text-muted-foreground hover:text-foreground hover:bg-muted'
  );

  const content = (
    <>
      <Icon className="h-[18px] w-[18px] shrink-0" />
      {!collapsed && <span className="flex-1 truncate">{label}</span>}
      {!collapsed && badge !== undefined && (
        <span className="text-xs bg-muted text-muted-foreground rounded-full px-2 py-0.5 font-normal">
          {badge}
        </span>
      )}
    </>
  );

  if (onClick) {
    return (
      <button type="button" className={classes} onClick={onClick} title={collapsed ? label : undefined}>
        {content}
      </button>
    );
  }

  if (external) {
    return (
      <a href={href || '#'} target="_blank" rel="noopener noreferrer" className={classes} title={collapsed ? label : undefined}>
        {content}
      </a>
    );
  }

  return (
    <Link href={href || '#'} className={classes} title={collapsed ? label : undefined}>
      {content}
    </Link>
  );
}

// Section label
function SidebarSection({ label, collapsed }: { label: string; collapsed?: boolean }) {
  if (collapsed) return <div className="my-2 mx-2 h-px bg-border" />;
  return (
    <p className="px-3 pt-5 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
      {label}
    </p>
  );
}

// =============================================================================
// CHAT SIDEBAR — used for Chat page with thread history
// =============================================================================

type InstalledSkill = {
  id: string;
  skill_id: string;
  name: string;
  description?: string;
  category: string;
  source?: string;
  is_installed: boolean;
};

/** Extract human-readable display name from a skill.
 * Description format: "Pretty Name → from source/repo"
 * The stored name field is just the raw slug (same as skill_id).
 */
function getSkillDisplayName(skill: InstalledSkill): string {
  if (skill.description) {
    // Split on " â " (mangled â†') or " → " or " - from "
    const arrowIdx = skill.description.indexOf(' â ');
    if (arrowIdx > 0) return skill.description.slice(0, arrowIdx).trim();
    const arrowIdx2 = skill.description.indexOf(' → ');
    if (arrowIdx2 > 0) return skill.description.slice(0, arrowIdx2).trim();
  }
  // Fallback: convert kebab-case slug to Title Case
  return skill.name
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

type BrowseSkill = {
  id: string;
  skill_id: string;
  name: string;
  description?: string;
  category: string;
  source: string;
  source_url?: string;
  installs?: number;
};

function InstalledSkillsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { user, agent } = useAuth();
  const userId = user?.id || agent?.id || 'anonymous';
  const { setEnabledSkills } = useSkillsStore();

  // ── tab state ──────────────────────────────────────────────────────────────
  const [tab, setTab] = React.useState<'installed' | 'recommended' | 'browse'>('installed');

  // ── installed tab state ────────────────────────────────────────────────────
  const [skills, setSkills] = React.useState<InstalledSkill[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [toggling, setToggling] = React.useState<string | null>(null);
  const [uninstalling, setUninstalling] = React.useState<string | null>(null);

  // ── browse tab state ───────────────────────────────────────────────────────
  const [browseSkills, setBrowseSkills] = React.useState<BrowseSkill[]>([]);
  const [browseLoading, setBrowseLoading] = React.useState(false);
  const [browseQuery, setBrowseQuery] = React.useState('');
  const [installingId, setInstallingId] = React.useState<string | null>(null);
  const [browsePage, setBrowsePage] = React.useState(1);
  const [browseHasMore, setBrowseHasMore] = React.useState(false);

  // ── recommended tab state ──────────────────────────────────────────────────
  const [recommendedSkills, setRecommendedSkills] = React.useState<InstalledSkill[]>([]);
  const [recommendedLoading, setRecommendedLoading] = React.useState(false);
  const [enablingId, setEnablingId] = React.useState<string | null>(null);

  // ── connections state ──────────────────────────────────────────────────────
  // connections: { skillKey → [envKey, ...] } — which keys are configured (no values)
  const [connections, setConnections] = React.useState<Record<string, string[]>>({});
  const [connectionsLoaded, setConnectionsLoaded] = React.useState(false);

  // ── configure skill modal state ────────────────────────────────────────────
  const [configuringSkill, setConfiguringSkill] = React.useState<{
    skillId: string;
    name: string;
    requirements: ConnectionRequirement[];
  } | null>(null);
  const [configValues, setConfigValues] = React.useState<Record<string, string>>({});
  const [configSaving, setConfigSaving] = React.useState(false);

  const toEnabledSkills = React.useCallback((list: InstalledSkill[]) => (
    list
      .filter((s) => s.is_installed)
      .map((s) => ({ skill_id: s.skill_id, name: s.name, category: s.category }))
  ), []);

  // ── reset connections when dialog closes ────────────────────────────────────
  React.useEffect(() => {
    if (!open) {
      setConnectionsLoaded(false);
      setConfiguringSkill(null);
      setConfigValues({});
    }
  }, [open]);

  // ── load connections on open ──────────────────────────────────────────────
  React.useEffect(() => {
    if (!open || connectionsLoaded) return;
    fetch('/api/skills/connections', { headers: { 'x-user-id': userId } })
      .then((r) => r.json())
      .then((data: { connections?: Record<string, string[]> }) => {
        setConnections(data.connections ?? {});
        setConnectionsLoaded(true);
      })
      .catch(() => setConnectionsLoaded(true));
  }, [open, connectionsLoaded, userId]);

  // ── scan workspace for agent-created skills (runs once on open) ────────────
  const [workspaceScanDone, setWorkspaceScanDone] = React.useState(false);
  React.useEffect(() => {
    if (!open) { setWorkspaceScanDone(false); return; }
    if (workspaceScanDone) return;
    // Fire-and-forget: scan workspace skills in background
    fetch('/api/skills/workspace-scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
    })
      .then(() => setWorkspaceScanDone(true))
      .catch(() => setWorkspaceScanDone(true));
  }, [open, workspaceScanDone, userId]);

  // ── fetch installed skills ─────────────────────────────────────────────────
  React.useEffect(() => {
    if (open && tab === 'installed') {
      setLoading(true);
      fetch('/api/skills?installed=true&limit=100', {
        headers: { 'x-user-id': userId },
      })
        .then((res) => res.json())
        .then((data) => {
          const list = data.data || [];
          setSkills(list);
          setEnabledSkills(toEnabledSkills(list));
        })
        .catch(() => {})
        .finally(() => setLoading(false));
    }
  }, [open, tab, userId, setEnabledSkills, toEnabledSkills, workspaceScanDone]);

  // ── fetch recommended skills ───────────────────────────────────────────────
  React.useEffect(() => {
    if (open && tab === 'recommended') {
      setRecommendedLoading(true);
      fetch('/api/skills?installed=recommended&limit=100', {
        headers: { 'x-user-id': userId },
      })
        .then((res) => res.json())
        .then((data) => setRecommendedSkills(data.data || []))
        .catch(() => {})
        .finally(() => setRecommendedLoading(false));
    }
  }, [open, tab, userId]);

  // ── fetch browse skills ────────────────────────────────────────────────────
  const fetchBrowse = React.useCallback((q: string, page: number) => {
    setBrowseLoading(true);
    const params = new URLSearchParams({
      limit: '20',
      page: String(page),
      ...(q ? { q } : {}),
    });
    fetch(`/api/skills?${params}`, { headers: { 'x-user-id': userId } })
      .then((res) => res.json())
      .then((data) => {
        const items: BrowseSkill[] = data.data || [];
        setBrowseSkills((prev) => (page === 1 ? items : [...prev, ...items]));
        setBrowseHasMore(data.pagination?.hasMore ?? false);
      })
      .catch(() => {})
      .finally(() => setBrowseLoading(false));
  }, [userId]);

  React.useEffect(() => {
    if (open && tab === 'browse') {
      setBrowsePage(1);
      fetchBrowse(browseQuery, 1);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, tab]);

  // debounced search
  React.useEffect(() => {
    if (tab !== 'browse') return;
    const timer = setTimeout(() => {
      setBrowsePage(1);
      fetchBrowse(browseQuery, 1);
    }, 350);
    return () => clearTimeout(timer);
  }, [browseQuery, tab, fetchBrowse]);

  // ── installed tab handlers ─────────────────────────────────────────────────
  const handleToggle = async (skill: InstalledSkill) => {
    setToggling(skill.skill_id);
    const previous = skills;
    const newEnabled = !skill.is_installed;
    setSkills((prev) => {
      const next = prev.map((s) =>
        s.skill_id === skill.skill_id && (s.source ?? '') === (skill.source ?? '')
          ? { ...s, is_installed: newEnabled }
          : s
      );
      setEnabledSkills(toEnabledSkills(next));
      return next;
    });
    try {
      const res = await fetch('/api/skills/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
        body: JSON.stringify({ skillId: skill.skill_id, source: skill.source, enabled: newEnabled }),
      });
      if (!res.ok) {
        setSkills(previous);
        setEnabledSkills(toEnabledSkills(previous));
      }
    } catch {
      setSkills(previous);
      setEnabledSkills(toEnabledSkills(previous));
    } finally {
      setToggling(null);
    }
  };

  const handleUninstall = async (skill: InstalledSkill) => {
    setUninstalling(skill.skill_id);
    const previous = skills;
    setSkills((prev) => {
      const next = prev.filter((s) => !(s.skill_id === skill.skill_id && (s.source ?? '') === (skill.source ?? '')));
      setEnabledSkills(toEnabledSkills(next));
      return next;
    });
    try {
      const res = await fetch('/api/skills/uninstall', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
        body: JSON.stringify({ skillId: skill.skill_id, source: skill.source }),
      });
      if (!res.ok) {
        setSkills(previous);
        setEnabledSkills(toEnabledSkills(previous));
      }
    } catch {
      setSkills(previous);
      setEnabledSkills(toEnabledSkills(previous));
    } finally {
      setUninstalling(null);
    }
  };

  // Helper: refetch the installed-skills list so newly installed entries appear
  // immediately in the Installed tab without requiring a page reload.
  const refetchInstalled = React.useCallback(async () => {
    try {
      const res = await fetch('/api/skills?installed=true&limit=100', {
        headers: { 'x-user-id': userId },
      });
      const data = await res.json();
      const list = data.data || [];
      setSkills(list);
      setEnabledSkills(toEnabledSkills(list));
    } catch {
      // non-fatal — user can switch tabs to retry
    }
  }, [userId, setEnabledSkills, toEnabledSkills]);

  // ── browse tab handler ─────────────────────────────────────────────────────
  const handleInstall = async (skill: BrowseSkill) => {
    setInstallingId(skill.id);
    try {
      const res = await fetch('/api/skills/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
        body: JSON.stringify({ skillId: skill.skill_id, source: skill.source }),
      });
      if (res.ok) {
        // optimistically remove from browse list (already installed, won't show again)
        setBrowseSkills((prev) => prev.filter((s) => s.id !== skill.id));
        // Refresh installed list so the user sees it under Installed immediately
        await refetchInstalled();
        // If skill has API key requirements, open configure modal
        const reqs = getSkillConnectionRequirements(skill.skill_id);
        if (reqs.length > 0) {
          setConfigValues({});
          setConfiguringSkill({ skillId: skill.skill_id, name: skill.name, requirements: reqs });
        } else {
          // Switch to Installed so the user gets visual confirmation
          setTab('installed');
        }
      }
    } catch {
      // silent – user can retry
    } finally {
      setInstallingId(null);
    }
  };

  // ── recommended tab handler: install a recommended skill ─────────────────
  const handleEnableRecommended = async (skill: InstalledSkill) => {
    setEnablingId(skill.skill_id);
    try {
      const res = await fetch('/api/skills/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
        body: JSON.stringify({ skillId: skill.skill_id, source: skill.source }),
      });
      if (res.ok) {
        // Remove from recommended list (it's now active → will show in Installed)
        setRecommendedSkills((prev) => prev.filter((s) => s.skill_id !== skill.skill_id));
        // Refresh installed list so the user sees it under Installed immediately
        await refetchInstalled();
        // If skill has API key requirements, open configure modal
        const reqs = getSkillConnectionRequirements(skill.skill_id);
        if (reqs.length > 0) {
          setConfigValues({});
          setConfiguringSkill({ skillId: skill.skill_id, name: getSkillDisplayName(skill), requirements: reqs });
        } else {
          setTab('installed');
        }
      }
    } catch {
      // silent – user can retry
    } finally {
      setEnablingId(null);
    }
  };

  // ── configure skill API keys ───────────────────────────────────────────────
  const handleSaveConnections = async () => {
    if (!configuringSkill) return;
    setConfigSaving(true);
    try {
      const savePromises = Object.entries(configValues)
        .filter(([, v]) => v.trim())
        .map(([envKey, value]) =>
          fetch('/api/skills/connections', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
            body: JSON.stringify({ skillKey: configuringSkill.skillId, envKey, value: value.trim() }),
          }),
        );
      await Promise.all(savePromises);
      // Update local connections state (mark these envKeys as configured)
      const newEnvKeys = Object.entries(configValues)
        .filter(([, v]) => v.trim())
        .map(([envKey]) => envKey);
      if (newEnvKeys.length > 0) {
        setConnections((prev) => ({
          ...prev,
          [configuringSkill.skillId]: Array.from(
            new Set([...(prev[configuringSkill.skillId] ?? []), ...newEnvKeys])
          ),
        }));
      }
      setConfiguringSkill(null);
      setConfigValues({});
    } catch {
      // silent – show error in future enhancement
    } finally {
      setConfigSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {configuringSkill ? (
              <>
                <KeyRound className="h-5 w-5 text-primary" />
                Configure: {configuringSkill.name}
              </>
            ) : (
              <>
                <Sparkles className="h-5 w-5 text-primary" />
                Skills
              </>
            )}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {configuringSkill
              ? `Configure API keys for ${configuringSkill.name}`
              : 'Manage your installed skills or browse the community hub.'}
          </DialogDescription>
        </DialogHeader>

        {/* ── configure view (shown when configuring a skill) ── */}
        {configuringSkill && (
          <div className="flex flex-col gap-4">
            <div className="max-h-[420px] overflow-y-auto space-y-4 -mx-1 px-1">
              {configuringSkill.requirements.map((req) => {
                const isConfigured = (connections[configuringSkill.skillId] ?? []).includes(req.envKey);
                return (
                  <div key={req.envKey} className="space-y-1.5">
                    <label className="text-sm font-medium flex items-center gap-2">
                      {req.label}
                      {req.required && <span className="text-[10px] text-destructive/70">required</span>}
                      {isConfigured && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-green-50 dark:bg-green-900/20 text-green-600 dark:text-green-400">
                          ✓ configured
                        </span>
                      )}
                    </label>
                    <input
                      type="password"
                      placeholder={isConfigured ? '••••••••  (leave blank to keep current)' : req.placeholder}
                      value={configValues[req.envKey] ?? ''}
                      onChange={(e) =>
                        setConfigValues((prev) => ({ ...prev, [req.envKey]: e.target.value }))
                      }
                      autoComplete="off"
                      spellCheck={false}
                      className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-primary/40"
                    />
                    <p className="text-xs text-muted-foreground">{req.description}</p>
                    {req.link && (
                      <a
                        href={req.link}
                        target="_blank"
                        rel="noreferrer"
                        className="text-xs text-primary hover:underline"
                      >
                        Get key →
                      </a>
                    )}
                  </div>
                );
              })}
            </div>
            <div className="flex items-center gap-2 justify-between pt-1">
              <button
                type="button"
                onClick={() => { setConfiguringSkill(null); setConfigValues({}); }}
                className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
              >
                <ArrowLeft className="h-4 w-4" />
                Back
              </button>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => { setConfiguringSkill(null); setConfigValues({}); }}
                  className="rounded-lg border border-input px-3 py-1.5 text-sm text-muted-foreground hover:bg-muted transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleSaveConnections}
                  disabled={configSaving || Object.values(configValues).every((v) => !v.trim())}
                  className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-60 flex items-center gap-1.5"
                >
                  {configSaving && (
                    <span className="h-3.5 w-3.5 border border-primary-foreground border-t-transparent rounded-full animate-spin" />
                  )}
                  Save keys
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── tab switcher + content (hidden when configuring) ── */}
        {!configuringSkill && (
        <>
        <div className="flex rounded-lg bg-muted p-1 gap-1 -mt-1">
          <button
            type="button"
            onClick={() => setTab('installed')}
            className={cn(
              'flex-1 rounded-md py-1.5 text-sm font-medium transition-colors',
              tab === 'installed'
                ? 'bg-background shadow-sm text-foreground'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            Installed
          </button>
          <button
            type="button"
            onClick={() => setTab('recommended')}
            className={cn(
              'flex-1 rounded-md py-1.5 text-sm font-medium transition-colors',
              tab === 'recommended'
                ? 'bg-background shadow-sm text-foreground'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            Recommended
          </button>
          <button
            type="button"
            onClick={() => setTab('browse')}
            className={cn(
              'flex-1 rounded-md py-1.5 text-sm font-medium transition-colors',
              tab === 'browse'
                ? 'bg-background shadow-sm text-foreground'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            Browse Hub
          </button>
        </div>

        {/* ── installed tab ── */}
        {tab === 'installed' && (
          <div className="max-h-[380px] overflow-y-auto space-y-1 -mx-2">
            {loading ? (
              <div className="flex items-center justify-center py-8">
                <div className="h-5 w-5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
              </div>
            ) : skills.length === 0 ? (
              <div className="text-center py-8">
                <Sparkles className="h-8 w-8 text-muted-foreground/40 mx-auto mb-3" />
                <p className="text-sm text-muted-foreground">No installed skills yet</p>
                <button
                  type="button"
                  onClick={() => setTab('browse')}
                  className="mt-3 text-xs text-primary hover:underline"
                >
                  Browse the community hub →
                </button>
              </div>
            ) : (
              skills.map((skill) => (
                <div
                  key={skill.id}
                  className="flex items-center justify-between px-3 py-2.5 rounded-lg hover:bg-muted transition-colors"
                >
                  <div className="flex-1 min-w-0 mr-3">
                    <div className="flex items-center gap-1.5">
                      <p className="text-sm font-medium text-foreground">{getSkillDisplayName(skill)}</p>
                      {skill.source === 'workspace-created' && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-violet-50 dark:bg-violet-900/20 text-violet-600 dark:text-violet-400 border border-violet-200 dark:border-violet-700 font-medium shrink-0">
                          Created
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground">{skill.source === 'workspace-created' ? (skill.description || skill.category) : (skill.source ?? skill.category)}</p>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    {(() => {
                      const reqs = getSkillConnectionRequirements(skill.skill_id);
                      if (reqs.length === 0) return null;
                      const allConfigured = reqs.filter(r => r.required).every(r => (connections[skill.skill_id] ?? []).includes(r.envKey));
                      return (
                        <button
                          type="button"
                          onClick={() => { setConfigValues({}); setConfiguringSkill({ skillId: skill.skill_id, name: skill.name, requirements: reqs }); }}
                          className={cn(
                            'p-1.5 rounded-lg transition-colors',
                            allConfigured
                              ? 'text-muted-foreground hover:bg-muted hover:text-foreground'
                              : 'text-amber-500 hover:bg-amber-50 dark:hover:bg-amber-900/20'
                          )}
                          title={allConfigured ? 'API keys configured — click to update' : 'Configure required API keys'}
                        >
                          <Settings2 className="h-3.5 w-3.5" />
                        </button>
                      );
                    })()}
                    <button
                      type="button"
                      onClick={() => handleToggle(skill)}
                      disabled={toggling === skill.skill_id}
                      className={cn(
                        'relative h-6 w-11 rounded-full overflow-hidden transition-colors shrink-0 disabled:opacity-60',
                        skill.is_installed ? 'bg-primary' : 'bg-muted-foreground/30',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40'
                      )}
                      aria-label={`Toggle ${skill.name}`}
                    >
                      <span
                        className={cn(
                          'absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform duration-200',
                          skill.is_installed ? 'translate-x-5' : 'translate-x-0'
                        )}
                      />
                    </button>
                    <button
                      type="button"
                      onClick={() => handleUninstall(skill)}
                      disabled={uninstalling === skill.skill_id}
                      className="p-1.5 rounded-lg text-muted-foreground hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10 transition-colors disabled:opacity-60"
                      aria-label={`Uninstall ${skill.name}`}
                      title="Uninstall"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        )}

        {/* ── recommended tab ── */}
        {tab === 'recommended' && (
          <div className="max-h-[380px] overflow-y-auto space-y-1 -mx-2">
            {recommendedLoading ? (
              <div className="flex items-center justify-center py-8">
                <div className="h-5 w-5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
              </div>
            ) : recommendedSkills.length === 0 ? (
              <div className="text-center py-8">
                <Sparkles className="h-8 w-8 text-muted-foreground/40 mx-auto mb-3" />
                <p className="text-sm text-muted-foreground">No recommendations right now</p>
                <button
                  type="button"
                  onClick={() => setTab('browse')}
                  className="mt-3 text-xs text-primary hover:underline"
                >
                  Browse the community hub →
                </button>
              </div>
            ) : (
              recommendedSkills.map((skill) => (
                <div
                  key={skill.id}
                  className="flex items-start justify-between px-3 py-2.5 rounded-lg hover:bg-muted transition-colors"
                >
                  <div className="flex-1 min-w-0 mr-3">
                    <p className="text-sm font-medium text-foreground">{getSkillDisplayName(skill)}</p>
                    {skill.description && (
                      <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{skill.description}</p>
                    )}
                    <div className="flex flex-wrap items-center gap-1 mt-1">
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                        {skill.category}
                      </span>
                      {getSkillConnectionRequirements(skill.skill_id).length > 0 && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-50 dark:bg-amber-900/20 text-amber-600 dark:text-amber-400 border border-amber-200 dark:border-amber-700 flex items-center gap-0.5">
                          <KeyRound className="h-2.5 w-2.5" />
                          Needs API key
                        </span>
                      )}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleEnableRecommended(skill)}
                    disabled={enablingId === skill.skill_id}
                    className="shrink-0 flex items-center gap-1 rounded-lg bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-60"
                  >
                    {enablingId === skill.skill_id ? (
                      <span className="h-3 w-3 border border-primary-foreground border-t-transparent rounded-full animate-spin" />
                    ) : (
                      '+ Install'
                    )}
                  </button>
                </div>
              ))
            )}
          </div>
        )}

        {/* ── browse tab ── */}
        {tab === 'browse' && (
          <div className="flex flex-col gap-3">
            {/* search bar */}
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
              <input
                type="text"
                placeholder="Search 60,000+ community skills…"
                value={browseQuery}
                onChange={(e) => setBrowseQuery(e.target.value)}
                className="w-full rounded-lg border border-input bg-background py-2 pl-8 pr-3 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
              />
            </div>

            {/* skill list */}
            <div className="max-h-[340px] overflow-y-auto space-y-1.5 -mx-2 pr-1">
              {browseLoading && browseSkills.length === 0 ? (
                <div className="flex items-center justify-center py-8">
                  <div className="h-5 w-5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                </div>
              ) : browseSkills.length === 0 ? (
                <div className="text-center py-8">
                  <p className="text-sm text-muted-foreground">No skills found</p>
                </div>
              ) : (
                <>
                  {browseSkills.map((skill) => (
                    <div
                      key={skill.id}
                      className="flex items-start justify-between px-3 py-2.5 rounded-lg hover:bg-muted transition-colors"
                    >
                      <div className="flex-1 min-w-0 mr-3">
                        <p className="text-sm font-medium text-foreground">
                          {skill.name.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}
                        </p>
                        {skill.description && (
                          <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{skill.description}</p>
                        )}
                        <div className="flex flex-wrap items-center gap-1 mt-1">
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                            {skill.category}
                          </span>
                          {getSkillConnectionRequirements(skill.skill_id).length > 0 && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-50 dark:bg-amber-900/20 text-amber-600 dark:text-amber-400 border border-amber-200 dark:border-amber-700 flex items-center gap-0.5">
                              <KeyRound className="h-2.5 w-2.5" />
                              Needs API key
                            </span>
                          )}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleInstall(skill)}
                        disabled={installingId === skill.id}
                        className="shrink-0 flex items-center gap-1 rounded-lg bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-60"
                      >
                        {installingId === skill.id ? (
                          <span className="h-3 w-3 border border-primary-foreground border-t-transparent rounded-full animate-spin" />
                        ) : (
                          '+ Install'
                        )}
                      </button>
                    </div>
                  ))}
                  {browseHasMore && (
                    <button
                      type="button"
                      onClick={() => {
                        const next = browsePage + 1;
                        setBrowsePage(next);
                        fetchBrowse(browseQuery, next);
                      }}
                      disabled={browseLoading}
                      className="w-full py-2 text-xs text-primary hover:underline disabled:opacity-60"
                    >
                      {browseLoading ? 'Loading…' : 'Load more'}
                    </button>
                  )}
                </>
              )}
            </div>
          </div>
        )}
        </> /* end !configuringSkill */
        )}
      </DialogContent>
    </Dialog>
  );
}

export function ChatSidebar({
  threads,
  activeThreadId,
  onNewChat,
  onSelectThread,
  onDeleteThread,
  onRenameThread,
}: {
  threads?: { id: string; title: string; time: string; pinned?: boolean; is_streaming?: boolean }[];
  activeThreadId?: string;
  onNewChat?: () => void;
  onSelectThread?: (id: string) => void;
  onDeleteThread?: (id: string) => void;
  onRenameThread?: (id: string, newTitle: string) => void;
}) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = React.useState(false);
  const [skillsDialogOpen, setSkillsDialogOpen] = React.useState(false);
  const [editingThreadId, setEditingThreadId] = React.useState<string | null>(null);
  const [editTitle, setEditTitle] = React.useState('');
  const editInputRef = React.useRef<HTMLInputElement>(null);

  // Track threads that were streaming so we can show "✓ Done" when they finish
  const prevStreamingRef = React.useRef<Set<string>>(new Set());
  const [recentlyFinished, setRecentlyFinished] = React.useState<Set<string>>(new Set());

  React.useEffect(() => {
    const currentStreaming = new Set((threads ?? []).filter(t => t.is_streaming).map(t => t.id));
    const prev = prevStreamingRef.current;

    // Threads that WERE streaming but no longer are → just finished
    const justFinished = new Set<string>();
    for (const id of prev) {
      if (!currentStreaming.has(id)) justFinished.add(id);
    }

    if (justFinished.size > 0) {
      setRecentlyFinished(prev => {
        const next = new Set(prev);
        for (const id of justFinished) next.add(id);
        return next;
      });
      // Auto-clear "Done" badge after 15 seconds
      const timer = setTimeout(() => {
        setRecentlyFinished(prev => {
          const next = new Set(prev);
          for (const id of justFinished) next.delete(id);
          return next;
        });
      }, 15_000);
      // Cleanup on unmount
      return () => clearTimeout(timer);
    }

    prevStreamingRef.current = currentStreaming;
  }, [threads]);

  const startEditing = React.useCallback((id: string, currentTitle: string) => {
    setEditingThreadId(id);
    setEditTitle(currentTitle);
    setTimeout(() => editInputRef.current?.focus(), 50);
  }, []);

  const saveEdit = React.useCallback(() => {
    if (editingThreadId && editTitle.trim()) {
      onRenameThread?.(editingThreadId, editTitle.trim());
    }
    setEditingThreadId(null);
    setEditTitle('');
  }, [editingThreadId, editTitle, onRenameThread]);

  const cancelEdit = React.useCallback(() => {
    setEditingThreadId(null);
    setEditTitle('');
  }, []);

  const pinnedThreads = threads?.filter((t) => t.pinned) ?? [];
  const todayThreads = threads?.filter((t) => !t.pinned && t.time === 'Today') ?? [];
  const yesterdayThreads = threads?.filter((t) => !t.pinned && t.time === 'Yesterday') ?? [];
  const olderThreads = threads?.filter((t) => !t.pinned && t.time !== 'Today' && t.time !== 'Yesterday') ?? [];

  const renderThread = (t: { id: string; title: string; time: string; pinned?: boolean; is_streaming?: boolean }) => {
    const isEditing = editingThreadId === t.id;

    if (isEditing) {
      return (
        <div key={t.id} className="flex items-center gap-0.5 px-1">
          <div className="flex items-center gap-1 flex-1 min-w-0 px-2 py-1.5 rounded-lg bg-muted border border-primary/30">
            <MessageSquare className="h-3.5 w-3.5 shrink-0 opacity-40" />
            <input
              ref={editInputRef}
              value={editTitle}
              onChange={(e) => setEditTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') saveEdit();
                if (e.key === 'Escape') cancelEdit();
              }}
              onBlur={saveEdit}
              className="flex-1 min-w-0 bg-transparent text-sm text-foreground focus:outline-none"
              autoFocus
            />
          </div>
          <button
            type="button"
            onClick={saveEdit}
            className="p-1 rounded text-emerald-500 hover:bg-emerald-500/10 transition-all shrink-0"
            title="Save"
          >
            <Check className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={cancelEdit}
            className="p-1 rounded text-muted-foreground hover:text-red-500 transition-all shrink-0"
            title="Cancel"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      );
    }

    return (
      <div key={t.id} className="group flex items-center gap-0.5">
        <button
          type="button"
          onClick={() => onSelectThread?.(t.id)}
          className={cn(
            'flex items-center gap-2 flex-1 min-w-0 px-3 py-2 rounded-lg text-sm transition-colors text-left',
            activeThreadId === t.id
              ? 'bg-barrsa-50 dark:bg-primary/10 text-primary font-medium'
              : 'text-muted-foreground hover:bg-muted'
          )}
        >
          {t.pinned ? (
            <Pin className="h-3.5 w-3.5 shrink-0 text-amber-500" />
          ) : t.is_streaming ? (
            <span className="relative flex h-3.5 w-3.5 shrink-0 items-center justify-center">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-50" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
            </span>
          ) : (
            <MessageSquare className="h-3.5 w-3.5 shrink-0 opacity-40" />
          )}
          <span className="truncate">{t.title}</span>
          {recentlyFinished.has(t.id) && !t.is_streaming && (
            <span className="ml-auto shrink-0 flex items-center gap-0.5 text-[10px] font-semibold text-emerald-500 bg-emerald-500/10 rounded-full px-1.5 py-0.5">
              <CheckCircle2 className="h-3 w-3" /> Done
            </span>
          )}
        </button>
        {onRenameThread && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); startEditing(t.id, t.title); }}
            className="opacity-0 group-hover:opacity-100 p-1 rounded text-muted-foreground hover:text-primary transition-all shrink-0"
            title="Rename"
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
        )}
        {onDeleteThread && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onDeleteThread(t.id); }}
            className="opacity-0 group-hover:opacity-100 p-1 rounded text-muted-foreground hover:text-red-500 transition-all shrink-0"
            title="Delete"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    );
  };

  return (
    <>
      <SidebarShell collapsed={collapsed}>
        <SidebarLogo collapsed={collapsed} onToggleCollapse={() => setCollapsed(!collapsed)} />

        {/* New Chat + Search */}
        <div className={cn('space-y-2 pb-3', collapsed ? 'px-2' : 'px-3')}>
          <button
            type="button"
            onClick={onNewChat}
            className={cn(
              'flex items-center gap-2 w-full rounded-lg bg-primary text-white text-sm font-medium hover:bg-primary/90 transition-colors',
              collapsed ? 'justify-center px-2 py-2.5' : 'px-3 py-2.5'
            )}
            title={collapsed ? 'New Chat' : undefined}
          >
            <Plus className="h-4 w-4" />
            {!collapsed && 'New Chat'}
          </button>
          {!collapsed && (
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <input
                type="text"
                placeholder="Search conversations..."
                className="w-full pl-9 pr-3 py-2 rounded-lg border border-border bg-muted text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/30"
              />
            </div>
          )}
        </div>

        {/* Thread Lists */}
        <div className={cn('flex-1 overflow-y-auto', collapsed ? 'px-2' : 'px-3 space-y-1')}>
          {!collapsed && (
            <>
              {pinnedThreads.length > 0 && (
                <>
                  <SidebarSection label="Pinned" />
                  {pinnedThreads.map(renderThread)}
                </>
              )}

              {todayThreads.length > 0 && (
                <>
                  <SidebarSection label="Today" />
                  {todayThreads.map(renderThread)}
                </>
              )}

              {yesterdayThreads.length > 0 && (
                <>
                  <SidebarSection label="Yesterday" />
                  {yesterdayThreads.map(renderThread)}
                </>
              )}

              {olderThreads.length > 0 && (
                <>
                  <SidebarSection label="Older" />
                  {olderThreads.map(renderThread)}
                </>
              )}
            </>
          )}
        </div>

        {/* Bottom nav — profile button with nav dropdown */}
        <div className={cn('border-t border-border', collapsed ? 'p-2' : 'p-3')}>
          <SidebarUserCard
            compact={collapsed}
            withNav
            onSkillsClick={() => setSkillsDialogOpen(true)}
            onExpandSidebar={() => setCollapsed(false)}
          />
        </div>
      </SidebarShell>

      <InstalledSkillsDialog open={skillsDialogOpen} onOpenChange={setSkillsDialogOpen} />
    </>
  );
}

// =============================================================================
// SETTINGS SIDEBAR
// =============================================================================
export function SettingsSidebar() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const currentTab = searchParams.get('tab');

  const settingsItems = [
    { href: '/settings?tab=profile', icon: User, label: 'Profile', match: 'profile' },
    { href: '/settings?tab=account', icon: Shield, label: 'Account', match: 'account' },
    { href: '/settings?tab=notifications', icon: Bell, label: 'Notifications', match: 'notifications' },
    { href: '/settings?tab=appearance', icon: Palette, label: 'Appearance', match: 'appearance' },
    { href: '/settings?tab=openclaw', icon: MessageSquare, label: 'Moonshot', match: 'openclaw' },
    { href: '/settings?tab=data', icon: HardDrive, label: 'Data', match: 'data' },
  ];

  return (
    <SidebarShell>
      <SidebarLogo />

      <nav className="flex-1 px-3 space-y-0.5">
        <SidebarSection label="Channels" />
        <SidebarItem
          href="/channels"
          icon={Radio}
          label="Channels"
          isActive={pathname === '/channels' || pathname.startsWith('/channels/') || pathname.startsWith('/integrations/')}
        />
        <SidebarSection label="Settings" />
        {settingsItems.map((item) => (
          <SidebarItem
            key={item.href}
            href={item.href}
            icon={item.icon}
            label={item.label}
            isActive={
              pathname === '/settings' && (currentTab || 'profile') === item.match
            }
          />
        ))}
      </nav>

      <div className="border-t border-border p-4">
        <SidebarUserCard />
      </div>
    </SidebarShell>
  );
}

// =============================================================================
// INBOX SIDEBAR — Gmail-style folder rail (Inbox / Starred / Sent / Drafts /
// Spam / Trash) plus dynamic user labels for the currently open mailbox.
// =============================================================================

type InboxLabel = {
  id: string;
  name: string;
  type: 'system' | 'user';
  messagesUnread?: number;
};

const INBOX_SYSTEM_LABELS: Array<{ id: string; label: string; Icon: React.ElementType }> = [
  { id: 'INBOX', label: 'Inbox', Icon: Inbox },
  { id: 'STARRED', label: 'Starred', Icon: Star },
  { id: 'SENT', label: 'Sent', Icon: Send },
  { id: 'DRAFT', label: 'Drafts', Icon: FileText },
  { id: 'SPAM', label: 'Spam', Icon: AlertOctagon },
  { id: 'TRASH', label: 'Trash', Icon: Trash2 },
];

const inboxLabelsFetcher = async (url: string) => {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<{ data: InboxLabel[] }>;
};

export function InboxSidebar() {
  // useSearchParams() must be wrapped in Suspense for static prerender of /inbox.
  return (
    <React.Suspense fallback={null}>
      <InboxSidebarInner />
    </React.Suspense>
  );
}

function InboxSidebarInner() {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // Detect /inbox/<accountId> — i.e. anything under /inbox that's not the
  // root Connections page.
  const accountId = React.useMemo(() => {
    const m = pathname?.match(/^\/inbox\/([^/?#]+)/);
    return m ? m[1] : null;
  }, [pathname]);

  const activeLabel = (searchParams?.get('label') ?? 'INBOX').toUpperCase();

  // Only fetch labels when we have an active mailbox.
  const labelsSwr = useSWR<{ data: InboxLabel[] }>(
    accountId ? `/api/inbox/accounts/${accountId}/labels` : null,
    inboxLabelsFetcher,
  );
  const labelById = React.useMemo(() => {
    const m = new Map<string, InboxLabel>();
    for (const l of labelsSwr.data?.data ?? []) m.set(l.id, l);
    return m;
  }, [labelsSwr.data]);

  const buildHref = React.useCallback(
    (labelId: string) => {
      if (!accountId) return '/inbox';
      return `/inbox/${accountId}?label=${encodeURIComponent(labelId)}`;
    },
    [accountId],
  );

  const userLabels = (labelsSwr.data?.data ?? []).filter((l) => l.type === 'user').slice(0, 30);

  return (
    <SidebarShell>
      <SidebarLogo />
      <nav className="flex-1 px-3 space-y-0.5">
        {/* Back to Connections (mailbox picker) */}
        <SidebarItem
          href="/inbox"
          icon={ArrowLeft}
          label="Inboxes"
          isActive={pathname === '/inbox'}
        />

        <SidebarSection label="Mail" />
        {INBOX_SYSTEM_LABELS.map((sl) => {
          const meta = labelById.get(sl.id);
          const unread = meta?.messagesUnread ?? 0;
          const isActive = !!accountId && activeLabel === sl.id;
          return (
            <SidebarItem
              key={sl.id}
              href={buildHref(sl.id)}
              icon={sl.Icon}
              label={sl.label}
              isActive={isActive}
              badge={unread > 0 ? (unread > 999 ? '999+' : unread) : undefined}
            />
          );
        })}

        <SidebarSection label="Labels" />
        {!accountId && (
          <p className="px-3 py-1.5 text-xs text-muted-foreground">
            Open a mailbox to see labels.
          </p>
        )}
        {accountId && labelsSwr.isLoading && (
          <p className="px-3 py-1.5 text-xs text-muted-foreground">Loading…</p>
        )}
        {accountId && !labelsSwr.isLoading && userLabels.length === 0 && (
          <p className="px-3 py-1.5 text-xs text-muted-foreground">No custom labels.</p>
        )}
        {userLabels.map((l) => {
          const isActive = activeLabel === l.id.toUpperCase();
          return (
            <SidebarItem
              key={l.id}
              href={buildHref(l.id)}
              icon={Tag}
              label={l.name}
              isActive={isActive}
              badge={l.messagesUnread && l.messagesUnread > 0 ? (l.messagesUnread > 999 ? '999+' : l.messagesUnread) : undefined}
            />
          );
        })}

        <SidebarSection label="Account" />
        <SidebarItem
          href={ROUTES.SETTINGS}
          icon={Settings}
          label="Settings"
          isActive={false}
        />
      </nav>
      <div className="border-t border-border p-4">
        <SidebarUserCard />
      </div>
    </SidebarShell>
  );
}
// =============================================================================
function SidebarUserCard({
  compact,
  withNav,
  onSkillsClick,
  onExpandSidebar,
}: {
  compact?: boolean;
  withNav?: boolean;
  onSkillsClick?: () => void;
  onExpandSidebar?: () => void;
}) {
  const { user, agent, logout } = useAuth();
  const pathname = usePathname();
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
          // When collapsed, expand sidebar instead of opening a dropdown that
          // gets clipped by the narrow 68px column.
          if (compact && onExpandSidebar) {
            onExpandSidebar();
            return;
          }
          setOpen(!open);
        }}
        className={cn(
          'flex items-center gap-2 w-full rounded-lg transition-colors text-left hover:bg-muted',
          compact ? 'justify-center px-2 py-2' : 'px-2 py-2'
        )}
      >
        <Avatar className="h-8 w-8 shrink-0">
          <AvatarImage src={avatarUrl} />
          <AvatarFallback className="bg-barrsa-100 text-barrsa-700 text-xs font-medium">
            {initials}
          </AvatarFallback>
        </Avatar>
        {!compact && (
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium truncate">{displayName}</p>
            <p className="text-xs text-muted-foreground truncate">{user?.email || 'Agent account'}</p>
          </div>
        )}
        {!compact && (
          <ChevronDown className={cn('h-3.5 w-3.5 text-muted-foreground transition-transform shrink-0', open && 'rotate-180')} />
        )}
      </button>

      {open && !compact && (
        <div className="absolute bottom-full left-0 right-0 mb-1 rounded-xl border border-border bg-card shadow-elevated p-1.5 animate-scale-in z-50 min-w-[180px]">
          {withNav && (
            <>
              <Link
                href="/"
                onClick={() => setOpen(false)}
                className={cn(
                  'flex items-center gap-2.5 px-3 py-2 text-sm rounded-lg transition-colors',
                  pathname === '/' ? 'bg-barrsa-50 dark:bg-primary/10 text-primary' : 'hover:bg-muted text-foreground'
                )}
              >
                <MessageSquare className="h-4 w-4 shrink-0" />
                OpenClaw
              </Link>
              <Link
                href="/mission-control"
                onClick={() => setOpen(false)}
                className={cn(
                  'flex items-center gap-2.5 px-3 py-2 text-sm rounded-lg transition-colors',
                  pathname.startsWith('/mission-control') ? 'bg-barrsa-50 dark:bg-primary/10 text-primary' : 'hover:bg-muted text-foreground'
                )}
              >
                <Rocket className="h-4 w-4 shrink-0" />
                Mission Control
              </Link>
              <Link
                href="/inbox"
                onClick={() => setOpen(false)}
                className={cn(
                  'flex items-center gap-2.5 px-3 py-2 text-sm rounded-lg transition-colors',
                  pathname.startsWith('/inbox') ? 'bg-barrsa-50 dark:bg-primary/10 text-primary' : 'hover:bg-muted text-foreground'
                )}
              >
                <Inbox className="h-4 w-4 shrink-0" />
                Inbox
              </Link>
              <button
                type="button"
                onClick={() => { onSkillsClick?.(); setOpen(false); }}
                className="flex items-center gap-2.5 px-3 py-2 text-sm rounded-lg hover:bg-muted transition-colors w-full text-left text-foreground"
              >
                <Sparkles className="h-4 w-4 shrink-0" />
                Skills
              </button>
              <Link
                href="/marketplace"
                onClick={() => setOpen(false)}
                className={cn(
                  'flex items-center gap-2.5 px-3 py-2 text-sm rounded-lg transition-colors',
                  pathname === '/marketplace' ? 'bg-barrsa-50 dark:bg-primary/10 text-primary' : 'hover:bg-muted text-foreground'
                )}
              >
                <Store className="h-4 w-4 shrink-0" />
                Marketplace
              </Link>
              <Link
                href="/seller"
                onClick={() => setOpen(false)}
                className={cn(
                  'flex items-center gap-2.5 px-3 py-2 text-sm rounded-lg transition-colors',
                  pathname.startsWith('/seller') ? 'bg-barrsa-50 dark:bg-primary/10 text-primary' : 'hover:bg-muted text-foreground'
                )}
              >
                <ShoppingBag className="h-4 w-4 shrink-0" />
                Seller
              </Link>
              <div className="flex items-center justify-between px-3 py-2 text-sm rounded-lg text-muted-foreground">
                <div className="flex items-center gap-2.5">
                  <CreditCard className="h-4 w-4 shrink-0" />
                  Credits
                </div>
                <span className="text-xs bg-muted rounded-full px-2 py-0.5">$1.96 Low</span>
              </div>
              <div className="my-1 h-px bg-border" />
            </>
          )}
          <Link
            href={ROUTES.SETTINGS}
            onClick={() => setOpen(false)}
            className="flex items-center gap-2.5 px-3 py-2 text-sm rounded-lg hover:bg-muted transition-colors text-foreground"
          >
            <Settings className="h-4 w-4 text-muted-foreground" />
            Settings
          </Link>
          <button
            onClick={() => { logout(); setOpen(false); }}
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

// =============================================================================
// MISSION CONTROL SIDEBAR — used for Mission Control pages
// =============================================================================
export function MissionControlSidebar() {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = React.useState(false);

  return (
    <SidebarShell collapsed={collapsed}>
      <SidebarLogo collapsed={collapsed} onToggleCollapse={() => setCollapsed(!collapsed)} />

      <nav className={cn('flex-1 overflow-y-auto', collapsed ? 'px-2' : 'px-3 space-y-0.5')}>
        <SidebarSection label="Mission Control" collapsed={collapsed} />
        <SidebarItem
          href="/mission-control"
          icon={LayoutDashboard}
          label="Overview"
          isActive={pathname === '/mission-control'}
          collapsed={collapsed}
        />
        <SidebarItem
          href="/mission-control/boards"
          icon={ClipboardList}
          label="Boards"
          isActive={pathname.startsWith('/mission-control/boards')}
          collapsed={collapsed}
        />
        <SidebarItem
          href="/mission-control/agents"
          icon={Bot}
          label="Agents"
          isActive={pathname.startsWith('/mission-control/agents')}
          collapsed={collapsed}
        />
        <SidebarItem
          href="/mission-control/approvals"
          icon={CheckCircle2}
          label="Approvals"
          isActive={pathname.startsWith('/mission-control/approvals')}
          collapsed={collapsed}
        />
        <SidebarItem
          href="/mission-control/activity"
          icon={Activity}
          label="Activity"
          isActive={pathname.startsWith('/mission-control/activity')}
          collapsed={collapsed}
        />
        <SidebarItem
          href="/mission-control/agent-tasks"
          icon={Zap}
          label="Agent Tasks"
          isActive={pathname.startsWith('/mission-control/agent-tasks')}
          collapsed={collapsed}
        />

        {!collapsed && <div className="my-3 mx-1 h-px bg-border" />}
        {collapsed && <div className="my-2 mx-2 h-px bg-border" />}

        <SidebarItem
          href="/"
          icon={MessageSquare}
          label="Back to Chat"
          isActive={false}
          collapsed={collapsed}
        />
        <SidebarItem
          href={ROUTES.SETTINGS}
          icon={Settings}
          label="Settings"
          isActive={false}
          collapsed={collapsed}
        />
      </nav>

      <div className={cn('border-t border-border', collapsed ? 'p-2' : 'p-3')}>
        {!collapsed && <SidebarUserCard />}
      </div>
    </SidebarShell>
  );
}

// =============================================================================
// SELLER SIDEBAR — used for Seller Agent pages
// =============================================================================
export function SellerSidebar() {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = React.useState(false);

  return (
    <SidebarShell collapsed={collapsed}>
      <SidebarLogo collapsed={collapsed} onToggleCollapse={() => setCollapsed(!collapsed)} />

      <nav className={cn('flex-1 overflow-y-auto', collapsed ? 'px-2' : 'px-3 space-y-0.5')}>
        <SidebarSection label="Seller" collapsed={collapsed} />
        <SidebarItem
          href="/seller"
          icon={ShoppingBag}
          label="Dashboard"
          isActive={pathname === '/seller'}
          collapsed={collapsed}
        />
        <SidebarItem
          href="/marketplace"
          icon={Store}
          label="Marketplace"
          isActive={pathname.startsWith('/marketplace')}
          collapsed={collapsed}
        />
        <SidebarItem
          href="/seller/products"
          icon={Package}
          label="Products"
          isActive={pathname.startsWith('/seller/products')}
          collapsed={collapsed}
        />
        <SidebarItem
          href="/seller/publishing"
          icon={Send}
          label="Publishing"
          isActive={pathname.startsWith('/seller/publishing')}
          collapsed={collapsed}
        />
        <SidebarItem
          href="/seller/campaigns"
          icon={CalendarClock}
          label="Campaigns"
          isActive={pathname.startsWith('/seller/campaigns')}
          collapsed={collapsed}
        />
        <SidebarItem
          href="/seller/approvals"
          icon={CheckCircle2}
          label="Approvals"
          isActive={pathname.startsWith('/seller/approvals')}
          collapsed={collapsed}
        />
        <SidebarItem
          href="/seller/social-accounts"
          icon={Share2}
          label="Social Accounts"
          isActive={pathname.startsWith('/seller/social-accounts')}
          collapsed={collapsed}
        />
        <SidebarItem
          href="/seller/wallet"
          icon={Wallet}
          label="Wallet"
          isActive={pathname.startsWith('/seller/wallet')}
          collapsed={collapsed}
        />

        {!collapsed && <div className="my-3 mx-1 h-px bg-border" />}
        {collapsed && <div className="my-2 mx-2 h-px bg-border" />}

        <SidebarItem
          href="/"
          icon={MessageSquare}
          label="Back to Chat"
          isActive={false}
          collapsed={collapsed}
        />
        <SidebarItem
          href={ROUTES.SETTINGS}
          icon={Settings}
          label="Settings"
          isActive={false}
          collapsed={collapsed}
        />
      </nav>

      <div className={cn('border-t border-border', collapsed ? 'p-2' : 'p-3')}>
        {!collapsed && <SidebarUserCard />}
      </div>
    </SidebarShell>
  );
}

// =============================================================================
// Sidebar Layout wrapper — sidebar + content area
// =============================================================================
export function SidebarLayout({
  sidebar,
  children,
  className,
}: {
  sidebar: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  const [mobileOpen, setMobileOpen] = React.useState(false);

  return (
    <div className="flex h-screen bg-background overflow-hidden">
      {/* Mobile header bar with hamburger */}
      <div className="fixed top-0 left-0 right-0 z-40 flex md:hidden items-center h-14 px-4 border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <button
          type="button"
          onClick={() => setMobileOpen(true)}
          className="h-9 w-9 flex items-center justify-center rounded-lg text-foreground hover:bg-muted transition-colors"
          aria-label="Open sidebar"
        >
          <Menu className="h-5 w-5" />
        </button>
        <Link href={ROUTES.HOME} className="flex items-center gap-2 ml-2">
          <div className="h-7 w-7 rounded-lg bg-primary flex items-center justify-center shrink-0">
            <span className="text-white font-bold text-xs">B</span>
          </div>
          <span className="text-base font-bold text-foreground">{APP_NAME}</span>
        </Link>
      </div>

      {/* Mobile sidebar overlay */}
      <MobileSidebarOverlay open={mobileOpen} onClose={() => setMobileOpen(false)}>
        {sidebar}
      </MobileSidebarOverlay>

      {/* Desktop sidebar (hidden on mobile via SidebarShell's `hidden md:flex`) */}
      {sidebar}
      <main className={cn('flex-1 min-w-0 overflow-x-hidden overflow-y-auto pt-14 md:pt-0', className)}>
        {children}
      </main>
    </div>
  );
}

// =============================================================================
// Mobile Sidebar Toggle (for responsive)
// =============================================================================
export function MobileSidebarOverlay({
  open,
  onClose,
  children,
}: {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
}) {
  // Close on Escape key
  React.useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 md:hidden">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div className="absolute left-0 top-0 h-full w-[280px] bg-card shadow-xl animate-in slide-in-from-left duration-300 [&>aside]:!flex [&>aside]:!w-full [&>aside]:!min-w-0 [&>aside]:!relative [&>aside]:!h-full">
        {children}
      </div>
    </div>
  );
}
