'use client';

import { useEffect, useState } from 'react';
import { Eye, EyeOff, MonitorUp, Shield, ShieldAlert, VenetianMask } from 'lucide-react';
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
          {[...SESSION_SHORTCUTS, ...DESKTOP_SHORTCUTS].map((s) => (
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

export function SettingsModal({
  open,
  onClose,
  desktopStatus,
  stealthMode,
  privacyMode,
  onStealthModeChange,
  onPrivacyModeChange,
  onPreferenceChange,
  onCenterWindow,
}: {
  open: boolean;
  onClose: () => void;
  desktopStatus: FridayWindowStatus | null;
  stealthMode: boolean;
  privacyMode: boolean;
  onStealthModeChange: () => void;
  onPrivacyModeChange: (value: boolean) => void;
  onPreferenceChange: (patch: Partial<FridayWindowPreferences>) => void;
  onCenterWindow: () => void;
}) {
  const prefs = desktopStatus?.preferences;

  return (
    <ModalShell title="Window settings" open={open} onClose={onClose} wide>
      <div className="flex flex-col gap-6 text-sm">
        <section className="flex flex-col gap-3">
          <div>
            <h3 className="font-semibold text-neutral-800 dark:text-neutral-100">
              Desktop controls
            </h3>
            <p className="mt-1 text-neutral-500 dark:text-neutral-400">
              Visible desktop settings for keeping Friday compact, movable, and easy to recover in
              development.
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
            icon={<MonitorUp className="h-4 w-4" />}
            title="Always on top"
            description="Keep the visible app above normal windows."
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
              prefs?.hideWindowControls ? (
                <EyeOff className="h-4 w-4" />
              ) : (
                <Eye className="h-4 w-4" />
              )
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

        <section className="flex flex-col gap-3">
          <div>
            <h3 className="font-semibold text-neutral-800 dark:text-neutral-100">Hotkeys</h3>
            <p className="mt-1 text-neutral-500 dark:text-neutral-400">
              These shortcuts work globally in the desktop app.
            </p>
          </div>
          <ShortcutTable items={DESKTOP_SHORTCUTS} />
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
        </section>
      </div>
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
