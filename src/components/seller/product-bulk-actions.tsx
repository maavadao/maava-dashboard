/**
 * ProductBulkActions
 * ------------------
 * Sticky action bar shown while one or more products are selected on the
 * list page. Mirrors enterprise-app patterns (Linear, Notion, Airtable):
 * persistent count, primary lifecycle actions, destructive action separated
 * by a divider and styled with a danger tint.
 *
 * The component is purely presentational — all mutations are dispatched
 * through callbacks so the list page stays the single source of truth.
 */
'use client';

import * as React from 'react';
import {
  CheckCircle2, PauseCircle, Archive, Trash2, X, Download, FileEdit,
} from 'lucide-react';
import { Button } from '@/components/ui';
import { cn } from '@/lib/utils';

export interface ProductBulkActionsProps {
  selectedCount: number;
  /** Disabled while a mutation is in flight — prevents double-clicks. */
  busy?: boolean;
  onClear: () => void;
  onPublish: () => void;
  onPause: () => void;
  onArchive: () => void;
  onMoveToDraft: () => void;
  onDelete: () => void;
  onExportCsv: () => void;
}

export function ProductBulkActions(props: ProductBulkActionsProps) {
  const { selectedCount, busy } = props;
  if (selectedCount === 0) return null;

  return (
    <div
      className={cn(
        'sticky bottom-4 z-30 mx-auto mb-2 w-fit max-w-[calc(100%-2rem)]',
        'flex items-center gap-1 rounded-2xl border border-border bg-background/95',
        'px-2.5 py-1.5 shadow-elevated backdrop-blur',
      )}
      role="toolbar"
      aria-label={`Bulk actions for ${selectedCount} product${selectedCount === 1 ? '' : 's'}`}
    >
      <span className="px-2.5 py-1 text-[12px] font-semibold tabular-nums text-foreground">
        {selectedCount} selected
      </span>
      <span className="h-5 w-px bg-border" aria-hidden="true" />

      <BulkButton onClick={props.onPublish} disabled={busy} icon={CheckCircle2}>
        Publish
      </BulkButton>
      <BulkButton onClick={props.onPause} disabled={busy} icon={PauseCircle}>
        Pause
      </BulkButton>
      <BulkButton onClick={props.onMoveToDraft} disabled={busy} icon={FileEdit}>
        Move to draft
      </BulkButton>
      <BulkButton onClick={props.onArchive} disabled={busy} icon={Archive}>
        Archive
      </BulkButton>

      <span className="h-5 w-px bg-border" aria-hidden="true" />

      <BulkButton onClick={props.onExportCsv} disabled={busy} icon={Download}>
        Export CSV
      </BulkButton>

      <span className="h-5 w-px bg-border" aria-hidden="true" />

      <BulkButton
        onClick={props.onDelete}
        disabled={busy}
        icon={Trash2}
        variant="danger"
      >
        Delete
      </BulkButton>

      <span className="h-5 w-px bg-border" aria-hidden="true" />

      <Button
        variant="ghost"
        size="sm"
        onClick={props.onClear}
        className="h-8 px-2 text-muted-foreground hover:text-foreground"
        aria-label="Clear selection"
      >
        <X className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

function BulkButton({
  onClick,
  disabled,
  icon: Icon,
  children,
  variant = 'default',
}: {
  onClick: () => void;
  disabled?: boolean;
  icon: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
  variant?: 'default' | 'danger';
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[12px] font-medium',
        'transition-colors disabled:opacity-50 disabled:cursor-not-allowed',
        variant === 'danger'
          ? 'text-red-600 hover:bg-red-50 dark:hover:bg-red-950/40'
          : 'text-foreground hover:bg-muted',
      )}
    >
      <Icon className="h-3.5 w-3.5" />
      {children}
    </button>
  );
}
