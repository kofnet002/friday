import * as React from 'react';

import { cn } from '@/lib/utils';

export type InputProps = React.InputHTMLAttributes<HTMLInputElement>;

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, ...props }, ref) => (
    <input
      type={type}
      ref={ref}
      className={cn(
        'flex h-9 w-full rounded-md border border-neutral-300 bg-white/70 px-3 py-1 text-sm shadow-sm transition-colors',
        'placeholder:text-neutral-500',
        'focus-visible:border-sky-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/30',
        'disabled:cursor-not-allowed disabled:opacity-50',
        'dark:border-neutral-700 dark:bg-neutral-950/60 dark:placeholder:text-neutral-400',
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = 'Input';
