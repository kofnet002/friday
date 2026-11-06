'use client';

import { useRef, type KeyboardEvent } from 'react';

interface CodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  indent: string;
  label: string;
}

/** A plain textarea with a line-number gutter, Tab to indent and
 *  auto-indent on Enter. Enough for a timed test; no editor dependency. */
export function CodeEditor({ value, onChange, indent, label }: CodeEditorProps) {
  const gutter = useRef<HTMLDivElement>(null);
  const lines = value.split('\n').length;

  function replaceSelection(el: HTMLTextAreaElement, text: string, caret: number) {
    const next = value.slice(0, el.selectionStart) + text + value.slice(el.selectionEnd);
    onChange(next);
    requestAnimationFrame(() => {
      el.selectionStart = el.selectionEnd = caret;
    });
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    const el = e.currentTarget;
    if (e.key === 'Tab' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      replaceSelection(el, indent, el.selectionStart + indent.length);
      return;
    }
    if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      const before = value.slice(0, el.selectionStart);
      const line = before.slice(before.lastIndexOf('\n') + 1);
      const current = line.match(/^\s*/)?.[0] ?? '';
      const opens = /[:{[(]\s*$/.test(line);
      const text = `\n${current}${opens ? indent : ''}`;
      replaceSelection(el, text, el.selectionStart + text.length);
    }
  }

  return (
    <div className="relative flex min-h-0 flex-1 overflow-hidden bg-[#14181f] font-mono text-[13px] leading-[1.6]">
      <div
        ref={gutter}
        aria-hidden
        className="select-none overflow-hidden px-3 py-3 text-right text-[#4b5566]"
      >
        {Array.from({ length: lines }, (_, i) => (
          <div key={i}>{i + 1}</div>
        ))}
      </div>
      <textarea
        aria-label={label}
        value={value}
        spellCheck={false}
        autoCapitalize="off"
        autoComplete="off"
        autoCorrect="off"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        onScroll={(e) => {
          if (gutter.current) gutter.current.scrollTop = e.currentTarget.scrollTop;
        }}
        className="min-h-0 flex-1 resize-none whitespace-pre bg-transparent py-3 pr-4 text-[#e6e9ef] caret-teal-300 outline-none selection:bg-teal-700/50"
      />
    </div>
  );
}
