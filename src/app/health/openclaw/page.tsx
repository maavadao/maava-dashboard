'use client';

import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@/hooks';
import { useRouter } from 'next/navigation';
import {
  Activity,
  Database,
  Cloud,
  Wifi,
  HardDrive,
  RefreshCw,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  ArrowLeft,
} from 'lucide-react';
import { Button } from '@/components/ui';
import { cn } from '@/lib/utils';

interface HealthComponent {
  status: 'ok' | 'degraded' | 'down';
  latency_ms?: number;
  error?: string;
  details?: Record<string, unknown>;
}

interface HealthData {
  service: string;
  status: 'ok' | 'degraded' | 'down';
  timestamp: string;
  components: {
    db: HealthComponent;
    gateway?: HealthComponent;
    providers?: HealthComponent;
    gcs: HealthComponent;
  };
  env: {
    cloud_mode: boolean;
    gateway_url: string | null;
    openai_key_set: boolean;
    anthropic_key_set: boolean;
    database_url_set: boolean;
    gcs_project: string;
    node_version: string;
    commit: string;
  };
}

const STATUS_CONFIG = {
  ok: { icon: CheckCircle2, label: 'Healthy', color: 'text-emerald-500', bg: 'bg-emerald-50 dark:bg-emerald-950/40', border: 'border-emerald-200 dark:border-emerald-800/40', dot: 'bg-emerald-500' },
  degraded: { icon: AlertTriangle, label: 'Degraded', color: 'text-amber-500', bg: 'bg-amber-50 dark:bg-amber-950/40', border: 'border-amber-200 dark:border-amber-800/40', dot: 'bg-amber-500' },
  down: { icon: XCircle, label: 'Down', color: 'text-red-500', bg: 'bg-red-50 dark:bg-red-950/40', border: 'border-red-200 dark:border-red-800/40', dot: 'bg-red-500' },
} as const;

export default function HealthDashboard() {
  const { isAuthenticated } = useAuth();
  const router = useRouter();
  const [data, setData] = useState<HealthData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  const fetchHealth = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await fetch('/api/health/openclaw');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setData(json);
      setLastRefresh(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch health data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isAuthenticated) {
      const rootDomain = process.env.NEXT_PUBLIC_ROOT_DOMAIN || 'mawadao.com';
      window.location.href = `https://${rootDomain}/auth/login`;
      return;
    }
    fetchHealth();
  }, [isAuthenticated, router, fetchHealth]);

  // Auto-refresh every 15 seconds
  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(fetchHealth, 15000);
    return () => clearInterval(interval);
  }, [autoRefresh, fetchHealth]);

  if (!isAuthenticated) return null;

  const overall = data?.status || 'down';
  const overallCfg = STATUS_CONFIG[overall];
  const OverallIcon = overallCfg.icon;

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-4xl mx-auto px-6 py-8">
        {/* Header */}
        <div className="flex items-center gap-4 mb-8">
          <Button variant="ghost" size="sm" onClick={() => router.push('/settings?tab=openclaw')} className="gap-1.5">
            <ArrowLeft className="h-4 w-4" /> Back to Settings
          </Button>
        </div>

        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl font-bold tracking-tight text-foreground">System Health</h1>
            <p className="text-[15px] text-muted-foreground mt-1">Real-time monitoring of OpenClaw platform services.</p>
          </div>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 text-sm text-muted-foreground cursor-pointer">
              <input
                type="checkbox"
                checked={autoRefresh}
                onChange={(e) => setAutoRefresh(e.target.checked)}
                className="rounded border-border"
              />
              Auto-refresh
            </label>
            <Button variant="outline" size="sm" onClick={fetchHealth} disabled={loading} className="gap-1.5">
              <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
              Refresh
            </Button>
          </div>
        </div>

        {/* Overall Status Banner */}
        {data && (
          <div className={cn('rounded-2xl border p-6 mb-8', overallCfg.bg, overallCfg.border)}>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <OverallIcon className={cn('h-8 w-8', overallCfg.color)} />
                <div>
                  <h2 className="text-lg font-bold text-foreground">Overall Status: {overallCfg.label}</h2>
                  <p className="text-sm text-muted-foreground">
                    Last checked: {lastRefresh ? lastRefresh.toLocaleTimeString() : '—'}
                    {autoRefresh && ' · Auto-refreshing every 15s'}
                  </p>
                </div>
              </div>
              <span className={cn('h-4 w-4 rounded-full animate-pulse', overallCfg.dot)} />
            </div>
          </div>
        )}

        {error && !data && (
          <div className="rounded-2xl border border-red-200 dark:border-red-800/40 bg-red-50 dark:bg-red-950/40 p-6 mb-8">
            <div className="flex items-center gap-3">
              <XCircle className="h-6 w-6 text-red-500" />
              <div>
                <h2 className="text-lg font-bold text-red-900 dark:text-red-400">Health Check Failed</h2>
                <p className="text-sm text-red-600 dark:text-red-400/70">{error}</p>
              </div>
            </div>
          </div>
        )}

        {/* Component Cards */}
        {data && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-8">
            <ComponentCard
              icon={Database}
              label="Database"
              component={data.components.db}
              details={[
                { label: 'URL Configured', value: data.env.database_url_set ? 'Yes' : 'No' },
                { label: 'Latency', value: data.components.db.latency_ms != null ? `${data.components.db.latency_ms}ms` : '—' },
              ]}
            />
            {data.components.gateway ? (
              <ComponentCard
                icon={Wifi}
                label="OpenClaw Gateway"
                component={data.components.gateway}
                details={[
                  { label: 'URL', value: data.env.gateway_url || 'Not configured' },
                  { label: 'Latency', value: data.components.gateway.latency_ms != null ? `${data.components.gateway.latency_ms}ms` : '—' },
                  ...(data.components.gateway.details?.models_count != null ? [{ label: 'Models', value: String(data.components.gateway.details.models_count) }] : []),
                ]}
              />
            ) : data.components.providers ? (
              <ComponentCard
                icon={Activity}
                label="AI Providers"
                component={data.components.providers}
                details={[
                  { label: 'Mode', value: 'Cloud' },
                  { label: 'Connected', value: Array.isArray(data.components.providers.details?.connected) ? (data.components.providers.details.connected as string[]).join(', ') : 'None' },
                  { label: 'Latency', value: data.components.providers.latency_ms != null ? `${data.components.providers.latency_ms}ms` : '—' },
                ]}
              />
            ) : null}
            <ComponentCard
              icon={HardDrive}
              label="Cloud Storage (GCS)"
              component={data.components.gcs}
              details={[
                { label: 'Project', value: data.env.gcs_project },
                { label: 'Latency', value: data.components.gcs.latency_ms != null ? `${data.components.gcs.latency_ms}ms` : '—' },
              ]}
            />
          </div>
        )}

        {/* Environment Info */}
        {data?.env && (
          <div className="bg-card/80 backdrop-blur-xl rounded-2xl border border-border/60 shadow-sm overflow-hidden">
            <div className="px-7 pt-7 pb-2">
              <h2 className="text-lg font-bold text-foreground tracking-tight">Environment</h2>
              <p className="text-[13px] text-muted-foreground mt-0.5">Runtime configuration status.</p>
            </div>
            <div className="px-7 pb-7 pt-4">
              <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                <EnvBadge label="Cloud Mode" value={data.env.cloud_mode} />
                <EnvBadge label="OpenAI Key" value={data.env.openai_key_set} />
                <EnvBadge label="Anthropic Key" value={data.env.anthropic_key_set} />
                <EnvBadge label="Database URL" value={data.env.database_url_set} />
                <div className="p-3 rounded-xl border border-border bg-muted/30">
                  <p className="text-[11px] text-muted-foreground uppercase tracking-wide font-semibold">Node</p>
                  <p className="text-sm font-medium text-foreground mt-1">{data.env.node_version}</p>
                </div>
                <div className="p-3 rounded-xl border border-border bg-muted/30">
                  <p className="text-[11px] text-muted-foreground uppercase tracking-wide font-semibold">Commit</p>
                  <p className="text-sm font-mono text-foreground mt-1 truncate">{data.env.commit}</p>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ComponentCard({
  icon: Icon,
  label,
  component,
  details,
}: {
  icon: React.ElementType;
  label: string;
  component: HealthComponent;
  details: { label: string; value: string }[];
}) {
  const cfg = STATUS_CONFIG[component.status];
  const StatusIcon = cfg.icon;

  return (
    <div className={cn('rounded-2xl border p-5 transition-all', cfg.bg, cfg.border)}>
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2.5">
          <Icon className={cn('h-5 w-5', cfg.color)} />
          <span className="text-sm font-bold text-foreground">{label}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <StatusIcon className={cn('h-4 w-4', cfg.color)} />
          <span className={cn('text-xs font-semibold', cfg.color)}>{cfg.label}</span>
        </div>
      </div>

      <div className="space-y-2">
        {details.map((d) => (
          <div key={d.label} className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground text-xs">{d.label}</span>
            <span className="font-medium text-foreground text-xs truncate max-w-[200px]">{d.value}</span>
          </div>
        ))}
        {component.error && (
          <div className="mt-2 p-2 rounded-lg bg-red-100/50 dark:bg-red-900/20 text-xs text-red-600 dark:text-red-400 break-all">
            {component.error}
          </div>
        )}
      </div>
    </div>
  );
}

function EnvBadge({ label, value }: { label: string; value: boolean }) {
  return (
    <div className="p-3 rounded-xl border border-border bg-muted/30 flex items-center justify-between">
      <span className="text-[11px] text-muted-foreground uppercase tracking-wide font-semibold">{label}</span>
      <span className={cn(
        'h-2.5 w-2.5 rounded-full',
        value ? 'bg-emerald-500' : 'bg-gray-300 dark:bg-gray-600',
      )} />
    </div>
  );
}
