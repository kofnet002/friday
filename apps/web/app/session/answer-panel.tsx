'use client';

import { useState } from 'react';
import type { AnswerProvider } from '@friday/shared-types';

import { Loader2, Sparkles } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { friendlyError } from '@/lib/error-messages';
import { Markdown } from '@/lib/markdown';
import { cn } from '@/lib/utils';

export type AnswerStatus = 'idle' | 'streaming' | 'done' | 'cancelled' | 'error';

export interface AnswerPanelProps {
  provider: AnswerProvider;
  onProviderChange: (p: AnswerProvider) => void;
  question: string | null;
  answer: string;
  status: AnswerStatus;
  error: string | null;
  marked: boolean;
  onMarkAnswered: () => void;
  onCancel: () => void;
  onClear: () => void;
  onSubmitCustom: (question: string) => void;
  connected: boolean;
  privacyMode: boolean;
}

export function AnswerPanel({
  provider,
  onProviderChange,
  question,
  answer,
  status,
  error,
  marked,
  onMarkAnswered,
  onCancel,
  onClear,
  onSubmitCustom,
  connected,
  privacyMode,
}: AnswerPanelProps) {
  const [customPrompt, setCustomPrompt] = useState('');

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = customPrompt.trim();
    if (!trimmed) return;
    onSubmitCustom(trimmed);
    setCustomPrompt('');
  };

  const isStreaming = status === 'streaming';

  return (
    <div className="flex h-full flex-col gap-4 rounded-2xl border border-neutral-200 bg-white/80 p-4 shadow-sm backdrop-blur dark:border-neutral-800 dark:bg-neutral-900/60">
      <div className="flex items-center gap-2.5">
        <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-sky-600 dark:text-sky-400">
          Copilot
        </span>
        <span
          className={cn(
            'flex items-center gap-1.5 rounded-full px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider',
            connected
              ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400'
              : 'bg-neutral-200/60 text-neutral-500 dark:bg-neutral-800/80 dark:text-neutral-500',
          )}
          title={connected ? 'WebSocket connected' : 'WebSocket disconnected'}
        >
          <span
            className={cn(
              'h-1.5 w-1.5 rounded-full',
              connected ? 'animate-pulse bg-emerald-500' : 'bg-neutral-400',
            )}
          />
          {connected ? 'live' : 'offline'}
        </span>
        <Select
          value={provider}
          onChange={(e) => onProviderChange(e.target.value as AnswerProvider)}
          className="ml-auto h-7 text-xs"
        >
          <option value="gemini">Gemini 2.5 Flash</option>
          <option value="openai">GPT-5</option>
        </Select>
      </div>

      {question ? (
        <div className="rounded-lg border border-sky-400/30 bg-sky-50 px-3 py-2 text-sm leading-snug text-sky-900 dark:border-sky-400/20 dark:bg-sky-950/30 dark:text-sky-200">
          <div className="text-[10px] font-semibold uppercase tracking-[0.15em] text-sky-600 dark:text-sky-400">
            Detected question
          </div>
          <p className="mt-1">{question}</p>
        </div>
      ) : null}

      {error
        ? (() => {
            const f = friendlyError(error);
            return (
              <div className="rounded-md border border-red-400/50 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-500/30 dark:bg-red-950/40 dark:text-red-300">
                <p className="font-medium">{f.text}</p>
                {f.hint ? <p className="mt-0.5 opacity-80">{f.hint}</p> : null}
              </div>
            );
          })()
        : null}

      <div
        className={cn(
          'min-h-[200px] flex-1 overflow-y-auto rounded-lg border border-neutral-200 bg-neutral-50 p-4 transition-opacity dark:border-neutral-800 dark:bg-neutral-950',
          marked && 'opacity-50',
          privacyMode && 'select-none blur-sm',
        )}
      >
        {answer ? (
          <Markdown text={answer + (isStreaming ? ' ▍' : '')} />
        ) : isStreaming ? (
          <div className="flex items-center gap-2 text-sm text-sky-600 dark:text-sky-400">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            <span>Generating…</span>
          </div>
        ) : question ? (
          <p className="text-sm text-neutral-500 dark:text-neutral-400">Ready.</p>
        ) : (
          <div className="flex h-full flex-col items-start justify-center gap-3 py-2">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-sky-600 dark:text-sky-400">
              <Sparkles className="h-3.5 w-3.5" aria-hidden />
              Awaiting a question
            </div>
            <ul className="flex flex-col gap-1.5 text-sm text-neutral-600 dark:text-neutral-300">
              <li className="flex gap-2">
                <span className="text-neutral-400">·</span>
                Auto-fires when an interview question is detected on transcription.
              </li>
              <li className="flex gap-2">
                <span className="text-neutral-400">·</span>
                Press{' '}
                <kbd className="rounded border border-neutral-300 bg-white px-1.5 py-0.5 font-mono text-[11px] text-neutral-700 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200">
                  ⌘⇧␣
                </kbd>{' '}
                to force-ask from the latest transcript.
              </li>
              <li className="flex gap-2">
                <span className="text-neutral-400">·</span>
                Or type a custom prompt below and hit Send.
              </li>
            </ul>
          </div>
        )}
      </div>

      {privacyMode ? (
        <div className="rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2 text-xs text-neutral-600 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-300">
          Stealth mode is on. Answer content is masked in this window.
        </div>
      ) : null}

      {answer || isStreaming ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {isStreaming ? (
            <Button variant="outline" size="sm" onClick={onCancel}>
              Cancel
            </Button>
          ) : null}
          {answer && !isStreaming ? (
            <Button
              variant={marked ? 'outline' : 'ghost'}
              size="sm"
              onClick={onMarkAnswered}
              className={cn(marked && 'text-emerald-700 dark:text-emerald-400')}
            >
              {marked ? '✓ Marked' : 'Mark as answered'}
            </Button>
          ) : null}
          {answer ? (
            <Button variant="ghost" size="sm" onClick={onClear}>
              Clear
            </Button>
          ) : null}
        </div>
      ) : null}

      <form onSubmit={handleSubmit} className="flex gap-2">
        <Input
          value={customPrompt}
          onChange={(e) => setCustomPrompt(e.target.value)}
          placeholder="Ask the copilot directly…"
          className="flex-1"
        />
        <Button type="submit" disabled={!customPrompt.trim() || !connected}>
          Send
        </Button>
      </form>
    </div>
  );
}
