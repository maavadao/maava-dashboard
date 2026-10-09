'use client';

import { useState, useEffect, useCallback, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { useRouter } from '@/lib/member-path';
import Link from '@/components/member-link';
import { Card, Button } from '@/components/ui';
import {
  ArrowLeft, CheckCircle2, Loader2, AlertCircle, ExternalLink,
  Zap, MessageSquare, Shield, Sparkles, Users,
} from 'lucide-react';
import { SiDiscord } from 'react-icons/si';
import { cn } from '@/lib/utils';
import { SettingsSidebar, SidebarLayout } from '@/components/layout/sidebar';
import { useAuth, usePlatformLinks } from '@/hooks';
import { api } from '@/lib/api';

const DISCORD_CLIENT_ID = process.env.NEXT_PUBLIC_DISCORD_CLIENT_ID || '';
const DISCORD_REDIRECT_URI = typeof window !== 'undefined'
  ? `${window.location.origin}/channels/discord`
  : '';

function buildOAuthUrl() {
  const params = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    redirect_uri: DISCORD_REDIRECT_URI,
    response_type: 'code',
    scope: 'identify',
  });
  return `https://discord.com/api/oauth2/authorize?${params}`;
}

function DiscordLinkPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { isAuthenticated } = useAuth();
  const { data: links, mutate: refreshLinks } = usePlatformLinks();
  const [linking, setLinking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const existingLink = links?.find(l => l.platform === 'discord' && l.isActive);

  // Handle OAuth callback — exchange code for Discord user info
  useEffect(() => {
    const code = searchParams.get('code');
    if (!code || !isAuthenticated || existingLink) return;

    (async () => {
      setLinking(true);
      setError(null);
      try {
        await api.linkDiscord(code);
        setSuccess(true);
        refreshLinks();
        // Clean up URL params
        router.replace('/channels/discord');
      } catch (err) {
        setError((err as Error).message || 'Failed to link Discord account');
      } finally {
        setLinking(false);
      }
    })();
  }, [searchParams, isAuthenticated, existingLink, refreshLinks, router]);

  const handleUnlink = useCallback(async () => {
    setLinking(true);
    setError(null);
    try {
      await api.unlinkPlatform('discord');
      setSuccess(false);
      refreshLinks();
    } catch (err) {
      setError((err as Error).message || 'Failed to unlink');
    } finally {
      setLinking(false);
    }
  }, [refreshLinks]);

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
          <div className="w-10 h-10 rounded-xl bg-[#5865F2] flex items-center justify-center">
            <SiDiscord className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-foreground">Discord</h1>
            <p className="text-sm text-muted-foreground">Link your Discord account</p>
          </div>
        </div>

        {error && (
          <div className="mb-6 p-3 rounded-xl bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800/50 flex items-start gap-2 text-sm text-red-700 dark:text-red-400">
            <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
            {error}
          </div>
        )}

        {(success || existingLink) ? (
          <Card className="p-6 border border-emerald-200 dark:border-emerald-800/50 bg-emerald-50/50 dark:bg-emerald-950/20">
            <div className="flex items-start gap-4">
              <div className="w-12 h-12 rounded-xl bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center">
                <CheckCircle2 className="h-6 w-6 text-emerald-600" />
              </div>
              <div className="flex-1">
                <h2 className="text-lg font-semibold text-foreground">Discord Linked</h2>
                <p className="text-sm text-muted-foreground mt-1">
                  Your Discord account is connected. DM the bot or @mention it in a server and your AI agent will respond.
                </p>
                {existingLink?.platformMeta && (
                  <div className="mt-3 text-sm text-muted-foreground space-y-1">
                    {(existingLink.platformMeta as Record<string, string>).username && (
                      <p>Discord user: <span className="font-medium text-foreground">{(existingLink.platformMeta as Record<string, string>).username}</span></p>
                    )}
                    <p>Linked: <span className="font-medium text-foreground">{new Date(existingLink.linkedAt).toLocaleDateString()}</span></p>
                  </div>
                )}
                <div className="mt-4 flex gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-xs text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950/30"
                    onClick={handleUnlink}
                    disabled={linking}
                  >
                    {linking ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                    Unlink
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
                  { icon: <Zap className="h-4 w-4" />, title: 'Authorize with Discord', desc: 'Click the button below to link your Discord identity' },
                  { icon: <MessageSquare className="h-4 w-4" />, title: 'DM the maavaDao bot', desc: 'Send a direct message — it routes to your AI agent' },
                  { icon: <Users className="h-4 w-4" />, title: 'Works in servers too', desc: '@mention the bot in any shared server and it will reply' },
                  { icon: <Shield className="h-4 w-4" />, title: 'Privacy first', desc: 'We only store your Discord user ID — no message history is kept' },
                ].map((step, i) => (
                  <div key={i} className="flex items-start gap-3">
                    <div className="w-8 h-8 rounded-lg bg-[#5865F2]/10 flex items-center justify-center text-[#5865F2] shrink-0">
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

            {/* OAuth Button */}
            <Card className="p-6 border border-border">
              <h2 className="text-base font-semibold text-foreground mb-4">Link your Discord account</h2>
              {linking ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="h-6 w-6 animate-spin text-[#5865F2]" />
                  <span className="ml-2 text-sm text-muted-foreground">Linking your account...</span>
                </div>
              ) : (
                <div className="flex flex-col items-center py-4">
                  <a href={buildOAuthUrl()}>
                    <Button className="bg-[#5865F2] hover:bg-[#4752C4] text-white gap-2 px-6 h-11">
                      <SiDiscord className="h-5 w-5" />
                      Continue with Discord
                    </Button>
                  </a>
                  <p className="text-xs text-muted-foreground text-center max-w-sm mt-4">
                    You'll be redirected to Discord to authorize. We only request access to your public user profile.
                  </p>
                </div>
              )}
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
            <li>@mention the bot in server channels for shared conversations</li>
            <li>Get real-time AI replies in Discord</li>
            <li>Unlink anytime from this page</li>
          </ul>
        </Card>
      </div>
    </SidebarLayout>
  );
}

export default function DiscordLinkPage() {
  return (
    <Suspense>
      <DiscordLinkPageContent />
    </Suspense>
  );
}
