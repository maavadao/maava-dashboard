'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Card, Button, Skeleton } from '@/components/ui';
import {
  Package, ShoppingBag, Send, CheckCircle2, CalendarClock, Share2,
  Plus, ArrowUpRight, TrendingUp, Clock, AlertCircle, Loader2,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAuthStore } from '@/store';
import { api } from '@/lib/api';
import type { SellerProfile, SellerCategory, Product } from '@/types';

export default function SellerDashboardPage() {
  const router = useRouter();
  const user = useAuthStore((s) => s.user);
  const [profile, setProfile] = useState<SellerProfile | null>(null);
  const [categories, setCategories] = useState<SellerCategory[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [profileData, categoriesData] = await Promise.all([
        api.getSellerProfile(),
        api.listSellerCategories(),
      ]);
      setProfile(profileData);
      setCategories(categoriesData);

      if (profileData) {
        const productsData = await api.listProducts({ limit: 5 });
        setProducts(productsData.data);
      }
    } catch (err) {
      console.error('Failed to load seller data', err);
      setError(err instanceof Error ? err.message : 'Failed to load seller data');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  // If no profile, redirect to onboarding
  useEffect(() => {
    if (!isLoading && !profile) {
      router.push('/seller/onboarding');
    }
  }, [isLoading, profile, router]);

  if (isLoading) {
    return (
      <div className="p-6 md:p-8 max-w-5xl">
        <Skeleton className="h-8 w-48 mb-2" />
        <Skeleton className="h-4 w-72 mb-8" />
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-28 rounded-lg" />
          ))}
        </div>
        <Skeleton className="h-64 rounded-lg" />
      </div>
    );
  }

  if (!profile) return null;

  const activeProducts = products.filter((p) => p.status === 'active').length;
  const draftProducts = products.filter((p) => p.status === 'draft').length;
  const category = categories.find((c) => c.id === profile.categoryId);

  return (
    <div className="p-6 md:p-8 max-w-5xl">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8">
        <div>
          <h1 className="text-2xl font-bold text-foreground">
            {profile.businessName || 'Seller Dashboard'}
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">
            {category ? category.name : 'Manage your products and publishing'}
            {profile.tagline && ` · ${profile.tagline}`}
          </p>
        </div>
        <Link href="/seller/products/new" className="shrink-0">
          <Button className="gap-1.5 w-full sm:w-auto">
            <Plus className="h-4 w-4" />
            New Product
          </Button>
        </Link>
      </div>

      {error && (
        <div className="mb-6 p-3 rounded-xl bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800/50 flex items-start gap-2 text-sm text-red-700 dark:text-red-400">
          <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
          {error}
        </div>
      )}

      {/* Not onboarded yet warning */}
      {!profile.onboardingCompleted && (
        <div className="mb-6 p-4 rounded-xl bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800/50 flex items-start gap-3">
          <Clock className="h-5 w-5 text-amber-600 dark:text-amber-400 mt-0.5" />
          <div>
            <p className="text-sm font-medium text-amber-800 dark:text-amber-300">Complete your setup</p>
            <p className="text-xs text-amber-700 dark:text-amber-400 mt-0.5">
              Finish configuring your seller profile to start publishing.
            </p>
            <Link href="/seller/onboarding">
              <Button variant="outline" size="sm" className="mt-2 text-xs h-7">
                Complete Setup
              </Button>
            </Link>
          </div>
        </div>
      )}

      {/* Stats Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <Card className="p-5 border border-border shadow-sm bg-card">
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm text-muted-foreground">Products</span>
            <Package className="h-4 w-4 text-primary" />
          </div>
          <p className="text-3xl font-bold text-foreground">{products.length}</p>
          <p className="text-xs text-muted-foreground mt-1">
            {activeProducts} active · {draftProducts} draft
          </p>
        </Card>

        <Card className="p-5 border border-border shadow-sm bg-card">
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm text-muted-foreground">Published</span>
            <Send className="h-4 w-4 text-emerald-500" />
          </div>
          <p className="text-3xl font-bold text-foreground">—</p>
          <p className="text-xs text-muted-foreground mt-1">Listings published this month</p>
        </Card>

        <Card className="p-5 border border-border shadow-sm bg-card">
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm text-muted-foreground">Pending</span>
            <CheckCircle2 className="h-4 w-4 text-amber-500" />
          </div>
          <p className="text-3xl font-bold text-foreground">—</p>
          <p className="text-xs text-muted-foreground mt-1">Approvals awaiting review</p>
        </Card>

        <Card className="p-5 border border-border shadow-sm bg-card">
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm text-muted-foreground">Campaigns</span>
            <CalendarClock className="h-4 w-4 text-blue-500" />
          </div>
          <p className="text-3xl font-bold text-foreground">—</p>
          <p className="text-xs text-muted-foreground mt-1">Active promotion rules</p>
        </Card>
      </div>

      {/* Recent Products */}
      <div className="mb-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold text-foreground">Recent Products</h2>
          <Link href="/seller/products" className="text-xs text-primary hover:underline flex items-center gap-1">
            View all <ArrowUpRight className="h-3 w-3" />
          </Link>
        </div>

        {products.length === 0 ? (
          <Card className="p-8 border border-dashed text-center">
            <Package className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
            <p className="text-sm font-medium text-foreground mb-1">No products yet</p>
            <p className="text-xs text-muted-foreground mb-4">
              Create your first product and let the AI generate optimized listings.
            </p>
            <Link href="/seller/products/new">
              <Button size="sm" className="gap-1.5">
                <Plus className="h-3.5 w-3.5" />
                Create Product
              </Button>
            </Link>
          </Card>
        ) : (
          <div className="space-y-3">
            {products.map((product) => (
              <Link key={product.id} href={`/seller/products/${product.id}`}>
                <Card className="p-4 border border-border hover:shadow-md transition-all duration-200 cursor-pointer">
                  <div className="flex items-center justify-between">
                    <div className="flex-1 min-w-0">
                      <h3 className="font-medium text-foreground text-sm truncate">{product.name}</h3>
                      <p className="text-xs text-muted-foreground mt-0.5 truncate">
                        {product.summary || 'No description'}
                      </p>
                    </div>
                    <div className="flex items-center gap-3 ml-4">
                      {product.price != null && (
                        <span className="text-sm font-semibold text-foreground">
                          {product.price === 0 ? 'Free' : `$${product.price}`}
                        </span>
                      )}
                      <span
                        className={cn(
                          'inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium',
                          product.status === 'active'
                            ? 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400'
                            : product.status === 'draft'
                              ? 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400'
                              : 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400',
                        )}
                      >
                        {product.status}
                      </span>
                    </div>
                  </div>
                </Card>
              </Link>
            ))}
          </div>
        )}
      </div>

      {/* Quick Actions */}
      <div>
        <h2 className="text-base font-semibold text-foreground mb-4">Quick Actions</h2>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <Link href="/seller/social-accounts">
            <Card className="p-4 border border-border hover:shadow-md transition-all duration-200 cursor-pointer">
              <Share2 className="h-5 w-5 text-blue-500 mb-2" />
              <h3 className="text-sm font-medium text-foreground">Connect Social</h3>
              <p className="text-xs text-muted-foreground mt-0.5">Link your social media accounts</p>
            </Card>
          </Link>
          <Link href="/seller/publishing">
            <Card className="p-4 border border-border hover:shadow-md transition-all duration-200 cursor-pointer">
              <Send className="h-5 w-5 text-emerald-500 mb-2" />
              <h3 className="text-sm font-medium text-foreground">Publish Listings</h3>
              <p className="text-xs text-muted-foreground mt-0.5">Schedule or publish to channels</p>
            </Card>
          </Link>
          <Link href="/seller/campaigns">
            <Card className="p-4 border border-border hover:shadow-md transition-all duration-200 cursor-pointer">
              <CalendarClock className="h-5 w-5 text-purple-500 mb-2" />
              <h3 className="text-sm font-medium text-foreground">Recurring Promos</h3>
              <p className="text-xs text-muted-foreground mt-0.5">Set up automated promotions</p>
            </Card>
          </Link>
        </div>
      </div>
    </div>
  );
}
