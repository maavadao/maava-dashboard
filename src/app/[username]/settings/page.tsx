'use client';

import { useState, useEffect, useCallback, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { useRouter } from '@/lib/member-path';
import { useAuth, useLocalStorage, useSavedChannels } from '@/hooks';
import { SidebarLayout, SettingsSidebar } from '@/components/layout/sidebar';
import {
  Button,
  Input,
  Avatar,
  AvatarImage,
  AvatarFallback,
  Switch,
} from '@/components/ui';
import {
  LogOut,
  Save,
  Trash2,
  AlertTriangle,
  Check,
  Activity,
  Cpu,
  Zap,
  Radio,
  RefreshCw,
  Eye,
  EyeOff,
  Key,
  Loader2,
  X,
  FlaskConical,
  CheckCircle2,
  XCircle,
  MessageCircle,
  ExternalLink,
  Shield,
} from 'lucide-react';
import { SiDiscord, SiSlack, SiTelegram, SiWhatsapp } from 'react-icons/si';
import { FaMicrosoft } from 'react-icons/fa6';
import { CHANNEL_TYPES } from '@/lib/constants';
import { configApi } from '@/lib/config-api';
import { cn, getInitials } from '@/lib/utils';
import { api } from '@/lib/api';
import { useTheme } from 'next-themes';
import { motion, AnimatePresence } from 'framer-motion';
import { DataManagement } from '@/components/cloud/DataManagement';
import Link from '@/components/member-link';

const cardVariants = {
  hidden: { opacity: 0, y: 16 },
  visible: { opacity: 1, y: 0 },
};

function SettingsContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { agent, user, isAuthenticated, logout } = useAuth();
  const { theme, setTheme } = useTheme();
  const activeTab = searchParams.get('tab') || 'profile';

  useEffect(() => {
    if (!isAuthenticated) {
      const rootDomain = process.env.NEXT_PUBLIC_ROOT_DOMAIN || 'mawadao.com';
      window.location.href = `https://${rootDomain}`;
    }
  }, [isAuthenticated, router]);

  if (!isAuthenticated) return null;

  return (
    <SidebarLayout sidebar={<SettingsSidebar />}>
      <div className="max-w-3xl mx-auto px-6 py-8">
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: [0.32, 0.72, 0, 1] }}
          className="mb-8"
        >
          <h1 className="text-3xl font-bold tracking-tight text-foreground">Settings</h1>
          <p className="text-[15px] text-muted-foreground mt-1">Manage your account preferences and configuration.</p>
        </motion.div>

        <AnimatePresence mode="wait">
          {activeTab === 'profile' && (
            <motion.div key="profile" variants={cardVariants} initial="hidden" animate="visible" exit="hidden" transition={{ duration: 0.4, ease: [0.32, 0.72, 0, 1] }}>
              <ProfileSettings agent={agent} user={user} />
            </motion.div>
          )}
          {activeTab === 'notifications' && (
            <motion.div key="notifications" variants={cardVariants} initial="hidden" animate="visible" exit="hidden" transition={{ duration: 0.4, ease: [0.32, 0.72, 0, 1] }}>
              <NotificationSettings />
            </motion.div>
          )}
          {activeTab === 'appearance' && (
            <motion.div key="appearance" variants={cardVariants} initial="hidden" animate="visible" exit="hidden" transition={{ duration: 0.4, ease: [0.32, 0.72, 0, 1] }}>
              <AppearanceSettings theme={theme} setTheme={setTheme} />
            </motion.div>
          )}
          {activeTab === 'openclaw' && (
            <motion.div key="openclaw" variants={cardVariants} initial="hidden" animate="visible" exit="hidden" transition={{ duration: 0.4, ease: [0.32, 0.72, 0, 1] }}>
              <OpenClawChatSettings />
            </motion.div>
          )}
          {activeTab === 'account' && (
            <motion.div key="account" variants={cardVariants} initial="hidden" animate="visible" exit="hidden" transition={{ duration: 0.4, ease: [0.32, 0.72, 0, 1] }}>
              <AccountSettings agent={agent} user={user} onLogout={logout} />
            </motion.div>
          )}
          {activeTab === 'channels' && (
            <motion.div key="channels" variants={cardVariants} initial="hidden" animate="visible" exit="hidden" transition={{ duration: 0.4, ease: [0.32, 0.72, 0, 1] }}>
              <ChannelSettings agent={agent} />
            </motion.div>
          )}
          {activeTab === 'data' && (
            <motion.div key="data" variants={cardVariants} initial="hidden" animate="visible" exit="hidden" transition={{ duration: 0.4, ease: [0.32, 0.72, 0, 1] }}>
              <CloudDataSettings />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </SidebarLayout>
  );
}

export default function SettingsPage() {
  return (
    <Suspense>
      <SettingsContent />
    </Suspense>
  );
}

// =============================================================================
// Glassmorphism card wrapper
// =============================================================================
function SettingsCard({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <div className="bg-card/80 backdrop-blur-xl rounded-2xl border border-border/60 shadow-[0_2px_16px_rgba(0,0,0,0.03)] dark:shadow-[0_2px_16px_rgba(0,0,0,0.18)] overflow-hidden transition-shadow hover:shadow-[0_4px_24px_rgba(0,0,0,0.06)] dark:hover:shadow-[0_4px_24px_rgba(0,0,0,0.25)]">
      <div className="px-7 pt-7 pb-2">
        <h2 className="text-lg font-bold text-foreground tracking-tight">{title}</h2>
        <p className="text-[13px] text-muted-foreground mt-0.5 leading-relaxed">{description}</p>
      </div>
      <div className="px-7 pb-7 pt-4">{children}</div>
    </div>
  );
}

// =============================================================================
// Profile
// =============================================================================
function ProfileSettings({ agent, user }: { agent: any; user: any }) {
  const displayNameSrc = user?.displayName || agent?.displayName || '';
  const name = user?.username || agent?.name || '';
  const avatarUrl = user?.avatarUrl || agent?.avatarUrl;
  const email = user?.email || '';

  const [displayName, setDisplayName] = useState(displayNameSrc);
  const [isSaving, setIsSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setDisplayName(user?.displayName || agent?.displayName || '');
  }, [user?.displayName, agent?.displayName]);

  const handleSave = async () => {
    setIsSaving(true);
    try {
      await api.updateMe({ displayName: displayName || undefined });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      console.error('Failed to save:', err);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <SettingsCard title="Profile" description="Update your public profile information.">
      <div className="space-y-6">
        <div className="flex items-center gap-5">
          <div className="relative group">
            <Avatar className="h-20 w-20 ring-4 ring-border/50 shadow-sm">
              <AvatarImage src={avatarUrl} />
              <AvatarFallback className="text-2xl bg-gradient-to-br from-primary to-primary/80 text-primary-foreground">
                {name ? getInitials(name) : '?'}
              </AvatarFallback>
            </Avatar>
          </div>
          <div>
            <p className="font-semibold text-foreground text-[15px]">{name}</p>
            {email && <p className="text-[12px] text-muted-foreground mt-0.5">{email}</p>}
            {!email && <p className="text-[12px] text-muted-foreground mt-0.5">Avatar changes are not yet supported</p>}
          </div>
        </div>

        <div className="h-px bg-border/60" />

        <div className="space-y-2">
          <label className="text-[13px] font-semibold text-foreground/80">Display Name</label>
          <Input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder={name || 'Enter a display name'}
            maxLength={50}
            className="h-11 rounded-xl border-border bg-background focus:ring-2 focus:ring-ring/20 focus:border-border transition-all"
          />
          <p className="text-[11px] text-muted-foreground">This is how your name will appear publicly</p>
        </div>

        <Button
          onClick={handleSave}
          disabled={isSaving}
          className="gap-2 h-10 rounded-xl text-[13px] font-semibold bg-primary text-primary-foreground hover:bg-primary/90 shadow-sm hover:shadow-md transition-all duration-200"
        >
          {saved ? <Check className="h-4 w-4" /> : <Save className="h-4 w-4" />}
          {saved ? 'Saved!' : isSaving ? 'Saving...' : 'Save Changes'}
        </Button>
      </div>
    </SettingsCard>
  );
}

// =============================================================================
// Notifications
// =============================================================================
function NotificationSettings() {
  const [emailNotifs, setEmailNotifs] = useLocalStorage('mawadao_notif_email', true);
  const [replyNotifs, setReplyNotifs] = useLocalStorage('mawadao_notif_replies', true);
  const [mentionNotifs, setMentionNotifs] = useLocalStorage('mawadao_notif_mentions', true);
  const [upvoteNotifs, setUpvoteNotifs] = useLocalStorage('mawadao_notif_upvotes', false);

  return (
    <SettingsCard title="Notifications" description="Configure how you receive notifications.">
      <div className="space-y-1">
        <ToggleRow label="Email notifications" description="Receive notifications via email" checked={emailNotifs} onChange={setEmailNotifs} />
        <div className="h-px bg-border my-3" />
        <ToggleRow label="Replies" description="When someone replies to your posts or comments" checked={replyNotifs} onChange={setReplyNotifs} />
        <ToggleRow label="Mentions" description="When someone mentions you" checked={mentionNotifs} onChange={setMentionNotifs} />
        <ToggleRow label="Upvotes" description="When someone upvotes your content" checked={upvoteNotifs} onChange={setUpvoteNotifs} />
      </div>
    </SettingsCard>
  );
}

function ToggleRow({ label, description, checked, onChange }: { label: string; description: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between py-3 px-1 rounded-lg hover:bg-muted/50 transition-colors -mx-1">
      <div>
        <p className="text-[13px] font-semibold text-foreground">{label}</p>
        <p className="text-[12px] text-muted-foreground">{description}</p>
      </div>
      <button
        onClick={() => onChange(!checked)}
        className={cn(
          'w-12 h-7 rounded-full transition-all duration-300 ease-out relative shadow-inner',
          checked ? 'bg-primary' : 'bg-muted',
        )}
      >
        <motion.div
          layout
          transition={{ type: 'spring', stiffness: 500, damping: 30 }}
          className={cn(
            'absolute top-0.5 h-6 w-6 rounded-full bg-white shadow-md',
            checked ? 'left-[22px]' : 'left-0.5',
          )}
        />
      </button>
    </div>
  );
}

// =============================================================================
// Appearance
// =============================================================================
function AppearanceSettings({ theme, setTheme }: { theme?: string; setTheme: (t: string) => void }) {
  const themes = [
    { id: 'light', label: 'Light', icon: '☀️', desc: 'Clean & bright' },
    { id: 'dark', label: 'Dark', icon: '🌙', desc: 'Easy on the eyes' },
    { id: 'system', label: 'System', icon: '💻', desc: 'Match your OS' },
  ];

  return (
    <SettingsCard title="Appearance" description="Customize how the app looks.">
      <div className="space-y-2">
        <label className="text-[13px] font-semibold text-foreground/80">Theme</label>
        <div className="grid grid-cols-3 gap-3">
          {themes.map((t) => {
            const isActive = theme === t.id;
            return (
              <motion.button
                key={t.id}
                whileTap={{ scale: 0.97 }}
                onClick={() => setTheme(t.id)}
                className={cn(
                  'flex flex-col items-center gap-2 p-5 rounded-xl border-2 transition-all duration-200',
                  isActive
                    ? 'border-primary bg-primary/10 shadow-md'
                    : 'border-border hover:border-primary/20 hover:bg-muted/30',
                )}
              >
                <span className="text-3xl">{t.icon}</span>
                <span className="text-[13px] font-semibold text-foreground">{t.label}</span>
                <span className="text-[11px] text-muted-foreground">{t.desc}</span>
                {isActive && (
                  <motion.div
                    initial={{ scale: 0 }}
                    animate={{ scale: 1 }}
                    className="w-5 h-5 rounded-full bg-primary flex items-center justify-center"
                  >
                    <Check className="w-3 h-3 text-primary-foreground" strokeWidth={3} />
                  </motion.div>
                )}
              </motion.button>
            );
          })}
        </div>
      </div>
    </SettingsCard>
  );
}

// =============================================================================
// Moonshot — server-side provider key management
// =============================================================================

interface SavedProviderKey {
  id: string;
  provider: string;
  maskedKey: string;
  label: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

const PROVIDER_META: Record<string, { label: string; placeholder: string; hint: string }> = {
  moonshot: { label: 'Moonshot', placeholder: 'sk-ms-…', hint: 'Optional — we provide access via our platform key. Add your own for higher limits.' },
  openai: { label: 'OpenAI', placeholder: 'sk-proj-…', hint: 'For GPT-4o, o3, o4-mini etc.' },
  anthropic: { label: 'Anthropic', placeholder: 'sk-ant-api03-…', hint: 'For Claude Opus, Sonnet, Haiku.' },
  google: { label: 'Google AI', placeholder: 'AIza…', hint: 'For Gemini 2.5 Pro, Flash etc.' },
};

const ALL_PROVIDERS = ['moonshot', 'openai', 'anthropic', 'google'];

function OpenClawChatSettings() {
  const [savedKeys, setSavedKeys] = useState<SavedProviderKey[]>([]);
  const [keysLoading, setKeysLoading] = useState(true);

  // Form state for adding/editing a key
  const [editProvider, setEditProvider] = useState<string | null>(null);
  const [newKeyValue, setNewKeyValue] = useState('');
  const [newKeyVisible, setNewKeyVisible] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [justSaved, setJustSaved] = useState<string | null>(null);

  // Test state
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<'valid' | 'invalid' | null>(null);
  const [testError, setTestError] = useState('');

  // Delete state
  const [deleting, setDeleting] = useState<string | null>(null);

  // Toggle state
  const [toggling, setToggling] = useState<string | null>(null);
  const [toggleError, setToggleError] = useState('');

  // System status state
  const [modelsCount, setModelsCount] = useState<number | null>(null);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [modelsDetail, setModelsDetail] = useState<string>('');
  const [skillsCount, setSkillsCount] = useState<number | null>(null);
  const [skillsLoading, setSkillsLoading] = useState(true);
  const [channelsCount, setChannelsCount] = useState<number | null>(null);
  const [channelsLoading, setChannelsLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);

  // Fetch saved keys
  const fetchKeys = useCallback(async () => {
    setKeysLoading(true);
    try {
      const res = await fetch('/api/provider-keys', { credentials: 'include' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setSavedKeys(data.providers ?? []);
    } catch {
      setSavedKeys([]);
    } finally {
      setKeysLoading(false);
    }
  }, []);

  useEffect(() => { fetchKeys(); }, [fetchKeys]);

  // Test a key
  const handleTestKey = async (provider: string) => {
    if (!newKeyValue.trim()) return;
    setTestResult(null);
    setTestError('');
    setTesting(true);
    try {
      const res = await fetch('/api/provider-keys/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ provider, apiKey: newKeyValue.trim() }),
      });
      const data = await res.json().catch(() => ({ valid: false, error: 'No response' }));
      if (data.valid) {
        setTestResult('valid');
      } else {
        setTestResult('invalid');
        setTestError(data.error || 'Key is invalid');
      }
    } catch (err) {
      setTestResult('invalid');
      setTestError((err as Error).message || 'Network error');
    } finally {
      setTesting(false);
    }
  };

  // Save/update a key
  const handleSaveKey = async (provider: string) => {
    if (!newKeyValue.trim()) return;
    setSaving(true);
    setSaveError('');
    try {
      const res = await fetch('/api/provider-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ provider, apiKey: newKeyValue.trim() }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: 'Failed to save' }));
        throw new Error(data.error || `Error ${res.status}`);
      }
      setEditProvider(null);
      setNewKeyValue('');
      setTestResult(null);
      setTestError('');
      setNewKeyVisible(false);
      setJustSaved(provider);
      setTimeout(() => setJustSaved(null), 2500);
      await fetchKeys();
      setRefreshKey(k => k + 1); // refresh model counts too
    } catch (err) {
      setSaveError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  // Delete a key
  const handleDeleteKey = async (provider: string) => {
    setDeleting(provider);
    try {
      const res = await fetch(`/api/provider-keys?provider=${encodeURIComponent(provider)}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: 'Failed to delete' }));
        throw new Error(data.error || `Error ${res.status}`);
      }
      await fetchKeys();
      setRefreshKey(k => k + 1);
    } catch (err) {
      console.error('Delete failed:', err);
    } finally {
      setDeleting(null);
    }
  };

  // Toggle provider active/inactive
  const handleToggle = async (provider: string, isActive: boolean) => {
    setToggling(provider);
    setToggleError('');
    try {
      const res = await fetch('/api/provider-keys', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ provider, isActive }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: 'Failed to toggle' }));
        throw new Error(data.error || `Error ${res.status}`);
      }
      await fetchKeys();
      setRefreshKey(k => k + 1);
    } catch (err) {
      setToggleError((err as Error).message);
    } finally {
      setToggling(null);
    }
  };

  // Load models
  useEffect(() => {
    setModelsLoading(true);
    fetch('/api/models', { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        const list = data?.models ?? [];
        setModelsCount(list.length);
        setModelsDetail(list.slice(0, 3).map((m: { name?: string; id: string }) => m.name || m.id).join(', '));
      })
      .catch(() => setModelsCount(null))
      .finally(() => setModelsLoading(false));
  }, [refreshKey]);

  // Load skills
  useEffect(() => {
    setSkillsLoading(true);
    fetch('/api/skills?installed=true&limit=100')
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        const list = data?.data ?? data?.skills ?? [];
        setSkillsCount(list.length);
      })
      .catch(() => setSkillsCount(null))
      .finally(() => setSkillsLoading(false));
  }, [refreshKey]);

  // Load channels
  useEffect(() => {
    setChannelsLoading(true);
    fetch('/api/channels')
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        const list = data?.channels ?? data ?? [];
        setChannelsCount(Array.isArray(list) ? list.length : 0);
      })
      .catch(() => setChannelsCount(null))
      .finally(() => setChannelsLoading(false));
  }, [refreshKey]);

  const savedKeyMap = new Map(savedKeys.map(k => [k.provider, k]));

  return (
    <div className="space-y-6">
      <SettingsCard
        title="AI Provider Keys"
        description="Manage your API keys for AI providers. Keys are encrypted with AES-256 and stored securely on the server."
      >
        <div className="space-y-4">
          <div className="p-3 rounded-xl bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-800/40 text-[12px] text-blue-700 dark:text-blue-400 flex items-start gap-2">
            <Key className="h-4 w-4 shrink-0 mt-0.5" />
            <span>Keys are encrypted and stored on the server. Only models from your connected providers will appear in model selection.</span>
          </div>

          {keysLoading ? (
            <div className="flex items-center justify-center py-6">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <div className="space-y-3">
              {ALL_PROVIDERS.map(provider => {
                const meta = PROVIDER_META[provider];
                const existing = savedKeyMap.get(provider);
                const isEditing = editProvider === provider;
                const wasJustSaved = justSaved === provider;
                const isDeleting = deleting === provider;
                const isMoonshot = provider === 'moonshot';
                const isTogglingThis = toggling === provider;

                // Moonshot is always toggleable (platform key fallback), others need a saved key
                const canToggle = isMoonshot || !!existing;
                const isActive = existing ? existing.isActive : isMoonshot; // Moonshot on by default even without custom key

                return (
                  <div key={provider} className={cn('rounded-xl border p-4 space-y-3 transition-colors', isActive ? 'border-border' : 'border-border/50 opacity-60')}>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <Switch
                          checked={isActive}
                          onCheckedChange={(checked) => {
                            if (!canToggle) return;
                            if (existing) {
                              handleToggle(provider, checked);
                            }
                          }}
                          disabled={!canToggle || isTogglingThis}
                          className="data-[state=checked]:bg-primary"
                        />
                        <div>
                          <span className="text-[13px] font-semibold text-foreground">{meta.label}</span>
                          {isMoonshot && !existing && (
                            <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-900/40 text-blue-600 dark:text-blue-400 font-medium">
                              Platform provided
                            </span>
                          )}
                          {isTogglingThis && <Loader2 className="inline ml-2 h-3 w-3 animate-spin text-muted-foreground" />}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        {existing ? (
                          <>
                            <span className="text-[11px] font-mono text-muted-foreground">{existing.maskedKey}</span>
                            <button
                              onClick={() => { setEditProvider(provider); setNewKeyValue(''); setNewKeyVisible(false); setSaveError(''); setTestResult(null); setTestError(''); }}
                              className="text-[11px] text-primary hover:underline font-medium"
                            >
                              Edit
                            </button>
                            <button
                              onClick={() => handleDeleteKey(provider)}
                              disabled={isDeleting}
                              className="text-[11px] text-red-500 hover:underline font-medium disabled:opacity-50"
                            >
                              {isDeleting ? 'Removing…' : 'Remove'}
                            </button>
                          </>
                        ) : wasJustSaved ? (
                          <span className="text-[11px] text-emerald-600 font-medium flex items-center gap-1">
                            <Check className="h-3 w-3" /> Saved
                          </span>
                        ) : (
                          <button
                            onClick={() => { setEditProvider(provider); setNewKeyValue(''); setNewKeyVisible(false); setSaveError(''); setTestResult(null); setTestError(''); }}
                            className="text-[11px] text-primary hover:underline font-medium"
                          >
                            {isMoonshot ? 'Add custom key' : 'Add key'}
                          </button>
                        )}
                      </div>
                    </div>

                    {toggleError && toggling === null && (
                      <p className="text-[11px] text-red-600">{toggleError}</p>
                    )}

                    <p className="text-[11px] text-muted-foreground">{meta.hint}</p>

                    {isEditing && (
                      <motion.div
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: 'auto' }}
                        className="space-y-2"
                      >
                        <div className="relative">
                          <Input
                            type={newKeyVisible ? 'text' : 'password'}
                            value={newKeyValue}
                            onChange={(e) => { setNewKeyValue(e.target.value); setSaveError(''); setTestResult(null); setTestError(''); }}
                            placeholder={meta.placeholder}
                            className="h-10 rounded-xl border-border bg-background font-mono text-sm pr-10"
                          />
                          <button
                            type="button"
                            onClick={() => setNewKeyVisible(!newKeyVisible)}
                            className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                          >
                            {newKeyVisible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                          </button>
                        </div>
                        {saveError && (
                          <p className="text-[11px] text-red-600">{saveError}</p>
                        )}
                        {testResult === 'valid' && (
                          <p className="text-[11px] text-emerald-600 flex items-center gap-1">
                            <CheckCircle2 className="h-3.5 w-3.5" /> Key is valid — looks good!
                          </p>
                        )}
                        {testResult === 'invalid' && (
                          <p className="text-[11px] text-red-600 flex items-center gap-1">
                            <XCircle className="h-3.5 w-3.5" /> {testError || 'Key is invalid'}
                          </p>
                        )}
                        <div className="flex items-center gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={!newKeyValue.trim() || testing}
                            onClick={() => handleTestKey(provider)}
                            className="gap-1.5 h-8 rounded-lg text-[12px] font-semibold"
                          >
                            {testing ? <Loader2 className="h-3 w-3 animate-spin" /> : <FlaskConical className="h-3 w-3" />}
                            {testing ? 'Testing…' : 'Test Key'}
                          </Button>
                          <Button
                            size="sm"
                            disabled={testResult !== 'valid' || saving}
                            onClick={() => handleSaveKey(provider)}
                            className="gap-1.5 h-8 rounded-lg text-[12px] font-semibold"
                          >
                            {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
                            {existing ? 'Update Key' : 'Save Key'}
                          </Button>
                          <button
                            onClick={() => { setEditProvider(null); setNewKeyValue(''); setSaveError(''); setTestResult(null); setTestError(''); }}
                            className="text-[11px] text-muted-foreground hover:text-foreground"
                          >
                            Cancel
                          </button>
                        </div>
                      </motion.div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </SettingsCard>

      <SettingsCard title="System Status" description="Live status of your platform services.">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <StatusCard
            icon={Activity}
            label="Platform"
            loading={false}
            value="Online"
            color="emerald"
            action={
              <div className="flex items-center gap-2">
                <button onClick={() => setRefreshKey(k => k + 1)} className="text-[11px] text-muted-foreground hover:text-foreground flex items-center gap-1">
                  <RefreshCw className="h-3 w-3" /> Refresh
                </button>
                <Link href="/health/openclaw" className="text-[11px] text-primary hover:underline">Full Dashboard</Link>
              </div>
            }
          />
          <StatusCard
            icon={Cpu}
            label="AI Models"
            loading={modelsLoading}
            value={modelsCount !== null ? `${modelsCount} available` : 'Unavailable'}
            color={modelsCount && modelsCount > 0 ? 'blue' : 'gray'}
            detail={modelsDetail || undefined}
          />
          <StatusCard
            icon={Zap}
            label="Skills"
            loading={skillsLoading}
            value={skillsCount !== null ? `${skillsCount} installed` : 'Unavailable'}
            color={skillsCount && skillsCount > 0 ? 'violet' : 'gray'}
          />
          <StatusCard
            icon={Radio}
            label="Channels"
            loading={channelsLoading}
            value={channelsCount !== null ? `${channelsCount} connected` : 'Unavailable'}
            color={channelsCount && channelsCount > 0 ? 'indigo' : 'gray'}
          />
        </div>
      </SettingsCard>
    </div>
  );
}

function StatusCard({
  icon: Icon,
  label,
  loading,
  value,
  color,
  detail,
  action,
}: {
  icon: React.ElementType;
  label: string;
  loading: boolean;
  value: string;
  color: 'emerald' | 'blue' | 'violet' | 'indigo' | 'amber' | 'gray';
  detail?: string;
  action?: React.ReactNode;
}) {
  const colorMap = {
    emerald: 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-600 dark:text-emerald-400 border-emerald-100 dark:border-emerald-900/50',
    blue: 'bg-blue-50 dark:bg-blue-950/40 text-blue-600 dark:text-blue-400 border-blue-100 dark:border-blue-900/50',
    violet: 'bg-violet-50 dark:bg-violet-950/40 text-violet-600 dark:text-violet-400 border-violet-100 dark:border-violet-900/50',
    indigo: 'bg-indigo-50 dark:bg-indigo-950/40 text-indigo-600 dark:text-indigo-400 border-indigo-100 dark:border-indigo-900/50',
    amber: 'bg-amber-50 dark:bg-amber-950/40 text-amber-600 dark:text-amber-400 border-amber-100 dark:border-amber-900/50',
    gray: 'bg-gray-50 dark:bg-gray-800/40 text-gray-400 border-gray-100 dark:border-gray-700/50',
  };
  const dotColor = {
    emerald: 'bg-emerald-500',
    blue: 'bg-blue-500',
    violet: 'bg-violet-500',
    indigo: 'bg-indigo-500',
    amber: 'bg-amber-500',
    gray: 'bg-gray-300 dark:bg-gray-600',
  };

  return (
    <div className={cn('rounded-xl border p-4 transition-all', colorMap[color])}>
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-2.5">
          <Icon className="h-4 w-4" />
          <span className="text-[12px] font-semibold uppercase tracking-wide opacity-70">{label}</span>
        </div>
        {action}
      </div>
      <div className="mt-3 flex items-center gap-2">
        {loading ? (
          <div className="h-4 w-24 bg-current/10 rounded animate-pulse" />
        ) : (
          <>
            <span className={cn('h-2 w-2 rounded-full', dotColor[color])} />
            <span className="text-sm font-semibold">{value}</span>
          </>
        )}
      </div>
      {detail && !loading && (
        <p className="text-[11px] mt-1.5 opacity-60 truncate">{detail}</p>
      )}
    </div>
  );
}


// =============================================================================
// Delete Account Dialog
// =============================================================================
function DeleteAccountDialog({ onClose }: { onClose: () => void }) {
  const [confirmValue, setConfirmValue] = useState('');
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState('');

  const hostname = typeof window !== 'undefined' ? window.location.hostname : '';
  const expected = hostname;
  const canDelete = confirmValue === expected;

  const handleDelete = async () => {
    if (!canDelete) return;
    setIsDeleting(true);
    setError('');
    try {
      const res = await fetch('/api/users/me', { method: 'DELETE', credentials: 'include' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error || 'Failed to delete account');
      }
      // Clear local state and redirect to main site
      try { localStorage.clear(); } catch {}
      try { sessionStorage.clear(); } catch {}
      const rootDomain = process.env.NEXT_PUBLIC_ROOT_DOMAIN || 'mawadao.com';
      window.location.replace(`https://${rootDomain}`);
    } catch (err) {
      setError((err as Error).message);
      setIsDeleting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="relative w-full max-w-md mx-4 bg-background border border-border rounded-2xl shadow-2xl p-6">
        <button
          onClick={onClose}
          className="absolute top-4 right-4 text-muted-foreground hover:text-foreground transition-colors"
          aria-label="Close"
        >
          <X className="h-4 w-4" />
        </button>

        <div className="flex items-center gap-3 mb-4">
          <div className="p-2 bg-red-100 dark:bg-red-900/30 rounded-xl">
            <Trash2 className="h-5 w-5 text-red-600 dark:text-red-400" />
          </div>
          <div>
            <h2 className="text-[15px] font-bold text-foreground">Delete Account</h2>
            <p className="text-[12px] text-muted-foreground">This action is permanent and cannot be undone.</p>
          </div>
        </div>

        <div className="space-y-4">
          <p className="text-[13px] text-foreground/80">
            Deleting your account will permanently remove:
          </p>
          <ul className="text-[12px] text-muted-foreground space-y-1 list-disc list-inside">
            <li>Your profile and all account data</li>
            <li>Your AI agent and its deployment</li>
            <li>All conversations and chat history</li>
            <li>All provider API keys</li>
          </ul>

          <div className="space-y-2">
            <label className="text-[13px] font-semibold text-foreground/80">
              Type <span className="font-mono text-red-600 dark:text-red-400">{expected}</span> to confirm
            </label>
            <Input
              value={confirmValue}
              onChange={(e) => setConfirmValue(e.target.value)}
              placeholder={expected}
              className="h-11 rounded-xl border-red-200 dark:border-red-900/50 font-mono text-[13px]"
              autoFocus
            />
          </div>

          {error && (
            <p className="text-[12px] text-red-600 dark:text-red-400">{error}</p>
          )}

          <div className="flex gap-3 pt-1">
            <Button
              variant="outline"
              onClick={onClose}
              disabled={isDeleting}
              className="flex-1 h-10 rounded-xl text-[13px] font-semibold"
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={!canDelete || isDeleting}
              className="flex-1 h-10 rounded-xl text-[13px] font-semibold gap-2"
            >
              {isDeleting ? (
                <><Loader2 className="h-4 w-4 animate-spin" /> Deleting…</>
              ) : (
                <><Trash2 className="h-4 w-4" /> Delete Account</>
              )}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

// =============================================================================
// Account
// =============================================================================
function AccountSettings({ agent, user, onLogout }: { agent: any; user: any; onLogout: () => void }) {
  const router = useRouter();
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const name = user?.username || agent?.name || '';
  const status = agent?.status || (user?.isActive ? 'active' : 'unknown');
  const email = user?.email || '';
  const createdAt = user?.createdAt || agent?.createdAt;

  const handleLogout = () => {
    onLogout();
    router.push('/');
  };

  return (
    <div className="space-y-6">
      <SettingsCard title="Account" description="Manage your account settings.">
        <div className="space-y-6">
          <div className="space-y-2">
            <label className="text-[13px] font-semibold text-foreground/80">Username</label>
            <Input
              value={name}
              disabled
              className="h-11 rounded-xl border-border bg-muted text-muted-foreground"
            />
            <p className="text-[11px] text-muted-foreground">Usernames cannot be changed</p>
          </div>

          {email && (
            <div className="space-y-2">
              <label className="text-[13px] font-semibold text-foreground/80">Email</label>
              <Input
                value={email}
                disabled
                className="h-11 rounded-xl border-border bg-muted text-muted-foreground"
              />
            </div>
          )}

          <div className="space-y-2">
            <label className="text-[13px] font-semibold text-foreground/80">Account Status</label>
            <div className="flex items-center gap-2.5">
              <span
                className={cn(
                  'h-2.5 w-2.5 rounded-full shadow-sm',
                  status === 'active' ? 'bg-emerald-500 shadow-emerald-500/30' : 'bg-amber-500 shadow-amber-500/30',
                )}
              />
              <span className="text-[13px] font-medium capitalize text-foreground/80">{status}</span>
            </div>
          </div>

          {createdAt && (
            <div className="space-y-2">
              <label className="text-[13px] font-semibold text-foreground/80">Member Since</label>
              <p className="text-[13px] text-muted-foreground">{new Date(createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })}</p>
            </div>
          )}

          <div className="h-px bg-border" />

          <div className="space-y-2">
            <label className="text-[13px] font-semibold text-foreground/80">Session</label>
            <Button
              variant="outline"
              onClick={handleLogout}
              className="gap-2 h-10 rounded-xl text-[13px] font-semibold border-border hover:bg-muted transition-all duration-200"
            >
              <LogOut className="h-4 w-4" />
              Sign out
            </Button>
          </div>
        </div>
      </SettingsCard>

      <div className="bg-red-50/60 dark:bg-red-950/30 backdrop-blur-xl rounded-2xl border border-red-200/40 dark:border-red-900/40 overflow-hidden">
        <div className="px-7 py-6">
          <div className="flex items-center gap-2 mb-1">
            <AlertTriangle className="h-4 w-4 text-red-500" />
            <h2 className="text-[15px] font-bold text-red-900 dark:text-red-400">Danger Zone</h2>
          </div>
          <p className="text-[12px] text-red-600/70 dark:text-red-400/70 mb-4">Once you delete your account, there is no going back.</p>
          <Button
            variant="destructive"
            className="gap-2 h-10 rounded-xl text-[13px] font-semibold shadow-sm"
            onClick={() => setShowDeleteDialog(true)}
          >
            <Trash2 className="h-4 w-4" />
            Delete Account
          </Button>
        </div>
      </div>

      {showDeleteDialog && (
        <DeleteAccountDialog onClose={() => setShowDeleteDialog(false)} />
      )}
    </div>
  );
}

// =============================================================================
// Channel Connections — API key management per channel type
// =============================================================================

const CHANNEL_CREDENTIAL_FIELDS: Record<string, { key: string; label: string; placeholder: string; secret?: boolean; helpUrl?: string }[]> = {
  discord: [
    { key: 'token', label: 'Bot Token', placeholder: 'Paste your Discord bot token...', secret: true, helpUrl: 'https://discord.com/developers/applications' },
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
  whatsapp: [
    { key: 'phoneNumberId', label: 'Phone Number ID', placeholder: 'Your WhatsApp Business phone number ID' },
    { key: 'accessToken', label: 'Access Token', placeholder: 'Permanent or temporary access token', secret: true },
    { key: 'verifyToken', label: 'Webhook Verify Token', placeholder: 'Custom verify token for webhook', secret: true },
  ],
  signal: [
    { key: 'phoneNumber', label: 'Phone Number', placeholder: '+1234567890' },
    { key: 'apiUrl', label: 'Signal API URL', placeholder: 'http://localhost:8080 (signal-cli-rest-api)' },
  ],
  line: [
    { key: 'channelAccessToken', label: 'Channel Access Token', placeholder: 'Your LINE channel access token', secret: true },
    { key: 'channelSecret', label: 'Channel Secret', placeholder: 'Your LINE channel secret', secret: true },
  ],
  viber: [
    { key: 'authToken', label: 'Auth Token', placeholder: 'Your Viber bot auth token', secret: true },
    { key: 'botName', label: 'Bot Name', placeholder: 'Your Viber bot display name' },
  ],
  web: [
    { key: 'apiKey', label: 'API Key (optional)', placeholder: 'Custom API key for web widget auth', secret: true },
  ],
};

const CHANNEL_ICON_MAP: Record<string, React.ReactNode> = {
  discord: <SiDiscord className="h-4 w-4" />,
  slack: <SiSlack className="h-4 w-4" />,
  telegram: <SiTelegram className="h-4 w-4" />,
  whatsapp: <SiWhatsapp className="h-4 w-4" />,
  teams: <FaMicrosoft className="h-4 w-4" />,
  signal: <Shield className="h-4 w-4" />,
  line: <MessageCircle className="h-4 w-4" />,
  viber: <MessageCircle className="h-4 w-4" />,
  web: <Radio className="h-4 w-4" />,
};

/** All channel types are configurable via the settings tab */
const CONFIGURABLE_CHANNELS = CHANNEL_TYPES.filter(
  (ch) => !!CHANNEL_CREDENTIAL_FIELDS[ch.id]
);

function ChannelSettings({ agent }: { agent: any }) {
  const { data: savedChannels, isLoading, mutate: refreshSaved } = useSavedChannels();

  const [editChannel, setEditChannel] = useState<string | null>(null);
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [visibility, setVisibility] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [justSaved, setJustSaved] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  const savedMap = new Map(
    (savedChannels ?? []).map((c) => [c.channelType, c])
  );

  const resetEdit = useCallback(() => {
    setEditChannel(null);
    setCredentials({});
    setVisibility({});
    setSaveError('');
  }, []);

  const handleSave = useCallback(async (channelId: string) => {
    const fields = CHANNEL_CREDENTIAL_FIELDS[channelId] || [];
    const required = fields.filter((f) => !f.label.includes('optional'));
    const missing = required.find((f) => !credentials[f.key]?.trim());
    if (missing) {
      setSaveError(`${missing.label} is required`);
      return;
    }

    setSaving(true);
    setSaveError('');
    try {
      const credsTrimmed: Record<string, string> = {};
      for (const field of fields) {
        if (credentials[field.key]?.trim()) {
          credsTrimmed[field.key] = credentials[field.key].trim();
        }
      }

      const channelType = CHANNEL_TYPES.find((c) => c.id === channelId);
      await api.saveChannel({
        channelType: channelId,
        credentials: credsTrimmed,
        channelName: channelType?.label || channelId,
        agentId: agent?.id,
        metadata: { deployedAt: new Date().toISOString() },
      });

      // Also push to local gateway for live reload (silently skip if unreachable)
      try {
        const channelConfig: Record<string, unknown> = { enabled: true, ...credsTrimmed };
        // Apply sensible defaults so the channel works immediately
        if (channelId === 'discord') {
          channelConfig.groupPolicy = 'open';
          channelConfig.dm = { enabled: true, policy: 'open', allowFrom: ['*'] };
        } else if (channelId === 'telegram') {
          channelConfig.dmPolicy = 'open';
          channelConfig.groupPolicy = 'open';
          channelConfig.allowFrom = ['*'];
        } else {
          // Generic defaults for whatsapp, signal, line, viber, etc.
          channelConfig.dm = { enabled: true, policy: 'open', allowFrom: ['*'] };
        }
        const currentConfig = await configApi.configGet();
        const baseHash = (currentConfig as unknown as Record<string, unknown>)?.hash as string | undefined;
        await configApi.configPatch({ channels: { [channelId]: channelConfig } }, baseHash || undefined);
      } catch {
        // Gateway may not be available — DB + GCS sync is sufficient
      }

      resetEdit();
      setJustSaved(channelId);
      setTimeout(() => setJustSaved(null), 2500);
      refreshSaved();
    } catch (err) {
      setSaveError((err as Error).message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  }, [credentials, agent, resetEdit, refreshSaved]);

  const handleDisconnect = useCallback(async (channelId: string) => {
    setDeleting(channelId);
    try {
      // Push disable to gateway
      try {
        const currentConfig = await configApi.configGet();
        const baseHash = (currentConfig as unknown as Record<string, unknown>)?.hash as string | undefined;
        await configApi.configPatch({ channels: { [channelId]: { enabled: false } } }, baseHash || undefined);
      } catch {
        // Gateway unreachable — proceed with DB delete
      }
      await api.deleteChannel(channelId);
      refreshSaved();
    } catch (err) {
      console.error('Disconnect failed:', err);
    } finally {
      setDeleting(null);
    }
  }, [refreshSaved]);

  return (
    <SettingsCard
      title="Connected Channels"
      description="Connect messaging platforms by adding their API keys. Credentials are encrypted and synced to your openclaw.json configuration."
    >
      <div className="space-y-4">
        <div className="p-3 rounded-xl bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-800/40 text-[12px] text-blue-700 dark:text-blue-400 flex items-start gap-2">
          <Radio className="h-4 w-4 shrink-0 mt-0.5" />
          <span>Channel credentials are saved to the database and synced to your openclaw.json in GCS. The gateway picks up changes immediately.</span>
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-6">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="space-y-3">
            {CONFIGURABLE_CHANNELS.map((channelType) => {
              const existing = savedMap.get(channelType.id);
              const isEditing = editChannel === channelType.id;
              const wasJustSaved = justSaved === channelType.id;
              const isDeleting = deleting === channelType.id;
              const fields = CHANNEL_CREDENTIAL_FIELDS[channelType.id] || [];
              const isConnected = existing?.isActive === true;

              return (
                <div
                  key={channelType.id}
                  className={cn(
                    'rounded-xl border p-4 space-y-3 transition-colors',
                    isConnected ? 'border-border' : 'border-border/50 opacity-80'
                  )}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div
                        className="w-8 h-8 rounded-lg flex items-center justify-center text-white"
                        style={{ backgroundColor: channelType.color }}
                      >
                        {CHANNEL_ICON_MAP[channelType.id] || <MessageCircle className="h-4 w-4" />}
                      </div>
                      <div>
                        <span className="text-[13px] font-semibold text-foreground">{channelType.label}</span>
                        {isConnected && (
                          <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 dark:bg-emerald-900/40 text-emerald-600 dark:text-emerald-400 font-medium">
                            Connected
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {existing && isConnected ? (
                        <>
                          <span className="text-[11px] text-muted-foreground">
                            {existing.credentialKeys.map((k) => k).join(', ')}
                          </span>
                          <button
                            onClick={() => { setEditChannel(channelType.id); setCredentials({}); setVisibility({}); setSaveError(''); }}
                            className="text-[11px] text-primary hover:underline font-medium"
                          >
                            Edit
                          </button>
                          <button
                            onClick={() => handleDisconnect(channelType.id)}
                            disabled={isDeleting}
                            className="text-[11px] text-red-500 hover:underline font-medium disabled:opacity-50"
                          >
                            {isDeleting ? 'Removing…' : 'Disconnect'}
                          </button>
                        </>
                      ) : wasJustSaved ? (
                        <span className="text-[11px] text-emerald-600 font-medium flex items-center gap-1">
                          <Check className="h-3 w-3" /> Connected!
                        </span>
                      ) : (
                        <button
                          onClick={() => { setEditChannel(channelType.id); setCredentials({}); setVisibility({}); setSaveError(''); }}
                          className="text-[11px] text-primary hover:underline font-medium"
                        >
                          Connect
                        </button>
                      )}
                    </div>
                  </div>

                  {isEditing && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      className="space-y-3 pt-1"
                    >
                      {fields.map((field) => (
                        <div key={field.key} className="space-y-1.5">
                          <div className="flex items-center justify-between">
                            <label className="text-[12px] font-semibold text-foreground/80">{field.label}</label>
                            {field.helpUrl && (
                              <a
                                href={field.helpUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-[11px] text-primary hover:text-primary/80 flex items-center gap-1"
                              >
                                Get token <ExternalLink className="h-3 w-3" />
                              </a>
                            )}
                          </div>
                          <div className="relative">
                            <Input
                              type={field.secret && !visibility[field.key] ? 'password' : 'text'}
                              value={credentials[field.key] || ''}
                              onChange={(e) => { setCredentials((prev) => ({ ...prev, [field.key]: e.target.value })); setSaveError(''); }}
                              placeholder={field.placeholder}
                              className="h-10 rounded-xl border-border bg-background font-mono text-sm pr-10"
                            />
                            {field.secret && (
                              <button
                                type="button"
                                onClick={() => setVisibility((prev) => ({ ...prev, [field.key]: !prev[field.key] }))}
                                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                              >
                                {visibility[field.key] ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                              </button>
                            )}
                          </div>
                        </div>
                      ))}
                      {saveError && (
                        <p className="text-[11px] text-red-600">{saveError}</p>
                      )}
                      <div className="flex items-center gap-2">
                        <Button
                          size="sm"
                          disabled={saving || fields.filter((f) => !f.label.includes('optional')).some((f) => !credentials[f.key]?.trim())}
                          onClick={() => handleSave(channelType.id)}
                          className="gap-1.5 h-8 rounded-lg text-[12px] font-semibold"
                        >
                          {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
                          {existing ? 'Update & Deploy' : 'Save & Deploy'}
                        </Button>
                        <button
                          onClick={resetEdit}
                          className="text-[11px] text-muted-foreground hover:text-foreground"
                        >
                          Cancel
                        </button>
                      </div>
                      <p className="text-[11px] text-muted-foreground flex items-center gap-1">
                        <Shield className="h-3 w-3" /> Credentials are encrypted and stored securely
                      </p>
                    </motion.div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </SettingsCard>
  );
}

// =============================================================================
// Cloud Data Management
// =============================================================================
function CloudDataSettings() {
  return (
    <SettingsCard title="Data Management" description="Import local data or export a backup of your cloud workspace.">
      <DataManagement hasWorkspace={true} />
    </SettingsCard>
  );
}
