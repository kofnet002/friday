'use client';

import { useState } from 'react';
import type { AnswerProvider } from '@friday/shared-types';

import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
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
      <div className="flex items-center gap-3">
        <span className="text-xs font-semibold uppercase tracking-[0.18em] text-sky-600 dark:text-sky-400">
          Copilot
        </span>
        <Select
          value={provider}
          onChange={(e) => onProviderChange(e.target.value as AnswerProvider)}
          className="h-8 text-xs"
        >
          <option value="gemini">Gemini 2.5 Pro</option>
          <option value="openai">GPT-5</option>
        </Select>
        <span
          className={cn(
            'ml-auto flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-semibold tracking-widest',
            connected
              ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400'
              : 'bg-neutral-300/40 text-neutral-500',
          )}
        >
          <span
            className={cn(
              'h-1.5 w-1.5 rounded-full',
              connected ? 'bg-emerald-500' : 'bg-neutral-400',
            )}
          />
          {connected ? 'LINKED' : 'OFFLINE'}
        </span>
      </div>

      {question ? (
        <div className="rounded-lg border border-sky-400/30 bg-sky-50 px-3 py-2 text-sm leading-snug text-sky-900 dark:border-sky-400/20 dark:bg-sky-950/30 dark:text-sky-200">
          <div className="text-[10px] font-semibold uppercase tracking-[0.15em] text-sky-600 dark:text-sky-400">
            Detected question
          </div>
          <p className="mt-1">{question}</p>
        </div>
      ) : null}

      {error ? (
        <div className="rounded-md border border-red-400/50 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-500/30 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </div>
      ) : null}

      <div
        className={cn(
          'min-h-[200px] flex-1 overflow-y-auto rounded-lg border border-neutral-200 bg-neutral-50 p-4 transition-opacity dark:border-neutral-800 dark:bg-neutral-950',
          marked && 'opacity-50',
        )}
      >
        {answer ? (
          <Markdown text={answer + (isStreaming ? ' ▍' : '')} />
        ) : (
          <p className="text-sm text-neutral-400 dark:text-neutral-600">
            {isStreaming
              ? 'Generating…'
              : question
                ? 'Ready.'
                : 'Waiting for a detected question, hotkey (⌘⇧␣), or custom prompt below.'}
          </p>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        {isStreaming ? (
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
        {answer && !isStreaming ? (
          <Button variant="outline" onClick={onMarkAnswered}>
            {marked ? 'Unmark' : 'Mark as answered'}
          </Button>
        ) : null}
        {answer ? (
          <Button variant="ghost" onClick={onClear}>
            Clear
          </Button>
        ) : null}
      </div>

      <form onSubmit={handleSubmit} className="flex gap-2">
        <input
          value={customPrompt}
          onChange={(e) => setCustomPrompt(e.target.value)}
          placeholder="Ask the copilot directly…"
          className="h-10 flex-1 rounded-md border border-neutral-300 bg-white px-3 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-neutral-400 dark:border-neutral-700 dark:bg-neutral-950"
        />
        <Button type="submit" disabled={!customPrompt.trim() || !connected}>
          Send
        </Button>
      </form>
    </div>
  );
}
