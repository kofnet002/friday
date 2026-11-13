'use client';

import { useEffect, useMemo, useState } from 'react';
import type {
  AnswerProvider,
  ClaudeModel,
  CodingLanguage,
  CodingMode,
  CodingTestCaseResult,
  ExtractedProblem,
} from '@friday/shared-types';

import {
  Bot,
  Bug,
  Check,
  CircleCheck,
  CircleX,
  Clock,
  Code2,
  Copy,
  Eye,
  FileText,
  Play,
  Sparkles,
  Square,
  Terminal,
  Target,
  TestTube2,
  Wrench,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { SavedPassages } from './saved-passages';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { friendlyError } from '@/lib/error-messages';
import { Markdown, useHighlightedCode } from '@/lib/markdown';
import { ALL_CODING_LANGUAGES, CLAUDE_MODEL_OPTIONS } from '@/lib/session-context';
import { cn } from '@/lib/utils';

export type CodingSolutionStatus = 'idle' | 'streaming' | 'done' | 'cancelled' | 'error';

/** Self-verification state for a solve tab. null until the backend has
 *  run the streamed solution against the problem's examples. */
export interface CodingTestState {
  ran: boolean;
  cases: CodingTestCaseResult[];
  skipReason: string | null;
}

/** One entry in the agent's live trace. `text` is the agent's own reasoning,
 *  `tool` a tool it invoked (Bash/Write/…), `result` what that tool returned. */
export type AgentStep =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; tool: string; summary: string }
  | { kind: 'result'; ok: boolean; summary: string };

/** Agent-mode state for a tab. Set when the user escalates the problem to the
 *  Claude Code agent; the trace streams into `steps` and the verified answer
 *  lands in the tab's `solution` like a normal solve. null when the agent
 *  hasn't been run on this problem. */
export interface AgentTraceState {
  status: CodingSolutionStatus;
  steps: AgentStep[];
  /** Epoch ms when this run started — drives the live elapsed counter. */
  startedAt: number;
}

/** Session-cumulative agent usage (subscription time is the real cost). */
export interface AgentSessionStats {
  runs: number;
  totalMs: number;
}

export interface CodingProblemTab {
  fingerprint: string;
  problem: ExtractedProblem;
  language: CodingLanguage;
  solution: string;
  status: CodingSolutionStatus;
  error: string | null;
  savedId: number | null;
  /** Result of running the streamed solution against the examples.
   *  null while the solution is still streaming or before verification. */
  tests: CodingTestState | null;
  /** Live trace + status when this problem was (or is being) solved by the
   *  Claude Code agent. null if the agent was never run on this tab. */
  agent: AgentTraceState | null;
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
  /** Claude model used when provider is 'claude'. */
  claudeModel: ClaudeModel;
  onClaudeModelChange: (model: ClaudeModel) => void;
  tabs: CodingProblemTab[];
  activeFingerprint: string | null;
  onSelectTab: (fingerprint: string) => void;
  onCloseTab: (fingerprint: string) => void;
  onClearAll: () => void;
  onRegenerate: () => void;
  onReExtract: () => void;
  onCancel: () => void;
  /** Re-runs solve mode with the current solution as `prior_solution` and
   *  the user's note as `feedback`. Used when LeetCode-style test cases
   *  fail against the streamed answer. */
  onRefine: (feedback: string) => void;
  /** Escalate the active problem to the Claude Code agent (tool-loop solve).
   *  Runs on the current tab; the trace + verified answer replace the tab's
   *  one-shot solution. */
  onAgentSolve: () => void;
  /** Session-cumulative agent usage (runs + wall-clock) — surfaces the
   *  subscription cost the way the cost pill does for API providers. */
  agentStats: AgentSessionStats;
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
  scanState: FridayScanState | null;
  onStartScan: (displayId?: string) => void;
  onFinishScan: () => void;
  onCancelScan: () => void;
  pendingScreenQuestion: {
    question: string;
    completeness: 'partial' | 'uncertain';
    missingSections: string[];
  } | null;
  onAnswerCapturedQuestion: () => void;
  onScanQuestionAgain: () => void;
  sessionId: string;
  /** Bumped whenever the remembered passages change, to refetch the list. */
  passagesRefreshKey: number;
  onClearScreenContext: () => void;
}

export function CodingPanel({
  active,
  onToggle,
  language,
  onLanguageChange,
  provider,
  onProviderChange,
  claudeModel,
  onClaudeModelChange,
  tabs,
  activeFingerprint,
  onSelectTab,
  onCloseTab,
  onClearAll,
  onRegenerate,
  onReExtract,
  onCancel,
  onRefine,
  onAgentSolve,
  agentStats,
  frameInfo,
  error,
  privacyMode,
  mode,
  onModeChange,
  scratch,
  onScratchChange,
  onRunScratch,
  onCancelScratch,
  scanState,
  onStartScan,
  onFinishScan,
  onCancelScan,
  pendingScreenQuestion,
  onAnswerCapturedQuestion,
  onScanQuestionAgain,
  sessionId,
  passagesRefreshKey,
  onClearScreenContext,
}: CodingPanelProps) {
  const activeTab = tabs.find((t) => t.fingerprint === activeFingerprint) ?? null;
  const [displays, setDisplays] = useState<FridayScanDisplay[]>([]);
  const [selectedDisplay, setSelectedDisplay] = useState('');

  useEffect(() => {
    const api = window.friday?.coding;
    if (!api) return;
    void Promise.all([api.listDisplays(), api.getScanDisplay()])
      .then(([available, saved]) => {
        setDisplays(available);
        setSelectedDisplay(
          saved ||
            available.find((display) => display.isPrimary)?.displayId ||
            available[0]?.displayId ||
            '',
        );
      })
      .catch(() => setDisplays([]));
  }, []);

  const isSolveMode = mode === 'solve';

  return (
    // No outer card chrome — the surrounding popover already provides the
    // glass frame. Adding another border here just nests containers.
    <div className="flex flex-col gap-4">
      {/* Header chrome is suppressed in privacy mode for the same reason
          AnswerPanel suppresses its header: the "Coding Mode" label,
          WATCHING/IDLE pill, model/language selectors, and Start/Stop
          button all visibly reveal that AI assistance is active. */}
      {!privacyMode ? (
        <div className="flex items-center gap-3">
          <span className="text-xs font-semibold uppercase tracking-[0.18em] text-sky-600 dark:text-sky-400">
            Coding Mode
          </span>
          <ActivePill active={active} />
          <Select
            // Claude entries carry their model id ("claude-sonnet-5-5"); the
            // other providers keep their provider id as the value.
            value={provider === 'claude' ? claudeModel : provider}
            onChange={(e) => {
              const value = e.target.value;
              const claude = CLAUDE_MODEL_OPTIONS.find((option) => option.id === value);
              if (claude) {
                onClaudeModelChange(claude.id);
                if (provider !== 'claude') onProviderChange('claude');
              } else {
                onProviderChange(value as AnswerProvider);
              }
            }}
            className="ml-auto h-8 text-xs"
            aria-label="model"
          >
            <option value="gemini">Gemini 2.5 Flash</option>
            <option value="openai">GPT-4o</option>
            <option value="deepseek">DeepSeek</option>
            {CLAUDE_MODEL_OPTIONS.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
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
      ) : null}

      {!privacyMode ? <ModeStrip mode={mode} onModeChange={onModeChange} /> : null}

      {isSolveMode ? (
        <div
          className="flex flex-wrap items-center gap-2 rounded-lg border border-sky-200 bg-sky-50/60 px-3 py-2 dark:border-sky-900 dark:bg-sky-950/25"
          data-interactive
        >
          {displays.length > 1 ? (
            <Select
              aria-label="Screen to scan"
              className="h-8 max-w-44 text-xs"
              value={selectedDisplay}
              onChange={(event) => {
                const value = event.target.value;
                setSelectedDisplay(value);
                void window.friday?.coding.setScanDisplay(value || null);
              }}
              disabled={scanState?.state === 'capturing' || scanState?.state === 'combining'}
            >
              {displays.map((display) => (
                <option key={display.displayId} value={display.displayId}>
                  {display.label}
                </option>
              ))}
            </Select>
          ) : null}
          {scanState?.state === 'capturing' ? (
            <>
              <span role="status" aria-live="polite" className="text-xs">
                {/* Scan state re-emits every ~400ms tick, so this recency check
                    refreshes on its own and the cue fades back to the count. */}
                {scanState.capturedAt && Date.now() - scanState.capturedAt < 2500 ? (
                  <span className="font-medium text-emerald-700 dark:text-emerald-300">
                    ✓ View {scanState.frames} captured — scroll to the next part
                  </span>
                ) : (
                  <>
                    Scanning · {scanState.frames} {scanState.frames === 1 ? 'view' : 'views'}
                    {scanState.lastCapture === 'duplicate' ? ' · section already captured' : ''}
                  </>
                )}
              </span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => void window.friday?.coding.captureScanSection()}
                aria-label="Capture this section (⌘⇧Enter)"
              >
                Capture section
              </Button>
              <Button type="button" size="sm" onClick={onFinishScan}>
                Finish scan
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={onCancelScan}>
                Cancel
              </Button>
              <span className="w-full text-xs text-muted-foreground">
                Keep scrolling down the page. Friday reads each part and finishes a few seconds
                after you stop · ⌘⇧Enter captures the current section
              </span>
            </>
          ) : scanState?.state === 'combining' ? (
            <span role="status" aria-live="polite" className="text-xs">
              {scanState.finishedBy === 'idle' ? 'Scrolling stopped · ' : ''}Reading{' '}
              {scanState.frames} {scanState.frames === 1 ? 'view' : 'views'}…
            </span>
          ) : (
            <>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => onStartScan(selectedDisplay || undefined)}
                disabled={!active || typeof window === 'undefined' || !window.friday?.coding}
                aria-label="Start guided screen scan"
              >
                Scan screen
              </Button>
              <span className="text-xs text-muted-foreground">
                Reads a long page as you scroll · ⌘⇧S starts or finishes
              </span>
            </>
          )}
          {scanState?.state === 'partial' ? (
            <span role="status" className="w-full text-xs text-amber-700 dark:text-amber-300">
              Partial scan{scanState.limitReached ? ' · capture limit reached' : ''}. Review the
              extracted text or scan again.
            </span>
          ) : null}
          {scanState?.state === 'failed' ? (
            <span role="alert" className="w-full text-xs text-destructive">
              Scan failed: {scanState.error || 'Try again.'}
            </span>
          ) : null}
          <SavedPassages
            sessionId={sessionId}
            refreshKey={passagesRefreshKey}
            onClearAll={onClearScreenContext}
          />
        </div>
      ) : null}

      {pendingScreenQuestion ? (
        <div
          className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950/30"
          data-interactive
        >
          <p className="font-medium">
            Screen question needs review · {pendingScreenQuestion.completeness}
          </p>
          <p className="mt-1 whitespace-pre-wrap">{pendingScreenQuestion.question}</p>
          {pendingScreenQuestion.missingSections.length ? (
            <p className="mt-1 text-xs">
              Could not read: {pendingScreenQuestion.missingSections.join(', ')}
            </p>
          ) : null}
          <div className="mt-2 flex gap-2">
            <Button size="sm" onClick={onAnswerCapturedQuestion}>
              Answer captured text
            </Button>
            <Button size="sm" variant="outline" onClick={onScanQuestionAgain}>
              Scan again
            </Button>
          </div>
        </div>
      ) : null}

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

      {!isSolveMode ? null : active && !activeTab && !privacyMode ? (
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

      {!isSolveMode ? null : !active && tabs.length === 0 && !privacyMode ? (
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

      {/* Tabs strip leaks the problem titles + difficulty badges — hide
          the whole strip in privacyMode for stealth parity with the rest
          of the panel. */}
      {isSolveMode && tabs.length > 0 && !privacyMode ? (
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

      {error && !privacyMode
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
          active={active}
          provider={provider}
          onRegenerate={onRegenerate}
          onReExtract={onReExtract}
          onStartScan={() => onStartScan(selectedDisplay || undefined)}
          onCancel={onCancel}
          onRefine={onRefine}
          onAgentSolve={onAgentSolve}
          agentStats={agentStats}
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
            // Match SolutionView's outer chrome so the modes feel like
            // siblings of Solve. Fully opaque card so the always-visible
            // copy buttons on code blocks have a clean backdrop.
            'rounded-xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-950',
            privacyMode && 'select-none blur-md',
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
  active,
  provider,
  onRegenerate,
  onReExtract,
  onStartScan,
  onCancel,
  onRefine,
  onAgentSolve,
  agentStats,
  privacyMode,
}: {
  tab: CodingProblemTab;
  active: boolean;
  provider: AnswerProvider;
  onRegenerate: () => void;
  onReExtract: () => void;
  onStartScan: () => void;
  onCancel: () => void;
  onRefine: (feedback: string) => void;
  onAgentSolve: () => void;
  agentStats: AgentSessionStats;
  privacyMode: boolean;
}) {
  const { problem, solution, status, error, agent } = tab;
  const [copied, setCopied] = useState(false);
  const [problemOpen, setProblemOpen] = useState(true);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedback, setFeedback] = useState('');
  const isStreaming = status === 'streaming';
  const agentRunning = agent?.status === 'streaming';

  const submitFeedback = () => {
    const trimmed = feedback.trim();
    if (!trimmed) return;
    onRefine(trimmed);
    setFeedback('');
    setFeedbackOpen(false);
  };

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

  // Heuristic for "the screenshot only got the top of a scrollable problem":
  // a real LeetCode-class problem always has examples + constraints, and
  // usually a function signature from the right-side editor. If none of
  // those came through but the extractor was still confident enough to
  // emit, the page probably extended below the viewport. Surface a hint
  // pointing at Re-extract so the user knows the recovery path.
  const looksTruncated =
    problem.completeness === 'partial' ||
    problem.completeness === 'uncertain' ||
    (!problem.examples?.length && !problem.constraints?.length && !problem.function_signature);

  return (
    <div className="flex flex-col gap-4">
      {looksTruncated ? (
        <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50/70 px-3 py-2 text-[12px] text-amber-900 dark:border-amber-500/30 dark:bg-amber-950/30 dark:text-amber-100">
          <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-amber-200/80 font-semibold dark:bg-amber-500/20">
            !
          </span>
          <div className="flex flex-col gap-1">
            <span className="font-medium">
              {problem.completeness === 'complete'
                ? 'Looks like the problem was partially captured.'
                : `Problem capture: ${problem.completeness ?? 'incomplete'}.`}
            </span>
            <span className="text-amber-900/80 dark:text-amber-100/80">
              {problem.missing_sections?.length
                ? `Could not read: ${problem.missing_sections.join(', ')}. Use guided scan to capture the remaining page.`
                : 'Use guided scan to capture the remaining prompt, examples, constraints, or editor.'}
            </span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => onStartScan()}
              disabled={!active}
            >
              Scan remaining page
            </Button>
          </div>
        </div>
      ) : null}
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
            {problem.screen_code ? (
              <pre className="overflow-x-auto rounded-md bg-neutral-100 p-2 text-[11px] dark:bg-neutral-900">
                <code>{problem.screen_code}</code>
              </pre>
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
        {/* Escalate to the Claude Code agent — it writes code, runs it against
            the examples, and fixes failures before answering. Slower but
            solves problems the one-shot providers miss. Disabled while any
            stream (normal or agent) is in flight for this tab. */}
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={onAgentSolve}
          disabled={isStreaming || agentRunning}
          title="Solve with the Claude Code agent — runs & verifies code before answering (uses your Claude subscription)"
          className="border-violet-300 text-violet-700 hover:bg-violet-50 dark:border-violet-500/40 dark:text-violet-300 dark:hover:bg-violet-950/30"
        >
          <Bot className="mr-1 h-3.5 w-3.5" aria-hidden />
          {agentRunning ? 'Agent working…' : 'Agent'}
        </Button>
        {/* Refine-with-feedback — only useful once we've actually produced a
            solution to refine. Hidden while streaming for the same reason
            Regenerate is disabled (the prior solution is still mutating). */}
        {solution && !isStreaming ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setFeedbackOpen((v) => !v)}
            title="Tell Friday why the current solution didn't pass — it'll re-run with that context"
          >
            {feedbackOpen ? 'Cancel feedback' : "Didn't pass?"}
          </Button>
        ) : null}
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
          {agentStats.runs > 0 ? (
            <span
              className="rounded-full bg-violet-500/15 px-2 py-0.5 font-mono text-[10px] text-violet-700 dark:text-violet-300"
              title="Claude agent usage this session (bills your subscription)"
            >
              🤖 {agentStats.runs} run{agentStats.runs === 1 ? '' : 's'} ·{' '}
              {Math.round(agentStats.totalMs / 60000)}m
            </span>
          ) : null}
          <span className="rounded-full bg-neutral-100 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">
            {provider} · {tab.language}
          </span>
        </div>
      </div>

      {feedbackOpen ? (
        <div className="flex flex-col gap-2 rounded-lg border border-amber-300/70 bg-amber-50/60 p-3 dark:border-amber-500/30 dark:bg-amber-950/30">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-amber-800 dark:text-amber-200">
            What went wrong?
          </p>
          <Textarea
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            placeholder={`e.g. "Case 2 failed — expected 94, got 64" or "TypeError on line 7"`}
            rows={3}
            className="text-[12px]"
            autoFocus
          />
          <div className="flex items-center gap-2">
            <Button type="button" size="sm" onClick={submitFeedback} disabled={!feedback.trim()}>
              Refine with feedback
            </Button>
            <span className="text-[11px] text-amber-800/80 dark:text-amber-200/80">
              Friday will re-run with the current solution + your note.
            </span>
          </div>
        </div>
      ) : null}

      {/* Agent trace — the live tool-loop timeline when this problem was
          escalated to the Claude Code agent. Kept above the solution so the
          user watches the work, then reads the verified answer below. */}
      {agent && !privacyMode ? <AgentTraceView agent={agent} /> : null}

      {/* Self-verification verdict — appears once the backend has run the
          streamed solution against the problem's examples. Hidden while
          the solution is still streaming. */}
      {!isStreaming && solution && tab.tests ? (
        <TestResultsPanel tests={tab.tests} onRefine={onRefine} />
      ) : null}

      <div className={cn(privacyMode && 'select-none blur-md')}>
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

// ─── Agent trace ────────────────────────────────────────────────────────────

function AgentTraceView({ agent }: { agent: AgentTraceState }) {
  const running = agent.status === 'streaming';
  // Live elapsed counter — a long agent run should read as deliberate work,
  // not a frozen panel. Ticks only while running.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [running]);
  const elapsedS = Math.max(0, Math.round((now - agent.startedAt) / 1000));
  const elapsed =
    elapsedS >= 60 ? `${Math.floor(elapsedS / 60)}m ${elapsedS % 60}s` : `${elapsedS}s`;
  return (
    <div className="rounded-lg border border-violet-200 bg-violet-50/40 dark:border-violet-500/30 dark:bg-violet-950/20">
      <div className="flex items-center gap-2 border-b border-violet-200/70 px-3 py-1.5 dark:border-violet-500/20">
        <Bot className="h-3.5 w-3.5 text-violet-600 dark:text-violet-400" aria-hidden />
        <span className="text-[11px] font-semibold uppercase tracking-wider text-violet-700 dark:text-violet-300">
          Claude Code agent
        </span>
        <span className="ml-auto text-[10px] font-medium text-violet-500 dark:text-violet-400/80">
          {running
            ? `working · ${elapsed} · ${agent.steps.length} steps`
            : agent.status === 'error'
              ? 'stopped'
              : agent.status === 'cancelled'
                ? 'cancelled'
                : `done · ${agent.steps.length} steps`}
        </span>
      </div>
      <div className="max-h-56 overflow-y-auto px-3 py-2">
        {agent.steps.length === 0 ? (
          <p className="py-1 text-[11px] italic text-violet-500 dark:text-violet-400/80">
            {running ? 'Spinning up the agent…' : 'No trace.'}
          </p>
        ) : (
          <ol className="flex flex-col gap-1.5">
            {agent.steps.map((step, i) => (
              <AgentStepRow key={i} step={step} />
            ))}
          </ol>
        )}
        {running ? (
          <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-violet-500 dark:text-violet-400/80">
            <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-violet-500" />
            thinking…
          </div>
        ) : null}
      </div>
    </div>
  );
}

function AgentStepRow({ step }: { step: AgentStep }) {
  if (step.kind === 'text') {
    return (
      <li className="flex gap-2 text-[12px] leading-relaxed text-neutral-700 dark:text-neutral-300">
        <Bot className="mt-0.5 h-3 w-3 shrink-0 text-violet-500" aria-hidden />
        <span className="whitespace-pre-wrap">{step.text}</span>
      </li>
    );
  }
  if (step.kind === 'tool') {
    const Icon = step.tool === 'Bash' ? Terminal : Wrench;
    return (
      <li className="flex gap-2 text-[11px] text-neutral-600 dark:text-neutral-400">
        <Icon className="mt-0.5 h-3 w-3 shrink-0 text-sky-500" aria-hidden />
        <span className="min-w-0">
          <span className="font-medium text-neutral-700 dark:text-neutral-300">{step.tool}</span>
          {step.summary ? (
            <span className="ml-1.5 break-all font-mono text-neutral-500">{step.summary}</span>
          ) : null}
        </span>
      </li>
    );
  }
  // result
  return (
    <li className="flex gap-2 text-[11px]">
      {step.ok ? (
        <CircleCheck className="mt-0.5 h-3 w-3 shrink-0 text-emerald-500" aria-hidden />
      ) : (
        <CircleX className="mt-0.5 h-3 w-3 shrink-0 text-red-500" aria-hidden />
      )}
      <span
        className={cn(
          'min-w-0 break-all font-mono',
          step.ok ? 'text-neutral-500' : 'text-red-600 dark:text-red-400',
        )}
      >
        {step.summary || (step.ok ? 'ok' : 'error')}
      </span>
    </li>
  );
}

// ─── Self-verification panel ───────────────────────────────────────────────

// Compose a precise, machine-checked refine prompt from the first failing
// example. The judge ran the solution locally, so this feedback is exact
// (not the user's hand-typed guess) — exactly what the refine prompt's
// "trace the failing input" rule wants.
function buildFailureFeedback(cases: CodingTestCaseResult[]): string {
  const failing = cases.map((c, i) => ({ c, i })).filter(({ c }) => !c.ok);
  if (failing.length === 0) return '';
  const lines = [
    `Self-verification failed ${failing.length} of ${cases.length} example(s). ` +
      `Fix the solution so every example passes.`,
    '',
  ];
  for (const { c, i } of failing) {
    lines.push(`Example ${i + 1}:`);
    lines.push(`  input:    ${c.input}`);
    lines.push(`  expected: ${c.expected}`);
    if (c.error) {
      lines.push(`  raised:   ${c.error}`);
    } else {
      lines.push(`  got:      ${c.actual ?? '(no output)'}`);
    }
  }
  return lines.join('\n');
}

function TestResultsPanel({
  tests,
  onRefine,
}: {
  tests: CodingTestState;
  onRefine: (feedback: string) => void;
}) {
  // Verification was skipped (non-Python, no examples, blocked code) — a
  // quiet neutral note so the user knows why there's no ✓/✗, not an alarm.
  if (!tests.ran) {
    return (
      <div className="rounded-lg border border-neutral-200 bg-neutral-50/60 px-3 py-2 text-[11px] text-neutral-500 dark:border-neutral-800 dark:bg-neutral-900/40 dark:text-neutral-400">
        Not verified — {tests.skipReason ?? 'verification skipped'}.
      </div>
    );
  }

  const passed = tests.cases.filter((c) => c.ok).length;
  const total = tests.cases.length;
  const allPassed = total > 0 && passed === total;

  if (allPassed) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-emerald-300 bg-emerald-50/70 px-3 py-2 text-xs font-medium text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-950/30 dark:text-emerald-200">
        <CircleCheck className="h-4 w-4 shrink-0" aria-hidden />
        Verified — passed all {total} example{total === 1 ? '' : 's'}.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-red-300 bg-red-50/70 p-3 dark:border-red-500/30 dark:bg-red-950/30">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-xs font-semibold text-red-800 dark:text-red-200">
          <CircleX className="h-4 w-4 shrink-0" aria-hidden />
          Failed {total - passed} of {total} example{total === 1 ? '' : 's'}
        </span>
        <Button type="button" size="sm" onClick={() => onRefine(buildFailureFeedback(tests.cases))}>
          Refine with this failure
        </Button>
      </div>
      <ul className="flex flex-col gap-1.5">
        {tests.cases.map((c, i) => (
          <li
            key={i}
            className="flex items-start gap-2 font-mono text-[11px] text-red-900/90 dark:text-red-100/85"
          >
            {c.ok ? (
              <Check className="mt-0.5 h-3 w-3 shrink-0 text-emerald-500" aria-hidden />
            ) : (
              <CircleX className="mt-0.5 h-3 w-3 shrink-0 text-red-500" aria-hidden />
            )}
            <span className="min-w-0 break-words">
              <span className="font-sans font-medium">Example {i + 1}</span> · {c.input}
              {c.ok ? null : (
                <>
                  {' → '}
                  {c.error ? (
                    <span className="text-red-700 dark:text-red-300">raised {c.error}</span>
                  ) : (
                    <>
                      got <span className="text-red-700 dark:text-red-300">{c.actual}</span>,
                      expected{' '}
                      <span className="text-emerald-700 dark:text-emerald-300">{c.expected}</span>
                    </>
                  )}
                </>
              )}
            </span>
          </li>
        ))}
      </ul>
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
            className="inline-flex h-6 items-center gap-1 rounded-md border border-neutral-200 bg-white px-2 text-[10px] font-medium text-neutral-700 transition-colors hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-800 dark:bg-neutral-900/60 dark:text-neutral-200 dark:hover:bg-neutral-800"
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
