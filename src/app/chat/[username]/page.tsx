'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { useAuth } from '@/hooks';
import { useOpenClawChatStore } from '@/store';
import { ChatPanel } from '@/components/chat';
import { Button, Avatar, AvatarImage, AvatarFallback, Skeleton } from '@/components/ui';
import Link from 'next/link';
import { ROUTES, APP_NAME } from '@/lib/constants';
import { cn, getInitials } from '@/lib/utils';
import { MessageSquare, Star, Users, ArrowLeft, ExternalLink } from 'lucide-react';
import { motion } from 'framer-motion';

interface AgentProfile {
  id: string;
  name: string;
  display_name?: string;
  description?: string;
  karma?: number;
  follower_count?: number;
  status?: string;
  avatarUrl?: string;
}

export default function AgentChatPage() {
  const params = useParams<{ username: string }>();
  const username = params.username;
  const { isAuthenticated, apiKey } = useAuth();
  const { gatewayToken } = useOpenClawChatStore();

  const [agent, setAgent] = useState<AgentProfile | null>(null);
  const [agentLoading, setAgentLoading] = useState(true);

  const canChat = isAuthenticated && (apiKey || gatewayToken);

  // Fetch agent profile from local API
  useEffect(() => {
    if (!username) return;
    setAgentLoading(true);
    fetch(`/api/agents/${encodeURIComponent(username)}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.agent) setAgent(data.agent);
      })
      .catch(() => {})
      .finally(() => setAgentLoading(false));
  }, [username]);

  const displayName = agent?.display_name || agent?.name || username;
  const initials = getInitials(displayName);

  return (
    <div className="flex flex-col h-screen bg-background">
      {/* Top bar — Agent info */}
      <header className="sticky top-0 z-40 bg-background/90 backdrop-blur-xl border-b border-border">
        <div className="max-w-5xl mx-auto flex items-center justify-between h-16 px-4 sm:px-6">
          <div className="flex items-center gap-3">
            <Link
              href={ROUTES.HOME}
              className="flex items-center justify-center h-8 w-8 rounded-lg hover:bg-muted transition-colors"
            >
              <ArrowLeft className="h-4 w-4 text-muted-foreground" />
            </Link>

            {agentLoading ? (
              <div className="flex items-center gap-3">
                <Skeleton className="h-9 w-9 rounded-full" />
                <div className="space-y-1.5">
                  <Skeleton className="h-4 w-28" />
                  <Skeleton className="h-3 w-20" />
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-3">
                <Avatar className="h-9 w-9 ring-2 ring-muted">
                  <AvatarImage src={agent?.avatarUrl} />
                  <AvatarFallback className="bg-gradient-to-br from-blue-500 to-purple-600 text-white text-xs font-semibold">
                    {initials}
                  </AvatarFallback>
                </Avatar>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h1 className="text-sm font-semibold text-foreground truncate">
                      {displayName}
                    </h1>
                    {agent?.status === 'active' && (
                      <div className="h-2 w-2 rounded-full bg-emerald-500 ring-2 ring-emerald-500/20" />
                    )}
                  </div>
                  <p className="text-[11px] text-muted-foreground truncate max-w-[200px] sm:max-w-[300px]">
                    {agent?.description || `Chat with @${username}`}
                  </p>
                </div>
              </div>
            )}
          </div>

          {/* Right side — stats */}
          <div className="flex items-center gap-3">
            {agent && (
              <div className="hidden sm:flex items-center gap-4 text-[11px] text-muted-foreground">
                <span className="flex items-center gap-1">
                  <Star className="h-3 w-3" />
                  {agent.karma?.toLocaleString() ?? 0}
                </span>
                <span className="flex items-center gap-1">
                  <Users className="h-3 w-3" />
                  {agent.follower_count?.toLocaleString() ?? 0}
                </span>
              </div>
            )}
            {agent && (
              <a
                href={`https://mawadao.com/agent/${encodeURIComponent(username)}`}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium text-muted-foreground bg-muted hover:bg-muted/80 rounded-lg transition-colors"
              >
                <ExternalLink className="h-3 w-3" />
                Profile
              </a>
            )}
          </div>
        </div>
      </header>

      {/* Chat area */}
      <div className="flex-1 min-h-0">
        {canChat ? (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.4 }}
            className="h-full flex flex-col max-w-5xl mx-auto"
          >
            <ChatPanel apiKey={apiKey ?? null} agentId={agent?.id} />
          </motion.div>
        ) : (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, ease: [0.32, 0.72, 0, 1] }}
            className="flex items-center justify-center h-full px-4"
          >
            <div className="max-w-md w-full text-center">
              {!agentLoading && (
                <div className="mb-8">
                  <Avatar className="h-20 w-20 mx-auto mb-4 ring-4 ring-background shadow-lg">
                    <AvatarImage src={agent?.avatarUrl} />
                    <AvatarFallback className="bg-gradient-to-br from-blue-500 to-purple-600 text-white text-2xl font-bold">
                      {initials}
                    </AvatarFallback>
                  </Avatar>
                  <h2 className="text-xl font-bold text-foreground mb-1">{displayName}</h2>
                  {agent?.description && (
                    <p className="text-sm text-muted-foreground mb-3 line-clamp-2">{agent.description}</p>
                  )}
                  {agent && (
                    <div className="flex items-center justify-center gap-6 text-sm text-muted-foreground">
                      <span className="flex items-center gap-1.5">
                        <Star className="h-4 w-4 text-amber-500" />
                        {agent.karma?.toLocaleString() ?? 0} karma
                      </span>
                      <span className="flex items-center gap-1.5">
                        <Users className="h-4 w-4 text-blue-500" />
                        {agent.follower_count?.toLocaleString() ?? 0} followers
                      </span>
                    </div>
                  )}
                </div>
              )}

              <div className="bg-card rounded-2xl border border-border shadow-lg p-8">
                <div className="w-14 h-14 mx-auto rounded-2xl bg-primary/10 flex items-center justify-center mb-4">
                  <MessageSquare className="h-7 w-7 text-primary" />
                </div>
                <h3 className="text-lg font-semibold text-foreground mb-2">
                  Sign in to start chatting
                </h3>
                <p className="text-sm text-muted-foreground mb-6">
                  Log in to {APP_NAME} to chat with <strong>{displayName}</strong>. Ask questions, get help, and automate your workflows.
                </p>
                <Link href={ROUTES.LOGIN}>
                  <Button size="lg" className="w-full font-semibold">
                    Sign in
                  </Button>
                </Link>
              </div>
            </div>
          </motion.div>
        )}
      </div>
    </div>
  );
}
