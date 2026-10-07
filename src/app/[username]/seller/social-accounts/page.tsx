'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { Card, Button, Skeleton } from '@/components/ui';
import {
  Share2, Trash2, Loader2, AlertCircle, ExternalLink,
} from 'lucide-react';
import {
  SiX, SiFacebook, SiInstagram, SiLinkedin, SiTiktok,
  SiYoutube, SiThreads, SiReddit, SiPinterest, SiBluesky,
  SiTelegram, SiSnapchat, SiGoogle,
} from 'react-icons/si';
import { cn } from '@/lib/utils';
import { api } from '@/lib/api';
import type { ConnectedSocialAccount, PublishingTarget } from '@/types';

const PLATFORMS = [
  { id: 'twitter',        label: 'Twitter / X',    color: 'bg-black',                                       Icon: SiX },
  { id: 'facebook',       label: 'Facebook',        color: 'bg-[#1877F2]',                                   Icon: SiFacebook },
  { id: 'instagram',      label: 'Instagram',       color: 'bg-gradient-to-br from-[#833AB4] via-[#E1306C] to-[#F77737]', Icon: SiInstagram },
  { id: 'linkedin',       label: 'LinkedIn',        color: 'bg-[#0A66C2]',                                   Icon: SiLinkedin },
  { id: 'tiktok',         label: 'TikTok',          color: 'bg-black',                                       Icon: SiTiktok },
  { id: 'youtube',        label: 'YouTube',         color: 'bg-[#FF0000]',                                   Icon: SiYoutube },
  { id: 'threads',        label: 'Threads',         color: 'bg-black',                                       Icon: SiThreads },
  { id: 'reddit',         label: 'Reddit',          color: 'bg-[#FF4500]',                                   Icon: SiReddit },
  { id: 'pinterest',      label: 'Pinterest',       color: 'bg-[#E60023]',                                   Icon: SiPinterest },
  { id: 'bluesky',        label: 'Bluesky',         color: 'bg-[#0285FF]',                                   Icon: SiBluesky },
  { id: 'googlebusiness', label: 'Google Business', color: 'bg-white border border-gray-200',                Icon: SiGoogle },
  { id: 'telegram',       label: 'Telegram',        color: 'bg-[#229ED9]',                                   Icon: SiTelegram },
  { id: 'snapchat',       label: 'Snapchat',        color: 'bg-[#FFFC00]',                                   Icon: SiSnapchat },
] as const;

const PLATFORM_MAP = Object.fromEntries(PLATFORMS.map((p) => [p.id, p]));

export default function SocialAccountsPage() {
  const [accounts, setAccounts] = useState<ConnectedSocialAccount[]>([]);
  const [targets, setTargets] = useState<PublishingTarget[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [disconnectingId, setDisconnectingId] = useState<string | null>(null);
  const [connectingPlatform, setConnectingPlatform] = useState<string | null>(null);
  const oauthWindowRef = useRef<Window | null>(null);

  const loadData = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [accts, tgts] = await Promise.all([
        api.listSocialAccounts(),
        api.listPublishingTargets(),
      ]);
      setAccounts(accts);
      setTargets(tgts);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load data');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  // Listen for OAuth callback messages from the popup
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (event.data?.type === 'zernio-oauth-success') {
        oauthWindowRef.current?.close();
        oauthWindowRef.current = null;
        setConnectingPlatform(null);
        void loadData();
      } else if (event.data?.type === 'zernio-oauth-error') {
        oauthWindowRef.current?.close();
        oauthWindowRef.current = null;
        setConnectingPlatform(null);
        setError(event.data.error || 'Connection failed');
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [loadData]);

  const handleConnect = useCallback(async (platform: string) => {
    setConnectingPlatform(platform);
    setError(null);
    try {
      // Use the current origin so the OAuth callback lands on the same
      // subdomain where the user has an auth cookie.
      const callbackUrl = `${window.location.origin}/seller/social-accounts/oauth-callback`;
      const { authUrl } = await api.getZernioConnectUrl(platform, callbackUrl);

      // Open OAuth popup
      const w = 600;
      const h = 700;
      const left = window.screenX + (window.outerWidth - w) / 2;
      const top = window.screenY + (window.outerHeight - h) / 2;
      const popup = window.open(
        authUrl,
        `zernio_connect_${platform}`,
        `width=${w},height=${h},left=${left},top=${top},toolbar=no,menubar=no,scrollbars=yes`
      );
      oauthWindowRef.current = popup;

      // Poll for popup close — always refresh data as a fallback
      // in case postMessage doesn't reach the opener.
      const pollTimer = setInterval(() => {
        if (popup?.closed) {
          clearInterval(pollTimer);
          setConnectingPlatform(null);
          void loadData();
        }
      }, 1000);
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to start ${platform} connect`);
      setConnectingPlatform(null);
    }
  }, [loadData]);

  const handleDisconnect = useCallback(async (accountId: string) => {
    setDisconnectingId(accountId);
    setError(null);
    try {
      await api.disconnectSocialAccount(accountId);
      setAccounts((prev) => prev.filter((a) => a.id !== accountId));
      setTargets((prev) => prev.filter((t) => t.socialAccountId !== accountId));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to disconnect account');
    } finally {
      setDisconnectingId(null);
    }
  }, []);

  const connectedPlatformIds = new Set(accounts.filter((a) => a.isActive).map((a) => a.platform));

  return (
    <div className="p-6 md:p-8 max-w-5xl">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Social Accounts</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Connect your social media accounts to publish listings across platforms
          </p>
        </div>
      </div>

      {error && (
        <div className="mb-6 p-3 rounded-xl bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800/50 flex items-start gap-2 text-sm text-red-700 dark:text-red-400">
          <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
          {error}
        </div>
      )}

      {/* Connect Platforms */}
      <div className="mb-10">
        <h2 className="text-base font-semibold text-foreground mb-1">Connect a Platform</h2>
        <p className="text-xs text-muted-foreground mb-4">
          Click a platform to start the OAuth connection flow
        </p>
        <div className="grid gap-3 grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
          {PLATFORMS.map((platform) => {
            const isConnected = connectedPlatformIds.has(platform.id);
            const isConnecting = connectingPlatform === platform.id;
            return (
              <button
                key={platform.id}
                onClick={() => handleConnect(platform.id)}
                disabled={isConnecting}
                className={cn(
                  'relative flex flex-col items-center gap-2 p-4 rounded-xl border transition-all',
                  'hover:shadow-md hover:-translate-y-0.5 active:translate-y-0',
                  isConnected
                    ? 'border-emerald-300 dark:border-emerald-700 bg-emerald-50/50 dark:bg-emerald-950/20'
                    : 'border-border hover:border-primary/30 bg-card',
                  isConnecting && 'opacity-70 cursor-wait',
                )}>
                <div className={cn(
                  'w-10 h-10 rounded-xl flex items-center justify-center text-white text-sm',
                  platform.color,
                )}>
                  {isConnecting ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <platform.Icon className={cn('h-5 w-5', platform.id === 'googlebusiness' && 'text-[#4285F4]', platform.id === 'snapchat' && 'text-black')} />
                  )}
                </div>
                <span className="text-xs font-medium text-foreground">{platform.label}</span>
                {isConnected && (
                  <span className="absolute top-2 right-2 w-2 h-2 rounded-full bg-emerald-500" />
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Connected Accounts */}
      <div className="mb-10">
        <h2 className="text-base font-semibold text-foreground mb-1">Connected Accounts</h2>
        <p className="text-xs text-muted-foreground mb-4">
          Manage your connected social media accounts
        </p>

        {isLoading ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-32 rounded-lg" />
            ))}
          </div>
        ) : accounts.length === 0 ? (
          <Card className="p-8 border border-dashed text-center">
            <Share2 className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
            <p className="text-sm font-medium text-foreground mb-1">No social accounts connected</p>
            <p className="text-xs text-muted-foreground">
              Click a platform above to connect your first account.
            </p>
          </Card>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {accounts.map((account) => {
              const platformInfo = PLATFORM_MAP[account.platform];
              return (
                <Card key={account.id} className="p-5 border border-border">
                  <div className="flex items-start gap-3 mb-4">
                    <div className={cn(
                      'w-10 h-10 rounded-xl flex items-center justify-center text-white text-sm',
                      platformInfo?.color || 'bg-gray-500',
                    )}>
                      {platformInfo ? (
                        <platformInfo.Icon className={cn('h-5 w-5', platformInfo.id === 'googlebusiness' && 'text-[#4285F4]', platformInfo.id === 'snapchat' && 'text-black')} />
                      ) : (
                        account.platform.charAt(0).toUpperCase()
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <h3 className="font-semibold text-foreground text-sm truncate">
                        {account.accountName || account.platform}
                      </h3>
                      <span className="flex items-center gap-1.5 text-xs text-emerald-600 mt-0.5">
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                        Connected
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 text-xs text-muted-foreground mb-4">
                    <span className="capitalize">{platformInfo?.label || account.platform}</span>
                    <span>via Zernio</span>
                  </div>
                  {account.accountUrl && (
                    <a
                      href={account.accountUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-xs text-primary hover:underline mb-3"
                    >
                      View profile <ExternalLink className="h-3 w-3" />
                    </a>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-xs h-7 gap-1 text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950/30 w-full"
                    onClick={() => handleDisconnect(account.id)}
                    disabled={disconnectingId === account.id}
                  >
                    {disconnectingId === account.id ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Trash2 className="h-3 w-3" />
                    )}
                    Disconnect
                  </Button>
                </Card>
              );
            })}
          </div>
        )}
      </div>

      {/* Publishing Targets */}
      <div>
        <h2 className="text-base font-semibold text-foreground mb-1">Publishing Targets</h2>
        <p className="text-xs text-muted-foreground mb-4">
          Targets are auto-created when you connect accounts
        </p>

        {isLoading ? (
          <div className="space-y-3">
            {Array.from({ length: 2 }).map((_, i) => (
              <Skeleton key={i} className="h-16 rounded-lg" />
            ))}
          </div>
        ) : targets.length === 0 ? (
          <Card className="p-6 border border-dashed text-center">
            <p className="text-sm font-medium text-foreground mb-1">No publishing targets</p>
            <p className="text-xs text-muted-foreground">
              Connect a social account above to auto-create publishing targets.
            </p>
          </Card>
        ) : (
          <div className="space-y-3">
            {targets.map((target) => {
              const platformInfo = PLATFORM_MAP[target.platform || ''];
              return (
                <Card key={target.id} className="p-4 border border-border">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className={cn(
                        'w-8 h-8 rounded-lg flex items-center justify-center text-white font-bold text-xs',
                        platformInfo?.color || 'bg-gray-500',
                      )}>
                        {platformInfo ? (
                          <platformInfo.Icon className={cn('h-4 w-4', platformInfo.id === 'googlebusiness' && 'text-[#4285F4]', platformInfo.id === 'snapchat' && 'text-black')} />
                        ) : (
                          (target.platform || target.targetType).charAt(0).toUpperCase()
                        )}
                      </div>
                      <div>
                        <h3 className="font-medium text-foreground text-sm">
                          {target.targetLabel || target.targetType}
                        </h3>
                        <p className="text-xs text-muted-foreground">
                          {platformInfo?.label || target.platform}
                          {target.accountName ? ` · ${target.accountName}` : ''}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {target.isDefault && (
                        <span className="text-[10px] px-2 py-0.5 rounded-full bg-primary/10 text-primary font-medium">
                          Default
                        </span>
                      )}
                      <span className={cn(
                        'text-[10px] px-2 py-0.5 rounded-full font-medium',
                        target.isActive
                          ? 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400'
                          : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400',
                      )}>
                        {target.isActive ? 'Active' : 'Inactive'}
                      </span>
                    </div>
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
