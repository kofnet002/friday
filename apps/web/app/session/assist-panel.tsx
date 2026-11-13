'use client';

import { createContext, useRef, type ReactNode, type RefObject } from 'react';
import { Eye, Headphones, Loader2, MonitorUp, Play } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export type AssistView = 'answers' | 'screen';

/** The Assist workspace's scroll container, for content that follows its
 *  own streaming text (the Screen tab's answers). */
export const AssistScrollContext = createContext<RefObject<HTMLDivElement | null> | null>(null);

interface AssistPanelProps {
  view: AssistView;
  onViewChange: (view: AssistView) => void;
  onStartTogether: () => void;
  audioStatus: 'live' | 'paused' | 'off';
  screenStatus: 'live' | 'paused' | 'off';
  starting: boolean;
  privacyMode: boolean;
  children: ReactNode;
}

/** One workspace for audio answers and screen-aware coding help. */
export function AssistPanel({
  view,
  onViewChange,
  onStartTogether,
  audioStatus,
  screenStatus,
  starting,
  privacyMode,
  children,
}: AssistPanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const bothSourcesLive = audioStatus === 'live' && screenStatus === 'live';
  const hasPausedSource = audioStatus === 'paused' || screenStatus === 'paused';
  const startLabel = hasPausedSource
    ? 'Resume Assist'
    : screenStatus === 'live'
      ? 'Start listening too'
      : audioStatus === 'live'
        ? 'Watch screen too'
        : 'Start Assist';
  const tabs: { id: AssistView; label: string; icon: typeof Headphones }[] = [
    { id: 'answers', label: 'AI Help', icon: Headphones },
    { id: 'screen', label: 'Screen', icon: MonitorUp },
  ];

  return (
    <section aria-label="Assist workspace" className="flex h-full min-h-0 flex-col gap-3">
      <header
        className={cn(
          'flex flex-wrap items-center justify-between gap-3 border-b pb-3 transition-[border-color,box-shadow] duration-300 motion-reduce:transition-none',
          bothSourcesLive
            ? 'border-emerald-300/70 shadow-[0_8px_20px_-18px_rgba(16,185,129,0.65)] dark:border-emerald-800/70'
            : 'border-neutral-200/70 dark:border-white/10',
        )}
      >
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-neutral-900 dark:text-neutral-100">
            <Eye className="h-4 w-4 text-sky-600 dark:text-sky-400" aria-hidden />
            Assist
          </h2>
          <p className="mt-0.5 text-xs text-neutral-600 dark:text-neutral-400">
            {bothSourcesLive
              ? 'Friday listens to the interviewer and watches your screen. Spoken questions use both when relevant.'
              : 'Listen to the interviewer and watch the screen together, or start either source on its own.'}
          </p>
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2">
          {!privacyMode ? (
            <div className="flex flex-wrap items-center gap-2" aria-label="Capture status">
              <CaptureStatus
                icon={Headphones}
                label="Audio"
                status={audioStatus}
                activeLabel="Live"
              />
              <CaptureStatus
                icon={MonitorUp}
                label="Screen"
                status={screenStatus}
                activeLabel="Watching"
              />
            </div>
          ) : null}
          {!bothSourcesLive ? (
            <Button type="button" size="sm" onClick={onStartTogether} disabled={starting}>
              {starting ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden />
              ) : (
                <Play className="mr-1.5 h-3.5 w-3.5" aria-hidden />
              )}
              {starting ? 'Starting…' : startLabel}
            </Button>
          ) : null}
        </div>
      </header>

      <div
        role="group"
        aria-label="Assist view"
        className="relative flex items-center rounded-xl bg-neutral-100/80 p-1 dark:bg-neutral-800/70"
      >
        <span
          aria-hidden="true"
          className={cn(
            'pointer-events-none absolute inset-y-1 left-1 w-[calc(50%-0.25rem)] rounded-lg bg-white shadow-sm transition-transform duration-200 ease-out motion-reduce:transition-none dark:bg-neutral-700',
            view === 'screen' && 'translate-x-full',
          )}
        />
        {tabs.map(({ id, label, icon: Icon }) => {
          const selected = view === id;
          return (
            <button
              key={id}
              type="button"
              aria-pressed={selected}
              onClick={() => onViewChange(id)}
              className={cn(
                'relative z-10 inline-flex min-h-8 flex-1 items-center justify-center gap-2 rounded-lg px-2.5 text-xs font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 active:scale-[0.98] motion-reduce:active:scale-100',
                selected
                  ? 'text-neutral-900 dark:text-white'
                  : 'text-neutral-600 hover:text-neutral-900 dark:text-neutral-300 dark:hover:text-white',
              )}
            >
              <Icon className="h-4 w-4" aria-hidden />
              {label}
              {id === 'answers' && audioStatus !== 'off' ? (
                <span className="sr-only">, audio active</span>
              ) : null}
              {id === 'screen' && screenStatus !== 'off' ? (
                <span className="sr-only">, screen active</span>
              ) : null}
            </button>
          );
        })}
      </div>

      <div
        key={view}
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-auto animate-in fade-in slide-in-from-bottom-1 duration-200 motion-reduce:animate-none"
      >
        <AssistScrollContext.Provider value={scrollRef}>{children}</AssistScrollContext.Provider>
      </div>
    </section>
  );
}

function CaptureStatus({
  icon: Icon,
  label,
  status,
  activeLabel,
}: {
  icon: typeof Headphones;
  label: string;
  status: 'live' | 'paused' | 'off';
  activeLabel: string;
}) {
  const style =
    status === 'live'
      ? 'border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300'
      : status === 'paused'
        ? 'border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-300'
        : 'border-neutral-200 bg-white/70 text-neutral-600 dark:border-neutral-700 dark:bg-neutral-900/60 dark:text-neutral-400';

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium',
        style,
      )}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden />
      {label}
      <span className="text-[11px]">
        {status === 'live' ? activeLabel : status === 'paused' ? 'Paused' : 'Off'}
      </span>
    </span>
  );
}
