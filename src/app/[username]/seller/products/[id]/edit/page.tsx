/**
 * Edit Product Page
 * -----------------
 * Mirrors the new-product form but pre-populated from the existing product
 * row. Uses `api.updateProduct` for partial updates and `api.deleteProduct`
 * for hard removal. Image management lives on the detail page (Images tab)
 * so this form stays focused on textual / pricing fields.
 */
'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { useRouter } from '@/lib/member-path';
import Link from '@/components/member-link';
import { Card, Button } from '@/components/ui';
import {
  ArrowLeft, Loader2, Plus, X, AlertCircle, Trash2, Save,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { api } from '@/lib/api';
import type {
  Product, SellerCategory, CreateProductForm, PricingModel, ProductType,
} from '@/types';
import { ConfirmDeleteDialog } from '@/components/seller/confirm-delete-dialog';
import { invalidateProductThumb } from '@/components/seller/product-thumb';

const PRODUCT_TYPES: { value: ProductType; label: string; desc: string }[] = [
  { value: 'physical', label: 'Physical Product', desc: 'Shipped to buyer' },
  { value: 'digital', label: 'Digital Product', desc: 'Instant delivery' },
  { value: 'service', label: 'Service', desc: 'Work you perform' },
  { value: 'hybrid', label: 'Hybrid', desc: 'Digital + physical' },
];

const PRICING_MODELS: { value: PricingModel; label: string; desc: string }[] = [
  { value: 'one_time', label: 'One-Time', desc: 'Single payment' },
  { value: 'subscription', label: 'Subscription', desc: 'Recurring billing' },
  { value: 'custom', label: 'Custom Quote', desc: 'Price on request' },
  { value: 'free', label: 'Free', desc: 'No charge' },
  { value: 'contact', label: 'Contact', desc: 'Discuss first' },
];

export default function EditProductPage() {
  const router = useRouter();
  const params = useParams();
  const productId = params.id as string;

  const [product, setProduct] = useState<Product | null>(null);
  const [categories, setCategories] = useState<SellerCategory[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tagInput, setTagInput] = useState('');
  const [deliverableInput, setDeliverableInput] = useState('');
  const [deleteOpen, setDeleteOpen] = useState(false);

  const [form, setForm] = useState<CreateProductForm>({
    name: '',
    summary: '',
    description: '',
    price: '',
    pricingModel: 'one_time',
    currency: 'USD',
    deliverables: [],
    targetAudience: '',
    tags: [],
    productType: 'physical',
  });

  // Hydrate the form from the server. Catalog metadata is fetched in parallel.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setIsLoading(true);
      setError(null);
      try {
        const [p, cats] = await Promise.all([
          api.getProduct(productId),
          api.listSellerCategories().catch(() => [] as SellerCategory[]),
        ]);
        if (cancelled) return;
        setProduct(p);
        setCategories(cats);
        setForm({
          name: p.name,
          summary: p.summary ?? '',
          description: p.description ?? '',
          // Form keeps `price` as a string so the input stays controlled.
          price: p.price != null ? String(p.price) : '',
          pricingModel: p.pricingModel ?? 'one_time',
          currency: p.currency || 'USD',
          deliverables: [...(p.deliverables ?? [])],
          targetAudience: p.targetAudience ?? '',
          tags: [...(p.tags ?? [])],
          productType: p.productType ?? 'physical',
          categoryId: p.categoryId,
        });
      } catch (err: any) {
        if (!cancelled) setError(err?.message ?? 'Failed to load product');
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [productId]);

  const addTag = useCallback(() => {
    const tag = tagInput.trim().toLowerCase();
    if (tag && !form.tags?.includes(tag)) {
      setForm((f) => ({ ...f, tags: [...(f.tags || []), tag] }));
    }
    setTagInput('');
  }, [tagInput, form.tags]);

  const removeTag = useCallback((tag: string) => {
    setForm((f) => ({ ...f, tags: (f.tags || []).filter((t) => t !== tag) }));
  }, []);

  const addDeliverable = useCallback(() => {
    const item = deliverableInput.trim();
    if (item && !form.deliverables?.includes(item)) {
      setForm((f) => ({ ...f, deliverables: [...(f.deliverables || []), item] }));
    }
    setDeliverableInput('');
  }, [deliverableInput, form.deliverables]);

  const removeDeliverable = useCallback((item: string) => {
    setForm((f) => ({ ...f, deliverables: (f.deliverables || []).filter((d) => d !== item) }));
  }, []);

  const handleSave = useCallback(async () => {
    if (!form.name.trim()) {
      setError('Product name is required');
      return;
    }
    setIsSaving(true);
    setError(null);
    try {
      await api.updateProduct(productId, form);
      router.push(`/seller/products/${productId}`);
    } catch (err: any) {
      setError(err?.message ?? 'Failed to save changes');
    } finally {
      setIsSaving(false);
    }
  }, [form, productId, router]);

  const handleDelete = useCallback(async () => {
    setIsDeleting(true);
    try {
      await api.deleteProduct(productId);
      invalidateProductThumb(productId);
      router.push('/seller/products');
    } catch (err: any) {
      setError(err?.message ?? 'Failed to delete product');
      setIsDeleting(false);
    }
  }, [productId, router]);

  if (isLoading) {
    return (
      <div className="p-6 md:p-8 max-w-3xl">
        <div className="h-4 w-32 bg-muted rounded mb-6 animate-pulse" />
        <div className="h-8 w-64 bg-muted rounded mb-2 animate-pulse" />
        <div className="space-y-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-40 bg-muted rounded-xl animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  if (!product) {
    return (
      <div className="p-6 md:p-8 max-w-3xl text-center">
        <p className="text-muted-foreground">Product not found.</p>
        <Link href="/seller/products">
          <Button variant="outline" className="mt-4">Back to Products</Button>
        </Link>
      </div>
    );
  }

  return (
    <div className="p-6 md:p-8 max-w-3xl">
      <Link
        href={`/seller/products/${productId}`}
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground mb-6 transition-colors"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to Product
      </Link>

      <div className="flex items-start justify-between gap-3 mb-8">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Edit Product</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Update details for <span className="font-medium text-foreground">{product.name}</span>
          </p>
        </div>
      </div>

      {error && (
        <div className="mb-6 p-3 rounded-xl bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800/50 flex items-start gap-2 text-sm text-red-700 dark:text-red-400">
          <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
          {error}
        </div>
      )}

      <div className="space-y-6">
        <Card className="p-6 border border-border">
          <h2 className="text-base font-semibold text-foreground mb-4">Product Type</h2>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {PRODUCT_TYPES.map((pt) => (
              <button
                key={pt.value}
                type="button"
                onClick={() => setForm((f) => ({ ...f, productType: pt.value }))}
                className={cn(
                  'p-3 rounded-lg border text-left transition-all text-xs',
                  form.productType === pt.value
                    ? 'border-primary ring-2 ring-primary/10'
                    : 'border-border hover:border-primary/40',
                )}
              >
                <p className="font-semibold text-foreground">{pt.label}</p>
                <p className="text-muted-foreground mt-0.5">{pt.desc}</p>
              </button>
            ))}
          </div>
        </Card>

        <Card className="p-6 border border-border">
          <h2 className="text-base font-semibold text-foreground mb-4">Basic Information</h2>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-foreground mb-1.5">
                Product Name <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/10 focus:border-primary/40 transition-all"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-foreground mb-1.5">Summary</label>
              <input
                type="text"
                value={form.summary || ''}
                onChange={(e) => setForm((f) => ({ ...f, summary: e.target.value }))}
                className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/10 focus:border-primary/40 transition-all"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-foreground mb-1.5">Description</label>
              <textarea
                value={form.description || ''}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                rows={4}
                className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/10 focus:border-primary/40 transition-all resize-none"
              />
            </div>

            {categories.length > 0 && (
              <div>
                <label className="block text-sm font-medium text-foreground mb-1.5">Category</label>
                <select
                  value={form.categoryId || ''}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, categoryId: e.target.value || undefined }))
                  }
                  className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/10 focus:border-primary/40 transition-all"
                >
                  <option value="">Select a category</option>
                  {categories.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </div>
            )}
          </div>
        </Card>

        <Card className="p-6 border border-border">
          <h2 className="text-base font-semibold text-foreground mb-4">Pricing</h2>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-foreground mb-1.5">Pricing Model</label>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {PRICING_MODELS.map((pm) => (
                  <button
                    key={pm.value}
                    type="button"
                    onClick={() => setForm((f) => ({ ...f, pricingModel: pm.value }))}
                    className={cn(
                      'p-3 rounded-lg border text-left transition-all text-xs',
                      form.pricingModel === pm.value
                        ? 'border-primary ring-2 ring-primary/10'
                        : 'border-border hover:border-primary/40',
                    )}
                  >
                    <p className="font-semibold text-foreground">{pm.label}</p>
                    <p className="text-muted-foreground mt-0.5">{pm.desc}</p>
                  </button>
                ))}
              </div>
            </div>

            {form.pricingModel !== 'free' && form.pricingModel !== 'contact' && (
              <div className="flex gap-3">
                <div className="flex-1">
                  <label className="block text-sm font-medium text-foreground mb-1.5">Price</label>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={form.price || ''}
                    onChange={(e) => setForm((f) => ({ ...f, price: e.target.value }))}
                    className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/10 focus:border-primary/40 transition-all"
                  />
                </div>
                <div className="w-24">
                  <label className="block text-sm font-medium text-foreground mb-1.5">Currency</label>
                  <select
                    value={form.currency || 'USD'}
                    onChange={(e) => setForm((f) => ({ ...f, currency: e.target.value }))}
                    className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/10 focus:border-primary/40 transition-all"
                  >
                    <option value="USD">USD</option>
                    <option value="EUR">EUR</option>
                    <option value="GBP">GBP</option>
                  </select>
                </div>
              </div>
            )}
          </div>
        </Card>

        <Card className="p-6 border border-border">
          <h2 className="text-base font-semibold text-foreground mb-4">Deliverables</h2>
          <div className="flex gap-2 mb-3">
            <input
              type="text"
              value={deliverableInput}
              onChange={(e) => setDeliverableInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addDeliverable())}
              placeholder="e.g. 3 logo concepts in SVG + PNG"
              className="flex-1 px-3 py-2 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/10 focus:border-primary/40 transition-all"
            />
            <Button type="button" variant="outline" size="sm" onClick={addDeliverable}>
              <Plus className="h-4 w-4" />
            </Button>
          </div>
          {(form.deliverables || []).length > 0 && (
            <div className="space-y-1.5">
              {form.deliverables!.map((d, i) => (
                <div key={i} className="flex items-center gap-2 px-3 py-1.5 bg-muted rounded-lg text-sm">
                  <span className="flex-1 text-foreground">{d}</span>
                  <button type="button" onClick={() => removeDeliverable(d)} className="text-muted-foreground hover:text-foreground">
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card className="p-6 border border-border">
          <h2 className="text-base font-semibold text-foreground mb-4">Additional Details</h2>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-foreground mb-1.5">Target Audience</label>
              <input
                type="text"
                value={form.targetAudience || ''}
                onChange={(e) => setForm((f) => ({ ...f, targetAudience: e.target.value }))}
                className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/10 focus:border-primary/40 transition-all"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-foreground mb-1.5">Tags</label>
              <div className="flex gap-2 mb-2">
                <input
                  type="text"
                  value={tagInput}
                  onChange={(e) => setTagInput(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addTag())}
                  placeholder="Add a tag and press Enter"
                  className="flex-1 px-3 py-2 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/10 focus:border-primary/40 transition-all"
                />
                <Button type="button" variant="outline" size="sm" onClick={addTag}>
                  <Plus className="h-4 w-4" />
                </Button>
              </div>
              {(form.tags || []).length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {form.tags!.map((tag) => (
                    <span
                      key={tag}
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-primary/10 text-primary text-[11px] font-medium"
                    >
                      {tag}
                      <button type="button" onClick={() => removeTag(tag)} className="hover:text-red-500">
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        </Card>

        <Card className="p-5 border border-red-200/60 dark:border-red-900/40 bg-red-50/40 dark:bg-red-950/10">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-foreground">Danger zone</h3>
              <p className="text-xs text-muted-foreground mt-0.5">
                Deleting this product also removes its versions, assets, and listings.
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-1.5 border-red-300/60 text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30"
              disabled={isDeleting || isSaving}
              onClick={() => setDeleteOpen(true)}
            >
              <Trash2 className="h-3.5 w-3.5" />
              Delete product
            </Button>
          </div>
        </Card>
      </div>

      {/* Sticky save bar so the action stays in view on long forms */}
      <div className="sticky bottom-4 mt-6 flex items-center justify-end gap-2 rounded-xl border border-border bg-background/85 px-3 py-2 shadow-sm backdrop-blur">
        <Link href={`/seller/products/${productId}`}>
          <Button type="button" variant="outline" size="sm" disabled={isSaving}>
            Cancel
          </Button>
        </Link>
        <Button
          type="button"
          size="sm"
          className="gap-1.5"
          onClick={() => void handleSave()}
          disabled={isSaving}
        >
          {isSaving ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Saving...
            </>
          ) : (
            <>
              <Save className="h-3.5 w-3.5" />
              Save changes
            </>
          )}
        </Button>
      </div>

      <ConfirmDeleteDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={`Delete "${product.name}"?`}
        description={
          <>
            This will permanently remove the product along with its versions, assets, and listings.
            This action cannot be undone.
          </>
        }
        requireTypedConfirmation="DELETE"
        confirmLabel="Delete product"
        onConfirm={handleDelete}
      />
    </div>
  );
}
