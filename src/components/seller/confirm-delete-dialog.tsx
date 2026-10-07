/**
 * ConfirmDeleteDialog
 * -------------------
 * Generic destructive-action confirmation dialog. Used by the products page
 * for both single and bulk delete. The confirmation pattern follows
 * GitHub-style "type the resource name to confirm" only when
 * `requireTypedConfirmation` is provided — for low-risk single deletes a
 * plain confirm button is sufficient.
 */
'use client';

import * as React from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  Button,
  Input,
} from '@/components/ui';

export interface ConfirmDeleteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Heading shown at the top of the dialog. */
  title: string;
  /** Body copy explaining what will be deleted and the consequences. */
  description: React.ReactNode;
  /** When provided, user must type this exact string to enable Delete. */
  requireTypedConfirmation?: string;
  /** Label on the destructive button (default "Delete"). */
  confirmLabel?: string;
  /** Called when the user confirms. Should be async — dialog shows spinner. */
  onConfirm: () => Promise<void> | void;
}

export function ConfirmDeleteDialog({
  open,
  onOpenChange,
  title,
  description,
  requireTypedConfirmation,
  confirmLabel = 'Delete',
  onConfirm,
}: ConfirmDeleteDialogProps) {
  const [busy, setBusy] = React.useState(false);
  const [typed, setTyped] = React.useState('');

  // Reset typed input every time the dialog opens. Without this, reopening
  // after a previous cancel would show the stale value.
  React.useEffect(() => {
    if (open) setTyped('');
  }, [open]);

  const canConfirm = requireTypedConfirmation
    ? typed.trim() === requireTypedConfirmation
    : true;

  const handleConfirm = async () => {
    if (busy || !canConfirm) return;
    setBusy(true);
    try {
      await onConfirm();
      onOpenChange(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <div className="flex items-start gap-3">
            <div className="h-10 w-10 rounded-xl bg-red-50 dark:bg-red-950/40 flex items-center justify-center shrink-0 border border-red-100 dark:border-red-900/40">
              <AlertTriangle className="h-5 w-5 text-red-600" />
            </div>
            <div className="flex-1 min-w-0">
              <DialogTitle className="text-base">{title}</DialogTitle>
              <DialogDescription className="mt-1.5 text-sm leading-relaxed">
                {description}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {requireTypedConfirmation && (
          <div className="mt-2">
            <label
              htmlFor="confirm-type"
              className="text-[12px] font-medium text-muted-foreground"
            >
              Type{' '}
              <code className="px-1 py-0.5 rounded bg-muted text-foreground text-[11px] font-mono">
                {requireTypedConfirmation}
              </code>{' '}
              to confirm
            </label>
            <Input
              id="confirm-type"
              autoComplete="off"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              className="mt-1.5"
              disabled={busy}
            />
          </div>
        )}

        <DialogFooter className="mt-4 gap-2">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() => void handleConfirm()}
            disabled={busy || !canConfirm}
          >
            {busy && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
