'use client';

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { useRouter } from '@/lib/member-path';
import Link from '@/components/member-link';
import useSWR from 'swr';
import { toast } from 'sonner';
import {
  Card,
  Button,
  Badge,
  Input,
  Skeleton,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui';
import { SidebarLayout, InboxSidebar } from '@/components/layout/sidebar';
import {
  ArrowLeft,
  Bot,
  Loader2,
  Mail,
  MailOpen,
  RefreshCw,
  Search,
  Send,
  FileText,
  Archive,
} from 'lucide-react';
import type { InboxAccountSummary } from '@/lib/inbox/types';

interface MessageMeta {
  id: string;
  threadId: string;
  labelIds: string[];
  snippet: string;
  internalDate: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  unread: boolean;
}

interface MessageFull extends MessageMeta {
  body: { text: string | null; html: string | null };
  headers: Record<string, string>;
  attachments: Array<{ id: string; filename: string; mimeType: string; size: number }>;
}

interface GmailLabel {
  id: string;
  name: string;
  type: 'system' | 'user';
  messagesUnread?: number;
}

const fetcher = async (url: string) => {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${body.slice(0, 200)}`);
  }
  return res.json();
};

function shortFrom(raw: string): string {
  // "Display Name <email@example.com>" → "Display Name"
  const m = raw.match(/^"?([^"<]+?)"?\s*<.+>$/);
  return (m?.[1] ?? raw).trim() || raw;
}

function formatDate(internalDate: string): string {
  const d = new Date(Number(internalDate));
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
}

export default function MailboxPage() {
  return (
    <SidebarLayout sidebar={<InboxSidebar />}>
      <Suspense
        fallback={
          <div className="flex items-center justify-center min-h-[60vh]">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        }
      >
        <Mailbox />
      </Suspense>
    </SidebarLayout>
  );
}

function Mailbox() {
  const params = useParams<{ accountId: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const accountId = params.accountId;

  const activeLabel = (searchParams.get('label') ?? 'INBOX').toUpperCase();
  const [searchInput, setSearchInput] = useState('');
  const [searchQ, setSearchQ] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [botOpen, setBotOpen] = useState(false);

  // Reset selection whenever the active label changes via URL.
  useEffect(() => {
    setSelectedId(null);
  }, [activeLabel]);

  // Account info
  const accountsSwr = useSWR<{ data: InboxAccountSummary[] }>('/api/inbox/accounts', fetcher);
  const account = useMemo(
    () => accountsSwr.data?.data.find((a) => a.id === accountId) ?? null,
    [accountsSwr.data, accountId],
  );

  // Labels — fetched here so the Refresh button can revalidate them; the
  // sidebar reads from the same SWR key and shares this cache.
  const labelsSwr = useSWR<{ data: GmailLabel[] }>(
    accountId ? `/api/inbox/accounts/${accountId}/labels` : null,
    fetcher,
  );

  // Messages list
  const messagesUrl = useMemo(() => {
    if (!accountId) return null;
    const params = new URLSearchParams();
    params.set('maxResults', '25');
    if (activeLabel) params.set('labelIds', activeLabel);
    if (searchQ) params.set('q', searchQ);
    return `/api/inbox/accounts/${accountId}/messages?${params.toString()}`;
  }, [accountId, activeLabel, searchQ]);

  const messagesSwr = useSWR<{ data: { messages: MessageMeta[]; nextPageToken: string | null; resultSizeEstimate: number } }>(
    messagesUrl,
    fetcher,
    { keepPreviousData: true },
  );
  const messages = messagesSwr.data?.data.messages ?? [];

  // Selected message detail
  const detailSwr = useSWR<{ data: MessageFull }>(
    selectedId && accountId ? `/api/inbox/accounts/${accountId}/messages/${selectedId}` : null,
    fetcher,
  );

  // Reauth handler — surface 401 from any request
  useEffect(() => {
    const err = messagesSwr.error || detailSwr.error || labelsSwr.error;
    if (err && /HTTP 401/.test(String(err.message))) {
      toast.error('Gmail authorisation expired. Reconnect this account from /inbox.');
    }
  }, [messagesSwr.error, detailSwr.error, labelsSwr.error]);

  const handleSearch = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    setSearchQ(searchInput.trim());
    setSelectedId(null);
  }, [searchInput]);

  const handleMarkRead = useCallback(async (msg: MessageMeta) => {
    if (!msg.unread) return;
    try {
      await fetch(`/api/inbox/accounts/${accountId}/messages/${msg.id}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ removeLabelIds: ['UNREAD'] }),
      });
      messagesSwr.mutate();
    } catch (err) {
      console.error('[mailbox] mark read failed', err);
    }
  }, [accountId, messagesSwr]);

  const handleArchive = useCallback(async (msg: MessageMeta) => {
    try {
      const res = await fetch(`/api/inbox/accounts/${accountId}/messages/${msg.id}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ removeLabelIds: ['INBOX'] }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      toast.success('Archived');
      setSelectedId(null);
      messagesSwr.mutate();
    } catch (err) {
      console.error('[mailbox] archive failed', err);
      toast.error('Failed to archive');
    }
  }, [accountId, messagesSwr]);

  return (
    <div className="container max-w-7xl mx-auto py-6 px-4 sm:px-6 lg:px-8">
      {/* Header */}
      <div className="flex items-center justify-between gap-4 mb-4">
        <div className="flex items-center gap-3 min-w-0">
          <Button variant="ghost" size="sm" onClick={() => router.push('/inbox')} className="gap-1.5">
            <ArrowLeft className="h-4 w-4" />
            Inboxes
          </Button>
          <div className="min-w-0">
            <h1 className="text-lg font-semibold truncate">{account?.account_email ?? 'Loading…'}</h1>
            <p className="text-xs text-muted-foreground">Gmail mailbox</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setBotOpen(true)}
            className="gap-1.5"
          >
            <Bot className="h-4 w-4" />
            mawaDao Bot
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              messagesSwr.mutate();
              labelsSwr.mutate();
            }}
            disabled={messagesSwr.isValidating}
            className="gap-1.5"
          >
            <RefreshCw className={`h-4 w-4 ${messagesSwr.isValidating ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </div>
      </div>

      {/* 2-pane layout (folder rail lives in the left InboxSidebar) */}
      <div className="grid grid-cols-12 gap-4 h-[calc(100vh-12rem)]">
        {/* Message list */}
        <section className="col-span-12 md:col-span-5 lg:col-span-5">
          <Card className="h-full flex flex-col overflow-hidden">
            <div className="p-3 border-b">
              <form onSubmit={handleSearch} className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  placeholder="Search mail (Gmail syntax)…"
                  className="pl-8 h-9 text-sm"
                />
              </form>
            </div>
            <div className="flex-1 overflow-y-auto min-h-0 divide-y">
              {messagesSwr.isLoading && !messagesSwr.data && (
                <div className="p-3 space-y-2">
                  {Array.from({ length: 6 }).map((_, i) => (
                    <Skeleton key={i} className="h-14 w-full" />
                  ))}
                </div>
              )}
              {messagesSwr.error && !messagesSwr.isLoading && (
                <div className="p-6 text-center text-sm text-destructive">
                  Failed to load messages.
                </div>
              )}
              {!messagesSwr.isLoading && messages.length === 0 && (
                <div className="p-10 text-center text-sm text-muted-foreground">
                  No messages.
                </div>
              )}
              {messages.map((msg) => {
                const active = selectedId === msg.id;
                return (
                  <button
                    key={msg.id}
                    onClick={() => {
                      setSelectedId(msg.id);
                      handleMarkRead(msg);
                    }}
                    className={`w-full text-left px-3 py-2.5 hover:bg-muted/60 transition-colors ${
                      active ? 'bg-muted' : ''
                    } ${msg.unread ? 'font-medium' : ''}`}
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-sm truncate flex-1 flex items-center gap-1.5">
                        {msg.unread ? (
                          <Mail className="h-3.5 w-3.5 text-primary shrink-0" />
                        ) : (
                          <MailOpen className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                        )}
                        {shortFrom(msg.from)}
                      </span>
                      <span className="text-[11px] text-muted-foreground shrink-0">
                        {formatDate(msg.internalDate)}
                      </span>
                    </div>
                    <div className="text-sm truncate mt-0.5">{msg.subject}</div>
                    <div className="text-xs text-muted-foreground truncate mt-0.5 font-normal">
                      {msg.snippet}
                    </div>
                  </button>
                );
              })}
            </div>
          </Card>
        </section>

        {/* Message detail */}
        <section className="col-span-12 md:col-span-7 lg:col-span-7">
          <Card className="h-full flex flex-col overflow-hidden">
            {!selectedId && (
              <div className="flex-1 flex flex-col items-center justify-center text-center p-10">
                <div className="h-12 w-12 rounded-2xl bg-muted flex items-center justify-center mb-3">
                  <Mail className="h-6 w-6 text-muted-foreground" />
                </div>
                <p className="text-sm text-muted-foreground">Select a message to read.</p>
              </div>
            )}
            {selectedId && detailSwr.isLoading && (
              <div className="p-6 space-y-3">
                <Skeleton className="h-6 w-2/3" />
                <Skeleton className="h-4 w-1/3" />
                <div className="pt-4 space-y-2">
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-4 w-5/6" />
                </div>
              </div>
            )}
            {selectedId && detailSwr.error && !detailSwr.isLoading && (
              <div className="p-10 text-center text-sm text-destructive">
                Failed to load message.
              </div>
            )}
            {selectedId && detailSwr.data && (
              <MessageDetail
                msg={detailSwr.data.data}
                onArchive={() => handleArchive(detailSwr.data!.data)}
              />
            )}
          </Card>
        </section>
      </div>

      {/* Footer hint */}
      <div className="mt-3 text-xs text-muted-foreground text-center">
        Showing {messages.length} of ~{messagesSwr.data?.data.resultSizeEstimate ?? 0} •{' '}
        <Link href="/inbox" className="underline">
          Manage accounts
        </Link>
      </div>
      <BotChatModal
        open={botOpen}
        onClose={() => setBotOpen(false)}
        accountId={accountId}
        accountEmail={account?.account_email ?? accountId}
      />
    </div>
  );
}

function MessageDetail({
  msg,
  onArchive,
}: {
  msg: MessageFull;
  onArchive: () => void;
}) {
  return (
    <>
      <div className="p-5 border-b space-y-2 shrink-0">
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-lg font-semibold leading-snug">{msg.subject}</h2>
          <Button variant="ghost" size="sm" onClick={onArchive} className="gap-1.5 shrink-0">
            <Archive className="h-4 w-4" />
            Archive
          </Button>
        </div>
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
          <span className="font-medium">{shortFrom(msg.from)}</span>
          <span className="text-xs text-muted-foreground truncate">{msg.from}</span>
        </div>
        <div className="text-xs text-muted-foreground">
          To: {msg.to} • {new Date(Number(msg.internalDate)).toLocaleString()}
        </div>
        {msg.labelIds.length > 0 && (
          <div className="flex flex-wrap gap-1 pt-1">
            {msg.labelIds.slice(0, 8).map((l) => (
              <Badge key={l} variant="secondary" className="text-[10px]">
                {l}
              </Badge>
            ))}
          </div>
        )}
      </div>
      <div className="flex-1 overflow-y-auto min-h-0">
        <div className="p-5">
          {msg.body.html ? (
            <iframe
              sandbox=""
              srcDoc={msg.body.html}
              className="w-full h-[600px] border-0"
              title="message-body"
            />
          ) : msg.body.text ? (
            <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed">{msg.body.text}</pre>
          ) : (
            <p className="text-sm text-muted-foreground">{msg.snippet}</p>
          )}
          {msg.attachments.length > 0 && (
            <div className="mt-6 pt-4 border-t">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                Attachments
              </p>
              <ul className="space-y-1">
                {msg.attachments.map((a) => (
                  <li key={a.id} className="text-sm flex items-center gap-2">
                    <FileText className="h-4 w-4 text-muted-foreground" />
                    <span>{a.filename}</span>
                    <span className="text-xs text-muted-foreground">
                      ({Math.round(a.size / 1024)} KB)
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

const BOT_SUGGESTIONS = [
  'Summarize my latest unread emails',
  'Find potential spam in my inbox',
  'List emails that need a reply',
  'Show emails with attachments',
  'Count unread emails by sender',
];

function BotChatModal({
  open,
  onClose,
  accountId,
  accountEmail,
}: {
  open: boolean;
  onClose: () => void;
  accountId: string;
  accountEmail: string;
}) {
  const [messages, setMessages] = useState<Array<{ role: 'user' | 'assistant'; content: string }>>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const sendMessage = useCallback(
    async (text: string) => {
      if (!text.trim() || loading) return;
      setInput('');
      setLoading(true);
      setMessages((prev) => [...prev, { role: 'user', content: text }]);
      const contextPrompt = `You are an AI assistant for the mawaDao inbox (${accountEmail}, account ${accountId}). Use the mawadao-inbox skill when needed.\n\n${text}`;
      try {
        const res = await fetch('/api/ai-chat', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messages: [{ id: crypto.randomUUID(), role: 'user', parts: [{ type: 'text', text: contextPrompt }] }],
            model: 'openclaw',
          }),
        });
        if (!res.body) throw new Error('No response body');
        setMessages((prev) => [...prev, { role: 'assistant', content: '' }]);
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let accumulated = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const raw = decoder.decode(value, { stream: true });
          for (const line of raw.split('\n')) {
            const trimmed = line.trim();
            if (trimmed.startsWith('0:')) {
              try {
                accumulated += JSON.parse(trimmed.slice(2)) as string;
                setMessages((prev) => {
                  const next = [...prev];
                  next[next.length - 1] = { role: 'assistant', content: accumulated };
                  return next;
                });
              } catch { /* skip malformed line */ }
            }
          }
        }
      } catch (err) {
        console.error('[bot-chat] failed:', err);
        toast.error('Failed to get response. Try again.');
        setMessages((prev) => prev.slice(0, -1));
      } finally {
        setLoading(false);
      }
    },
    [accountId, accountEmail, loading],
  );

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-2xl h-[80vh] flex flex-col p-0 gap-0">
        <DialogHeader className="px-6 py-4 border-b shrink-0">
          <div className="flex items-center gap-3">
            <div className="h-8 w-8 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
              <Bot className="h-5 w-5 text-primary" />
            </div>
            <div>
              <DialogTitle className="text-base leading-none mb-0.5">mawaDao Bot</DialogTitle>
              <DialogDescription className="text-xs">
                AI assistant for {accountEmail}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>
        <div ref={scrollRef} className="flex-1 overflow-y-auto min-h-0 px-6 py-4 space-y-4">
          {messages.length === 0 && (
            <div className="space-y-3 pt-2">
              <p className="text-sm text-muted-foreground">What would you like to do?</p>
              <div className="flex flex-wrap gap-2">
                {BOT_SUGGESTIONS.map((s) => (
                  <Button
                    key={s}
                    variant="outline"
                    size="sm"
                    onClick={() => sendMessage(s)}
                    className="text-xs h-8 rounded-full"
                  >
                    {s}
                  </Button>
                ))}
              </div>
            </div>
          )}
          {messages.map((m, i) => (
            <div key={i} className={`flex gap-2 ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              {m.role === 'assistant' && (
                <div className="h-7 w-7 rounded-full bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
                  <Bot className="h-3.5 w-3.5 text-primary" />
                </div>
              )}
              <div
                className={`max-w-[80%] rounded-2xl px-4 py-2.5 text-sm ${
                  m.role === 'user'
                    ? 'bg-primary text-primary-foreground rounded-br-sm'
                    : 'bg-muted rounded-bl-sm'
                }`}
              >
                {m.role === 'assistant' && !m.content && loading ? (
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                ) : (
                  <pre className="whitespace-pre-wrap font-sans leading-relaxed">{m.content}</pre>
                )}
              </div>
            </div>
          ))}
        </div>
        <div className="px-6 py-4 border-t shrink-0">
          <form
            onSubmit={(e) => { e.preventDefault(); sendMessage(input); }}
            className="flex gap-2"
          >
            <Input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask about your inbox…"
              className="flex-1 h-10 text-sm"
              disabled={loading}
            />
            <Button
              type="submit"
              size="sm"
              disabled={loading || !input.trim()}
              className="h-10 px-4 gap-1.5"
            >
              {loading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Send className="h-4 w-4" />
              )}
            </Button>
          </form>
        </div>
      </DialogContent>
    </Dialog>
  );
}
