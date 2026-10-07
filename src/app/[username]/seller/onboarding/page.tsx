'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from '@/lib/member-path';
import { Card, Button, Skeleton } from '@/components/ui';
import {
  ArrowLeft, ArrowRight, CheckCircle2, Loader2, Sparkles,
  PenTool, Code, Package, Headphones, BarChart3, Palette,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { api } from '@/lib/api';
import type { SellerCategory, CreateSellerProfileForm } from '@/types';

const CATEGORY_ICONS: Record<string, LucideIcon> = {
  design_logo: Palette,
  digital_product: Package,
  software: Code,
  creative_services: PenTool,
  consulting: Headphones,
  marketing: BarChart3,
};

type Step = 'category' | 'profile' | 'review';

export default function SellerOnboardingPage() {
  const router = useRouter();
  const [step, setStep] = useState<Step>('category');
  const [categories, setCategories] = useState<SellerCategory[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [form, setForm] = useState<CreateSellerProfileForm>({
    categoryId: undefined,
    businessName: '',
    brandVoice: '',
    tagline: '',
    targetAudience: '',
    defaultCta: '',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    websiteUrl: '',
  });

  useEffect(() => {
    api.listSellerCategories()
      .then(setCategories)
      .catch((err) => setError(err.message))
      .finally(() => setIsLoading(false));
  }, []);

  const selectedCategory = categories.find((c) => c.id === form.categoryId);

  const handleSave = useCallback(async () => {
    setIsSaving(true);
    setError(null);
    try {
      // Check if profile already exists
      const existing = await api.getSellerProfile();
      if (existing) {
        await api.updateSellerProfile(form);
      } else {
        await api.createSellerProfile(form);
      }
      await api.completeSellerOnboarding();
      router.push('/seller');
    } catch (err: any) {
      setError(err.message || 'Failed to save profile');
    } finally {
      setIsSaving(false);
    }
  }, [form, router]);

  if (isLoading) {
    return (
      <div className="p-6 md:p-8 max-w-3xl mx-auto">
        <Skeleton className="h-8 w-64 mb-2" />
        <Skeleton className="h-4 w-96 mb-8" />
        <div className="grid grid-cols-2 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-32 rounded-lg" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 md:p-8 max-w-3xl mx-auto">
      {/* Header */}
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-1">
          <h1 className="text-2xl font-bold text-foreground">Seller Setup</h1>
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-blue-50/80 dark:bg-blue-950/30 border border-blue-100/60 dark:border-blue-900/40 text-blue-600 dark:text-blue-400 text-[11px] font-semibold">
            <Sparkles className="w-3 h-3" />
            AI-Powered
          </span>
        </div>
        <p className="text-sm text-muted-foreground">
          {step === 'category' && 'Choose your selling category to get started.'}
          {step === 'profile' && 'Tell us about your business so the AI can craft perfect listings.'}
          {step === 'review' && 'Review your setup and launch your seller profile.'}
        </p>
      </div>

      {/* Progress Steps */}
      <div className="flex items-center gap-2 mb-8">
        {(['category', 'profile', 'review'] as Step[]).map((s, i) => (
          <div key={s} className="flex items-center gap-2">
            <div
              className={cn(
                'w-8 h-8 rounded-full flex items-center justify-center text-xs font-semibold transition-colors',
                step === s
                  ? 'bg-primary text-primary-foreground'
                  : (['category', 'profile', 'review'].indexOf(step) > i)
                    ? 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400'
                    : 'bg-muted text-muted-foreground',
              )}
            >
              {(['category', 'profile', 'review'].indexOf(step) > i)
                ? <CheckCircle2 className="h-4 w-4" />
                : i + 1}
            </div>
            {i < 2 && (
              <div className={cn(
                'w-12 h-0.5',
                (['category', 'profile', 'review'].indexOf(step) > i) ? 'bg-emerald-400' : 'bg-border'
              )} />
            )}
          </div>
        ))}
      </div>

      {error && (
        <div className="mb-6 p-3 rounded-xl bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800/50 text-sm text-red-700 dark:text-red-400">
          {error}
        </div>
      )}

      {/* Step: Category Selection */}
      {step === 'category' && (
        <div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-8">
            {categories.map((cat) => {
              const Icon = CATEGORY_ICONS[cat.slug] || Package;
              return (
                <Card
                  key={cat.id}
                  onClick={() => setForm((f) => ({ ...f, categoryId: cat.id }))}
                  className={cn(
                    'p-5 border cursor-pointer transition-all duration-200 hover:shadow-md',
                    form.categoryId === cat.id
                      ? 'ring-2 ring-primary border-primary/50'
                      : 'border-border',
                  )}
                >
                  <Icon className="h-6 w-6 text-primary mb-3" />
                  <h3 className="font-semibold text-foreground text-sm mb-1">{cat.name}</h3>
                  <p className="text-xs text-muted-foreground">{cat.description}</p>
                </Card>
              );
            })}
          </div>
          <div className="flex justify-end">
            <Button
              onClick={() => setStep('profile')}
              disabled={!form.categoryId}
              className="gap-1.5"
            >
              Next <ArrowRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}

      {/* Step: Profile Details */}
      {step === 'profile' && (
        <div>
          <div className="space-y-5 mb-8">
            <div>
              <label className="block text-sm font-medium text-foreground mb-1.5">Business Name</label>
              <input
                type="text"
                value={form.businessName || ''}
                onChange={(e) => setForm((f) => ({ ...f, businessName: e.target.value }))}
                placeholder="e.g. Creative Studio Co."
                className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/10 focus:border-primary/40 transition-all"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-foreground mb-1.5">Tagline</label>
              <input
                type="text"
                value={form.tagline || ''}
                onChange={(e) => setForm((f) => ({ ...f, tagline: e.target.value }))}
                placeholder="e.g. Beautiful designs, fast turnaround"
                className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/10 focus:border-primary/40 transition-all"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-foreground mb-1.5">Brand Voice</label>
              <textarea
                value={form.brandVoice || ''}
                onChange={(e) => setForm((f) => ({ ...f, brandVoice: e.target.value }))}
                rows={3}
                placeholder="Describe your brand's tone and personality. e.g. Professional but friendly, uses emojis sparingly, focuses on value and quality."
                className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/10 focus:border-primary/40 transition-all resize-none"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-foreground mb-1.5">Target Audience</label>
              <input
                type="text"
                value={form.targetAudience || ''}
                onChange={(e) => setForm((f) => ({ ...f, targetAudience: e.target.value }))}
                placeholder="e.g. Small business owners, startups, solo entrepreneurs"
                className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/10 focus:border-primary/40 transition-all"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-foreground mb-1.5">Default Call to Action</label>
              <input
                type="text"
                value={form.defaultCta || ''}
                onChange={(e) => setForm((f) => ({ ...f, defaultCta: e.target.value }))}
                placeholder="e.g. DM me to get started!"
                className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/10 focus:border-primary/40 transition-all"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-foreground mb-1.5">Website URL (optional)</label>
              <input
                type="url"
                value={form.websiteUrl || ''}
                onChange={(e) => setForm((f) => ({ ...f, websiteUrl: e.target.value }))}
                placeholder="https://your-website.com"
                className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/10 focus:border-primary/40 transition-all"
              />
            </div>
          </div>

          <div className="flex justify-between">
            <Button variant="outline" onClick={() => setStep('category')} className="gap-1.5">
              <ArrowLeft className="h-4 w-4" /> Back
            </Button>
            <Button onClick={() => setStep('review')} className="gap-1.5">
              Next <ArrowRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}

      {/* Step: Review */}
      {step === 'review' && (
        <div>
          <Card className="p-6 border border-border mb-8">
            <h3 className="font-semibold text-foreground mb-4">Your Seller Profile</h3>
            <div className="space-y-3 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Category</span>
                <span className="font-medium text-foreground">{selectedCategory?.name || '—'}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Business Name</span>
                <span className="font-medium text-foreground">{form.businessName || '—'}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Tagline</span>
                <span className="font-medium text-foreground">{form.tagline || '—'}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Audience</span>
                <span className="font-medium text-foreground">{form.targetAudience || '—'}</span>
              </div>
              {form.brandVoice && (
                <div>
                  <span className="text-muted-foreground block mb-1">Brand Voice</span>
                  <p className="text-foreground text-xs bg-muted p-3 rounded-lg">{form.brandVoice}</p>
                </div>
              )}
              <div className="flex justify-between">
                <span className="text-muted-foreground">Timezone</span>
                <span className="font-medium text-foreground">{form.timezone}</span>
              </div>
            </div>
          </Card>

          <div className="flex justify-between">
            <Button variant="outline" onClick={() => setStep('profile')} className="gap-1.5">
              <ArrowLeft className="h-4 w-4" /> Back
            </Button>
            <Button onClick={handleSave} disabled={isSaving} className="gap-1.5">
              {isSaving ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Setting up...
                </>
              ) : (
                <>
                  <CheckCircle2 className="h-4 w-4" />
                  Complete Setup
                </>
              )}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
