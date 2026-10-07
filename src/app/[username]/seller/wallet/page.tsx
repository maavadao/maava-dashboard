'use client';

import { useEffect, useState, useCallback } from 'react';
import { Card, Button, Skeleton } from '@/components/ui';
import {
  Wallet, ArrowUpRight, ArrowDownLeft, RefreshCcw, Link2,
  AlertCircle, Loader2, CheckCircle2, XCircle, Clock, Shield,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { api } from '@/lib/api';
import type { WalletSettings, WalletPendingAction, WalletBalanceEntry, WalletAuditLog } from '@/types';

type Tab = 'overview' | 'actions' | 'history';

export default function WalletPage() {
  const [tab, setTab] = useState<Tab>('overview');
  const [settings, setSettings] = useState<WalletSettings | null>(null);
  const [balances, setBalances] = useState<WalletBalanceEntry[]>([]);
  const [actions, setActions] = useState<WalletPendingAction[]>([]);
  const [auditLogs, setAuditLogs] = useState<WalletAuditLog[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [connectKey, setConnectKey] = useState('');
  const [isConnecting, setIsConnecting] = useState(false);
  const [actionLoadingId, setActionLoadingId] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const walletSettings = await api.getWalletSettings();
      setSettings(walletSettings);

      if (walletSettings?.isConnected) {
        const [bal, acts, logs] = await Promise.all([
          api.getWalletBalances().catch(() => []),
          api.listWalletActions({ status: 'pending' }).catch(() => []),
          api.getWalletAuditLogs({ limit: 20 }).catch(() => []),
        ]);
        setBalances(Array.isArray(bal) ? bal : []);
        setActions(acts);
        setAuditLogs(logs);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load wallet data');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const handleConnect = useCallback(async () => {
    if (!connectKey.trim()) return;
    setIsConnecting(true);
    setError(null);
    try {
      const updated = await api.connectWallet(connectKey.trim());
      setSettings(updated);
      setConnectKey('');
      void loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to connect wallet');
    } finally {
      setIsConnecting(false);
    }
  }, [connectKey, loadData]);

  const handleDisconnect = useCallback(async () => {
    try {
      const updated = await api.disconnectWallet();
      setSettings(updated);
      setBalances([]);
      setActions([]);
      setAuditLogs([]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to disconnect wallet');
    }
  }, []);

  const handleApprove = useCallback(async (actionId: string) => {
    setActionLoadingId(actionId);
    try {
      const updated = await api.approveWalletAction(actionId);
      setActions((prev) => prev.map((a) => (a.id === actionId ? updated : a)).filter((a) => a.status === 'pending'));
    } catch {
      // silent
    } finally {
      setActionLoadingId(null);
    }
  }, []);

  const handleReject = useCallback(async (actionId: string) => {
    setActionLoadingId(actionId);
    try {
      const updated = await api.rejectWalletAction(actionId, 'Rejected by user');
      setActions((prev) => prev.map((a) => (a.id === actionId ? updated : a)).filter((a) => a.status === 'pending'));
    } catch {
      // silent
    } finally {
      setActionLoadingId(null);
    }
  }, []);

  const tabs: { value: Tab; label: string }[] = [
    { value: 'overview', label: 'Overview' },
    { value: 'actions', label: `Pending${actions.length ? ` (${actions.length})` : ''}` },
    { value: 'history', label: 'History' },
  ];

  // ─── Not connected state ──────────────────────────────────────────

  if (!isLoading && (!settings || !settings.isConnected)) {
    return (
      <div className="p-6 md:p-8 max-w-3xl">
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-foreground">Wallet</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Connect your PaySponge wallet to enable payments, transfers, and financial tracking
          </p>
        </div>

        {error && (
          <div className="mb-6 p-3 rounded-xl bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800/50 flex items-start gap-2 text-sm text-red-700 dark:text-red-400">
            <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
            {error}
          </div>
        )}

        <Card className="p-8 text-center">
          <div className="mx-auto w-14 h-14 rounded-2xl bg-primary/10 flex items-center justify-center mb-4">
            <Wallet className="h-7 w-7 text-primary" />
          </div>
          <h2 className="text-lg font-semibold mb-2">Connect PaySponge Wallet</h2>
          <p className="text-sm text-muted-foreground mb-6 max-w-md mx-auto">
            Enter your PaySponge API key to connect your wallet. Your AI agent will be able to check
            balances, create payment links, and manage transactions.
          </p>

          <div className="flex flex-col sm:flex-row gap-3 max-w-md mx-auto">
            <input
              type="password"
              value={connectKey}
              onChange={(e) => setConnectKey(e.target.value)}
              placeholder="sk_live_..."
              className="flex-1 px-3 py-2 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
            />
            <Button
              onClick={handleConnect}
              disabled={isConnecting || !connectKey.trim()}
              className="shrink-0"
            >
              {isConnecting ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Link2 className="h-4 w-4 mr-2" />}
              Connect
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  // ─── Connected state ──────────────────────────────────────────────

  return (
    <div className="p-6 md:p-8 max-w-5xl">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Wallet</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Manage your PaySponge wallet, view balances, and approve transactions
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void loadData()}>
            <RefreshCcw className="h-4 w-4 mr-1" /> Refresh
          </Button>
          <Button variant="outline" size="sm" onClick={handleDisconnect}>
            Disconnect
          </Button>
        </div>
      </div>

      {error && (
        <div className="mb-6 p-3 rounded-xl bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800/50 flex items-start gap-2 text-sm text-red-700 dark:text-red-400">
          <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
          {error}
        </div>
      )}

      {isLoading ? (
        <div className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            {[1, 2, 3].map((i) => <Skeleton key={i} className="h-28 rounded-xl" />)}
          </div>
          <Skeleton className="h-[300px] rounded-xl" />
        </div>
      ) : (
        <>
          {/* Balance Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
            {balances.length > 0 ? balances.map((b, i) => (
              <Card key={i} className="p-5">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{b.token}</span>
                  <span className="text-xs text-muted-foreground">{b.chain}</span>
                </div>
                <p className="text-2xl font-bold text-foreground">{Number(b.balance).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
              </Card>
            )) : (
              <Card className="p-5 col-span-full text-center text-sm text-muted-foreground">
                No balance data available
              </Card>
            )}
          </div>

          {/* Policy Summary */}
          {settings && (
            <Card className="p-4 mb-6 flex flex-wrap items-center gap-4 text-sm">
              <div className="flex items-center gap-1.5">
                <Shield className="h-4 w-4 text-muted-foreground" />
                <span className="text-muted-foreground">Daily limit:</span>
                <span className="font-medium">${settings.dailyLimit.toLocaleString()}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="text-muted-foreground">Auto-approve max:</span>
                <span className="font-medium">${settings.autoApproveMax}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="text-muted-foreground">Approval required:</span>
                <span className={cn('font-medium', settings.requireApproval ? 'text-amber-600' : 'text-green-600')}>
                  {settings.requireApproval ? 'Yes' : 'No'}
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="text-muted-foreground">Chains:</span>
                <span className="font-medium">{settings.allowedChains.join(', ')}</span>
              </div>
            </Card>
          )}

          {/* Tabs */}
          <div className="flex items-center gap-1 p-1 bg-muted rounded-xl mb-6 w-fit">
            {tabs.map((t) => (
              <button
                key={t.value}
                type="button"
                onClick={() => setTab(t.value)}
                className={cn(
                  'px-4 py-1.5 rounded-lg text-sm font-medium transition-colors',
                  tab === t.value
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {t.label}
              </button>
            ))}
          </div>

          {/* Tab Content */}
          {tab === 'overview' && (
            <div className="space-y-4">
              <h2 className="text-lg font-semibold">Recent Activity</h2>
              {auditLogs.length > 0 ? (
                <div className="space-y-2">
                  {auditLogs.map((log) => (
                    <Card key={log.id} className="p-4 flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div className={cn('w-8 h-8 rounded-lg flex items-center justify-center', getEventColor(log.status))}>
                          {getEventIcon(log.eventType)}
                        </div>
                        <div>
                          <p className="text-sm font-medium">{formatEventType(log.eventType)}</p>
                          <p className="text-xs text-muted-foreground">
                            {log.actor} · {new Date(log.createdAt).toLocaleString()}
                          </p>
                        </div>
                      </div>
                      {log.amount != null && (
                        <span className="text-sm font-mono font-medium">
                          {log.amount} {log.currency || 'USDC'}
                        </span>
                      )}
                    </Card>
                  ))}
                </div>
              ) : (
                <Card className="p-8 text-center text-sm text-muted-foreground">
                  No activity yet
                </Card>
              )}
            </div>
          )}

          {tab === 'actions' && (
            <div className="space-y-4">
              <h2 className="text-lg font-semibold">Pending Actions</h2>
              {actions.length > 0 ? (
                <div className="space-y-3">
                  {actions.map((action) => (
                    <Card key={action.id} className="p-4">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <div className="w-8 h-8 rounded-lg bg-amber-100 dark:bg-amber-950/40 flex items-center justify-center">
                            <Clock className="h-4 w-4 text-amber-600" />
                          </div>
                          <div>
                            <p className="text-sm font-medium capitalize">{action.actionType.replace(/_/g, ' ')}</p>
                            <p className="text-xs text-muted-foreground">
                              {action.amount} {action.currency || 'USDC'}
                              {action.chain && ` on ${action.chain}`}
                              {action.destination && ` → ${action.destination.slice(0, 10)}...`}
                            </p>
                            <p className="text-xs text-muted-foreground mt-0.5">
                              Requested by {action.requestedBy} · {new Date(action.createdAt).toLocaleString()}
                            </p>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => void handleReject(action.id)}
                            disabled={actionLoadingId === action.id}
                          >
                            <XCircle className="h-4 w-4 mr-1" /> Reject
                          </Button>
                          <Button
                            size="sm"
                            onClick={() => void handleApprove(action.id)}
                            disabled={actionLoadingId === action.id}
                          >
                            {actionLoadingId === action.id
                              ? <Loader2 className="h-4 w-4 animate-spin mr-1" />
                              : <CheckCircle2 className="h-4 w-4 mr-1" />
                            }
                            Approve
                          </Button>
                        </div>
                      </div>
                    </Card>
                  ))}
                </div>
              ) : (
                <Card className="p-8 text-center text-sm text-muted-foreground">
                  No pending actions
                </Card>
              )}
            </div>
          )}

          {tab === 'history' && (
            <div className="space-y-4">
              <h2 className="text-lg font-semibold">Audit Log</h2>
              {auditLogs.length > 0 ? (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border text-left">
                        <th className="pb-2 font-medium text-muted-foreground">Event</th>
                        <th className="pb-2 font-medium text-muted-foreground">Amount</th>
                        <th className="pb-2 font-medium text-muted-foreground">Status</th>
                        <th className="pb-2 font-medium text-muted-foreground">Actor</th>
                        <th className="pb-2 font-medium text-muted-foreground">Date</th>
                      </tr>
                    </thead>
                    <tbody>
                      {auditLogs.map((log) => (
                        <tr key={log.id} className="border-b border-border/50">
                          <td className="py-2.5">{formatEventType(log.eventType)}</td>
                          <td className="py-2.5 font-mono text-xs">
                            {log.amount != null ? `${log.amount} ${log.currency || 'USDC'}` : '—'}
                          </td>
                          <td className="py-2.5">
                            <span className={cn(
                              'inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium',
                              log.status === 'success' && 'bg-green-100 text-green-700 dark:bg-green-950/40 dark:text-green-400',
                              log.status === 'failed' && 'bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-400',
                              log.status === 'rejected' && 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400',
                              !['success', 'failed', 'rejected'].includes(log.status || '') && 'bg-muted text-muted-foreground',
                            )}>
                              {log.status || '—'}
                            </span>
                          </td>
                          <td className="py-2.5 text-muted-foreground">{log.actor}</td>
                          <td className="py-2.5 text-muted-foreground text-xs">{new Date(log.createdAt).toLocaleString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <Card className="p-8 text-center text-sm text-muted-foreground">
                  No audit logs yet
                </Card>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ─── Helpers ───────────────────────────────────────────────────────

function formatEventType(eventType: string): string {
  return eventType
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function getEventColor(status?: string): string {
  switch (status) {
    case 'success': return 'bg-green-100 dark:bg-green-950/40';
    case 'failed': return 'bg-red-100 dark:bg-red-950/40';
    case 'rejected': return 'bg-amber-100 dark:bg-amber-950/40';
    default: return 'bg-muted';
  }
}

function getEventIcon(eventType: string) {
  if (eventType.includes('transfer')) return <ArrowUpRight className="h-4 w-4 text-blue-600" />;
  if (eventType.includes('swap')) return <RefreshCcw className="h-4 w-4 text-purple-600" />;
  if (eventType.includes('payment')) return <ArrowDownLeft className="h-4 w-4 text-green-600" />;
  if (eventType.includes('balance')) return <Wallet className="h-4 w-4 text-muted-foreground" />;
  if (eventType.includes('connected') || eventType.includes('disconnected')) return <Link2 className="h-4 w-4 text-primary" />;
  return <Clock className="h-4 w-4 text-muted-foreground" />;
}
