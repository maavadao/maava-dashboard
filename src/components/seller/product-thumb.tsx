/**
 * ProductThumb
 * ------------
 * Lightweight thumbnail for a product, lazily resolved from the product's
 * first image asset. Results are cached in a module-level `Map` keyed by
 * productId so navigating away and back to the catalog is instant and the
 * list view never blocks on an N+1 fetch wave during initial render.
 *
 * Each product fires a single GET to `listProductAssets`; the first asset
 * with `mimeType` starting `image/` (falling back to `assetType === 'image'`)
 * is used. If none, a styled placeholder is rendered. Failures are silently
 * absorbed so a misbehaving asset endpoint never breaks the catalog.
 */
'use client';

import * as React from 'react';
import { Package } from 'lucide-react';
import { cn } from '@/lib/utils';
import { api } from '@/lib/api';

type CacheValue = string | null; // resolved URL or "no image"
const cache = new Map<string, CacheValue>();
const inFlight = new Map<string, Promise<CacheValue>>();

async function resolveThumb(productId: string): Promise<CacheValue> {
  if (cache.has(productId)) return cache.get(productId)!;
  if (inFlight.has(productId)) return inFlight.get(productId)!;

  const p = (async () => {
    try {
      const assets = await api.listProductAssets(productId);
      const sorted = [...assets].sort((a, b) => a.sortOrder - b.sortOrder);
      const img = sorted.find(
        (a) => a.mimeType?.startsWith('image/') || a.assetType === 'image',
      );
      const url = img?.fileUrl ?? null;
      cache.set(productId, url);
      return url;
    } catch {
      cache.set(productId, null);
      return null;
    } finally {
      inFlight.delete(productId);
    }
  })();

  inFlight.set(productId, p);
  return p;
}

/** Bust the cache for a single product — call after asset mutations. */
export function invalidateProductThumb(productId: string) {
  cache.delete(productId);
}

export interface ProductThumbProps {
  productId: string;
  productName?: string;
  /** Tailwind size class; defaults to a 56px square. */
  className?: string;
}

export function ProductThumb({
  productId,
  productName,
  className,
}: ProductThumbProps) {
  const [url, setUrl] = React.useState<CacheValue | undefined>(() =>
    cache.has(productId) ? cache.get(productId)! : undefined,
  );

  React.useEffect(() => {
    let cancelled = false;
    if (cache.has(productId)) {
      setUrl(cache.get(productId)!);
      return;
    }
    setUrl(undefined);
    void resolveThumb(productId).then((v) => {
      if (!cancelled) setUrl(v);
    });
    return () => {
      cancelled = true;
    };
  }, [productId]);

  const base = cn(
    'h-14 w-14 shrink-0 overflow-hidden rounded-xl border border-border bg-muted',
    className,
  );

  // Loading state — subtle pulsing placeholder.
  if (url === undefined) {
    return <div className={cn(base, 'animate-pulse')} aria-hidden />;
  }

  // No image — branded fallback that still fits the row visually.
  if (url === null) {
    return (
      <div
        className={cn(
          base,
          'flex items-center justify-center bg-gradient-to-br from-muted to-muted/50',
        )}
        aria-hidden
      >
        <Package className="h-5 w-5 text-muted-foreground/60" />
      </div>
    );
  }

  return (
    <div className={base}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={url}
        alt={productName ? `${productName} thumbnail` : 'Product thumbnail'}
        loading="lazy"
        decoding="async"
        className="h-full w-full object-cover"
      />
    </div>
  );
}
