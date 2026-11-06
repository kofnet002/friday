import { Fragment, type ReactNode } from 'react';

import type { Block, Question } from './types';

const DIFFICULTY_STYLE = {
  Easy: 'bg-emerald-100 text-emerald-800',
  Medium: 'bg-amber-100 text-amber-900',
  Hard: 'bg-rose-100 text-rose-800',
} as const;

/** `code` and **bold** inside a sentence. */
function inline(text: string): ReactNode {
  return text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).map((part, i) => {
    if (part.startsWith('`') && part.endsWith('`')) {
      return (
        <code
          key={i}
          className="rounded bg-stone-200/70 px-1 py-0.5 font-mono text-[0.86em] text-stone-900"
        >
          {part.slice(1, -1)}
        </code>
      );
    }
    if (part.startsWith('**') && part.endsWith('**')) {
      return (
        <strong key={i} className="font-semibold text-stone-900">
          {part.slice(2, -2)}
        </strong>
      );
    }
    return <Fragment key={i}>{part}</Fragment>;
  });
}

function BlockView({ block, exampleNo }: { block: Block; exampleNo: number }) {
  switch (block.t) {
    case 'p':
      return <p className="leading-7">{inline(block.text)}</p>;
    case 'h':
      return <h3 className="pt-2 text-[15px] font-semibold text-stone-900">{block.text}</h3>;
    case 'note':
      return (
        <p className="rounded-lg border border-teal-200 bg-teal-50/70 px-4 py-2.5 text-[13px] leading-6 text-teal-950">
          {inline(block.text)}
        </p>
      );
    case 'list': {
      const Tag = block.ordered ? 'ol' : 'ul';
      return (
        <Tag
          className={`space-y-1.5 pl-6 leading-7 ${block.ordered ? 'list-decimal' : 'list-disc'}`}
        >
          {block.items.map((item) => (
            <li key={item}>{inline(item)}</li>
          ))}
        </Tag>
      );
    }
    case 'code':
      return (
        <pre className="overflow-x-auto rounded-lg border border-stone-200 bg-stone-100 px-4 py-3 font-mono text-[12.5px] leading-6 text-stone-800">
          {block.text}
        </pre>
      );
    case 'table':
      return (
        <div className="overflow-x-auto rounded-lg border border-stone-200">
          <table className="w-full border-collapse text-left text-[12.5px]">
            <thead className="bg-stone-100 text-stone-600">
              <tr>
                {block.head.map((h) => (
                  <th key={h} className="whitespace-nowrap px-3 py-2 font-semibold">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="font-mono text-stone-800">
              {block.rows.map((row, r) => (
                <tr key={r} className="border-t border-stone-200">
                  {row.map((cell, c) => (
                    <td key={c} className="px-3 py-1.5 align-top">
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'example':
      return (
        <section className="space-y-1.5">
          <h4 className="text-[13px] font-semibold text-stone-900">Example {exampleNo}</h4>
          <div className="rounded-lg border border-stone-200 bg-stone-50 px-4 py-2.5 font-mono text-[12.5px] leading-6 text-stone-800">
            <div className="whitespace-pre-wrap">
              <span className="font-sans font-semibold text-stone-500">Input: </span>
              {block.input}
            </div>
            <div className="whitespace-pre-wrap">
              <span className="font-sans font-semibold text-stone-500">Output: </span>
              {block.output}
            </div>
            {block.explanation && (
              <div className="mt-1 whitespace-pre-wrap font-sans text-[13px] leading-6 text-stone-700">
                <span className="font-semibold text-stone-500">Explanation: </span>
                {inline(block.explanation)}
              </div>
            )}
          </div>
        </section>
      );
  }
}

export function Statement({ question, index }: { question: Question; index: number }) {
  let examples = 0;
  return (
    <article className="space-y-4 text-[14px] text-stone-700">
      <header className="space-y-2 border-b border-stone-200 pb-4">
        <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-stone-500">
          Question {index + 1} · {question.points} points
        </p>
        <h2 className="text-[22px] font-semibold leading-tight tracking-tight text-stone-900">
          {question.title}
        </h2>
        {question.kind === 'coding' && (
          <span
            className={`inline-block rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${DIFFICULTY_STYLE[question.difficulty]}`}
          >
            {question.difficulty}
          </span>
        )}
      </header>
      {question.blocks.map((block, i) => (
        <BlockView key={i} block={block} exampleNo={block.t === 'example' ? ++examples : 0} />
      ))}
    </article>
  );
}
