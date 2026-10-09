'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useRouter } from '@/lib/member-path';
import useSWR from 'swr';
import { toast } from 'sonner';
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
  Button,
  Badge,
  Skeleton,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui';
import { SidebarLayout, InboxSidebar } from '@/components/layout/sidebar';
import {
  Inbox as InboxIcon,
  Mail,
  ShieldCheck,
  Loader2,
  Plug,
  Trash2,
  AlertCircle,
  CheckCircle2,
  ArrowRight,
} from 'lucide-react';
import Link from '@/components/member-link';
import { SiGmail } from 'react-icons/si';
import { FaMicrosoft } from 'react-icons/fa6';
import type { InboxAccountSummary, InboxProvider } from '@/lib/inbox/types';

const fetcher = async (url: string) => {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${txt}`);
  }
  return res.json() as Promise<{ data: InboxAccountSummary[] }>;
};

const PROVIDER_META: Record<
  InboxProvider,
  {
    label: string;
    brand: string;
    Icon: React.ComponentType<{ className?: string }>;
    startUrl: string;
    comingSoon?: boolean;
  }
> = {
  gmail: {
    label: 'Gmail',
    brand: '#EA4335',
    Icon: ({ className }) => <SiGmail className={className} />,
    startUrl: '/api/inbox/oauth/gmail/start',
  },
  outlook: {
    label: 'Outlook',
    brand: '#0078D4',
    Icon: ({ className }) => <FaMicrosoft className={className} />,
    startUrl: '/api/inbox/oauth/outlook/start',
    comingSoon: true,
  },
};

export default function InboxPage() {
  return (
    <SidebarLayout sidebar={<InboxSidebar />}>
      <Suspense
        fallback={
          <div className="flex items-center justify-center min-h-[60vh]">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        }
      >
        <InboxContent />
      </Suspense>
    </SidebarLayout>
  );
}

function InboxContent() {
  const router = useRouter();
  const search = useSearchParams();
  const { data, error, isLoading, mutate } = useSWR('/api/inbox/accounts', fetcher, {
    revalidateOnFocus: false,
  });
  const accounts = data?.data ?? [];
  const [pendingDisconnect, setPendingDisconnect] = useState<InboxAccountSummary | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);

  // Surface OAuth callback flash messages
  useEffect(() => {
    const connected = search.get('connected');
    const err = search.get('error');
    if (connected) {
      toast.success(`${PROVIDER_META[connected as InboxProvider]?.label ?? connected} connected.`);
    }
    if (err) {
      toast.error(`Connection failed: ${err.replace(/_/g, ' ')}`);
    }
    if (connected || err) {
      const url = new URL(window.location.href);
      url.searchParams.delete('connected');
      url.searchParams.delete('error');
      router.replace(url.pathname + (url.search || ''), { scroll: false });
      mutate();
    }
  }, [search, router, mutate]);

  const handleConnect = useCallback((provider: InboxProvider) => {
    const meta = PROVIDER_META[provider];
    if (meta.comingSoon) {
      toast.info(`${meta.label} support is coming soon.`);
      return;
    }
    window.location.href = meta.startUrl;
  }, []);

  const handleDisconnect = useCallback(async () => {
    if (!pendingDisconnect) return;
    setDisconnecting(true);
    try {
      const res = await fetch(`/api/inbox/accounts?id=${encodeURIComponent(pendingDisconnect.id)}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      toast.success(`${pendingDisconnect.account_email} disconnected.`);
      setPendingDisconnect(null);
      mutate();
    } catch (err) {
      console.error('[inbox] disconnect failed', err);
      toast.error('Failed to disconnect account.');
    } finally {
      setDisconnecting(false);
    }
  }, [pendingDisconnect, mutate]);

  return (
    <div className="container max-w-5xl mx-auto py-8 px-4 sm:px-6 lg:px-8 space-y-8">
      <header className="space-y-2">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-xl bg-primary/10 text-primary flex items-center justify-center">
            <InboxIcon className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Inbox</h1>
            <p className="text-sm text-muted-foreground">
              Connect your email accounts so maava can triage, draft, and (with your approval) act on messages.
            </p>
          </div>
        </div>
      </header>

      {/* Connect a new account */}
      <section className="grid gap-4 sm:grid-cols-2">
        {(Object.keys(PROVIDER_META) as InboxProvider[]).map((p) => (
          <ConnectProviderCard key={p} provider={p} onConnect={handleConnect} />
        ))}
      </section>

      {/* Connected accounts */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Connected accounts</h2>
          {!isLoading && accounts.length > 0 && (
            <Badge variant="secondary">{accounts.length} active</Badge>
          )}
        </div>

        {isLoading && (
          <div className="space-y-3">
            <Skeleton className="h-24 w-full rounded-xl" />
            <Skeleton className="h-24 w-full rounded-xl" />
          </div>
        )}

        {error && !isLoading && (
          <Card className="border-destructive/40">
            <CardContent className="pt-6 flex items-center gap-3 text-destructive">
              <AlertCircle className="h-5 w-5" />
              <span className="text-sm">Failed to load inbox accounts. Try refreshing.</span>
            </CardContent>
          </Card>
        )}

        {!isLoading && !error && accounts.length === 0 && <InboxEmptyState />}

        {!isLoading && accounts.length > 0 && (
          <div className="grid gap-3">
            {accounts.map((acct) => (
              <ConnectedAccountCard
                key={acct.id}
                account={acct}
                onDisconnect={() => setPendingDisconnect(acct)}
              />
            ))}
          </div>
        )}
      </section>

      {/* AI policy note */}
      <section>
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-primary" />
              AI handling policy
            </CardTitle>
            <CardDescription>
              Every connected account starts in <strong>Approval required</strong> mode. The agent can read
              and draft but never sends, deletes, or forwards without your explicit approval. Per-account
              policy controls (autonomy level, action limits, label rules) ship in the next release.
            </CardDescription>
          </CardHeader>
        </Card>
      </section>

      <DisconnectDialog
        account={pendingDisconnect}
        loading={disconnecting}
        onCancel={() => (disconnecting ? null : setPendingDisconnect(null))}
        onConfirm={handleDisconnect}
      />
    </div>
  );
}

function ConnectProviderCard({
  provider,
  onConnect,
}: {
  provider: InboxProvider;
  onConnect: (p: InboxProvider) => void;
}) {
  const meta = PROVIDER_META[provider];
  const disabled = !!meta.comingSoon;
  return (
    <Card className="hover:border-primary/40 transition-colors">
      <CardHeader>
        <div className="flex items-center gap-3">
          <div
            className="h-10 w-10 rounded-xl flex items-center justify-center text-white"
            style={{ backgroundColor: meta.brand }}
          >
            <meta.Icon className="h-5 w-5" />
          </div>
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <CardTitle className="text-base">{meta.label}</CardTitle>
              {disabled ? (
                <Badge variant="secondary" className="text-[10px] uppercase tracking-wide">
                  Coming soon
                </Badge>
              ) : null}
            </div>
            <CardDescription>
              Read, draft, and (with approval) send mail from your {meta.label} account.
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardFooter>
        <Button
          onClick={() => onConnect(provider)}
          className="gap-2"
          disabled={disabled}
          title={disabled ? `${meta.label} support is coming soon` : undefined}
        >
          <Plug className="h-4 w-4" />
          {disabled ? `${meta.label} — Coming soon` : `Connect ${meta.label}`}
        </Button>
      </CardFooter>
    </Card>
  );
}

function ConnectedAccountCard({
  account,
  onDisconnect,
}: {
  account: InboxAccountSummary;
  onDisconnect: () => void;
}) {
  const meta = PROVIDER_META[account.provider];
  return (
    <Card>
      <CardContent className="pt-6 flex items-center gap-4">
        <div
          className="h-10 w-10 rounded-xl flex items-center justify-center text-white shrink-0"
          style={{ backgroundColor: meta.brand }}
        >
          <meta.Icon className="h-5 w-5" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <p className="font-medium truncate">{account.account_email}</p>
            {account.status === 'active' && (
              <Badge variant="secondary" className="gap-1">
                <CheckCircle2 className="h-3 w-3 text-emerald-500" />
                Active
              </Badge>
            )}
            {account.status === 'error' && (
              <Badge variant="destructive" className="gap-1">
                <AlertCircle className="h-3 w-3" />
                Needs attention
              </Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">
            {meta.label} • policy: <span className="font-medium">{account.policy.mode.replace(/_/g, ' ')}</span>
          </p>
          {account.last_error && (
            <p className="text-xs text-destructive mt-1 truncate">{account.last_error}</p>
          )}
        </div>
        {account.provider === 'gmail' && account.status === 'active' && (
          <Button variant="outline" size="sm" asChild className="gap-1.5">
            <Link href={`/inbox/${account.id}`}>
              Open mailbox
              <ArrowRight className="h-4 w-4" />
            </Link>
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          onClick={onDisconnect}
          className="text-destructive hover:text-destructive gap-1.5"
        >
          <Trash2 className="h-4 w-4" />
          Disconnect
        </Button>
      </CardContent>
    </Card>
  );
}

function InboxEmptyState() {
  return (
    <Card className="border-dashed">
      <CardContent className="pt-10 pb-10 flex flex-col items-center text-center space-y-3">
        <div className="h-12 w-12 rounded-2xl bg-muted flex items-center justify-center">
          <Mail className="h-6 w-6 text-muted-foreground" />
        </div>
        <div>
          <p className="font-medium">No inboxes connected yet</p>
          <p className="text-sm text-muted-foreground mt-1">
            Connect Gmail or Outlook above to let maava help with your email.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

function DisconnectDialog({
  account,
  loading,
  onCancel,
  onConfirm,
}: {
  account: InboxAccountSummary | null;
  loading: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={!!account} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Disconnect this inbox?</DialogTitle>
          <DialogDescription>
            maava will lose access to <strong>{account?.account_email}</strong>. Stored tokens will be
            revoked from this dashboard. You can reconnect at any time.
          </DialogDescription>
        </DialogHeader>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={onCancel} disabled={loading}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={onConfirm} disabled={loading} className="gap-2">
            {loading && <Loader2 className="h-4 w-4 animate-spin" />}
            Disconnect
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
