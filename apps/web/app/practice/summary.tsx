'use client';

import { codingScore, formatClock, wordCount } from './grading';
import type { AttemptState } from './practice-app';
import type { PracticeTest, Question } from './types';

interface Row {
  question: Question;
  score: number | null;
  detail: string;
}

function rowFor(question: Question, state: AttemptState): Row {
  if (question.kind === 'coding') {
    const sub = state.submissions[question.id];
    return sub
      ? {
          question,
          score: codingScore(question.points, sub.passed, sub.total),
          detail: `${sub.passed}/${sub.total} tests`,
        }
      : { question, score: 0, detail: 'not submitted' };
  }
  if (question.kind === 'choice') {
    const right = question.items.filter((item) => state.choices[item.id] === item.answer).length;
    const each = question.points / question.items.length;
    return {
      question,
      score: Math.round(right * each),
      detail: `${right}/${question.items.length} correct`,
    };
  }
  const words = question.parts.map((p) => wordCount(state.written[p.id] ?? ''));
  const over = question.parts.filter((p, i) => (words[i] ?? 0) > p.maxWords).length;
  return {
    question,
    score: null,
    detail: `${words.reduce((a, b) => a + b, 0)} words${over ? ` · ${over} part(s) over the limit` : ''} · reviewed by a person`,
  };
}

interface SummaryProps {
  test: PracticeTest;
  state: AttemptState;
  onRetake: () => void;
}

export function Summary({ test, state, onRetake }: SummaryProps) {
  const rows = test.questions.map((q) => rowFor(q, state));
  const auto = rows.filter((r) => r.score !== null);
  const scored = auto.reduce((s, r) => s + (r.score ?? 0), 0);
  const possible = auto.reduce((s, r) => s + r.question.points, 0);
  const took = (state.finishedAt ?? Date.now()) - (state.startedAt ?? Date.now());

  return (
    <main className="min-h-screen bg-[#f6f4ef] px-4 py-12 text-stone-800">
      <div className="mx-auto max-w-2xl space-y-8">
        <p className="font-mono text-[12px] uppercase tracking-[0.18em] text-teal-700">
          Test submitted
        </p>
        <div className="flex flex-wrap items-end gap-x-6 gap-y-2">
          <h1 className="text-[56px] font-semibold leading-none tracking-tight text-stone-900">
            {scored}
            <span className="text-[28px] text-stone-400">/{possible}</span>
          </h1>
          <p className="pb-2 text-[14px] text-stone-600">
            auto-graded points · finished in {formatClock(took)} of {test.info.minutes}:00
          </p>
        </div>
        <ol className="divide-y divide-stone-200 rounded-xl border border-stone-200 bg-white">
          {rows.map((r, i) => (
            <li key={r.question.id} className="flex items-center gap-4 px-5 py-3.5 text-[14px]">
              <span className="font-mono text-[12px] text-stone-400">
                {String(i + 1).padStart(2, '0')}
              </span>
              <span className="flex-1">
                <span className="block text-stone-900">{r.question.title}</span>
                <span className="block text-[12px] text-stone-500">{r.detail}</span>
              </span>
              <span className="font-mono text-[13px] text-stone-700">
                {r.score === null ? '—' : r.score}/{r.question.points}
              </span>
            </li>
          ))}
        </ol>
        <button
          type="button"
          onClick={onRetake}
          className="rounded-lg border border-stone-300 bg-white px-5 py-2.5 text-[14px] font-medium text-stone-800 hover:bg-stone-100"
        >
          Start over
        </button>
      </div>
    </main>
  );
}
