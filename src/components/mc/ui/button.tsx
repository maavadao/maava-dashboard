'use client';

import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 rounded-xl text-sm font-semibold transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--mc-accent)] focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        primary: 'bg-[color:var(--mc-accent)] text-white shadow-sm hover:bg-[color:var(--mc-accent-strong)]',
        secondary:
          'border border-[color:var(--mc-border)] bg-[color:var(--mc-surface)] text-[color:var(--mc-text)] hover:border-[color:var(--mc-accent)] hover:text-[color:var(--mc-accent)]',
        outline:
          'border border-[color:var(--mc-border-strong)] bg-transparent text-[color:var(--mc-text)] hover:border-[color:var(--mc-accent)] hover:text-[color:var(--mc-accent)]',
        ghost: 'bg-transparent text-[color:var(--mc-text)] hover:bg-[color:var(--mc-surface-strong)]',
      },
      size: {
        sm: 'h-9 px-4',
        md: 'h-11 px-5',
        lg: 'h-12 px-6 text-base',
      },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => (
    <button ref={ref} className={cn(buttonVariants({ variant, size, className }))} {...props} />
  )
);
Button.displayName = 'Button';

export { Button, Button as MCButton, buttonVariants };
