'use client';

import { wordCount } from './grading';
import type { ChoiceQuestion, WrittenQuestion } from './types';

interface ChoicePanelProps {
  question: ChoiceQuestion;
  answers: Record<string, number>;
  onAnswer: (itemId: string, option: number) => void;
}

export function ChoicePanel({ question, answers, onAnswer }: ChoicePanelProps) {
  return (
    <ol className="space-y-8">
      {question.items.map((item, n) => (
        <li key={item.id} className="space-y-3">
          <p className="text-[15px] leading-7 text-stone-800">
            <span className="mr-2 font-mono text-[12px] text-stone-500">{n + 1}.</span>
            {item.prompt}
          </p>
          {item.code && (
            <pre className="overflow-x-auto rounded-lg border border-stone-200 bg-stone-100 px-4 py-3 font-mono text-[12.5px] leading-6 text-stone-800">
              {item.code}
            </pre>
          )}
          <fieldset className="grid gap-2 sm:grid-cols-2">
            <legend className="sr-only">{item.prompt}</legend>
            {item.options.map((option, i) => {
              const checked = answers[item.id] === i;
              return (
                <label
                  key={option}
                  className={`flex cursor-pointer items-center gap-3 rounded-lg border px-3.5 py-2.5 text-[14px] transition-colors ${
                    checked
                      ? 'border-teal-600 bg-teal-50 text-teal-950'
                      : 'border-stone-200 bg-white text-stone-700 hover:border-stone-400'
                  }`}
                >
                  <input
                    type="radio"
                    name={item.id}
                    checked={checked}
                    onChange={() => onAnswer(item.id, i)}
                    className="h-4 w-4 accent-teal-600"
                  />
                  <span className="font-mono text-[12px] text-stone-500">
                    {String.fromCharCode(65 + i)}
                  </span>
                  {option}
                </label>
              );
            })}
          </fieldset>
        </li>
      ))}
    </ol>
  );
}

interface WrittenPanelProps {
  question: WrittenQuestion;
  answers: Record<string, string>;
  onAnswer: (partId: string, text: string) => void;
}

export function WrittenPanel({ question, answers, onAnswer }: WrittenPanelProps) {
  return (
    <div className="space-y-6">
      {question.parts.map((part) => {
        const text = answers[part.id] ?? '';
        const words = wordCount(text);
        const over = words > part.maxWords;
        return (
          <div key={part.id} className="space-y-2">
            <div className="flex items-baseline justify-between gap-3">
              <label
                htmlFor={`part-${part.id}`}
                className="text-[14px] font-semibold text-stone-900"
              >
                {part.label}
              </label>
              <span
                className={`font-mono text-[12px] ${over ? 'font-semibold text-rose-700' : 'text-stone-500'}`}
              >
                {words}/{part.maxWords} words
              </span>
            </div>
            <textarea
              id={`part-${part.id}`}
              value={text}
              onChange={(e) => onAnswer(part.id, e.target.value)}
              rows={part.maxWords > 150 ? 9 : 5}
              className={`w-full resize-y rounded-lg border bg-white px-3.5 py-3 text-[14px] leading-6 text-stone-800 outline-none focus-visible:ring-2 ${
                over
                  ? 'border-rose-400 focus-visible:ring-rose-200'
                  : 'border-stone-300 focus-visible:ring-teal-200'
              }`}
            />
          </div>
        );
      })}
    </div>
  );
}
