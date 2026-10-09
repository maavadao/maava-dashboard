'use client';

import { useState, useCallback, Suspense } from 'react';
import Link from '@/components/member-link';
import { Card, Button, Input } from '@/components/ui';
import {
  ArrowLeft, CheckCircle2, Loader2, AlertCircle, ExternalLink,
  Zap, MessageSquare, Shield, Sparkles, Phone, Send,
} from 'lucide-react';
import { SiWhatsapp } from 'react-icons/si';
import { cn } from '@/lib/utils';
import { SettingsSidebar, SidebarLayout } from '@/components/layout/sidebar';
import { useAuth, usePlatformLinks } from '@/hooks';
import { api } from '@/lib/api';

function WhatsAppLinkPageContent() {
  const { isAuthenticated } = useAuth();
  const { data: links, mutate: refreshLinks } = usePlatformLinks();
  const [phoneNumber, setPhoneNumber] = useState('');
  const [linking, setLinking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const existingLink = links?.find(l => l.platform === 'whatsapp' && l.isActive);

  const handleLink = useCallback(async () => {
    if (!phoneNumber.trim()) {
      setError('Please enter your phone number');
      return;
    }

    // Basic phone validation
    const cleaned = phoneNumber.replace(/[^\d+]/g, '');
    if (cleaned.length < 7) {
      setError('Please enter a valid phone number (include country code, e.g. +1234567890)');
      return;
    }

    setLinking(true);
    setError(null);
    try {
      await api.linkWhatsApp(cleaned);
      setSuccess(true);
      refreshLinks();
    } catch (err) {
      setError((err as Error).message || 'Failed to link WhatsApp');
    } finally {
      setLinking(false);
    }
  }, [phoneNumber, refreshLinks]);

  const handleUnlink = useCallback(async () => {
    setLinking(true);
    setError(null);
    try {
      await api.unlinkPlatform('whatsapp');
      setSuccess(false);
      refreshLinks();
    } catch (err) {
      setError((err as Error).message || 'Failed to unlink');
    } finally {
      setLinking(false);
    }
  }, [refreshLinks]);

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
          <div className="w-10 h-10 rounded-xl bg-[#25D366] flex items-center justify-center">
            <SiWhatsapp className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-foreground">WhatsApp</h1>
            <p className="text-sm text-muted-foreground">Link your WhatsApp number</p>
          </div>
        </div>

        {error && (
          <div className="mb-6 p-3 rounded-xl bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800/50 flex items-start gap-2 text-sm text-red-700 dark:text-red-400">
            <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
            {error}
          </div>
        )}

        {(success || existingLink) ? (
          <Card className="p-6 border border-emerald-200 dark:border-emerald-800/50 bg-emerald-50/50 dark:bg-emerald-950/20">
            <div className="flex items-start gap-4">
              <div className="w-12 h-12 rounded-xl bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center">
                <CheckCircle2 className="h-6 w-6 text-emerald-600" />
              </div>
              <div className="flex-1">
                <h2 className="text-lg font-semibold text-foreground">WhatsApp Linked</h2>
                <p className="text-sm text-muted-foreground mt-1">
                  Your WhatsApp number is connected. Send a message to the maavaDao number and your AI agent will respond.
                </p>
                {existingLink?.platformMeta && (
                  <div className="mt-3 text-sm text-muted-foreground space-y-1">
                    {(existingLink.platformMeta as Record<string, string>).phoneNumber && (
                      <p>Phone: <span className="font-medium text-foreground">{(existingLink.platformMeta as Record<string, string>).phoneNumber}</span></p>
                    )}
                    <p>Linked: <span className="font-medium text-foreground">{new Date(existingLink.linkedAt).toLocaleDateString()}</span></p>
                  </div>
                )}
                <div className="mt-4 flex gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-xs text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950/30"
                    onClick={handleUnlink}
                    disabled={linking}
                  >
                    {linking ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
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
                  { icon: <Phone className="h-4 w-4" />, title: 'Enter your phone number', desc: 'Include your country code (e.g. +994 for Azerbaijan, +1 for US)' },
                  { icon: <Send className="h-4 w-4" />, title: 'Send a message to maavaDao', desc: 'Message our WhatsApp number and your AI agent will reply' },
                  { icon: <Shield className="h-4 w-4" />, title: 'Secure & private', desc: 'We only store your phone number for routing — messages are not stored' },
                ].map((step, i) => (
                  <div key={i} className="flex items-start gap-3">
                    <div className="w-8 h-8 rounded-lg bg-[#25D366]/10 flex items-center justify-center text-[#25D366] shrink-0">
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

            {/* Phone Input */}
            <Card className="p-6 border border-border">
              <h2 className="text-base font-semibold text-foreground mb-4">Link your WhatsApp number</h2>
              <div className="space-y-4">
                <div>
                  <label className="text-sm font-medium text-foreground mb-1.5 block">Phone Number</label>
                  <Input
                    type="tel"
                    placeholder="+994501234567"
                    value={phoneNumber}
                    onChange={(e) => setPhoneNumber(e.target.value)}
                    className="h-11"
                  />
                  <p className="text-xs text-muted-foreground mt-1.5">
                    Enter the phone number registered with your WhatsApp account, including country code.
                  </p>
                </div>
                <Button
                  className="bg-[#25D366] hover:bg-[#1DA851] text-white gap-2 w-full h-11"
                  onClick={handleLink}
                  disabled={linking || !phoneNumber.trim()}
                >
                  {linking ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <SiWhatsapp className="h-4 w-4" />
                  )}
                  Link WhatsApp Number
                </Button>
              </div>
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
            <li>Send messages from WhatsApp to your AI agent</li>
            <li>Get real-time AI replies on WhatsApp</li>
            <li>Works with any WhatsApp client (phone, desktop, web)</li>
            <li>Unlink anytime from this page</li>
          </ul>
        </Card>
      </div>
    </SidebarLayout>
  );
}

export default function WhatsAppLinkPage() {
  return (
    <Suspense>
      <WhatsAppLinkPageContent />
    </Suspense>
  );
}
