'use client';

import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { useParams } from 'next/navigation';
import { useRouter } from '@/lib/member-path';
import { useAuth } from '@/hooks';
import { useAuthStore, useOpenClawChatStore } from '@/store';
import { ChatPanel } from '@/components/chat';
import { Button } from '@/components/ui';
import { ChatSidebar, SidebarLayout } from '@/components/layout/sidebar';
import Link from '@/components/member-link';
import { ROUTES, APP_NAME } from '@/lib/constants';
import { MessageSquare } from 'lucide-react';
import { api } from '@/lib/api';

interface Conversation {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  message_count: number;
  is_streaming?: boolean;
}

function getTimeLabel(dateStr: string | undefined): string {
  if (!dateStr) return 'Today';
  const d = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  return `${diffDays}d ago`;
}

export default function ChatSessionPage() {
  const params = useParams();
  const router = useRouter();
  const conversationId = params.id as string;

  const { isAuthenticated, apiKey, user, agent } = useAuth();
  const { gatewayToken } = useOpenClawChatStore();
  const [exchangingToken, setExchangingToken] = useState(false);
  const exchangeAttempted = useRef(false);
  const canChat = isAuthenticated && (apiKey || gatewayToken) && !exchangingToken;
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const userId = user?.id || agent?.id || 'anonymous';

  // --- Transfer token exchange ---
  useEffect(() => {
    if (exchangeAttempted.current) return;
    const urlParams = new URLSearchParams(window.location.search);
    const authToken = urlParams.get('auth_token');
    if (!authToken) return;
    exchangeAttempted.current = true;
    setExchangingToken(true);

    (async () => {
      try {
        const res = await fetch('/api/auth/token-exchange', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: authToken }),
        });
        if (res.ok) {
          const data = await res.json();
          if (data.token) {
            api.setApiKey(data.token);
            useAuthStore.setState({
              apiKey: data.token,
              token: data.token,
              user: {
                id: data.user.userId,
                email: data.user.email,
                username: data.user.email?.split('@')[0] || '',
                displayName: '',
                avatarUrl: '',
                isActive: true,
                isVerified: true,
                createdAt: new Date().toISOString(),
              },
            });
          }
        }
      } catch {
        // ignore
      }
      const cleanUrl = new URL(window.location.href);
      cleanUrl.searchParams.delete('auth_token');
      cleanUrl.searchParams.delete('state');
      window.history.replaceState({}, '', cleanUrl.toString());
      setExchangingToken(false);
    })();
  }, []);

  // --- Session bootstrap ---
  const sessionBootstrapped = useRef(false);
  useEffect(() => {
    if (sessionBootstrapped.current) return;
    if (isAuthenticated || exchangingToken) return;
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('auth_token')) return;
    sessionBootstrapped.current = true;

    (async () => {
      try {
        const res = await fetch('/api/auth/me-session', { credentials: 'include' });
        if (res.ok) {
          const data = await res.json();
          if (data.authenticated && data.token) {
            api.setApiKey(data.token);
            useAuthStore.setState({
              apiKey: data.token,
              token: data.token,
              user: {
                id: data.user.userId,
                email: data.user.email,
                username: data.user.email?.split('@')[0] || '',
                displayName: '',
                avatarUrl: '',
                isActive: true,
                isVerified: true,
                createdAt: new Date().toISOString(),
              },
            });
          }
        }
      } catch {
        // ignore
      }
    })();
  }, [isAuthenticated, exchangingToken]);

  const loadConversations = useCallback(async () => {
    try {
      const res = await fetch('/api/conversations', {
        headers: { 'x-user-id': userId },
      });
      const data = await res.json();
      if (data.conversations) {
        setConversations(data.conversations);
      }
    } catch {
      // ignore
    }
  }, [userId]);

  useEffect(() => {
    if (canChat) {
      loadConversations();
    }
  }, [canChat, loadConversations]);

  const threads = useMemo(() => {
    return conversations.map((c) => ({
      id: c.id,
      title: c.title || 'New Chat',
      time: getTimeLabel(c.updated_at),
      pinned: false,
      is_streaming: c.is_streaming ?? false,
    }));
  }, [conversations]);

  // Auto-poll sidebar when any conversation is streaming (faster refresh)
  const anyStreaming = conversations.some(c => c.is_streaming);
  useEffect(() => {
    if (!canChat) return;
    const interval = setInterval(loadConversations, anyStreaming ? 4_000 : 30_000);
    return () => clearInterval(interval);
  }, [canChat, anyStreaming, loadConversations]);

  const handleNewChat = useCallback(() => {
    router.push('/');
  }, [router]);

  const handleSelectThread = useCallback((id: string) => {
    router.push(`/c/${id}`);
  }, [router]);

  const handleDeleteThread = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/conversations/${id}`, {
        method: 'DELETE',
        headers: { 'x-user-id': userId },
      });
      if (res.ok) {
        if (conversationId === id) {
          router.push('/');
        }
        loadConversations();
      }
    } catch {
      // ignore
    }
  }, [conversationId, loadConversations, userId, router]);

  const handleConversationCreated = useCallback((id: string) => {
    // Update URL without full navigation to avoid killing the active chat stream
    window.history.replaceState({}, '', `/c/${id}`);
    loadConversations();
    setTimeout(() => loadConversations(), 5000);
    setTimeout(() => loadConversations(), 12000);
  }, [loadConversations]);

  const handleRenameThread = useCallback(async (id: string, newTitle: string) => {
    try {
      const res = await fetch(`/api/conversations/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
        body: JSON.stringify({ title: newTitle }),
      });
      if (res.ok) {
        loadConversations();
      }
    } catch {
      // ignore
    }
  }, [userId, loadConversations]);

  if (!canChat) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen text-center px-4">
        <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center mb-4">
          <MessageSquare className="h-8 w-8 text-primary" />
        </div>
        <h1 className="text-xl font-bold mb-2">Sign in to chat</h1>
        <p className="text-muted-foreground mb-6 max-w-sm">
          Log in to chat with AI agents on {APP_NAME}. Ask questions, get help, and automate your workflows.
        </p>
        <Link href={ROUTES.LOGIN}>
          <Button size="lg">Sign in</Button>
        </Link>
      </div>
    );
  }

  return (
    <SidebarLayout
      sidebar={
        <ChatSidebar
          threads={threads}
          activeThreadId={conversationId}
          onNewChat={handleNewChat}
          onSelectThread={handleSelectThread}
          onDeleteThread={handleDeleteThread}
          onRenameThread={handleRenameThread}
        />
      }
      className="overflow-hidden h-screen"
    >
      <div className="h-full flex flex-col overflow-hidden">
        <ChatPanel
          apiKey={apiKey ?? null}
          conversationId={conversationId}
          key={conversationId}
          onConversationCreated={handleConversationCreated}
        />
      </div>
    </SidebarLayout>
  );
}
