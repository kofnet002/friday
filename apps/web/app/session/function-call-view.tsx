'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AnswerProvider,
  ExtractedFunctionCall,
  FunctionCallSolveResponse,
  FunctionCallToolSpec,
} from '@friday/shared-types';
import { CircleCheck, CircleX, Copy, Loader2, RefreshCw, Wrench } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

const BACKEND_HTTP_URL = process.env.NEXT_PUBLIC_BACKEND_URL ?? 'http://127.0.0.1:8000';

type SolveStatus = 'idle' | 'solving' | 'done' | 'error';

interface FunctionCallViewProps {
  assessment: ExtractedFunctionCall;
  fingerprint: string;
  provider: AnswerProvider;
  sessionId: string;
  onDismiss: () => void;
}

/** Renders a detected (or hand-entered) function-calling assessment: the task,
 *  the available tools, and — once solved — the chosen tool + payload with the
 *  structural self-verify verdict. Self-contained: owns its own solve fetch so
 *  the session orchestrator only has to hand it an assessment. */
export function FunctionCallView({
  assessment,
  fingerprint,
  provider,
  sessionId,
  onDismiss,
}: FunctionCallViewProps) {
  const [status, setStatus] = useState<SolveStatus>('idle');
  const [result, setResult] = useState<FunctionCallSolveResponse | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // Guard against a stale response landing after the assessment changed
  // (a new detection arrives while the previous solve is in flight).
  const runIdRef = useRef(0);

  const tools = useMemo<FunctionCallToolSpec[]>(() => assessment.tools ?? [], [assessment.tools]);

  const solve = useCallback(async () => {
    if (!assessment.question) {
      setStatus('error');
      setErrorMessage('No task text was detected.');
      return;
    }
    if (tools.length === 0) {
      // The solver needs a catalog to pick from; without one there's nothing
      // to select. Surface it rather than firing a 422.
      setStatus('error');
      setErrorMessage('No tool catalog detected on screen — nothing to select from.');
      return;
    }
    const runId = ++runIdRef.current;
    setStatus('solving');
    setErrorMessage(null);
    try {
      const res = await fetch(`${BACKEND_HTTP_URL}/api/function-call/solve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          question: assessment.question,
          tools,
          provider,
          session_id: sessionId,
        }),
      });
      if (!res.ok) {
        const detail = await res.text();
        throw new Error(detail.slice(0, 300) || `HTTP ${res.status}`);
      }
      const data = (await res.json()) as FunctionCallSolveResponse;
      if (runId !== runIdRef.current) return; // superseded
      setResult(data);
      setStatus('done');
    } catch (err) {
      if (runId !== runIdRef.current) return;
      setErrorMessage(err instanceof Error ? err.message : String(err));
      setStatus('error');
    }
  }, [assessment.question, tools, provider, sessionId]);

  // Auto-solve when a new assessment arrives (keyed by fingerprint).
  useEffect(() => {
    setResult(null);
    void solve();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fingerprint]);

  const prediction = result?.prediction ?? null;
  const payloadJson = prediction ? JSON.stringify(prediction.arguments, null, 2) : '';

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-indigo-300 bg-indigo-50/50 p-3 dark:border-indigo-500/30 dark:bg-indigo-950/20">
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-semibold text-indigo-800 dark:text-indigo-200">
          <Wrench className="h-4 w-4 shrink-0" aria-hidden />
          <span>{assessment.title ?? 'Function-calling assessment'}</span>
          <ConfidenceBadge value={assessment.confidence} />
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="text-[11px] text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200"
        >
          Dismiss
        </button>
      </div>

      {/* Task */}
      {assessment.question ? (
        <p className="whitespace-pre-wrap text-xs leading-relaxed text-neutral-700 dark:text-neutral-300">
          {assessment.question}
        </p>
      ) : null}

      {/* Tool catalog */}
      {tools.length > 0 ? <ToolCatalog tools={tools} chosen={prediction?.tool ?? null} /> : null}

      {/* Answer + verify */}
      {status === 'solving' ? (
        <div className="flex items-center gap-2 text-xs text-neutral-500 dark:text-neutral-400">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          Selecting tool and building payload…
        </div>
      ) : null}

      {status === 'error' ? (
        <div className="flex items-center justify-between gap-2 rounded-lg border border-red-300 bg-red-50/70 px-3 py-2 text-xs text-red-800 dark:border-red-500/30 dark:bg-red-950/30 dark:text-red-200">
          <span className="min-w-0 break-words">Couldn&apos;t solve — {errorMessage}</span>
          <Button type="button" size="sm" variant="outline" onClick={() => void solve()}>
            Retry
          </Button>
        </div>
      ) : null}

      {status === 'done' && prediction ? (
        <div className="flex flex-col gap-2">
          <AnswerCard tool={prediction.tool} payloadJson={payloadJson} />
          {result ? <VerifyPanel result={result} /> : null}
          <div className="flex items-center justify-end gap-2">
            <Button type="button" size="sm" variant="outline" onClick={() => void solve()}>
              <RefreshCw className="mr-1 h-3.5 w-3.5" aria-hidden />
              Re-solve
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ConfidenceBadge({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  return (
    <span className="rounded-full bg-indigo-100 px-1.5 py-0.5 text-[10px] font-medium text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-300">
      {pct}% sure
    </span>
  );
}

function ToolCatalog({ tools, chosen }: { tools: FunctionCallToolSpec[]; chosen: string | null }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {tools.map((t) => {
        const isChosen = t.name === chosen;
        return (
          <span
            key={t.name}
            title={t.description ?? undefined}
            className={cn(
              'rounded-md border px-2 py-0.5 font-mono text-[11px]',
              isChosen
                ? 'border-indigo-400 bg-indigo-100 font-semibold text-indigo-800 dark:border-indigo-400/50 dark:bg-indigo-500/25 dark:text-indigo-100'
                : 'border-neutral-200 bg-white/60 text-neutral-600 dark:border-neutral-700 dark:bg-neutral-900/40 dark:text-neutral-400',
            )}
          >
            {t.name}
            {isChosen ? ' ✓' : ''}
          </span>
        );
      })}
    </div>
  );
}

function AnswerCard({ tool, payloadJson }: { tool: string | null; payloadJson: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(
        JSON.stringify({ tool, arguments: JSON.parse(payloadJson || '{}') }, null, 2),
      );
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      // clipboard blocked — no-op
    }
  };
  return (
    <div className="overflow-hidden rounded-lg border border-neutral-200 bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-900/60">
      <div className="flex items-center justify-between gap-2 border-b border-neutral-200 px-3 py-1.5 dark:border-neutral-800">
        <span className="text-[11px] uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
          Tool
        </span>
        <span className="flex items-center gap-2">
          <code className="font-mono text-xs font-semibold text-neutral-800 dark:text-neutral-100">
            {tool ?? '—'}
          </code>
          <button
            type="button"
            onClick={() => void copy()}
            className="text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200"
            title="Copy tool + payload"
          >
            <Copy className="h-3.5 w-3.5" aria-hidden />
          </button>
        </span>
      </div>
      <pre className="overflow-x-auto px-3 py-2 font-mono text-[11px] leading-relaxed text-neutral-800 dark:text-neutral-100">
        {payloadJson || '{}'}
      </pre>
      {copied ? (
        <div className="px-3 pb-1.5 text-[10px] text-emerald-600 dark:text-emerald-400">Copied</div>
      ) : null}
    </div>
  );
}

function VerifyPanel({ result }: { result: FunctionCallSolveResponse }) {
  const { check, grade } = result;

  return (
    <div className="flex flex-col gap-2">
      {/* Structural self-verify */}
      {!check.ran ? (
        <div className="rounded-lg border border-neutral-200 bg-neutral-50/60 px-3 py-2 text-[11px] text-neutral-500 dark:border-neutral-800 dark:bg-neutral-900/40 dark:text-neutral-400">
          Not verified — {check.skip_reason ?? 'no catalog to check against'}.
        </div>
      ) : check.ok ? (
        <div className="flex items-center gap-2 rounded-lg border border-emerald-300 bg-emerald-50/70 px-3 py-2 text-xs font-medium text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-950/30 dark:text-emerald-200">
          <CircleCheck className="h-4 w-4 shrink-0" aria-hidden />
          Valid — payload conforms to the tool&apos;s schema.
        </div>
      ) : (
        <div className="flex flex-col gap-1.5 rounded-lg border border-red-300 bg-red-50/70 p-3 dark:border-red-500/30 dark:bg-red-950/30">
          <span className="flex items-center gap-2 text-xs font-semibold text-red-800 dark:text-red-200">
            <CircleX className="h-4 w-4 shrink-0" aria-hidden />
            {check.checks.filter((c) => !c.ok).length} schema issue
            {check.checks.filter((c) => !c.ok).length === 1 ? '' : 's'} — review before submitting
          </span>
          <ul className="flex flex-col gap-1">
            {check.checks
              .filter((c) => !c.ok)
              .map((c, i) => (
                <li
                  key={i}
                  className="flex items-start gap-2 font-mono text-[11px] text-red-900/90 dark:text-red-100/85"
                >
                  <CircleX className="mt-0.5 h-3 w-3 shrink-0 text-red-500" aria-hidden />
                  <span className="min-w-0 break-words">
                    <span className="font-sans font-medium">{c.kind}</span> · {c.detail}
                  </span>
                </li>
              ))}
          </ul>
        </div>
      )}

      {/* Answer-key grade (practice mode only) */}
      {grade ? (
        <div
          className={cn(
            'flex items-center gap-2 rounded-lg border px-3 py-2 text-xs font-medium',
            grade.correct
              ? 'border-emerald-300 bg-emerald-50/70 text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-950/30 dark:text-emerald-200'
              : 'border-amber-300 bg-amber-50/70 text-amber-800 dark:border-amber-500/30 dark:bg-amber-950/30 dark:text-amber-200',
          )}
        >
          {grade.correct ? (
            <CircleCheck className="h-4 w-4 shrink-0" aria-hidden />
          ) : (
            <CircleX className="h-4 w-4 shrink-0" aria-hidden />
          )}
          {grade.correct
            ? 'Correct — matches the answer key.'
            : !grade.tool_match
              ? `Wrong tool — expected ${grade.expected_tool}.`
              : `Payload differs — ${grade.payload_diff ?? 'does not match the answer key'}.`}
        </div>
      ) : null}
    </div>
  );
}
