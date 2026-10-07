'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { useRouter } from '@/lib/member-path';
import Link from '@/components/member-link';
import { Card, Button, Skeleton } from '@/components/ui';
import {
  ArrowLeft, Package, Sparkles, Send, Image as ImageIcon, FileText,
  Plus, Loader2, CheckCircle2, AlertCircle, Trash2, Pencil, Star,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { api } from '@/lib/api';
import type {
  Product, ProductVersion, ProductAsset, ListingOutput,
  PublishingTarget,
} from '@/types';
import {
  ProductImageUpload,
  type PendingImage,
} from '@/components/seller/product-image-upload';
import { invalidateProductThumb } from '@/components/seller/product-thumb';

type Tab = 'overview' | 'versions' | 'images' | 'listings' | 'publish';

/** Read a File into a base64 data URL. Mirrors the upload path used by the
 * new-product page so the same backend contract holds. */
function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsDataURL(file);
  });
}

export default function ProductDetailPage() {
  const params = useParams();
  const router = useRouter();
  const productId = params.id as string;

  const [product, setProduct] = useState<Product | null>(null);
  const [versions, setVersions] = useState<ProductVersion[]>([]);
  const [assets, setAssets] = useState<ProductAsset[]>([]);
  const [listings, setListings] = useState<ListingOutput[]>([]);
  const [targets, setTargets] = useState<PublishingTarget[]>([]);
  const [activeTab, setActiveTab] = useState<Tab>('overview');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Publishing state
  const [selectedListing, setSelectedListing] = useState<string | null>(null);
  const [selectedTargets, setSelectedTargets] = useState<string[]>([]);
  const [isPublishing, setIsPublishing] = useState(false);
  const [publishResult, setPublishResult] = useState<string | null>(null);

  // Image-management state — kept distinct from the publishing flow so a
  // half-finished upload never leaves stale UI in the publish step.
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const [imageBusy, setImageBusy] = useState(false);
  const [imageMessage, setImageMessage] = useState<{
    tone: 'success' | 'warning' | 'error';
    text: string;
  } | null>(null);

  const loadProduct = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [prod, vers, asst, list, tgts] = await Promise.all([
        api.getProduct(productId),
        api.listProductVersions(productId),
        api.listProductAssets(productId),
        api.listListingOutputs(productId),
        api.listPublishingTargets(),
      ]);
      setProduct(prod);
      setVersions(vers);
      setAssets(asst);
      setListings(list);
      setTargets(tgts);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load product');
    } finally {
      setIsLoading(false);
    }
  }, [productId]);

  useEffect(() => {
    void loadProduct();
  }, [loadProduct]);

  const handlePublish = useCallback(async () => {
    if (!selectedListing || selectedTargets.length === 0) return;
    setIsPublishing(true);
    setPublishResult(null);
    try {
      const jobs = await api.publishToMultiple({
        productId,
        listingOutputId: selectedListing,
        targetIds: selectedTargets,
      });
      const published = jobs.filter((j) => j.status === 'published' || j.status === 'scheduled');
      const failed = jobs.filter((j) => j.status === 'failed');
      if (failed.length === 0) {
        setPublishResult(`Published to ${published.length} target(s) successfully.`);
      } else if (published.length === 0) {
        setPublishResult(`Publishing failed for all ${failed.length} target(s). Check jobs for details.`);
      } else {
        setPublishResult(`${published.length} published, ${failed.length} failed.`);
      }
      setSelectedListing(null);
      setSelectedTargets([]);
    } catch (err: any) {
      setPublishResult(`Error: ${err.message}`);
    } finally {
      setIsPublishing(false);
    }
  }, [productId, selectedListing, selectedTargets]);

  const currentVersion = versions.find((v) => v.isCurrent);

  /**
   * Sort assets by sortOrder so the first image is always the “primary”.
   * Pre-computed here so each render path doesn’t resort.
   */
  const imageAssets = [...assets]
    .filter((a) => a.mimeType?.startsWith('image/') || a.assetType === 'image')
    .sort((a, b) => a.sortOrder - b.sortOrder);
  const otherAssets = assets.filter(
    (a) => !(a.mimeType?.startsWith('image/') || a.assetType === 'image'),
  );

  const flashImageMessage = (
    tone: 'success' | 'warning' | 'error',
    text: string,
  ) => {
    setImageMessage({ tone, text });
    setTimeout(() => setImageMessage(null), 4000);
  };

  /**
   * Upload all pending images sequentially. Sequential keeps the asset list
   * order deterministic and avoids the case where a parallel race produces
   * an out-of-order “primary” thumbnail.
   */
  const handleUploadPendingImages = async () => {
    if (pendingImages.length === 0) return;
    setImageBusy(true);
    let succeeded = 0;
    let failed = 0;
    try {
      for (const img of pendingImages) {
        try {
          const dataUrl = await readFileAsDataUrl(img.file);
          await api.createProductAsset(productId, {
            assetType: 'image',
            fileUrl: dataUrl,
            fileName: img.file.name,
            fileSize: img.file.size,
            mimeType: img.file.type,
          });
          succeeded++;
        } catch {
          failed++;
        }
      }
      // Clean up object URLs the picker created.
      pendingImages.forEach((p) => URL.revokeObjectURL(p.previewUrl));
      setPendingImages([]);
      invalidateProductThumb(productId);
      await loadProduct();
      if (failed === 0) {
        flashImageMessage(
          'success',
          `Uploaded ${succeeded} image${succeeded === 1 ? '' : 's'}.`,
        );
      } else {
        flashImageMessage(
          'warning',
          `Uploaded ${succeeded} of ${succeeded + failed}. ${failed} failed.`,
        );
      }
    } finally {
      setImageBusy(false);
    }
  };

  const handleDeleteAsset = async (assetId: string) => {
    setImageBusy(true);
    try {
      await api.deleteProductAsset(productId, assetId);
      invalidateProductThumb(productId);
      await loadProduct();
      flashImageMessage('success', 'Image removed.');
    } catch (err) {
      flashImageMessage(
        'error',
        err instanceof Error ? err.message : 'Failed to remove image',
      );
    } finally {
      setImageBusy(false);
    }
  };

  if (isLoading) {
    return (
      <div className="p-6 md:p-8 max-w-5xl">
        <Skeleton className="h-4 w-32 mb-6" />
        <Skeleton className="h-8 w-64 mb-2" />
        <Skeleton className="h-4 w-96 mb-8" />
        <div className="grid grid-cols-4 gap-4 mb-8">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-24 rounded-lg" />
          ))}
        </div>
        <Skeleton className="h-64 rounded-lg" />
      </div>
    );
  }

  if (!product) {
    return (
      <div className="p-6 md:p-8 max-w-5xl text-center">
        <p className="text-muted-foreground">Product not found.</p>
        <Link href="/seller/products">
          <Button variant="outline" className="mt-4">Back to Products</Button>
        </Link>
      </div>
    );
  }

  const tabs: { id: Tab; label: string; count?: number }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'versions', label: 'Versions', count: versions.length },
    { id: 'images', label: 'Images', count: imageAssets.length },
    { id: 'listings', label: 'Listings', count: listings.length },
    { id: 'publish', label: 'Publish' },
  ];

  return (
    <div className="p-6 md:p-8 max-w-5xl">
      {/* Back */}
      <Link
        href="/seller/products"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground mb-6 transition-colors"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to Products
      </Link>

      {error && (
        <div className="mb-6 p-3 rounded-xl bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800/50 flex items-start gap-2 text-sm text-red-700 dark:text-red-400">
          <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
          {error}
        </div>
      )}

      {/* Header */}
      <div className="flex items-start justify-between gap-4 mb-6">
        <div className="min-w-0">
          <div className="flex items-center gap-3 mb-1 flex-wrap">
            <h1 className="text-2xl font-bold text-foreground">{product.name}</h1>
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
          <p className="text-sm text-muted-foreground">
            {product.summary || 'No summary'}
            {product.categoryName && ` · ${product.categoryName}`}
          </p>
        </div>
        <div className="flex items-start gap-3 shrink-0">
          {product.price != null && (
            <div className="text-right">
              <p className="text-2xl font-bold text-foreground leading-none">
                {product.price === 0 ? 'Free' : `$${product.price}`}
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                {product.pricingModel?.replace('_', ' ')}
              </p>
            </div>
          )}
          <Link href={`/seller/products/${productId}/edit`}>
            <Button variant="outline" size="sm" className="gap-1.5">
              <Pencil className="h-3.5 w-3.5" />
              Edit
            </Button>
          </Link>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 p-1 bg-muted rounded-xl mb-6 w-fit">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setActiveTab(tab.id)}
            className={cn(
              'px-4 py-1.5 rounded-lg text-[12px] font-semibold transition-all duration-200 flex items-center gap-1.5',
              activeTab === tab.id
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {tab.label}
            {tab.count != null && tab.count > 0 && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-primary/10 text-primary">
                {tab.count}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Tab: Overview */}
      {activeTab === 'overview' && (
        <div className="space-y-6">
          {product.description && (
            <Card className="p-6 border border-border">
              <h3 className="text-sm font-semibold text-foreground mb-2">Description</h3>
              <p className="text-sm text-muted-foreground whitespace-pre-wrap">{product.description}</p>
            </Card>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {product.deliverables.length > 0 && (
              <Card className="p-5 border border-border">
                <h3 className="text-sm font-semibold text-foreground mb-3">Deliverables</h3>
                <ul className="space-y-1.5">
                  {product.deliverables.map((d, i) => (
                    <li key={i} className="flex items-start gap-2 text-sm text-muted-foreground">
                      <CheckCircle2 className="h-4 w-4 text-emerald-500 mt-0.5 shrink-0" />
                      {d}
                    </li>
                  ))}
                </ul>
              </Card>
            )}

            {currentVersion && (
              <Card className="p-5 border border-border">
                <h3 className="text-sm font-semibold text-foreground mb-3">Current Version (v{currentVersion.versionNum})</h3>
                <p className="text-sm font-medium text-foreground mb-1">{currentVersion.title}</p>
                {currentVersion.description && (
                  <p className="text-xs text-muted-foreground mb-2">{currentVersion.description}</p>
                )}
                {currentVersion.bullets.length > 0 && (
                  <ul className="list-disc list-inside text-xs text-muted-foreground space-y-0.5">
                    {currentVersion.bullets.map((b, i) => (
                      <li key={i}>{b}</li>
                    ))}
                  </ul>
                )}
                {currentVersion.cta && (
                  <p className="mt-2 text-xs font-medium text-primary">{currentVersion.cta}</p>
                )}
              </Card>
            )}
          </div>

          {product.tags.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {product.tags.map((tag) => (
                <span
                  key={tag}
                  className="inline-flex items-center px-2 py-0.5 rounded-full bg-primary/10 text-primary text-[11px] font-medium"
                >
                  {tag}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Tab: Versions */}
      {activeTab === 'versions' && (
        <div>
          {versions.length === 0 ? (
            <Card className="p-8 border border-dashed text-center">
              <FileText className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
              <p className="text-sm font-medium text-foreground mb-1">No versions yet</p>
              <p className="text-xs text-muted-foreground">Use the AI agent to generate listing copy for this product.</p>
            </Card>
          ) : (
            <div className="space-y-3">
              {versions.map((v) => (
                <Card key={v.id} className={cn(
                  'p-4 border transition-all',
                  v.isCurrent ? 'border-primary/50 ring-1 ring-primary/10' : 'border-border',
                )}>
                  <div className="flex items-start justify-between mb-2">
                    <div>
                      <div className="flex items-center gap-2">
                        <h3 className="font-medium text-foreground text-sm">v{v.versionNum}: {v.title}</h3>
                        {v.isCurrent && (
                          <span className="text-[10px] px-2 py-0.5 rounded-full bg-primary/10 text-primary font-medium">Current</span>
                        )}
                      </div>
                      {v.description && <p className="text-xs text-muted-foreground mt-0.5">{v.description}</p>}
                    </div>
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-muted text-muted-foreground font-medium">
                      {v.generatedBy}
                    </span>
                  </div>
                  {v.bullets.length > 0 && (
                    <ul className="list-disc list-inside text-xs text-muted-foreground space-y-0.5 mb-2">
                      {v.bullets.map((b, i) => <li key={i}>{b}</li>)}
                    </ul>
                  )}
                  {v.hashtags.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {v.hashtags.map((h) => (
                        <span key={h} className="text-[10px] text-blue-500">#{h}</span>
                      ))}
                    </div>
                  )}
                </Card>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Tab: Images */}
      {activeTab === 'images' && (
        <div className="space-y-6">
          {imageMessage && (
            <div
              className={cn(
                'p-3 rounded-xl border text-sm flex items-start gap-2',
                imageMessage.tone === 'success' &&
                  'bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-900/40 text-emerald-700 dark:text-emerald-300',
                imageMessage.tone === 'warning' &&
                  'bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-900/40 text-amber-700 dark:text-amber-300',
                imageMessage.tone === 'error' &&
                  'bg-red-50 dark:bg-red-950/30 border-red-200 dark:border-red-900/40 text-red-700 dark:text-red-300',
              )}
            >
              {imageMessage.text}
            </div>
          )}

          {/* Existing image gallery */}
          <Card className="p-6 border border-border">
            <div className="flex items-baseline justify-between mb-4">
              <div>
                <h3 className="text-sm font-semibold text-foreground">Product Images</h3>
                <p className="text-[12px] text-muted-foreground mt-0.5">
                  The first image is shown as the catalog thumbnail.
                </p>
              </div>
              <span className="text-[12px] text-muted-foreground">
                {imageAssets.length} image{imageAssets.length === 1 ? '' : 's'}
              </span>
            </div>

            {imageAssets.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border bg-muted/30 px-6 py-10 text-center">
                <ImageIcon className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
                <p className="text-sm font-medium text-foreground mb-1">No images yet</p>
                <p className="text-xs text-muted-foreground">
                  Upload images below to give this product a thumbnail.
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                {imageAssets.map((asset, idx) => (
                  <div
                    key={asset.id}
                    className="group relative aspect-square overflow-hidden rounded-xl border border-border bg-muted"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={asset.fileUrl}
                      alt={asset.fileName || 'Product image'}
                      loading="lazy"
                      decoding="async"
                      className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-[1.02]"
                    />

                    {idx === 0 && (
                      <span className="absolute left-2 top-2 inline-flex items-center gap-1 rounded-md bg-background/90 px-1.5 py-0.5 text-[10px] font-semibold text-foreground shadow-sm backdrop-blur">
                        <Star className="h-3 w-3 text-amber-500" />
                        Primary
                      </span>
                    )}

                    {asset.isGenerated && (
                      <span className="absolute right-2 top-2 inline-flex items-center gap-1 rounded-md bg-primary/90 px-1.5 py-0.5 text-[10px] font-semibold text-primary-foreground shadow-sm">
                        <Sparkles className="h-3 w-3" />
                        AI
                      </span>
                    )}

                    <button
                      type="button"
                      onClick={() => void handleDeleteAsset(asset.id)}
                      disabled={imageBusy}
                      title="Remove image"
                      className={cn(
                        'absolute right-2 bottom-2 inline-flex items-center justify-center',
                        'h-7 w-7 rounded-md bg-background/90 text-muted-foreground shadow-sm',
                        'opacity-0 transition-opacity duration-200 group-hover:opacity-100',
                        'hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/40',
                        'disabled:opacity-50 disabled:cursor-not-allowed',
                      )}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>

                    {asset.fileName && (
                      <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/60 to-transparent px-2 pt-6 pb-1.5 opacity-0 transition-opacity group-hover:opacity-100">
                        <p className="text-[10px] text-white/90 truncate">{asset.fileName}</p>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </Card>

          {/* Upload new images */}
          <Card className="p-6 border border-border">
            <div className="flex items-baseline justify-between mb-4">
              <h3 className="text-sm font-semibold text-foreground">Add Images</h3>
              <span className="text-[12px] text-muted-foreground">
                PNG / JPG / WebP up to 5 MB
              </span>
            </div>
            <ProductImageUpload
              files={pendingImages}
              onChange={setPendingImages}
              disabled={imageBusy}
            />
            {pendingImages.length > 0 && (
              <div className="mt-4 flex items-center justify-end gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={imageBusy}
                  onClick={() => {
                    pendingImages.forEach((p) => URL.revokeObjectURL(p.previewUrl));
                    setPendingImages([]);
                  }}
                >
                  Clear
                </Button>
                <Button
                  type="button"
                  size="sm"
                  className="gap-1.5"
                  disabled={imageBusy}
                  onClick={() => void handleUploadPendingImages()}
                >
                  {imageBusy ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      Uploading...
                    </>
                  ) : (
                    <>
                      <Plus className="h-3.5 w-3.5" />
                      Upload {pendingImages.length} image
                      {pendingImages.length === 1 ? '' : 's'}
                    </>
                  )}
                </Button>
              </div>
            )}
          </Card>

          {/* Other (non-image) assets, if any */}
          {otherAssets.length > 0 && (
            <Card className="p-6 border border-border">
              <h3 className="text-sm font-semibold text-foreground mb-3">Other Files</h3>
              <div className="space-y-2">
                {otherAssets.map((asset) => (
                  <div
                    key={asset.id}
                    className="flex items-center gap-3 rounded-lg border border-border p-3"
                  >
                    <div className="h-9 w-9 rounded-lg bg-muted flex items-center justify-center shrink-0">
                      <FileText className="h-4 w-4 text-muted-foreground" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-foreground truncate">
                        {asset.fileName || asset.assetType}
                      </p>
                      <p className="text-[11px] text-muted-foreground">
                        {asset.assetType}
                        {asset.isGenerated ? ' · AI generated' : ''}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => void handleDeleteAsset(asset.id)}
                      disabled={imageBusy}
                      className="text-muted-foreground hover:text-red-600 disabled:opacity-50"
                      title="Remove file"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </div>
      )}

      {/* Tab: Listings */}
      {activeTab === 'listings' && (
        <div>
          {listings.length === 0 ? (
            <Card className="p-8 border border-dashed text-center">
              <Sparkles className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
              <p className="text-sm font-medium text-foreground mb-1">No listings generated yet</p>
              <p className="text-xs text-muted-foreground">Ask the AI agent to generate channel-specific listings for this product.</p>
            </Card>
          ) : (
            <div className="space-y-3">
              {listings.map((listing) => (
                <Card key={listing.id} className="p-4 border border-border">
                  <div className="flex items-start justify-between mb-2">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] px-2 py-0.5 rounded-full bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 font-medium">
                          {listing.channel}
                        </span>
                        {listing.title && (
                          <h3 className="font-medium text-foreground text-sm">{listing.title}</h3>
                        )}
                      </div>
                    </div>
                    <span className="text-[10px] text-muted-foreground">
                      {new Date(listing.createdAt).toLocaleDateString()}
                    </span>
                  </div>
                  {listing.body && (
                    <p className="text-sm text-muted-foreground whitespace-pre-wrap mb-2 line-clamp-4">
                      {listing.body}
                    </p>
                  )}
                  {listing.cta && (
                    <p className="text-xs font-medium text-primary mb-1">{listing.cta}</p>
                  )}
                  {listing.hashtags.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {listing.hashtags.map((h) => (
                        <span key={h} className="text-[10px] text-blue-500">#{h}</span>
                      ))}
                    </div>
                  )}
                </Card>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Tab: Publish */}
      {activeTab === 'publish' && (
        <div className="space-y-6">
          {publishResult && (
            <div className={cn(
              'p-3 rounded-xl text-sm flex items-start gap-2',
              publishResult.startsWith('Error')
                ? 'bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800/50 text-red-700 dark:text-red-400'
                : 'bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800/50 text-emerald-700 dark:text-emerald-400',
            )}>
              {publishResult.startsWith('Error')
                ? <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                : <CheckCircle2 className="h-4 w-4 shrink-0 mt-0.5" />}
              {publishResult}
            </div>
          )}

          {/* Step 1: Select Listing */}
          <Card className="p-6 border border-border">
            <h3 className="text-sm font-semibold text-foreground mb-3">1. Select a Listing</h3>
            {listings.length === 0 ? (
              <p className="text-xs text-muted-foreground">No listings available. Generate listings first using the AI agent.</p>
            ) : (
              <div className="space-y-2">
                {listings.map((listing) => (
                  <button
                    key={listing.id}
                    type="button"
                    onClick={() => setSelectedListing(listing.id)}
                    className={cn(
                      'w-full text-left p-3 rounded-lg border transition-all text-sm',
                      selectedListing === listing.id
                        ? 'border-primary ring-2 ring-primary/10'
                        : 'border-border hover:border-primary/40',
                    )}
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] px-2 py-0.5 rounded-full bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 font-medium">
                        {listing.channel}
                      </span>
                      <span className="font-medium text-foreground">{listing.title || 'Untitled'}</span>
                    </div>
                    {listing.body && (
                      <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{listing.body}</p>
                    )}
                  </button>
                ))}
              </div>
            )}
          </Card>

          {/* Step 2: Select Targets */}
          <Card className="p-6 border border-border">
            <h3 className="text-sm font-semibold text-foreground mb-3">2. Select Publishing Targets</h3>
            {targets.length === 0 ? (
              <div>
                <p className="text-xs text-muted-foreground mb-2">No publishing targets configured.</p>
                <Link href="/seller/social-accounts">
                  <Button variant="outline" size="sm" className="text-xs gap-1.5">
                    <Plus className="h-3 w-3" />
                    Connect Social Accounts
                  </Button>
                </Link>
              </div>
            ) : (
              <div className="space-y-2">
                {targets.map((target) => (
                  <label
                    key={target.id}
                    className={cn(
                      'flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-all text-sm',
                      selectedTargets.includes(target.id)
                        ? 'border-primary ring-2 ring-primary/10'
                        : 'border-border hover:border-primary/40',
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={selectedTargets.includes(target.id)}
                      onChange={(e) => {
                        setSelectedTargets((prev) =>
                          e.target.checked
                            ? [...prev, target.id]
                            : prev.filter((id) => id !== target.id),
                        );
                      }}
                      className="rounded border-border"
                    />
                    <div>
                      <span className="font-medium text-foreground">
                        {target.targetLabel || target.targetType}
                      </span>
                      {target.platform && (
                        <span className="text-xs text-muted-foreground ml-2">
                          {target.platform}{target.accountName ? ` · ${target.accountName}` : ''}
                        </span>
                      )}
                    </div>
                  </label>
                ))}
              </div>
            )}
          </Card>

          {/* Publish Button */}
          <div className="flex justify-end">
            <Button
              onClick={handlePublish}
              disabled={!selectedListing || selectedTargets.length === 0 || isPublishing}
              className="gap-1.5"
            >
              {isPublishing ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Publishing...
                </>
              ) : (
                <>
                  <Send className="h-4 w-4" />
                  Publish to {selectedTargets.length} Target{selectedTargets.length !== 1 ? 's' : ''}
                </>
              )}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
