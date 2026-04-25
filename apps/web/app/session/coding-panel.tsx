'use client';

import { useState } from 'react';
import type { AnswerProvider, CodingLanguage, ExtractedProblem } from '@friday/shared-types';

import { Code2, Eye } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { friendlyError } from '@/lib/error-messages';
import { Markdown } from '@/lib/markdown';
import { ALL_CODING_LANGUAGES } from '@/lib/session-context';
import { cn } from '@/lib/utils';

export type CodingSolutionStatus = 'idle' | 'streaming' | 'done' | 'cancelled' | 'error';

export interface CodingProblemTab {
  fingerprint: string;
  problem: ExtractedProblem;
  language: CodingLanguage;
  solution: string;
  status: CodingSolutionStatus;
  error: string | null;
  savedId: number | null;
}

export interface CodingPanelProps {
  active: boolean;
  onToggle: () => void;
  language: CodingLanguage;
  onLanguageChange: (lang: CodingLanguage) => void;
  provider: AnswerProvider;
  tabs: CodingProblemTab[];
  activeFingerprint: string | null;
  onSelectTab: (fingerprint: string) => void;
  onCloseTab: (fingerprint: string) => void;
  onClearAll: () => void;
  onRegenerate: () => void;
  onReExtract: () => void;
  onCancel: () => void;
  frameInfo: { changed_bits: number; interval_ms: number } | null;
  error: string | null;
  privacyMode: boolean;
}

export function CodingPanel({
  active,
  onToggle,
  language,
  onLanguageChange,
  provider,
  tabs,
  activeFingerprint,
  onSelectTab,
  onCloseTab,
  onClearAll,
  onRegenerate,
  onReExtract,
  onCancel,
  frameInfo,
  error,
  privacyMode,
}: CodingPanelProps) {
  const activeTab = tabs.find((t) => t.fingerprint === activeFingerprint) ?? null;

  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-neutral-200 bg-white/80 p-4 shadow-sm backdrop-blur dark:border-neutral-800 dark:bg-neutral-900/60">
      <div className="flex items-center gap-3">
        <span className="text-xs font-semibold uppercase tracking-[0.18em] text-sky-600 dark:text-sky-400">
          Coding Mode
        </span>
        <ActivePill active={active} />
        <Select
          value={language}
          onChange={(e) => onLanguageChange(e.target.value as CodingLanguage)}
          className="ml-auto h-8 text-xs"
          aria-label="language"
        >
          {ALL_CODING_LANGUAGES.map((lang) => (
            <option key={lang} value={lang}>
              {lang}
            </option>
          ))}
        </Select>
        <Button type="button" size="sm" variant={active ? 'outline' : 'default'} onClick={onToggle}>
          {active ? 'Stop' : 'Start'}
        </Button>
      </div>

      {active && !activeTab ? (
        <div className="flex items-center gap-2 rounded-lg border border-dashed border-sky-300 bg-sky-50/40 px-3 py-2 text-xs text-sky-700 dark:border-sky-500/30 dark:bg-sky-950/20 dark:text-sky-300">
          <Eye className="h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>Watching for coding problems on-screen…</span>
          {frameInfo ? (
            <span className="ml-auto font-mono text-[10px] text-sky-500 dark:text-sky-400/80">
              Δ {frameInfo.changed_bits}/64
            </span>
          ) : null}
        </div>
      ) : null}

      {!active && tabs.length === 0 ? (
        <div className="flex flex-col items-start gap-2 rounded-lg border border-dashed border-neutral-300 bg-neutral-50/60 px-4 py-5 dark:border-neutral-700 dark:bg-neutral-950/40">
          <Code2 className="h-5 w-5 text-neutral-400 dark:text-neutral-500" aria-hidden />
          <p className="text-sm font-medium text-neutral-800 dark:text-neutral-200">
            Coding mode is off
          </p>
          <p className="text-xs leading-relaxed text-neutral-500 dark:text-neutral-400">
            When enabled, Friday watches your screen and auto-detects LeetCode, Turing, and
            HackerRank problems — then streams a solution.
          </p>
          <div className="mt-1 flex items-center gap-2 text-[11px] text-neutral-500">
            <kbd className="rounded border border-neutral-300 bg-white px-1.5 py-0.5 font-mono text-[10px] text-neutral-700 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200">
              ⌘⇧C
            </kbd>
            <span>or click Start above</span>
          </div>
        </div>
      ) : null}

      {tabs.length > 0 ? (
        <div className="flex items-center gap-1 overflow-x-auto border-b border-neutral-200 dark:border-neutral-800">
          {tabs.map((tab) => {
            const isActive = tab.fingerprint === activeFingerprint;
            return (
              <div
                key={tab.fingerprint}
                className={cn(
                  'group flex items-center gap-1 whitespace-nowrap px-2 py-1.5 -mb-px border-b-2',
                  isActive
                    ? 'border-sky-500'
                    : 'border-transparent hover:border-neutral-300 dark:hover:border-neutral-700',
                )}
              >
                <button
                  type="button"
                  onClick={() => onSelectTab(tab.fingerprint)}
                  className={cn(
                    'text-xs font-medium',
                    isActive
                      ? 'text-sky-700 dark:text-sky-300'
                      : 'text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300',
                  )}
                >
                  {tab.problem.title ?? `Problem ${tab.fingerprint.slice(0, 6)}`}
                  <DifficultyBadge difficulty={tab.problem.difficulty ?? null} />
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onCloseTab(tab.fingerprint);
                  }}
                  aria-label="close tab"
                  className="flex h-4 w-4 items-center justify-center rounded-full text-[11px] leading-none text-neutral-400 opacity-50 transition-all hover:bg-neutral-200 hover:text-neutral-700 hover:opacity-100 group-hover:opacity-100 dark:hover:bg-neutral-700 dark:hover:text-neutral-200"
                >
                  ×
                </button>
              </div>
            );
          })}
          <button
            type="button"
            onClick={onClearAll}
            className="ml-auto rounded-md px-2 py-1 text-[11px] font-medium text-neutral-500 hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
          >
            Clear all
          </button>
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

      {activeTab ? (
        <ActiveProblemView
          tab={activeTab}
          provider={provider}
          onRegenerate={onRegenerate}
          onReExtract={onReExtract}
          onCancel={onCancel}
          privacyMode={privacyMode}
        />
      ) : null}
    </div>
  );
}

function ActivePill({ active }: { active: boolean }) {
  return (
    <div
      className={cn(
        'flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-semibold tracking-widest',
        active
          ? 'bg-sky-500/15 text-sky-700 dark:text-sky-300'
          : 'bg-neutral-200/60 text-neutral-500 dark:bg-neutral-800/80',
      )}
    >
      <span
        className={cn(
          'h-1.5 w-1.5 rounded-full',
          active ? 'animate-pulse bg-sky-500' : 'bg-neutral-400',
        )}
      />
      {active ? 'WATCHING' : 'IDLE'}
    </div>
  );
}

function DifficultyBadge({ difficulty }: { difficulty: string | null }) {
  if (!difficulty) return null;
  const tone =
    difficulty === 'easy'
      ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400'
      : difficulty === 'medium'
        ? 'bg-amber-500/15 text-amber-700 dark:text-amber-400'
        : 'bg-red-500/15 text-red-700 dark:text-red-400';
  return (
    <span className={cn('ml-2 rounded-full px-1.5 py-0.5 text-[9px] font-semibold', tone)}>
      {difficulty.toUpperCase()}
    </span>
  );
}

function ActiveProblemView({
  tab,
  provider,
  onRegenerate,
  onReExtract,
  onCancel,
  privacyMode,
}: {
  tab: CodingProblemTab;
  provider: AnswerProvider;
  onRegenerate: () => void;
  onReExtract: () => void;
  onCancel: () => void;
  privacyMode: boolean;
}) {
  const { problem, solution, status, error } = tab;
  const [copied, setCopied] = useState(false);
  const [problemOpen, setProblemOpen] = useState(true);
  const isStreaming = status === 'streaming';

  const copyCode = async () => {
    const match = solution.match(/```[a-zA-Z+#]*\n([\s\S]*?)```/);
    const code = (match?.[1] ?? solution).trim();
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-lg border border-neutral-200 dark:border-neutral-800">
        <button
          type="button"
          onClick={() => setProblemOpen((v) => !v)}
          className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-xs font-semibold uppercase tracking-[0.15em] text-neutral-600 dark:text-neutral-400"
        >
          <span>
            Problem
            {problem.title ? (
              <span className="ml-2 normal-case tracking-normal text-neutral-500">
                · {problem.title}
              </span>
            ) : null}
          </span>
          <span className="text-neutral-400">{problemOpen ? '−' : '+'}</span>
        </button>
        {problemOpen ? (
          <div className="flex flex-col gap-3 border-t border-neutral-200 p-3 text-sm dark:border-neutral-800">
            {problem.problem_statement ? (
              <p className="whitespace-pre-wrap leading-relaxed text-neutral-800 dark:text-neutral-200">
                {problem.problem_statement}
              </p>
            ) : null}
            {problem.examples?.length ? (
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-xs">
                  <thead>
                    <tr className="text-left text-neutral-500">
                      <th className="pb-1 pr-4">Input</th>
                      <th className="pb-1 pr-4">Output</th>
                      <th className="pb-1">Explanation</th>
                    </tr>
                  </thead>
                  <tbody>
                    {problem.examples.map((ex, i) => (
                      <tr
                        key={i}
                        className="border-t border-neutral-200 align-top dark:border-neutral-800"
                      >
                        <td className="py-1 pr-4 font-mono">{ex.input}</td>
                        <td className="py-1 pr-4 font-mono">{ex.output}</td>
                        <td className="py-1 text-neutral-500">{ex.explanation ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
            {problem.constraints?.length ? (
              <ul className="list-disc space-y-0.5 pl-5 text-xs text-neutral-600 dark:text-neutral-400">
                {problem.constraints.map((c, i) => (
                  <li key={i} className="font-mono">
                    {c}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={onRegenerate}
          disabled={isStreaming}
        >
          Regenerate · {tab.language}
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={onReExtract}>
          Re-extract
        </Button>
        {isStreaming ? (
          <Button type="button" size="sm" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
        {solution ? (
          <Button type="button" size="sm" variant="ghost" onClick={copyCode}>
            {copied ? 'Copied ✓' : 'Copy code'}
          </Button>
        ) : null}
        <div className="ml-auto flex items-center gap-2 self-center">
          {tab.savedId ? (
            <span className="flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-400">
              <span className="h-1 w-1 rounded-full bg-emerald-500" aria-hidden />
              Saved
            </span>
          ) : null}
          <span className="rounded-full bg-neutral-100 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">
            {provider} · {tab.language}
          </span>
        </div>
      </div>

      <div
        className={cn(
          'rounded-lg border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-950',
          privacyMode && 'select-none blur-sm',
        )}
      >
        {status === 'error' ? (
          <div className="flex items-center justify-between gap-2 text-xs text-red-700 dark:text-red-400">
            <span>{error ?? 'solution failed'}</span>
            <Button type="button" size="sm" variant="outline" onClick={onRegenerate}>
              Retry
            </Button>
          </div>
        ) : solution ? (
          <Markdown text={solution + (isStreaming ? ' ▍' : '')} />
        ) : (
          <p className="text-xs text-neutral-500">
            {isStreaming ? 'Generating…' : 'No solution yet. Click Regenerate.'}
          </p>
        )}
      </div>
      {privacyMode ? (
        <div className="rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2 text-xs text-neutral-600 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-300">
          Stealth mode is on. Coding content is masked in this window.
        </div>
      ) : null}
    </div>
  );
}
