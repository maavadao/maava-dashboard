import type { ReactNode } from 'react';
import { Button, type ButtonProps } from '@/components/mc/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/mc/ui/dialog';

type ConfirmActionDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: ReactNode;
  onConfirm: () => void;
  isConfirming: boolean;
  errorMessage?: string | null;
  confirmLabel?: string;
  confirmingLabel?: string;
  cancelLabel?: string;
  cancelVariant?: NonNullable<ButtonProps['variant']>;
  ariaLabel?: string;
};

export function ConfirmActionDialog({
  open,
  onOpenChange,
  title,
  description,
  onConfirm,
  isConfirming,
  errorMessage,
  confirmLabel = 'Delete',
  confirmingLabel = 'Deleting…',
  cancelLabel = 'Cancel',
  cancelVariant = 'outline',
  ariaLabel,
}: ConfirmActionDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-label={ariaLabel}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {errorMessage ? (
          <div className="rounded-lg border border-[color:var(--mc-border)] bg-[color:var(--mc-surface-muted)] p-3 text-xs text-[color:var(--mc-text-muted)]">
            {errorMessage}
          </div>
        ) : null}
        <DialogFooter>
          <Button variant={cancelVariant} onClick={() => onOpenChange(false)}>
            {cancelLabel}
          </Button>
          <Button onClick={onConfirm} disabled={isConfirming}>
            {isConfirming ? confirmingLabel : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
