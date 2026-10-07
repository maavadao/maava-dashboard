'use client';

import { useState, useEffect, useCallback, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from '@/components/member-link';
import { Card, Button } from '@/components/ui';
import {
  ArrowLeft, CheckCircle2, Loader2, AlertCircle, ExternalLink,
  Zap, MessageSquare, Shield, Sparkles, Users, Hash, AtSign,
} from 'lucide-react';
import { SiSlack } from 'react-icons/si';
import { cn } from '@/lib/utils';
import { SettingsSidebar, SidebarLayout } from '@/components/layout/sidebar';
import { useAuth } from '@/hooks';
import type { SlackConnectionStatus } from '@/types/slack';

function SlackPageContent() {
  const searchParams = useSearchParams();
  const { isAuthenticated } = useAuth();
  const [status, setStatus] = useState<SlackConnectionStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [disconnecting, setDisconnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  // Check for callback params
  useEffect(() => {
    if (searchParams.get('success') === 'slack_connected') {
      setSuccess(true);
    }
    const slackError = searchParams.get('slack_error');
    if (slackError) {
      setError(`Slack connection failed: ${slackError.replace(/_/g, ' ')}`);
    }
  }, [searchParams]);

  // Fetch connection status
  const fetchStatus = useCallback(async () => {
    if (!isAuthenticated) return;
    try {
      const res = await fetch('/api/channels/slack/status', { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to fetch status');
      const data = await res.json();
      setStatus(data.data);
    } catch (err) {
      console.error('Failed to fetch Slack status:', err);
    } finally {
      setLoading(false);
    }
  }, [isAuthenticated]);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  const handleDisconnect = useCallback(async () => {
    setDisconnecting(true);
    setError(null);
    try {
      const res = await fetch('/api/channels/slack/disconnect', {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(data.error);
      }
      setStatus(null);
      setSuccess(false);
      await fetchStatus();
    } catch (err) {
      setError((err as Error).message || 'Failed to disconnect');
    } finally {
      setDisconnecting(false);
    }
  }, [fetchStatus]);

  const isConnected = status?.connected === true;

  return (
    <SidebarLayout sidebar={<SettingsSidebar />}>
      <div className="p-6 md:p-8 max-w-2xl">
        {/* Header */}
        <div className="flex items-center gap-3 mb-6">
          <Link href="/channels">
            <Button variant="ghost" size="sm" className="h-8 w-8 p-0">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div className="w-10 h-10 rounded-xl bg-[#4A154B] flex items-center justify-center">
            <SiSlack className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-foreground">Slack</h1>
            <p className="text-sm text-muted-foreground">Connect your Slack workspace</p>
          </div>
        </div>

        {error && (
          <div className="mb-6 p-3 rounded-xl bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800/50 flex items-start gap-2 text-sm text-red-700 dark:text-red-400">
            <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
            {error}
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : isConnected ? (
          <Card className="p-6 border border-emerald-200 dark:border-emerald-800/50 bg-emerald-50/50 dark:bg-emerald-950/20">
            <div className="flex items-start gap-4">
              <div className="w-12 h-12 rounded-xl bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center">
                <CheckCircle2 className="h-6 w-6 text-emerald-600" />
              </div>
              <div className="flex-1">
                <h2 className="text-lg font-semibold text-foreground">Slack Connected</h2>
                <p className="text-sm text-muted-foreground mt-1">
                  Your Slack workspace is connected. DM the bot or @mention it in any channel and your AI agent will respond.
                </p>
                <div className="mt-3 text-sm text-muted-foreground space-y-1">
                  {status.teamName && (
                    <p>
                      Workspace:{' '}
                      <span className="font-medium text-foreground">{status.teamName}</span>
                    </p>
                  )}
                  <p>
                    Mode:{' '}
                    <span className="font-medium text-foreground capitalize">
                      {status.mode === 'events_api' ? 'Events API' : 'Socket Mode'}
                    </span>
                  </p>
                  {status.installedAt && (
                    <p>
                      Connected:{' '}
                      <span className="font-medium text-foreground">
                        {new Date(status.installedAt).toLocaleDateString()}
                      </span>
                    </p>
                  )}
                </div>

                {/* Capabilities badges */}
                <div className="mt-4 flex flex-wrap gap-2">
                  {status.capabilities.dm && (
                    <span className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded-md bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400">
                      <MessageSquare className="h-3 w-3" /> DMs
                    </span>
                  )}
                  {status.capabilities.mentions && (
                    <span className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded-md bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400">
                      <AtSign className="h-3 w-3" /> Mentions
                    </span>
                  )}
                  {status.capabilities.threads && (
                    <span className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded-md bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400">
                      <Hash className="h-3 w-3" /> Threads
                    </span>
                  )}
                  {status.capabilities.channels && (
                    <span className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded-md bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400">
                      <Hash className="h-3 w-3" /> Channels
                    </span>
                  )}
                </div>

                <div className="mt-4 flex gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-xs text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950/30"
                    onClick={handleDisconnect}
                    disabled={disconnecting}
                  >
                    {disconnecting && <Loader2 className="h-3 w-3 animate-spin mr-1" />}
                    Disconnect
                  </Button>
                </div>
              </div>
            </div>
          </Card>
        ) : (
          <>
            {/* How it works */}
            <Card className="p-6 mb-6 border border-border">
              <h2 className="text-base font-semibold text-foreground mb-3">How it works</h2>
              <div className="space-y-3">
                {[
                  {
                    icon: <Zap className="h-4 w-4" />,
                    title: 'Install to your workspace',
                    desc: 'Click the button below to add the mawaDao app to your Slack workspace',
                  },
                  {
                    icon: <MessageSquare className="h-4 w-4" />,
                    title: 'DM the bot',
                    desc: 'Send direct messages to the mawaDao bot — routed to your AI agent',
                  },
                  {
                    icon: <Users className="h-4 w-4" />,
                    title: 'Mention in channels',
                    desc: '@mawaDao in any channel and your agent responds in-thread',
                  },
                  {
                    icon: <Shield className="h-4 w-4" />,
                    title: 'Workspace-level install',
                    desc: 'One click, no bot tokens needed — mawaDao manages everything',
                  },
                ].map((step, i) => (
                  <div key={i} className="flex items-start gap-3">
                    <div className="w-8 h-8 rounded-lg bg-[#4A154B]/10 flex items-center justify-center text-[#4A154B] dark:text-[#E01E5A] shrink-0">
                      {step.icon}
                    </div>
                    <div>
                      <p className="text-sm font-medium text-foreground">{step.title}</p>
                      <p className="text-xs text-muted-foreground">{step.desc}</p>
                    </div>
                  </div>
                ))}
              </div>
            </Card>

            {/* Connect Button */}
            <Card className="p-6 border border-border">
              <h2 className="text-base font-semibold text-foreground mb-4">
                Connect your Slack workspace
              </h2>
              <div className="flex flex-col items-center py-4">
                <a href="/api/channels/slack/connect">
                  <Button className="bg-[#4A154B] hover:bg-[#3B1139] text-white gap-2 px-6 h-11">
                    <SiSlack className="h-5 w-5" />
                    Add to Slack
                  </Button>
                </a>
                <p className="text-xs text-muted-foreground text-center max-w-sm mt-4">
                  You'll be redirected to Slack to authorize the mawaDao app for your workspace.
                  Only workspace admins can approve the installation.
                </p>
              </div>
            </Card>
          </>
        )}

        {/* Features */}
        <Card className="mt-6 p-5 border border-border bg-muted/30">
          <div className="flex items-center gap-2 mb-3">
            <Sparkles className="h-4 w-4 text-amber-500" />
            <h3 className="text-sm font-semibold text-foreground">What you can do</h3>
          </div>
          <ul className="space-y-1.5 text-xs text-muted-foreground">
            <li>DM the bot for private conversations with your AI agent</li>
            <li>@mention the bot in any channel for shared conversations</li>
            <li>Threaded replies keep conversations organized</li>
            <li>Supports long messages with automatic chunking</li>
            <li>Disconnect anytime from this page</li>
          </ul>
        </Card>
      </div>
    </SidebarLayout>
  );
}

export default function SlackPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center min-h-screen">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      }
    >
      <SlackPageContent />
    </Suspense>
  );
}
