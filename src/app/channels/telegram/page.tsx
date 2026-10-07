'use client';

import { useState, useCallback, useEffect, useRef, Suspense } from 'react';
import Link from 'next/link';
import { Card, Button } from '@/components/ui';
import {
  ArrowLeft, CheckCircle2, Loader2, AlertCircle, ExternalLink,
  Zap, MessageSquare, Shield, Sparkles, Clock,
} from 'lucide-react';
import { SiTelegram } from 'react-icons/si';
import { SettingsSidebar, SidebarLayout } from '@/components/layout/sidebar';
import { useAuth, usePlatformLinks } from '@/hooks';
import { api } from '@/lib/api';

const BOT_USERNAME = process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME || 'barrsa_bot';
const POLL_INTERVAL_MS = 3000;
const ENABLE_LOGIN_WIDGET = process.env.NEXT_PUBLIC_TELEGRAM_ENABLE_LOGIN_WIDGET === 'true';

type LinkMethod = 'deep_link' | 'widget';

function TelegramLinkPageContent() {
  const { isAuthenticated } = useAuth();
  const { data: links, mutate: refreshLinks } = usePlatformLinks();
  const [generating, setGenerating] = useState(false);
  const [deepLink, setDeepLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [waitingForBot, setWaitingForBot] = useState(false);
  const [unlinking, setUnlinking] = useState(false);
  const [linkMethod, setLinkMethod] = useState<LinkMethod>('deep_link');
  const [widgetLoading, setWidgetLoading] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const existingLink = links?.find(l => l.platform === 'telegram' && l.isActive);

  // Poll for link completion while waiting (deep-link flow)
  useEffect(() => {
    if (!waitingForBot) return;
    pollRef.current = setInterval(async () => {
      const updated = await refreshLinks();
      if (updated?.some(l => l.platform === 'telegram' && l.isActive)) {
        setWaitingForBot(false);
        setDeepLink(null);
      }
    }, POLL_INTERVAL_MS);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [waitingForBot, refreshLinks]);

  // Stop polling if link appeared
  useEffect(() => {
    if (existingLink && pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
      setWaitingForBot(false);
      setDeepLink(null);
    }
  }, [existingLink]);

  const handleGenerateToken = useCallback(async () => {
    setGenerating(true);
    setError(null);
    try {
      const result = await api.generateLinkToken('telegram');
      if (result.deepLink) {
        setDeepLink(result.deepLink);
        setWaitingForBot(true);
      }
    } catch (err) {
      setError((err as Error).message || 'Failed to generate link token');
    } finally {
      setGenerating(false);
    }
  }, []);

  const handleUnlink = useCallback(async () => {
    setUnlinking(true);
    setError(null);
    try {
      await api.unlinkPlatform('telegram');
      refreshLinks();
    } catch (err) {
      setError((err as Error).message || 'Failed to unlink');
    } finally {
      setUnlinking(false);
    }
  }, [refreshLinks]);

  // Telegram Login Widget callback handler
  const handleTelegramWidgetAuth = useCallback(async (telegramUser: Record<string, string>) => {
    setWidgetLoading(true);
    setError(null);
    try {
      await api.linkTelegramWidget(telegramUser);
      refreshLinks();
    } catch (err) {
      setError((err as Error).message || 'Failed to verify Telegram login');
    } finally {
      setWidgetLoading(false);
    }
  }, [refreshLinks]);

  // Mount Telegram Login Widget script
  const widgetRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ENABLE_LOGIN_WIDGET || linkMethod !== 'widget' || existingLink || !widgetRef.current) return;

    // Expose the callback on window
    (window as unknown as Record<string, unknown>).onBarrsaTelegramAuth = (user: Record<string, string>) => {
      handleTelegramWidgetAuth(user);
    };

    const script = document.createElement('script');
    script.src = 'https://telegram.org/js/telegram-widget.js?22';
    script.setAttribute('data-telegram-login', BOT_USERNAME);
    script.setAttribute('data-size', 'large');
    script.setAttribute('data-onauth', 'onBarrsaTelegramAuth(user)');
    script.setAttribute('data-request-access', 'write');
    script.async = true;

    // Clear previous widget if any
    widgetRef.current.innerHTML = '';
    widgetRef.current.appendChild(script);

    return () => {
      delete (window as unknown as Record<string, unknown>).onBarrsaTelegramAuth;
    };
  }, [linkMethod, existingLink, handleTelegramWidgetAuth]);

  const meta = existingLink?.platformMeta as Record<string, string> | undefined;

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
          <div className="w-10 h-10 rounded-xl bg-[#0088cc] flex items-center justify-center">
            <SiTelegram className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-foreground">Telegram</h1>
            <p className="text-sm text-muted-foreground">Link your Telegram account</p>
          </div>
        </div>

        {error && (
          <div className="mb-6 p-3 rounded-xl bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800/50 flex items-start gap-2 text-sm text-red-700 dark:text-red-400">
            <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
            {error}
          </div>
        )}

        {existingLink ? (
          <Card className="p-6 border border-emerald-200 dark:border-emerald-800/50 bg-emerald-50/50 dark:bg-emerald-950/20">
            <div className="flex items-start gap-4">
              <div className="w-12 h-12 rounded-xl bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center">
                <CheckCircle2 className="h-6 w-6 text-emerald-600" />
              </div>
              <div className="flex-1">
                <h2 className="text-lg font-semibold text-foreground">Telegram Linked</h2>
                <p className="text-sm text-muted-foreground mt-1">
                  Your Telegram account is connected. Send a message to our bot and it will be routed to your AI agent.
                </p>
                {meta && (
                  <div className="mt-3 text-sm text-muted-foreground space-y-1">
                    {meta.username && (
                      <p>Username: <span className="font-medium text-foreground">@{meta.username}</span></p>
                    )}
                    {meta.firstName && (
                      <p>Name: <span className="font-medium text-foreground">{meta.firstName}</span></p>
                    )}
                    <p>Linked: <span className="font-medium text-foreground">{new Date(existingLink.linkedAt).toLocaleDateString()}</span></p>
                    {(existingLink as Record<string, unknown>).lastSeenAt && (
                      <p className="flex items-center gap-1">
                        <Clock className="h-3 w-3" />
                        Last active: <span className="font-medium text-foreground">
                          {new Date((existingLink as Record<string, unknown>).lastSeenAt as string).toLocaleString()}
                        </span>
                      </p>
                    )}
                  </div>
                )}
                <div className="mt-4 flex gap-2">
                  <a href={`https://t.me/${BOT_USERNAME}`} target="_blank" rel="noopener noreferrer">
                    <Button variant="outline" size="sm" className="text-xs gap-1.5">
                      <ExternalLink className="h-3 w-3" />
                      Open Bot Chat
                    </Button>
                  </a>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-xs text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950/30"
                    onClick={handleUnlink}
                    disabled={unlinking}
                  >
                    {unlinking ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
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
                  { icon: <Zap className="h-4 w-4" />, title: 'Choose a linking method', desc: ENABLE_LOGIN_WIDGET ? 'Use the Telegram Login Widget for instant linking, or the deep-link flow' : 'Click "Link Telegram" to generate a one-time link' },
                  { icon: <MessageSquare className="h-4 w-4" />, title: 'Connect your account', desc: 'Your Telegram identity is securely verified and linked to your Barrsa account' },
                  { icon: <Shield className="h-4 w-4" />, title: 'Secure & private', desc: 'We only store your Telegram user ID for routing — no messages are stored on our servers' },
                ].map((step, i) => (
                  <div key={i} className="flex items-start gap-3">
                    <div className="w-8 h-8 rounded-lg bg-[#0088cc]/10 flex items-center justify-center text-[#0088cc] shrink-0">
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

            {/* Link method toggle (only if Login Widget is enabled) */}
            {ENABLE_LOGIN_WIDGET && (
              <div className="mb-6 flex gap-2">
                <button
                  onClick={() => setLinkMethod('deep_link')}
                  className={`flex-1 px-4 py-2 rounded-xl text-sm font-medium transition-colors ${
                    linkMethod === 'deep_link'
                      ? 'bg-[#0088cc] text-white'
                      : 'bg-muted text-muted-foreground hover:bg-muted/80'
                  }`}
                >
                  Deep Link
                </button>
                <button
                  onClick={() => setLinkMethod('widget')}
                  className={`flex-1 px-4 py-2 rounded-xl text-sm font-medium transition-colors ${
                    linkMethod === 'widget'
                      ? 'bg-[#0088cc] text-white'
                      : 'bg-muted text-muted-foreground hover:bg-muted/80'
                  }`}
                >
                  Login Widget
                </button>
              </div>
            )}

            {/* Link action */}
            <Card className="p-6 border border-border">
              <h2 className="text-base font-semibold text-foreground mb-4">
                {linkMethod === 'widget' ? 'Link via Telegram Login' : 'Link your Telegram account'}
              </h2>

              {linkMethod === 'widget' && ENABLE_LOGIN_WIDGET ? (
                <div className="flex flex-col items-center py-4 space-y-4">
                  {widgetLoading ? (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Verifying Telegram login...
                    </div>
                  ) : (
                    <>
                      <div ref={widgetRef} className="min-h-[44px]" />
                      <p className="text-xs text-muted-foreground text-center max-w-sm">
                        Click &quot;Log in with Telegram&quot; and authorize access.
                        Your account will be linked instantly.
                      </p>
                    </>
                  )}
                </div>
              ) : deepLink && waitingForBot ? (
                <div className="flex flex-col items-center py-4 space-y-4">
                  <a
                    href={deepLink}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-2 px-6 py-3 rounded-xl bg-[#0088cc] text-white font-medium hover:bg-[#006fa1] transition-colors"
                  >
                    <SiTelegram className="w-5 h-5" />
                    Open Telegram &amp; Start
                  </a>
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Waiting for you to press Start in Telegram...
                  </div>
                  <p className="text-xs text-muted-foreground text-center max-w-sm">
                    Click the button above, then press <strong>Start</strong> in the Telegram chat.
                    This page will update automatically once linked.
                  </p>
                </div>
              ) : (
                <div className="flex flex-col items-center py-4 space-y-4">
                  <Button
                    onClick={handleGenerateToken}
                    disabled={generating || !isAuthenticated}
                    className="gap-2 bg-[#0088cc] hover:bg-[#006fa1] text-white"
                    size="lg"
                  >
                    {generating ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <SiTelegram className="w-4 h-4" />
                    )}
                    Link Telegram
                  </Button>
                  <p className="text-xs text-muted-foreground text-center max-w-sm">
                    Generates a one-time link to our Telegram bot.
                    Press Start in Telegram to complete the connection.
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
            <li>Send messages to the bot — they go to your AI agent</li>
            <li>Get real-time AI replies in Telegram</li>
            <li>Use /agents to list and switch between your installed agents</li>
            <li>Use /new to start a fresh conversation</li>
            <li>Use /unlink to disconnect directly from Telegram</li>
            <li>Unlink anytime from this page or via /unlink in the bot</li>
          </ul>
        </Card>
      </div>
    </SidebarLayout>
  );
}

export default function TelegramLinkPage() {
  return (
    <Suspense>
      <TelegramLinkPageContent />
    </Suspense>
  );
}
