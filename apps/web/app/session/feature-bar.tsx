'use client';

import { Clock, Code2, Headphones, Settings2, UserCog, type LucideIcon } from 'lucide-react';

import { cn } from '@/lib/utils';

export type FeatureKey = 'setup' | 'listen' | 'coding' | 'history' | 'settings';

interface FeatureDef {
  key: FeatureKey;
  label: string;
  icon: LucideIcon;
  /** Tailwind class controlling the popover's content min-width. */
  width: string;
  /** Visual separator after this feature so adjacent ones read as one group. */
  divideAfter?: boolean;
}

export const FEATURES: readonly FeatureDef[] = [
  // "Listen" merges live transcript + copilot answer — they're two views of
  // one pipeline (mic → transcript → question detection → answer), so a
  // single panel is easier to grok than two siblings. Sits first, grouped
  // with the Capture cluster (Start/Pause/Stop) to its left.
  {
    key: 'listen',
    label: 'Listen',
    icon: Headphones,
    width: 'w-[50rem] max-w-[96vw]',
    divideAfter: true,
  },
  { key: 'setup', label: 'Setup', icon: UserCog, width: 'w-[44rem] max-w-[94vw]' },
  { key: 'coding', label: 'Coding', icon: Code2, width: 'w-[52rem] max-w-[96vw]' },
  { key: 'history', label: 'History', icon: Clock, width: 'w-[42rem] max-w-[94vw]' },
  { key: 'settings', label: 'Settings', icon: Settings2, width: 'w-[44rem] max-w-[94vw]' },
] as const;

export function getFeatureWidth(key: FeatureKey): string {
  return FEATURES.find((f) => f.key === key)?.width ?? 'w-[44rem] max-w-[94vw]';
}

export interface FeatureBarProps {
  active: FeatureKey | null;
  onChange: (next: FeatureKey | null) => void;
  /** Per-feature pulse-dot when the feature is streaming and not currently open. */
  badges: Partial<Record<FeatureKey, boolean>>;
}

export function FeatureBar({ active, onChange, badges }: FeatureBarProps) {
  return (
    <div className="flex items-center gap-1">
      {FEATURES.map((f, idx) => {
        const isActive = active === f.key;
        const showBadge = !isActive && Boolean(badges[f.key]);
        const Icon = f.icon;
        return (
          <div key={f.key} className="flex items-center gap-1">
            <button
              type="button"
              data-feature-trigger
              onClick={() => onChange(isActive ? null : f.key)}
              className={cn(
                'group/feature relative flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors',
                isActive
                  ? 'bg-sky-100 text-sky-700 shadow-[inset_0_-2px_0_0_rgba(56,189,248,0.6)] dark:bg-sky-950/40 dark:text-sky-300'
                  : 'text-neutral-700 hover:bg-white/60 hover:text-neutral-900 dark:text-neutral-300 dark:hover:bg-white/10 dark:hover:text-neutral-100',
              )}
              aria-label={f.label}
              aria-pressed={isActive}
            >
              <Icon className="h-4 w-4" aria-hidden />
              <span>{f.label}</span>
              {showBadge ? (
                <span
                  className="absolute right-1.5 top-1 flex h-1.5 w-1.5"
                  aria-label={`${f.label} updated`}
                >
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-sky-400 opacity-75" />
                  <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-sky-500" />
                </span>
              ) : null}
            </button>
            {f.divideAfter && idx < FEATURES.length - 1 ? (
              <span
                aria-hidden
                className="mx-1 h-5 w-px bg-neutral-300/50 dark:bg-neutral-100/10"
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
