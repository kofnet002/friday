'use client';

import { useMemo, useState } from 'react';
import type {
  AnswerProvider,
  CodingLanguage,
  CodingMode,
  ExtractedProblem,
} from '@friday/shared-types';

import {
  Bug,
  Check,
  Clock,
  Code2,
  Copy,
  Eye,
  FileText,
  Play,
  Sparkles,
  Square,
  Target,
  TestTube2,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { friendlyError } from '@/lib/error-messages';
import { Markdown, useHighlightedCode } from '@/lib/markdown';
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

/** Scratch buffer for non-solve modes (explain / debug / tests). Lives on
 *  session-client so the coding WS message handler can route streamed
 *  tokens here when mode !== 'solve'. */
export interface CodingScratchState {
  /** The mode the scratch was last run with — used to render the right
   *  output structure header. */
  mode: CodingMode;
  /** Inputs the user typed. `code` is required for explain + debug;
   *  `error` for debug only; `hint` is optional context. */
  code: string;
  error: string;
  hint: string;
  /** Streamed output (Markdown). */
  output: string;
  status: CodingSolutionStatus;
  errorMessage: string | null;
}

export interface CodingPanelProps {
  active: boolean;
  onToggle: () => void;
  language: CodingLanguage;
  onLanguageChange: (lang: CodingLanguage) => void;
  provider: AnswerProvider;
  onProviderChange: (provider: AnswerProvider) => void;
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
  /** Active mode tab. solve = problem→solution (existing behavior).
   *  explain / debug / tests = scratch panel with user-typed inputs. */
  mode: CodingMode;
  onModeChange: (mode: CodingMode) => void;
  scratch: CodingScratchState;
  onScratchChange: (patch: Partial<CodingScratchState>) => void;
  onRunScratch: () => void;
  onCancelScratch: () => void;
}

export function CodingPanel({
  active,
  onToggle,
  language,
  onLanguageChange,
  provider,
  onProviderChange,
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
  mode,
  onModeChange,
  scratch,
  onScratchChange,
  onRunScratch,
  onCancelScratch,
}: CodingPanelProps) {
  const activeTab = tabs.find((t) => t.fingerprint === activeFingerprint) ?? null;

  const isSolveMode = mode === 'solve';

  return (
    // No outer card chrome — the surrounding popover already provides the
    // glass frame. Adding another border here just nests containers.
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <span className="text-xs font-semibold uppercase tracking-[0.18em] text-sky-600 dark:text-sky-400">
          Coding Mode
        </span>
        <ActivePill active={active} />
        <Select
          value={provider}
          onChange={(e) => onProviderChange(e.target.value as AnswerProvider)}
          className="ml-auto h-8 text-xs"
          aria-label="model"
        >
          <option value="gemini">Gemini 2.5 Flash</option>
          <option value="openai">GPT-4o</option>
          <option value="deepseek">DeepSeek</option>
        </Select>
        <Select
          value={language}
          onChange={(e) => onLanguageChange(e.target.value as CodingLanguage)}
          className="h-8 text-xs"
          aria-label="language"
        >
          {ALL_CODING_LANGUAGES.map((lang) => (
            <option key={lang} value={lang}>
              {lang}
            </option>
          ))}
        </Select>
        {/* Start/Stop is the screen-watcher toggle — only meaningful in
            solve mode where vision extraction feeds tabs. Hidden in scratch
            modes so the user doesn't think it gates Run. */}
        {isSolveMode ? (
          <Button
            type="button"
            size="sm"
            variant={active ? 'outline' : 'default'}
            onClick={onToggle}
          >
            {active ? 'Stop' : 'Start'}
          </Button>
        ) : null}
      </div>

      <ModeStrip mode={mode} onModeChange={onModeChange} />

      {!isSolveMode ? (
        <ScratchView
          mode={mode}
          scratch={scratch}
          activeTab={activeTab}
          language={language}
          onChange={onScratchChange}
          onRun={onRunScratch}
          onCancel={onCancelScratch}
          privacyMode={privacyMode}
        />
      ) : null}

      {!isSolveMode ? null : active && !activeTab ? (
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

      {!isSolveMode ? null : !active && tabs.length === 0 ? (
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

      {isSolveMode && tabs.length > 0 ? (
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

      {isSolveMode && activeTab ? (
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

// ─── Mode strip ──────────────────────────────────────────────────────────────

const MODE_DEFS: Array<{
  mode: CodingMode;
  label: string;
  icon: typeof Code2;
  hint: string;
}> = [
  { mode: 'solve', label: 'Solve', icon: Sparkles, hint: 'Auto-detected problem → solution' },
  { mode: 'explain', label: 'Explain', icon: FileText, hint: 'Walk through a code snippet' },
  { mode: 'debug', label: 'Debug', icon: Bug, hint: 'Diagnose an error and show the fix' },
  { mode: 'tests', label: 'Tests', icon: TestTube2, hint: 'Generate edge-case test inputs' },
];

function ModeStrip({
  mode,
  onModeChange,
}: {
  mode: CodingMode;
  onModeChange: (mode: CodingMode) => void;
}) {
  return (
    <div
      className="flex items-center gap-1 rounded-lg border border-neutral-200 bg-neutral-50/60 p-1 dark:border-neutral-800 dark:bg-neutral-900/40"
      role="tablist"
    >
      {MODE_DEFS.map(({ mode: m, label, icon: Icon, hint }) => {
        const isActive = m === mode;
        return (
          <button
            key={m}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => onModeChange(m)}
            title={hint}
            className={cn(
              'flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium transition-colors',
              isActive
                ? 'bg-white text-sky-700 shadow-sm dark:bg-neutral-800 dark:text-sky-300'
                : 'text-neutral-500 hover:bg-white/60 hover:text-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-800/50 dark:hover:text-neutral-200',
            )}
          >
            <Icon className="h-3.5 w-3.5" aria-hidden />
            <span>{label}</span>
          </button>
        );
      })}
    </div>
  );
}

// ─── Scratch view (explain / debug / tests) ──────────────────────────────────

function ScratchView({
  mode,
  scratch,
  activeTab,
  language,
  onChange,
  onRun,
  onCancel,
  privacyMode,
}: {
  mode: CodingMode;
  scratch: CodingScratchState;
  /** Solve-mode active tab. Used by tests-mode to pull the problem from
   *  the most recent detection rather than asking the user to retype it. */
  activeTab: CodingProblemTab | null;
  language: CodingLanguage;
  onChange: (patch: Partial<CodingScratchState>) => void;
  onRun: () => void;
  onCancel: () => void;
  privacyMode: boolean;
}) {
  const isStreaming = scratch.status === 'streaming' && scratch.mode === mode;
  // For tests mode we don't ask for code/error — we use the most recent
  // active solve tab as the implicit problem source. If there isn't one,
  // explain why.
  const testsNeedProblem = mode === 'tests' && !activeTab;
  const canRun =
    !isStreaming &&
    ((mode === 'explain' && scratch.code.trim().length > 0) ||
      (mode === 'debug' && scratch.code.trim().length > 0 && scratch.error.trim().length > 0) ||
      (mode === 'tests' && !testsNeedProblem));

  return (
    <div className="flex flex-col gap-3">
      {mode === 'tests' ? (
        testsNeedProblem ? (
          <p className="rounded-md border border-dashed border-amber-300 bg-amber-50/60 px-3 py-2 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-950/30 dark:text-amber-200">
            Tests mode uses the currently-open problem tab. Switch to Solve mode and let Friday
            detect a problem first, or open one from history.
          </p>
        ) : (
          <p className="rounded-md border border-sky-200 bg-sky-50/60 px-3 py-2 text-xs text-sky-700 dark:border-sky-500/30 dark:bg-sky-950/30 dark:text-sky-300">
            Will generate edge-case inputs for:{' '}
            <span className="font-medium">{activeTab?.problem.title ?? 'the active problem'}</span>
          </p>
        )
      ) : (
        <Textarea
          value={scratch.code}
          onChange={(e) => onChange({ code: e.target.value })}
          placeholder={
            mode === 'explain'
              ? `Paste ${language} code to explain…`
              : `Paste the ${language} code that's misbehaving…`
          }
          rows={8}
          className="font-mono text-[12px]"
          disabled={isStreaming}
        />
      )}

      {mode === 'debug' ? (
        <Textarea
          value={scratch.error}
          onChange={(e) => onChange({ error: e.target.value })}
          placeholder="Paste the error message or stack trace…"
          rows={4}
          className="font-mono text-[12px]"
          disabled={isStreaming}
        />
      ) : null}

      <div className="flex items-center gap-2">
        {isStreaming ? (
          <Button type="button" variant="outline" size="sm" onClick={onCancel}>
            <Square className="mr-1 h-3.5 w-3.5" aria-hidden />
            Cancel
          </Button>
        ) : (
          <Button type="button" size="sm" onClick={onRun} disabled={!canRun}>
            <Play className="mr-1 h-3.5 w-3.5" aria-hidden />
            Run
          </Button>
        )}
        <span className="text-[11px] text-neutral-500">
          {mode === 'explain' && 'Walkthrough · complexity · gotchas'}
          {mode === 'debug' && 'Diagnosis · fix · why · verify'}
          {mode === 'tests' && '5–8 edge cases targeting different failure modes'}
        </span>
      </div>

      {scratch.errorMessage ? (
        <div className="rounded-md border border-red-400/50 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-500/30 dark:bg-red-950/40 dark:text-red-300">
          {scratch.errorMessage}
        </div>
      ) : null}

      {scratch.output || isStreaming ? (
        <div
          className={cn(
            'rounded-lg border border-neutral-200 bg-white/40 p-3 dark:border-neutral-800 dark:bg-neutral-900/30',
            privacyMode && 'select-none blur-sm',
          )}
        >
          <Markdown text={scratch.output + (isStreaming ? ' ▍' : '')} />
        </div>
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
    <div className="flex flex-col gap-4">
      <div>
        <button
          type="button"
          onClick={() => setProblemOpen((v) => !v)}
          className="-mx-1 flex w-full items-center justify-between gap-2 rounded-md px-1 py-1 text-left text-[10px] font-semibold uppercase tracking-[0.18em] text-neutral-500 transition-colors hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-200"
        >
          <span>
            Problem
            {problem.title ? (
              <span className="ml-2 normal-case tracking-normal text-neutral-700 dark:text-neutral-300">
                · {problem.title}
              </span>
            ) : null}
          </span>
          <span className="font-mono text-neutral-400">{problemOpen ? '−' : '+'}</span>
        </button>
        {problemOpen ? (
          <div className="mt-2 flex flex-col gap-3 text-[12px]">
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

      <div className={cn(privacyMode && 'select-none blur-sm')}>
        {status === 'error' ? (
          <div className="flex items-center justify-between gap-2 rounded-lg border border-red-400/50 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-500/30 dark:bg-red-950/40 dark:text-red-300">
            <span>{error ?? 'solution failed'}</span>
            <Button type="button" size="sm" variant="outline" onClick={onRegenerate}>
              Retry
            </Button>
          </div>
        ) : solution ? (
          <SolutionView solution={solution} isStreaming={isStreaming} />
        ) : (
          <div className="rounded-lg border border-dashed border-neutral-300 bg-neutral-50/60 px-4 py-6 text-center text-xs text-neutral-500 dark:border-neutral-700 dark:bg-neutral-950/40">
            {isStreaming ? 'Generating…' : 'No solution yet. Click Regenerate.'}
          </div>
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

// ─── Solution rendering ────────────────────────────────────────────────────
//
// The solution prompt (CODING_SOLUTION_VERSION 1.1+) emits five fixed H3
// sections in this order: 🎯 Approach, ⏱️ Complexity, 💻 Code, 💡 Key
// insight, ⚡ Edge cases. Splitting on those headings lets us render each
// as a styled sub-card with its own icon and tone instead of one wall of
// prose. During streaming the parser falls back to plain Markdown until at
// least one heading has been emitted.

interface ParsedSolution {
  approach: string;
  complexity: string;
  codeRaw: string; // entire markdown body, including the fence
}

// Section names the parser knows. Match is case-insensitive and tolerates a
// wide range of heading styles emitted across prompt versions:
//   ### 🎯 Approach
//   ### Approach
//   **Approach**
//   1. **Approach** — content
//   3. Code:
// Insight + Edge cases are intentionally omitted — they crowd the panel
// and the candidate doesn't read them in a live interview anyway.
const SECTION_NAMES: { key: keyof ParsedSolution; names: string[] }[] = [
  { key: 'approach', names: ['approach'] },
  { key: 'complexity', names: ['complexity'] },
  { key: 'codeRaw', names: ['code'] },
];

const HEADING_PREFIX =
  // optional list marker (1. / 1) / -)
  '(?:[\\t ]*(?:[-*]|\\d+[.)])\\s+)?' +
  // optional markdown heading marks
  '(?:#{1,6}\\s*)?' +
  // optional leading emoji / unicode glyph
  '(?:[^\\w\\s\\n]+\\s*)?' +
  // optional bold open
  '\\*{0,2}\\s*';

const HEADING_SUFFIX =
  // optional bold close
  '\\s*\\*{0,2}' +
  // optional separator (colon or em-dash) — eats up to but not the rest of the line
  '\\s*[:—\\-]?\\s*';

function buildHeadingRe(name: string): RegExp {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${HEADING_PREFIX}${escaped}${HEADING_SUFFIX}`, 'gim');
}

function parseSolution(text: string): ParsedSolution | null {
  const found: { key: keyof ParsedSolution; lineStart: number; bodyStart: number }[] = [];
  for (const { key, names } of SECTION_NAMES) {
    let best: { start: number; end: number } | null = null;
    for (const name of names) {
      const re = buildHeadingRe(name);
      const m = re.exec(text);
      if (m && (best === null || m.index < best.start)) {
        best = { start: m.index, end: m.index + m[0].length };
      }
    }
    if (best) found.push({ key, lineStart: best.start, bodyStart: best.end });
  }
  if (found.length === 0) return null;
  found.sort((a, b) => a.lineStart - b.lineStart);

  const out: ParsedSolution = {
    approach: '',
    complexity: '',
    codeRaw: '',
  };
  for (let i = 0; i < found.length; i++) {
    const cur = found[i]!;
    const next = found[i + 1];
    out[cur.key] = text.slice(cur.bodyStart, next ? next.lineStart : text.length).trim();
  }
  return out;
}

function extractCodeFromFence(raw: string): { language: string; code: string } {
  // Match the FIRST fenced block — ignore any prose around it. During
  // streaming the closing fence may not be present yet; tolerate that.
  const m = raw.match(/```([a-zA-Z+#0-9_-]*)\n([\s\S]*?)(?:```|$)/);
  if (!m) return { language: '', code: '' };
  return { language: (m[1] ?? '').trim(), code: (m[2] ?? '').replace(/\n+$/, '') };
}

function SolutionView({ solution, isStreaming }: { solution: string; isStreaming: boolean }) {
  const parsed = useMemo(() => parseSolution(solution), [solution]);

  if (!parsed) {
    return (
      <div className="rounded-xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-950">
        <Markdown text={solution + (isStreaming ? ' ▍' : '')} />
      </div>
    );
  }

  const cursor = isStreaming ? ' ▍' : '';

  return (
    <div className="flex flex-col gap-4">
      {parsed.approach || parsed.complexity ? (
        <div className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
          {parsed.approach ? (
            <SolutionField icon={<Target className="h-3 w-3" aria-hidden />} label="Approach">
              {parsed.approach}
              {isStreaming && !parsed.complexity ? cursor : null}
            </SolutionField>
          ) : null}

          {parsed.complexity ? (
            <SolutionField icon={<Clock className="h-3 w-3" aria-hidden />} label="Complexity" mono>
              {parsed.complexity}
              {isStreaming && !parsed.codeRaw ? cursor : null}
            </SolutionField>
          ) : null}
        </div>
      ) : null}

      {parsed.codeRaw ? <CodeSection raw={parsed.codeRaw} isStreaming={isStreaming} /> : null}
    </div>
  );
}

// Lightweight label + value pair. No background, no border, no card chrome
// — just a tiny uppercase label above the content. Body text is forced to
// 12px so it matches the rest of the dense floating-bar UI.
function SolutionField({
  icon,
  label,
  children,
  mono,
}: {
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-neutral-500 dark:text-neutral-400">
        {icon}
        {label}
      </span>
      <p
        className={cn(
          'text-[12px] leading-relaxed text-neutral-900 dark:text-neutral-100',
          mono && 'font-mono',
        )}
      >
        {children}
      </p>
    </div>
  );
}

// IDE-style code card. Single frame (no nested gray backgrounds), traffic
// lights on the left, language pill + copy button on the right, and the
// shiki-highlighted code rendered straight into the body so its native
// theme background carries through edge-to-edge.
function CodeSection({ raw, isStreaming }: { raw: string; isStreaming: boolean }) {
  const { language, code } = useMemo(() => extractCodeFromFence(raw), [raw]);
  const html = useHighlightedCode(code, language);
  const [copied, setCopied] = useState(false);

  const onCopy = async () => {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      /* swallow */
    }
  };

  return (
    <section className="friday-code-card overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-sm ring-1 ring-black/5 dark:border-neutral-800 dark:bg-[#0d1117] dark:ring-white/5">
      <header className="flex items-center justify-between gap-2 border-b border-neutral-200 px-3.5 py-2 dark:border-neutral-800/80">
        <div className="flex items-center gap-2">
          {/* Traffic lights — purely decorative, hint that this is a code editor */}
          <span className="flex items-center gap-1" aria-hidden>
            <span className="h-2.5 w-2.5 rounded-full bg-red-400/90" />
            <span className="h-2.5 w-2.5 rounded-full bg-amber-400/90" />
            <span className="h-2.5 w-2.5 rounded-full bg-emerald-400/90" />
          </span>
          <span className="ml-1 inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.14em] text-neutral-500 dark:text-neutral-400">
            <Code2 className="h-3 w-3" aria-hidden />
            solution.{language || 'txt'}
          </span>
          {isStreaming ? (
            <span className="ml-1 inline-flex items-center gap-1 rounded-full bg-sky-500/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-sky-700 dark:text-sky-300">
              <span className="h-1 w-1 animate-pulse rounded-full bg-sky-500" />
              streaming
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-1.5">
          {language ? (
            <span className="rounded-md border border-neutral-200 bg-neutral-50 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-neutral-600 dark:border-neutral-800 dark:bg-neutral-900/60 dark:text-neutral-300">
              {language}
            </span>
          ) : null}
          <button
            type="button"
            onClick={onCopy}
            disabled={!code}
            aria-label={copied ? 'Copied' : 'Copy code'}
            title={copied ? 'Copied' : 'Copy code'}
            className="inline-flex h-6 items-center gap-1 rounded-md border border-neutral-200 bg-white px-2 text-[10px] font-medium text-neutral-700 transition-colors hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-800 dark:bg-neutral-900/60 dark:text-neutral-200 dark:hover:bg-neutral-800"
          >
            {copied ? (
              <Check className="h-3 w-3 text-emerald-500" aria-hidden />
            ) : (
              <Copy className="h-3 w-3" aria-hidden />
            )}
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      </header>
      <div className="friday-code-body relative overflow-x-auto text-[12px] leading-relaxed">
        {html ? (
          <div dangerouslySetInnerHTML={{ __html: html }} />
        ) : (
          <pre className="px-3 py-2 font-mono text-neutral-800 dark:text-neutral-100">
            <code>{code || ' '}</code>
          </pre>
        )}
      </div>
    </section>
  );
}
