'use client';

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import * as Popover from '@radix-ui/react-popover';
import type { AnswerMessage, AnswerProvider, QdModel, QdState } from '@friday/shared-types';

import { ALL_QD_MODELS } from '@/lib/session-context';

import {
  Bot,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Code2,
  Copy,
  CornerDownLeft,
  Eraser,
  Loader2,
  Maximize2,
  Minimize2,
  MoreHorizontal,
  Play,
  RotateCcw,
  Send,
  Sparkles,
  Square,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { friendlyError } from '@/lib/error-messages';
import { Markdown } from '@/lib/markdown';
import { asQuestionBlocks, extractQuestionAnswers } from '@/lib/question-answers';
import { isScreenQuestionPrompt } from '@/lib/screen-question-routing';
import { cn } from '@/lib/utils';

export type AnswerStatus = 'idle' | 'streaming' | 'done' | 'cancelled' | 'error';

export interface AnswerPanelProps {
  provider: AnswerProvider;
  onProviderChange: (p: AnswerProvider) => void;
  /** Model used for question detection (silence + ceiling + speaker-turn).
   *  User-selectable so they own the cost/quality tradeoff now that
   *  detection fires more often. */
  qdModel: QdModel;
  onQdModelChange: (m: QdModel) => void;
  /** Audio minutes used against this session's cap; null until known. */
  audioUsage?: AudioUsage | null;
  /** Lifecycle state of the per-session question detector. Drives the
   *  status dot next to the connection pill. */
  qdState: QdState;
  /** Non-null when the backend has fallen back from Gemini to GPT-4o for
   *  QD (e.g. due to a 429). Surfaces a small badge next to the QD model
   *  dropdown so the user knows their pick is being overridden. */
  qdFallbackModel: string | null;
  /** Non-null when QD has stopped because both providers are unavailable.
   *  Renders a critical badge so the user knows detection has paused. */
  qdError: string | null;
  /** Timestamp (Date.now()) of the most recent dedup signal — used to
   *  flash a subtle "heard it" pulse on the status pill without spawning
   *  a new entry. 0 means never. */
  qdDedupAt: number;
  question: string | null;
  answer: string;
  /** Full thread for the current entry, oldest first. Used to render
   *  multi-turn conversation history above the streaming answer. */
  messages: AnswerMessage[];
  status: AnswerStatus;
  error: string | null;
  marked: boolean;
  onMarkAnswered: () => void;
  onCancel: () => void;
  onClear: () => void;
  onReask: () => void;
  onSubmitCustom: (question: string) => void;
  /** Append a user turn to the current thread and stream the next answer.
   *  Different from onSubmitCustom which always starts a new thread. */
  onFollowUp: (question: string) => void;
  connected: boolean;
  privacyMode: boolean;
  /** True while the capture session is live (recording or paused). When
   *  false the panel shows a Start CTA instead of silently doing nothing —
   *  opening AI Help no longer starts listening on its own. */
  listening: boolean;
  /** True during the WS / Deepgram handshake, so the CTA can show progress
   *  instead of inviting a second click. */
  starting: boolean;
  /** Begins the capture session. Wired to the Start button. */
  onStart: () => void;
  /** 1-based position of the displayed entry; 0 when there are no entries. */
  entryIndex: number;
  /** Total number of in-memory Q&A entries this session. */
  entryCount: number;
  onPrev: () => void;
  onNext: () => void;
  /**
   * When provided, renders alongside the answer body in a 2-column split
   * (transcript on the left, answer on the right). Used by the Listen
   * feature to keep the live transcript visible while the candidate reads
   * the streamed answer.
   */
  transcriptSlot?: ReactNode;
  /** 'screen' renders answers to on-screen questions inside the Screen tab:
   *  just the pager, answer and follow-ups — no listening chrome (model and
   *  detection pickers, connection pills, Start CTA). */
  variant?: 'listen' | 'screen';
}

export function AnswerPanel({
  provider,
  onProviderChange,
  qdModel,
  onQdModelChange,
  audioUsage = null,
  qdState,
  qdFallbackModel,
  qdError,
  qdDedupAt,
  question,
  answer,
  messages,
  status,
  error,
  marked,
  onMarkAnswered,
  onCancel,
  onClear,
  onReask,
  onSubmitCustom,
  onFollowUp,
  connected,
  privacyMode,
  listening,
  starting,
  onStart,
  entryIndex,
  entryCount,
  onPrev,
  onNext,
  transcriptSlot,
  variant = 'listen',
}: AnswerPanelProps) {
  const isScreen = variant === 'screen';
  const [customPrompt, setCustomPrompt] = useState('');
  const [copied, setCopied] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const copyTimerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (copyTimerRef.current) window.clearTimeout(copyTimerRef.current);
    },
    [],
  );

  const isStreaming = status === 'streaming';
  const hasAnswer = Boolean(answer);
  // Follow-up mode kicks in once the current entry has accrued at least one
  // completed assistant turn — the submit button becomes "Follow up" and
  // routes through onFollowUp (append to thread) instead of onSubmitCustom
  // (start a new thread). hasAnswer alone is enough because the streaming
  // turn's content lives in `answer` from the first token onward.
  const isFollowUpMode = hasAnswer;

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = customPrompt.trim();
    if (!trimmed) return;
    if (isFollowUpMode) {
      onFollowUp(trimmed);
    } else {
      onSubmitCustom(trimmed);
    }
    setCustomPrompt('');
  };

  // Reaction shortcuts — pre-filled follow-up prompts. Kept short so the
  // model treats them as instructions rather than questions; the system
  // prompt's existing format rules take care of structure.
  const reactions: { label: string; icon: ReactNode; prompt: string }[] = [
    {
      label: 'Shorter',
      icon: <Minimize2 className="h-3 w-3" aria-hidden />,
      prompt: 'Make that shorter and tighter — keep only the most important points.',
    },
    {
      label: 'More detail',
      icon: <Maximize2 className="h-3 w-3" aria-hidden />,
      prompt: 'Give me more detail — expand each point with specifics, examples, and tradeoffs.',
    },
    {
      label: 'Code example',
      icon: <Code2 className="h-3 w-3" aria-hidden />,
      prompt: 'Show a concrete code example illustrating the answer.',
    },
  ];

  const copyAnswer = async () => {
    if (!answer) return;
    await copyText(answer);
    setCopied(true);
    if (copyTimerRef.current) window.clearTimeout(copyTimerRef.current);
    copyTimerRef.current = window.setTimeout(() => setCopied(false), 1400);
  };

  return (
    // No outer card chrome — the surrounding popover already provides the
    // glass frame. Keep this transparent so we don't end up with nested
    // containers.
    <div className={cn('flex flex-col gap-4', !isScreen && 'h-full')}>
      {/* In privacyMode the entire header bar collapses: no Copilot badge,
          no connection / QD / fallback / error indicators, no model
          selectors, no history pager. An over-the-shoulder observer
          should see nothing that hints at AI assistance. */}
      {!privacyMode ? (
        <div
          className={cn(
            'flex items-center gap-2.5',
            // In the Screen tab the answer grows with the tab's own scroll;
            // the pager stays pinned so navigation is always reachable.
            isScreen && 'sticky top-0 z-10 -my-1 bg-white py-1 dark:bg-neutral-900',
          )}
        >
          {isScreen ? (
            <span className="mr-auto text-xs font-semibold uppercase tracking-[0.18em] text-sky-600 dark:text-sky-400">
              Screen answers
            </span>
          ) : (
            <>
              <span
                className="flex items-center gap-1.5 rounded-md bg-sky-100/70 px-2 py-1 text-sm font-semibold text-sky-700 dark:bg-sky-950/40 dark:text-sky-300"
                aria-label="Copilot"
              >
                <Bot className="h-4 w-4" aria-hidden />
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
              <QdStatePill state={qdState} dedupAt={qdDedupAt} error={qdError} />
              {audioUsage ? <AudioBudgetPill usage={audioUsage} /> : null}
              <div className="ml-auto flex items-center gap-1.5">
                <Select
                  value={qdModel}
                  onChange={(e) => onQdModelChange(e.target.value as QdModel)}
                  className="h-7 text-xs"
                  title="Model used to detect questions in the live transcript. Claude options use your Anthropic API key when set; otherwise they run on your Claude Code subscription, which adds a few seconds per detection."
                  aria-label="Question detection model"
                >
                  {ALL_QD_MODELS.map((m) => (
                    <option key={m} value={m}>
                      QD: {qdModelLabel(m)}
                    </option>
                  ))}
                </Select>
                {qdError ? <QdErrorBadge reason={qdError} /> : null}
                {qdFallbackModel && !qdError ? <QdFallbackBadge model={qdFallbackModel} /> : null}
              </div>
              <Select
                value={provider}
                onChange={(e) => onProviderChange(e.target.value as AnswerProvider)}
                className="h-7 text-xs"
              >
                <option value="gemini">Gemini 2.5 Flash</option>
                <option value="openai">GPT-4o</option>
                <option value="deepseek">DeepSeek</option>
                <option value="claude">Claude Sonnet 5.5</option>
              </Select>
            </>
          )}

          {/* History pager — chevrons step through every Q&A asked this
            session (auto-detect or force-ask), so a new question never
            stomps an older answer. Disabled at the boundaries. */}
          <div
            className="flex items-center gap-0.5 rounded-md border border-neutral-200 bg-white/70 p-0.5 dark:border-neutral-800 dark:bg-neutral-900/70"
            role="group"
            aria-label="Answer history"
          >
            <button
              type="button"
              onClick={onPrev}
              disabled={entryCount === 0 || entryIndex <= 1}
              aria-label="Previous answer"
              title="Previous answer"
              className="flex h-6 w-6 items-center justify-center rounded text-neutral-600 transition-colors hover:bg-neutral-100 disabled:opacity-40 dark:text-neutral-300 dark:hover:bg-neutral-800"
            >
              <ChevronLeft className="h-3.5 w-3.5" aria-hidden />
            </button>
            <span
              className="min-w-[2.5rem] text-center font-mono text-[10px] tabular-nums text-neutral-600 dark:text-neutral-400"
              aria-live="polite"
            >
              {entryCount === 0 ? '0/0' : `${entryIndex}/${entryCount}`}
            </span>
            <button
              type="button"
              onClick={onNext}
              disabled={entryCount === 0 || entryIndex >= entryCount}
              aria-label="Next answer"
              title="Next answer"
              className="flex h-6 w-6 items-center justify-center rounded text-neutral-600 transition-colors hover:bg-neutral-100 disabled:opacity-40 dark:text-neutral-300 dark:hover:bg-neutral-800"
            >
              <ChevronRight className="h-3.5 w-3.5" aria-hidden />
            </button>
          </div>
        </div>
      ) : null}

      {/* The LLM now emits a `**💬 Question:**` line inside the answer body
          (see ANSWER_GENERATION_VERSION 1.1+), so the previous "Detected
          question" pill is suppressed to avoid showing the question twice.
          The `question` prop is still kept for accessibility / data flow. */}

      {/* Start CTA. Opening this panel used to call start() as a side effect,
          which meant the mic went live the moment the user peeked at the
          panel. Now starting is an explicit act. Hidden once live so the
          panel reads the same as before mid-session. */}
      {!listening && !isScreen ? (
        <StartListeningCta
          starting={starting}
          onStart={onStart}
          audioSpent={!!audioUsage && audioUsage.used >= audioUsage.limit}
          audioLimit={audioUsage?.limit ?? 0}
        />
      ) : null}

      {/* Error banner hidden in privacyMode — error text could itself leak
          context (provider names, model names, quota details) to a viewer. */}
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

      {/* Body. With transcriptSlot present we run a 2-column split:
          transcript on the left, answer on the right. Both scroll
          independently so a long answer doesn't push the transcript off
          screen and vice-versa. Without transcriptSlot we keep the
          original single-column layout. */}
      {transcriptSlot ? (
        // Always-row layout. The Listen popover defaults to ~50rem so
        // there's room for both columns; below ~480px the column shrinks
        // toward the transcript's min-width, which is fine on the very
        // narrow widths the user can resize down to.
        <div className="flex min-h-0 flex-1 flex-row gap-4">
          <div className="flex min-h-0 w-[30%] min-w-[13rem] max-w-[22rem] shrink-0 flex-col overflow-hidden rounded-xl border border-neutral-200/70 bg-white/40 dark:border-neutral-800/70 dark:bg-neutral-900/30">
            {/* In-flow header — the old floating pill sat on top of the
                first transcript line. */}
            <div className="shrink-0 border-b border-neutral-200/60 px-3 py-2 text-[11px] font-medium text-neutral-500 dark:border-neutral-800/60 dark:text-neutral-400">
              Transcript
            </div>
            <div className="min-h-0 flex-1 overflow-hidden">{transcriptSlot}</div>
          </div>
          <div className="flex min-h-0 flex-1 flex-col">
            <AnswerBody
              answer={answer}
              question={question}
              messages={messages}
              isStreaming={isStreaming}
              marked={marked}
              privacyMode={privacyMode}
            />
          </div>
        </div>
      ) : (
        <AnswerBody
          answer={answer}
          question={question}
          messages={messages}
          isStreaming={isStreaming}
          marked={marked}
          privacyMode={privacyMode}
          screen={isScreen}
        />
      )}

      {privacyMode ? (
        <div className="rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2 text-xs text-neutral-600 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-300">
          Stealth mode is on. Answer content is masked in this window.
        </div>
      ) : null}

      {/* Reaction shortcuts — visible once the thread has at least one answer
          and isn't actively streaming. Each one fires a pre-filled follow-up
          so the candidate can shape the answer without typing. */}
      {isFollowUpMode && !isStreaming ? (
        <div className="-mb-2 flex items-center gap-1.5 text-[11px] text-neutral-500 dark:text-neutral-400">
          <span className="text-[10px] uppercase tracking-wider opacity-70">React:</span>
          {reactions.map((r) => (
            <button
              key={r.label}
              type="button"
              onClick={() => onFollowUp(r.prompt)}
              disabled={!connected}
              className={cn(
                'inline-flex items-center gap-1 rounded-full border border-neutral-200 bg-white/70 px-2 py-0.5 transition-colors hover:border-sky-400 hover:bg-sky-50 hover:text-sky-700',
                'dark:border-neutral-800 dark:bg-neutral-900/60 dark:hover:border-sky-500/60 dark:hover:bg-sky-950/40 dark:hover:text-sky-300',
                'disabled:opacity-50',
              )}
              title={r.prompt}
            >
              {r.icon}
              <span>{r.label}</span>
            </button>
          ))}
        </div>
      ) : null}

      <form onSubmit={handleSubmit} className="flex items-center gap-2">
        <Input
          value={customPrompt}
          onChange={(e) => setCustomPrompt(e.target.value)}
          placeholder={isFollowUpMode ? 'Follow up…' : 'Ask the copilot directly…'}
          className="flex-1"
          disabled={isStreaming}
        />

        {/* Primary action: Send → Cancel during streaming. Re-ask is in the
            overflow menu so the primary button doesn't change text mid-flow. */}
        {isStreaming ? (
          <Button type="button" variant="outline" onClick={onCancel} aria-label="Cancel">
            <Square className="mr-1 h-3.5 w-3.5" aria-hidden />
            Cancel
          </Button>
        ) : (
          <Button
            type="submit"
            disabled={!customPrompt.trim() || !connected}
            aria-label={isFollowUpMode ? 'Follow up' : 'Send'}
          >
            {isFollowUpMode ? (
              <CornerDownLeft className="mr-1 h-3.5 w-3.5" aria-hidden />
            ) : (
              <Send className="mr-1 h-3.5 w-3.5" aria-hidden />
            )}
            {isFollowUpMode ? 'Follow up' : 'Send'}
          </Button>
        )}

        {/* Overflow menu — copy / re-ask / mark / clear, surfaced only when
            there's something to act on. Keeps the footer to two visible
            controls (input + primary) regardless of state. */}
        {hasAnswer || question ? (
          <Popover.Root open={menuOpen} onOpenChange={setMenuOpen}>
            <Popover.Trigger asChild>
              <Button
                type="button"
                variant="outline"
                size="sm"
                aria-label="More actions"
                title="More actions"
                className="!px-2"
              >
                <MoreHorizontal className="h-4 w-4" aria-hidden />
              </Button>
            </Popover.Trigger>
            <Popover.Portal>
              <Popover.Content
                align="end"
                sideOffset={6}
                data-interactive="true"
                className={cn(
                  'pointer-events-auto z-[60] w-52 rounded-lg border border-neutral-200 bg-white p-1 shadow-lg',
                  'dark:border-neutral-800 dark:bg-neutral-900',
                  'data-[state=open]:animate-in data-[state=closed]:animate-out',
                  'data-[state=open]:fade-in data-[state=closed]:fade-out duration-100',
                )}
              >
                <MenuItem
                  icon={
                    copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />
                  }
                  label={copied ? 'Copied' : 'Copy answer'}
                  onClick={() => {
                    void copyAnswer();
                  }}
                  disabled={!hasAnswer || isStreaming}
                />
                <MenuItem
                  icon={<RotateCcw className="h-3.5 w-3.5" />}
                  label="Re-ask question"
                  onClick={() => {
                    setMenuOpen(false);
                    onReask();
                  }}
                  disabled={!question || isStreaming}
                />
                <MenuItem
                  icon={
                    marked ? (
                      <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                    ) : (
                      <CheckCircle2 className="h-3.5 w-3.5" />
                    )
                  }
                  label={marked ? 'Unmark answered' : 'Mark as answered'}
                  onClick={() => {
                    setMenuOpen(false);
                    onMarkAnswered();
                  }}
                  disabled={!hasAnswer || isStreaming}
                  active={marked}
                />
                <MenuItem
                  icon={<Eraser className="h-3.5 w-3.5" />}
                  label="Clear"
                  onClick={() => {
                    setMenuOpen(false);
                    onClear();
                  }}
                  disabled={!hasAnswer}
                  destructive
                />
              </Popover.Content>
            </Popover.Portal>
          </Popover.Root>
        ) : null}
      </form>
    </div>
  );
}

// Within this many px of the bottom counts as "following the stream".
const ANSWER_PIN_THRESHOLD_PX = 48;

function AnswerBody({
  answer,
  question,
  messages,
  isStreaming,
  marked,
  privacyMode,
  screen = false,
}: {
  answer: string;
  question: string | null;
  messages: AnswerMessage[];
  isStreaming: boolean;
  marked: boolean;
  privacyMode: boolean;
  /** Screen tab: grow with the content instead of scrolling inside (the tab
   *  already scrolls, so there's one scrollbar, not two), and show the
   *  thread's answers as one list of "Q<n> · …" blocks. */
  screen?: boolean;
}) {
  // Prior turns to show above the current streaming/finished answer. We
  // skip:
  //   - the very first user turn (already implied by the body — the LLM's
  //     `**💬 Question:**` block restates it)
  //   - the trailing assistant turn (that's what `answer` renders as)
  // Anything in between is real conversation history that should be visible.
  const priorTurns = messages.slice(1, -1);

  // Keep the newest streamed text in view. Follows the bottom while
  // "pinned"; scrolling up to re-read unpins (so tokens don't yank the view
  // away), scrolling back near the bottom re-pins, and every new question or
  // follow-up re-pins.
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const turnKey = `${question ?? ''}|${messages.length}`;

  useLayoutEffect(() => {
    pinnedRef.current = true;
  }, [turnKey]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [answer, turnKey, isStreaming]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= ANSWER_PIN_THRESHOLD_PX;
  };

  // Per-question answers from a grouped screen answer (all turns of the
  // thread), for per-heading / one-key copy.
  // Later questions of a scan come back in the single-question layout; the
  // Screen tab rewrites them to match the scan's "Q<n> · …" blocks.
  const shown = (text: string) => (screen ? asQuestionBlocks(text) : text);
  const assistantTexts = [
    ...messages
      .slice(0, -1)
      .filter((m) => m.role === 'assistant')
      .map((m) => m.content),
    answer,
  ].map(shown);
  const questionAnswers = extractQuestionAnswers(assistantTexts);
  const { copiedLabel, copyQuestion } = useQuestionCopy(questionAnswers, !privacyMode);
  // A copy icon on each "Q<n> · …" heading copies that question's answer.
  const questionAction = privacyMode
    ? undefined
    : (label: string) => {
        const qa = questionAnswers.find((q) => q.label === label);
        return qa ? (
          <QuestionCopyButton
            qa={qa}
            copied={copiedLabel === label}
            onCopy={() => void copyQuestion(label)}
          />
        ) : null;
      };

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      className={cn(
        // Transparent answer body — no nested card chrome. Vertical
        // padding only; the popover's frame handles the rest.
        'py-1 transition-opacity',
        !screen && 'min-h-[200px] flex-1 overflow-y-auto',
        marked && 'opacity-50',
        privacyMode && 'select-none blur-md',
      )}
    >
      {priorTurns.length > 0 ? (
        <div
          className={cn(
            'flex flex-col gap-3',
            !screen && 'mb-4 border-b border-neutral-200/70 pb-3 dark:border-neutral-800/70',
          )}
        >
          {priorTurns.map((turn, i) => (
            <ThreadTurn key={i} turn={turn} questionAction={questionAction} flat={screen} />
          ))}
        </div>
      ) : null}

      {answer ? (
        <Markdown
          text={shown(answer) + (isStreaming ? ' ▍' : '')}
          questionAction={questionAction}
        />
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
  );
}

type QuestionAnswer = { label: string; answer: string; check: boolean };

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
    } catch {
      /* swallow */
    }
    document.body.removeChild(ta);
  }
}

/** Copies one question's answer by label, and binds keys 1–9 to Q1–Q9
 *  while you're not typing somewhere. `copiedLabel` is set for ~1.4s. */
function useQuestionCopy(questionAnswers: QuestionAnswer[], enabled: boolean) {
  const [copiedLabel, setCopiedLabel] = useState<string | null>(null);
  const answersRef = useRef(questionAnswers);
  answersRef.current = questionAnswers;
  const timerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
    },
    [],
  );

  const copyQuestion = async (label: string) => {
    const qa = answersRef.current.find((q) => q.label === label);
    if (!qa) return;
    await copyText(qa.answer);
    setCopiedLabel(label);
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => setCopiedLabel(null), 1400);
  };
  const copyRef = useRef(copyQuestion);
  copyRef.current = copyQuestion;

  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
      ) {
        return;
      }
      if (!/^[1-9]$/.test(event.key)) return;
      const label = `Q${event.key}`;
      if (!answersRef.current.some((qa) => qa.label === label)) return;
      event.preventDefault();
      void copyRef.current(label);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [enabled]);

  return { copiedLabel, copyQuestion };
}

function QuestionCopyButton({
  qa,
  copied,
  onCopy,
}: {
  qa: QuestionAnswer;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <span className="ml-1.5 inline-flex items-center gap-1 align-[-3px]">
      <button
        type="button"
        onClick={onCopy}
        aria-label={`Copy ${qa.label} answer`}
        title={
          copied
            ? 'Copied'
            : `Copy ${qa.label}: ${qa.answer}${qa.check ? ' (double-check)' : ''} — press ${qa.label.slice(1)}`
        }
        className={cn(
          'inline-flex h-5 w-5 items-center justify-center rounded transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500',
          copied
            ? 'text-emerald-600 dark:text-emerald-400'
            : 'text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 dark:text-neutral-500 dark:hover:bg-neutral-800 dark:hover:text-neutral-200',
        )}
      >
        {copied ? (
          <Check className="h-3.5 w-3.5" aria-hidden />
        ) : (
          <Copy className="h-3.5 w-3.5" aria-hidden />
        )}
      </button>
      {qa.check ? (
        <span role="img" aria-label="double-check" title="Double-check this one">
          ⚠️
        </span>
      ) : null}
    </span>
  );
}

function ThreadTurn({
  turn,
  questionAction,
  flat = false,
}: {
  turn: AnswerMessage;
  questionAction?: (label: string) => ReactNode;
  /** Screen tab: later questions continue the list — no divider, no card. */
  flat?: boolean;
}) {
  if (turn.role === 'user' && isScreenQuestionPrompt(turn.content)) {
    if (flat) return null;
    return (
      <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wider text-sky-700 dark:text-sky-300">
        More questions from the screen
      </div>
    );
  }
  if (turn.role === 'user') {
    return (
      <div className="flex items-start gap-2">
        <span className="rounded-md bg-sky-100/70 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-sky-700 dark:bg-sky-950/40 dark:text-sky-300">
          You
        </span>
        <p className="flex-1 text-sm text-neutral-700 dark:text-neutral-200">{turn.content}</p>
      </div>
    );
  }
  if (flat) {
    return <Markdown text={asQuestionBlocks(turn.content)} questionAction={questionAction} />;
  }
  return (
    <div className="rounded-lg bg-neutral-100/60 p-2.5 dark:bg-neutral-900/40">
      <Markdown text={turn.content} questionAction={questionAction} />
    </div>
  );
}

function MenuItem({
  icon,
  label,
  onClick,
  disabled,
  active,
  destructive,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  destructive?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors',
        'disabled:opacity-40',
        !disabled && !destructive && 'hover:bg-neutral-100 dark:hover:bg-neutral-800',
        !disabled &&
          destructive &&
          'text-red-700 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40',
        active && 'text-emerald-700 dark:text-emerald-400',
      )}
    >
      <span className="text-neutral-500 dark:text-neutral-400" aria-hidden>
        {icon}
      </span>
      {label}
    </button>
  );
}

function StartListeningCta({
  starting,
  onStart,
  audioSpent,
  audioLimit,
}: {
  starting: boolean;
  onStart: () => void;
  /** The session's audio budget is used up; starting would capture nothing. */
  audioSpent: boolean;
  audioLimit: number;
}) {
  if (audioSpent) {
    return (
      <div
        role="alert"
        className="flex items-center gap-3 rounded-xl border border-red-400/50 bg-red-50 px-3 py-2.5 dark:border-red-500/30 dark:bg-red-950/40"
      >
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-red-700 dark:text-red-300">
            Audio limit reached for this session
          </p>
          <p className="mt-0.5 text-xs text-red-700/80 dark:text-red-300/80">
            All {Math.round(audioLimit)} minutes are used, so nothing more can be transcribed. Start
            a new session from Setup, or raise SESSION_AUDIO_MINUTE_LIMIT.
          </p>
        </div>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-3 rounded-xl border border-neutral-200/80 bg-white/50 px-3 py-2.5 dark:border-neutral-800 dark:bg-neutral-900/40">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-neutral-800 dark:text-neutral-100">
          {starting ? 'Starting…' : 'Not listening yet'}
        </p>
        <p className="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">
          {starting
            ? 'Connecting the transcription stream.'
            : 'Start to transcribe the conversation and auto-detect questions.'}
        </p>
      </div>
      <Button
        type="button"
        size="sm"
        onClick={onStart}
        disabled={starting}
        aria-label="Start listening"
      >
        {starting ? (
          <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" aria-hidden />
        ) : (
          <Play className="mr-1 h-3.5 w-3.5" aria-hidden />
        )}
        {starting ? 'Starting' : 'Start'}
      </Button>
    </div>
  );
}

function qdModelLabel(model: QdModel): string {
  switch (model) {
    case 'gemini-2.5-flash-lite':
      return 'Flash-Lite';
    case 'gemini-2.5-flash':
      return 'Flash';
    case 'gemini-2.5-pro':
      return 'Pro';
    case 'gpt-4o-mini':
      return '4o-mini';
    case 'gpt-4o':
      return '4o';
    case 'claude-haiku-4-5':
      return 'Haiku 4.5';
    case 'claude-opus-5-5':
      return 'Opus 5.5';
  }
}

function QdFallbackBadge({ model }: { model: string }) {
  return (
    <span
      className="inline-flex items-center rounded-full bg-amber-500/15 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-amber-700 dark:text-amber-400"
      title={`Gemini was rate-limited — question detection fell back to ${model}. Pick a model again to retry Gemini.`}
      role="status"
      aria-label={`Question detection fell back to ${model}`}
    >
      → {model}
    </span>
  );
}

export interface AudioUsage {
  used: number; // minutes
  limit: number; // minutes
}

/** Session audio used vs the per-session cap, as a small bar. Turns amber
 *  past 75% and red past 90%, so the cap never arrives as a surprise. */
export function AudioBudgetPill({ usage }: { usage: AudioUsage }) {
  const ratio = usage.limit > 0 ? Math.min(usage.used / usage.limit, 1) : 0;
  const left = Math.max(usage.limit - usage.used, 0);
  const tone =
    ratio >= 0.9
      ? 'bg-red-500/15 text-red-700 dark:text-red-400'
      : ratio >= 0.75
        ? 'bg-amber-500/15 text-amber-700 dark:text-amber-400'
        : 'bg-black/5 text-neutral-600 dark:bg-white/5 dark:text-neutral-300';
  const bar = ratio >= 0.9 ? 'bg-red-500' : ratio >= 0.75 ? 'bg-amber-500' : 'bg-emerald-500';
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 font-mono text-[10px]',
        tone,
      )}
      title={`Session audio: ${usage.used.toFixed(1)} of ${usage.limit.toFixed(0)} min used, ${left.toFixed(1)} min left. Each session has its own budget (SESSION_AUDIO_MINUTE_LIMIT); start a new session from Setup for a fresh one.`}
      role="meter"
      aria-label="Session audio used"
      aria-valuemin={0}
      aria-valuemax={usage.limit}
      aria-valuenow={Math.min(usage.used, usage.limit)}
    >
      <span className="h-1 w-10 overflow-hidden rounded-full bg-black/10 dark:bg-white/10">
        <span className={cn('block h-full', bar)} style={{ width: `${ratio * 100}%` }} />
      </span>
      {Math.floor(usage.used)}/{Math.round(usage.limit)} min
    </span>
  );
}

function QdErrorBadge({ reason }: { reason: string }) {
  // Both providers unavailable — QD has effectively stopped. Surfaced as
  // critical so the user can take action (pick a different model, wait
  // for quota to reset, or fall back to ⌘⇧Space for manual asks).
  const label =
    reason === 'both_providers_unavailable'
      ? 'QD paused — pick another model'
      : reason === 'call_failed'
        ? 'QD model failed — check its key or pick another'
        : `QD paused — ${reason}`;
  return (
    <span
      className="inline-flex items-center rounded-full bg-red-500/15 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-red-700 dark:text-red-400"
      title={`Auto question-detection is paused (${reason}). Use ⌘⇧Space to ask manually, or pick a different QD model.`}
      role="status"
      aria-live="assertive"
    >
      ⚠ {label}
    </span>
  );
}

function QdStatePill({
  state,
  dedupAt,
  error,
}: {
  state: QdState;
  dedupAt: number;
  error: string | null;
}) {
  // Briefly flash a "heard it" pulse when the backend deduped a question.
  // Lets the user know the detector is alive without spawning an entry.
  const [showDedup, setShowDedup] = useState(false);
  useEffect(() => {
    if (!dedupAt) return;
    setShowDedup(true);
    const t = window.setTimeout(() => setShowDedup(false), 1400);
    return () => window.clearTimeout(t);
  }, [dedupAt]);

  // Error state suppresses the normal pill (the error badge tells the
  // story). Idle + no recent dedup = silent.
  if (error) return null;
  if (state === 'idle' && !showDedup) return null;

  if (showDedup) {
    return (
      <span
        className="flex items-center gap-1.5 rounded-full bg-purple-500/15 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-purple-700 dark:text-purple-400"
        title="Heard a question we already answered — skipped"
      >
        <span className="h-1.5 w-1.5 rounded-full bg-purple-500" />
        heard it
      </span>
    );
  }

  const isDetecting = state === 'detecting';
  return (
    <span
      className={cn(
        'flex items-center gap-1.5 rounded-full px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider',
        isDetecting
          ? 'bg-amber-500/15 text-amber-700 dark:text-amber-400'
          : 'bg-sky-500/15 text-sky-700 dark:text-sky-400',
      )}
      title={
        isDetecting
          ? 'Analyzing the recent transcript for a question'
          : 'Listening — a question may be forming'
      }
      // aria-live="off" deliberately: state cycles frequently and was
      // generating dozens of screen-reader announcements per session.
      // The badge is purely visual; users who need an alert see the
      // QdErrorBadge (assertive) or QdFallbackBadge (status).
    >
      <span
        className={cn(
          'h-1.5 w-1.5 rounded-full',
          isDetecting ? 'animate-pulse bg-amber-500' : 'bg-sky-500',
        )}
      />
      {isDetecting ? 'analyzing' : 'listening'}
    </span>
  );
}
