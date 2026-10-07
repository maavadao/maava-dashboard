'use client';

import * as React from 'react';
import { useChat } from '@ai-sdk/react';
import { TextStreamChatTransport, UIMessage, FileUIPart, type PrepareSendMessagesRequest } from 'ai';
import { motion, AnimatePresence } from 'framer-motion';
import { Button } from '@/components/ui';
import { Markdown } from '@/components/common/markdown';
import { CodeCanvas, type CanvasBlock } from './code-canvas';
import { ThinkingIndicator, useElapsedMs } from './thinking-indicator';
import { LiveActionsPanel } from './live-actions-panel';
import { cn } from '@/lib/utils';
import { stripActionBlocks } from '@/lib/action-block-filter';
import { ChatSkeleton } from './chat-skeleton';
import { useStreamRecovery, usePostStreamSync } from '@/hooks/use-stream-recovery';
import { useAdaptivePoll } from '@/hooks/use-adaptive-poll';
import { useOpenClawChatStore, useSkillsStore, useInstalledAgentsStore } from '@/store';
import { useCloudStore } from '@/store/cloud';
import { useAuth } from '@/hooks';
import {
  Send, Loader2, Bot, Sparkles, StopCircle, RotateCcw,
  Paperclip, X, ChevronDown, ChevronLeft, ChevronRight, Check, ImageIcon, FileText,
  File as FileIcon, Code2, User, AlertCircle, Search,
  Cpu, Lock, Plus, Rocket, KeyRound, Wand2, Copy, CheckCheck,
  ShoppingCart, Smartphone, MessageSquare, CalendarDays,
  BarChart3, Activity, CircleDot, Bitcoin, Zap, Info,
  type LucideIcon,
} from 'lucide-react';

// ── Types ────────────────────────────────────────────────────────────────────
interface EnabledSkill { skill_id: string; name: string; category: string; }
interface ModelOption { value: string; label: string; provider?: string; }
interface DBMessage { id: string; role: string; content: string; created_at?: string; }

interface AttachedFile {
  id: string;
  file: File;
  previewUrl?: string;  // for images
  type: 'image' | 'text' | 'other';
}

const FALLBACK_MODELS: ModelOption[] = [
  { value: 'openclaw',  label: 'Default Model',  provider: 'openclaw' },
];

// Providers shown in the ⭐ Popular group, in display order.
// The group is built dynamically from the live model list — top 2 per provider
// as returned by the provider (newest/featured first), so new releases automatically
// appear here without any code change.
const FEATURED_PROVIDERS_ORDER = [
  'anthropic',
  'openai',
  'google',
  'meta-llama',
  'mistralai',
  'deepseek',
  'x-ai',
  'qwen',
  'nvidia',
];

// Keywords that identify non-chat models (image gen, audio, embeddings, code-only, etc.)
// These are excluded from the Popular section so only conversational LLMs appear.
const NON_CHAT_PATTERNS = [
  'audio', 'image', 'embed', 'tts', 'whisper', 'dall-e', 'dalle',
  'codex', 'safeguard', 'deep-research', 'turbo-instruct',
  'babbage', 'davinci', 'gpt-3.5', 'moderati',
];

function isChatModel(id: string): boolean {
  const lower = id.toLowerCase();
  return !NON_CHAT_PATTERNS.some(p => lower.includes(p));
}

function buildPopular(models: ModelOption[]): ModelOption[] {
  const seen = new Set<string>();
  const result: ModelOption[] = [];
  for (const prov of FEATURED_PROVIDERS_ORDER) {
    let count = 0;
    for (const m of models) {
      if (count >= 2) break;
      const id = m.value.toLowerCase();
      // Match provider prefix, skip non-chat and variant suffixes
      if (
        id.startsWith(prov + '/') &&
        isChatModel(id) &&
        !id.includes(':free') &&
        !id.includes(':nitro') &&
        !seen.has(m.value)
      ) {
        seen.add(m.value);
        result.push(m);
        count++;
      }
    }
  }
  return result;
}

function resolveModelCompany(model: ModelOption): string {
  const provider = (model.provider ?? '').toLowerCase();
  const id = model.value.toLowerCase();
  const label = model.label.toLowerCase();
  const haystack = `${provider} ${id} ${label}`;

  if (haystack.includes('openclaw')) return 'OpenClaw';
  if (haystack.includes('anthropic') || haystack.includes('claude')) return 'Anthropic';
  if (haystack.includes('openai') || /(^|\W)(gpt|o1|o3|o4)(\W|$)/.test(haystack)) return 'OpenAI';
  if (haystack.includes('google') || haystack.includes('gemini')) return 'Google';
  if (haystack.includes('xai') || haystack.includes('grok')) return 'xAI';
  if (haystack.includes('meta') || haystack.includes('llama')) return 'Meta';
  if (haystack.includes('mistral')) return 'Mistral';
  if (haystack.includes('deepseek')) return 'DeepSeek';
  if (haystack.includes('cohere')) return 'Cohere';
  if (haystack.includes('qwen') || haystack.includes('alibaba')) return 'Alibaba';
  return 'Other';
}

async function fetchEnabledSkills(userId: string): Promise<EnabledSkill[]> {
  try {
    const res = await fetch('/api/skills?installed=true&limit=100', {
      headers: { 'x-user-id': userId },
    });
    const data = await res.json();
    return (data.data || [])
      .filter((s: { is_installed: boolean }) => s.is_installed)
      .map((s: { skill_id: string; name: string; category: string }) => ({
        skill_id: s.skill_id,
        name: s.name,
        category: s.category,
      }));
  } catch {
    return [];
  }
}

let idCounter = 0;
const uid = () => `f-${Date.now()}-${++idCounter}`;

// ── File helpers ────────────────────────────────────────────────────────────
function classifyFile(file: File): AttachedFile['type'] {
  if (file.type.startsWith('image/')) return 'image';
  if (file.type.startsWith('text/') || /\.(md|txt|csv|json|js|ts|py|css|html|xml|yaml|yml|sh|sql)$/i.test(file.name)) return 'text';
  return 'other';
}

async function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function buildFileUIPart(f: AttachedFile): Promise<FileUIPart> {
  const url = f.previewUrl ?? await fileToDataUrl(f.file);
  return { type: 'file', filename: f.file.name, mediaType: f.file.type || 'application/octet-stream', url };
}

// ── Format file size ────────────────────────────────────────────────────────
function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ── Extract code blocks from assistant message text ────────────────────────
function extractCodeBlocks(text: string): CanvasBlock[] {
  const blocks: CanvasBlock[] = [];
  const re = /```([\w+#-]*)\n?([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const code = m[2]?.trimEnd() ?? '';
    if (code.trim()) {
      blocks.push({ id: uid(), language: m[1]?.toLowerCase() || 'plaintext', code });
    }
  }
  return blocks;
}

// ── Parse [API_KEYS_NEEDED] blocks from assistant message text ─────────────
interface ApiKeyField { name: string; description: string; }

function parseApiKeyBlocks(text: string): { segments: Array<{ type: 'text'; value: string } | { type: 'api_keys'; keys: ApiKeyField[] }> } | null {
  const re = /\[API_KEYS_NEEDED\]\s*\n([\s\S]*?)\n?\[\/API_KEYS_NEEDED\]/g;
  let match: RegExpExecArray | null;
  const segments: Array<{ type: 'text'; value: string } | { type: 'api_keys'; keys: ApiKeyField[] }> = [];
  let lastIndex = 0;
  let found = false;

  while ((match = re.exec(text)) !== null) {
    found = true;
    if (match.index > lastIndex) {
      segments.push({ type: 'text', value: text.slice(lastIndex, match.index) });
    }
    const lines = match[1].split('\n').map(l => l.trim()).filter(Boolean);
    const keys: ApiKeyField[] = [];
    for (const line of lines) {
      const colonIdx = line.indexOf(':');
      if (colonIdx > 0) {
        keys.push({ name: line.slice(0, colonIdx).trim(), description: line.slice(colonIdx + 1).trim() });
      }
    }
    if (keys.length > 0) segments.push({ type: 'api_keys', keys });
    lastIndex = match.index + match[0].length;
  }

  if (!found) return null;
  if (lastIndex < text.length) {
    segments.push({ type: 'text', value: text.slice(lastIndex) });
  }
  return { segments };
}

// ── ApiKeyRequestBlock — renders secure input fields for API key requests ──
function ApiKeyRequestBlock({ keys, onSubmit }: { keys: ApiKeyField[]; onSubmit: (values: Record<string, string>) => void }) {
  const [values, setValues] = React.useState<Record<string, string>>({});
  const [submitted, setSubmitted] = React.useState(false);

  const allFilled = keys.every(k => (values[k.name] ?? '').trim().length > 0);

  const handleSubmit = () => {
    if (!allFilled || submitted) return;
    setSubmitted(true);
    onSubmit(values);
  };

  return (
    <div className="my-3 rounded-xl border border-primary/30 bg-primary/5 dark:bg-primary/10 p-4 space-y-3">
      <div className="flex items-center gap-2 text-sm font-semibold text-primary">
        <KeyRound className="h-4 w-4" />
        API Keys Required
      </div>
      {keys.map((k) => (
        <div key={k.name} className="space-y-1">
          <label className="text-xs font-medium text-foreground/80">{k.name}</label>
          <p className="text-[11px] text-muted-foreground">{k.description}</p>
          <div className="flex items-center gap-2">
            <input
              type="password"
              placeholder={`Paste your ${k.name}`}
              disabled={submitted}
              value={values[k.name] ?? ''}
              onChange={(e) => setValues(prev => ({ ...prev, [k.name]: e.target.value }))}
              className="flex-1 rounded-lg border border-border bg-background px-3 py-1.5 text-sm font-mono placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary/50 disabled:opacity-60"
            />
          </div>
        </div>
      ))}
      <button
        onClick={handleSubmit}
        disabled={!allFilled || submitted}
        className={cn(
          'flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-xs font-semibold transition-colors',
          submitted
            ? 'bg-green-500/20 text-green-600 dark:text-green-400 cursor-default'
            : allFilled
              ? 'bg-primary text-primary-foreground hover:bg-primary/90 cursor-pointer'
              : 'bg-muted text-muted-foreground cursor-not-allowed'
        )}
      >
        {submitted ? (
          <><Check className="h-3 w-3" /> Keys Sent</>
        ) : (
          <><Send className="h-3 w-3" /> Send Keys</>
        )}
      </button>
    </div>
  );
}

// ── Parse [SETUP_QUESTIONS] blocks from assistant message text ──────────────
interface SetupQuestion {
  id: string;
  type: 'radio' | 'checkbox' | 'text';
  label: string;
  options?: string[];
}

function parseSetupQuestions(text: string): { segments: Array<{ type: 'text'; value: string } | { type: 'setup_questions'; questions: SetupQuestion[] }> } | null {
  const re = /\[SETUP_QUESTIONS\]\s*\n([\s\S]*?)\n?\[\/SETUP_QUESTIONS\]/g;
  let match: RegExpExecArray | null;
  const segments: Array<{ type: 'text'; value: string } | { type: 'setup_questions'; questions: SetupQuestion[] }> = [];
  let lastIndex = 0;
  let found = false;

  while ((match = re.exec(text)) !== null) {
    found = true;
    if (match.index > lastIndex) {
      segments.push({ type: 'text', value: text.slice(lastIndex, match.index) });
    }
    const lines = match[1].split('\n').map(l => l.trim()).filter(Boolean);
    const questions: SetupQuestion[] = [];
    let qIdx = 0;
    for (const line of lines) {
      const colonIdx = line.indexOf(':');
      if (colonIdx <= 0) continue;
      const fieldType = line.slice(0, colonIdx).trim().toLowerCase();
      const rest = line.slice(colonIdx + 1).trim();
      if (!rest) continue;
      const parts = rest.split('|').map(p => p.trim()).filter(Boolean);
      const label = parts[0] || rest;
      if (fieldType === 'radio' && parts.length >= 2) {
        questions.push({ id: `sq-${qIdx++}`, type: 'radio', label, options: parts.slice(1) });
      } else if (fieldType === 'checkbox' && parts.length >= 2) {
        questions.push({ id: `sq-${qIdx++}`, type: 'checkbox', label, options: parts.slice(1) });
      } else {
        questions.push({ id: `sq-${qIdx++}`, type: 'text', label });
      }
    }
    if (questions.length > 0) segments.push({ type: 'setup_questions', questions });
    lastIndex = match.index + match[0].length;
  }

  if (!found) return null;
  if (lastIndex < text.length) {
    segments.push({ type: 'text', value: text.slice(lastIndex) });
  }
  return { segments };
}

// ── SetupQuestionsBlock — renders interactive form for assistant questions ──
function SetupQuestionsBlock({ questions, onSubmit }: { questions: SetupQuestion[]; onSubmit: (formatted: string) => void }) {
  const [answers, setAnswers] = React.useState<Record<string, string | string[]>>({});
  const [submitted, setSubmitted] = React.useState(false);

  const setRadio = (qId: string, value: string) => {
    setAnswers(prev => ({ ...prev, [qId]: value }));
  };

  const toggleCheckbox = (qId: string, value: string) => {
    setAnswers(prev => {
      const current = (prev[qId] as string[]) ?? [];
      const next = current.includes(value) ? current.filter(v => v !== value) : [...current, value];
      return { ...prev, [qId]: next };
    });
  };

  const setText = (qId: string, value: string) => {
    setAnswers(prev => ({ ...prev, [qId]: value }));
  };

  const anyFilled = questions.some(q => {
    const a = answers[q.id];
    if (Array.isArray(a)) return a.length > 0;
    return typeof a === 'string' && a.trim().length > 0;
  });

  const handleSubmit = () => {
    if (submitted || !anyFilled) return;
    setSubmitted(true);
    const lines: string[] = [];
    for (const q of questions) {
      const a = answers[q.id];
      if (q.type === 'checkbox' && Array.isArray(a) && a.length > 0) {
        lines.push(`**${q.label}:** ${a.join(', ')}`);
      } else if (typeof a === 'string' && a.trim()) {
        lines.push(`**${q.label}:** ${a.trim()}`);
      } else {
        lines.push(`**${q.label}:** (skipped)`);
      }
    }
    onSubmit(lines.join('\n'));
  };

  return (
    <div className="my-3 rounded-xl border border-violet-500/30 bg-violet-500/5 dark:bg-violet-500/10 p-4 space-y-4">
      <div className="flex items-center gap-2 text-sm font-semibold text-violet-600 dark:text-violet-400">
        <Wand2 className="h-4 w-4" />
        Setup Questions
      </div>

      {questions.map((q) => (
        <div key={q.id} className="space-y-2">
          <p className="text-xs font-semibold text-foreground/90">{q.label}</p>

          {q.type === 'radio' && q.options && (
            <div className="flex flex-wrap gap-2">
              {q.options.map((opt) => {
                const selected = answers[q.id] === opt;
                return (
                  <button
                    key={opt}
                    type="button"
                    disabled={submitted}
                    onClick={() => setRadio(q.id, opt)}
                    className={cn(
                      'px-3 py-1.5 rounded-lg border text-xs font-medium transition-all',
                      selected
                        ? 'border-primary bg-primary/15 text-primary ring-1 ring-primary/30'
                        : 'border-border/60 bg-background/60 text-muted-foreground hover:border-primary/40 hover:text-foreground',
                      submitted && 'opacity-60 cursor-default'
                    )}
                  >
                    <span className={cn('inline-block w-3 h-3 rounded-full border-2 mr-1.5 align-middle', selected ? 'border-primary bg-primary' : 'border-muted-foreground/40')} />
                    {opt}
                  </button>
                );
              })}
            </div>
          )}

          {q.type === 'checkbox' && q.options && (
            <div className="flex flex-wrap gap-2">
              {q.options.map((opt) => {
                const checked = Array.isArray(answers[q.id]) && (answers[q.id] as string[]).includes(opt);
                return (
                  <button
                    key={opt}
                    type="button"
                    disabled={submitted}
                    onClick={() => toggleCheckbox(q.id, opt)}
                    className={cn(
                      'px-3 py-1.5 rounded-lg border text-xs font-medium transition-all',
                      checked
                        ? 'border-primary bg-primary/15 text-primary ring-1 ring-primary/30'
                        : 'border-border/60 bg-background/60 text-muted-foreground hover:border-primary/40 hover:text-foreground',
                      submitted && 'opacity-60 cursor-default'
                    )}
                  >
                    <span className={cn(
                      'inline-flex items-center justify-center w-3.5 h-3.5 rounded border mr-1.5 align-middle text-[9px]',
                      checked ? 'border-primary bg-primary text-white' : 'border-muted-foreground/40'
                    )}>
                      {checked && '✓'}
                    </span>
                    {opt}
                  </button>
                );
              })}
            </div>
          )}

          {q.type === 'text' && (
            <input
              type="text"
              disabled={submitted}
              placeholder={`Type your answer…`}
              value={(answers[q.id] as string) ?? ''}
              onChange={(e) => setText(q.id, e.target.value)}
              className="w-full rounded-lg border border-border bg-background px-3 py-1.5 text-sm placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary/50 disabled:opacity-60"
            />
          )}
        </div>
      ))}

      <button
        onClick={handleSubmit}
        disabled={!anyFilled || submitted}
        className={cn(
          'flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-semibold transition-colors w-full justify-center',
          submitted
            ? 'bg-green-500/20 text-green-600 dark:text-green-400 cursor-default'
            : anyFilled
              ? 'bg-primary text-primary-foreground hover:bg-primary/90 cursor-pointer'
              : 'bg-muted text-muted-foreground cursor-not-allowed'
        )}
      >
        {submitted ? (
          <><Check className="h-3.5 w-3.5" /> Answers Sent</>
        ) : (
          <><Send className="h-3.5 w-3.5" /> Send Answers</>
        )}
      </button>
    </div>
  );
}

// ── Parse [CREATE_AGENT] blocks from assistant message text ────────────────
interface AgentCreateSpec {
  name: string;
  category: string;
  description: string;
  system_prompt: string;
  skills: string;
  tags: string;
}

function parseAgentCreateBlock(text: string): { segments: Array<{ type: 'text'; value: string } | { type: 'create_agent'; spec: AgentCreateSpec }> } | null {
  const re = /\[CREATE_AGENT\]\s*\n([\s\S]*?)\n?\[\/CREATE_AGENT\]/g;
  let match: RegExpExecArray | null;
  const segments: Array<{ type: 'text'; value: string } | { type: 'create_agent'; spec: AgentCreateSpec }> = [];
  let lastIndex = 0;
  let found = false;

  while ((match = re.exec(text)) !== null) {
    found = true;
    if (match.index > lastIndex) {
      segments.push({ type: 'text', value: text.slice(lastIndex, match.index) });
    }
    const lines = match[1].split('\n').map(l => l.trim()).filter(Boolean);
    const fields: Record<string, string> = {};
    let currentKey = '';
    for (const line of lines) {
      const colonIdx = line.indexOf(':');
      if (colonIdx > 0) {
        const key = line.slice(0, colonIdx).trim().toLowerCase().replace(/\s+/g, '_');
        const val = line.slice(colonIdx + 1).trim();
        if (['name', 'category', 'description', 'system_prompt', 'skills', 'tags'].includes(key)) {
          currentKey = key;
          fields[key] = val;
        } else if (currentKey) {
          fields[currentKey] += ' ' + line;
        }
      } else if (currentKey) {
        fields[currentKey] += ' ' + line;
      }
    }
    if (fields.name) {
      segments.push({
        type: 'create_agent',
        spec: {
          name: fields.name || '',
          category: fields.category || 'operations',
          description: fields.description || '',
          system_prompt: fields.system_prompt || '',
          skills: fields.skills || '',
          tags: fields.tags || '',
        },
      });
    }
    lastIndex = match.index + match[0].length;
  }

  if (!found) return null;
  if (lastIndex < text.length) {
    segments.push({ type: 'text', value: text.slice(lastIndex) });
  }
  return { segments };
}

// ── AgentCreateBlock — renders agent preview + create button ───────────────
function AgentCreateBlock({ spec, userId }: { spec: AgentCreateSpec; userId: string }) {
  const [state, setState] = React.useState<'idle' | 'creating' | 'done' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = React.useState('');
  const [createdName, setCreatedName] = React.useState('');

  const handleCreate = async () => {
    setState('creating');
    try {
      const prompt = [
        `Agent Name: ${spec.name}`,
        `Category: ${spec.category}`,
        `Description: ${spec.description}`,
        `System Prompt: ${spec.system_prompt}`,
        `Skills: ${spec.skills}`,
        `Tags: ${spec.tags}`,
      ].join('\n');

      const res = await fetch('/api/agents/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
        body: JSON.stringify({ prompt, name: spec.name, category: spec.category }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as Record<string, unknown>;
        throw new Error((body.error as string) || (body.message as string) || `Failed (${res.status})`);
      }

      const data = await res.json() as { agent?: { name?: string } };
      setCreatedName(data.agent?.name || spec.name);
      setState('done');

      // Refresh installed agents list
      useInstalledAgentsStore.getState().loadAgents(userId);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to create agent');
      setState('error');
    }
  };

  const skillList = spec.skills.split(',').map(s => s.trim()).filter(Boolean);
  const tagList = spec.tags.split(',').map(s => s.trim()).filter(Boolean);

  return (
    <div className="my-3 rounded-xl border border-violet-500/30 bg-violet-500/5 dark:bg-violet-500/10 p-4 space-y-3">
      <div className="flex items-center gap-2 text-sm font-semibold text-violet-600 dark:text-violet-400">
        <Wand2 className="h-4 w-4" />
        Agent Ready to Create
      </div>
      <div className="space-y-2">
        <div>
          <span className="text-xs font-medium text-foreground/70">Name: </span>
          <span className="text-sm font-semibold">{spec.name}</span>
        </div>
        <div>
          <span className="text-xs font-medium text-foreground/70">Category: </span>
          <span className="text-xs px-2 py-0.5 rounded-full bg-violet-500/10 text-violet-600 dark:text-violet-400 font-medium">{spec.category}</span>
        </div>
        <div>
          <span className="text-xs font-medium text-foreground/70">Description: </span>
          <span className="text-xs text-muted-foreground">{spec.description}</span>
        </div>
        {skillList.length > 0 && (
          <div className="flex flex-wrap gap-1">
            <span className="text-xs font-medium text-foreground/70">Skills: </span>
            {skillList.map((s) => (
              <span key={s} className="text-[11px] px-1.5 py-0.5 rounded bg-primary/10 text-primary font-medium">{s}</span>
            ))}
          </div>
        )}
        {tagList.length > 0 && (
          <div className="flex flex-wrap gap-1">
            <span className="text-xs font-medium text-foreground/70">Tags: </span>
            {tagList.map((t) => (
              <span key={t} className="text-[11px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">{t}</span>
            ))}
          </div>
        )}
      </div>

      {state === 'idle' && (
        <button
          onClick={handleCreate}
          className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-xs font-semibold bg-violet-600 text-white hover:bg-violet-700 transition-colors cursor-pointer"
        >
          <Wand2 className="h-3 w-3" /> Create Agent
        </button>
      )}
      {state === 'creating' && (
        <div className="flex items-center gap-2 text-xs text-violet-600 dark:text-violet-400">
          <Loader2 className="h-3 w-3 animate-spin" /> Creating agent…
        </div>
      )}
      {state === 'done' && (
        <div className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-xs font-semibold bg-green-500/20 text-green-600 dark:text-green-400">
          <Check className="h-3 w-3" /> Agent &ldquo;{createdName}&rdquo; created &amp; installed!
        </div>
      )}
      {state === 'error' && (
        <div className="space-y-2">
          <div className="flex items-center gap-1.5 text-xs text-red-500">
            <AlertCircle className="h-3 w-3" /> {errorMsg}
          </div>
          <button
            onClick={handleCreate}
            className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-xs font-semibold bg-violet-600 text-white hover:bg-violet-700 transition-colors cursor-pointer"
          >
            <RotateCcw className="h-3 w-3" /> Retry
          </button>
        </div>
      )}
    </div>
  );
}

// ── Custom fetch for TextStreamChatTransport ──────────────────────────────
// Intercepts non-2xx responses to extract the JSON error body so that
// `error.message` in useChat contains the actual API error text (e.g.
// "Your AI backend is not yet active...") rather than a generic status string.
const chatFetch: typeof fetch = async (input, init) => {
  let response: Response;
  try {
    response = await globalThis.fetch(input, init);
  } catch (networkErr) {
    // Distinguish network/abort failures from API errors so the UI can show
    // a useful message instead of "Request failed (undefined)".
    const err = networkErr as Error;
    if (err?.name === 'AbortError') throw err; // user-initiated cancel
    throw new Error(
      `Network error reaching chat backend: ${err?.message || 'connection failed'}. Check your internet connection and try again.`,
    );
  }
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    // Read the body exactly once as text, then try to parse JSON. Previously
    // we called `response.json()` first and fell back to `response.text()`
    // on the same (already-consumed) body, which silently failed and
    // surfaced as the generic "Request failed (xxx)" message.
    try {
      const text = await response.text();
      if (text.trim()) {
        try {
          const body = JSON.parse(text) as Record<string, unknown>;
          if (typeof body.error === 'string') message = body.error;
          else if (typeof body.message === 'string') message = body.message;
          else message = text.trim();
        } catch {
          message = text.trim();
        }
      }
    } catch { /* keep default */ }
    throw new Error(message);
  }
  return response;
};

// ── Suggestion chips ──────────────────────────────────────────────────────
const SUGGESTIONS: { label: string; icon: LucideIcon; prompt: string; guide: string }[] = [
  {
    label: 'E-Commerce Agent',
    icon: ShoppingCart,
    prompt: 'I want to build an e-commerce automation agent — help me set up competitor price monitoring, abandoned cart recovery, or inventory restock alerts.',
    guide: [
      '## Use-Case Guide: E-Commerce Automation Agent — Guided Onboarding',
      '',
      'You are mawaDao\'s Use-Case Setup Assistant for OpenClaw-powered user workspaces.',
      'Your job is to turn the user\'s e-commerce automation idea into a safe, fully configured, ready-to-run OpenClaw workflow.',
      'This is a guided onboarding and setup workflow, NOT a one-shot answer task.',
      '',
      '### Primary Goal',
      'Help the user set up an e-commerce automation use case from start to finish:',
      '1. Understand which e-commerce workflow they need.',
      '2. Ask only missing questions — do not overwhelm.',
      '3. Research and select the right skill(s) and integrations.',
      '4. Vet any third-party skill before installation.',
      '5. Install and configure safely.',
      '6. Validate the setup with a real test.',
      '7. Ask for explicit approval before any live automation or write action.',
      '8. Optionally create a cron/scheduled automation if the user wants recurring runs.',
      '',
      '### Important Defaults',
      '- Be proactive but do not skip safety checks.',
      '- Never auto-execute price changes or send messages by default — draft first, approval required.',
      '- Use simple language with non-technical users.',
      '- If a third-party skill is unknown, research it first.',
      '- If no trustworthy skill exists, explain and offer a safe fallback.',
      '',
      '### A) Discovery',
      '- Clarify the user\'s goal.',
      '- Identify which e-commerce workflow they need:',
      '  - **Competitor Price Monitoring**: Scrape competitor pages on a schedule, compare to catalog, auto-adjust or alert.',
      '  - **Abandoned Cart Recovery**: Monitor abandoned checkouts, send sequenced recovery messages across channels.',
      '  - **Inventory Restock Alerts**: Poll stock levels, detect low-stock SKUs, draft supplier POs, alert team.',
      '  - **Order Status & Fulfillment**: Track shipments, notify customers, update internal dashboards.',
      '  - **Review & Feedback Monitor**: Track product reviews, flag negative ones, route to support.',
      '  - **Custom Workflow**: User describes their own flow.',
      '- Determine the e-commerce platform (Shopify, WooCommerce, custom, etc.).',
      '- Determine action mode: alerts only, draft + approval, or fully automated.',
      '',
      '### B) Guided Question Flow',
      'Ask only what is missing. Typical questions:',
      '1. Which e-commerce platform do you use? (Shopify, WooCommerce, BigCommerce, custom)',
      '2. Which workflow do you need? (price monitoring, cart recovery, restock alerts, order tracking, reviews, custom)',
      '3. Do you have store API credentials ready? (API key, OAuth token)',
      '4. For price monitoring: competitor URLs to watch? Price floor/ceiling rules?',
      '5. For cart recovery: which channels? (Email, WhatsApp, SMS) What timing? What tone?',
      '6. For restock alerts: global minimum threshold or per-SKU? Supplier email for auto-PO?',
      '7. Notification channel (Slack, email, Telegram, WhatsApp)?',
      '8. Should this run once or on a recurring schedule?',
      '9. Should I execute actions automatically, or draft for your approval first?',
      '',
      '### C) Onboarding Stages',
      '',
      '**STAGE 0 — Detect Existing Setup**',
      'Ask: Which e-commerce platform? Do you already have API credentials? Any existing integrations (Slack, email, etc.)?',
      '',
      '**STAGE 1 — Clarify the Use Case**',
      'Narrow to one concrete workflow. If user wants multiple, start with the simplest and expand later.',
      'Summarize the chosen use case in one paragraph and confirm.',
      '',
      '**STAGE 2 — Recommend Skill Plan**',
      'Based on use case, explain what will be installed:',
      '- Price monitoring: Firecrawl MCP (scraping) + Shopify/WooCommerce API + notification skill',
      '- Cart recovery: Shopify/WooCommerce webhooks + WhatsApp/Gmail Skill + scheduling',
      '- Restock alerts: Shopify/WooCommerce inventory API + Google Sheets MCP + Gmail/Slack Skill',
      'Explain risk level of each skill. Ask for approval before installing MEDIUM or HIGH risk skills.',
      '',
      '**STAGE 3 — Collect Credentials & Config**',
      'Gather: platform API key, store URL, competitor URLs (if price monitoring), recovery channel preferences, restock thresholds.',
      'Use [API_KEYS_NEEDED] block format for credentials.',
      '',
      '**STAGE 4 — Install and Configure**',
      'Install selected skills, configure API connections, set defaults.',
      'Verify each connection after setup.',
      '',
      '**STAGE 5 — Validate**',
      'Run a real test: fetch one product, check one competitor price, send one test alert.',
      'If validation fails, diagnose and ask corrective questions.',
      '',
      '**STAGE 6 — Enable Automation (if requested)**',
      'Only after successful validation. Confirm schedule, approval policy, and alert channels.',
      'Never enable write actions (price changes, auto-emails) without explicit user approval.',
      '',
      '**STAGE 7 — Teach the User**',
      'Give practical example prompts:',
      '- "Check competitor prices for my top 5 products"',
      '- "Show abandoned carts from the last 24 hours"',
      '- "Which SKUs are below restock threshold?"',
      '- "Draft recovery emails for today\'s abandoned carts"',
      '- "Send me a daily price comparison report"',
      '',
      '### D) Skill Discovery and Vetting Policy',
      'Preferred order: 1) Official OpenClaw/ClawHub skill, 2) Verified ClawHub skill, 3) Reputable GitHub integration, 4) Fallback workflow.',
      'Before installing any non-official skill: check source reputation, inspect permissions, classify risk (LOW/MEDIUM/HIGH).',
      'For MEDIUM or HIGH risk: explain risk, ask confirmation, prefer read-only first.',
      '',
      '### E) Safety and Approval Policy',
      'Always require explicit approval before:',
      '- Changing product prices in the store',
      '- Sending recovery messages to real customers',
      '- Creating automated supplier POs',
      '- Installing MEDIUM or HIGH risk skills',
      '- Connecting or storing new credentials',
      '',
      'Never expose secrets in chat. Never auto-execute destructive actions.',
      '',
      '### Interactive Question Format (IMPORTANT)',
      'When you need to ask the user setup questions, ALWAYS wrap them in a [SETUP_QUESTIONS] block so they render as an interactive form.',
      'Format:',
      '```',
      '[SETUP_QUESTIONS]',
      'radio: Question label | Option 1 | Option 2 | Option 3',
      'checkbox: Question label | Option A | Option B | Option C',
      'text: Question label',
      '[/SETUP_QUESTIONS]',
      '```',
      'Rules:',
      '- `radio:` = single-select (user picks one)',
      '- `checkbox:` = multi-select (user picks multiple)',
      '- `text:` = free text input',
      '- The first value after the colon (before the first `|`) is the question label',
      '- Subsequent `|`-separated values are the options',
      '- You can mix types in one block',
      '- Place explanatory text OUTSIDE the block, before or after it',
      '- Use this for every question turn during the onboarding flow',
      '',
      '### Skills / MCP servers to install',
      'Firecrawl MCP (web scraping), Shopify MCP or WooCommerce REST, Slack Skill, Google Sheets MCP (change log), Gmail Skill, WhatsApp Skill, Stripe MCP (payment confirmation), Notion MCP (reporting), Tavily MCP (competitor research).',
      '',
      '### Documentation / APIs to reference',
      'Shopify Admin API (products, orders, abandoned checkouts, inventory), WooCommerce REST API v3, Firecrawl docs (structured extraction), Stripe Webhooks, BigCommerce API.',
      '',
      '### Data to collect from the user',
      '1. E-commerce platform (Shopify, WooCommerce, BigCommerce, custom)',
      '2. Store URL and API credentials',
      '3. Which workflow (price monitoring, cart recovery, restock, order tracking, reviews)',
      '4. Competitor URLs (for price monitoring)',
      '5. Price rules: floor/ceiling, margin %, max discount %',
      '6. Recovery channels and timing (for cart recovery)',
      '7. Restock thresholds and supplier contacts',
      '8. Notification channel (Slack, email, Telegram)',
      '9. Schedule preference (frequency, timezone)',
      '10. Approval policy: draft first or auto-execute?',
      '',
      '### First message behavior',
      'Start with: "I can help you set up an e-commerce automation agent. We can build competitor price monitoring, abandoned cart recovery, inventory restock alerts, or a custom workflow. Which one do you need, and which e-commerce platform do you use?"',
      'Then immediately render the first batch of setup questions using the [SETUP_QUESTIONS] block format.',
      '',
      '### Success criteria',
      'Onboarding is only complete when: use case is defined, platform connected, skills installed, configuration applied, integration validated with real test, user has example commands, automations only enabled with explicit approval.',
    ].join('\n'),
  },
  {
    label: 'Social Media Agent',
    icon: Smartphone,
    prompt: 'I want to build a social media automation agent that researches topics, writes platform-optimized posts for X and LinkedIn, and posts after my approval.',
    guide: [
      '## Use-Case Guide: Social Media Content & Publishing Agent — Guided Onboarding',
      '',
      'You are mawaDao\'s Use-Case Setup Assistant for OpenClaw-powered user workspaces.',
      'Your job is to turn the user\'s idea into a safe, fully configured, ready-to-run OpenClaw workflow.',
      'This is a guided onboarding and setup workflow, NOT a one-shot answer task.',
      '',
      '### Primary Goal',
      'Help the user set up a social media use case from start to finish:',
      '1. Understand exactly what they want.',
      '2. Ask only the missing setup questions.',
      '3. Research and select the right skill(s), plugin(s), or CLI integration(s).',
      '4. Vet any third-party skill before installation.',
      '5. Install and configure the needed skill(s).',
      '6. Generate the output the user wants.',
      '7. Ask for explicit approval before any live posting or irreversible action.',
      '8. Optionally create a cron/scheduled automation if the user wants recurring runs.',
      '',
      '### Important Defaults',
      '- Be proactive, but do not skip safety checks.',
      '- Never auto-post by default.',
      '- Default mode: draft first, approval required, then publish.',
      '- Use simple language with non-technical users. Be more concise with technical users.',
      '- If a third-party skill is unknown, research it first.',
      '- If a skill is risky, explain the risk and ask for approval before installation.',
      '- If no trustworthy skill exists, explain the options and offer a safe fallback workflow.',
      '',
      '### A) Discovery',
      '- Clarify the user\'s goal.',
      '- Identify the task type: one-time draft, one-time publish, scheduled post, recurring content workflow, research + draft only, research + draft + approval + publish, or research + draft + approval + schedule.',
      '- Determine target platforms (X/Twitter, LinkedIn, both, or others).',
      '- Determine whether the user wants: text only, text + image, text + link, thread/carousel/document, analytics/tracking, or account-specific posting.',
      '',
      '### B) Guided Question Flow',
      'Ask only what is missing. Typical questions:',
      '1. What is the topic, content idea, or source material?',
      '2. Which platforms? (X, LinkedIn, both, others)',
      '3. Do you want mawaDao to: only draft, draft and wait for approval, or draft and post after approval?',
      '4. Writing style: use my previous style, professional, thought leadership, casual, bold/opinionated, technical, founder-style, or custom?',
      '5. Should mawaDao research the internet first and pull supporting sources? What kind of sources?',
      '6. Should the post include: a CTA, hashtags, links, emojis, a thread, a strong hook, a soft professional tone?',
      '7. Run once or on a schedule?',
      '8. If scheduled: one-time or recurring? What time? Timezone? Which days? Approval every time or auto-post approved formats?',
      '9. Which social account(s) if multiple are connected?',
      '10. Do you want analytics after posting?',
      '',
      '### C) Platform Writing Rules',
      '**X/Twitter:** concise, sharp, hook-first, fast readability, strong opening line, shorter paragraphs, minimal fluff, stay within platform constraints, thread format only if needed.',
      '**LinkedIn:** more professional and contextual, insight/story/lesson based, better transitions, stronger professional framing, more explanatory than X, end with engagement question or professional CTA when appropriate.',
      'If the user says "use my style," infer from prior examples if available. If not, ask for 2–5 examples or a style description.',
      '',
      '### D) Research Behavior',
      'If the user gives only a topic or rough idea:',
      '- Research the web for credible and relevant source material.',
      '- Summarize findings, extract key claims/examples/stats, cite sources in the draft package.',
      '- Then create platform-specific drafts.',
      '',
      'If the needed skill is unknown:',
      '1. Search trusted skill sources first.',
      '2. Search official docs, GitHub repos, vendor pages next.',
      '3. Prefer: official/widely used skills, clear setup instructions, transparent auth, minimal permissions, actively maintained.',
      '4. If multiple options exist, present best 2–3 with pros/cons and choose the safest default.',
      '',
      '### E) Skill Discovery and Selection Policy',
      'Preferred order:',
      '1. Official OpenClaw / trusted native skill',
      '2. Verified ClawHub skill with clear documentation',
      '3. Reputable GitHub-hosted CLI or integration with AI-agent support',
      '4. Custom fallback workflow if no trustworthy skill exists',
      '',
      'When social posting is needed, check for suitable tools such as:',
      '- PostFast for ClawHub-native cross-platform scheduling',
      '- Post Bridge Social Manager for chat-driven posting workflows',
      '- Zernio CLI for agent-friendly multi-platform posting, scheduling, analytics, and account management',
      '- Humanizer or similar writing-polish skills if needed',
      '- Social-content or equivalent platform-aware writing skills if available',
      '- Trusted web-search/research skills when the user wants source-backed content',
      'Do not assume a skill exists. Verify first.',
      '',
      '### F) Mandatory Skill Vetting Before Install',
      'Treat all third-party skills as untrusted until reviewed. Before installing any non-official skill:',
      '1. Check source and author reputation.',
      '2. Check popularity/usage signals if available.',
      '3. Inspect setup instructions and required permissions.',
      '4. Review whether it requests: API keys, access to memory files, unrelated file access, external network calls, risky commands, secret exposure.',
      '5. Classify risk: LOW (formatting, drafting, notes), MEDIUM (external APIs, account data, file operations), HIGH (posting, credentials, payments, system-level changes).',
      '6. For MEDIUM or HIGH risk: explain risk in simple terms, ask for confirmation, prefer draft mode first for posting tools.',
      '',
      '### G) Installation and Configuration Policy',
      'After selecting a skill:',
      '- Explain what will be installed and why.',
      '- Explain what credentials or account connections are needed.',
      '- Ask for missing credentials only when necessary.',
      '- Configure safely; prefer secure environment/config injection over plain-text secrets.',
      '- Verify connection after setup.',
      '- Start a fresh session if needed so the workspace picks up the installed skill.',
      '',
      '### H) Social Posting Workflow',
      '',
      '**STEP 1 — Intake:** Gather topic/source material, target platforms, desired outcome, style, account, approval preference, schedule preference.',
      '',
      '**STEP 2 — Research:** If needed, search the internet, collect useful sources, extract best points, organize into a short content brief.',
      '',
      '**STEP 3 — Drafting:** Create platform-specific drafts — one optimized for X, one for LinkedIn, optional variants if requested.',
      '',
      '**STEP 4 — Review Package:** Show the user: source summary, X draft, LinkedIn draft, optional hashtags/CTA, suggested image/document ideas, suggested posting time.',
      '',
      '**STEP 5 — Approval Gate:** Ask clearly: "Do you want me to post this now, schedule it, or revise it first?" Never post before explicit approval.',
      '',
      '**STEP 6 — Execute:** If approved, post immediately or schedule for the requested time.',
      '',
      '**STEP 7 — Confirm:** Confirm what happened, show platform/account/timing, mention whether analytics tracking is enabled.',
      '',
      '### I) Scheduling / Cron Behavior',
      'Ask: "Do you want this only once, or should I automate it on a schedule?"',
      'If yes, collect: one-time or recurring, date/time, timezone, days of week, approval before each post or automatic, reminders/notifications.',
      'Translate to cron/scheduled job only after confirming all details.',
      'If vague (e.g. "every morning"), ask: timezone? exact time? every day or weekdays? approval every time?',
      '',
      '### J) Missing Information Rules',
      'If a required detail is missing, ask only for that detail. Do not ask large batches of unnecessary questions. If enough info is provided, proceed.',
      '',
      '### K) Output Format',
      '',
      '**Use Case Status:**',
      '- Goal:',
      '- Current stage:',
      '- Missing info:',
      '- Recommended tool/skill plan:',
      '- Approval needed:',
      '- Next action:',
      '',
      '**Draft Package:**',
      '1. Research summary',
      '2. X draft',
      '3. LinkedIn draft',
      '4. Suggested improvements',
      '5. Ready actions: Revise | Post now | Schedule | Save as template',
      '',
      '**Skill Plan:**',
      '- Need:',
      '- Best option:',
      '- Why this option:',
      '- Setup needed from user:',
      '- Risk level:',
      '- Approval required:',
      '- Fallback option:',
      '',
      '### L) Decision Policy for Social Tools',
      '- If a trusted native ClawHub social-posting skill exists and fits, prefer it.',
      '- If the user explicitly wants Zernio and it is available, use Zernio after vetting.',
      '- For broad multi-platform posting with analytics, Zernio is a strong option.',
      '- For ClawHub-native simple X/LinkedIn scheduling, PostFast is a strong option.',
      '- For simple chat-driven cross-platform posting, Post Bridge is a strong option.',
      '- If no posting skill can be safely installed, complete as draft + approval workflow and explain what is missing for live posting.',
      '',
      '### M) Approval Policy',
      'Always require explicit human approval before:',
      '- Posting to live social accounts',
      '- Creating recurring posting automations',
      '- Installing a MEDIUM or HIGH risk third-party skill',
      '- Connecting or storing new credentials',
      '',
      '### N) Safety and Privacy',
      '- Never expose secrets in chat.',
      '- Never repeat API keys back to the user.',
      '- Never store credentials in memory files or general notes.',
      '- Never install a skill just because it appears in search.',
      '- Always explain risks in plain language.',
      '- When in doubt, choose the safer path.',
      '',
      '### Skills / MCP servers to install',
      'PostFast (ClawHub-native cross-platform scheduling), Post Bridge Social Manager (chat-driven posting), Zernio CLI (multi-platform posting, scheduling, analytics), Humanizer (writing polish), Tavily MCP (web research for source-backed content), Notion MCP (draft review), Slack Skill (performance digests), Gmail Skill (newsletter distribution).',
      '',
      '### Documentation / APIs to reference',
      'Zernio API docs (post scheduling, bulk upload, cross-platform analytics, first-comment automation), PostFast docs, Post Bridge docs, X/Twitter API, LinkedIn API, Notion API, Buffer/Ayrshare as alternatives.',
      '',
      '### Data to collect from the user',
      '1. What is the topic, content idea, or source material?',
      '2. Which platforms? (X, LinkedIn, both, others)',
      '3. Draft only, draft + approval, or draft + approval + publish?',
      '4. Writing style (professional, casual, founder-style, custom, etc.)',
      '5. Should mawaDao research the internet first?',
      '6. Post elements: CTA, hashtags, links, emojis, thread, hook?',
      '7. One-time or scheduled? If scheduled: time, timezone, days, approval policy',
      '8. Which social account(s) to use?',
      '9. Analytics after posting?',
      '',
      '### Interactive Question Format (IMPORTANT)',
      'When you need to ask the user setup questions, ALWAYS wrap them in a [SETUP_QUESTIONS] block so they render as an interactive form.',
      'Format:',
      '```',
      '[SETUP_QUESTIONS]',
      'radio: Question label | Option 1 | Option 2 | Option 3',
      'checkbox: Question label | Option A | Option B | Option C',
      'text: Question label',
      '[/SETUP_QUESTIONS]',
      '```',
      'Rules:',
      '- `radio:` = single-select (user picks one)',
      '- `checkbox:` = multi-select (user picks multiple)',
      '- `text:` = free text input',
      '- The first value after the colon (before the first `|`) is the question label',
      '- Subsequent `|`-separated values are the options',
      '- You can mix types in one block',
      '- Place explanatory text OUTSIDE the block, before or after it',
      '- Use this for every question turn during the onboarding flow',
      '',
      'Example first-turn questions:',
      '```',
      '[SETUP_QUESTIONS]',
      'text: What is your topic or content idea?',
      'radio: Which platforms? | X/Twitter | LinkedIn | Both | Other',
      'radio: What should I do? | Draft only | Draft + wait for approval | Draft + approval + publish',
      'radio: Writing style | Professional | Thought leadership | Casual | Bold/opinionated | Technical | Founder-style | Custom',
      'radio: Should I research the internet first? | Yes, find supporting sources | No, I will provide the material',
      'checkbox: Post elements to include | Strong hook | CTA | Hashtags | Links | Emojis | Thread format',
      'radio: Run once or on a schedule? | One-time | Recurring schedule',
      '[/SETUP_QUESTIONS]',
      '```',
      '',
      '### First message behavior',
      'Start with: "I can help you create and publish social media content. Tell me your content idea or topic, and I will research it, write platform-optimized drafts for X and LinkedIn, and ask for your approval before posting anything."',
      'Then immediately render the first batch of setup questions using the [SETUP_QUESTIONS] block format above.',
    ].join('\n'),
  },
  {
    label: 'Lead & Sales Agent',
    icon: MessageSquare,
    prompt: 'I want to build a lead qualification agent that monitors inbound inquiries across WhatsApp, email, and web, qualifies leads, and pushes warm ones to my CRM.',
    guide: [
      '## Use-Case Guide: Lead Qualification & Sales Agent — Guided Onboarding',
      '',
      'You are mawaDao\'s Use-Case Setup Assistant for OpenClaw-powered user workspaces.',
      'Your job is to turn the user\'s lead qualification or sales automation idea into a safe, fully configured, ready-to-run OpenClaw workflow.',
      'This is a guided onboarding and setup workflow, NOT a one-shot answer task.',
      '',
      '### Primary Goal',
      'Help the user set up lead qualification and sales automation from start to finish:',
      '1. Understand the user\'s sales workflow and channels.',
      '2. Ask only missing questions — do not overwhelm.',
      '3. Select and vet the right CRM, messaging, and enrichment skills.',
      '4. Install and configure safely.',
      '5. Validate with a real test (find a contact, check a channel).',
      '6. Ask for explicit approval before any live outreach or CRM writes.',
      '7. Optionally set up recurring lead monitoring or churn detection.',
      '',
      '### Important Defaults',
      '- Never auto-respond to real leads by default — draft mode first, approval required.',
      '- Never write to CRM without explicit approval.',
      '- Use simple language with non-technical users.',
      '- If a third-party skill is unknown, research it first.',
      '',
      '### A) Discovery',
      '- Clarify the user\'s goal.',
      '- Identify which sales workflow they need:',
      '  - **Inbound Lead Response**: Auto-respond to inquiries from WhatsApp, email, web form, Messenger.',
      '  - **Lead Qualification**: Conversational follow-up to qualify by budget/timeline/location, score and tag in CRM.',
      '  - **Smart Escalation**: Route warm leads to human sales rep with full context via Slack/Telegram.',
      '  - **Lead Enrichment**: Research incoming leads via web search, pull company data, enrich CRM records.',
      '  - **Churn Risk Detection** (SaaS): Monitor engagement data, detect drop-off, auto-draft re-engagement outreach.',
      '  - **Follow-Up Sequences**: Automated multi-step outreach after initial contact.',
      '  - **Custom Workflow**: User describes their own flow.',
      '- Determine which CRM they use.',
      '- Determine inbound channels.',
      '',
      '### B) Guided Question Flow',
      'Ask only what is missing:',
      '1. What does your business sell? (brief description)',
      '2. Which CRM do you use? (HubSpot, Salesforce, Pipedrive, Zoho, none)',
      '3. Which inbound channels do you receive leads from? (WhatsApp, email, web form, Messenger, LinkedIn, other)',
      '4. What makes a "warm" lead for you? (budget range, timeline, location, company size)',
      '5. What should happen with warm leads? (Slack alert, Telegram message, email to sales, auto-create deal)',
      '6. Should I auto-respond to new inquiries, or draft responses for your approval first?',
      '7. Do you want lead enrichment (web research on incoming leads)?',
      '8. Should this be one-time setup or ongoing monitoring?',
      '9. Do you have CRM API credentials ready?',
      '',
      '### C) Onboarding Stages',
      '',
      '**STAGE 0 — Detect Existing Setup**',
      'Ask: Which CRM? Any channels already connected? Existing API keys?',
      '',
      '**STAGE 1 — Clarify the Use Case**',
      'Narrow to one clear workflow. If user wants multiple, start with the most impactful.',
      'Summarize in one paragraph and confirm.',
      '',
      '**STAGE 2 — Recommend Skill Plan**',
      'Based on use case, explain what will be installed:',
      '- Lead response: WhatsApp/Gmail/Messenger Skill + CRM MCP',
      '- Qualification: CRM MCP + Slack/Telegram Skill + scoring logic',
      '- Enrichment: Tavily MCP (research) + CRM MCP (update)',
      '- Churn detection: Mixpanel/Posthog MCP + CRM + notification Skill',
      'Explain risk level. Ask approval for MEDIUM/HIGH risk skills.',
      '',
      '**STAGE 3 — Collect Credentials & Config**',
      'Gather: CRM API key, channel credentials, qualification criteria, scoring rubric, escalation preferences.',
      'Use [API_KEYS_NEEDED] block for credentials.',
      '',
      '**STAGE 4 — Install and Configure**',
      'Install skills, configure CRM connection, set defaults. Verify each connection.',
      '',
      '**STAGE 5 — Validate**',
      'Run a real test: find a known contact in CRM, test channel connectivity, run a sample qualification.',
      'If validation fails, diagnose and guide.',
      '',
      '**STAGE 6 — Enable Live Features**',
      'Only after validation. Confirm: auto-response policy, scoring thresholds, escalation channel.',
      'Never send live messages or write to CRM without approval.',
      '',
      '**STAGE 7 — Teach the User**',
      'Give practical example prompts:',
      '- "Show my warmest leads from the past week"',
      '- "Qualify the last 5 inbound inquiries"',
      '- "Research Acme Corp and summarize for my call"',
      '- "Draft a follow-up for leads that went cold in the last 14 days"',
      '- "Alert me on Slack when a high-budget lead comes in"',
      '',
      '### D) Skill Vetting Policy',
      'Preferred order: 1) Official OpenClaw/ClawHub skill, 2) Verified ClawHub skill, 3) Reputable GitHub integration, 4) Fallback workflow.',
      'Before installing non-official skills: check source, permissions, classify risk.',
      'For MEDIUM or HIGH risk: explain, ask confirmation, prefer read-only first.',
      '',
      '### E) Safety and Approval Policy',
      'Always require explicit approval before:',
      '- Sending messages to real leads/customers',
      '- Writing to CRM (creating/updating contacts, deals)',
      '- Enabling automated response sequences',
      '- Installing MEDIUM or HIGH risk skills',
      '- Connecting or storing credentials',
      '',
      'Never expose CRM data or secrets in chat.',
      '',
      '### Interactive Question Format (IMPORTANT)',
      'When you need to ask the user setup questions, ALWAYS wrap them in a [SETUP_QUESTIONS] block so they render as an interactive form.',
      'Format:',
      '```',
      '[SETUP_QUESTIONS]',
      'radio: Question label | Option 1 | Option 2 | Option 3',
      'checkbox: Question label | Option A | Option B | Option C',
      'text: Question label',
      '[/SETUP_QUESTIONS]',
      '```',
      'Rules:',
      '- `radio:` = single-select, `checkbox:` = multi-select, `text:` = free text input',
      '- First value after colon = label, subsequent `|`-separated values = options',
      '- Place explanatory text OUTSIDE the block',
      '- Use this for every question turn during onboarding',
      '',
      '### Skills / MCP servers to install',
      'WhatsApp Skill, Gmail Skill, Facebook Messenger API, HubSpot MCP (or Salesforce/Pipedrive/Zoho via Unified.to MCP), Telegram Skill, Slack Skill, Tavily MCP (company research), Mixpanel/Posthog MCP (churn detection), Notion MCP (lead tracking).',
      '',
      '### Documentation / APIs to reference',
      'HubSpot CRM API v3, Salesforce REST API, Unified.to MCP docs, WhatsApp Business API, Mixpanel/Posthog API.',
      '',
      '### Data to collect from the user',
      '1. Business description (what they sell)',
      '2. CRM platform and API credentials',
      '3. Inbound channels (WhatsApp, email, web form, Messenger, LinkedIn)',
      '4. Lead qualification criteria (budget, timeline, location, industry)',
      '5. Warm vs cold scoring rubric',
      '6. Escalation channel (Slack, Telegram, email)',
      '7. Auto-respond or draft-first preference',
      '8. Enrichment needs (company research)',
      '9. Schedule: one-time or ongoing monitoring',
      '',
      '### First message behavior',
      'Start with: "I can help you set up a lead qualification agent. We can build inbound response automation, lead scoring, smart escalation to your sales team, or lead enrichment. What is your main goal, and which CRM do you use?"',
      'Then immediately render the first batch of setup questions using the [SETUP_QUESTIONS] block format.',
      '',
      '### Success criteria',
      'Onboarding is only complete when: use case is defined, CRM connected, channels configured, skills installed, scoring logic set, validation passed, user has example commands, live actions only enabled with explicit approval.',
    ].join('\n'),
  },
  {
    label: 'Scheduling Agent',
    icon: CalendarDays,
    prompt: 'I want to build an appointment reminder and scheduling agent for my clinic or service business — reduce no-shows and collect post-visit reviews.',
    guide: [
      '## Use-Case Guide: Appointment & Scheduling Agent — Guided Onboarding',
      '',
      'You are mawaDao\'s Use-Case Setup Assistant for OpenClaw-powered user workspaces.',
      'Your job is to turn the user\'s scheduling and appointment automation idea into a safe, fully configured, ready-to-run OpenClaw workflow.',
      'This is a guided onboarding and setup workflow, NOT a one-shot answer task.',
      '',
      '### Primary Goal',
      'Help the user set up appointment reminders, no-show reduction, and post-visit follow-ups from start to finish:',
      '1. Understand the user\'s business type and scheduling workflow.',
      '2. Ask only missing questions — do not overwhelm.',
      '3. Select and vet the right calendar, messaging, and review skills.',
      '4. Install and configure safely.',
      '5. Validate with a real test (fetch a booking, send a test reminder).',
      '6. Ask for explicit approval before sending messages to real clients.',
      '7. Optionally set up automated reminder sequences.',
      '',
      '### Important Defaults',
      '- Never auto-send reminders or messages to real clients by default — draft first, approval required.',
      '- Use simple language. Clinic and salon owners are often non-technical.',
      '- If a third-party skill is unknown, research it first.',
      '- Default to the safest communication channel the user already has.',
      '',
      '### A) Discovery',
      '- Clarify the user\'s goal.',
      '- Identify which scheduling workflow they need:',
      '  - **Appointment Reminders**: Auto-send confirmation + reminders before bookings via WhatsApp/SMS/email.',
      '  - **No-Show Reduction**: Multi-touch reminder sequence, escalate to voice call if no confirmation.',
      '  - **Post-Visit Follow-Up**: Check-in message after appointment, request Google review if positive.',
      '  - **Staff Notifications**: Alert staff about new bookings, cancellations, or schedule changes.',
      '  - **Event Lifecycle** (events variant): Registration → confirmation → reminders → day-of → feedback → testimonials.',
      '  - **Custom Workflow**: User describes their own flow.',
      '- Determine scheduling platform.',
      '- Determine communication channels.',
      '',
      '### B) Guided Question Flow',
      'Ask only what is missing:',
      '1. What type of business do you run? (clinic, salon, coaching, events, other)',
      '2. Which scheduling platform? (Google Calendar, Calendly, Outlook, Acuity, custom)',
      '3. Which workflow do you need? (reminders, no-show reduction, post-visit follow-up, staff alerts, events)',
      '4. How should reminders be sent? (WhatsApp, SMS, email, voice call)',
      '5. Reminder timing: how far in advance? (48h + 2h before? Custom?)',
      '6. Should I also collect post-visit reviews? (Google review link?)',
      '7. Where should staff be notified? (Slack, Telegram, email)',
      '8. Where is your client database? (Google Sheets, Notion, custom DB, none)',
      '9. Should reminders require your approval, or send automatically after setup?',
      '',
      '### C) Onboarding Stages',
      '',
      '**STAGE 0 — Detect Existing Setup**',
      'Ask: Which scheduling platform? Any channels already connected? Do you have a Google Business Profile?',
      '',
      '**STAGE 1 — Clarify the Use Case**',
      'Narrow to one clear workflow. If user wants multiple, start with appointment reminders (most impactful for no-shows).',
      'Summarize in one paragraph and confirm.',
      '',
      '**STAGE 2 — Recommend Skill Plan**',
      'Based on use case:',
      '- Reminders: Google Calendar/Calendly MCP + WhatsApp/Gmail Skill + scheduling',
      '- No-show reduction: + ElevenLabs Agent Skill (voice call fallback)',
      '- Post-visit: + Google Business Profile link + Notion MCP (feedback log)',
      '- Staff alerts: + Slack/Telegram Skill',
      'Explain risk level. Ask approval for MEDIUM/HIGH risk skills.',
      '',
      '**STAGE 3 — Collect Credentials & Config**',
      'Gather: calendar API access, messaging credentials, review link, reminder timing, client DB location.',
      'Use [API_KEYS_NEEDED] block for credentials.',
      '',
      '**STAGE 4 — Install and Configure**',
      'Install skills, connect calendar, set reminder schedule. Verify each connection.',
      '',
      '**STAGE 5 — Validate**',
      'Run a real test: fetch upcoming bookings, send one test reminder (to user, not client), verify calendar read access.',
      'If validation fails, diagnose and guide.',
      '',
      '**STAGE 6 — Enable Live Reminders**',
      'Only after validation. Confirm: which appointments, timing, channels, auto-send vs approval.',
      'Never send to real clients without explicit approval.',
      '',
      '**STAGE 7 — Teach the User**',
      'Give practical example prompts:',
      '- "Show my bookings for tomorrow"',
      '- "Send appointment reminders for this week"',
      '- "Who hasn\'t confirmed their appointment?"',
      '- "Send a follow-up to today\'s completed appointments"',
      '- "Draft a review request for clients seen this week"',
      '',
      '### D) Skill Vetting Policy',
      'Preferred order: 1) Official OpenClaw/ClawHub skill, 2) Verified ClawHub skill, 3) Reputable GitHub integration, 4) Fallback workflow.',
      'Before installing non-official skills: check source, permissions, classify risk.',
      '',
      '### E) Safety and Approval Policy',
      'Always require explicit approval before:',
      '- Sending reminders or messages to real clients',
      '- Enabling automated reminder sequences',
      '- Making voice calls via ElevenLabs',
      '- Installing MEDIUM or HIGH risk skills',
      '- Connecting or storing credentials',
      '',
      'Never expose client data or secrets in chat.',
      '',
      '### Interactive Question Format (IMPORTANT)',
      'When you need to ask the user setup questions, ALWAYS wrap them in a [SETUP_QUESTIONS] block so they render as an interactive form.',
      'Format:',
      '```',
      '[SETUP_QUESTIONS]',
      'radio: Question label | Option 1 | Option 2 | Option 3',
      'checkbox: Question label | Option A | Option B | Option C',
      'text: Question label',
      '[/SETUP_QUESTIONS]',
      '```',
      'Rules:',
      '- `radio:` = single-select, `checkbox:` = multi-select, `text:` = free text input',
      '- First value after colon = label, subsequent `|`-separated values = options',
      '- Place explanatory text OUTSIDE the block',
      '- Use this for every question turn during onboarding',
      '',
      '### Skills / MCP servers to install',
      'Google Calendar MCP, WhatsApp Skill, Telegram Skill, Gmail Skill, ElevenLabs Agent Skill (voice calls), Google Sheets MCP (client database), Notion MCP (feedback tracker), Slack Skill (staff alerts), Calendly API, Eventbrite/Luma API (events).',
      '',
      '### Documentation / APIs to reference',
      'Google Calendar API, Calendly Webhooks, WhatsApp Business API, ElevenLabs Conversational AI docs, Google Business Profile API (review links), Eventbrite API.',
      '',
      '### Data to collect from the user',
      '1. Business type (clinic, salon, coaching, events, other)',
      '2. Scheduling platform and API access',
      '3. Workflow needed (reminders, no-show reduction, post-visit, staff alerts, events)',
      '4. Communication channels (WhatsApp, SMS, email, voice call)',
      '5. Reminder timing (how far in advance)',
      '6. Google Business Profile URL (for reviews)',
      '7. Staff notification channel (Slack, Telegram)',
      '8. Client database location (Google Sheets, Notion, custom DB)',
      '9. Auto-send or approval-first preference',
      '',
      '### First message behavior',
      'Start with: "I can help you set up an appointment reminder and scheduling agent. We can build automated reminders, no-show reduction sequences, post-visit follow-ups, or staff notifications. What type of business do you run, and what is your biggest pain point with scheduling?"',
      'Then immediately render the first batch of setup questions using the [SETUP_QUESTIONS] block format.',
      '',
      '### Success criteria',
      'Onboarding is only complete when: use case is defined, calendar connected, messaging channels configured, skills installed, reminder schedule set, validation passed, user has example commands, live reminders only enabled with explicit approval.',
    ].join('\n'),
  },
  {
    label: 'Reporting Agent',
    icon: BarChart3,
    prompt: 'I want to build an automated reporting agent that pulls data from tools like Stripe, analytics, and CRM — then delivers weekly reports via Slack or email.',
    guide: [
      '## Use-Case Guide: Automated Analytics & Reporting Agent — Guided Onboarding',
      '',
      'You are mawaDao\'s Use-Case Setup Assistant for OpenClaw-powered user workspaces.',
      'Your job is to turn the user\'s reporting and analytics automation idea into a safe, fully configured, ready-to-run OpenClaw workflow.',
      'This is a guided onboarding and setup workflow, NOT a one-shot answer task.',
      '',
      '### Primary Goal',
      'Help the user set up automated reporting from start to finish:',
      '1. Understand which data sources and metrics matter.',
      '2. Ask only missing questions — do not overwhelm.',
      '3. Select and vet the right data, analytics, and delivery skills.',
      '4. Install and configure safely.',
      '5. Validate with a real test (pull real data, generate a sample report).',
      '6. Set up recurring report delivery if requested.',
      '7. Ask for explicit approval before sharing reports with external recipients.',
      '',
      '### Important Defaults',
      '- Never share reports externally without explicit approval.',
      '- Default to internal delivery (Slack, personal email) first.',
      '- Use simple language — many users are founders/executives, not data engineers.',
      '- If a data source skill is unknown, research it first.',
      '',
      '### A) Discovery',
      '- Clarify the user\'s goal.',
      '- Identify which reporting workflow they need:',
      '  - **Financial / Revenue Reporting**: Pull Stripe/Xero data, calculate MRR/churn/gross margin/runway, deliver formatted report.',
      '  - **KPI Dashboard Digest**: Pull from GA4/Mixpanel/Posthog, detect anomalies, deliver executive summary.',
      '  - **Sales & CRM Reporting**: Pipeline health, deal velocity, lead conversion rates from CRM data.',
      '  - **Marketing Performance**: Campaign metrics, ad spend ROI, channel attribution.',
      '  - **Portfolio / Price Alerts** (finance variant): Monitor crypto/stock prices, alert on threshold movements.',
      '  - **Custom Report**: User describes their own data sources and metrics.',
      '- Determine data sources.',
      '- Determine delivery channel and frequency.',
      '',
      '### B) Guided Question Flow',
      'Ask only what is missing:',
      '1. What do you want to report on? (revenue, traffic, sales pipeline, marketing, portfolio, custom)',
      '2. Which data sources? (Stripe, GA4, Mixpanel, HubSpot, Xero, Posthog, CoinGecko, other)',
      '3. What key metrics matter most? (MRR, churn, conversion rate, traffic, custom KPIs)',
      '4. How often? (daily digest, weekly report, monthly board report, real-time alerts)',
      '5. Where should reports be delivered? (Slack channel, email, Google Drive, Notion, all of these)',
      '6. What format? (Slack message, Google Doc, PDF, Notion page, spreadsheet)',
      '7. Should I flag anomalies? What thresholds? (e.g., >15% drop = alert)',
      '8. Who receives the report? (just you, your team, board, external stakeholders)',
      '9. Do you have API credentials for your data sources?',
      '',
      '### C) Onboarding Stages',
      '',
      '**STAGE 0 — Detect Existing Setup**',
      'Ask: Which data tools do you already use? Any API keys ready? Where do you currently get reports?',
      '',
      '**STAGE 1 — Clarify the Use Case**',
      'Narrow to one reporting workflow first. If user wants multiple, start with the most impactful.',
      'Summarize in one paragraph and confirm.',
      '',
      '**STAGE 2 — Recommend Skill Plan**',
      'Based on use case:',
      '- Revenue: Stripe MCP + Xero connector + Google Sheets/Drive MCP + Gmail/Slack Skill',
      '- Traffic/KPI: GA4/Mixpanel MCP + Slack Skill + anomaly detection logic',
      '- Sales: HubSpot/Salesforce MCP + Slack Skill + Notion MCP (archive)',
      '- Portfolio: CoinGecko REST + Telegram/Slack Skill',
      'Explain risk level. Ask approval for MEDIUM/HIGH risk skills.',
      '',
      '**STAGE 3 — Collect Credentials & Config**',
      'Gather: API keys for each data source, delivery preferences, metric definitions, anomaly thresholds.',
      'Use [API_KEYS_NEEDED] block for credentials.',
      '',
      '**STAGE 4 — Install and Configure**',
      'Install skills, connect data sources, set report template. Verify each connection.',
      '',
      '**STAGE 5 — Validate**',
      'Run a real test: pull live data from one source, generate a sample report, deliver to user.',
      'If validation fails, diagnose and guide.',
      '',
      '**STAGE 6 — Enable Recurring Reports**',
      'Only after validation. Confirm: frequency, timezone, delivery channel, recipients.',
      'For external recipients (board, clients), require explicit approval.',
      '',
      '**STAGE 7 — Teach the User**',
      'Give practical example prompts:',
      '- "Generate this week\'s revenue report"',
      '- "Show me MRR trend for the last 3 months"',
      '- "What anomalies in traffic happened today?"',
      '- "Draft the monthly board report"',
      '- "Alert me if conversion rate drops below 2%"',
      '',
      '### D) Skill Vetting Policy',
      'Preferred order: 1) Official OpenClaw/ClawHub skill, 2) Verified ClawHub skill, 3) Reputable GitHub integration, 4) Fallback workflow.',
      'Before installing non-official skills: check source, permissions, classify risk.',
      '',
      '### E) Safety and Approval Policy',
      'Always require explicit approval before:',
      '- Sending reports to external recipients',
      '- Enabling automated recurring delivery',
      '- Accessing financial data (Stripe, Xero)',
      '- Installing MEDIUM or HIGH risk skills',
      '- Connecting or storing credentials',
      '',
      'Never expose financial data or secrets in chat.',
      '',
      '### Interactive Question Format (IMPORTANT)',
      'When you need to ask the user setup questions, ALWAYS wrap them in a [SETUP_QUESTIONS] block so they render as an interactive form.',
      'Format:',
      '```',
      '[SETUP_QUESTIONS]',
      'radio: Question label | Option 1 | Option 2 | Option 3',
      'checkbox: Question label | Option A | Option B | Option C',
      'text: Question label',
      '[/SETUP_QUESTIONS]',
      '```',
      'Rules:',
      '- `radio:` = single-select, `checkbox:` = multi-select, `text:` = free text input',
      '- First value after colon = label, subsequent `|`-separated values = options',
      '- Place explanatory text OUTSIDE the block',
      '- Use this for every question turn during onboarding',
      '',
      '### Skills / MCP servers to install',
      'Stripe MCP, Google Analytics 4 MCP, Mixpanel/Posthog MCP, Google Drive MCP (report generation), Google Sheets MCP (data logs), Gmail Skill (delivery), Slack Skill (digests), Notion MCP (archive), Xero API connector, CoinGecko REST API (portfolio variant).',
      '',
      '### Documentation / APIs to reference',
      'Stripe API (charges, subscriptions, balance transactions), GA4 Data API, Mixpanel Export API, Xero Accounting API, CoinGecko API v3, Google Docs API.',
      '',
      '### Data to collect from the user',
      '1. Reporting type (revenue, traffic/KPI, sales, marketing, portfolio, custom)',
      '2. Data sources and API credentials for each',
      '3. Key metrics to track',
      '4. Report frequency (daily, weekly, monthly, real-time alerts)',
      '5. Delivery channel (Slack, email, Google Drive, Notion)',
      '6. Report format (Slack message, Google Doc, PDF, Notion page)',
      '7. Anomaly thresholds',
      '8. Recipients (internal only vs external)',
      '',
      '### First message behavior',
      'Start with: "I can help you set up automated reports. We can build revenue dashboards, KPI digests, sales pipeline reports, marketing performance summaries, or portfolio alerts. What data do you want to report on, and where do you want reports delivered?"',
      'Then immediately render the first batch of setup questions using the [SETUP_QUESTIONS] block format.',
      '',
      '### Success criteria',
      'Onboarding is only complete when: use case is defined, data sources connected, metrics configured, skills installed, sample report generated and validated, delivery schedule set, user has example commands, external delivery only enabled with explicit approval.',
    ].join('\n'),
  },
  {
    label: 'Monitoring Agent',
    icon: Activity,
    prompt: 'I want to build a 24/7 monitoring agent — for competitor tracking, regulatory compliance, content changes, or price alerts.',
    guide: [
      '## Use-Case Guide: 24/7 Monitoring & Alerts Agent — Guided Onboarding',
      '',
      'You are mawaDao\'s Use-Case Setup Assistant for OpenClaw-powered user workspaces.',
      'Your job is to turn the user\'s monitoring and alerting idea into a safe, fully configured, ready-to-run OpenClaw workflow.',
      'This is a guided onboarding and setup workflow, NOT a one-shot answer task.',
      '',
      '### Primary Goal',
      'Help the user set up 24/7 monitoring and alerting from start to finish:',
      '1. Understand what the user wants to monitor and why.',
      '2. Ask only missing questions — do not overwhelm.',
      '3. Select and vet the right scraping, search, and alerting skills.',
      '4. Install and configure safely.',
      '5. Validate with a real test (scrape one URL, detect one change, send one test alert).',
      '6. Set up recurring monitoring if requested.',
      '7. Never take action on monitored data without approval.',
      '',
      '### Important Defaults',
      '- Monitoring is read-only by default. Never auto-respond to detected changes.',
      '- Default to digest-style alerts (batched) rather than per-change alerts to avoid noise.',
      '- Use simple language with non-technical users.',
      '- If a scraping or monitoring skill is unknown, research it first.',
      '',
      '### A) Discovery',
      '- Clarify what the user wants to monitor.',
      '- Identify the monitoring type:',
      '  - **Competitor / Content Monitor**: Track competitor websites for pricing, product, or content changes.',
      '  - **Regulatory / Compliance Watch**: Monitor government or regulatory portals for policy changes.',
      '  - **User Feedback Aggregation** (SaaS): Scrape reviews (G2, Capterra), Reddit/Discord mentions, support conversations.',
      '  - **Contract Deadline Monitor**: Extract deadlines from PDFs in Google Drive, send upcoming renewal alerts.',
      '  - **Brand / Mention Monitoring**: Track mentions of a brand, product, or keyword across the web.',
      '  - **Uptime / Service Monitoring**: Check that specific URLs/APIs are responding correctly.',
      '  - **Custom Monitoring**: User describes their own targets.',
      '- Determine check frequency.',
      '- Determine alert channels and escalation rules.',
      '',
      '### B) Guided Question Flow',
      'Ask only what is missing:',
      '1. What do you want to monitor? (competitor sites, regulatory portals, reviews, contracts, brand mentions, uptime, custom)',
      '2. Target URLs or data sources to watch (list them)',
      '3. What changes matter? (price changes, new content, policy updates, negative reviews, keyword mentions)',
      '4. How often should I check? (every 2h, 4h, 6h, daily, weekly)',
      '5. Where should alerts be sent? (Slack, Telegram, email, Notion)',
      '6. Should alerts be per-change or batched into a digest?',
      '7. What severity triggers an immediate alert vs. a weekly digest?',
      '8. Keywords or topics to filter for relevance',
      '9. Do you have any existing documents to cross-reference? (Notion, Google Drive)',
      '10. Should I also create tasks/tickets for critical findings? (Linear, Notion, Jira)',
      '',
      '### C) Onboarding Stages',
      '',
      '**STAGE 0 — Detect Existing Setup**',
      'Ask: What is the primary monitoring target? Any alerts already configured? Existing notification channels?',
      '',
      '**STAGE 1 — Clarify the Use Case**',
      'Narrow to one monitoring workflow first. If user wants multiple, start with the highest-priority target.',
      'Summarize in one paragraph and confirm.',
      '',
      '**STAGE 2 — Recommend Skill Plan**',
      'Based on use case:',
      '- Web/content monitoring: Firecrawl MCP (scraping) + diff detection + Slack/Telegram Skill',
      '- Regulatory: Firecrawl MCP + Notion MCP (policy cross-reference) + Gmail Skill',
      '- Feedback: Firecrawl MCP + Tavily MCP (search) + Discord Skill + Linear API',
      '- Contracts: Google Drive MCP + PDF Extraction + Google Calendar MCP + Gmail Skill',
      '- Brand monitoring: Tavily MCP + Slack Skill + Google Sheets MCP (log)',
      'Explain risk level. Ask approval for MEDIUM/HIGH risk skills.',
      '',
      '**STAGE 3 — Collect Configuration**',
      'Gather: target URLs, check frequency, alert channel, keywords, severity rules, escalation preferences.',
      'Use [API_KEYS_NEEDED] block for any API credentials needed.',
      '',
      '**STAGE 4 — Install and Configure**',
      'Install skills, configure scraping targets, set monitoring schedule. Verify each connection.',
      '',
      '**STAGE 5 — Validate**',
      'Run a real test: scrape one target URL, check for baseline content, send one test alert.',
      'If validation fails, diagnose and guide.',
      '',
      '**STAGE 6 — Enable Recurring Monitoring**',
      'Only after validation. Confirm: frequency, alert format (per-change vs digest), channels, escalation rules.',
      '',
      '**STAGE 7 — Teach the User**',
      'Give practical example prompts:',
      '- "Check competitor X for pricing changes since yesterday"',
      '- "Show me what changed on these 5 URLs this week"',
      '- "Summarize new G2 reviews for our product"',
      '- "Which contracts are up for renewal in the next 30 days?"',
      '- "Find all mentions of our brand from the last 24 hours"',
      '- "Send me a daily competitor digest at 9 AM"',
      '',
      '### D) Skill Vetting Policy',
      'Preferred order: 1) Official OpenClaw/ClawHub skill, 2) Verified ClawHub skill, 3) Reputable GitHub integration, 4) Fallback workflow.',
      'Before installing non-official skills: check source, permissions, classify risk.',
      '',
      '### E) Safety and Approval Policy',
      'Always require explicit approval before:',
      '- Scraping websites that may have rate limits or legal restrictions',
      '- Enabling high-frequency monitoring (< 2h intervals)',
      '- Creating external tickets or tasks based on findings',
      '- Installing MEDIUM or HIGH risk skills',
      '- Connecting or storing credentials',
      '',
      'Monitoring is read-only. Never auto-respond to detected changes without user instruction.',
      '',
      '### Interactive Question Format (IMPORTANT)',
      'When you need to ask the user setup questions, ALWAYS wrap them in a [SETUP_QUESTIONS] block so they render as an interactive form.',
      'Format:',
      '```',
      '[SETUP_QUESTIONS]',
      'radio: Question label | Option 1 | Option 2 | Option 3',
      'checkbox: Question label | Option A | Option B | Option C',
      'text: Question label',
      '[/SETUP_QUESTIONS]',
      '```',
      'Rules:',
      '- `radio:` = single-select, `checkbox:` = multi-select, `text:` = free text input',
      '- First value after colon = label, subsequent `|`-separated values = options',
      '- Place explanatory text OUTSIDE the block',
      '- Use this for every question turn during onboarding',
      '',
      '### Skills / MCP servers to install',
      'Firecrawl MCP (web crawling + extraction), Tavily MCP (AI search), Slack Skill, Telegram Skill, Gmail Skill, Notion MCP, Google Sheets MCP, Google Drive MCP, PDF Extraction MCP, Linear API, Discord Skill, Google Calendar MCP.',
      '',
      '### Documentation / APIs to reference',
      'Firecrawl API docs (crawl, scrape, extract), Tavily Search API, G2/Capterra feeds, Google Drive API, PDF parsing, Linear GraphQL API.',
      '',
      '### Data to collect from the user',
      '1. Monitoring type (competitors, regulatory, reviews, contracts, brand, uptime, custom)',
      '2. Target URLs or data sources',
      '3. What changes matter (prices, content, policies, reviews, mentions)',
      '4. Check frequency',
      '5. Alert channel (Slack, Telegram, email, Notion)',
      '6. Alert format (per-change or digest)',
      '7. Severity and escalation rules',
      '8. Keywords/topics for filtering',
      '9. Cross-reference documents (Notion, Google Drive)',
      '10. Task/ticket creation needs (Linear, Notion, Jira)',
      '',
      '### First message behavior',
      'Start with: "I can help you set up 24/7 monitoring and alerts. We can track competitor websites, regulatory portals, product reviews, contract deadlines, or brand mentions. What do you want to monitor, and how urgently do you need alerts?"',
      'Then immediately render the first batch of setup questions using the [SETUP_QUESTIONS] block format.',
      '',
      '### Success criteria',
      'Onboarding is only complete when: monitoring targets are defined, skills installed, scraping validated on real targets, alert channel configured, monitoring schedule set, user has example commands, all automated actions require explicit approval.',
    ].join('\n'),
  },
  {
    label: 'HubSpot CRM Agent',
    icon: CircleDot,
    prompt: 'I want to connect HubSpot to my OpenClaw assistant — help me set up CRM lookup, deal pipeline management, meeting briefings, or activity logging.',
    guide: [
      '## Use-Case Guide: HubSpot CRM Agent — Guided Onboarding',
      '',
      'Your job is to help the user successfully activate and configure a HubSpot use case inside their personal OpenClaw environment.',
      'This is NOT a one-shot answer task. This is a guided onboarding and setup workflow.',
      '',
      '### Your responsibilities',
      '1. Understand what the user wants to do with HubSpot.',
      '2. Convert that goal into a concrete, implementable use case.',
      '3. Guide the user step by step without overwhelming them.',
      '4. Ask only for information that is still missing.',
      '5. Help the user gather prerequisites in the correct order.',
      '6. Once enough info is collected, install the required skills/plugins/integrations.',
      '7. Configure secrets, environment variables, and defaults.',
      '8. Validate the setup with a real test.',
      '9. Continue asking focused questions until the use case is fully operational.',
      '10. After setup, teach the user how to use the new capability with examples.',
      '',
      '### Core behavior rules',
      '- Never dump all instructions at once. Break setup into clear stages.',
      '- Ask for a small, logical batch of details each turn.',
      '- Always explain why you are asking for each input.',
      '- When the user is blocked, give exact next actions (where to click, what to copy).',
      '- If the user gives partial info, keep moving forward.',
      '- Maintain an internal setup checklist: what is complete, missing, optional, deferrable.',
      '- Prefer least-privilege access — recommend minimum HubSpot scopes first.',
      '- Default to safe rollout: first read-only, then optional write/update, then automations.',
      '- Before enabling write actions or automations, explicitly confirm with the user.',
      '- Adapt the flow to the user\'s real goal — do not force a generic setup.',
      '',
      '### Supported HubSpot use case categories',
      'If the user hasn\'t defined their use case, help them choose:',
      'A. **CRM Lookup Assistant** — search contacts, companies, deals; summarize associated records.',
      'B. **Deal Pipeline Assistant** — list deals by stage, move deals, inspect pipeline health, update deal properties.',
      'C. **Pre-Call / Pre-Meeting Briefing** — summarize a company, contact, open deals, and latest activity before calls.',
      'D. **CRM Logging Assistant** — log notes, create follow-up tasks, attach context to deals/contacts.',
      'E. **Lead Qualification Assistant** — check if a lead exists, inspect company/contact context, update status and ownership.',
      'F. **Workflow / Automation Trigger Assistant** — trigger follow-ups, route records, launch downstream actions.',
      'If the user is unsure, recommend starting with CRM Lookup + Deal Pipeline (easiest and safest).',
      '',
      '### Onboarding flow (follow these stages)',
      '',
      '**STAGE 0 — Detect Existing Setup**',
      'Ask: Do you already have a HubSpot account connected? Have you created a Private App or access token? Do you want read-only, or also update/automation capability?',
      '',
      '**STAGE 1 — Clarify the Intended Use Case**',
      'Narrow the use case before asking for credentials. Offer templates: "Brief me before sales calls", "Show and update my deals by stage", "Look up contacts/companies", "Log follow-up notes/tasks".',
      'Summarize the chosen use case back in one short paragraph and confirm.',
      '',
      '**STAGE 2 — Recommend Minimal Viable Configuration**',
      'Based on use case, explain minimum setup:',
      '- Lookup only: contacts read, companies read, deals read, owners read',
      '- Pipeline updates: + deals write',
      '- Notes/tasks/logging: + relevant write permissions for notes/tasks + associations',
      'Separate: required setup, recommended extras, optional advanced features.',
      '',
      '**STAGE 3 — Guided HubSpot Setup**',
      'Walk through Private App creation one step at a time:',
      '1. Go to HubSpot Settings → Integrations → Private Apps',
      '2. Create new app, name it "OpenClaw Personal Assistant"',
      '3. Enable the scopes needed for selected use case',
      '4. Generate the access token, copy it securely',
      'Wait until user finishes each milestone before proceeding.',
      '',
      '**STAGE 4 — Collect Required Configuration Inputs**',
      'Gather: access token, desired objects, read-only vs write, default pipeline name, default deal stages, sample contact/deal for testing, automation preferences.',
      'For write use cases: ask which pipeline, stage labels, confirmation-every-time preference.',
      '',
      '**STAGE 5 — Install and Configure OpenClaw Skills**',
      'Install/enable HubSpot-related skills, configure secrets/tokens/env vars, set defaults.',
      'Use the [API_KEYS_NEEDED] block format when requesting the HubSpot access token.',
      '',
      '**STAGE 6 — Validate the Setup**',
      'Run real validation: connectivity test, object access test, one realistic query.',
      'Examples: find a known contact, list deals, show pipeline stage for a sample deal.',
      'If validation fails: explain what failed, identify likely cause (scope, token, pipeline mismatch), ask the next corrective question.',
      '',
      '**STAGE 7 — Optional Write Test**',
      'If write capability was requested, get explicit confirmation before the first write.',
      'Perform one safe minimal write: update a low-risk property, create a note/task.',
      'Never perform high-impact updates silently.',
      '',
      '**STAGE 8 — Teach the User**',
      'Give practical example prompts:',
      '- "Find my latest deals in negotiation"',
      '- "Brief me on Acme Corp before my meeting"',
      '- "Show all contacts at Contoso"',
      '- "Move the Zenith deal to Proposal Sent"',
      '- "Create a follow-up task for Sarah next Friday"',
      '',
      '**STAGE 9 — Refine**',
      'Ask: Stay read-only? Require approval for writes? Daily summaries? Calendar/email integration? Speed vs safety vs completeness?',
      '',
      '### Interactive Question Format (IMPORTANT)',
      'When you need to ask the user setup questions, ALWAYS wrap them in a [SETUP_QUESTIONS] block so they render as an interactive form.',
      'Format:',
      '```',
      '[SETUP_QUESTIONS]',
      'radio: Question label | Option 1 | Option 2 | Option 3',
      'checkbox: Question label | Option A | Option B | Option C',
      'text: Question label',
      '[/SETUP_QUESTIONS]',
      '```',
      'Rules:',
      '- `radio:` = single-select, `checkbox:` = multi-select, `text:` = free text input',
      '- First value after colon = label, subsequent `|`-separated values = options',
      '- Place explanatory text OUTSIDE the block',
      '- Use this for every question turn during onboarding',
      '',
      '### Skills / MCP servers to install',
      'HubSpot MCP (CRM read/write), Slack Skill (deal alerts/digests), Gmail Skill (meeting follow-ups), Google Calendar MCP (pre-call briefing trigger), Notion MCP (deal notes archive), Tavily MCP (company research enrichment).',
      '',
      '### Documentation / APIs to reference',
      'HubSpot CRM API v3 (contacts, companies, deals, owners, tasks, notes, tickets, custom objects), HubSpot Private Apps docs, HubSpot Scopes reference, HubSpot Search API, HubSpot Associations API, HubSpot Pipelines API.',
      '',
      '### Data to collect from the user',
      '1. HubSpot account status (connected? Private App exists?)',
      '2. Intended use case category (A–F above, or custom)',
      '3. Read-only vs write/update vs automation',
      '4. HubSpot Private App access token (use [API_KEYS_NEEDED] block)',
      '5. Which CRM objects matter (contacts, companies, deals, tasks, notes, tickets, custom)',
      '6. Default pipeline and stage labels (for deal workflows)',
      '7. Sample contact/company/deal name for validation testing',
      '8. Alert/notification channel (Slack, Telegram, email)',
      '',
      '### First message behavior',
      'Start with: "I can help you set up a HubSpot-powered assistant. We can start with CRM lookup, deal pipeline management, pre-meeting briefings, activity logging, or a custom flow. Which one do you want first, and do you already have a HubSpot Private App or access token ready?"',
      '',
      '### Success criteria',
      'Onboarding is only complete when: use case is defined, credentials collected, skills installed, configuration applied, integration validated with real test, user has example commands, optional improvements are clearly separated from working baseline.',
    ].join('\n'),
  },
  {
    label: 'Crypto Trading Agent',
    icon: Bitcoin,
    prompt: 'I want to build a daily crypto intelligence and trading agent — help me set up fresh news monitoring, signal analysis, trade planning, and Bankr execution.',
    guide: [
      '## Use-Case Guide: Fresh Crypto Intelligence, Trade Planning & Bankr Execution Agent — Guided Onboarding',
      '',
      'You are a specialized crypto intelligence, trade planning, and execution agent inside a per-user OpenClaw environment.',
      'Your mission: help the user build and run a daily crypto workflow that monitors only fresh information, filters and validates market-moving signals, builds a high-confidence daily trade plan, and converts approved plans into orders via Bankr.',
      'This is a guided onboarding + ongoing execution workflow, NOT a one-shot answer task.',
      '',
      '### Core behavior rules',
      '- Never dump all instructions at once. Break setup into clear stages — use a staged wizard approach.',
      '- Ask for a small, logical batch of details each turn and explain why each input matters.',
      '- Maintain an internal setup checklist: what is complete, missing, optional, deferrable.',
      '- When the user is blocked, give exact next actions.',
      '- If the user gives partial info, keep moving forward.',
      '- Default to safe rollout: paper mode first, read-only by default, live only with explicit approval.',
      '- Never rely on stale content, hype alone, or unverified rumors.',
      '',
      '### Critical date & freshness rules (MANDATORY)',
      '- ALWAYS use current UTC date/time as source of truth. Normalize all timestamps to UTC before ranking.',
      '- NEVER analyze items outside allowed freshness windows unless user explicitly asks for historical analysis.',
      '- If a source has no parseable timestamp, treat it as unusable.',
      '- If a post references an old article, use the ORIGINAL publication timestamp, not the repost timestamp.',
      '- Sort all candidate inputs by timestamp descending before analysis.',
      '- When in doubt, prefer a smaller but fresher dataset.',
      '- Default freshness windows:',
      '  - Breaking news/newsroom articles: last 24h',
      '  - X posts: last 6h preferred, max 12h',
      '  - Reddit posts/comments: last 12h',
      '  - On-chain dashboards/fast analytics: last 24h',
      '  - Research/newsletters: last 72h max, lower priority than same-day news',
      '  - Macro/regulatory calendars: upcoming 7 days + all same-day official releases',
      '- If insufficient fresh data, output: "Insufficient fresh data" or "No high-confidence trade today."',
      '',
      '### Default source universe (tiered trust model)',
      '**TIER 0 — Official / Regulatory / Macro** (highest trust): SEC crypto newsroom, Federal Reserve FOMC calendars, CFTC digital asset updates, official protocol/foundation announcements.',
      '**TIER 1 — Major Crypto Newsrooms**: CoinDesk, The Block, Decrypt, Bankless, Bitcoin Magazine.',
      '**TIER 2 — On-Chain / Research**: Glassnode Insights, Nansen Research, Bankr Signals (if available).',
      '**TIER 3 — Fast X Signals** (discovery, not execution): @CoinDesk, @TheBlockCo, @DecryptMedia, @Bankless, @whale_alert, @glassnode, @EricBalchunas.',
      '**TIER 4 — Reddit Sentiment**: r/CryptoCurrency, r/CryptoMarkets, r/BitcoinMarkets, r/ethfinance, r/defi, r/solana.',
      '',
      '**Source reliability rules:**',
      '- Tier 0-2 preferred for trade confirmation. X or Reddit alone must NOT trigger a live trade.',
      '- If a claim appears only on X/Reddit and nowhere else: mark as "Unconfirmed social signal — not tradable yet."',
      '',
      '### Bankr execution & skill strategy',
      'Use Bankr as the execution and wallet infrastructure layer.',
      '**Minimum viable skill set:** bankr (wallet/portfolio/swaps/execution), bankr-signals (transaction-verified signals), quicknode (on-chain balances/gas/confirmations).',
      '**Optional:** helixa (agent identity/reputation context), neynar (Farcaster social source).',
      'Install skills when enough setup info is available. Ask before installing optional skills.',
      '',
      '### Bankr safety rules (MANDATORY)',
      '- Default to paper mode until user explicitly requests live trading.',
      '- Recommend: dedicated Bankr account, dedicated agent wallet, IP allowlisting, recipient allowlisting.',
      '- For live trading collect: max daily loss, max position size, max concurrent positions, allowed tokens/chains, leverage (default: no), slippage tolerance, approval policy.',
      '- If no risk profile is configured, do NOT enable live execution.',
      '- If write access is not explicitly enabled, remain read-only / paper mode.',
      '- Never send funds to new external addresses without explicit user approval.',
      '- If a trade fails risk checks, reject it even if sentiment is bullish.',
      '- For full automation: still require one-time explicit confirmation of live trading risk.',
      '',
      '### Onboarding flow (follow these stages)',
      '',
      '**STAGE 0 — Detect Existing Setup**',
      'Determine: whether Bankr is already connected, whether user has a Bankr API key, whether LLM credits are configured, paper vs live mode preference, which skills are already installed.',
      '',
      '**STAGE 1 — Clarify Trading Workflow**',
      'Ask in logical batches (not all at once):',
      '- Which assets? (BTC, ETH, SOL, etc.)',
      '- Spot only or derivatives too?',
      '- Which chains should Bankr use?',
      '- Time horizon: intraday / swing / event-driven / mixed?',
      '- Output: ideas only, paper trades, or live trades?',
      '- Goal: news-driven / narrative momentum / on-chain confirmation / macro+crypto / hybrid?',
      '',
      '**STAGE 2 — Configure Source Universe**',
      'Help user choose: X watchlist, Reddit watchlist, news sites, on-chain research sources, optional asset-specific official sources. If unsure, start with the defaults above.',
      '',
      '**STAGE 3 — Configure Risk Policy**',
      'Collect: execution mode (research-only/paper/live), account size, max risk per trade (% and absolute), max daily drawdown, max trades/day, weekend trading, avoid major events, stablecoin base (default USDC), token blacklist, leverage policy, approval policy (always confirm / threshold / automatic). Defaults: paper mode, no leverage, user confirmation required.',
      '',
      '**STAGE 4 — Technical Configuration**',
      'Install bankr, bankr-signals, quicknode (+ optional helixa, neynar). Configure API keys using [API_KEYS_NEEDED] block format. Enable only needed permissions. For live mode verify write-capable Bankr key; for paper keep write disabled.',
      '',
      '**STAGE 5 — Validation** (layered)',
      '1. Connectivity test, 2. Balances/portfolio test, 3. Read-only intelligence test, 4. Paper trade simulation, 5. Optional live small-size test (only with explicit approval).',
      'Never claim setup is complete without validation.',
      '',
      '### Daily workflow logic (for each run)',
      '',
      '**PHASE A — Fresh Collection**: Fetch only fresh items from configured sources. Capture title, summary, source, URL, published_at_utc, author, mentioned assets/tickers, mentioned events. Reject items missing timestamps or outside freshness windows. Deduplicate.',
      '',
      '**PHASE B — Event Extraction**: For each item extract: asset(s), event type (regulatory / macro / ETF / protocol / exchange / exploit / unlock / whale / governance / narrative / sentiment / technical), directionality, urgency, confidence, whether likely market-moving in next 24h.',
      '',
      '**PHASE C — Cross-Source Validation**: Check at least one higher-tier source confirms each event. Mark as: confirmed / partially confirmed / unconfirmed. Only confirmed or strongly partially confirmed events can feed live trades.',
      '',
      '**PHASE D — Signal Scoring**: Weighted model — recency (25%), credibility (20%), confirmation (20%), impact (15%), actionability (10%), on-chain confirmation (5%), sentiment quality (5%). Subtract penalties for: rumor-only, influencer-only, low-liquidity token, contradictory sources, stale repost, obvious hype/shill.',
      '',
      '**PHASE E — Market Context Overlay**: Check same-day macro calendar, imminent Fed/regulatory/ETF catalyst risk, risk-on vs risk-off tape, on-chain/flow data support. If story and tape conflict sharply, reduce confidence or reject.',
      '',
      '**PHASE F — Trade Plan Generation**: Each trade idea must include: asset, direction, thesis, catalyst summary, freshness proof, supporting sources, entry logic, execution trigger, invalidation condition, stop logic, target logic, holding horizon, confidence score, position size recommendation, order type, expiry/cancellation condition. If no valid setups: "No high-confidence trade today."',
      '',
      '**PHASE G — Order Conversion**: Research-only: plan only. Paper: simulated orders. Live: check approval policy, verify risk limits/allowed tokens/chains/balance/no duplicate position, place smallest valid order if first time, record metadata.',
      '',
      '### Order policy',
      '- Prefer limit orders unless urgency/liquidity justify market execution.',
      '- Use stop/stop-limit only for breakout/breakdown confirmation theses.',
      '- Use DCA/TWAP for larger allocations or accumulation mode.',
      '- Every order must have: symbol, side, size, chain/venue, trigger, risk note, timestamp UTC, thesis reference.',
      '- If slippage/liquidity/gas conditions are poor, reduce size or skip.',
      '- If news is fresh but contradictory, wait — do not force a trade.',
      '',
      '### Mandatory no-trade conditions',
      'Do NOT create a live trade if: catalyst is stale, timestamp missing, thesis depends on unconfirmed rumor, violates user risk settings, asset not on whitelist, insufficient liquidity, exceeds daily risk budget, too close to major macro release (if user chose to avoid), system cannot explain the edge, user approval not granted.',
      '',
      '### Daily report output format',
      '1. Date/time (UTC), 2. Freshness summary (collected/rejected/used), 3. Top validated narratives, 4. Market regime/risk context, 5. Daily trade plan, 6. Execution recommendations, 7. Orders created/paper/none, 8. Risk notes, 9. Source appendix with timestamps.',
      '',
      '### Interactive Question Format (IMPORTANT)',
      'When you need to ask the user setup questions, ALWAYS wrap them in a [SETUP_QUESTIONS] block so they render as an interactive form.',
      'Format:',
      '```',
      '[SETUP_QUESTIONS]',
      'radio: Question label | Option 1 | Option 2 | Option 3',
      'checkbox: Question label | Option A | Option B | Option C',
      'text: Question label',
      '[/SETUP_QUESTIONS]',
      '```',
      'Rules:',
      '- `radio:` = single-select, `checkbox:` = multi-select, `text:` = free text input',
      '- First value after colon = label, subsequent `|`-separated values = options',
      '- Place explanatory text OUTSIDE the block',
      '- Use this for every question turn during onboarding',
      '',
      '### Skills / MCP servers to install',
      'Bankr Skill (wallet, portfolio, swaps, execution routing), Bankr Signals Skill (transaction-verified signal feed), QuickNode Skill (on-chain balances, gas, confirmations), Firecrawl MCP (news scraping), Tavily MCP (search/research), Slack Skill (alerts/digests), Notion MCP (trade journal), Google Sheets MCP (position tracking). Optional: Helixa (agent reputation), Neynar (Farcaster).',
      '',
      '### Documentation / APIs to reference',
      'Bankr API docs (wallet management, order creation, signal feeds, risk controls), QuickNode API (multi-chain RPC, balance queries), CoinDesk API, The Block API, Glassnode API, Reddit API (subreddit fetching), Twitter/X API (timeline/search), SEC EDGAR RSS feeds, FOMC calendar.',
      '',
      '### Data to collect from the user',
      '1. Bankr account status (connected? API key ready?)',
      '2. Execution mode (research-only / paper / live)',
      '3. Target assets (BTC, ETH, SOL, etc.)',
      '4. Spot or derivatives',
      '5. Preferred chains (Ethereum, Solana, Base, etc.)',
      '6. Time horizon (intraday / swing / event-driven / mixed)',
      '7. Risk parameters (max loss, position size, drawdown, leverage)',
      '8. Source preferences (X accounts, subreddits, news sites)',
      '9. Notification channel (Slack, Telegram, email)',
      '10. Bankr API key (use [API_KEYS_NEEDED] block)',
      '11. QuickNode API key (use [API_KEYS_NEEDED] block)',
      '',
      '### First message behavior',
      'Start with: "I can help you set up a daily crypto intelligence workflow that monitors only fresh information and turns validated signals into paper or live trade plans via Bankr."',
      'Then offer 4 templates: 1) News-driven crypto trading, 2) On-chain confirmed trading, 3) Macro + crypto event trading, 4) Hybrid multi-source daily trade planner.',
      'Ask: research-only, paper, or live? Is Bankr already connected / do you have a Bankr API key? What assets to focus on (BTC/ETH/SOL)?',
      '',
      '### Success criteria',
      'Onboarding is only complete when: trading objective is clear, source universe configured, freshness rules active, required Bankr skills installed, API keys/secrets configured, paper or live mode selected, risk limits configured, validation succeeded, and a same-day test run produced either a valid no-trade conclusion, a valid trade plan, or a paper/live order per user settings. If incomplete, continue guiding — do not end with generic advice.',
    ].join('\n'),
  },
];

// ═══════════════════════════════════════════════════════════════════════════════
// MessageActions — copy & retry buttons below assistant messages
// ═══════════════════════════════════════════════════════════════════════════════
function MessageActions({
  messageId,
  message,
  messages,
  setMessages,
  sendMessage,
  isLoading,
}: {
  messageId: string;
  message: UIMessage;
  messages: UIMessage[];
  setMessages: (msgs: UIMessage[] | ((prev: UIMessage[]) => UIMessage[])) => void;
  sendMessage: (msg: { role: 'user'; parts: Array<{ type: 'text'; text: string }> }) => void;
  isLoading: boolean;
}) {
  const [copied, setCopied] = React.useState(false);

  const handleCopy = React.useCallback(() => {
    const text = message.parts
      ?.filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map(p => p.text)
      .join('\n') || String((message as { content?: unknown }).content ?? '');
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [message]);

  const handleRetry = React.useCallback(() => {
    if (isLoading) return;
    // Find the user message that preceded this assistant message
    const idx = messages.findIndex(m => m.id === messageId);
    if (idx <= 0) return;
    const userMsg = messages[idx - 1];
    if (userMsg.role !== 'user') return;
    const userText = userMsg.parts
      ?.filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map(p => p.text)
      .join('\n') || String((userMsg as { content?: unknown }).content ?? '');
    // Resend the same user message — the AI produces a new response.
    // We do NOT delete old messages because they are persisted in the DB;
    // cutting them locally causes ghost duplicates after navigation.
    sendMessage({ role: 'user', parts: [{ type: 'text', text: userText }] });
  }, [messageId, messages, sendMessage, isLoading]);

  return (
    <div className="flex items-center gap-1 mt-1 opacity-0 group-hover:opacity-100 transition-opacity">
      <button
        type="button"
        onClick={handleCopy}
        className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
        title="Copy message"
      >
        {copied ? <CheckCheck className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
      <button
        type="button"
        onClick={handleRetry}
        disabled={isLoading}
        className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        title="Regenerate response"
      >
        <RotateCcw className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ChatPanelInner — the actual chat UI, receives initialMessages
// ═══════════════════════════════════════════════════════════════════════════════
interface ChatPanelInnerProps {
  apiKey: string | null;
  conversationId?: string;
  initialMessages: UIMessage[];
  userId: string;
  onConversationCreated?: (id: string) => void;
  agentId?: string;
  isStreamRecovery?: boolean;
}

const IS_CLOUD = process.env.NEXT_PUBLIC_CLOUD_MODE === 'true';

function ChatPanelInner({ apiKey, conversationId, initialMessages, userId, onConversationCreated, agentId: agentIdProp, isStreamRecovery }: ChatPanelInnerProps) {
  const { gatewayToken, gatewayUrl, openaiKey, anthropicKey } = useOpenClawChatStore();
  const { tenantStatus, setTenantStatus } = useCloudStore();
  // In cloud mode, start "not ready" and let the /api/backend-status check flip it
  const [backendChecked, setBackendChecked] = React.useState(!IS_CLOUD);
  const backendReady = !IS_CLOUD || (backendChecked && tenantStatus === 'active');
  const authToken = gatewayToken ?? apiKey ?? '';

  // ── Provisioning animation state ──────────────────────────────────────────
  const [provPhase, setProvPhase] = React.useState(0);
  const [provLogIdx, setProvLogIdx] = React.useState(0);
  const [provPercent, setProvPercent] = React.useState(0);

  const PROV_MESSAGES: string[][] = [
    ['Initializing workspace…', 'Reserving your namespace…', 'Allocating cloud resources…'],
    ['Pulling AI runtime image…', 'Deploying backend container…', 'Booting OpenClaw engine…', 'Wiring up WebSocket gateway…'],
    ['Mounting persistent storage…', 'Configuring environment…', 'Applying preferences…', 'Running health checks…'],
    ['Almost there…', 'Finalizing deployment…'],
  ];

  const PROV_FACTS = [
    'Your workspace runs on dedicated infrastructure',
    'Each tenant gets its own isolated AI backend',
    'Conversations are encrypted end-to-end',
    'You can customise models and skills anytime',
    'Your data never leaves your workspace',
    'WebSocket streaming for real-time AI responses',
    'Automatic scaling handles traffic spikes',
    'All models available via a single API',
  ];

  React.useEffect(() => {
    if (backendReady) return;
    // Animate progress bar, rotate log messages, advance phases
    const interval = setInterval(() => {
      setProvPercent(p => Math.min(p + (p < 30 ? 3 : p < 60 ? 2 : 1), 92));
      setProvLogIdx(i => i + 1);
    }, 3000);

    const phaseTimer = setInterval(() => {
      setProvPhase(ph => Math.min(ph + 1, 3));
    }, 20000);

    return () => { clearInterval(interval); clearInterval(phaseTimer); };
  }, [backendReady]);

  React.useEffect(() => {
    if (backendReady) {
      setProvPercent(100);
      setProvPhase(3);
    }
  }, [backendReady]);

  const currentProvMsg = PROV_MESSAGES[provPhase]?.[provLogIdx % (PROV_MESSAGES[provPhase]?.length ?? 1)] ?? 'Preparing…';
  const currentFact = PROV_FACTS[Math.floor(provLogIdx / 2) % PROV_FACTS.length];

  // ── Refs ───────────────────────────────────────────────────────────────────
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLTextAreaElement>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const dropZoneRef = React.useRef<HTMLDivElement>(null);
  const modelRef = React.useRef('openclaw');
  const convRef = React.useRef(conversationId);
  const convCreatingRef = React.useRef(false);
  const skillsRef = React.useRef<EnabledSkill[]>([]);
  const authRef = React.useRef(authToken);
  const skillsUserRef = React.useRef<string | null>(null);
  // Settings overrides — refs so prepareSendMessagesRequest (memoised) always reads latest values
  const gwUrlRef = React.useRef(gatewayUrl);
  const gwTokenRef = React.useRef(gatewayToken);
  const oaiKeyRef = React.useRef(openaiKey);
  const antKeyRef = React.useRef(anthropicKey);
  const useCaseGuideRef = React.useRef<string | undefined>(undefined);

  // ── Sync refs ──────────────────────────────────────────────────────────────
  // Only update convRef from the prop when the prop provides a concrete value.
  // Keeping it undefined would overwrite the ID dynamically set by handleSend
  // on every re-render, causing prepareSendMessagesRequest to read undefined
  // and the ai-chat route to skip message persistence.
  if (conversationId !== undefined) {
    convRef.current = conversationId;
  }
  authRef.current = authToken;
  gwUrlRef.current = gatewayUrl;
  gwTokenRef.current = gatewayToken;
  oaiKeyRef.current = openaiKey;
  antKeyRef.current = anthropicKey;

  // ── State ──────────────────────────────────────────────────────────────────
  const [input, setInput] = React.useState('');
  const [attachedFiles, setAttachedFiles] = React.useState<AttachedFile[]>([]);
  const [isDragging, setIsDragging] = React.useState(false);
  const [selectedModel, setSelectedModel] = React.useState('openclaw');
  const [modelDropdownOpen, setModelDropdownOpen] = React.useState(false);
  const [modelSearchQuery, setModelSearchQuery] = React.useState('');
  const [modelSaving, setModelSaving] = React.useState(false);
  const { enabledSkills, loaded: skillsLoaded, setEnabledSkills } = useSkillsStore();
  const { agents: installedAgents, selectedAgentId, loaded: agentsLoaded, loadAgents, selectAgent } = useInstalledAgentsStore();
  const [models, setModels] = React.useState<ModelOption[]>(FALLBACK_MODELS);
  const [modelsLoading, setModelsLoading] = React.useState(false);
  const [canvas, setCanvas] = React.useState<{ blocks: CanvasBlock[]; activeId?: string } | null>(null);
  const [agentDropdownOpen, setAgentDropdownOpen] = React.useState(false);
  const agentDropdownRef = React.useRef<HTMLDivElement>(null);
  const agentIdRef = React.useRef<string | null>(agentIdProp ?? selectedAgentId);
  const agentsUserRef = React.useRef<string>('');
  const activeTaskRef = React.useRef<string | null>(null);

  // Sync mutable refs with state
  modelRef.current = selectedModel;
  skillsRef.current = enabledSkills;
  agentIdRef.current = agentIdProp ?? selectedAgentId;

  // ── Transport (created once, uses refs for dynamic values) ─────────────────
  const prepareSendMessagesRequest: PrepareSendMessagesRequest<UIMessage> = React.useCallback(
    ({ messages }) => {
      console.log('[prepareSendMessagesRequest] convRef.current:', convRef.current, 'msgCount:', messages.length);
      // Keep sending the guide on every message so the AI retains context
      // throughout the conversation (not just on the first message).
      const guide = useCaseGuideRef.current;
      return {
      body: {
        messages,
        model: modelRef.current,
        conversationId: convRef.current,
        skills: skillsRef.current.map(s => s.skill_id),
        agentId: agentIdRef.current || undefined,
        useCaseGuide: guide || undefined,
        // Settings overrides — allow UI config to take effect without server restart
        overrideGatewayUrl:    gwUrlRef.current    || undefined,
        overrideGatewayToken:  gwTokenRef.current  || undefined,
        overrideOpenaiKey:     oaiKeyRef.current   || undefined,
        overrideAnthropicKey:  antKeyRef.current   || undefined,
      },
      headers: {
        // In cloud mode auth uses httpOnly cookies; skip the Authorization header
        // to avoid a Next.js 14 routing issue where valid JWTs in the header
        // cause the request to bypass the route handler.
        ...(process.env.NEXT_PUBLIC_CLOUD_MODE === 'true'
          ? {}
          : { Authorization: `Bearer ${authRef.current}` }),
      },
    };},
    []
  );

  const transport = React.useMemo(
    () => new TextStreamChatTransport({ api: '/api/ai-chat', prepareSendMessagesRequest, fetch: chatFetch }),
    [prepareSendMessagesRequest]
  );

  // ── useChat ────────────────────────────────────────────────────────────────
  const { messages, setMessages, sendMessage, status, stop, clearError, error } = useChat({
    transport,
    messages: initialMessages,
  });

  const isLoading = status === 'streaming' || status === 'submitted';

  // Drives the engagement indicator (phased status, skeleton, cancel link).
  // Resets to 0 each time the assistant starts a new turn.
  const thinkingElapsedMs = useElapsedMs(status === 'submitted');

  // ── Stream recovery: SSE push (when enabled) or polling fallback ──────────
  const { recovering, setRecovering } = useStreamRecovery(conversationId, userId, setMessages, !!isStreamRecovery);

  // ── Post-stream DB sync: catch final content after action-block processing ──
  usePostStreamSync(conversationId, userId, status, setMessages);

  // ── Drive agent task lifecycle based on AI stream status ────────────────────
  const prevStatusRef = React.useRef(status);
  React.useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = status;
    const taskId = activeTaskRef.current;
    if (!taskId) return;

    // AI started streaming → task moves to running (MC: in_progress)
    if (status === 'streaming' && prev !== 'streaming') {
      fetch(`/api/agents/tasks/${taskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
        body: JSON.stringify({ status: 'running' }),
      }).catch(() => {});
    }

    // AI finished (ready after streaming) → task moves to completed (MC: done)
    if (status === 'ready' && prev === 'streaming') {
      fetch(`/api/agents/tasks/${taskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
        body: JSON.stringify({ status: 'completed' }),
      }).catch(() => {});
      activeTaskRef.current = null; // task completed, clear for next message
    }

    // Error after streaming → mark failed
    if (status === 'error' && (prev === 'streaming' || prev === 'submitted')) {
      fetch(`/api/agents/tasks/${taskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
        body: JSON.stringify({ status: 'cancelled' }),
      }).catch(() => {});
      activeTaskRef.current = null;
    }
  }, [status, userId]);

  // ── Silent recovery on transport drop ──────────────────────────────────────
  // RFC: Resilient Long-Running Chat (Phase B).
  // When the SSE stream from /api/ai-chat is interrupted (Cloud Run cold-start,
  // intermediate proxy idle drop, network blip), `useChat` flips to status='error'.
  // If we already have partial assistant content for the latest turn, surface it
  // as a quiet "Reconnecting…" state instead of a red toast — the existing
  // recovery hook (useStreamRecovery) will pull the final text from Postgres
  // once the backend finishes. The user sees a single continuous response, not
  // two assistant bubbles or a scary error banner.
  React.useEffect(() => {
    if (status !== 'error') return;
    if (!conversationId) return;
    const last = messages[messages.length - 1];
    if (!last || last.role !== 'assistant') return;
    const partial = (last.parts || [])
      .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map(p => p.text)
      .join('');
    if (!partial.trim()) return; // nothing partial → keep the visible error
    // Suppress the error banner and let stream-recovery rebuild from DB.
    clearError();
    setRecovering(true);
  }, [status, conversationId, messages, clearError, setRecovering]);

  // ── Cloud mode: verify backend is actually reachable on mount ──────────────
  const backendNotReady = IS_CLOUD && useCloudStore.getState().tenantStatus !== 'active';

  useAdaptivePoll(
    async () => {
      const res = await fetch('/api/backend-status', { credentials: 'include' });
      return await res.json() as { ready: boolean };
    },
    (data) => {
      const d = data as { ready: boolean };
      setBackendChecked(true);
      if (d.ready) {
        setTenantStatus('active');
      } else {
        setTenantStatus('provisioning');
      }
    },
    {
      enabled: IS_CLOUD && backendNotReady,
      baseInterval: 4_000,
      maxInterval: 30_000,
      backoffFactor: 1.5,
      shouldStop: (data) => (data as { ready: boolean }).ready,
    },
  );

  // If not cloud, mark checked immediately
  React.useEffect(() => {
    if (!IS_CLOUD) return;
    // Initial check
    fetch('/api/backend-status', { credentials: 'include' })
      .then(r => r.json())
      .then((d: { ready: boolean }) => {
        setBackendChecked(true);
        setTenantStatus(d.ready ? 'active' : 'provisioning');
      })
      .catch(() => setBackendChecked(true));
  }, [setTenantStatus]);

  // ── React to provisioning errors from useChat ──────────────────────────────
  React.useEffect(() => {
    if (!error || !IS_CLOUD) return;
    const msg = error.message?.toLowerCase() ?? '';
    if (msg.includes('not yet active') || msg.includes('provisioning')) {
      setTenantStatus('provisioning');
    }
  }, [error, setTenantStatus]);

  // ── Load models ────────────────────────────────────────────────────────────
  React.useEffect(() => {
    setModelsLoading(true);
    fetch('/api/models')
      .then(r => r.json())
      .then(data => {
        const list = (data.models || []) as Array<{ id: string; name: string; provider?: string }>;
        if (list.length > 0) {
          const mapped = list.map(m => ({ value: m.id, label: m.name || m.id, provider: m.provider }));
          setModels(mapped);
          // Validate persisted selection against the config list
          setSelectedModel(prev => {
            const stillValid = mapped.some(m => m.value === prev);
            return stillValid ? prev : mapped[0].value;
          });
        }
      })
      .catch(() => {})
      .finally(() => setModelsLoading(false));
  }, []);

  // Load persisted per-user model preference
  React.useEffect(() => {
    fetch('/api/ai-chat/model', { headers: { 'x-user-id': userId } })
      .then(r => r.json())
      .then((data: { model?: string }) => {
        if (data.model && typeof data.model === 'string') {
          setSelectedModel(data.model);
        }
      })
      .catch(() => {});
  }, [userId]);

  // ── Load skills ────────────────────────────────────────────────────────────
  React.useEffect(() => {
    if (!skillsLoaded || skillsUserRef.current !== userId) {
      skillsUserRef.current = userId;
      fetchEnabledSkills(userId).then(setEnabledSkills);
    }
  }, [skillsLoaded, userId, setEnabledSkills]);

  // ── Load installed agents ──────────────────────────────────────────────────
  React.useEffect(() => {
    if (!agentsLoaded || agentsUserRef.current !== userId) {
      agentsUserRef.current = userId;
      loadAgents(userId);
    }
  }, [agentsLoaded, userId, loadAgents]);

  // ── Auto-scroll ────────────────────────────────────────────────────────────
  React.useEffect(() => {
    scrollRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, status]);

  // ── Auto-open canvas when assistant sends HTML code blocks ─────────────────
  const lastCanvasCheckRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (status !== 'ready' || messages.length === 0) return;
    const lastMsg = messages[messages.length - 1];
    if (lastMsg.role !== 'assistant' || lastMsg.id === lastCanvasCheckRef.current) return;
    lastCanvasCheckRef.current = lastMsg.id;
    const text = lastMsg.parts
      ?.filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map(p => p.text)
      .join('') ?? '';
    const blocks = extractCodeBlocks(text);
    // Only auto-open canvas for HTML blocks — other languages stay collapsed
    const htmlBlocks = blocks.filter(b => b.language === 'html');
    if (htmlBlocks.length > 0) {
      setCanvas({ blocks: htmlBlocks, activeId: htmlBlocks[0].id });
    }
  }, [messages, status]);

  // ── Focus input ───────────────────────────────────────────────────────────
  React.useEffect(() => { inputRef.current?.focus(); }, []);

  // ── Close model dropdown on outside click ─────────────────────────────────
  const modelDropdownRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (!modelDropdownOpen) return;
    const h = (e: MouseEvent) => {
      if (modelDropdownRef.current && !modelDropdownRef.current.contains(e.target as Node)) {
        setModelDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [modelDropdownOpen]);

  React.useEffect(() => {
    if (!modelDropdownOpen) {
      setModelSearchQuery('');
    }
  }, [modelDropdownOpen]);

  // ── Close agent dropdown on outside click ──────────────────────────────────
  React.useEffect(() => {
    if (!agentDropdownOpen) return;
    const h = (e: MouseEvent) => {
      if (agentDropdownRef.current && !agentDropdownRef.current.contains(e.target as Node)) {
        setAgentDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [agentDropdownOpen]);

  const chooseModel = React.useCallback(async (model: string) => {
    setSelectedModel(model);
    setModelDropdownOpen(false);
    setModelSaving(true);
    try {
      await fetch('/api/ai-chat/model', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
        body: JSON.stringify({ model }),
      });
    } catch {
      // Ignore persistence failures; local selection still works for the session.
    } finally {
      setModelSaving(false);
    }
  }, [userId]);

  // ── Handle file selection ──────────────────────────────────────────────────
  const addFiles = React.useCallback(async (newFiles: File[]) => {
    const toAdd: AttachedFile[] = await Promise.all(
      newFiles.map(async f => {
        const type = classifyFile(f);
        const previewUrl = type === 'image' ? await fileToDataUrl(f) : undefined;
        return { id: uid(), file: f, previewUrl, type };
      })
    );
    setAttachedFiles(prev => [...prev, ...toAdd]);
  }, []);

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length) addFiles(files);
    e.target.value = '';
  };

  const removeFile = (id: string) => setAttachedFiles(prev => prev.filter(f => f.id !== id));

  // ── Drag & drop ────────────────────────────────────────────────────────────
  const handleDragOver = (e: React.DragEvent) => { e.preventDefault(); setIsDragging(true); };
  const handleDragLeave = (e: React.DragEvent) => { e.preventDefault(); setIsDragging(false); };
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length) addFiles(files);
  };

  // ── Paste images ───────────────────────────────────────────────────────────
  const handlePaste = React.useCallback((e: React.ClipboardEvent) => {
    const items = Array.from(e.clipboardData.items);
    const imageItems = items.filter(it => it.kind === 'file' && it.type.startsWith('image/'));
    if (imageItems.length === 0) return;
    e.preventDefault();
    const files = imageItems.map(it => it.getAsFile()).filter((f): f is File => f !== null);
    addFiles(files);
  }, [addFiles]);

  // ── Send ───────────────────────────────────────────────────────────────────
  const handleSend = React.useCallback(async () => {
    const text = input.trim();
    if (!text && attachedFiles.length === 0) return;
    if (isLoading || recovering || !backendReady) return;

    clearError();
    setInput('');

    console.log('[handleSend] start — convRef.current:', convRef.current, 'conversationId prop:', conversationId);

    // Create the conversation BEFORE sending so the transport's
    // prepareSendMessagesRequest reads a valid convRef.current. Otherwise the
    // backend gets no conversationId, never persists the user message, and the
    // chat appears empty after a refresh / when opened in another tab.
    const needsConv = !convRef.current && !convCreatingRef.current;
    if (needsConv) {
      convCreatingRef.current = true;
      try {
        const res = await fetch('/api/conversations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
          body: JSON.stringify({ title: text.slice(0, 60) || 'New Chat', agentId: agentIdRef.current || undefined }),
        });
        const data = await res.json() as { conversation?: { id: string } };
        if (data.conversation?.id) {
          convRef.current = data.conversation.id;
          console.log('[handleSend] conversation created:', data.conversation.id);
          onConversationCreated?.(data.conversation.id);
        } else {
          console.error('[handleSend] conversation creation returned no id. status:', res.status, 'body:', JSON.stringify(data));
        }
      } catch (err) {
        console.error('[handleSend] failed to create conversation:', err);
      } finally {
        convCreatingRef.current = false;
      }
    } else if (convCreatingRef.current) {
      // A previous send is still creating the conversation — wait for it briefly
      // so we don't fire another POST or send without an id.
      const start = Date.now();
      while (convCreatingRef.current && Date.now() - start < 5000) {
        await new Promise(r => setTimeout(r, 50));
      }
    }

    // Now fire the message — conversationId is guaranteed to be set (or the
    // POST genuinely failed, in which case we still try so the user sees an error).
    if (attachedFiles.length === 0) {
      sendMessage({ text });
    } else {
      const fileParts = await Promise.all(attachedFiles.map(buildFileUIPart));
      setAttachedFiles([]);
      sendMessage({ text: text || undefined, files: fileParts });
    }

    // Auto-create an agent task when chatting with a selected agent (first message only)
    if (agentIdRef.current && text && !activeTaskRef.current) {
      const agentName = installedAgents.find(a => a.agent_id === agentIdRef.current)?.name;
      fetch('/api/agents/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
        body: JSON.stringify({
          agent_id: agentIdRef.current,
          task_prompt: text.slice(0, 200),
          agent_name: agentName || 'Agent',
        }),
      })
        .then((res) => res.ok ? res.json() as Promise<{ task?: { id: string } }> : null)
        .then((data) => {
          if (data?.task?.id) activeTaskRef.current = data.task.id;
        })
        .catch(() => { /* task creation is non-blocking */ });
    }
  }, [input, attachedFiles, isLoading, recovering, backendReady, sendMessage, clearError, userId, onConversationCreated]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  };

  // ── Auto-resize textarea ───────────────────────────────────────────────────
  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    e.target.style.height = 'auto';
    e.target.style.height = `${Math.min(e.target.scrollHeight, 128)}px`;
  };

  // ── Canvas ─────────────────────────────────────────────────────────────────
  const handleCodeOpen = React.useCallback((code: string, language: string) => {
    setCanvas({ blocks: [{ id: uid(), code, language }] });
  }, []);

  const handleOpenAllCanvasBlocks = React.useCallback((msgText: string) => {
    const blocks = extractCodeBlocks(msgText);
    if (blocks.length > 0) setCanvas({ blocks, activeId: blocks[0].id });
  }, []);

  // ── Render message parts ───────────────────────────────────────────────────
  const renderMessageParts = React.useCallback((msg: UIMessage) => {
    if (!msg.parts || msg.parts.length === 0) {
      return <p className="text-sm whitespace-pre-wrap leading-relaxed">{String((msg as { content?: unknown }).content ?? '')}</p>;
    }

    return (
      <React.Fragment>
        {msg.parts.map((part, i) => {
          if (part.type === 'text') {
            if (msg.role === 'assistant') {
              const text = stripActionBlocks(part.text).replace(
                /MEDIA:\s*\/home\/node\/\.openclaw\/workspace\/(.+)/g,
                (_m: string, fp: string) => {
                  const fn = fp.trim().replace(/[`"']+$/g, '');
                  return `![${fn}](/api/media/workspace/${encodeURIComponent(fn)})`;
                },
              );
              const codeBlocks = extractCodeBlocks(text);
              const agentCreateParsed = parseAgentCreateBlock(text);
              const apiKeyParsed = parseApiKeyBlocks(text);
              const setupQParsed = parseSetupQuestions(text);

              // If the message contains [SETUP_QUESTIONS] blocks, split and render them inline
              if (setupQParsed) {
                return (
                  <div key={i}>
                    {setupQParsed.segments.map((seg, si) => {
                      if (seg.type === 'text') {
                        // Within text segments, also check for other block types
                        const innerAgent = parseAgentCreateBlock(seg.value);
                        if (innerAgent) {
                          return (
                            <React.Fragment key={si}>
                              {innerAgent.segments.map((iseg, isi) =>
                                iseg.type === 'text'
                                  ? <Markdown key={isi} content={iseg.value || '…'} onCodeBlockOpen={handleCodeOpen} />
                                  : <AgentCreateBlock key={isi} spec={iseg.spec} userId={userId} />
                              )}
                            </React.Fragment>
                          );
                        }
                        const innerApi = parseApiKeyBlocks(seg.value);
                        if (innerApi) {
                          return (
                            <React.Fragment key={si}>
                              {innerApi.segments.map((iseg, isi) =>
                                iseg.type === 'text'
                                  ? <Markdown key={isi} content={iseg.value || '…'} onCodeBlockOpen={handleCodeOpen} />
                                  : <ApiKeyRequestBlock key={isi} keys={iseg.keys} onSubmit={(vals) => {
                                      const t = Object.entries(vals).map(([k, v]) => `${k}: ${v}`).join('\n');
                                      sendMessage({ text: `Here are the requested API keys:\n${t}` });
                                    }} />
                              )}
                            </React.Fragment>
                          );
                        }
                        return <Markdown key={si} content={seg.value || '…'} onCodeBlockOpen={handleCodeOpen} />;
                      }
                      return (
                        <SetupQuestionsBlock
                          key={si}
                          questions={seg.questions}
                          onSubmit={(formatted) => {
                            sendMessage({ text: formatted });
                          }}
                        />
                      );
                    })}
                    {codeBlocks.length > 1 && (
                      <button
                        onClick={() => handleOpenAllCanvasBlocks(text)}
                        className="mt-2 flex items-center gap-1.5 px-3 py-1 rounded-lg border border-primary/30 text-primary text-xs hover:bg-primary/10 transition-colors"
                      >
                        <Code2 className="h-3 w-3" />
                        Open {codeBlocks.length} blocks in Canvas
                      </button>
                    )}
                  </div>
                );
              }

              // If the message contains [CREATE_AGENT] blocks, split and render them inline
              if (agentCreateParsed) {
                return (
                  <div key={i}>
                    {agentCreateParsed.segments.map((seg, si) => {
                      if (seg.type === 'text') {
                        // Within text segments, also check for API key blocks
                        const innerApi = parseApiKeyBlocks(seg.value);
                        if (innerApi) {
                          return (
                            <React.Fragment key={si}>
                              {innerApi.segments.map((iseg, isi) =>
                                iseg.type === 'text'
                                  ? <Markdown key={isi} content={iseg.value || '…'} onCodeBlockOpen={handleCodeOpen} />
                                  : <ApiKeyRequestBlock key={isi} keys={iseg.keys} onSubmit={(vals) => {
                                      const t = Object.entries(vals).map(([k, v]) => `${k}: ${v}`).join('\n');
                                      sendMessage({ text: `Here are the requested API keys:\n${t}` });
                                    }} />
                              )}
                            </React.Fragment>
                          );
                        }
                        return <Markdown key={si} content={seg.value || '…'} onCodeBlockOpen={handleCodeOpen} />;
                      }
                      return <AgentCreateBlock key={si} spec={seg.spec} userId={userId} />;
                    })}
                    {codeBlocks.length > 1 && (
                      <button
                        onClick={() => handleOpenAllCanvasBlocks(text)}
                        className="mt-2 flex items-center gap-1.5 px-3 py-1 rounded-lg border border-primary/30 text-primary text-xs hover:bg-primary/10 transition-colors"
                      >
                        <Code2 className="h-3 w-3" />
                        Open {codeBlocks.length} blocks in Canvas
                      </button>
                    )}
                  </div>
                );
              }

              // If the message contains [API_KEYS_NEEDED] blocks, split and render them inline
              if (apiKeyParsed) {
                return (
                  <div key={i}>
                    {apiKeyParsed.segments.map((seg, si) => {
                      if (seg.type === 'text') {
                        return <Markdown key={si} content={seg.value || '…'} onCodeBlockOpen={handleCodeOpen} />;
                      }
                      return (
                        <ApiKeyRequestBlock
                          key={si}
                          keys={seg.keys}
                          onSubmit={(vals) => {
                            const text = Object.entries(vals).map(([k, v]) => `${k}: ${v}`).join('\n');
                            sendMessage({ text: `Here are the requested API keys:\n${text}` });
                          }}
                        />
                      );
                    })}
                    {codeBlocks.length > 1 && (
                      <button
                        onClick={() => handleOpenAllCanvasBlocks(text)}
                        className="mt-2 flex items-center gap-1.5 px-3 py-1 rounded-lg border border-primary/30 text-primary text-xs hover:bg-primary/10 transition-colors"
                      >
                        <Code2 className="h-3 w-3" />
                        Open {codeBlocks.length} blocks in Canvas
                      </button>
                    )}
                  </div>
                );
              }

              return (
                <div key={i}>
                  <Markdown
                    content={text || '…'}
                    onCodeBlockOpen={handleCodeOpen}
                  />
                  {codeBlocks.length > 1 && (
                    <button
                      onClick={() => handleOpenAllCanvasBlocks(text)}
                      className="mt-2 flex items-center gap-1.5 px-3 py-1 rounded-lg border border-primary/30 text-primary text-xs hover:bg-primary/10 transition-colors"
                    >
                      <Code2 className="h-3 w-3" />
                      Open {codeBlocks.length} blocks in Canvas
                    </button>
                  )}
                </div>
              );
            }
            return <p key={i} className="text-sm whitespace-pre-wrap leading-relaxed">{part.text}</p>;
          }

          if (part.type === 'file') {
            const fp = part as { type: 'file'; url: string; mediaType: string; filename?: string };
            if (fp.mediaType?.startsWith('image/')) {
              return (
                <div key={i} className="mt-2 max-w-xs">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={fp.url}
                    alt={fp.filename ?? 'image'}
                    className="rounded-lg max-h-64 object-contain border border-border/50 shadow-sm"
                  />
                  {fp.filename && <p className="text-[10px] text-muted-foreground mt-1">{fp.filename}</p>}
                </div>
              );
            }
            return (
              <div key={i} className="mt-2 flex items-center gap-2 px-3 py-2 rounded-lg bg-background/40 border border-border/50 max-w-xs">
                <FileText className="h-4 w-4 text-primary shrink-0" />
                <div className="min-w-0">
                  <p className="text-xs font-medium truncate">{fp.filename ?? 'File'}</p>
                  <p className="text-[10px] text-muted-foreground">{fp.mediaType}</p>
                </div>
              </div>
            );
          }

          return null;
        })}
      </React.Fragment>
    );
  }, [handleCodeOpen, handleOpenAllCanvasBlocks, sendMessage, userId]);

  const currentModelLabel = models.find(m => m.value === selectedModel)?.label ?? selectedModel;
  const selectedAgent = installedAgents.find(a => a.agent_id === selectedAgentId);
  const modelGroups = React.useMemo(() => {
    const q = modelSearchQuery.trim().toLowerCase();
    const filtered = q
      ? models.filter((m) => {
          const company = resolveModelCompany(m).toLowerCase();
          return (
            m.label.toLowerCase().includes(q) ||
            m.value.toLowerCase().includes(q) ||
            (m.provider ?? '').toLowerCase().includes(q) ||
            company.includes(q)
          );
        })
      : models;

    // When searching, show a flat list under matching company groups
    const groups = new Map<string, ModelOption[]>();
    for (const model of filtered) {
      const company = resolveModelCompany(model);
      if (!groups.has(company)) groups.set(company, []);
      groups.get(company)!.push(model);
    }

    const sorted = Array.from(groups.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([company, items]) => ({ company, items }));

    // Prepend a Popular group when not searching
    if (!q) {
      const popular = buildPopular(models);
      if (popular.length > 0) {
        return [{ company: '⭐ Popular', items: popular }, ...sorted];
      }
    }

    return sorted;
  }, [models, modelSearchQuery]);
  const hasMessages = messages.length > 0;
  const agentLocked = hasMessages;

  return (
    <div
      className="flex h-full min-h-0 bg-background overflow-hidden"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* ── Main chat column ── */}
      <div className={cn('flex flex-col h-full min-h-0 flex-1 min-w-0 overflow-hidden transition-all duration-300', canvas && 'hidden md:flex')}>

        {/* ── Header ── */}
        <div className="px-5 py-3 border-b border-border/50 bg-background/95 backdrop-blur-sm flex items-center gap-3 shrink-0">
          <div className={cn('h-9 w-9 rounded-xl flex items-center justify-center shrink-0 shadow-md', selectedAgent ? 'bg-gradient-to-br from-emerald-500 to-teal-600' : 'bg-gradient-to-br from-primary via-primary/90 to-violet-600')}>
            {selectedAgent ? <Cpu className="h-4.5 w-4.5 text-white" /> : <Zap className="h-4.5 w-4.5 text-white" />}
          </div>
          <div className="flex-1 min-w-0">
            <p className="font-semibold text-sm text-foreground leading-tight">
              {selectedAgent ? selectedAgent.name : 'mawaDao Assistant'}
            </p>
            <div className="flex items-center gap-1.5 mt-0.5">
              <span className={cn('h-1.5 w-1.5 rounded-full', isLoading ? 'bg-amber-400 animate-pulse' : 'bg-emerald-400')} />
              <p className="text-[11px] text-muted-foreground">
                {recovering ? 'Resuming…' : isLoading ? 'Thinking…' : selectedAgent ? selectedAgent.category || 'Agent' : 'Online'}
              </p>
            </div>
          </div>

          {/* Skills badge */}
          {enabledSkills.length > 0 && (
            <div className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-violet-500/10 text-violet-600 dark:text-violet-400 text-xs font-medium">
              <Sparkles className="h-3.5 w-3.5" />
              <span>{enabledSkills.length}</span>
            </div>
          )}
        </div>

        {/* ── Messages ── */}
        <div className="flex-1 overflow-y-auto overscroll-contain">
          <div className="max-w-3xl mx-auto px-4 py-6 space-y-6">

            {/* Provisioning overlay — shown instead of empty state while backend is deploying */}
            {!backendReady && (
              <div className="flex flex-col items-center justify-center min-h-[55vh] text-center px-4">
                {/* Animated icon */}
                <div className="relative mb-6">
                  <div className="w-20 h-20 rounded-3xl bg-gradient-to-br from-primary/20 to-violet-600/20 flex items-center justify-center">
                    <Rocket className="h-10 w-10 text-primary animate-pulse" />
                  </div>
                  {/* Orbiting dot */}
                  <div className="absolute inset-0 animate-spin" style={{ animationDuration: '3s' }}>
                    <div className="absolute -top-1 left-1/2 -translate-x-1/2 h-3 w-3 rounded-full bg-primary shadow-lg shadow-primary/40" />
                  </div>
                </div>

                <h2 className="text-2xl font-bold text-foreground mb-2 tracking-tight">Setting up your workspace</h2>
                <p className="text-sm text-muted-foreground max-w-sm leading-relaxed mb-6">
                  Your AI backend is being deployed. This usually takes a minute or two.
                </p>

                {/* Progress bar */}
                <div className="w-full max-w-sm mb-4">
                  <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
                    <div
                      className="h-full rounded-full bg-gradient-to-r from-primary via-violet-500 to-primary transition-all duration-1000 ease-out"
                      style={{ width: `${provPercent}%` }}
                    />
                  </div>
                  <div className="flex items-center justify-between mt-1.5">
                    <p className="text-xs text-muted-foreground font-mono">{currentProvMsg}</p>
                    <p className="text-xs text-muted-foreground tabular-nums">{provPercent}%</p>
                  </div>
                </div>

                {/* Phase steps */}
                <div className="space-y-2 mb-6">
                  <ProvisionStepIndicator label="Creating workspace" done={provPhase >= 1} active={provPhase === 0} />
                  <ProvisionStepIndicator label="Deploying AI backend" done={provPhase >= 2} active={provPhase === 1} />
                  <ProvisionStepIndicator label="Configuring environment" done={provPhase >= 3} active={provPhase === 2} />
                </div>

                {/* Rotating fun fact */}
                <div className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-primary/5 border border-primary/10 max-w-sm">
                  <Sparkles className="h-4 w-4 text-primary shrink-0" />
                  <p key={currentFact} className="text-xs text-muted-foreground animate-fade-in">
                    {currentFact}
                  </p>
                </div>

                <p className="text-[11px] text-muted-foreground/50 mt-6">
                  Polling every 8 seconds — hang tight
                </p>
              </div>
            )}

            {/* Empty state — Req #5: centered positioning, Req #8: removed top-center icon, Req #10: carousel suggestions with tooltips */}
            {!hasMessages && backendReady && (
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
                className="flex flex-col items-center justify-center min-h-[55vh] text-center px-4"
              >
                {/* Req #8: Removed the Zap icon + checkmark badge that was displayed at top-center */}
                <h2 className="text-2xl font-bold text-foreground mb-2 tracking-tight">What agent do you want to build?</h2>
                <p className="text-sm text-muted-foreground max-w-sm leading-relaxed">
                  Pick a use case below, or describe your own — I&apos;ll guide you through the setup, skills, and integrations.
                </p>
                {/* Req #10: Suggestion carousel with tooltips & card-based layout */}
                <SuggestionCarousel
                  suggestions={SUGGESTIONS}
                  onSelect={(s) => { useCaseGuideRef.current = s.guide; setInput(s.prompt); inputRef.current?.focus(); }}
                />
              </motion.div>
            )}

            {/* Messages — Req #11: smooth entry animations */}
            {messages.map((msg, msgIdx) => (
              <motion.div
                key={msg.id}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
                className={cn('flex gap-3 group', msg.role === 'user' ? 'justify-end' : 'justify-start')}
              >                {msg.role === 'assistant' && (
                  <div className="h-8 w-8 rounded-xl bg-gradient-to-br from-primary/15 to-violet-500/10 flex items-center justify-center shrink-0 mt-0.5 border border-primary/15">
                    <Bot className="h-4 w-4 text-primary" />
                  </div>
                )}

                <div className="flex flex-col">
                  <div className={cn(
                    'max-w-[85%] rounded-2xl px-4 py-3 shadow-sm',
                    msg.role === 'user'
                      ? 'bg-primary text-primary-foreground rounded-br-sm'
                      : 'bg-muted/50 dark:bg-muted/30 border border-border/50 rounded-bl-sm',
                  )}>
                    {msg.role === 'assistant' ? (
                      <div className="text-sm leading-relaxed [&_.markdown-prose]:text-foreground [&_.prose-text]:text-foreground/90 [&_.md-p]:mb-2 [&_.md-h1]:text-xl [&_.md-h1]:font-bold [&_.md-h1]:mb-3 [&_.md-h2]:text-lg [&_.md-h2]:font-semibold [&_.md-h2]:mb-2 [&_.md-h3]:text-base [&_.md-h3]:font-semibold [&_.md-h3]:mb-1.5 [&_.md-ul]:list-disc [&_.md-ul]:pl-5 [&_.md-ul]:mb-2 [&_.md-ol]:list-decimal [&_.md-ol]:pl-5 [&_.md-ol]:mb-2 [&_.md-uli]:mb-1 [&_.md-oli]:mb-1 [&_.md-link]:text-primary [&_.md-link]:underline [&_.md-blockquote]:border-l-4 [&_.md-blockquote]:border-primary/40 [&_.md-blockquote]:pl-3 [&_.md-blockquote]:italic [&_.md-blockquote]:text-muted-foreground [&_.inline-code]:bg-muted [&_.inline-code]:px-1.5 [&_.inline-code]:py-0.5 [&_.inline-code]:rounded [&_.inline-code]:font-mono [&_.inline-code]:text-[11px] [&_.inline-code]:text-primary">
                        {renderMessageParts(msg)}
                        {/* Persistent streaming indicator: keeps the "working…"
                            feeling alive from first token until response ends.
                            Only shown on the last assistant bubble while the
                            stream is active or while we are silently reconnecting. */}
                        {msgIdx === messages.length - 1
                          && msg.role === 'assistant'
                          && (status === 'streaming' || recovering) && (
                          <span
                            className="inline-flex items-center gap-1.5 mt-1 align-middle text-[11px] text-muted-foreground/80"
                            aria-live="polite"
                          >
                            <Loader2 className="h-3 w-3 animate-spin text-primary" />
                            <span className="animate-pulse">
                              {recovering ? 'Reconnecting…' : 'Generating…'}
                            </span>
                          </span>
                        )}
                      </div>
                    ) : (
                      <div className="text-sm">
                        {renderMessageParts(msg)}
                      </div>
                    )}
                  </div>

                  {/* Copy & Retry buttons for assistant messages */}
                  {msg.role === 'assistant' && (
                    <MessageActions
                      messageId={msg.id}
                      message={msg}
                      messages={messages}
                      setMessages={setMessages}
                      sendMessage={sendMessage}
                      isLoading={isLoading}
                    />
                  )}
                </div>

                {msg.role === 'user' && (
                  <div className="h-8 w-8 rounded-xl bg-primary/10 flex items-center justify-center shrink-0 mt-0.5 border border-primary/20">
                    <User className="h-4 w-4 text-primary" />
                  </div>
                )}
              </motion.div>
            ))}

            {/* Streaming engagement indicator (when submitted but no assistant tokens yet). */}
            {(status === 'submitted' || recovering) && (
              <ThinkingIndicator
                elapsedMs={thinkingElapsedMs}
                expectedSeconds={8}
                onCancel={() => stop()}
                recovering={recovering}
              />
            )}

            {/* Per-action live feed — short status updates for each backend action. */}
            <LiveActionsPanel conversationId={conversationId} className="mx-2" />

            {/* Error */}
            {status === 'error' && (
              <div className="flex items-center gap-3 px-4 py-3 rounded-xl bg-red-50 dark:bg-red-950/30 border border-red-200/60 dark:border-red-900/30 text-red-600 dark:text-red-400">
                <AlertCircle className="h-4 w-4 shrink-0" />
                <span className="text-sm flex-1">{error?.message || 'Something went wrong. Please try again.'}</span>
                <button
                  onClick={() => { clearError(); }}
                  className="flex items-center gap-1 text-xs font-medium hover:underline shrink-0"
                >
                  <RotateCcw className="h-3 w-3" />
                  Dismiss
                </button>
              </div>
            )}

            <div ref={scrollRef} />
          </div>
        </div>

        {/* ── Drag overlay — Req #6, #11: animated file drop zone ── */}
        <AnimatePresence>
        {isDragging && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="absolute inset-0 z-40 bg-primary/5 dark:bg-primary/10 border-2 border-dashed border-primary/40 rounded-2xl flex items-center justify-center pointer-events-none backdrop-blur-sm"
          >
            <div className="text-center">
              <FileIcon className="h-12 w-12 text-primary/60 mx-auto mb-2" />
              <p className="text-primary font-semibold text-sm">Drop files to attach</p>
            </div>
          </motion.div>
        )}
        </AnimatePresence>

        {/* ── Input Area — Req #5: dynamic positioning (bottom after first msg) ── */}
        <motion.div
          layout
          transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
          className="border-t border-border/50 bg-background/95 backdrop-blur-sm px-4 py-3 pb-[calc(0.75rem+3.5rem)] md:pb-3 shrink-0"
        >
          <div className="max-w-3xl mx-auto">

            {/* Req #9: Redesigned composer toolbar — model + agent selectors */}
            <div className="flex items-center justify-between mb-2 px-1">
              <div className="flex items-center gap-2">
                {/* Req #9: Modern model selector with glass-morphism styling */}
                <div className="relative" ref={modelDropdownRef}>
                  <button
                    type="button"
                    onClick={() => setModelDropdownOpen(o => !o)}
                    className="flex items-center gap-2 px-3 py-1.5 rounded-xl border border-border/60 bg-card/80 dark:bg-card/60 backdrop-blur-sm hover:bg-muted/80 dark:hover:bg-muted/40 text-xs text-foreground transition-all duration-200 max-w-[220px] shadow-sm hover:shadow-md"
                  >
                    <Sparkles className="h-3.5 w-3.5 text-primary shrink-0" />
                    <span className="truncate font-medium">{currentModelLabel}</span>
                    {modelSaving && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground shrink-0" />}
                    <ChevronDown className={cn('h-3 w-3 text-muted-foreground shrink-0 transition-transform duration-200', modelDropdownOpen && 'rotate-180')} />
                  </button>
                <AnimatePresence>
                {modelDropdownOpen && (
                  <motion.div
                    initial={{ opacity: 0, y: 8, scale: 0.96 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: 8, scale: 0.96 }}
                    transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
                    className="absolute left-0 bottom-full mb-1.5 w-80 rounded-2xl border border-border/60 bg-card/95 dark:bg-card/90 backdrop-blur-xl shadow-elevated z-50 max-h-96 overflow-hidden"
                  >
                    {modelsLoading ? (
                      <div className="flex items-center justify-center py-5">
                        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                      </div>
                    ) : (
                      <>
                        <div className="p-2.5 border-b border-border/40">
                          <div className="relative">
                            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                            <input
                              value={modelSearchQuery}
                              onChange={(e) => setModelSearchQuery(e.target.value)}
                              placeholder="Search models or provider..."
                              className="w-full pl-8 pr-3 py-2 rounded-xl border border-border/40 bg-background/60 dark:bg-background/40 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all duration-200"
                              aria-label="Search models"
                            />
                          </div>
                        </div>

                        <div className="max-h-80 overflow-y-auto py-1.5 scrollbar-hide">
                          {modelGroups.length === 0 ? (
                            <p className="px-3.5 py-3 text-xs text-muted-foreground">No models match your search.</p>
                          ) : (
                            modelGroups.map((group) => (
                              <div key={group.company} className="py-1">
                                <p className="px-3.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                                  {group.company}
                                </p>
                                {group.items.map((m) => (
                                  <button
                                    key={m.value}
                                    type="button"
                                    onClick={() => { void chooseModel(m.value); }}
                                    className={cn(
                                      'flex items-center gap-2.5 w-full px-3.5 py-2.5 text-sm transition-all duration-150 text-left rounded-lg mx-1 max-w-[calc(100%-0.5rem)]',
                                      selectedModel === m.value
                                        ? 'bg-primary/10 dark:bg-primary/15 text-primary font-medium'
                                        : 'text-foreground hover:bg-muted/60 dark:hover:bg-muted/30',
                                    )}
                                  >
                                    <div className="w-4 shrink-0 flex items-center justify-center">
                                      {selectedModel === m.value && <Check className="h-3.5 w-3.5" />}
                                    </div>
                                    <div className="flex flex-col min-w-0 flex-1">
                                      <span className="truncate text-sm">{m.label}</span>
                                      <span className="text-[10px] text-muted-foreground capitalize">
                                        {m.provider || group.company}
                                      </span>
                                    </div>
                                  </button>
                                ))}
                              </div>
                            ))
                          )}
                        </div>

                        <div className="border-t border-border/40 p-2">
                          <button
                            type="button"
                            onClick={() => { setModelDropdownOpen(false); window.location.href = '/settings?tab=openclaw'; }}
                            className="flex items-center gap-2 w-full px-3 py-2 rounded-xl text-xs text-primary hover:bg-primary/5 dark:hover:bg-primary/10 transition-all duration-200 font-medium"
                          >
                            <Plus className="h-3.5 w-3.5" />
                            Add Models
                          </button>
                        </div>
                      </>
                    )}
                  </motion.div>
                )}
                </AnimatePresence>
              </div>

              {/* Req #9: Redesigned agent selector with modern styling */}
              <div className="relative" ref={agentDropdownRef}>
                <button
                  type="button"
                  onClick={() => !agentLocked && setAgentDropdownOpen(o => !o)}
                  disabled={agentLocked}
                  title={agentLocked ? 'Start a new chat to change agent' : undefined}
                  aria-label={selectedAgent ? `Agent: ${selectedAgent.name}` : 'Select agent'}
                  className={cn(
                    'flex items-center gap-2 px-3 py-1.5 rounded-xl border text-xs transition-all duration-200 max-w-[200px] shadow-sm',
                    agentLocked
                      ? 'border-border/30 bg-card/40 dark:bg-card/20 text-muted-foreground cursor-not-allowed opacity-60'
                      : selectedAgent
                        ? 'border-emerald-500/30 bg-emerald-500/8 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-500/15 dark:hover:bg-emerald-500/25 hover:shadow-md'
                        : 'border-border/60 bg-card/80 dark:bg-card/60 backdrop-blur-sm hover:bg-muted/80 dark:hover:bg-muted/40 text-foreground hover:shadow-md',
                  )}
                >
                  {agentLocked
                    ? <Lock className="h-3.5 w-3.5 shrink-0" />
                    : <Cpu className="h-3.5 w-3.5 shrink-0" />}
                  <span className="truncate font-medium">{selectedAgent ? selectedAgent.name : 'No agent'}</span>
                  {!agentLocked && <ChevronDown className={cn('h-3 w-3 text-muted-foreground shrink-0 transition-transform duration-200', agentDropdownOpen && 'rotate-180')} />}
                </button>
                <AnimatePresence>
                {agentDropdownOpen && !agentLocked && (
                  <motion.div
                    initial={{ opacity: 0, y: 8, scale: 0.96 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: 8, scale: 0.96 }}
                    transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
                    className="absolute left-0 bottom-full mb-1.5 w-72 rounded-2xl border border-border/60 bg-card/95 dark:bg-card/90 backdrop-blur-xl shadow-elevated z-50 max-h-80 overflow-hidden"
                  >
                    <div className="max-h-72 overflow-y-auto py-1.5 scrollbar-hide">
                      {/* None option */}
                      <button
                        type="button"
                        onClick={() => { selectAgent(null); setAgentDropdownOpen(false); }}
                        className={cn(
                          'flex items-center gap-2.5 w-full px-3.5 py-2.5 text-sm transition-all duration-150 text-left rounded-lg mx-1 max-w-[calc(100%-0.5rem)]',
                          !selectedAgentId
                            ? 'bg-primary/10 dark:bg-primary/15 text-primary font-medium'
                            : 'text-foreground hover:bg-muted/60 dark:hover:bg-muted/30',
                        )}
                      >
                        <div className="w-4 shrink-0 flex items-center justify-center">
                          {!selectedAgentId && <Check className="h-3.5 w-3.5" />}
                        </div>
                        <div className="flex flex-col min-w-0 flex-1">
                          <span className="text-sm">Default OpenClaw</span>
                          <span className="text-[10px] text-muted-foreground">No agent personality</span>
                        </div>
                      </button>

                      {installedAgents.length === 0 ? (
                        <p className="px-3.5 py-3 text-xs text-muted-foreground">
                          No agents installed. Visit Agent Builder or Marketplace to add agents.
                        </p>
                      ) : (
                        installedAgents.map(a => (
                          <button
                            key={a.agent_id}
                            type="button"
                            onClick={() => { selectAgent(a.agent_id); setAgentDropdownOpen(false); }}
                            className={cn(
                              'flex items-center gap-2.5 w-full px-3.5 py-2.5 text-sm transition-all duration-150 text-left rounded-lg mx-1 max-w-[calc(100%-0.5rem)]',
                              selectedAgentId === a.agent_id
                                ? 'bg-primary/10 dark:bg-primary/15 text-primary font-medium'
                                : 'text-foreground hover:bg-muted/60 dark:hover:bg-muted/30',
                            )}
                          >
                            <div className="w-4 shrink-0 flex items-center justify-center">
                              {selectedAgentId === a.agent_id && <Check className="h-3.5 w-3.5" />}
                            </div>
                            <div className="flex flex-col min-w-0 flex-1">
                              <span className="truncate text-sm">{a.name}</span>
                              <span className="text-[10px] text-muted-foreground capitalize">{a.category || 'General'}</span>
                            </div>
                          </button>
                        ))
                      )}
                    </div>
                  </motion.div>
                )}
                </AnimatePresence>
              </div>
              </div>

              {enabledSkills.length > 0 && (
                <div className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-violet-500/8 dark:bg-violet-500/15 text-violet-600 dark:text-violet-400 text-[11px] font-medium transition-colors">
                  <Sparkles className="h-3 w-3" />
                  <span>{enabledSkills.length} skills</span>
                </div>
              )}
            </div>

            {/* Req #6: File previews with animated entry */}
            <AnimatePresence>
            {attachedFiles.length > 0 && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.2 }}
                className="flex gap-2 mb-2.5 flex-wrap"
              >
                {attachedFiles.map(af => (
                  <motion.div
                    key={af.id}
                    initial={{ opacity: 0, scale: 0.8 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.8 }}
                    transition={{ duration: 0.2 }}
                    className="relative group"
                  >
                    {af.type === 'image' && af.previewUrl ? (
                      <div className="relative">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={af.previewUrl} alt={af.file.name} className="h-16 w-16 object-cover rounded-xl border border-border/60 shadow-sm" />
                        <button
                          type="button"
                          onClick={() => removeFile(af.id)}
                          aria-label={`Remove ${af.file.name}`}
                          className="absolute -top-1.5 -right-1.5 h-5 w-5 rounded-full bg-foreground text-background flex items-center justify-center opacity-0 group-hover:opacity-100 transition-all duration-200 shadow-sm hover:scale-110"
                        >
                          <X className="h-3 w-3" />
                        </button>
                        <div className="absolute bottom-0 left-0 right-0 bg-black/50 rounded-b-xl px-1 py-0.5">
                          <p className="text-[9px] text-white truncate">{fmtSize(af.file.size)}</p>
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-center gap-1.5 bg-muted/60 dark:bg-muted/30 rounded-xl pl-2.5 pr-1 py-1.5 text-xs max-w-[150px] border border-border/60">
                        {af.type === 'text' ? (
                          <FileText className="h-3.5 w-3.5 text-primary shrink-0" />
                        ) : (
                          <FileIcon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                        )}
                        <span className="truncate">{af.file.name}</span>
                        <button
                          type="button"
                          onClick={() => removeFile(af.id)}
                          aria-label={`Remove ${af.file.name}`}
                          className="text-muted-foreground hover:text-foreground transition-colors shrink-0 ml-0.5"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </div>
                    )}
                  </motion.div>
                ))}
              </motion.div>
            )}
            </AnimatePresence>

            {/* Req #1: Removed voice recorder/Mic button. Req #7: Loading animation on send. Req #6: Click-to-select file picker. */}
            <div className="flex items-end gap-1.5 sm:gap-2 rounded-2xl border border-border/60 bg-muted/20 dark:bg-muted/10 px-2 sm:px-3 py-2 sm:py-2.5 focus-within:ring-2 focus-within:ring-primary/20 focus-within:border-primary/40 transition-all duration-300 shadow-sm focus-within:shadow-md">
              {/* Req #6: Attach file button (click-to-select + drag-and-drop supported via parent handler) */}
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="h-8 w-8 shrink-0 flex items-center justify-center rounded-xl text-muted-foreground hover:text-foreground hover:bg-muted/60 dark:hover:bg-muted/30 transition-all duration-200"
                title="Attach file (or drag & drop / paste image)"
                aria-label="Attach file"
              >
                <Paperclip className="h-4 w-4" />
              </button>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept="image/*,text/*,.pdf,.doc,.docx,.xls,.xlsx,.json,.yaml,.yml,.md,.csv,.sql"
                onChange={handleFileInput}
                className="hidden"
                aria-hidden="true"
              />

              {/* Textarea */}
              <textarea
                ref={inputRef}
                value={input}
                onChange={handleInputChange}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
                rows={1}
                disabled={isLoading || recovering || !backendReady}
                placeholder={!backendReady ? (tenantStatus === 'provisioning' ? 'Your AI backend is still launching…' : 'Backend not ready yet…') : recovering ? 'Still generating…' : 'Message OpenClaw…'}
                className="flex-1 min-w-0 bg-transparent text-sm placeholder:text-muted-foreground focus:outline-none resize-none leading-relaxed min-h-[28px] max-h-32 disabled:opacity-50"
                style={{ paddingTop: '2px', paddingBottom: '2px' }}
                aria-label="Chat message input"
              />

              {/* Req #7: Dynamic send button — loading animation during processing */}
              <AnimatePresence mode="wait">
                {isLoading || recovering ? (
                  <motion.button
                    key="stop"
                    initial={{ scale: 0.8, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    exit={{ scale: 0.8, opacity: 0 }}
                    transition={{ duration: 0.15 }}
                    type="button"
                    onClick={() => { stop(); setRecovering(false); }}
                    className="h-8 w-8 shrink-0 flex items-center justify-center rounded-xl bg-destructive/10 dark:bg-destructive/20 text-destructive hover:bg-destructive/20 dark:hover:bg-destructive/30 transition-all duration-200"
                    aria-label="Stop generating"
                  >
                    <StopCircle className="h-4 w-4" />
                  </motion.button>
                ) : (
                  <motion.button
                    key="send"
                    initial={{ scale: 0.8, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    exit={{ scale: 0.8, opacity: 0 }}
                    transition={{ duration: 0.15 }}
                    type="button"
                    onClick={handleSend}
                    disabled={(!input.trim() && attachedFiles.length === 0) || !backendReady}
                    className="h-8 w-8 shrink-0 flex items-center justify-center rounded-xl bg-primary text-primary-foreground hover:bg-primary/90 transition-all duration-200 disabled:opacity-40 disabled:cursor-not-allowed shadow-sm hover:shadow-md disabled:shadow-none"
                    aria-label="Send message"
                  >
                    <Send className="h-3.5 w-3.5" />
                  </motion.button>
                )}
              </AnimatePresence>
            </div>

            <div className="hidden sm:flex items-center justify-between mt-1.5 px-1">
              <p className="text-[10px] text-muted-foreground/60">
                Drag &amp; drop files · paste images · Shift+Enter for newline
              </p>
              <p className="text-[10px] text-muted-foreground/40">
                May produce errors
              </p>
            </div>
          </div>
        </motion.div>
      </div>

      {/* ── Code Canvas panel ── */}
      {canvas && (
        <div className="w-full md:w-[45%] md:min-w-[380px] md:max-w-[600px] h-full border-l border-border/50 flex flex-col overflow-hidden">
          <CodeCanvas
            blocks={canvas.blocks}
            activeId={canvas.activeId}
            onClose={() => setCanvas(null)}
          />
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Req #10: SuggestionCarousel — carousel navigation for suggestion chips
// with informational tooltips, card-based layout, and modern animations
// ═══════════════════════════════════════════════════════════════════════════════
function SuggestionCarousel({ suggestions, onSelect }: {
  suggestions: typeof SUGGESTIONS;
  onSelect: (s: typeof SUGGESTIONS[number]) => void;
}) {
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const cardRefs = React.useRef<(HTMLButtonElement | null)[]>([]);
  const [canScrollLeft, setCanScrollLeft] = React.useState(false);
  const [canScrollRight, setCanScrollRight] = React.useState(true);
  const [hoveredIdx, setHoveredIdx] = React.useState<number | null>(null);
  const [tooltipPos, setTooltipPos] = React.useState<{ left: number; top: number; arrowLeft: number } | null>(null);

  const checkScroll = React.useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setCanScrollLeft(el.scrollLeft > 4);
    setCanScrollRight(el.scrollLeft < el.scrollWidth - el.clientWidth - 4);
  }, []);

  React.useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    checkScroll();
    el.addEventListener('scroll', checkScroll, { passive: true });
    const ro = new ResizeObserver(checkScroll);
    ro.observe(el);
    return () => { el.removeEventListener('scroll', checkScroll); ro.disconnect(); };
  }, [checkScroll]);

  // Compute tooltip position relative to the outer container when hovered card changes
  React.useEffect(() => {
    if (hoveredIdx === null) { setTooltipPos(null); return; }
    const card = cardRefs.current[hoveredIdx];
    const container = containerRef.current;
    if (!card || !container) { setTooltipPos(null); return; }
    const cardRect = card.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    // Tooltip is w-56 (224px). Clamp center so the tooltip never overflows the
    // container; then offset the arrow back to the card's true center so the
    // pointer always points at the hovered card.
    const TOOLTIP_WIDTH = 224;
    const HALF = TOOLTIP_WIDTH / 2;
    const PAD = 8; // breathing room from container edges
    const cardCenterInContainer = cardRect.left + cardRect.width / 2 - containerRect.left;
    const minLeft = HALF + PAD;
    const maxLeft = Math.max(minLeft, containerRect.width - HALF - PAD);
    const clampedLeft = Math.min(Math.max(cardCenterInContainer, minLeft), maxLeft);
    // Arrow x within tooltip (0..TOOLTIP_WIDTH). Tooltip is positioned with
    // translateX(-50%), so its left edge is at clampedLeft - HALF.
    const arrowLeft = Math.min(
      Math.max(cardCenterInContainer - (clampedLeft - HALF), 12),
      TOOLTIP_WIDTH - 12,
    );
    setTooltipPos({
      left: clampedLeft,
      top: cardRect.bottom - containerRect.top + 8,
      arrowLeft,
    });
  }, [hoveredIdx]);

  const scroll = (dir: 'left' | 'right') => {
    const el = scrollRef.current;
    if (!el) return;
    const amount = el.clientWidth * 0.6;
    el.scrollBy({ left: dir === 'left' ? -amount : amount, behavior: 'smooth' });
  };

  return (
    <div ref={containerRef} className="relative w-full max-w-2xl mt-8 pb-16">
      {/* Scroll area with navigation arrows */}
      <div className="relative">
        {/* Scrollable container — extra horizontal padding to keep arrows inside bounds */}
        <div
          ref={scrollRef}
          className="flex gap-3 overflow-x-auto scrollbar-hide px-8 py-1"
          role="list"
          aria-label="Suggested use cases"
        >
          {suggestions.map((s, idx) => {
            const Icon = s.icon;
            return (
              <motion.button
                key={s.label}
                ref={(el) => { cardRefs.current[idx] = el; }}
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.35, delay: idx * 0.04, ease: [0.22, 1, 0.36, 1] }}
                type="button"
                role="listitem"
                onClick={() => onSelect(s)}
                onMouseEnter={() => setHoveredIdx(idx)}
                onMouseLeave={() => setHoveredIdx(null)}
                className="group/chip relative flex-shrink-0 w-44 px-4 py-3.5 rounded-2xl border border-border/50 bg-card/80 dark:bg-card/60 hover:bg-primary/5 dark:hover:bg-primary/10 hover:border-primary/30 text-xs text-muted-foreground hover:text-foreground transition-all duration-200 text-left leading-snug shadow-sm hover:shadow-md"
              >
                <div className="flex items-center gap-2.5 mb-1.5">
                  <div className="h-8 w-8 rounded-xl bg-primary/8 dark:bg-primary/15 group-hover/chip:bg-primary/15 dark:group-hover/chip:bg-primary/25 flex items-center justify-center shrink-0 transition-all duration-200">
                    <Icon className="h-4 w-4 text-primary" />
                  </div>
                  <Info className="h-3 w-3 text-muted-foreground/40 group-hover/chip:text-muted-foreground/70 transition-colors" />
                </div>
                <span className="font-semibold text-foreground/90 text-[13px]">{s.label}</span>
              </motion.button>
            );
          })}
        </div>

        {/* Left arrow — inset so it doesn't overflow into other UI */}
        <AnimatePresence>
          {canScrollLeft && (
            <motion.button
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              type="button"
              onClick={() => scroll('left')}
              className="absolute left-0 top-1/2 -translate-y-1/2 h-8 w-8 rounded-full bg-card border border-border/60 shadow-md flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-all duration-200"
              aria-label="Scroll suggestions left"
            >
              <ChevronLeft className="h-4 w-4" />
            </motion.button>
          )}
        </AnimatePresence>
        {/* Right arrow — inset */}
        <AnimatePresence>
          {canScrollRight && (
            <motion.button
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              type="button"
              onClick={() => scroll('right')}
              className="absolute right-0 top-1/2 -translate-y-1/2 z-10 h-8 w-8 rounded-full bg-card border border-border/60 shadow-md flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-all duration-200"
              aria-label="Scroll suggestions right"
            >
              <ChevronRight className="h-4 w-4" />
            </motion.button>
          )}
        </AnimatePresence>
      </div>

      {/* Tooltip — rendered outside the scroll container so it's never clipped */}
      <AnimatePresence>
        {hoveredIdx !== null && tooltipPos && (
          <motion.div
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.15 }}
            className="absolute w-56 px-3 py-2.5 rounded-xl bg-foreground text-background text-[11px] leading-relaxed shadow-xl z-50 pointer-events-none"
            style={{ left: tooltipPos.left, top: tooltipPos.top, transform: 'translateX(-50%)' }}
          >
            <div
              className="absolute bottom-full mb-[-1px] w-2 h-2 bg-foreground rotate-45"
              style={{ left: tooltipPos.arrowLeft, transform: 'translateX(-50%)' }}
            />
            {suggestions[hoveredIdx].prompt.slice(0, 140)}…
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ProvisionStepIndicator — phase indicator for the deployment overlay
// ═══════════════════════════════════════════════════════════════════════════════
function ProvisionStepIndicator({ label, done, active }: { label: string; done: boolean; active?: boolean }) {
  return (
    <div className="flex items-center gap-3 justify-center">
      <div className="w-5 h-5 flex items-center justify-center">
        {done ? (
          <Check className="h-4 w-4 text-emerald-500" />
        ) : active ? (
          <Loader2 className="h-4 w-4 animate-spin text-primary" />
        ) : (
          <div className="w-2 h-2 rounded-full bg-muted-foreground/30" />
        )}
      </div>
      <span
        className={cn(
          'text-sm',
          done && 'text-emerald-600 dark:text-emerald-400',
          active && 'text-foreground font-medium',
          !done && !active && 'text-muted-foreground',
        )}
      >
        {label}
      </span>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ChatPanel — outer wrapper that loads history then renders inner
// ═══════════════════════════════════════════════════════════════════════════════
export function ChatPanel({ apiKey, conversationId, onConversationCreated, agentId: agentIdProp }: Readonly<{ apiKey: string | null; conversationId?: string; onConversationCreated?: (id: string) => void; agentId?: string }>) {
  const { user, agent } = useAuth();
  const userId = user?.id || agent?.id || 'anonymous';
  const { selectAgent } = useInstalledAgentsStore();
  const [initialMessages, setInitialMessages] = React.useState<UIMessage[]>([]);
  const [historyLoading, setHistoryLoading] = React.useState(!!conversationId);
  const [streamRecovery, setStreamRecovery] = React.useState(false);

  React.useEffect(() => {
    // Capture the conversationId at mount time only.
    // When a conversation is auto-created (undefined→id) we do NOT re-fetch — the
    // ChatPanelInner is already live with the correct messages in useChat state.
    const initialConvId = conversationId;
    console.log('[ChatPanel] mount — conversationId:', initialConvId, 'userId:', userId);
    if (!initialConvId) { setHistoryLoading(false); setInitialMessages([]); return; }
    let cancelled = false;
    setHistoryLoading(true);

    // Retry up to 2 times on failure (handles intermittent network / cold-start issues)
    async function loadMessages(attempt = 1): Promise<void> {
      try {
        const r = await fetch(`/api/conversations/${initialConvId}/messages`, {
          headers: { 'x-user-id': userId },
          credentials: 'include', // ensure httpOnly auth-token cookie is always sent
        });
        console.log('[ChatPanel] messages fetch status:', r.status, 'for conv:', initialConvId, 'attempt:', attempt);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data: { messages?: DBMessage[]; agentId?: string | null; isStreaming?: boolean } = await r.json();
        if (cancelled) return;
        console.log('[ChatPanel] loaded', data.messages?.length ?? 0, 'messages for', initialConvId, 'agentId:', data.agentId, 'isStreaming:', data.isStreaming);
        if (data.messages && data.messages.length > 0) {
          console.log('[ChatPanel] first msg:', data.messages[0].role, data.messages[0].content?.slice(0, 80));
        }
        // Restore the agent that was selected when this conversation was started
        if (data.agentId !== undefined) selectAgent(data.agentId ?? null);
        const msgs: UIMessage[] = (data.messages ?? []).map(m => ({
          id: m.id,
          role: m.role as 'user' | 'assistant',
          parts: [{ type: 'text' as const, text: m.content }],
        }));
        setInitialMessages(msgs);
        // Detect active stream that was interrupted by page refresh
        if (data.isStreaming) {
          console.log('[ChatPanel] conversation is still streaming — starting recovery polling');
          setStreamRecovery(true);
        }
      } catch (err) {
        console.error(`[ChatPanel] history fetch error (attempt ${attempt}):`, err);
        if (attempt < 3 && !cancelled) {
          // Exponential back-off: 500ms then 1.5s
          await new Promise(res => setTimeout(res, attempt * 500));
          return loadMessages(attempt + 1);
        }
      }
    }

    loadMessages().finally(() => { if (!cancelled) setHistoryLoading(false); });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // intentionally empty — only run on mount with the initial conversationId

  if (historyLoading) {
    return <ChatSkeleton />;
  }

  return (
    <ChatPanelInner
      apiKey={apiKey}
      conversationId={conversationId}
      initialMessages={initialMessages}
      userId={userId}
      onConversationCreated={onConversationCreated}
      agentId={agentIdProp}
      isStreamRecovery={streamRecovery}
    />
  );
}
