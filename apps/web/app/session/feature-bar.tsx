'use client';

import { Clock, Sparkles, Settings2, UserCog, type LucideIcon } from 'lucide-react';

import { cn } from '@/lib/utils';

export type FeatureKey = 'setup' | 'assist' | 'history' | 'settings';

interface FeatureDef {
  key: FeatureKey;
  label: string;
  icon: LucideIcon;
  /** Tailwind class controlling the popover's content min-width. */
  width: string;
  /** When true, surfaces this feature as a hero pill in the main bar. */
  primary: boolean;
}

// Assist brings audio answers and screen analysis into one workspace.
export const FEATURES: readonly FeatureDef[] = [
  {
    key: 'assist',
    label: 'Assist',
    icon: Sparkles,
    width: 'w-[52rem] max-w-[96vw]',
    primary: true,
  },
  { key: 'setup', label: 'Setup', icon: UserCog, width: 'w-[44rem] max-w-[94vw]', primary: false },
  {
    key: 'history',
    label: 'History',
    icon: Clock,
    width: 'w-[42rem] max-w-[94vw]',
    primary: false,
  },
  {
    key: 'settings',
    label: 'Settings',
    icon: Settings2,
    width: 'w-[44rem] max-w-[94vw]',
    primary: false,
  },
] as const;

export const PRIMARY_FEATURES = FEATURES.filter((f) => f.primary);
export const SECONDARY_FEATURES = FEATURES.filter((f) => !f.primary);

export function getFeatureWidth(key: FeatureKey): string {
  return FEATURES.find((f) => f.key === key)?.width ?? 'w-[44rem] max-w-[94vw]';
}

export interface FeatureBarProps {
  active: FeatureKey | null;
  onChange: (next: FeatureKey | null) => void;
  /** Per-feature pulse-dot when the feature is streaming and not currently open. */
  badges: Partial<Record<FeatureKey, boolean>>;
}

// Hero row — only PRIMARY features render here. Parakeet-style: trailing
// icon, dashed-outline active state, opaque dark surface (set by parent).
export function FeatureBar({ active, onChange, badges }: FeatureBarProps) {
  return (
    <div className="flex items-center gap-1">
      {PRIMARY_FEATURES.map((f) => {
        const isActive = active === f.key;
        const showBadge = !isActive && Boolean(badges[f.key]);
        const Icon = f.icon;
        return (
          <button
            key={f.key}
            type="button"
            data-feature-trigger
            onClick={() => onChange(isActive ? null : f.key)}
            className={cn(
              'group/feature relative inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium transition-[color,background-color,transform] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 active:scale-[0.98] motion-reduce:transition-none motion-reduce:active:scale-100',
              // Parakeet: dashed outline = active, no fill. Inactive is bare text
              // with a soft hover bg. The dashed effect uses outline (not ring)
              // because Tailwind's ring doesn't support dashed styles.
              isActive
                ? 'text-neutral-900 outline outline-1 outline-offset-[-2px] outline-dashed outline-neutral-600 dark:text-white dark:outline-white/55'
                : 'text-neutral-700 hover:bg-white/60 hover:text-neutral-900 dark:text-neutral-200 dark:hover:bg-white/10 dark:hover:text-white',
            )}
            aria-label={f.label}
            aria-pressed={isActive}
          >
            <span>{f.label}</span>
            <Icon className="h-3.5 w-3.5 opacity-90" aria-hidden />
            {showBadge ? (
              <span
                className="absolute right-1 top-1 flex h-1.5 w-1.5"
                aria-label={`${f.label} updated`}
              >
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-sky-400 opacity-75 motion-reduce:animate-none" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-sky-500" />
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
