'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Card, Button } from '@/components/ui';
import {
  ArrowLeft, Loader2, Package, Plus, X, Sparkles,
} from 'lucide-react';
import Link from 'next/link';
import { cn } from '@/lib/utils';
import { api } from '@/lib/api';
import type { SellerCategory, CreateProductForm, PricingModel, ProductType } from '@/types';
import {
  ProductImageUpload,
  type PendingImage,
} from '@/components/seller/product-image-upload';

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

/**
 * Read a File into a base64 data URL. Used as a stand-in for a real upload
 * pipeline so newly-created products can carry their thumbnails through to
 * the catalog without an extra service. Replace with a signed-URL POST when
 * the bucket integration lands.
 */
function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsDataURL(file);
  });
}

export default function NewProductPage() {
  const router = useRouter();
  const [categories, setCategories] = useState<SellerCategory[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tagInput, setTagInput] = useState('');
  const [deliverableInput, setDeliverableInput] = useState('');
  // Selected images held locally until the product row is created. After a
  // successful create() we POST each one as a product asset and surface a
  // soft warning if any uploads failed (the product is still created).
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const [imageUploadWarning, setImageUploadWarning] = useState<string | null>(null);

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

  useEffect(() => {
    api.listSellerCategories().then(setCategories).catch(() => {});
  }, []);

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

  const handleSubmit = useCallback(async () => {
    if (!form.name.trim()) {
      setError('Product name is required');
      return;
    }
    setIsSaving(true);
    setError(null);
    setImageUploadWarning(null);
    try {
      const product = await api.createProduct(form);

      // Upload images sequentially. We send the data URL as `fileUrl`
      // because there is no separate upload endpoint on the seller surface
      // yet — the backend stores the data URL directly. If a real bucket
      // is wired up later, swap this for an upload step that returns a
      // signed URL and pass that here instead.
      let imageFailures = 0;
      for (const img of pendingImages) {
        try {
          const dataUrl = await readFileAsDataUrl(img.file);
          await api.createProductAsset(product.id, {
            assetType: 'image',
            fileUrl: dataUrl,
            fileName: img.file.name,
            fileSize: img.file.size,
            mimeType: img.file.type,
          });
        } catch {
          imageFailures++;
        }
      }

      if (imageFailures > 0) {
        // Warn but still navigate — the product itself was created.
        setImageUploadWarning(
          `${imageFailures} image${imageFailures === 1 ? '' : 's'} failed to upload. You can retry from the product page.`,
        );
      }

      router.push(`/seller/products/${product.id}`);
    } catch (err: any) {
      setError(err.message || 'Failed to create product');
    } finally {
      setIsSaving(false);
    }
  }, [form, pendingImages, router]);

  return (
    <div className="p-6 md:p-8 max-w-3xl">
      {/* Header */}
      <Link
        href="/seller/products"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground mb-6 transition-colors"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to Products
      </Link>

      <div className="flex items-center gap-3 mb-8">
        <h1 className="text-2xl font-bold text-foreground">New Product</h1>
        <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-blue-50/80 dark:bg-blue-950/30 border border-blue-100/60 dark:border-blue-900/40 text-blue-600 dark:text-blue-400 text-[11px] font-semibold">
          <Sparkles className="w-3 h-3" />
          AI will generate listings
        </span>
      </div>

      {error && (
        <div className="mb-6 p-3 rounded-xl bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800/50 text-sm text-red-700 dark:text-red-400">
          {error}
        </div>
      )}

      {imageUploadWarning && (
        <div className="mb-6 p-3 rounded-xl bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900/40 text-sm text-amber-700 dark:text-amber-300">
          {imageUploadWarning}
        </div>
      )}

      <div className="space-y-6">
        {/* Product Type */}
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

        {/* Basic Info */}
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
                placeholder="e.g. Premium Logo Design Package"
                className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/10 focus:border-primary/40 transition-all"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-foreground mb-1.5">Summary</label>
              <input
                type="text"
                value={form.summary || ''}
                onChange={(e) => setForm((f) => ({ ...f, summary: e.target.value }))}
                placeholder="Short one-liner describing your product"
                className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/10 focus:border-primary/40 transition-all"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-foreground mb-1.5">Description</label>
              <textarea
                value={form.description || ''}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                rows={4}
                placeholder="Detailed description. The AI will use this to generate tailored listings for each channel."
                className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/10 focus:border-primary/40 transition-all resize-none"
              />
            </div>

            {categories.length > 0 && (
              <div>
                <label className="block text-sm font-medium text-foreground mb-1.5">Category</label>
                <select
                  value={form.categoryId || ''}
                  onChange={(e) => setForm((f) => ({ ...f, categoryId: e.target.value || undefined }))}
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

        {/* Images — uploaded after the product row is created */}
        <Card className="p-6 border border-border">
          <div className="flex items-baseline justify-between mb-4">
            <h2 className="text-base font-semibold text-foreground">Images</h2>
            <span className="text-[11px] text-muted-foreground">
              First image is used as the primary thumbnail
            </span>
          </div>
          <ProductImageUpload
            files={pendingImages}
            onChange={setPendingImages}
            disabled={isSaving}
          />
        </Card>

        {/* Pricing */}
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
                    placeholder="0.00"
                    className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/10 focus:border-primary/40 transition-all"
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

        {/* Deliverables */}
        <Card className="p-6 border border-border">
          <h2 className="text-base font-semibold text-foreground mb-4">Deliverables</h2>
          <div className="flex gap-2 mb-3">
            <input
              type="text"
              value={deliverableInput}
              onChange={(e) => setDeliverableInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addDeliverable())}
              placeholder="e.g. 3 logo concepts in SVG + PNG"
              className="flex-1 px-3 py-2 rounded-lg border border-border bg-background text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/10 focus:border-primary/40 transition-all"
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

        {/* Tags & Audience */}
        <Card className="p-6 border border-border">
          <h2 className="text-base font-semibold text-foreground mb-4">Additional Details</h2>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-foreground mb-1.5">Target Audience</label>
              <input
                type="text"
                value={form.targetAudience || ''}
                onChange={(e) => setForm((f) => ({ ...f, targetAudience: e.target.value }))}
                placeholder="e.g. SaaS founders, e-commerce brands"
                className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/10 focus:border-primary/40 transition-all"
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
                  className="flex-1 px-3 py-2 rounded-lg border border-border bg-background text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/10 focus:border-primary/40 transition-all"
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

        {/* Actions */}
        <div className="flex justify-end gap-3 pt-2">
          <Link href="/seller/products">
            <Button variant="outline">Cancel</Button>
          </Link>
          <Button onClick={handleSubmit} disabled={isSaving} className="gap-1.5">
            {isSaving ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Creating...
              </>
            ) : (
              <>
                <Package className="h-4 w-4" />
                Create Product
              </>
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
