'use client';

import { useEffect, useState, type ReactNode } from 'react';
import {
  Clock,
  Download,
  Eye,
  EyeOff,
  Keyboard,
  MessageSquareText,
  MonitorUp,
  Shield,
  ShieldAlert,
  VenetianMask,
} from 'lucide-react';
import type { QAHistoryRow } from '@friday/shared-types';

import { Button } from '@/components/ui/button';
import { Markdown } from '@/lib/markdown';
import { cn } from '@/lib/utils';

export const SESSION_SHORTCUTS = [
  { keys: '⌘ ⇧ Space', label: 'Force-ask copilot using last 2 transcript finals' },
  { keys: '⌘ ⇧ C', label: 'Toggle coding mode' },
  { keys: '⌘ /', label: 'Show this shortcuts cheat-sheet' },
];

export const DESKTOP_SHORTCUTS = [
  { keys: '⌘ ⇧ \\', label: 'Show or hide the desktop window' },
  { keys: '⌘ ⇧ [', label: 'Nudge window left 50px' },
  { keys: '⌘ ⇧ ]', label: 'Nudge window right 50px' },
  { keys: '⌘ ⇧ -', label: 'Decrease window opacity' },
  { keys: '⌘ ⇧ =', label: 'Increase window opacity' },
  { keys: '⌘ ⇧ 0', label: 'Reset opacity and recenter the window' },
];

export function ModalShell({
  title,
  icon,
  open,
  onClose,
  wide,
  children,
}: {
  title: string;
  icon?: ReactNode;
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
      data-interactive="true"
      className="pointer-events-auto fixed inset-0 z-[100] flex items-center justify-center bg-black/55 px-4 py-8 backdrop-blur-sm animate-in fade-in duration-150"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className={cn(
          'flex max-h-[80vh] w-full flex-col rounded-xl border border-neutral-200 bg-white shadow-2xl ring-1 ring-black/5 animate-in fade-in zoom-in-95 duration-200 dark:border-neutral-800 dark:bg-neutral-900 dark:ring-white/5',
          wide ? 'max-w-3xl' : 'max-w-md',
        )}
      >
        <div className="flex items-center justify-between gap-3 border-b border-neutral-200 px-5 py-3 dark:border-neutral-800">
          <h2 className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-neutral-700 dark:text-neutral-200">
            {icon ? (
              <span className="text-sky-600 dark:text-sky-400" aria-hidden>
                {icon}
              </span>
            ) : null}
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-neutral-200 bg-neutral-50 px-1.5 py-0.5 font-mono text-[10px] text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-700 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-700 dark:hover:text-neutral-200"
            aria-label="close"
          >
            esc
          </button>
        </div>
        <div className="overflow-y-auto px-5 py-4">{children}</div>
      </div>
    </div>
  );
}

export function ShortcutsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <ModalShell
      title="Keyboard shortcuts"
      icon={<Keyboard className="h-3.5 w-3.5" />}
      open={open}
      onClose={onClose}
    >
      <div className="flex flex-col gap-5">
        <ShortcutGroup heading="Session" items={SESSION_SHORTCUTS} />
        <ShortcutGroup heading="Window" items={DESKTOP_SHORTCUTS} />
      </div>
    </ModalShell>
  );
}

function ShortcutGroup({
  heading,
  items,
}: {
  heading: string;
  items: Array<{ keys: string; label: string }>;
}) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-[10px] font-semibold uppercase tracking-[0.18em] text-neutral-500 dark:text-neutral-400">
        {heading}
      </h3>
      <div className="overflow-hidden rounded-lg border border-neutral-200 dark:border-neutral-800">
        {items.map((s, i) => (
          <div
            key={s.keys}
            className={cn(
              'flex items-center justify-between gap-4 px-3 py-2 text-sm',
              i > 0 && 'border-t border-neutral-200 dark:border-neutral-800',
              'odd:bg-neutral-50/40 dark:odd:bg-neutral-900/30',
            )}
          >
            <span className="text-neutral-700 dark:text-neutral-200">{s.label}</span>
            <kbd className="rounded-md border border-neutral-300 bg-white px-2 py-0.5 font-mono text-[11px] text-neutral-700 shadow-[0_1px_0_rgba(0,0,0,0.05)] dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-200">
              {s.keys}
            </kbd>
          </div>
        ))}
      </div>
    </section>
  );
}

export interface SettingsBodyProps {
  desktopStatus: FridayWindowStatus | null;
  stealthMode: boolean;
  privacyMode: boolean;
  onStealthModeChange: () => void;
  onPrivacyModeChange: (value: boolean) => void;
  onPreferenceChange: (patch: Partial<FridayWindowPreferences>) => void;
  onCenterWindow: () => void;
  onOpenStealthTest: () => void;
}

export function SettingsBody({
  desktopStatus,
  stealthMode,
  privacyMode,
  onStealthModeChange,
  onPrivacyModeChange,
  onPreferenceChange,
  onCenterWindow,
  onOpenStealthTest,
}: SettingsBodyProps) {
  const prefs = desktopStatus?.preferences;

  return (
    <div className="flex flex-col gap-6 text-sm">
      <section className="flex flex-col gap-3">
        <div>
          <h3 className="font-semibold text-neutral-800 dark:text-neutral-100">Stealth</h3>
          <p className="mt-1 text-neutral-500 dark:text-neutral-400">
            Use these toggles to verify each behavior independently during development.
          </p>
        </div>
        <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 dark:border-amber-900 dark:bg-amber-950/30">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h4 className="font-semibold text-amber-950 dark:text-amber-100">Stealth mode</h4>
              <p className="mt-1 text-xs text-amber-900/80 dark:text-amber-100/80">
                Enables Electron content protection and the native macOS window-sharing lock for
                awareness checks. This should reduce capture paths, but it is not a security
                boundary.
              </p>
            </div>
            <Button
              type="button"
              variant={stealthMode ? 'outline' : 'default'}
              onClick={onStealthModeChange}
            >
              <VenetianMask className="mr-2 h-4 w-4" />
              {stealthMode ? 'Disable' : 'Enable'}
            </Button>
          </div>
        </div>
        <ToggleRow
          icon={<Shield className="h-4 w-4" />}
          title="Accessory app"
          description="Use accessory-mode app behavior instead of a normal Dock and Cmd-Tab app."
          checked={Boolean(prefs?.accessoryApp)}
          disabled={!desktopStatus}
          onChange={(checked) => onPreferenceChange({ accessoryApp: checked })}
        />
        <ToggleRow
          icon={<EyeOff className="h-4 w-4" />}
          title="Dock hidden"
          description="Hide the Dock icon while keeping the menu bar icon as the primary launcher."
          checked={Boolean(prefs?.dockHidden)}
          disabled={!desktopStatus}
          onChange={(checked) => onPreferenceChange({ dockHidden: checked })}
        />
        <ToggleRow
          icon={<MonitorUp className="h-4 w-4" />}
          title="Always on top"
          description="Keep the visible app above normal windows, including fullscreen contexts."
          checked={Boolean(prefs?.alwaysOnTop)}
          disabled={!desktopStatus}
          onChange={(checked) => onPreferenceChange({ alwaysOnTop: checked })}
        />
        <ToggleRow
          icon={<Shield className="h-4 w-4" />}
          title="All workspaces"
          description="Keep the window available across Spaces, including fullscreen desktops."
          checked={Boolean(prefs?.visibleOnAllWorkspaces)}
          disabled={!desktopStatus}
          onChange={(checked) => onPreferenceChange({ visibleOnAllWorkspaces: checked })}
        />
        <ToggleRow
          icon={
            prefs?.hideWindowControls ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />
          }
          title="Hide traffic lights"
          description="Remove the macOS window buttons for a cleaner frameless shell."
          checked={Boolean(prefs?.hideWindowControls)}
          disabled={!desktopStatus}
          onChange={(checked) => onPreferenceChange({ hideWindowControls: checked })}
        />
        <ToggleRow
          icon={<ShieldAlert className="h-4 w-4" />}
          title="Content masking"
          description="Blur transcript, answers, and coding output inside the visible window."
          checked={privacyMode}
          onChange={onPrivacyModeChange}
        />
        <div className="flex items-center justify-between rounded-lg border border-neutral-200 px-3 py-2 dark:border-neutral-800">
          <div>
            <div className="font-medium text-neutral-800 dark:text-neutral-100">
              Current opacity
            </div>
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              Hotkeys update this live and persist it for the next launch.
            </p>
          </div>
          <span className="font-mono text-xs text-neutral-600 dark:text-neutral-300">
            {desktopStatus ? `${Math.round(desktopStatus.opacity * 100)}%` : 'desktop only'}
          </span>
        </div>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={onCenterWindow}
            disabled={!desktopStatus}
          >
            Center window
          </Button>
        </div>
      </section>

      <section className="flex flex-col gap-3 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
        <div>
          <h3 className="font-semibold text-neutral-800 dark:text-neutral-100">Hotkey Reference</h3>
          <p className="mt-1 text-neutral-500 dark:text-neutral-400">
            Use this card while checking visibility, movement, and opacity behavior.
          </p>
        </div>
        <ShortcutTable
          items={[
            ...SESSION_SHORTCUTS,
            ...DESKTOP_SHORTCUTS,
            { keys: 'Esc', label: 'Close any open modal' },
          ]}
        />
      </section>

      <section className="flex flex-col gap-3 rounded-xl border border-sky-200 bg-sky-50 p-4 dark:border-sky-900 dark:bg-sky-950/30">
        <div>
          <h3 className="font-semibold text-sky-900 dark:text-sky-100">Test window workflow</h3>
          <p className="mt-1 text-sky-800/80 dark:text-sky-200/80">
            Use this quick manual check after changing window settings.
          </p>
        </div>
        <ol className="list-decimal space-y-1 pl-5 text-sky-900/90 dark:text-sky-100/90">
          <li>Confirm Stealth mode is enabled.</li>
          <li>Open Friday from the tray or Dock.</li>
          <li>Press `⌘ ⇧ \\` to hide and show the visible window.</li>
          <li>After the window comes back, verify Stealth mode still reports as enabled.</li>
          <li>
            Run your screen-share or screenshot check and confirm the window behaves as expected.
          </li>
        </ol>
        <div>
          <Button type="button" variant="outline" onClick={onOpenStealthTest}>
            Test stealth
          </Button>
        </div>
      </section>
    </div>
  );
}

export function SettingsModal({
  open,
  onClose,
  ...body
}: { open: boolean; onClose: () => void } & SettingsBodyProps) {
  return (
    <ModalShell title="Window settings" open={open} onClose={onClose} wide>
      <SettingsBody {...body} />
    </ModalShell>
  );
}

export interface HistoryListProps {
  qa: QAHistoryRow[];
  loading: boolean;
  onExport?: () => void;
}

export function HistoryList({ qa, loading, onExport }: HistoryListProps) {
  const [expanded, setExpanded] = useState<number | null>(null);

  if (loading) {
    return <p className="text-sm text-neutral-500">Loading…</p>;
  }
  if (qa.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-10 text-center">
        <Clock className="h-6 w-6 text-neutral-400 dark:text-neutral-500" aria-hidden />
        <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">
          No questions answered yet
        </p>
        <p className="max-w-[36ch] text-xs text-neutral-500 dark:text-neutral-400">
          Ask the copilot directly, hit ⌘⇧Space, or let auto question-detection trigger one —
          they'll appear here once they finish streaming.
        </p>
        {onExport ? (
          <Button type="button" variant="outline" size="sm" onClick={onExport} className="mt-2">
            <Download className="mr-1.5 h-3.5 w-3.5" />
            Export session
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {onExport ? (
        <div className="flex items-center justify-between">
          <span className="text-[11px] uppercase tracking-widest text-neutral-500 dark:text-neutral-400">
            {qa.length} {qa.length === 1 ? 'entry' : 'entries'}
          </span>
          <Button type="button" variant="ghost" size="sm" onClick={onExport}>
            <Download className="mr-1.5 h-3.5 w-3.5" />
            Export
          </Button>
        </div>
      ) : null}
      <ul className="flex flex-col gap-2">
        {qa.map((item) => {
          const isOpen = expanded === item.id;
          const date = new Date(item.created_at * 1000);
          return (
            <li
              key={item.id}
              className="overflow-hidden rounded-lg border border-neutral-200 transition-colors hover:border-neutral-300 dark:border-neutral-800 dark:hover:border-neutral-700"
            >
              <button
                type="button"
                onClick={() => setExpanded(isOpen ? null : item.id)}
                className="flex w-full items-start justify-between gap-3 px-3 py-2.5 text-left"
              >
                <span className="flex-1 text-sm text-neutral-800 dark:text-neutral-100">
                  {item.question}
                </span>
                <span className="shrink-0 text-[10px] uppercase tracking-widest text-neutral-500">
                  {date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} ·{' '}
                  {item.provider}
                  {item.auto_detected ? ' · auto' : ''}
                </span>
              </button>
              {isOpen ? (
                <div className="border-t border-neutral-200 bg-neutral-50/40 px-3 py-3 dark:border-neutral-800 dark:bg-neutral-950/40">
                  <Markdown text={item.answer} />
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
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
  return (
    <ModalShell
      title="Q&A history"
      icon={<MessageSquareText className="h-3.5 w-3.5" />}
      open={open}
      onClose={onClose}
      wide
    >
      <HistoryList qa={qa} loading={loading} />
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
  const dot = (state: 'green' | 'amber' | 'gray', pulse?: boolean) =>
    cn(
      'h-1.5 w-1.5 rounded-full',
      pulse && 'animate-pulse',
      state === 'green' && 'bg-emerald-500',
      state === 'amber' && 'bg-amber-500',
      state === 'gray' && 'bg-neutral-400 dark:bg-neutral-600',
    );
  return (
    <div
      title={`transcribe: ${transcribe}, copilot WS: ${answer ? 'open' : 'closed'}, coding WS: ${coding ? 'open' : 'closed'}`}
      className="flex items-center gap-2 rounded-full bg-neutral-100 px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider text-neutral-500 dark:bg-neutral-800/80 dark:text-neutral-400"
    >
      <span className="flex items-center gap-1">
        <span
          className={dot(
            transcribe === 'live' ? 'green' : transcribe === 'error' ? 'amber' : 'gray',
            transcribe === 'live',
          )}
        />
        asr
      </span>
      <span className="h-2 w-px bg-neutral-300 dark:bg-neutral-700" />
      <span className="flex items-center gap-1">
        <span className={dot(answer ? 'green' : 'gray')} />
        cp
      </span>
      <span className="h-2 w-px bg-neutral-300 dark:bg-neutral-700" />
      <span className="flex items-center gap-1">
        <span className={dot(coding ? 'green' : 'gray')} />
        cd
      </span>
    </div>
  );
}

function ShortcutTable({ items }: { items: Array<{ keys: string; label: string }> }) {
  return (
    <table className="w-full text-sm">
      <tbody>
        {items.map((s) => (
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
  );
}

function ToggleRow({
  icon,
  title,
  description,
  checked,
  onChange,
  disabled,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label
      className={cn(
        'flex items-center justify-between gap-4 rounded-lg border border-neutral-200 px-3 py-2 dark:border-neutral-800',
        disabled && 'opacity-50',
      )}
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5 text-neutral-500 dark:text-neutral-400">{icon}</span>
        <div>
          <div className="font-medium text-neutral-800 dark:text-neutral-100">{title}</div>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">{description}</p>
        </div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          'relative inline-flex h-6 w-11 shrink-0 rounded-full transition-colors',
          checked ? 'bg-sky-600' : 'bg-neutral-300 dark:bg-neutral-700',
        )}
      >
        <span
          className={cn(
            'absolute top-0.5 h-5 w-5 rounded-full bg-white transition-transform',
            checked ? 'translate-x-5' : 'translate-x-0.5',
          )}
        />
      </button>
    </label>
  );
}
