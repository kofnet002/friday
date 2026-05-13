'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import * as Popover from '@radix-ui/react-popover';
import type { AnswerProvider } from '@friday/shared-types';

import {
  Bot,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Copy,
  Eraser,
  Loader2,
  MoreHorizontal,
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
  onReask: () => void;
  onSubmitCustom: (question: string) => void;
  connected: boolean;
  privacyMode: boolean;
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
  onReask,
  onSubmitCustom,
  connected,
  privacyMode,
  entryIndex,
  entryCount,
  onPrev,
  onNext,
  transcriptSlot,
}: AnswerPanelProps) {
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

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = customPrompt.trim();
    if (!trimmed) return;
    onSubmitCustom(trimmed);
    setCustomPrompt('');
  };

  const isStreaming = status === 'streaming';
  const hasAnswer = Boolean(answer);

  const copyAnswer = async () => {
    if (!answer) return;
    try {
      await navigator.clipboard.writeText(answer);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = answer;
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
    setCopied(true);
    if (copyTimerRef.current) window.clearTimeout(copyTimerRef.current);
    copyTimerRef.current = window.setTimeout(() => setCopied(false), 1400);
  };

  return (
    // No outer card chrome — the surrounding popover already provides the
    // glass frame. Keep this transparent so we don't end up with nested
    // containers.
    <div className="flex h-full flex-col gap-4">
      <div className="flex items-center gap-2.5">
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
        <Select
          value={provider}
          onChange={(e) => onProviderChange(e.target.value as AnswerProvider)}
          className="ml-auto h-7 text-xs"
        >
          <option value="gemini">Gemini 2.5 Flash</option>
          <option value="openai">GPT-4o</option>
          <option value="deepseek">DeepSeek</option>
        </Select>

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
            className="flex h-6 w-6 items-center justify-center rounded text-neutral-600 transition-colors hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-40 dark:text-neutral-300 dark:hover:bg-neutral-800"
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
            className="flex h-6 w-6 items-center justify-center rounded text-neutral-600 transition-colors hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-40 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            <ChevronRight className="h-3.5 w-3.5" aria-hidden />
          </button>
        </div>
      </div>

      {/* The LLM now emits a `**💬 Question:**` line inside the answer body
          (see ANSWER_GENERATION_VERSION 1.1+), so the previous "Detected
          question" pill is suppressed to avoid showing the question twice.
          The `question` prop is still kept for accessibility / data flow. */}

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
          <div className="relative min-h-0 w-[30%] min-w-[13rem] max-w-[22rem] shrink-0 overflow-hidden rounded-xl border border-neutral-200/70 bg-white/40 dark:border-neutral-800/70 dark:bg-neutral-900/30">
            <div className="pointer-events-none absolute left-3 top-2 z-10 inline-flex items-center gap-1 rounded-md bg-white/90 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-neutral-500 shadow-sm backdrop-blur dark:bg-neutral-900/90 dark:text-neutral-400">
              Transcript
            </div>
            <div className="h-full overflow-hidden">{transcriptSlot}</div>
          </div>
          <div className="flex min-h-0 flex-1 flex-col">
            <AnswerBody
              answer={answer}
              question={question}
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
          isStreaming={isStreaming}
          marked={marked}
          privacyMode={privacyMode}
        />
      )}

      {privacyMode ? (
        <div className="rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2 text-xs text-neutral-600 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-300">
          Stealth mode is on. Answer content is masked in this window.
        </div>
      ) : null}

      <form onSubmit={handleSubmit} className="flex items-center gap-2">
        <Input
          value={customPrompt}
          onChange={(e) => setCustomPrompt(e.target.value)}
          placeholder="Ask the copilot directly…"
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
          <Button type="submit" disabled={!customPrompt.trim() || !connected} aria-label="Send">
            <Send className="mr-1 h-3.5 w-3.5" aria-hidden />
            Send
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

function AnswerBody({
  answer,
  question,
  isStreaming,
  marked,
  privacyMode,
}: {
  answer: string;
  question: string | null;
  isStreaming: boolean;
  marked: boolean;
  privacyMode: boolean;
}) {
  return (
    <div
      className={cn(
        // Transparent answer body — no nested card chrome. Vertical
        // padding only; the popover's frame handles the rest.
        'min-h-[200px] flex-1 overflow-y-auto py-1 transition-opacity',
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
        'disabled:cursor-not-allowed disabled:opacity-40',
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
