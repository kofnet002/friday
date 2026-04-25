'use client';

import { useEffect, useState } from 'react';
import type { QAHistoryRow } from '@friday/shared-types';

import { Markdown } from '@/lib/markdown';
import { cn } from '@/lib/utils';

const SHORTCUTS = [
  { keys: '⌘ ⇧ Space', label: 'Force-ask copilot using last 2 transcript finals' },
  { keys: '⌘ ⇧ C', label: 'Toggle coding mode' },
  { keys: '⌘ /', label: 'Show this shortcuts cheat-sheet' },
];

export function ModalShell({
  title,
  open,
  onClose,
  wide,
  children,
}: {
  title: string;
  open: boolean;
  onClose: () => void;
  wide?: boolean;
  children: React.ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 px-4 py-8 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className={cn(
          'flex max-h-[80vh] w-full flex-col gap-4 rounded-xl border border-neutral-200 bg-white p-5 shadow-2xl dark:border-neutral-800 dark:bg-neutral-900',
          wide ? 'max-w-3xl' : 'max-w-md',
        )}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-[0.15em] text-neutral-700 dark:text-neutral-300">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-2 py-1 text-xs text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
          >
            esc
          </button>
        </div>
        <div className="overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}

export function ShortcutsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <ModalShell title="Keyboard shortcuts" open={open} onClose={onClose}>
      <table className="w-full text-sm">
        <tbody>
          {SHORTCUTS.map((s) => (
            <tr
              key={s.keys}
              className="border-b border-neutral-200 last:border-b-0 dark:border-neutral-800"
            >
              <td className="py-2 pr-4 align-top">
                <kbd className="rounded-md border border-neutral-300 bg-neutral-50 px-2 py-0.5 font-mono text-xs text-neutral-700 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-200">
                  {s.keys}
                </kbd>
              </td>
              <td className="py-2 text-neutral-600 dark:text-neutral-300">{s.label}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </ModalShell>
  );
}

export function HistoryModal({
  open,
  onClose,
  qa,
  loading,
}: {
  open: boolean;
  onClose: () => void;
  qa: QAHistoryRow[];
  loading: boolean;
}) {
  const [expanded, setExpanded] = useState<number | null>(null);
  return (
    <ModalShell title="Q&A history (this session)" open={open} onClose={onClose} wide>
      {loading ? (
        <p className="text-xs text-neutral-500">Loading…</p>
      ) : qa.length === 0 ? (
        <p className="text-xs text-neutral-500">
          No Q&A yet — ask the copilot or wait for question detection.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {qa.map((item) => {
            const isOpen = expanded === item.id;
            const date = new Date(item.created_at * 1000);
            return (
              <li
                key={item.id}
                className="rounded-lg border border-neutral-200 dark:border-neutral-800"
              >
                <button
                  type="button"
                  onClick={() => setExpanded(isOpen ? null : item.id)}
                  className="flex w-full items-start justify-between gap-3 px-3 py-2 text-left"
                >
                  <span className="flex-1 text-sm text-neutral-800 dark:text-neutral-100">
                    {item.question}
                  </span>
                  <span className="shrink-0 text-[10px] uppercase tracking-widest text-neutral-500">
                    {date.toLocaleTimeString()} · {item.provider}
                    {item.auto_detected ? ' · auto' : ''}
                  </span>
                </button>
                {isOpen ? (
                  <div className="border-t border-neutral-200 px-3 py-3 dark:border-neutral-800">
                    <Markdown text={item.answer} />
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </ModalShell>
  );
}

export function ConnectionPill({
  transcribe,
  answer,
  coding,
}: {
  transcribe: 'live' | 'idle' | 'error';
  answer: boolean;
  coding: boolean;
}) {
  const dot = (state: 'green' | 'amber' | 'gray') =>
    cn(
      'h-1.5 w-1.5 rounded-full',
      state === 'green' && 'bg-emerald-500',
      state === 'amber' && 'bg-amber-500',
      state === 'gray' && 'bg-neutral-400',
    );
  return (
    <div
      title={`transcribe: ${transcribe}, copilot WS: ${answer ? 'open' : 'closed'}, coding WS: ${coding ? 'open' : 'closed'}`}
      className="flex items-center gap-1.5 rounded-full bg-neutral-100 px-2 py-1 text-[10px] font-mono text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
    >
      <span
        className={dot(transcribe === 'live' ? 'green' : transcribe === 'error' ? 'amber' : 'gray')}
      />
      <span>asr</span>
      <span className={dot(answer ? 'green' : 'gray')} />
      <span>copilot</span>
      <span className={dot(coding ? 'green' : 'gray')} />
      <span>coding</span>
    </div>
  );
}
