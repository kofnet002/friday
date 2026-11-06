'use client';

import { CheckCircle2, CircleX, Loader2, Play, RotateCcw, Send } from 'lucide-react';
import { useState } from 'react';

import { CodeEditor } from './code-editor';
import { formatValue, judge, type CaseVerdict } from './grading';
import { LANGUAGES, type CodingQuestion, type Language } from './types';
import { runCases } from './runner';
import { SAMPLE_COUNT } from './test-cases';

export interface Submission {
  passed: number;
  total: number;
}

interface CodingWorkspaceProps {
  question: CodingQuestion;
  language: Language;
  code: string;
  onLanguage: (language: Language) => void;
  onCode: (code: string) => void;
  onSubmitted: (submission: Submission) => void;
}

type Outcome =
  | { mode: 'run'; verdicts: CaseVerdict[] }
  | { mode: 'submit'; samples: CaseVerdict[]; hidden: CaseVerdict[] };

function Verdict({
  verdict,
  index,
  params,
}: {
  verdict: CaseVerdict;
  index: number;
  params: string[];
}) {
  const { result } = verdict;
  return (
    <details open={!verdict.passed} className="rounded-md border border-white/10 bg-white/[0.03]">
      <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 text-[13px]">
        {verdict.passed ? (
          <CheckCircle2 className="h-4 w-4 text-emerald-400" />
        ) : (
          <CircleX className="h-4 w-4 text-rose-400" />
        )}
        <span className="text-slate-200">Case {index + 1}</span>
        <span className="ml-auto font-mono text-[11px] text-slate-500">
          {result.ms.toFixed(1)} ms
        </span>
      </summary>
      <dl className="space-y-1.5 border-t border-white/10 px-3 py-2 font-mono text-[12px]">
        <div>
          <dt className="text-slate-500">Input</dt>
          <dd className="break-all text-slate-200">
            {params.map((p, i) => `${p} = ${formatValue(verdict.args[i])}`).join(', ')}
          </dd>
        </div>
        <div>
          <dt className="text-slate-500">Expected</dt>
          <dd className="break-all text-slate-200">{formatValue(verdict.expected)}</dd>
        </div>
        <div>
          <dt className="text-slate-500">Your output</dt>
          <dd className={`break-all ${verdict.passed ? 'text-slate-200' : 'text-rose-300'}`}>
            {result.ok ? formatValue(result.output) : (result.error ?? 'error')}
          </dd>
        </div>
        {result.stdout && (
          <div>
            <dt className="text-slate-500">Stdout</dt>
            <dd className="whitespace-pre-wrap text-slate-300">{result.stdout}</dd>
          </div>
        )}
      </dl>
    </details>
  );
}

export function CodingWorkspace({
  question,
  language,
  code,
  onLanguage,
  onCode,
  onSubmitted,
}: CodingWorkspaceProps) {
  const [busy, setBusy] = useState<'run' | 'submit' | null>(null);
  const [status, setStatus] = useState<string>('');
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const fn = question.fn[language];

  async function execute(mode: 'run' | 'submit') {
    setBusy(mode);
    setStatus('Running…');
    const cases = mode === 'run' ? question.tests.slice(0, SAMPLE_COUNT) : question.tests;
    const results = await runCases(language, code, fn, cases, setStatus);
    const verdicts = judge(cases, results);
    if (mode === 'run') {
      setOutcome({ mode, verdicts });
    } else {
      setOutcome({
        mode,
        samples: verdicts.slice(0, SAMPLE_COUNT),
        hidden: verdicts.slice(SAMPLE_COUNT),
      });
      onSubmitted({ passed: verdicts.filter((v) => v.passed).length, total: verdicts.length });
    }
    setStatus('');
    setBusy(null);
  }

  const samples = outcome ? (outcome.mode === 'run' ? outcome.verdicts : outcome.samples) : [];
  const hidden = outcome?.mode === 'submit' ? outcome.hidden : [];
  const hiddenPassed = hidden.filter((v) => v.passed).length;
  const firstHiddenError = hidden.find((v) => !v.passed && !v.result.ok)?.result.error;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-[#0f1217] text-slate-200">
      <div className="flex items-center gap-2 border-b border-white/10 px-3 py-2">
        <select
          value={language}
          onChange={(e) => onLanguage(e.target.value as Language)}
          aria-label="Language"
          className="h-8 rounded-md border border-white/15 bg-[#1a1f27] px-2 text-[13px] text-slate-100 outline-none focus-visible:border-teal-400"
        >
          {LANGUAGES.map((l) => (
            <option key={l.id} value={l.id}>
              {l.label}
            </option>
          ))}
        </select>
        <span className="font-mono text-[12px] text-slate-500">{fn}()</span>
        <button
          type="button"
          onClick={() => onCode(question.starter[language])}
          className="ml-auto flex items-center gap-1 rounded-md px-2 py-1 text-[12px] text-slate-400 hover:bg-white/5 hover:text-slate-200"
        >
          <RotateCcw className="h-3.5 w-3.5" /> Reset code
        </button>
      </div>

      <CodeEditor
        value={code}
        onChange={onCode}
        indent={language === 'python' ? '    ' : '  '}
        label={`${question.title} code editor`}
      />

      <div className="flex max-h-[42%] min-h-[9rem] flex-col border-t border-white/10">
        <div className="flex items-center gap-2 px-3 py-2">
          <span className="text-[12px] font-semibold uppercase tracking-[0.14em] text-slate-400">
            Console
          </span>
          {status && (
            <span className="flex items-center gap-1.5 text-[12px] text-teal-300">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> {status}
            </span>
          )}
          <div className="ml-auto flex gap-2">
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => execute('run')}
              className="flex items-center gap-1.5 rounded-md border border-white/15 px-3 py-1.5 text-[13px] text-slate-100 transition-colors hover:bg-white/5 disabled:opacity-40"
            >
              <Play className="h-3.5 w-3.5" /> Run samples
            </button>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => execute('submit')}
              className="flex items-center gap-1.5 rounded-md bg-teal-500 px-3 py-1.5 text-[13px] font-semibold text-teal-950 transition-colors hover:bg-teal-400 disabled:opacity-40"
            >
              <Send className="h-3.5 w-3.5" /> Submit
            </button>
          </div>
        </div>
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 pb-3">
          {!outcome && (
            <p className="text-[13px] text-slate-500">
              Run checks the {SAMPLE_COUNT} sample cases. Submit also runs hidden cases and records
              your score.
            </p>
          )}
          {outcome?.mode === 'submit' && (
            <p
              className={`rounded-md px-3 py-2 text-[13px] ${
                hiddenPassed === hidden.length && samples.every((v) => v.passed)
                  ? 'bg-emerald-500/10 text-emerald-300'
                  : 'bg-rose-500/10 text-rose-200'
              }`}
            >
              Submitted · samples {samples.filter((v) => v.passed).length}/{samples.length} · hidden{' '}
              {hiddenPassed}/{hidden.length}
              {firstHiddenError ? ` · first hidden error: ${firstHiddenError.split('\n')[0]}` : ''}
            </p>
          )}
          {samples.map((v, i) => (
            <Verdict key={i} verdict={v} index={i} params={question.params} />
          ))}
        </div>
      </div>
    </div>
  );
}
