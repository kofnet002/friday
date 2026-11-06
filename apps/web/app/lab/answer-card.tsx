'use client';

import { Check, Copy, Loader2, X } from 'lucide-react';
import { useState } from 'react';

import { Markdown } from '@/lib/markdown';
import { cn } from '@/lib/utils';

import type { AnswerDone } from './lab-api';
import { checkRubric, wordCount } from './lab-helpers';

export type RunStatus = 'idle' | 'running' | 'done' | 'error';

export interface RunState {
  status: RunStatus;
  text: string;
  error: string | null;
  done: AnswerDone | null;
  startedAt: number | null;
  firstTokenAt: number | null;
}

export const EMPTY_RUN: RunState = {
  status: 'idle',
  text: '',
  error: null,
  done: null,
  startedAt: null,
  firstTokenAt: null,
};

interface AnswerCardProps {
  model: string;
  effort: string | null;
  run: RunState;
  rubric: string;
}

function seconds(ms: number | null | undefined): string {
  return ms == null ? '—' : `${(ms / 1000).toFixed(1)}s`;
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col">
      <dt className="text-[10px] uppercase tracking-[0.14em] text-neutral-500">{label}</dt>
      <dd className="font-mono text-sm tabular-nums text-neutral-100">{value}</dd>
    </div>
  );
}

export function AnswerCard({ model, effort, run, rubric }: AnswerCardProps) {
  const [copied, setCopied] = useState(false);
  const checks = checkRubric(run.text, rubric);
  const hits = checks.filter((c) => c.hit).length;
  const firstTokenMs =
    run.done?.first_token_ms ??
    (run.firstTokenAt && run.startedAt ? run.firstTokenAt - run.startedAt : null);
  const cost = run.done?.usage?.cost;

  async function copy() {
    try {
      await navigator.clipboard.writeText(run.text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // Clipboard can be blocked (permissions); nothing useful to do.
    }
  }

  return (
    <article
      className={cn(
        'flex min-w-0 flex-col rounded-xl border bg-neutral-900/70 shadow-lg shadow-black/30',
        run.status === 'error' ? 'border-rose-900/70' : 'border-neutral-800',
      )}
    >
      <header className="flex items-start justify-between gap-3 border-b border-neutral-800 px-4 py-3">
        <div className="min-w-0">
          <h3 className="truncate font-mono text-sm font-semibold text-neutral-50">{model}</h3>
          <p className="text-xs text-neutral-500">
            {effort ? `${effort} effort` : 'default effort'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {run.status === 'running' && (
            <Loader2 className="h-4 w-4 animate-spin text-sky-400" aria-label="Running" />
          )}
          {run.text && (
            <button
              type="button"
              onClick={copy}
              className="rounded-md p-1.5 text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/40"
              aria-label="Copy answer"
            >
              {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            </button>
          )}
        </div>
      </header>

      <dl className="grid grid-cols-4 gap-2 border-b border-neutral-800 px-4 py-2.5">
        <Metric label="First word" value={seconds(firstTokenMs)} />
        <Metric label="Total" value={seconds(run.done?.total_ms)} />
        <Metric label="Words" value={run.text ? String(wordCount(run.text)) : '—'} />
        <Metric label="Cost" value={cost == null ? '—' : `$${cost.toFixed(3)}`} />
      </dl>

      {checks.length > 0 && run.status !== 'idle' && (
        <ul
          className="flex flex-wrap gap-1.5 border-b border-neutral-800 px-4 py-2.5"
          aria-label="Must-mention checks"
        >
          <li className="mr-1 self-center font-mono text-xs text-neutral-400">
            {hits}/{checks.length}
          </li>
          {checks.map((c) => (
            <li
              key={c.label}
              className={cn(
                'flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px]',
                c.hit
                  ? 'bg-emerald-950 text-emerald-300'
                  : 'bg-neutral-800 text-neutral-400 line-through',
              )}
            >
              {c.hit ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}
              {c.label}
            </li>
          ))}
        </ul>
      )}

      <div className="max-h-[70vh] min-h-[8rem] overflow-y-auto px-4 py-3 text-sm">
        {run.error && (
          <p className="mb-2 rounded-md bg-rose-950/60 px-3 py-2 text-rose-200">{run.error}</p>
        )}
        {run.text ? (
          <Markdown text={run.text} />
        ) : (
          run.status === 'running' && (
            <p className="text-neutral-500">Waiting for the first word…</p>
          )
        )}
      </div>
    </article>
  );
}
