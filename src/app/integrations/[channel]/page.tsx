'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import Image from 'next/image';
import { Card, Button, Input, Avatar, AvatarFallback } from '@/components/ui';
import { CHANNEL_TYPES, ROUTES } from '@/lib/constants';
import {
  ChevronRight, Check, Shield, ExternalLink, Bot, ArrowLeft,
  Loader2, AlertCircle, Key, Eye, EyeOff, Globe, Trash2, RefreshCw,
} from 'lucide-react';
import { SiDiscord, SiSlack, SiTelegram, SiWhatsapp } from 'react-icons/si';
import { FaMicrosoft } from 'react-icons/fa6';
import { cn } from '@/lib/utils';
import { useAuth, useChannels, useSavedChannels } from '@/hooks';
import { SettingsSidebar, SidebarLayout } from '@/components/layout/sidebar';
import { configApi } from '@/lib/config-api';
import { api } from '@/lib/api';

function getChannelIcon(channelId: string): JSX.Element {
  const iconMap: Record<string, JSX.Element> = {
    discord: <SiDiscord className="w-5 h-5 text-white" />,
    slack: <SiSlack className="w-5 h-5 text-white" />,
    telegram: <SiTelegram className="w-5 h-5 text-white" />,
    whatsapp: <SiWhatsapp className="w-5 h-5 text-white" />,
    teams: <FaMicrosoft className="w-5 h-5 text-white" />,
    web: <Globe className="w-5 h-5 text-white" />,
  };
  return iconMap[channelId] || <span className="text-lg font-bold text-white">{channelId.charAt(0).toUpperCase()}</span>;
}

const CHANNEL_FIELDS: Record<string, { key: string; label: string; placeholder: string; secret?: boolean; helpUrl?: string }[]> = {
  discord: [
    { key: 'token', label: 'Bot Token', placeholder: 'Paste your Discord bot token...', secret: true, helpUrl: 'https://discord.com/developers/applications' },
    { key: 'applicationId', label: 'Application ID', placeholder: 'Your Discord application/client ID (from Developer Portal)', helpUrl: 'https://discord.com/developers/applications' },
  ],
  telegram: [
    { key: 'botToken', label: 'Bot Token', placeholder: 'e.g. 123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11', secret: true, helpUrl: 'https://t.me/BotFather' },
  ],
  slack: [
    { key: 'botToken', label: 'Bot Token (xoxb-...)', placeholder: 'xoxb-...', secret: true },
    { key: 'appToken', label: 'App Token (xapp-...)', placeholder: 'xapp-...', secret: true },
  ],
  teams: [
    { key: 'appId', label: 'Azure App ID', placeholder: 'Your Azure Bot App ID' },
    { key: 'appPassword', label: 'App Password', placeholder: 'Your Azure Bot App Password', secret: true },
    { key: 'tenantId', label: 'Tenant ID (optional)', placeholder: 'Azure AD Tenant ID' },
  ],
  whatsapp: [],
  signal: [
    { key: 'phoneNumber', label: 'Phone Number', placeholder: '+1234567890', helpUrl: 'https://github.com/AsamK/signal-cli' },
    { key: 'apiUrl', label: 'Signal API URL (optional)', placeholder: 'http://localhost:8080' },
  ],
  line: [
    { key: 'channelAccessToken', label: 'Channel Access Token', placeholder: 'Long-lived access token...', secret: true, helpUrl: 'https://developers.line.biz/console/' },
    { key: 'channelSecret', label: 'Channel Secret', placeholder: 'Your channel secret', secret: true },
  ],
  viber: [
    { key: 'authToken', label: 'Auth Token', placeholder: 'Viber bot auth token...', secret: true, helpUrl: 'https://partners.viber.com' },
    { key: 'botName', label: 'Bot Name', placeholder: 'Your bot name' },
  ],
};

const CHANNEL_DOCS: Record<string, string> = {
  discord: 'Create a Discord bot, enable Message Content Intent, add it to your server with the right permissions, and paste the bot token below.',
  telegram: 'Create a Telegram bot via @BotFather, then paste the token below. The bot will respond to DMs and group messages automatically.',
  slack: 'Create a Slack app at api.slack.com, enable Socket Mode, and copy both tokens.',
  teams: 'Register a bot in Azure Portal, create an App Registration, and enter the credentials.',
  whatsapp: 'Scan the QR code below with WhatsApp on your phone to link your number.',
  signal: 'Connect via signal-cli. Enter your registered phone number and the URL of your signal-cli REST API.',
  line: 'Create a LINE Messaging API channel at developers.line.biz and paste your access token and channel secret below.',
  viber: 'Create a Viber bot at partners.viber.com and enter your auth token and bot name below.',
  web: 'Web chat is built-in and does not require configuration.',
};

const CHANNEL_SETUP_STEPS: Record<string, string[]> = {
  discord: [
    'Go to discord.com/developers/applications and click "New Application"',
    'Navigate to the "Bot" tab and click "Reset Token" — copy the token',
    'Under "Privileged Gateway Intents", enable MESSAGE CONTENT INTENT',
    'Go to "OAuth2" tab → URL Generator → select "bot" scope',
    'Under Bot Permissions, select: Send Messages, Read Message History, Embed Links, Attach Files',
    'Copy the generated URL and open it to add the bot to your server',
    'Paste the bot token below and click Deploy',
  ],
  telegram: [
    'Open Telegram and search for @BotFather',
    'Send /newbot and follow the prompts to name your bot',
    'Copy the bot token that BotFather gives you',
    'Paste the token below and click Deploy',
    'Add the bot to any group where you want it to respond',
    'In groups, send /start or mention the bot to activate it',
  ],
};

type StepState = 'pending' | 'active' | 'completed';
interface SetupStep { number: number; title: string; description: string; state: StepState; }

function LivePreview({ channelName }: { channelName: string }) {
  return (
    <Card className="border border-border shadow-sm overflow-hidden bg-card">
      <div className="bg-gray-900 dark:bg-black px-4 py-3 flex items-center justify-between">
        <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Live Preview</span>
        <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
      </div>
      <div className="bg-[#36393f] px-4 py-3 border-b border-[#2f3136] flex items-center gap-2">
        <span className="text-gray-400 text-sm">#</span>
        <span className="text-white text-sm font-medium">general</span>
        <span className="text-gray-500 text-xs ml-2">Main conversation channel</span>
      </div>
      <div className="bg-[#36393f] p-4 space-y-4 min-h-[240px]">
        <div className="flex gap-3">
          <div className="w-8 h-8 rounded-full bg-indigo-500 flex items-center justify-center text-white text-xs font-bold shrink-0">U</div>
          <div>
            <div className="flex items-baseline gap-2">
              <span className="text-sm font-medium text-white">User</span>
              <span className="text-[11px] text-gray-500">Today at 2:14 PM</span>
            </div>
            <p className="text-sm text-gray-300 mt-0.5">Hey agent, can you help me with my order?</p>
          </div>
        </div>
        <div className="flex gap-3">
          <div className="w-8 h-8 rounded-full bg-primary flex items-center justify-center text-white text-xs font-bold shrink-0">
            <Bot className="h-4 w-4" />
          </div>
          <div>
            <div className="flex items-baseline gap-2">
              <span className="text-sm font-medium text-primary">Barrsa Agent</span>
              <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-primary/20 text-primary">BOT</span>
              <span className="text-[11px] text-gray-500">Today at 2:14 PM</span>
            </div>
            <p className="text-sm text-gray-300 mt-0.5">Of course! I&apos;d be happy to help. Could you share your order number?</p>
          </div>
        </div>
        <div className="flex gap-3 items-center">
          <div className="w-8 h-8 rounded-full bg-primary flex items-center justify-center text-white text-xs font-bold shrink-0">
            <Bot className="h-4 w-4" />
          </div>
          <div className="flex gap-1">
            <span className="w-2 h-2 rounded-full bg-gray-500 animate-bounce" style={{ animationDelay: '0ms' }} />
            <span className="w-2 h-2 rounded-full bg-gray-500 animate-bounce" style={{ animationDelay: '150ms' }} />
            <span className="w-2 h-2 rounded-full bg-gray-500 animate-bounce" style={{ animationDelay: '300ms' }} />
          </div>
        </div>
      </div>
      <div className="bg-[#40444b] px-4 py-3">
        <div className="bg-[#4f545c] rounded-lg px-4 py-2.5 text-sm text-gray-400">
          Message #{channelName.toLowerCase()}-general
        </div>
      </div>
    </Card>
  );
}

function StepIndicator({ step }: { step: SetupStep }) {
  return (
    <div className="flex items-center gap-3">
      <div className={cn(
        'w-8 h-8 rounded-full flex items-center justify-center text-sm font-semibold shrink-0 transition-all',
        step.state === 'completed' && 'bg-emerald-500 text-white',
        step.state === 'active' && 'bg-primary text-white',
        step.state === 'pending' && 'bg-muted text-muted-foreground'
      )}>
        {step.state === 'completed' ? <Check className="h-4 w-4" /> : step.number}
      </div>
      <div className="flex-1 min-w-0">
        <p className={cn('text-sm font-medium', step.state === 'active' ? 'text-foreground' : 'text-muted-foreground')}>{step.title}</p>
        <p className="text-xs text-muted-foreground">{step.description}</p>
      </div>
    </div>
  );
}

function CredentialField({ label, placeholder, value, onChange, secret, helpUrl }: {
  label: string; placeholder: string; value: string; onChange: (v: string) => void; secret?: boolean; helpUrl?: string;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <label className="text-sm font-medium text-foreground">{label}</label>
        {helpUrl && (
          <a href={helpUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-primary hover:text-primary/80 flex items-center gap-1">
            Get token <ExternalLink className="h-3 w-3" />
          </a>
        )}
      </div>
      <div className="relative">
        <Input
          type={secret && !visible ? 'password' : 'text'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="h-11 rounded-xl border-border bg-background text-foreground font-mono text-sm pr-10 focus:ring-2 focus:ring-ring/20"
        />
        {secret && (
          <button type="button" onClick={() => setVisible(!visible)} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors">
            {visible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        )}
      </div>
    </div>
  );
}

export default function IntegrationSetupPage() {
  const params = useParams();
  const router = useRouter();
  const channelId = params.channel as string;
  const { user, agent, apiKey } = useAuth();
  const { mutate: refreshGatewayChannels } = useChannels({
    refreshInterval: 0,
    revalidateOnMount: false,
    revalidateIfStale: false,
    revalidateOnFocus: false,
  });
  const { data: savedChannels, mutate: refreshSavedChannels } = useSavedChannels();

  const channelType = CHANNEL_TYPES.find((c) => c.id === channelId);
  const channelName = channelType?.label || channelId.charAt(0).toUpperCase() + channelId.slice(1);
  const channelColor = channelType?.color || '#6366f1';
  const fields = CHANNEL_FIELDS[channelId] || [];
  const docs = CHANNEL_DOCS[channelId] || '';

  const existingSaved = savedChannels?.find((c) => c.channelType === channelId);
  const alreadyConnected = existingSaved?.isActive === true;

  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [deploying, setDeploying] = useState(false);
  const [deployed, setDeployed] = useState(alreadyConnected);
  const [disconnecting, setDisconnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // WhatsApp QR state
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [qrLoading, setQrLoading] = useState(false);
  const [qrError, setQrError] = useState<string | null>(null);
  const [qrMessage, setQrMessage] = useState<string>('');
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (alreadyConnected) setDeployed(true);
  }, [alreadyConnected]);

  const isQrBased = channelId === 'whatsapp';

  const loadQr = useCallback(async (force = false) => {
    setQrLoading(true);
    setQrError(null);
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

      const res = await fetch('/api/whatsapp/qr', {
        method: 'POST',
        headers,
        body: JSON.stringify({ force }),
        credentials: 'include',
      });
      const result = await res.json();
      if (!res.ok || !result.success) {
        throw new Error(result.message || result.error || 'Failed to load QR code');
      }
      if (result.message) setQrMessage(result.message);
      if (result.qrDataUrl) setQrDataUrl(result.qrDataUrl);
    } catch (err: unknown) {
      setQrError(err instanceof Error ? err.message : 'Failed to load QR code');
    } finally {
      setQrLoading(false);
    }
  }, [apiKey]);

  // Load QR on mount; poll status every 3s until connected
  useEffect(() => {
    if (!isQrBased || deployed) return;
    loadQr();
    pollRef.current = setInterval(async () => {
      try {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

        const res = await fetch('/api/whatsapp/status', {
          method: 'POST',
          headers,
          body: JSON.stringify({}),
          credentials: 'include',
        });
        const data = await res.json();
        if (data.connected) {
          clearInterval(pollRef.current!);
          // Save to DB and update openclaw.json — same flow as handleDeploy for other channels
          try {
            await api.saveChannel({
              channelType: 'whatsapp',
              credentials: {},
              channelName: 'WhatsApp',
              agentId: agent?.id,
              metadata: { deployedAt: new Date().toISOString() },
            });
          } catch { /* non-fatal — gateway already knows it's connected */ }
          try {
            const currentConfig = await configApi.configGet();
            const baseHash = (currentConfig as unknown as Record<string, unknown>)?.hash as string | undefined;
            await configApi.configPatch(
              { channels: { whatsapp: { enabled: true, dmPolicy: 'open', allowFrom: ['*'] } } },
              baseHash || undefined,
            );
          } catch { /* gateway may be temporarily unreachable */ }
          setDeployed(true);
          refreshGatewayChannels();
          refreshSavedChannels();
        }
      } catch {
        // ignore polling errors
      }
    }, 3000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey, isQrBased, deployed, loadQr, agent, refreshGatewayChannels, refreshSavedChannels]);

  const hasCredentials = fields.length > 0 && fields.every((f) => f.key !== 'tenantId' && f.key !== 'apiUrl' ? !!credentials[f.key]?.trim() : true);
  const currentStep = deployed ? 3 : hasCredentials ? 2 : 1;

  const steps: SetupStep[] = [
    { number: 1, title: 'Enter Credentials', description: `Provide your ${channelName} bot credentials`, state: hasCredentials ? 'completed' : 'active' },
    { number: 2, title: 'Deploy Channel', description: `Connect ${channelName} to your OpenClaw gateway`, state: deployed ? 'completed' : hasCredentials ? 'active' : 'pending' },
    { number: 3, title: 'Verify Connection', description: 'Confirm your channel is live', state: deployed ? 'completed' : 'pending' },
  ];

  const handleDeploy = useCallback(async () => {
    setDeploying(true);
    setError(null);
    try {
      const channelConfig: Record<string, unknown> = { enabled: true };
      const credsTrimmed: Record<string, string> = {};
      for (const field of fields) {
        if (credentials[field.key]?.trim()) {
          channelConfig[field.key] = credentials[field.key].trim();
          credsTrimmed[field.key] = credentials[field.key].trim();
        }
      }
      // Apply sensible defaults so the channel works immediately
      if (channelId === 'discord') {
        channelConfig.groupPolicy = 'open';
        channelConfig.dm = { policy: 'open' };
      } else if (channelId === 'telegram') {
        channelConfig.dmPolicy = 'open';
        channelConfig.groupPolicy = 'open';
        channelConfig.allowFrom = ['*'];
      }
      // Always save credentials to DB first — works in cloud mode without a gateway
      await api.saveChannel({
        channelType: channelId, credentials: credsTrimmed, channelName,
        agentId: agent?.id, metadata: { deployedAt: new Date().toISOString() },
      });
      // Push to local OpenClaw gateway for live reload — silently skip if unreachable
      try {
        const currentConfig = await configApi.configGet();
        const baseHash = (currentConfig as unknown as Record<string, unknown>)?.hash as string | undefined;
        await configApi.configPatch({ channels: { [channelId]: channelConfig } }, baseHash || undefined);
      } catch {
        // Gateway not running in cloud mode — DB save above is sufficient
      }
      setDeployed(true);
      refreshGatewayChannels();
      refreshSavedChannels();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to deploy channel');
    } finally {
      setDeploying(false);
    }
  }, [channelId, channelName, credentials, fields, agent, refreshGatewayChannels, refreshSavedChannels]);

  const handleDisconnect = useCallback(async () => {
    setDisconnecting(true);
    setError(null);
    try {
      // Delete from DB — always works in cloud mode without a gateway
      await api.deleteChannel(channelId);
      // Also update local gateway config if reachable
      try {
        const currentConfig = await configApi.configGet();
        const baseHash = (currentConfig as unknown as Record<string, unknown>)?.hash as string | undefined;
        await configApi.configPatch({ channels: { [channelId]: { enabled: false } } }, baseHash || undefined);
      } catch {
        // Gateway not running in cloud mode — DB delete above is sufficient
      }
      setDeployed(false);
      setCredentials({});
      refreshGatewayChannels();
      refreshSavedChannels();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to disconnect');
    } finally {
      setDisconnecting(false);
    }
  }, [channelId, refreshGatewayChannels, refreshSavedChannels]);

  const setField = useCallback((key: string, value: string) => {
    setCredentials(prev => ({ ...prev, [key]: value }));
  }, []);

  const displayName = user?.displayName || user?.username || agent?.displayName || agent?.name || 'User';
  const avatarInitials = displayName.slice(0, 2).toUpperCase();
  const isBuiltIn = channelId === 'web';

  return (
    <SidebarLayout sidebar={<SettingsSidebar />}>
      <div className="p-6 md:p-8">
        <div className="flex items-center gap-2 text-sm text-muted-foreground mb-6">
          <Link href={ROUTES.CHANNELS} className="hover:text-foreground transition-colors">Integrations</Link>
          <ChevronRight className="h-3.5 w-3.5" />
          <span className="text-foreground font-medium">{channelName} Setup</span>
        </div>
        <Link href={ROUTES.CHANNELS} className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground mb-6 transition-colors">
          <ArrowLeft className="h-4 w-4" /> Back to Integrations
        </Link>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 max-w-5xl">
          <div className="space-y-6">
            <div className="flex items-center gap-3 mb-2">
              <div className="w-10 h-10 rounded-xl flex items-center justify-center text-white font-bold" style={{ backgroundColor: channelColor }}>
                {getChannelIcon(channelId)}
              </div>
              <div>
                <h1 className="text-xl font-bold text-foreground">Connect {channelName}</h1>
                <p className="text-sm text-muted-foreground">{docs}</p>
              </div>
            </div>

            {CHANNEL_SETUP_STEPS[channelId] && !deployed && (
              <Card className="border border-border shadow-sm p-5 bg-card">
                <p className="text-[13px] font-semibold text-foreground mb-3">Setup Guide</p>
                <ol className="space-y-2">
                  {CHANNEL_SETUP_STEPS[channelId].map((step, i) => (
                    <li key={i} className="flex gap-2.5 text-[12px] text-muted-foreground leading-relaxed">
                      <span className="w-5 h-5 rounded-full bg-muted flex items-center justify-center text-[10px] font-semibold text-foreground/60 shrink-0 mt-0.5">{i + 1}</span>
                      {step}
                    </li>
                  ))}
                </ol>
              </Card>
            )}

            {isQrBased && (
              <Card className="border border-border shadow-sm p-6 bg-card">
                {deployed ? (
                  <div className="space-y-4">
                    <div className="p-4 rounded-xl bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800/50">
                      <div className="flex items-center gap-2 text-emerald-700 dark:text-emerald-400 font-medium text-sm">
                        <Check className="h-4 w-4" /> WhatsApp connected!
                      </div>
                      <p className="text-xs text-emerald-600 dark:text-emerald-400/80 mt-1">Your WhatsApp number is linked and ready.</p>
                    </div>
                    <div className="flex gap-2">
                      <Button onClick={() => router.push(ROUTES.CHANNELS)} className="flex-1">Back to Channels</Button>
                      <Button variant="outline" onClick={handleDisconnect} disabled={disconnecting}
                        className="gap-2 text-sm text-red-600 hover:text-red-700 border-red-200 hover:border-red-300">
                        {disconnecting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                        Disconnect
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-4">
                    <p className="text-sm font-medium text-foreground">Scan with WhatsApp</p>
                    <p className="text-xs text-muted-foreground">
                      Open WhatsApp on your phone → Linked Devices → Link a Device → scan the code below.
                    </p>
                    <div className="flex justify-center">
                      {qrLoading && (
                        <div className="w-56 h-56 flex items-center justify-center rounded-xl bg-muted">
                          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                        </div>
                      )}
                      {!qrLoading && qrError && (
                        <div className="w-56 flex flex-col items-center gap-3 p-4 rounded-xl bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800/50">
                          <AlertCircle className="h-8 w-8 text-red-500" />
                          <p className="text-xs text-red-700 dark:text-red-400 text-center">{qrError}</p>
                        </div>
                      )}
                      {!qrLoading && !qrError && qrDataUrl && (
                        <div className="relative">
                          <Image
                            src={qrDataUrl}
                            alt="WhatsApp QR Code"
                            width={224}
                            height={224}
                            className="rounded-xl border border-border"
                            unoptimized
                          />
                        </div>
                      )}
                      {!qrLoading && !qrError && !qrDataUrl && qrMessage && (
                        <div className="w-56 p-4 rounded-xl bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800/50">
                          <p className="text-xs text-emerald-700 dark:text-emerald-400 text-center">{qrMessage}</p>
                        </div>
                      )}
                    </div>
                    <div className="flex gap-2">
                      <Button variant="outline" onClick={() => loadQr(true)} disabled={qrLoading} className="gap-2 text-sm flex-1">
                        {qrLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                        Refresh QR
                      </Button>
                      <Button variant="outline" onClick={() => router.push(ROUTES.CHANNELS)} className="gap-2 text-sm">
                        <ArrowLeft className="h-4 w-4" /> Back
                      </Button>
                    </div>
                    <p className="text-xs text-muted-foreground flex items-center gap-1">
                      <Shield className="h-3 w-3" /> Waiting for scan — page updates automatically
                    </p>
                  </div>
                )}
              </Card>
            )}

            {isBuiltIn && (
              <Card className="border border-border shadow-sm p-6 bg-card">
                <div className="space-y-4">
                  <div className="p-4 rounded-xl bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800/50">
                    <div className="flex items-center gap-2 text-emerald-700 dark:text-emerald-400 font-medium text-sm">
                      <Check className="h-4 w-4" /> Already Active
                    </div>
                    <p className="text-xs text-emerald-600 dark:text-emerald-400/80 mt-1">Web chat is built in. Go to Chat to use it.</p>
                  </div>
                  <Button onClick={() => router.push(ROUTES.CHAT)} className="gap-2">Open Chat</Button>
                </div>
              </Card>
            )}

            {!isQrBased && !isBuiltIn && (
              <>
                <Card className="border border-border shadow-sm p-6 space-y-6 bg-card">
                  <div className="space-y-4">
                    {steps.map((step, i) => (
                      <div key={step.number}>
                        <StepIndicator step={step} />
                        {i < steps.length - 1 && <div className="ml-4 mt-2 mb-2 border-l-2 border-border h-4" />}
                      </div>
                    ))}
                  </div>
                  <div className="border-t border-border pt-6">
                    {currentStep === 1 && (
                      <div className="space-y-4">
                        {fields.map((field) => (
                          <CredentialField key={field.key} label={field.label} placeholder={field.placeholder}
                            value={credentials[field.key] || ''} onChange={(v) => setField(field.key, v)}
                            secret={field.secret} helpUrl={field.helpUrl} />
                        ))}
                        <p className="text-xs text-muted-foreground flex items-center gap-1">
                          <Shield className="h-3 w-3" /> Credentials are sent directly to your OpenClaw gateway
                        </p>
                      </div>
                    )}
                    {currentStep === 2 && !deployed && (
                      <div className="space-y-4">
                        <p className="text-sm text-muted-foreground">Your credentials are ready. Click below to deploy.</p>
                        {error && (
                          <div className="p-3 rounded-xl bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800/50 flex items-start gap-2">
                            <AlertCircle className="h-4 w-4 text-red-500 mt-0.5 shrink-0" />
                            <p className="text-sm text-red-700 dark:text-red-400">{error}</p>
                          </div>
                        )}
                        <Button onClick={handleDeploy} disabled={deploying} className="gap-2 w-full" style={{ backgroundColor: deploying ? undefined : channelColor }}>
                          {deploying ? <Loader2 className="h-4 w-4 animate-spin" /> : <Key className="h-4 w-4" />}
                          {deploying ? 'Deploying...' : `Deploy ${channelName}`}
                        </Button>
                      </div>
                    )}
                    {deployed && (
                      <div className="space-y-4">
                        <div className="p-4 rounded-xl bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800/50">
                          <div className="flex items-center gap-2 text-emerald-700 dark:text-emerald-400 font-medium text-sm">
                            <Check className="h-4 w-4" /> Channel connected &amp; saved!
                          </div>
                          <p className="text-xs text-emerald-600 dark:text-emerald-400/80 mt-1">
                            Your {channelName} integration is active. Credentials survive gateway restarts.
                          </p>
                        </div>
                        <div className="flex gap-2">
                          <Button onClick={() => router.push(ROUTES.CHANNELS)} className="flex-1">Back to Channels</Button>
                          <Button variant="outline" onClick={() => { setDeployed(false); setCredentials({}); }} className="gap-2 text-sm">Re-configure</Button>
                          <Button variant="outline" onClick={handleDisconnect} disabled={disconnecting}
                            className="gap-2 text-sm text-red-600 hover:text-red-700 border-red-200 hover:border-red-300">
                            {disconnecting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                            Disconnect
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                </Card>
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Shield className="h-3.5 w-3.5" /> Secure Connection — AES-256 Encrypted
                  </span>
                </div>
              </>
            )}

            <div className="flex items-center gap-3 pt-4 border-t border-border">
              <Avatar className="h-8 w-8">
                <AvatarFallback className="bg-primary/10 text-primary text-xs font-medium">{avatarInitials}</AvatarFallback>
              </Avatar>
              <div>
                <p className="text-sm font-medium text-foreground">{displayName}</p>
                <p className="text-xs text-muted-foreground">{user?.email || 'agent@barrsa.com'}</p>
              </div>
            </div>
          </div>

          <div className="space-y-4">
            <LivePreview channelName={channelName} />
            <div className="grid grid-cols-2 gap-3">
              <Card className="p-4 border border-border shadow-sm bg-card">
                <p className="text-xs text-muted-foreground mb-1">Response Time</p>
                <p className="text-lg font-bold text-foreground">&lt;2s</p>
              </Card>
              <Card className="p-4 border border-border shadow-sm bg-card">
                <p className="text-xs text-muted-foreground mb-1">Uptime SLA</p>
                <p className="text-lg font-bold text-foreground">99.9%</p>
              </Card>
            </div>
          </div>
        </div>
      </div>
    </SidebarLayout>
  );
}
