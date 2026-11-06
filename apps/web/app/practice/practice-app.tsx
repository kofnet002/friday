'use client';

import { Clock, Flag } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { ChoicePanel, WrittenPanel } from './answer-panels';
import { CodingWorkspace, type Submission } from './coding-workspace';
import { formatClock } from './grading';
import { Statement } from './statement';
import { Summary } from './summary';
import { PRACTICE_TESTS, type PracticeTestId } from './tests';
import type { Language, PracticeTest, Question, TestInfo } from './types';

export interface AttemptState {
  startedAt: number | null;
  finishedAt: number | null;
  current: string;
  language: Record<string, Language>;
  code: Record<string, string>;
  choices: Record<string, number>;
  written: Record<string, string>;
  submissions: Record<string, Submission>;
}

function freshState(test: PracticeTest): AttemptState {
  return {
    startedAt: null,
    finishedAt: null,
    current: test.questions[0].id,
    language: {},
    code: {},
    choices: {},
    written: {},
    submissions: {},
  };
}

function load(test: PracticeTest): AttemptState {
  const fresh = freshState(test);
  try {
    const raw = window.localStorage.getItem(test.storageKey);
    return raw ? { ...fresh, ...(JSON.parse(raw) as Partial<AttemptState>) } : fresh;
  } catch {
    return fresh;
  }
}

function save(test: PracticeTest, state: AttemptState): void {
  try {
    window.localStorage.setItem(test.storageKey, JSON.stringify(state));
  } catch {
    // Private window / storage blocked: the attempt just won't survive a reload.
  }
}

function isAnswered(q: Question, s: AttemptState): boolean {
  if (q.kind === 'coding') return Boolean(s.submissions[q.id]);
  if (q.kind === 'choice') return q.items.every((item) => s.choices[item.id] !== undefined);
  return q.parts.some((p) => (s.written[p.id] ?? '').trim().length > 0);
}

function Intro({ test, onStart }: { test: PracticeTest; onStart: () => void }) {
  const { info, questions } = test;
  return (
    <main className="min-h-screen bg-[#f6f4ef] px-4 py-12 text-stone-800">
      <div className="mx-auto max-w-2xl space-y-8">
        <Brand info={info} />
        <section className="space-y-3">
          <p className="font-mono text-[12px] uppercase tracking-[0.18em] text-teal-700">
            {info.company}
          </p>
          <h1 className="text-[34px] font-semibold leading-tight tracking-tight text-stone-900">
            {info.name}
          </h1>
          <p className="text-[15px] leading-7 text-stone-600">
            {questions.length} questions · {info.minutes} minutes ·{' '}
            {questions.reduce((s, q) => s + q.points, 0)} points. The timer starts when you press
            Start and keeps running if you close the tab.
          </p>
        </section>
        <ol className="divide-y divide-stone-200 rounded-xl border border-stone-200 bg-white">
          {questions.map((q, i) => (
            <li key={q.id} className="flex items-center gap-4 px-5 py-3.5 text-[14px]">
              <span className="font-mono text-[12px] text-stone-400">
                {String(i + 1).padStart(2, '0')}
              </span>
              <span className="flex-1 text-stone-800">{q.title}</span>
              <span className="text-[12px] text-stone-500">
                {q.kind === 'coding'
                  ? `Coding · ${q.difficulty}`
                  : q.kind === 'choice'
                    ? 'Multiple choice'
                    : 'Written'}
              </span>
              <span className="w-16 whitespace-nowrap text-right font-mono text-[12px] text-stone-500">
                {q.points} pts
              </span>
            </li>
          ))}
        </ol>
        <ul className="list-disc space-y-1 pl-5 text-[13px] leading-6 text-stone-600">
          <li>
            Coding questions accept Python 3 or JavaScript. Run checks the samples; Submit also runs
            hidden tests.
          </li>
          <li>You can move between questions freely. Answers save as you type.</li>
        </ul>
        <button
          type="button"
          onClick={onStart}
          className="rounded-lg bg-stone-900 px-6 py-3 text-[15px] font-semibold text-white transition-colors hover:bg-stone-700 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-teal-300"
        >
          Start test
        </button>
      </div>
    </main>
  );
}

function Brand({ info }: { info: TestInfo }) {
  return (
    <div className="flex items-center gap-2">
      <span aria-hidden className="h-3.5 w-3.5 rotate-45 rounded-[3px] bg-teal-500" />
      <span className="text-[15px] font-semibold tracking-tight">{info.platform}</span>
    </div>
  );
}

export function PracticeApp({ testId }: { testId: PracticeTestId }) {
  const test = PRACTICE_TESTS[testId];
  const { info, questions } = test;
  const durationMs = info.minutes * 60 * 1000;
  const [state, setState] = useState<AttemptState | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => setState(load(test)), [test]);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const update = useCallback(
    (patch: (s: AttemptState) => Partial<AttemptState>) => {
      setState((prev) => {
        if (!prev) return prev;
        const next = { ...prev, ...patch(prev) };
        save(test, next);
        return next;
      });
    },
    [test],
  );

  const remaining = state?.startedAt ? state.startedAt + durationMs - now : durationMs;
  useEffect(() => {
    if (state?.startedAt && !state.finishedAt && remaining <= 0)
      update(() => ({ finishedAt: Date.now() }));
  }, [remaining, state?.startedAt, state?.finishedAt, update]);

  if (!state) return <main className="min-h-screen bg-[#f6f4ef]" />;
  if (!state.startedAt)
    return (
      <Intro
        test={test}
        onStart={() => update(() => ({ ...freshState(test), startedAt: Date.now() }))}
      />
    );
  if (state.finishedAt) {
    return <Summary test={test} state={state} onRetake={() => update(() => freshState(test))} />;
  }

  const question = questions.find((q) => q.id === state.current) ?? questions[0];
  const index = questions.indexOf(question);
  const language =
    question.kind === 'coding' ? (state.language[question.id] ?? 'python') : 'python';
  const codeKey = `${question.id}:${language}`;

  return (
    <main className="flex h-screen flex-col bg-[#f6f4ef] text-stone-800">
      <header className="flex h-14 shrink-0 items-center gap-4 border-b border-stone-200 bg-white px-4">
        <Brand info={info} />
        <span className="hidden truncate text-[13px] text-stone-500 md:inline">
          {info.company} · {info.name}
        </span>
        <div
          className={`ml-auto flex items-center gap-1.5 rounded-md px-2.5 py-1 font-mono text-[14px] tabular-nums ${
            remaining < 5 * 60 * 1000 ? 'bg-rose-100 text-rose-800' : 'bg-stone-100 text-stone-800'
          }`}
          aria-label="Time remaining"
        >
          <Clock className="h-4 w-4" /> {formatClock(remaining)}
        </div>
        <button
          type="button"
          onClick={() => update(() => ({ finishedAt: Date.now() }))}
          className="flex items-center gap-1.5 rounded-md border border-stone-300 px-3 py-1.5 text-[13px] font-medium text-stone-800 hover:bg-stone-100"
        >
          <Flag className="h-4 w-4" /> Finish test
        </button>
      </header>

      <div className="flex min-h-0 flex-1">
        <nav
          aria-label="Questions"
          className="flex w-14 shrink-0 flex-col items-center gap-2 border-r border-stone-200 bg-white py-3"
        >
          {questions.map((q, i) => {
            const active = q.id === question.id;
            const done = isAnswered(q, state);
            return (
              <button
                key={q.id}
                type="button"
                onClick={() => update(() => ({ current: q.id }))}
                aria-current={active ? 'step' : undefined}
                title={q.title}
                className={`relative h-9 w-9 rounded-lg font-mono text-[13px] transition-colors ${
                  active ? 'bg-stone-900 text-white' : 'text-stone-600 hover:bg-stone-100'
                }`}
              >
                {i + 1}
                {done && (
                  <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border-2 border-white bg-teal-500" />
                )}
              </button>
            );
          })}
        </nav>

        <section
          className="min-h-0 w-[46%] shrink-0 overflow-y-auto border-r border-stone-200 bg-white px-8 py-7"
          aria-label="Problem"
        >
          <Statement question={question} index={index} />
        </section>

        {question.kind === 'coding' ? (
          <CodingWorkspace
            key={question.id}
            question={question}
            language={language}
            code={state.code[codeKey] ?? question.starter[language]}
            onLanguage={(lang) =>
              update((s) => ({ language: { ...s.language, [question.id]: lang } }))
            }
            onCode={(code) => update((s) => ({ code: { ...s.code, [codeKey]: code } }))}
            onSubmitted={(sub) =>
              update((s) => ({ submissions: { ...s.submissions, [question.id]: sub } }))
            }
          />
        ) : (
          <section className="min-h-0 flex-1 overflow-y-auto px-8 py-7" aria-label="Your answer">
            <h2 className="mb-5 font-mono text-[11px] uppercase tracking-[0.18em] text-stone-500">
              Your answer
            </h2>
            {question.kind === 'choice' ? (
              <ChoicePanel
                question={question}
                answers={state.choices}
                onAnswer={(id, option) =>
                  update((s) => ({ choices: { ...s.choices, [id]: option } }))
                }
              />
            ) : (
              <WrittenPanel
                question={question}
                answers={state.written}
                onAnswer={(id, text) => update((s) => ({ written: { ...s.written, [id]: text } }))}
              />
            )}
          </section>
        )}
      </div>
    </main>
  );
}
