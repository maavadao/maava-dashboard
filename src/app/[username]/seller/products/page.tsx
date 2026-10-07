'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import Link from '@/components/member-link';
import { Card, Button, Skeleton } from '@/components/ui';
import { Package, Plus, Search, X, ArrowUpRight, AlertCircle, Download } from 'lucide-react';
import { cn } from '@/lib/utils';
import { api } from '@/lib/api';
import type { Product, ProductStatus } from '@/types';
import { ImportMarketModal } from '@/components/import-market-modal';
import { ProductBulkActions } from '@/components/seller/product-bulk-actions';
import { ConfirmDeleteDialog } from '@/components/seller/confirm-delete-dialog';
import { ProductThumb, invalidateProductThumb } from '@/components/seller/product-thumb';
import { downloadCsv, rowsToCsv } from '@/lib/csv';

const STATUS_FILTERS: { value: ProductStatus | 'all'; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'draft', label: 'Draft' },
  { value: 'active', label: 'Active' },
  { value: 'paused', label: 'Paused' },
  { value: 'archived', label: 'Archived' },
];

export default function ProductsPage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<ProductStatus | 'all'>('all');
  const [page, setPage] = useState(1);
  const [pagination, setPagination] = useState<any>(null);
  const [importModalOpen, setImportModalOpen] = useState(false);

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [statusBanner, setStatusBanner] = useState<{
    tone: 'success' | 'warning' | 'error';
    text: string;
  } | null>(null);

  const loadProducts = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const params: { status?: string; page?: number; limit?: number } = { page, limit: 20 };
      if (statusFilter !== 'all') params.status = statusFilter;
      const result = await api.listProducts(params);
      setProducts(result.data);
      setPagination(result.pagination);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load products');
    } finally {
      setIsLoading(false);
    }
  }, [statusFilter, page]);

  useEffect(() => {
    void loadProducts();
  }, [loadProducts]);

  useEffect(() => {
    setSelectedIds(new Set());
  }, [statusFilter, page]);

  const filteredProducts = useMemo(() => {
    if (!search) return products;
    const term = search.toLowerCase();
    return products.filter(
      (p) =>
        p.name.toLowerCase().includes(term) ||
        p.summary?.toLowerCase().includes(term) ||
        p.tags.some((t) => t.toLowerCase().includes(term)),
    );
  }, [products, search]);

  const allFilteredSelected =
    filteredProducts.length > 0 &&
    filteredProducts.every((p) => selectedIds.has(p.id));

  const toggleAll = () => {
    if (allFilteredSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filteredProducts.map((p) => p.id)));
    }
  };

  const toggleOne = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const flashBanner = (
    tone: 'success' | 'warning' | 'error',
    text: string,
  ) => {
    setStatusBanner({ tone, text });
    setTimeout(() => setStatusBanner(null), 4000);
  };

  const runBulkStatus = async (
    status: 'draft' | 'active' | 'paused' | 'archived',
    label: string,
  ) => {
    if (selectedIds.size === 0) return;
    setBulkBusy(true);
    try {
      const ids = Array.from(selectedIds);
      const { succeeded, failed } = await api.bulkUpdateProductStatus(ids, status);
      if (failed.length === 0) {
        flashBanner('success', `${label} ${succeeded} product${succeeded === 1 ? '' : 's'}.`);
      } else {
        flashBanner('warning', `${label} ${succeeded} of ${ids.length}. ${failed.length} failed.`);
      }
      setSelectedIds(new Set());
      await loadProducts();
    } catch (err) {
      flashBanner('error', err instanceof Error ? err.message : 'Bulk update failed');
    } finally {
      setBulkBusy(false);
    }
  };

  const handleBulkDelete = async () => {
    if (selectedIds.size === 0) return;
    setBulkBusy(true);
    try {
      const ids = Array.from(selectedIds);
      // Drop cached thumbnails for deleted products so a future create with a
      // recycled id doesn't render a stale image.
      ids.forEach(invalidateProductThumb);
      const { succeeded, failed } = await api.bulkDeleteProducts(ids);
      if (failed.length === 0) {
        flashBanner('success', `Deleted ${succeeded} product${succeeded === 1 ? '' : 's'}.`);
      } else {
        flashBanner('warning', `Deleted ${succeeded} of ${ids.length}. ${failed.length} failed.`);
      }
      setSelectedIds(new Set());
      await loadProducts();
    } catch (err) {
      flashBanner('error', err instanceof Error ? err.message : 'Bulk delete failed');
    } finally {
      setBulkBusy(false);
    }
  };

  const handleExportCsv = () => {
    const selected = filteredProducts.filter((p) => selectedIds.has(p.id));
    if (selected.length === 0) return;
    const rows = selected.map((p) => ({
      id: p.id,
      name: p.name,
      summary: p.summary ?? '',
      status: p.status,
      product_type: p.productType ?? '',
      pricing_model: p.pricingModel ?? '',
      price: p.price ?? '',
      currency: p.currency,
      tags: p.tags.join('; '),
      deliverables: p.deliverables.join('; '),
      created_at: p.createdAt ?? '',
      updated_at: p.updatedAt ?? '',
    }));
    const stamp = new Date().toISOString().slice(0, 10);
    downloadCsv(`products-${stamp}.csv`, rowsToCsv(rows));
    flashBanner('success', `Exported ${rows.length} product${rows.length === 1 ? '' : 's'} to CSV.`);
  };

  return (
    <div className="p-6 md:p-8 max-w-5xl">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Products</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Manage your product catalog and listings
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" className="gap-1.5 text-xs sm:text-sm" onClick={() => setImportModalOpen(true)}>
            <Download className="h-4 w-4" />
            <span className="hidden sm:inline">Import from my market</span>
            <span className="sm:hidden">Import</span>
          </Button>
          <Link href="/seller/products/new">
            <Button className="gap-1.5">
              <Plus className="h-4 w-4" />
              New Product
            </Button>
          </Link>
        </div>
      </div>

      {error && (
        <div className="mb-6 p-3 rounded-xl bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800/50 flex items-start gap-2 text-sm text-red-700 dark:text-red-400">
          <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
          {error}
        </div>
      )}

      {statusBanner && (
        <div
          className={cn(
            'mb-4 p-3 rounded-xl border text-sm flex items-start gap-2',
            statusBanner.tone === 'success' &&
              'bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-900/40 text-emerald-700 dark:text-emerald-300',
            statusBanner.tone === 'warning' &&
              'bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-900/40 text-amber-700 dark:text-amber-300',
            statusBanner.tone === 'error' &&
              'bg-red-50 dark:bg-red-950/30 border-red-200 dark:border-red-900/40 text-red-700 dark:text-red-300',
          )}
        >
          {statusBanner.text}
        </div>
      )}

      <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4 mb-6">
        <div className="flex items-center gap-1 p-1 bg-muted rounded-xl">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              onClick={() => { setStatusFilter(f.value); setPage(1); }}
              className={cn(
                'px-4 py-1.5 rounded-lg text-[12px] font-semibold transition-all duration-200',
                statusFilter === f.value
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {f.label}
            </button>
          ))}
        </div>

        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search products..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-10 pr-10 py-2 rounded-xl border border-border bg-background/80 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/10 focus:border-primary/40 transition-all"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch('')}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>

        {filteredProducts.length > 0 && !isLoading && (
          <button
            type="button"
            onClick={toggleAll}
            className="text-[12px] text-muted-foreground hover:text-foreground transition-colors sm:ml-auto"
          >
            {allFilteredSelected ? 'Deselect all' : 'Select all'}
          </button>
        )}
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-20 rounded-lg" />
          ))}
        </div>
      ) : filteredProducts.length === 0 ? (
        <Card className="p-8 border border-dashed text-center">
          <Package className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
          <p className="text-sm font-medium text-foreground mb-1">
            {search ? 'No matching products' : 'No products yet'}
          </p>
          <p className="text-xs text-muted-foreground mb-4">
            {search ? 'Try a different search term.' : 'Create your first product to start selling.'}
          </p>
          {!search && (
            <Link href="/seller/products/new">
              <Button size="sm" className="gap-1.5">
                <Plus className="h-3.5 w-3.5" />
                Create Product
              </Button>
            </Link>
          )}
        </Card>
      ) : (
        <div className="space-y-3">
          {filteredProducts.map((product) => {
            const checked = selectedIds.has(product.id);
            return (
              <Card
                key={product.id}
                className={cn(
                  'p-4 border transition-all duration-200',
                  checked ? 'border-primary/40 bg-primary/5 shadow-sm' : 'border-border hover:shadow-md',
                )}
              >
                <div className="flex items-center gap-3">
                  <label
                    className="flex items-center justify-center shrink-0 cursor-pointer"
                    aria-label={`Select ${product.name}`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleOne(product.id)}
                      className="h-4 w-4 rounded border-border text-primary focus:ring-2 focus:ring-primary/30 cursor-pointer"
                    />
                  </label>

                  <Link
                    href={`/seller/products/${product.id}`}
                    className="flex-1 min-w-0 flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3 group"
                  >
                    <ProductThumb productId={product.id} productName={product.name} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <h3 className="font-medium text-foreground text-sm truncate group-hover:text-primary transition-colors">
                          {product.name}
                        </h3>
                        {product.categoryName && (
                          <span className="text-[10px] px-2 py-0.5 rounded-full bg-muted text-muted-foreground font-medium">
                            {product.categoryName}
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5 truncate">
                        {product.summary || 'No description'}
                      </p>
                      {product.tags.length > 0 && (
                        <div className="flex gap-1 mt-1.5 flex-wrap">
                          {product.tags.slice(0, 3).map((tag) => (
                            <span key={tag} className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                              {tag}
                            </span>
                          ))}
                          {product.tags.length > 3 && (
                            <span className="text-[10px] text-muted-foreground">+{product.tags.length - 3}</span>
                          )}
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-3 sm:ml-4">
                      {product.price != null && (
                        <span className="text-sm font-semibold text-foreground whitespace-nowrap">
                          {product.price === 0 ? 'Free' : `$${product.price}`}
                        </span>
                      )}
                      <span
                        className={cn(
                          'inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium whitespace-nowrap',
                          product.status === 'active'
                            ? 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400'
                            : product.status === 'draft'
                              ? 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400'
                              : product.status === 'paused'
                                ? 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400'
                                : 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400',
                        )}
                      >
                        {product.status}
                      </span>
                      <ArrowUpRight className="h-4 w-4 text-muted-foreground group-hover:text-primary transition-colors" />
                    </div>
                  </Link>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {pagination && pagination.totalPages > 1 && (
        <div className="flex items-center justify-center gap-2 mt-6">
          <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            Previous
          </Button>
          <span className="text-sm text-muted-foreground">
            Page {page} of {pagination.totalPages}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= pagination.totalPages}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </Button>
        </div>
      )}

      <ProductBulkActions
        selectedCount={selectedIds.size}
        busy={bulkBusy}
        onClear={() => setSelectedIds(new Set())}
        onPublish={() => void runBulkStatus('active', 'Published')}
        onPause={() => void runBulkStatus('paused', 'Paused')}
        onMoveToDraft={() => void runBulkStatus('draft', 'Moved to draft')}
        onArchive={() => void runBulkStatus('archived', 'Archived')}
        onDelete={() => setDeleteOpen(true)}
        onExportCsv={handleExportCsv}
      />

      <ConfirmDeleteDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={`Delete ${selectedIds.size} product${selectedIds.size === 1 ? '' : 's'}?`}
        description={
          <>
            This will permanently remove the selected product
            {selectedIds.size === 1 ? '' : 's'} along with their assets and version history. This action cannot be
            undone.
          </>
        }
        requireTypedConfirmation={selectedIds.size >= 5 ? 'DELETE' : undefined}
        confirmLabel={`Delete ${selectedIds.size} product${selectedIds.size === 1 ? '' : 's'}`}
        onConfirm={handleBulkDelete}
      />

      <ImportMarketModal
        open={importModalOpen}
        onOpenChange={setImportModalOpen}
        onImportComplete={() => void loadProducts()}
      />
    </div>
  );
}
