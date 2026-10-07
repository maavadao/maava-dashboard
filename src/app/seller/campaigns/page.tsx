'use client';

import { useEffect, useState, useCallback } from 'react';
import { Card, Button, Skeleton } from '@/components/ui';
import {
  CalendarClock, AlertCircle, CheckCircle2, Loader2,
  Power, PowerOff, Clock, PlayCircle, Target, Users, Hash,
  BarChart3, Megaphone, ChevronDown, ChevronUp, Instagram,
  Facebook, Twitter, Linkedin, Globe, ArrowLeft,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { api } from '@/lib/api';
import type { PromotionRule, CampaignRun, CampaignPlanSummary, CampaignPlanWeek, CampaignPlanPost } from '@/types';

// ─── Platform helpers ──────────────────────────────────────────────

const PLATFORM_ICON: Record<string, React.ReactNode> = {
  instagram: <Instagram className="h-3.5 w-3.5" />,
  facebook: <Facebook className="h-3.5 w-3.5" />,
  twitter: <Twitter className="h-3.5 w-3.5" />,
  linkedin: <Linkedin className="h-3.5 w-3.5" />,
  tiktok: <span className="text-[11px] font-bold leading-none">TT</span>,
};

const PLATFORM_COLOR: Record<string, string> = {
  instagram: 'bg-gradient-to-br from-purple-500 to-pink-500 text-white',
  facebook: 'bg-blue-600 text-white',
  twitter: 'bg-sky-500 text-white',
  linkedin: 'bg-blue-700 text-white',
  tiktok: 'bg-black text-white dark:bg-white dark:text-black',
};

const CONTENT_TYPE_BADGE: Record<string, { label: string; color: string }> = {
  carousel: { label: 'Carousel', color: 'bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300' },
  reel: { label: 'Reel', color: 'bg-pink-100 text-pink-700 dark:bg-pink-900/30 dark:text-pink-300' },
  story: { label: 'Story', color: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300' },
  static_image: { label: 'Image', color: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300' },
  video: { label: 'Video', color: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300' },
  text_post: { label: 'Text', color: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300' },
  poll: { label: 'Poll', color: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-300' },
  live: { label: 'Live', color: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300' },
};

function isCampaignPlan(summary: Record<string, unknown>): summary is CampaignPlanSummary {
  return summary?.type === 'campaign_plan';
}

// ─── Campaign Plan Detail View ─────────────────────────────────────

function CampaignPlanDetail({ run, onBack }: { run: CampaignRun; onBack: () => void }) {
  const plan = run.summary as CampaignPlanSummary;
  const [expandedWeek, setExpandedWeek] = useState<number>(1);

  return (
    <div>
      {/* Header */}
      <button
        type="button"
        onClick={onBack}
        className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors mb-4"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to Campaigns
      </button>

      <div className="mb-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-xl font-bold text-foreground">{plan.campaignName || 'Campaign Plan'}</h2>
            {plan.brandName && (
              <p className="text-sm text-muted-foreground mt-0.5">Brand: <span className="font-medium text-foreground">{plan.brandName}</span></p>
            )}
          </div>
          <span className="text-[10px] px-2.5 py-1 rounded-full bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400 font-semibold shrink-0">
            Active Plan
          </span>
        </div>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <Card className="p-3 border border-border">
          <div className="flex items-center gap-2 mb-1">
            <div className="h-7 w-7 rounded-lg bg-primary/10 flex items-center justify-center">
              <Target className="h-3.5 w-3.5 text-primary" />
            </div>
            <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Goal</span>
          </div>
          <p className="text-xs text-foreground font-medium leading-snug">{plan.goal || '—'}</p>
        </Card>
        <Card className="p-3 border border-border">
          <div className="flex items-center gap-2 mb-1">
            <div className="h-7 w-7 rounded-lg bg-blue-500/10 flex items-center justify-center">
              <Users className="h-3.5 w-3.5 text-blue-600" />
            </div>
            <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Audience</span>
          </div>
          <p className="text-xs text-foreground font-medium leading-snug">{plan.targetAudience || '—'}</p>
        </Card>
        <Card className="p-3 border border-border">
          <div className="flex items-center gap-2 mb-1">
            <div className="h-7 w-7 rounded-lg bg-violet-500/10 flex items-center justify-center">
              <CalendarClock className="h-3.5 w-3.5 text-violet-600" />
            </div>
            <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Duration</span>
          </div>
          <p className="text-xs text-foreground font-medium">{plan.duration || '—'}</p>
        </Card>
        <Card className="p-3 border border-border">
          <div className="flex items-center gap-2 mb-1">
            <div className="h-7 w-7 rounded-lg bg-pink-500/10 flex items-center justify-center">
              <Megaphone className="h-3.5 w-3.5 text-pink-600" />
            </div>
            <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Platforms</span>
          </div>
          <div className="flex items-center gap-1 flex-wrap">
            {(plan.platforms || []).map((p) => (
              <span
                key={p}
                className={cn('inline-flex items-center justify-center h-5 w-5 rounded-md', PLATFORM_COLOR[p] || 'bg-gray-200 text-gray-700')}
                title={p}
              >
                {PLATFORM_ICON[p] || <Globe className="h-3 w-3" />}
              </span>
            ))}
          </div>
        </Card>
      </div>

      {/* Content Pillars + KPIs */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-6">
        {plan.contentPillars && plan.contentPillars.length > 0 && (
          <Card className="p-4 border border-border">
            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Content Pillars</h3>
            <div className="flex flex-wrap gap-1.5">
              {plan.contentPillars.map((pillar, i) => (
                <span key={i} className="text-[11px] px-2.5 py-1 rounded-full bg-primary/10 text-primary font-medium">
                  {pillar}
                </span>
              ))}
            </div>
          </Card>
        )}
        {plan.kpis && plan.kpis.length > 0 && (
          <Card className="p-4 border border-border">
            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">KPIs & Goals</h3>
            <div className="space-y-1.5">
              {plan.kpis.map((kpi, i) => (
                <div key={i} className="flex items-center gap-2">
                  <BarChart3 className="h-3 w-3 text-emerald-500 shrink-0" />
                  <span className="text-xs text-foreground">{kpi}</span>
                </div>
              ))}
            </div>
          </Card>
        )}
      </div>

      {/* Weekly Plan */}
      {plan.weeklyPlan && plan.weeklyPlan.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-foreground mb-3">Weekly Plan</h3>
          <div className="space-y-2">
            {plan.weeklyPlan.map((week: CampaignPlanWeek) => (
              <Card key={week.week} className="border border-border overflow-hidden">
                <button
                  type="button"
                  onClick={() => setExpandedWeek(expandedWeek === week.week ? -1 : week.week)}
                  className="w-full flex items-center justify-between p-3 hover:bg-muted/50 transition-colors"
                >
                  <div className="flex items-center gap-3">
                    <span className="h-8 w-8 rounded-lg bg-primary/10 flex items-center justify-center text-xs font-bold text-primary">
                      W{week.week}
                    </span>
                    <div className="text-left">
                      <span className="text-sm font-medium text-foreground">{week.theme || `Week ${week.week}`}</span>
                      <span className="text-[11px] text-muted-foreground ml-2">
                        {week.posts?.length || 0} post{(week.posts?.length || 0) !== 1 ? 's' : ''}
                      </span>
                    </div>
                  </div>
                  {expandedWeek === week.week ? (
                    <ChevronUp className="h-4 w-4 text-muted-foreground" />
                  ) : (
                    <ChevronDown className="h-4 w-4 text-muted-foreground" />
                  )}
                </button>

                {expandedWeek === week.week && week.posts && (
                  <div className="border-t border-border">
                    <div className="divide-y divide-border">
                      {week.posts.map((post: CampaignPlanPost, pi: number) => (
                        <div key={pi} className="p-4">
                          <div className="flex items-start gap-3">
                            {/* Left: Day & Time */}
                            <div className="w-16 shrink-0 text-center pt-0.5">
                              <div className="text-xs font-semibold text-foreground">{post.day}</div>
                              <div className="text-[10px] text-muted-foreground">{post.suggestedTime}</div>
                            </div>

                            {/* Content */}
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 mb-1.5 flex-wrap">
                                <span
                                  className={cn('inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-md font-medium', PLATFORM_COLOR[post.platform] || 'bg-gray-200 text-gray-700')}
                                >
                                  {PLATFORM_ICON[post.platform] || <Globe className="h-3 w-3" />}
                                  {post.platform}
                                </span>
                                {post.contentType && (
                                  <span className={cn('text-[10px] px-2 py-0.5 rounded-md font-medium', CONTENT_TYPE_BADGE[post.contentType]?.color || 'bg-gray-100 text-gray-700')}>
                                    {CONTENT_TYPE_BADGE[post.contentType]?.label || post.contentType}
                                  </span>
                                )}
                              </div>
                              <h4 className="text-sm font-medium text-foreground mb-1">{post.topic}</h4>
                              <p className="text-xs text-muted-foreground leading-relaxed whitespace-pre-line">{post.caption}</p>
                              {post.hashtags && post.hashtags.length > 0 && (
                                <div className="flex items-center gap-1 mt-2 flex-wrap">
                                  <Hash className="h-3 w-3 text-blue-500 shrink-0" />
                                  <span className="text-[10px] text-blue-600 dark:text-blue-400">
                                    {post.hashtags.join(' ')}
                                  </span>
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </Card>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Campaign Plan Card (for list view) ────────────────────────────

function CampaignPlanCard({ run, onClick }: { run: CampaignRun; onClick: () => void }) {
  const plan = run.summary as CampaignPlanSummary;
  const totalPosts = (plan.weeklyPlan || []).reduce((sum, w) => sum + (w.posts?.length || 0), 0);

  return (
    <Card
      className="p-4 border border-border hover:border-primary/30 hover:shadow-sm transition-all cursor-pointer group"
      onClick={onClick}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <h3 className="font-medium text-foreground text-sm group-hover:text-primary transition-colors truncate">
              {plan.campaignName || 'Campaign Plan'}
            </h3>
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-primary/10 text-primary font-medium shrink-0">
              Campaign Plan
            </span>
          </div>
          {plan.brandName && (
            <p className="text-xs text-muted-foreground mb-2">
              {plan.brandName} · {plan.duration || 'Ongoing'}
            </p>
          )}
          <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
            <span className="flex items-center gap-1">
              <Target className="h-3 w-3" />
              {plan.goal ? (plan.goal.length > 40 ? plan.goal.slice(0, 40) + '…' : plan.goal) : '—'}
            </span>
            <span className="flex items-center gap-1">
              <CalendarClock className="h-3 w-3" />
              {plan.weeklyPlan?.length || 0} weeks · {totalPosts} posts
            </span>
          </div>
          <div className="flex items-center gap-1 mt-2">
            {(plan.platforms || []).map((p) => (
              <span
                key={p}
                className={cn('inline-flex items-center justify-center h-5 w-5 rounded-md', PLATFORM_COLOR[p] || 'bg-gray-200 text-gray-700')}
                title={p}
              >
                {PLATFORM_ICON[p] || <Globe className="h-3 w-3" />}
              </span>
            ))}
          </div>
        </div>
        <div className="text-[11px] text-muted-foreground shrink-0">
          {new Date(run.createdAt).toLocaleDateString()}
        </div>
      </div>
    </Card>
  );
}

// ─── Main Page ─────────────────────────────────────────────────────

export default function CampaignsPage() {
  const [rules, setRules] = useState<PromotionRule[]>([]);
  const [runs, setRuns] = useState<CampaignRun[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'plans' | 'rules' | 'history'>('plans');
  const [selectedPlan, setSelectedPlan] = useState<CampaignRun | null>(null);

  const campaignPlans = runs.filter((r) => r.runType === 'campaign_plan' && isCampaignPlan(r.summary));
  const otherRuns = runs.filter((r) => r.runType !== 'campaign_plan');

  const loadData = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [rulesData, runsData] = await Promise.all([
        api.listPromotionRules(),
        api.listCampaignRuns({ limit: 50 }),
      ]);
      setRules(rulesData);
      setRuns(runsData.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load campaign data');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const handleToggle = useCallback(async (ruleId: string, currentlyActive: boolean) => {
    setTogglingId(ruleId);
    try {
      const updated = await api.togglePromotionRule(ruleId, !currentlyActive);
      setRules((prev) => prev.map((r) => (r.id === ruleId ? updated : r)));
    } catch {
      // silently fail
    } finally {
      setTogglingId(null);
    }
  }, []);

  const RULE_TYPE_LABELS: Record<string, string> = {
    repost: 'Repost',
    reminder: 'Reminder',
    launch_sequence: 'Launch Sequence',
    weekend_promo: 'Weekend Promo',
    still_available: 'Still Available',
    custom: 'Custom',
  };

  // Detail view
  if (selectedPlan) {
    return (
      <div className="p-6 md:p-8 max-w-5xl">
        <CampaignPlanDetail run={selectedPlan} onBack={() => setSelectedPlan(null)} />
      </div>
    );
  }

  return (
    <div className="p-6 md:p-8 max-w-5xl">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Campaigns</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Marketing campaign plans, promotion rules and execution history
          </p>
        </div>
      </div>

      {error && (
        <div className="mb-6 p-3 rounded-xl bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800/50 flex items-start gap-2 text-sm text-red-700 dark:text-red-400">
          <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
          {error}
        </div>
      )}

      {/* Tabs */}
      <div className="flex items-center gap-1 p-1 bg-muted rounded-xl mb-6 w-fit">
        {[
          { id: 'plans' as const, label: 'Campaign Plans', count: campaignPlans.length },
          { id: 'rules' as const, label: 'Promotion Rules', count: rules.length },
          { id: 'history' as const, label: 'Run History', count: otherRuns.length },
        ].map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setActiveTab(tab.id)}
            className={cn(
              'px-4 py-1.5 rounded-lg text-[12px] font-semibold transition-all duration-200 flex items-center gap-1.5',
              activeTab === tab.id
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {tab.label}
            {tab.count > 0 && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-primary/10 text-primary">
                {tab.count}
              </span>
            )}
          </button>
        ))}
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-20 rounded-lg" />
          ))}
        </div>
      ) : activeTab === 'plans' ? (
        <>
          {campaignPlans.length === 0 ? (
            <Card className="p-8 border border-dashed text-center">
              <Megaphone className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
              <p className="text-sm font-medium text-foreground mb-1">No campaign plans yet</p>
              <p className="text-xs text-muted-foreground max-w-sm mx-auto">
                Tell your AI agent about your business and goals — it will create a detailed marketing campaign plan for you. Try saying: &ldquo;Help me create a social media campaign to increase sales&rdquo;
              </p>
            </Card>
          ) : (
            <div className="space-y-3">
              {campaignPlans.map((run) => (
                <CampaignPlanCard
                  key={run.id}
                  run={run}
                  onClick={() => setSelectedPlan(run)}
                />
              ))}
            </div>
          )}
        </>
      ) : activeTab === 'rules' ? (
        <>
          {rules.length === 0 ? (
            <Card className="p-8 border border-dashed text-center">
              <CalendarClock className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
              <p className="text-sm font-medium text-foreground mb-1">No promotion rules</p>
              <p className="text-xs text-muted-foreground">
                Create recurring promotions through the AI agent by asking it to set up automatic reposting.
              </p>
            </Card>
          ) : (
            <div className="space-y-3">
              {rules.map((rule) => (
                <Card key={rule.id} className={cn(
                  'p-4 border transition-all',
                  rule.isActive ? 'border-border' : 'border-border opacity-60',
                )}>
                  <div className="flex items-center justify-between">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <h3 className="font-medium text-foreground text-sm">{rule.ruleName}</h3>
                        <span className="text-[10px] px-2 py-0.5 rounded-full bg-muted text-muted-foreground font-medium">
                          {RULE_TYPE_LABELS[rule.ruleType] || rule.ruleType}
                        </span>
                        {rule.isActive ? (
                          <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400 font-medium">
                            Active
                          </span>
                        ) : (
                          <span className="text-[10px] px-2 py-0.5 rounded-full bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 font-medium">
                            Paused
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-3 text-xs text-muted-foreground">
                        {rule.scheduleCron && (
                          <span className="flex items-center gap-1">
                            <Clock className="h-3 w-3" />
                            {rule.scheduleCron}
                          </span>
                        )}
                        {rule.channels.length > 0 && (
                          <span>{rule.channels.join(', ')}</span>
                        )}
                        {rule.maxRuns != null && (
                          <span>Max {rule.maxRuns} runs</span>
                        )}
                      </div>
                      {rule.template && (
                        <p className="text-[11px] text-muted-foreground mt-1 italic truncate">
                          Template: &ldquo;{rule.template}&rdquo;
                        </p>
                      )}
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      className={cn(
                        'text-xs h-7 gap-1',
                        rule.isActive
                          ? 'text-amber-600 hover:bg-amber-50 dark:hover:bg-amber-950/30'
                          : 'text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-950/30',
                      )}
                      onClick={() => handleToggle(rule.id, rule.isActive)}
                      disabled={togglingId === rule.id}
                    >
                      {togglingId === rule.id ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : rule.isActive ? (
                        <PowerOff className="h-3 w-3" />
                      ) : (
                        <Power className="h-3 w-3" />
                      )}
                      {rule.isActive ? 'Pause' : 'Activate'}
                    </Button>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </>
      ) : (
        <>
          {otherRuns.length === 0 ? (
            <Card className="p-8 border border-dashed text-center">
              <PlayCircle className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
              <p className="text-sm font-medium text-foreground mb-1">No campaign runs yet</p>
              <p className="text-xs text-muted-foreground">
                Campaign runs will appear here as promotion rules execute.
              </p>
            </Card>
          ) : (
            <div className="space-y-3">
              {otherRuns.map((run) => (
                <Card key={run.id} className="p-4 border border-border">
                  <div className="flex items-center justify-between">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <h3 className="font-medium text-foreground text-sm">
                          {run.productName || 'Campaign Run'}
                        </h3>
                        <span className="text-[10px] px-2 py-0.5 rounded-full bg-muted text-muted-foreground font-medium">
                          {run.runType}
                        </span>
                        <span
                          className={cn(
                            'text-[10px] px-2 py-0.5 rounded-full font-medium',
                            run.status === 'completed'
                              ? 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400'
                              : run.status === 'running'
                                ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400'
                                : run.status === 'failed'
                                  ? 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400'
                                  : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400',
                          )}
                        >
                          {run.status}
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Started {new Date(run.startedAt).toLocaleString()}
                        {run.completedAt && ` · Completed ${new Date(run.completedAt).toLocaleString()}`}
                      </p>
                      {run.promotionRuleName && (
                        <p className="text-[11px] text-muted-foreground mt-0.5">
                          Rule: {run.promotionRuleName}
                        </p>
                      )}
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
