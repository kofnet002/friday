'use client';

import { Loader2 } from 'lucide-react';
import type { ReactNode } from 'react';
import type { BriefStatus } from '@friday/shared-types';

import { cn } from '@/lib/utils';

const BRIEF_STATUS: Record<BriefStatus, { label: string; className: string }> = {
  none: {
    label: 'No brief',
    className: 'border-neutral-200 text-neutral-500 dark:border-neutral-700 dark:text-neutral-400',
  },
  generating: {
    label: 'Generating',
    className:
      'border-sky-200 bg-sky-50/60 text-sky-700 dark:border-sky-500/30 dark:bg-sky-950/30 dark:text-sky-300',
  },
  ready: {
    label: 'Brief ready',
    className:
      'border-emerald-300 bg-emerald-50/70 text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-950/30 dark:text-emerald-200',
  },
  stale: {
    label: 'Stale',
    className:
      'border-amber-300 bg-amber-50/70 text-amber-800 dark:border-amber-500/30 dark:bg-amber-950/30 dark:text-amber-200',
  },
  error: {
    label: 'Error',
    className:
      'border-red-300 bg-red-50/70 text-red-700 dark:border-red-500/30 dark:bg-red-950/30 dark:text-red-300',
  },
};

export function BriefStatusBadge({ status }: { status: BriefStatus }) {
  const def = BRIEF_STATUS[status] ?? BRIEF_STATUS.none;
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider',
        def.className,
      )}
    >
      {status === 'generating' ? (
        <Loader2 className="h-2.5 w-2.5 animate-spin" aria-hidden />
      ) : null}
      {def.label}
    </span>
  );
}

export function FieldLabel({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5 text-sm">
      <span className="text-[11px] font-medium uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
        {label}
      </span>
      {children}
    </label>
  );
}

export function Checkbox({
  checked,
  onChange,
  disabled,
  children,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <label
      className={cn(
        'inline-flex cursor-pointer select-none items-center gap-2 text-xs text-neutral-700 dark:text-neutral-300',
        disabled && 'cursor-not-allowed opacity-60',
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="h-3.5 w-3.5 shrink-0 rounded border-neutral-300 accent-sky-600 dark:border-neutral-700 dark:accent-sky-400"
      />
      {children}
    </label>
  );
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-md border border-red-400/50 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-500/30 dark:bg-red-950/40 dark:text-red-300">
      {children}
    </p>
  );
}

export function formatChars(chars: number): string {
  if (chars < 1000) return `${chars} chars`;
  if (chars < 1_000_000) return `${(chars / 1000).toFixed(chars < 10_000 ? 1 : 0)}k chars`;
  return `${(chars / 1_000_000).toFixed(1)}M chars`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Backend timestamps are epoch seconds. */
export function formatDate(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/** The setup screen renders inside a `<form>` whose submit starts the
 *  session. Swallow Enter in text inputs within the projects area so typing
 *  a project name and hitting Enter doesn't navigate away; `onEnter` lets a
 *  caller map it to its own action instead. */
export function stopImplicitSubmit(onEnter?: () => void) {
  return (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
    e.preventDefault();
    onEnter?.();
  };
}
