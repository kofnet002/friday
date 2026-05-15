import * as React from 'react';

import { cn } from '@/lib/utils';

export type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement>;

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, ...props }, ref) => (
    <textarea
      ref={ref}
      className={cn(
        'min-h-[96px] w-full resize-y rounded-md border border-neutral-300 bg-white/70 px-3 py-2 text-sm shadow-sm transition-colors placeholder:text-neutral-500',
        'focus-visible:border-sky-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/30',
        'disabled:opacity-50',
        'dark:border-neutral-700 dark:bg-neutral-950/60 dark:placeholder:text-neutral-500',
        className,
      )}
      {...props}
    />
  ),
);
Textarea.displayName = 'Textarea';
