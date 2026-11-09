'use client';

import { FileText, MessageSquare } from 'lucide-react';
import { useEffect, useState } from 'react';

import { AudioBudgetPill } from '@/app/session/answer-panel';
import { Button } from '@/components/ui/button';
import { fetchSessionsOverview, type SessionsOverview } from '@/lib/session-context';
import { cn } from '@/lib/utils';

const SHOWN = 8;

/** Recent sessions with what each has used, so a spent audio budget or a
 *  long-running session is visible before the interview, not during it. */
export function SessionsList({
  sessionId,
  refreshKey,
  onSwitch,
}: {
  sessionId: string;
  /** Bump to refetch (e.g. after starting a new session). */
  refreshKey: number;
  onSwitch: (id: string) => void;
}) {
  const [data, setData] = useState<SessionsOverview | null>(null);
  const [failed, setFailed] = useState(false);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    let live = true;
    fetchSessionsOverview(30).then((res) => {
      if (!live) return;
      setData(res);
      setFailed(res === null);
    });
    return () => {
      live = false;
    };
  }, [sessionId, refreshKey]);

  if (failed) {
    return (
      <p className="text-xs text-neutral-500">Couldn&apos;t load sessions from the backend.</p>
    );
  }
  if (!data) return <p className="text-xs text-neutral-500">Loading sessions…</p>;

  const isSaved = data.sessions.some((s) => s.session_id === sessionId);
  const rows = showAll ? data.sessions : data.sessions.slice(0, SHOWN);

  return (
    <div className="flex flex-col gap-2">
      {!isSaved && sessionId ? (
        <div className="rounded-lg border border-dashed border-sky-400/60 px-3 py-2 text-xs text-sky-700 dark:text-sky-300">
          Current session <span className="font-mono">{sessionId.slice(0, 8)}</span> is new. It
          appears here once you start it.
        </div>
      ) : null}
      {data.sessions.length === 0 ? (
        <p className="text-xs text-neutral-500">No saved sessions yet.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-neutral-200 rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
          {rows.map((s) => {
            const current = s.session_id === sessionId;
            const title =
              [s.job_title, s.company].filter(Boolean).join(' · ') || 'Untitled session';
            return (
              <li
                key={s.session_id}
                className={cn(
                  'flex items-center gap-3 px-3 py-2',
                  current && 'bg-sky-50/70 dark:bg-sky-950/30',
                )}
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-neutral-800 dark:text-neutral-100">
                    {title}
                  </p>
                  <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-neutral-500">
                    <span className="font-mono">{s.session_id.slice(0, 8)}</span>
                    <span>{formatWhen(s.last_active_at)}</span>
                    <span className="inline-flex items-center gap-0.5" title="Answered questions">
                      <MessageSquare className="h-3 w-3" aria-hidden />
                      {s.qa_count}
                    </span>
                    <span title="LLM spend">${s.cost_usd.toFixed(s.cost_usd >= 0.01 ? 2 : 4)}</span>
                    {s.has_resume ? (
                      <span className="inline-flex items-center gap-0.5" title="Has a resume">
                        <FileText className="h-3 w-3" aria-hidden />
                        resume
                      </span>
                    ) : null}
                  </p>
                </div>
                <AudioBudgetPill
                  usage={{ used: s.audio_minutes_used, limit: data.audio_minutes_limit }}
                />
                {current ? (
                  <span className="w-16 text-center text-[11px] font-medium uppercase tracking-wider text-sky-700 dark:text-sky-300">
                    Current
                  </span>
                ) : (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="w-16"
                    onClick={() => onSwitch(s.session_id)}
                  >
                    Switch
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {data.sessions.length > SHOWN ? (
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          className="self-start text-xs text-neutral-500 underline-offset-2 hover:text-neutral-800 hover:underline dark:hover:text-neutral-200"
        >
          {showAll ? 'Show fewer' : `Show all ${data.sessions.length}`}
        </button>
      ) : null}
    </div>
  );
}

function formatWhen(ts: number): string {
  const d = new Date(ts * 1000);
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOfDay(new Date()) - startOfDay(d)) / 86_400_000);
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (days === 0) return `today ${time}`;
  if (days === 1) return `yesterday ${time}`;
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}
