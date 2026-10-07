'use client';

import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import {
  CardTitle,
  Button,
  Avatar,
  AvatarImage,
  AvatarFallback,
  Skeleton,
} from '@/components/ui';
import {
  Search, Star, X, Package, Sparkles, TrendingUp,
  Headphones, PenTool, Code, BarChart3, UserPlus, Coins, Settings, Scale, Palette,
  Download, BadgeCheck, Plus, Loader2, CheckCircle2, ArrowLeft,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn, getInitials } from '@/lib/utils';
import { AGENT_CATEGORIES } from '@/lib/constants';
import { useAuthStore } from '@/store';
import { motion, AnimatePresence } from 'framer-motion';
import Link from '@/components/member-link';
import { toMemberPath } from '@/lib/member-path';
import type { Pricing } from '@/lib/pricing';

interface MarketplaceAgent {
  id: string;
  slug: string;
  name: string;
  short_description: string;
  description: string;
  category: string;
  developer: string;
  price: number;
  price_label: string;
  pricing?: Pricing;
  rating: number;
  review_count: number;
  total_installs: number;
  version: string;
  verified: boolean;
  tags: string[];
  integrations: string[];
  icon_url: string | null;
  created_at: string;
}

const CATEGORY_ICONS: Record<string, LucideIcon> = {
  'customer-support': Headphones,
  sales: TrendingUp,
  writing: PenTool,
  coding: Code,
  data: BarChart3,
  hr: UserPlus,
  finance: Coins,
  operations: Settings,
  legal: Scale,
  creative: Palette,
};

export default function MarketplacePage() {
  const [searchQuery, setSearchQuery] = useState('');
  const [activeTab, setActiveTab] = useState<'buy' | 'sell'>('buy');
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [agents, setAgents] = useState<MarketplaceAgent[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [installedIds, setInstalledIds] = useState<Set<string>>(new Set());
  const [installingIds, setInstallingIds] = useState<Set<string>>(new Set());
  const [installProgress, setInstallProgress] = useState<Record<string, number>>({});
  const [installError, setInstallError] = useState<string | null>(null);
  const user = useAuthStore((s) => s.user);
  const trackedUserIdRef = useRef<string | undefined>();

  const loadInstalledAgents = useCallback((userId: string) => {
    fetch('/api/agents/installed', { headers: { 'x-user-id': userId } })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.agents) {
          setInstalledIds(new Set(data.agents.map((a: { id: string }) => a.id)));
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const handleUserChange = (userId: string | undefined) => {
      if (userId === trackedUserIdRef.current) return;
      trackedUserIdRef.current = userId;
      if (!userId) { setInstalledIds(new Set()); return; }
      loadInstalledAgents(userId);
    };

    const currentUserId = useAuthStore.getState().user?.id;
    handleUserChange(currentUserId);

    return useAuthStore.subscribe((state) => {
      handleUserChange(state.user?.id);
    });
  }, [loadInstalledAgents]);

  const handleInstallToggle = useCallback(async (agentId: string, isInstalled: boolean) => {
    if (!user?.id) return;
    setInstallingIds((prev) => new Set(prev).add(agentId));

    // Simulate provisioning progress for installs (6 backend steps ~5s total)
    if (!isInstalled) {
      const milestones = [5, 20, 38, 52, 67, 80, 91];
      const delays =    [0, 350, 800, 1400, 2200, 3300, 4600];
      milestones.forEach((pct, i) => {
        setTimeout(() => {
          setInstallProgress((prev) =>
            prev[agentId] !== undefined ? { ...prev, [agentId]: pct } : prev,
          );
        }, delays[i]);
      });
      setInstallProgress((prev) => ({ ...prev, [agentId]: 5 }));
    }

    try {
      const method = isInstalled ? 'DELETE' : 'POST';
      const res = await fetch('/api/agents/installed', {
        method,
        headers: { 'Content-Type': 'application/json', 'x-user-id': user.id },
        body: JSON.stringify({ agent_id: agentId }),
      });
      if (res.ok) {
        if (!isInstalled) {
          setInstallProgress((prev) => ({ ...prev, [agentId]: 100 }));
        }
        setInstalledIds((prev) => {
          const next = new Set(prev);
          if (isInstalled) next.delete(agentId); else next.add(agentId);
          return next;
        });
        setAgents((prev) =>
          prev.map((a) =>
            a.id === agentId
              ? { ...a, total_installs: a.total_installs + (isInstalled ? -1 : 1) }
              : a,
          ),
        );
      } else {
        const errData = await res.json().catch(() => ({ error: 'Provisioning failed' }));
        console.error('[marketplace] install/uninstall failed:', res.status, errData);
        setInstallError(errData.error || `Install failed (${res.status})`);
      }
    } catch {
      setInstallError('Network error — please try again');
    } finally {
      setInstallingIds((prev) => {
        const next = new Set(prev);
        next.delete(agentId);
        return next;
      });
      setTimeout(() => {
        setInstallProgress((prev) => {
          const next = { ...prev };
          delete next[agentId];
          return next;
        });
      }, 900);
    }
  }, [user?.id]);

  const loadAgents = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ limit: '50', sort: 'rating' });
      if (selectedCategory) params.set('category', selectedCategory);
      const res = await fetch(`/api/marketplace-agents?${params}`);
      const data = await res.json();
      if (data.agents) {
        setAgents(
          data.agents.map((a: MarketplaceAgent) => ({
            ...a,
            price: Number(a.price) || 0,
            rating: Number(a.rating) || 0,
            review_count: Number(a.review_count) || 0,
            total_installs: Number(a.total_installs) || 0,
          })),
        );
      } else {
        throw new Error(data.error || 'Failed to load agents');
      }
    } catch (err) {
      console.error('Failed to load agents', err);
      setError(err instanceof Error ? err.message : 'Failed to load agents');
    } finally {
      setIsLoading(false);
    }
  }, [selectedCategory]);

  useEffect(() => {
    void loadAgents();
  }, [loadAgents]);

  const filteredAgents = useMemo(() => {
    let result = agents;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      result = result.filter(
        (a) =>
          a.name.toLowerCase().includes(q) ||
          a.short_description?.toLowerCase().includes(q) ||
          a.description?.toLowerCase().includes(q) ||
          a.tags?.some((t) => t.toLowerCase().includes(q)),
      );
    }
    return result;
  }, [agents, searchQuery]);

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-6xl mx-auto px-6 py-8">
        {/* Back link */}
        <Link
          href="/"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground mb-6 transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Chat
        </Link>

        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: [0.32, 0.72, 0, 1] }}
          className="mb-8"
        >
          <div className="flex items-center gap-3 mb-1">
            <h1 className="text-3xl font-bold tracking-tight text-foreground">Agent Marketplace</h1>
            <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-blue-50/80 dark:bg-blue-950/30 border border-blue-100/60 dark:border-blue-900/40 text-blue-600 dark:text-blue-400 text-[11px] font-semibold">
              <Sparkles className="w-3 h-3" />
              AI-Powered
            </span>
          </div>
          <p className="text-[15px] text-muted-foreground">Discover, install, and sell AI agents for your workflows.</p>
        </motion.div>

        {/* Tabs & Search Row */}
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.1, ease: [0.32, 0.72, 0, 1] }}
          className="flex flex-col sm:flex-row items-start sm:items-center gap-4 mb-6"
        >
          <div className="flex items-center gap-1 p-1 bg-muted rounded-xl">
            {(['buy', 'sell'] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                onClick={() => setActiveTab(tab)}
                className={cn(
                  'px-5 py-2 rounded-lg text-[13px] font-semibold transition-all duration-200',
                  activeTab === tab
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {tab === 'buy' ? 'Browse Agents' : 'Sell Agents'}
              </button>
            ))}
          </div>

          <div className="relative flex-1 max-w-md">
            <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <input
              type="text"
              placeholder="Search agents..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-10 pr-10 py-2.5 rounded-xl border border-border bg-background/80 backdrop-blur-sm text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/10 focus:border-primary/40 transition-all duration-200"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
        </motion.div>

        {/* Category pills */}
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.15, ease: [0.32, 0.72, 0, 1] }}
          className="flex flex-wrap gap-2 mb-8"
        >
          <button
            type="button"
            onClick={() => setSelectedCategory(null)}
            className={cn(
              'px-4 py-2 rounded-full text-[12px] font-semibold border transition-all duration-200',
              !selectedCategory
                ? 'bg-primary text-primary-foreground border-primary shadow-md shadow-primary/10'
                : 'bg-background text-muted-foreground border-border hover:border-primary/30 hover:bg-primary/5',
            )}
          >
            All
          </button>
          {AGENT_CATEGORIES.map((cat) => (
            <button
              key={cat.value}
              type="button"
              onClick={() => setSelectedCategory(selectedCategory === cat.value ? null : cat.value)}
              className={cn(
                'inline-flex items-center gap-1.5 px-4 py-2 rounded-full text-[12px] font-semibold border transition-all duration-200',
                selectedCategory === cat.value
                  ? 'bg-primary text-primary-foreground border-primary shadow-md shadow-primary/10'
                  : 'bg-background text-muted-foreground border-border hover:border-primary/30 hover:bg-primary/5',
              )}
            >
              {(() => { const Icon = CATEGORY_ICONS[cat.value]; return Icon ? <Icon className="w-3.5 h-3.5" /> : <Package className="w-3.5 h-3.5" />; })()}
              {cat.label}
            </button>
          ))}
        </motion.div>

        {/* Results */}
        <AnimatePresence mode="wait">
          {activeTab === 'buy' ? (
            <motion.div key="buy" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.3 }}>
              {installError && (
                <div className="mb-4 p-3 rounded-xl bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900 text-red-700 dark:text-red-400 text-[13px] flex items-center justify-between">
                  <span>{installError}</span>
                  <button onClick={() => setInstallError(null)} className="ml-3 hover:text-red-900 dark:hover:text-red-200">
                    <X className="w-4 h-4" />
                  </button>
                </div>
              )}
              {isLoading ? (
                <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
                  {Array.from({ length: 6 }).map((_, i) => (
                    <div key={`skeleton-${i}`} className="bg-card/80 backdrop-blur-sm rounded-2xl border border-border/60 p-6 shadow-[0_2px_12px_rgba(0,0,0,0.03)]">
                      <div className="flex items-center gap-3 mb-4">
                        <Skeleton className="h-12 w-12 rounded-xl" />
                        <div className="flex-1 space-y-2">
                          <Skeleton className="h-4 w-32" />
                          <Skeleton className="h-3 w-24" />
                        </div>
                      </div>
                      <Skeleton className="h-3 w-full mb-2" />
                      <Skeleton className="h-3 w-2/3" />
                    </div>
                  ))}
                </div>
              ) : error ? (
                <div className="bg-card/80 backdrop-blur-xl rounded-2xl border border-border/60 p-16 text-center shadow-sm">
                  <h3 className="font-bold text-lg text-foreground mb-2">Unable to load marketplace</h3>
                  <p className="text-muted-foreground text-[14px] mb-6">{error}</p>
                  <Button
                    variant="outline"
                    onClick={() => void loadAgents()}
                    className="rounded-xl h-10 px-6 text-[13px] font-semibold"
                  >
                    Try again
                  </Button>
                </div>
              ) : filteredAgents.length === 0 ? (
                <motion.div
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="flex flex-col items-center justify-center py-24 text-center"
                >
                  <div className="w-20 h-20 rounded-2xl bg-muted flex items-center justify-center mb-5">
                    <Package className="h-10 w-10 text-muted-foreground/40" />
                  </div>
                  <h3 className="font-bold text-lg text-foreground mb-1">No listings found</h3>
                  <p className="text-muted-foreground text-[14px] max-w-sm">
                    {searchQuery
                      ? `No agents match "${searchQuery}". Try a different search term.`
                      : 'No agents available yet. Check back soon or list your own!'}
                  </p>
                </motion.div>
              ) : (
                <>
                  <div className="flex items-center justify-between mb-5">
                    <p className="text-[13px] text-muted-foreground font-medium">
                      {filteredAgents.length} agent{filteredAgents.length !== 1 ? 's' : ''} found
                    </p>
                    <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
                      <TrendingUp className="w-3.5 h-3.5" />
                      Sorted by popularity
                    </div>
                  </div>
                  <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
                    {filteredAgents.map((agent, i) => (
                      <motion.div
                        key={agent.id}
                        initial={{ opacity: 0, y: 16 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.4, delay: Math.min(i * 0.05, 0.3), ease: [0.32, 0.72, 0, 1] }}
                      >
                        <AgentCard
                          agent={agent}
                          isInstalled={installedIds.has(agent.id)}
                          isInstalling={installingIds.has(agent.id)}
                          installProgress={installProgress[agent.id]}
                          isAnyInstalling={installingIds.size > 0}
                          onInstallToggle={handleInstallToggle}
                          isLoggedIn={!!user}
                        />
                      </motion.div>
                    ))}
                  </div>
                </>
              )}
            </motion.div>
          ) : (
            <motion.div key="sell" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.4 }}>
              <PromptToSellCTA />
              <CreateAgentForm onCreated={() => { setActiveTab('buy'); void loadAgents(); }} />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

// =============================================================================
// Prompt-to-Sell CTA — quick path: describe agent in plain language and let
// mawaDao Agent generate the marketplace listing through the chat.
// =============================================================================
function PromptToSellCTA() {
  const [prompt, setPrompt] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleGenerate = async () => {
    if (!prompt.trim() || submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      // Seed a dedicated chat conversation with a structured "create marketplace
      // agent" instruction so mawaDao Agent produces the listing end-to-end.
      const seed =
        `I want to create and sell a new AI agent on the mawaDao marketplace.\n\n` +
        `Here's my idea:\n${prompt.trim()}\n\n` +
        `Please:\n` +
        `1. Generate a clear name, short description, full description, category, tags, capabilities and price.\n` +
        `2. Create the marketplace listing by calling POST /api/marketplace-agents.\n` +
        `3. Confirm the listing went live and report the marketplace URL.\n` +
        `Track every step in Mission Control as a campaign so I can monitor progress.`;

      // Open chat with the prompt prefilled via querystring; the chat root
      // already handles ?q= autofill + autosend.
      const url = `/?q=${encodeURIComponent(seed)}&intent=marketplace_create_agent`;
      window.location.href = toMemberPath(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start');
      setSubmitting(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto mb-8">
      <div className="bg-gradient-to-br from-primary/5 via-card/80 to-card/80 backdrop-blur-sm rounded-2xl border border-primary/20 shadow-sm p-6">
        <div className="flex items-center gap-3 mb-4">
          <div className="h-10 w-10 rounded-xl bg-primary/10 flex items-center justify-center">
            <Sparkles className="h-5 w-5 text-primary" />
          </div>
          <div>
            <h3 className="font-bold text-lg text-foreground">Describe it — mawaDao Agent builds it</h3>
            <p className="text-[13px] text-muted-foreground">
              Skip the form. Tell us what your agent does and we&apos;ll generate the full listing.
            </p>
          </div>
        </div>

        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="e.g. An agent that monitors competitor prices on Amazon every morning, sends a Slack digest, and auto-adjusts my Shopify prices when undercut by more than 5%."
          rows={4}
          className="w-full px-4 py-3 rounded-xl border border-border bg-background/80 backdrop-blur-sm text-sm placeholder:text-muted-foreground/70 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/40 transition-all duration-200 resize-none"
        />

        {error && (
          <div className="mt-3 p-2.5 rounded-lg bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900 text-red-700 dark:text-red-400 text-[13px]">
            {error}
          </div>
        )}

        <div className="mt-4 flex items-center justify-between gap-3">
          <p className="text-[12px] text-muted-foreground">
            mawaDao Agent will publish the listing and track each step in Mission Control.
          </p>
          <Button
            type="button"
            onClick={handleGenerate}
            disabled={!prompt.trim() || submitting}
            className="gap-2"
          >
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
            Generate with mawaDao Agent
          </Button>
        </div>
      </div>

      <div className="my-6 flex items-center gap-3 text-[12px] text-muted-foreground">
        <div className="flex-1 h-px bg-border" />
        <span>or fill in the form manually</span>
        <div className="flex-1 h-px bg-border" />
      </div>
    </div>
  );
}

// =============================================================================
// Create Agent Form
// =============================================================================
function CreateAgentForm({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [shortDesc, setShortDesc] = useState('');
  const [category, setCategory] = useState('');
  const [tagsInput, setTagsInput] = useState('');
  const [integrationsInput, setIntegrationsInput] = useState('');
  const [capabilitiesInput, setCapabilitiesInput] = useState('');
  const [price, setPrice] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch('/api/marketplace-agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim(),
          short_description: shortDesc.trim() || undefined,
          category,
          tags: tagsInput ? tagsInput.split(',').map((t) => t.trim()).filter(Boolean) : [],
          integrations: integrationsInput ? integrationsInput.split(',').map((t) => t.trim()).filter(Boolean) : [],
          capabilities: capabilitiesInput ? capabilitiesInput.split(',').map((t) => t.trim()).filter(Boolean) : [],
          price: price ? parseFloat(price) : 0,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to create agent');
      setSuccess(true);
      setTimeout(() => onCreated(), 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create agent');
    } finally {
      setSubmitting(false);
    }
  };

  if (success) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <div className="w-20 h-20 rounded-2xl bg-green-50 dark:bg-green-950/30 flex items-center justify-center mb-5">
          <CheckCircle2 className="h-10 w-10 text-green-500" />
        </div>
        <h3 className="font-bold text-lg text-foreground mb-1">Agent Created!</h3>
        <p className="text-muted-foreground text-[14px]">Your agent is now live in the marketplace.</p>
      </div>
    );
  }

  const inputClass =
    'w-full px-4 py-2.5 rounded-xl border border-border bg-background/80 backdrop-blur-sm text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/10 focus:border-primary/40 transition-all duration-200';
  const labelClass = 'block text-[13px] font-semibold text-foreground mb-1.5';

  return (
    <div className="max-w-2xl mx-auto">
      <div className="bg-card/80 backdrop-blur-sm rounded-2xl border border-border/60 shadow-sm p-8">
        <div className="flex items-center gap-3 mb-6">
          <div className="h-10 w-10 rounded-xl bg-primary/10 flex items-center justify-center">
            <Plus className="h-5 w-5 text-primary" />
          </div>
          <div>
            <h3 className="font-bold text-lg text-foreground">Create Your Agent</h3>
            <p className="text-[13px] text-muted-foreground">Build and list a custom AI agent on the marketplace.</p>
          </div>
        </div>

        {error && (
          <div className="mb-6 p-3 rounded-xl bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900 text-red-700 dark:text-red-400 text-[13px]">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-5">
          <div>
            <label className={labelClass}>Agent Name *</label>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. My Sales Assistant" className={inputClass} required minLength={2} maxLength={100} />
          </div>

          <div>
            <label className={labelClass}>Category *</label>
            <div className="flex flex-wrap gap-2">
              {AGENT_CATEGORIES.map((cat) => {
                const Icon = CATEGORY_ICONS[cat.value] || Package;
                return (
                  <button
                    key={cat.value}
                    type="button"
                    onClick={() => setCategory(cat.value)}
                    className={cn(
                      'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12px] font-semibold border transition-all duration-200',
                      category === cat.value
                        ? 'bg-primary text-primary-foreground border-primary shadow-sm'
                        : 'bg-background text-muted-foreground border-border hover:border-primary/30 hover:bg-primary/5',
                    )}
                  >
                    <Icon className="w-3 h-3" />
                    {cat.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <label className={labelClass}>Short Description</label>
            <input type="text" value={shortDesc} onChange={(e) => setShortDesc(e.target.value)} placeholder="Brief one-liner shown on agent cards" className={inputClass} maxLength={200} />
          </div>

          <div>
            <label className={labelClass}>Full Description *</label>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Detailed description of what the agent does, features, and use cases..." className={cn(inputClass, 'min-h-[120px] resize-y')} required minLength={10} />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className={labelClass}>Tags</label>
              <input type="text" value={tagsInput} onChange={(e) => setTagsInput(e.target.value)} placeholder="sales, crm, automation" className={inputClass} />
              <p className="text-[11px] text-muted-foreground mt-1">Comma-separated</p>
            </div>
            <div>
              <label className={labelClass}>Integrations</label>
              <input type="text" value={integrationsInput} onChange={(e) => setIntegrationsInput(e.target.value)} placeholder="Slack, Discord, GitHub" className={inputClass} />
              <p className="text-[11px] text-muted-foreground mt-1">Comma-separated</p>
            </div>
          </div>

          <div>
            <label className={labelClass}>Capabilities</label>
            <input type="text" value={capabilitiesInput} onChange={(e) => setCapabilitiesInput(e.target.value)} placeholder="Natural language processing, Data analysis, Report generation" className={inputClass} />
            <p className="text-[11px] text-muted-foreground mt-1">Comma-separated list of capabilities</p>
          </div>

          <div className="max-w-[200px]">
            <label className={labelClass}>Price ($/month)</label>
            <input type="number" step="0.01" min="0" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="0 = Free" className={inputClass} />
          </div>

          <div className="pt-2">
            <Button
              type="submit"
              disabled={submitting || !name.trim() || !description.trim() || !category}
              className="w-full gap-2 rounded-xl h-11 text-[14px] font-semibold bg-primary hover:bg-primary/90 text-primary-foreground shadow-sm hover:shadow-md transition-all duration-200 disabled:opacity-50"
            >
              {submitting ? (
                <><Loader2 className="h-4 w-4 animate-spin" /> Creating...</>
              ) : (
                <><Plus className="h-4 w-4" /> Create Agent</>
              )}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

// =============================================================================
// Agent Card
// =============================================================================
function AgentCard({
  agent,
  isInstalled,
  isInstalling,
  installProgress,
  isAnyInstalling,
  onInstallToggle,
  isLoggedIn,
}: {
  agent: MarketplaceAgent;
  isInstalled: boolean;
  isInstalling: boolean;
  installProgress?: number;
  isAnyInstalling?: boolean;
  onInstallToggle: (agentId: string, isInstalled: boolean) => void;
  isLoggedIn: boolean;
}) {
  const gradients = [
    'from-primary/5 to-blue-500/5',
    'from-primary/5 to-indigo-500/5',
    'from-blue-400/5 to-cyan-500/5',
    'from-blue-500/5 to-sky-500/5',
    'from-indigo-500/5 to-blue-500/5',
    'from-primary/5 to-sky-400/5',
  ];

  const gradientIdx = agent.slug.length % gradients.length;
  const CatIcon = CATEGORY_ICONS[agent.category] || Package;

  return (
    <div className="group h-full flex flex-col bg-card/70 backdrop-blur-sm rounded-2xl border border-border/60 shadow-[0_2px_12px_rgba(0,0,0,0.03)] hover:shadow-[0_8px_40px_rgba(0,0,0,0.08)] hover:border-border transition-all duration-500 overflow-hidden relative">
      <div
        className={`absolute inset-0 bg-gradient-to-br ${gradients[gradientIdx]} opacity-0 group-hover:opacity-100 transition-opacity duration-500 rounded-2xl`}
      />

      <div className="relative p-6 pb-3">
        <div className="flex items-start gap-3.5">
          <Avatar className="h-12 w-12 rounded-xl shrink-0 ring-2 ring-muted shadow-sm">
            <AvatarImage src={agent.icon_url || undefined} />
            <AvatarFallback className="rounded-xl bg-gradient-to-br from-primary to-primary/80 text-primary-foreground font-semibold text-sm">
              {getInitials(agent.name)}
            </AvatarFallback>
          </Avatar>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5">
              <CardTitle className="text-[15px] font-bold truncate text-foreground">
                {agent.name}
              </CardTitle>
              {agent.verified && (
                <BadgeCheck className="h-4 w-4 text-blue-500 shrink-0" />
              )}
            </div>
            <p className="text-[12px] text-muted-foreground truncate mt-0.5">
              by {agent.developer}
            </p>
          </div>
          <span className="shrink-0 text-[12px] font-semibold text-foreground text-right max-w-[45%]">
            Free for education
          </span>
        </div>
      </div>

      <div className="relative px-6 pb-6 flex-1 flex flex-col">
        <p className="text-[13px] text-muted-foreground line-clamp-2 mb-4 leading-relaxed">
          {agent.short_description || agent.description}
        </p>

        {/* Installation progress bar */}
        {isInstalling && installProgress !== undefined && (
          <div className="mb-3 -mx-0">
            <div className="flex items-center justify-between mb-1">
              <span className="text-[11px] font-semibold text-primary">Installing…</span>
              <span className="text-[11px] font-semibold text-primary">{installProgress}%</span>
            </div>
            <div className="h-1.5 w-full rounded-full bg-primary/10 overflow-hidden">
              <div
                className="h-full rounded-full bg-primary transition-all duration-500 ease-out"
                style={{ width: `${installProgress}%` }}
              />
            </div>
          </div>
        )}

        <div className="mt-auto flex items-center gap-4 pt-4 border-t border-border/60">
          <span className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
            <Star className="h-3.5 w-3.5 text-amber-400 fill-amber-400" />
            <span className="font-semibold text-foreground">{agent.rating.toFixed(1)}</span>
            <span className="text-muted-foreground/60">({agent.review_count})</span>
          </span>
          <span className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
            <Download className="h-3.5 w-3.5" />
            <span className="font-semibold text-foreground">{agent.total_installs.toLocaleString()}</span>
          </span>
          {isLoggedIn && (
            <button
              type="button"
              onClick={() => { if (!isInstalling && !isAnyInstalling) onInstallToggle(agent.id, isInstalled); }}
              disabled={isInstalling || isAnyInstalling}
              className={cn(
                'ml-auto flex items-center gap-1 px-3 py-1 rounded-lg text-[11px] font-semibold transition-all duration-200 border',
                isInstalled
                  ? 'bg-emerald-50 dark:bg-emerald-950/30 text-emerald-600 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800 hover:bg-red-50 dark:hover:bg-red-950/30 hover:text-red-600 dark:hover:text-red-400 hover:border-red-200 dark:hover:border-red-800'
                  : 'bg-primary/5 text-primary border-primary/20 hover:bg-primary/10 hover:border-primary/40',
                (isInstalling || (isAnyInstalling && !isInstalled)) && 'opacity-40 cursor-not-allowed',
              )}
            >
              {isInstalling ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : isInstalled ? (
                <><CheckCircle2 className="h-3 w-3" /> Installed</>
              ) : (
                <><Download className="h-3 w-3" /> Install</>
              )}
            </button>
          )}
          {!isLoggedIn && (
            <span className="flex items-center gap-1 text-[11px] text-muted-foreground ml-auto">
              <CatIcon className="h-3 w-3" />
              {AGENT_CATEGORIES.find((c) => c.value === agent.category)?.label || agent.category}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
