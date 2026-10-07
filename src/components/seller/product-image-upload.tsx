/**
 * ProductImageUpload
 * ------------------
 * Drag-and-drop multi-image picker with thumbnail previews. The component
 * is fully controlled — the parent owns the `files` array and handles the
 * eventual upload. This separation keeps the upload concern (signed URLs,
 * direct-to-bucket POSTs, etc.) out of the UI layer where it would be hard
 * to test.
 *
 * Validation:
 *   • only `image/*` MIME types
 *   • per-file size cap (default 5 MB)
 *   • optional max-count
 * Validation errors are shown inline beneath the drop zone.
 */
'use client';

import * as React from 'react';
import { Upload, X, ImagePlus, AlertCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface PendingImage {
  id: string;
  file: File;
  /** Object URL for inline preview. Revoked when the entry is removed. */
  previewUrl: string;
}

export interface ProductImageUploadProps {
  files: PendingImage[];
  onChange: (files: PendingImage[]) => void;
  /** Hard cap on number of images. Default 8. */
  maxCount?: number;
  /** Per-file size cap in bytes. Default 5 MiB. */
  maxBytesPerFile?: number;
  disabled?: boolean;
}

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

function makeId() {
  return `img_${Math.random().toString(36).slice(2, 10)}`;
}

export function ProductImageUpload({
  files,
  onChange,
  maxCount = 8,
  maxBytesPerFile = DEFAULT_MAX_BYTES,
  disabled,
}: ProductImageUploadProps) {
  const [dragOver, setDragOver] = React.useState(false);
  const [errors, setErrors] = React.useState<string[]>([]);
  const inputRef = React.useRef<HTMLInputElement>(null);

  // Revoke object URLs on unmount to avoid leaking blob references.
  React.useEffect(() => {
    return () => {
      files.forEach((f) => URL.revokeObjectURL(f.previewUrl));
    };
    // We deliberately only run cleanup at unmount — the per-file revoke on
    // remove is handled in `handleRemove` below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleFiles = (incoming: FileList | File[]) => {
    const next: PendingImage[] = [...files];
    const errs: string[] = [];

    for (const file of Array.from(incoming)) {
      if (next.length >= maxCount) {
        errs.push(`Maximum ${maxCount} images reached.`);
        break;
      }
      if (!file.type.startsWith('image/')) {
        errs.push(`"${file.name}" is not an image.`);
        continue;
      }
      if (file.size > maxBytesPerFile) {
        const limit = (maxBytesPerFile / (1024 * 1024)).toFixed(1);
        errs.push(`"${file.name}" exceeds the ${limit} MB limit.`);
        continue;
      }
      next.push({
        id: makeId(),
        file,
        previewUrl: URL.createObjectURL(file),
      });
    }

    setErrors(errs);
    onChange(next);
  };

  const handleRemove = (id: string) => {
    const target = files.find((f) => f.id === id);
    if (target) URL.revokeObjectURL(target.previewUrl);
    onChange(files.filter((f) => f.id !== id));
  };

  return (
    <div className="space-y-3">
      <div
        onDragEnter={(e) => {
          e.preventDefault();
          if (!disabled) setDragOver(true);
        }}
        onDragOver={(e) => {
          e.preventDefault();
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          if (disabled) return;
          if (e.dataTransfer.files?.length) handleFiles(e.dataTransfer.files);
        }}
        onClick={() => !disabled && inputRef.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if ((e.key === 'Enter' || e.key === ' ') && !disabled) {
            e.preventDefault();
            inputRef.current?.click();
          }
        }}
        aria-disabled={disabled}
        className={cn(
          'flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed',
          'px-6 py-8 text-center transition-colors cursor-pointer',
          dragOver
            ? 'border-primary bg-primary/5'
            : 'border-border hover:border-primary/50 hover:bg-muted/30',
          disabled && 'opacity-50 cursor-not-allowed',
        )}
      >
        <div className="h-10 w-10 rounded-xl bg-muted flex items-center justify-center">
          <Upload className="h-5 w-5 text-muted-foreground" />
        </div>
        <div>
          <p className="text-sm font-medium text-foreground">
            Drag and drop images here
          </p>
          <p className="text-[12px] text-muted-foreground mt-0.5">
            or click to browse · PNG / JPG / WebP up to{' '}
            {(maxBytesPerFile / (1024 * 1024)).toFixed(0)} MB ·{' '}
            {files.length}/{maxCount} used
          </p>
        </div>
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files?.length) handleFiles(e.target.files);
            // Reset so picking the same file again retriggers `onChange`.
            e.target.value = '';
          }}
        />
      </div>

      {errors.length > 0 && (
        <ul className="space-y-1">
          {errors.map((msg, i) => (
            <li
              key={i}
              className="flex items-start gap-1.5 text-[12px] text-red-600"
            >
              <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              <span>{msg}</span>
            </li>
          ))}
        </ul>
      )}

      {files.length > 0 && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
          {files.map((f, i) => (
            <div
              key={f.id}
              className="group relative aspect-square overflow-hidden rounded-lg border border-border bg-muted"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={f.previewUrl}
                alt={f.file.name}
                className="h-full w-full object-cover"
              />
              {i === 0 && (
                <span className="absolute left-1.5 top-1.5 rounded bg-background/90 px-1.5 py-0.5 text-[10px] font-medium text-foreground shadow-sm">
                  Primary
                </span>
              )}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  handleRemove(f.id);
                }}
                className="absolute right-1.5 top-1.5 inline-flex h-6 w-6 items-center justify-center rounded-md bg-background/90 text-foreground opacity-0 transition-opacity hover:bg-background group-hover:opacity-100 focus:opacity-100"
                aria-label={`Remove ${f.file.name}`}
              >
                <X className="h-3.5 w-3.5" />
              </button>
              <div className="absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/70 to-transparent px-2 py-1 text-[10px] text-white">
                {f.file.name}
              </div>
            </div>
          ))}
          {files.length < maxCount && (
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              disabled={disabled}
              className="aspect-square rounded-lg border border-dashed border-border flex items-center justify-center text-muted-foreground hover:text-foreground hover:border-primary/50 transition-colors"
            >
              <ImagePlus className="h-5 w-5" />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
