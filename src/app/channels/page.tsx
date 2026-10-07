'use client';

import { useState, useMemo, useCallback, Suspense } from 'react';
import Link from 'next/link';
import { Card, Button, Skeleton } from '@/components/ui';
import { CHANNEL_TYPES, ROUTES } from '@/lib/constants';
import { useChannels, useSavedChannels, usePlatformLinks, useSlackStatus } from '@/hooks';
import {
  Radio, Plus, Settings2, ExternalLink, CheckCircle2,
  Activity, MessageSquare, ArrowUpRight, Key, Zap, Globe,
  Trash2, Loader2, RefreshCw, AlertCircle, Lock, Sparkles
} from 'lucide-react';
import { SiDiscord, SiSlack, SiTelegram, SiWhatsapp } from 'react-icons/si';
import { FaMicrosoft } from 'react-icons/fa6';
import { cn } from '@/lib/utils';
import { SettingsSidebar, SidebarLayout } from '@/components/layout/sidebar';
import { api } from '@/lib/api';
import { configApi } from '@/lib/config-api';

function ChannelIcon({ type, size = 'md' }: { type: (typeof CHANNEL_TYPES)[number]; size?: 'sm' | 'md' }) {
  const sizeClasses = size === 'sm' ? 'w-8 h-8' : 'w-10 h-10';
  const iconSizeClasses = size === 'sm' ? 'w-4 h-4' : 'w-5 h-5';

  const iconMap: Record<string, JSX.Element> = {
    discord: <SiDiscord className={cn('text-white', iconSizeClasses)} />,
    slack: <SiSlack className={cn('text-white', iconSizeClasses)} />,
    telegram: <SiTelegram className={cn('text-white', iconSizeClasses)} />,
    whatsapp: <SiWhatsapp className={cn('text-white', iconSizeClasses)} />,
    teams: <FaMicrosoft className={cn('text-white', iconSizeClasses)} />,
    web: <Globe className={cn('text-white', iconSizeClasses)} />,
  };

  return (
    <div
      className={cn('rounded-xl flex items-center justify-center text-white font-bold shrink-0', sizeClasses)}
      style={{ backgroundColor: type.color }}
    >
      {iconMap[type.id] || type.label.charAt(0)}
    </div>
  );
}

export default function ChannelsPage() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center min-h-screen"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>}>
      <ChannelsContent />
    </Suspense>
  );
}

function ChannelsContent() {
  const { data: gatewayChannels, isLoading: gatewayLoading } = useChannels();
  const { data: savedChannels, isLoading: savedLoading, mutate: refreshSaved } = useSavedChannels();
  const { data: platformLinks, isLoading: linksLoading, mutate: refreshLinks } = usePlatformLinks();
  const { data: slackStatus, isLoading: slackLoading, mutate: refreshSlack } = useSlackStatus();
  const { mutate: refreshGateway } = useChannels();
  const [disconnecting, setDisconnecting] = useState<string | null>(null);
  const [disconnectError, setDisconnectError] = useState<string | null>(null);

  const isLoading = gatewayLoading || savedLoading || linksLoading || slackLoading;

  // Platform link status for SaaS channels
  const linkMap = useMemo(() => {
    const map = new Map<string, { platformUserId: string; platformMeta: Record<string, unknown>; linkedAt: string }>();
    (platformLinks ?? []).forEach((link) => {
      if (link?.isActive) map.set(link.platform, { platformUserId: link.platformUserId, platformMeta: link.platformMeta, linkedAt: link.linkedAt });
    });
    // Inject Slack connection status from dedicated slack_connections table
    if (slackStatus?.connected && slackStatus.teamId) {
      map.set('slack', {
        platformUserId: slackStatus.teamId,
        platformMeta: { teamName: slackStatus.teamName, mode: slackStatus.mode },
        linkedAt: slackStatus.installedAt || new Date().toISOString(),
      });
    }
    return map;
  }, [platformLinks, slackStatus]);

  const savedMap = useMemo(() => {
    const map = new Map<string, (typeof savedChannels extends (infer U)[] | undefined ? U : never)>();
    (savedChannels ?? []).forEach((c) => { if (c) map.set(c.channelType, c); });
    return map;
  }, [savedChannels]);

  const gatewayMap = useMemo(() => {
    const map = new Map<string, boolean>();
    (gatewayChannels ?? []).forEach((gc) => {
      const key = gc.type?.toLowerCase() || gc.name?.toLowerCase() || '';
      if (key) map.set(key, !!gc.connected);
    });
    return map;
  }, [gatewayChannels]);

  // Split channels into SaaS (primary) and legacy (coming soon)
  const saasChannels = CHANNEL_TYPES.filter(t => t.saas);
  const comingSoonChannels = CHANNEL_TYPES.filter(t => !t.saas);

  const getChannelStatus = useCallback((type: (typeof CHANNEL_TYPES)[number]) => {
    const saved = savedMap.get(type.id);
    const gatewayConnected = gatewayMap.get(type.id);
    const link = linkMap.get(type.id);
    return {
      type,
      savedRecord: saved,
      isLinked: !!link,
      linkInfo: link,
      isConnected: saved?.isActive === true || !!gatewayConnected || !!link,
      isGatewayLive: !!gatewayConnected,
      isDbSaved: !!saved?.isActive,
      connectedAt: link?.linkedAt ?? saved?.connectedAt ?? null,
      lastError: saved?.lastError ?? null,
    };
  }, [savedMap, gatewayMap, linkMap]);

  const saasStatuses = saasChannels.map(getChannelStatus);
  const linkedCount = saasStatuses.filter(c => c.isLinked).length;

  const handleUnlink = useCallback(async (platform: string) => {
    setDisconnecting(platform);
    setDisconnectError(null);
    try {
      if (platform === 'slack') {
        const res = await fetch('/api/channels/slack/disconnect', { method: 'DELETE', credentials: 'include' });
        if (!res.ok) { const d = await res.json().catch(() => ({ error: 'Unknown error' })); throw new Error(d.error); }
        refreshSlack();
      } else {
        await api.unlinkPlatform(platform);
      }
      refreshLinks();
      refreshSaved();
      refreshGateway();
    } catch (err) {
      setDisconnectError(`Failed to unlink ${platform}: ${(err as Error).message}`);
    } finally {
      setDisconnecting(null);
    }
  }, [refreshLinks, refreshSaved, refreshGateway, refreshSlack]);

  return (
    <SidebarLayout sidebar={<SettingsSidebar />}>
      <div className="p-6 md:p-8 max-w-5xl">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-2xl font-bold text-foreground">Messaging Channels</h1>
            <p className="text-muted-foreground mt-1 text-sm">
              Connect your messaging platforms — no bot tokens needed, just link your account
            </p>
          </div>
        </div>

        {disconnectError && (
          <div className="mb-6 p-3 rounded-xl bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800/50 flex items-start gap-2 text-sm text-red-700 dark:text-red-400">
            <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
            {disconnectError}
          </div>
        )}

        {/* Stats */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-8">
          <Card className="p-5 border border-border shadow-sm bg-card">
            <div className="flex items-center justify-between mb-3">
              <span className="text-sm text-muted-foreground">Linked Channels</span>
              <Radio className="h-4 w-4 text-primary" />
            </div>
            {isLoading ? (
              <Skeleton className="h-9 w-16" />
            ) : (
              <>
                <p className="text-3xl font-bold text-foreground">{linkedCount}</p>
                <p className="text-xs text-emerald-600 mt-1 flex items-center gap-1">
                  <ArrowUpRight className="h-3 w-3" />
                  {linkedCount === 0 ? 'No channels linked yet' : `${linkedCount} of ${saasChannels.length} platforms linked`}
                </p>
              </>
            )}
          </Card>

          <Card className="p-5 border border-border shadow-sm bg-card">
            <div className="flex items-center justify-between mb-3">
              <span className="text-sm text-muted-foreground">Available Platforms</span>
              <Sparkles className="h-4 w-4 text-amber-500" />
            </div>
            <p className="text-3xl font-bold text-foreground">{saasChannels.length}</p>
            <p className="text-xs text-muted-foreground mt-1">Zero-setup instant connection</p>
          </Card>
        </div>

        {/* Primary SaaS Channels */}
        <div className="mb-6">
          <h2 className="text-base font-semibold text-foreground mb-1">Available Channels</h2>
          <p className="text-xs text-muted-foreground mb-4">Link your account and start chatting — we handle all the bot infrastructure</p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 mb-10">
          {saasStatuses.map((channel) => (
            <Card
              key={channel.type.id}
              className={cn(
                'p-5 border shadow-sm hover:shadow-md transition-all duration-200 bg-card',
                channel.isLinked && 'ring-1 ring-emerald-500/20'
              )}
            >
              <div className="flex items-start gap-3 mb-4">
                <ChannelIcon type={channel.type} />
                <div className="flex-1 min-w-0">
                  <h3 className="font-semibold text-foreground text-sm">{channel.type.label}</h3>
                  {channel.isLinked ? (
                    <div className="space-y-0.5 mt-0.5">
                      <span className="flex items-center gap-1.5 text-xs text-emerald-600">
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                        Linked
                        {channel.linkInfo?.platformMeta && (channel.linkInfo.platformMeta as Record<string, string>).username
                          ? ` — @${(channel.linkInfo.platformMeta as Record<string, string>).username}`
                          : ''}
                      </span>
                      {channel.connectedAt && (
                        <span className="text-[11px] text-muted-foreground block">
                          Since {new Date(channel.connectedAt).toLocaleDateString()}
                        </span>
                      )}
                    </div>
                  ) : (
                    <span className="text-xs text-muted-foreground mt-0.5">Not linked — click to connect</span>
                  )}
                </div>
              </div>

              {channel.isLinked ? (
                <div className="flex gap-2">
                  <Link href={`/channels/${channel.type.id}`} className="flex-1">
                    <Button variant="outline" size="sm" className="text-xs h-8 gap-1.5 w-full">
                      <Settings2 className="h-3 w-3" />
                      Manage
                    </Button>
                  </Link>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-xs h-8 gap-1.5 text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950/30"
                    onClick={() => handleUnlink(channel.type.id)}
                    disabled={disconnecting === channel.type.id}
                  >
                    {disconnecting === channel.type.id
                      ? <Loader2 className="h-3 w-3 animate-spin" />
                      : <Trash2 className="h-3 w-3" />}
                    Unlink
                  </Button>
                </div>
              ) : (
                <Link href={`/channels/${channel.type.id}`}>
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-xs h-8 gap-1.5 w-full justify-center"
                  >
                    <Zap className="h-3 w-3" />
                    Link {channel.type.label}
                  </Button>
                </Link>
              )}
            </Card>
          ))}
        </div>

        {/* Coming Soon Channels */}
        <div className="mb-4">
          <h2 className="text-base font-semibold text-foreground mb-1">Coming Soon</h2>
          <p className="text-xs text-muted-foreground mb-4">More platforms are on the way</p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 mb-8">
          {comingSoonChannels.map((type) => (
            <Card
              key={type.id}
              className="p-5 border border-border shadow-sm bg-card opacity-60 cursor-not-allowed"
            >
              <div className="flex items-start gap-3 mb-4">
                <div className="relative">
                  <ChannelIcon type={type} />
                  <div className="absolute -bottom-0.5 -right-0.5 w-4 h-4 rounded-full bg-muted flex items-center justify-center">
                    <Lock className="h-2.5 w-2.5 text-muted-foreground" />
                  </div>
                </div>
                <div className="flex-1 min-w-0">
                  <h3 className="font-semibold text-foreground text-sm">{type.label}</h3>
                  <span className="text-xs text-muted-foreground mt-0.5">Coming soon</span>
                </div>
                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400">
                  Soon
                </span>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="text-xs h-8 gap-1.5 w-full justify-center"
                disabled
              >
                <Lock className="h-3 w-3" />
                Coming Soon
              </Button>
            </Card>
          ))}
        </div>

        {/* Linked Channel Details */}
        {saasStatuses.filter(c => c.isLinked).length > 0 && (
          <div className="mt-8">
            <h2 className="text-base font-semibold text-foreground mb-4">Linked Channel Details</h2>
            <div className="space-y-3">
              {saasStatuses.filter(c => c.isLinked).map((channel) => (
                <Card key={channel.type.id} className="p-4 border border-border shadow-sm bg-card">
                  <div className="flex flex-col sm:flex-row sm:items-center gap-3">
                    <ChannelIcon type={channel.type} size="sm" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium text-sm text-foreground">{channel.type.label}</span>
                        <span className="inline-flex items-center gap-1 text-[11px] bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400 px-2 py-0.5 rounded-full font-medium">
                          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                          Linked
                        </span>
                      </div>
                      {channel.linkInfo?.platformMeta && (
                        <p className="text-xs text-muted-foreground mt-0.5">
                          Platform ID: {channel.linkInfo.platformUserId}
                          {(channel.linkInfo.platformMeta as Record<string, string>).username &&
                            ` (@${(channel.linkInfo.platformMeta as Record<string, string>).username})`}
                        </p>
                      )}
                    </div>
                    <Link href={`/channels/${channel.type.id}`}>
                      <Button variant="ghost" size="sm" className="h-8 text-xs gap-1">
                        <Settings2 className="h-3 w-3" />
                        Edit
                      </Button>
                    </Link>
                  </div>
                </Card>
              ))}
            </div>
          </div>
        )}

        <Card className="mt-8 p-5 border border-border shadow-sm bg-muted/50">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-muted flex items-center justify-center shrink-0">
                <Key className="h-5 w-5 text-muted-foreground" />
              </div>
              <div>
                <h3 className="font-semibold text-foreground text-sm">Looking for API Keys?</h3>
                <p className="text-xs text-muted-foreground">
                  Manage your API keys for programmatic access to mawaDao integrations
                </p>
              </div>
            </div>
            <Link href="/settings?tab=account" className="shrink-0">
              <Button variant="outline" size="sm" className="text-xs gap-1.5 w-full sm:w-auto">
                Manage API Keys
                <ArrowUpRight className="h-3 w-3" />
              </Button>
            </Link>
          </div>
        </Card>
      </div>
    </SidebarLayout>
  );
}
