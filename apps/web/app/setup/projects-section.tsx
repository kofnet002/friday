'use client';

import { ChevronDown, FolderKanban, Loader2, Plus, Upload, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { ProjectSummary } from '@friday/shared-types';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  createProject,
  errorMessage,
  fetchSessionProjects,
  listProjects,
  setSessionProjects,
} from '@/lib/projects';
import { cn } from '@/lib/utils';

import { ProjectDetail } from './project-detail';
import {
  BriefStatusBadge,
  Checkbox,
  ErrorNote,
  FieldLabel,
  formatChars,
  stopImplicitSubmit,
} from './project-ui';
import {
  useFileDrop,
  useSourceQueue,
  useWindowDropGuard,
  type UploadStatus,
} from './use-file-drop';

/** Body of the setup screen's "Projects" section: the library of projects
 *  plus which ones are attached to the current session. */
export function ProjectsLibrary({ sessionId }: { sessionId: string }) {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [attached, setAttached] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  // Files dropped beside a project card must not navigate away from setup.
  useWindowDropGuard();

  const reload = useCallback(async () => {
    try {
      setProjects(await listProjects());
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
      setProjects((prev) => prev ?? []);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Attachments are per session — reload when "new session" swaps the id.
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    fetchSessionProjects(sessionId)
      .then((rows) => {
        if (!cancelled) setAttached(new Set(rows.map((p) => p.id)));
      })
      .catch(() => {
        if (!cancelled) setAttached(new Set());
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  const toggleAttach = async (projectId: string, on: boolean) => {
    const prev = attached;
    const next = new Set(prev);
    if (on) next.add(projectId);
    else next.delete(projectId);
    setAttached(next);
    try {
      const rows = await setSessionProjects(sessionId, [...next]);
      setAttached(new Set(rows.map((p) => p.id)));
    } catch (err) {
      setAttached(prev);
      setError(errorMessage(err));
    }
  };

  const onDeleted = (projectId: string) => {
    setExpandedId(null);
    setAttached((prev) => {
      const next = new Set(prev);
      next.delete(projectId);
      return next;
    });
    void reload();
  };

  return (
    <div className="flex flex-col gap-3">
      {projects === null ? (
        <p className="flex items-center gap-2 text-xs text-neutral-500 dark:text-neutral-400">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          Loading projects…
        </p>
      ) : projects.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {projects.map((p) => (
            <ProjectRow
              key={p.id}
              project={p}
              attached={attached.has(p.id)}
              expanded={expandedId === p.id}
              canAttach={Boolean(sessionId)}
              onToggleExpand={() => setExpandedId((cur) => (cur === p.id ? null : p.id))}
              onExpand={() => setExpandedId(p.id)}
              onToggleAttach={(on) => void toggleAttach(p.id, on)}
              onChanged={reload}
              onDeleted={() => onDeleted(p.id)}
            />
          ))}
        </ul>
      ) : !creating && !error ? (
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          No projects yet. Create one for a repo you shipped or a PR you&apos;ll be asked about.
        </p>
      ) : null}

      {error ? <ErrorNote>{error}</ErrorNote> : null}

      {creating ? (
        <NewProjectForm
          onCancel={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            setExpandedId(id);
            void reload();
          }}
        />
      ) : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="self-start"
          onClick={() => setCreating(true)}
        >
          <Plus className="mr-1.5 h-3.5 w-3.5" aria-hidden />
          New project
        </Button>
      )}
    </div>
  );
}

function ProjectRow({
  project,
  attached,
  expanded,
  canAttach,
  onToggleExpand,
  onExpand,
  onToggleAttach,
  onChanged,
  onDeleted,
}: {
  project: ProjectSummary;
  attached: boolean;
  expanded: boolean;
  canAttach: boolean;
  onToggleExpand: () => void;
  onExpand: () => void;
  onToggleAttach: (on: boolean) => void;
  onChanged: () => void;
  onDeleted: () => void;
}) {
  // Bumped after dropped sources land so an open detail refetches.
  const [reloadKey, setReloadKey] = useState(0);
  const onQueueFinished = useCallback(() => {
    setReloadKey((k) => k + 1);
    onChanged();
  }, [onChanged]);
  const sourceQueue = useSourceQueue(project.id, onQueueFinished);
  const { dragging, dropHandlers } = useFileDrop((items) => {
    onExpand();
    void sourceQueue.add(items);
  });
  const addFiles = (files: File[]) =>
    void sourceQueue.add(files.map((file) => ({ kind: 'file' as const, file })));

  return (
    <li
      {...dropHandlers}
      className={cn(
        'relative rounded-xl border transition-colors',
        attached
          ? 'border-sky-300 bg-sky-50/30 dark:border-sky-500/40 dark:bg-sky-950/10'
          : 'border-neutral-200 dark:border-neutral-800',
      )}
    >
      <div className="flex items-start gap-3 px-3.5 py-3">
        <button
          type="button"
          onClick={onToggleExpand}
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 items-start gap-2.5 text-left"
        >
          <FolderKanban
            className="mt-0.5 h-4 w-4 shrink-0 text-neutral-400 dark:text-neutral-500"
            aria-hidden
          />
          <span className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="truncate text-sm font-medium text-neutral-900 dark:text-neutral-100">
              {project.name}
            </span>
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-neutral-500 dark:text-neutral-400">
              <span>
                {project.source_count} source{project.source_count === 1 ? '' : 's'}
                {project.source_chars ? ` · ${formatChars(project.source_chars)}` : ''}
              </span>
              <BriefStatusBadge status={project.brief_status} />
            </span>
          </span>
          <ChevronDown
            className={cn(
              'mt-0.5 h-4 w-4 shrink-0 text-neutral-400 transition-transform',
              expanded && 'rotate-180',
            )}
            aria-hidden
          />
        </button>
      </div>
      <div role="status" aria-live="polite">
        {sourceQueue.status ? (
          <DropStatus status={sourceQueue.status} onDismiss={sourceQueue.dismiss} />
        ) : null}
      </div>
      <div className="flex items-center border-t border-neutral-200/70 px-3.5 py-2 dark:border-neutral-800/70">
        <Checkbox checked={attached} onChange={onToggleAttach} disabled={!canAttach}>
          Attach to this session
        </Checkbox>
      </div>
      {expanded ? (
        <div className="border-t border-neutral-200 px-3.5 py-4 dark:border-neutral-800">
          <ProjectDetail
            projectId={project.id}
            reloadKey={reloadKey}
            onChanged={onChanged}
            onDeleted={onDeleted}
            onAddFiles={addFiles}
          />
        </div>
      ) : null}
      {dragging ? (
        <div
          aria-hidden
          className={cn(
            'pointer-events-none absolute inset-0 z-10 flex justify-center rounded-xl border-2 border-dashed border-sky-400 bg-sky-50/90 p-3 backdrop-blur-[1px] dark:border-sky-400/70 dark:bg-sky-950/85',
            expanded ? 'items-start pt-6' : 'items-center',
          )}
        >
          <span className="sticky top-6 flex max-w-full items-center gap-2 text-sm font-medium text-sky-700 dark:text-sky-200">
            <Upload className="h-4 w-4 shrink-0" />
            <span className="truncate">Drop files to add to {project.name}</span>
          </span>
        </div>
      ) : null}
    </li>
  );
}

function DropStatus({ status, onDismiss }: { status: UploadStatus; onDismiss: () => void }) {
  if (status.phase === 'working') {
    return (
      <p className="flex min-w-0 items-center gap-2 px-3.5 pb-3 text-xs text-sky-700 dark:text-sky-300">
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden />
        <span className="shrink-0">
          Adding {status.current} of {status.total}…
        </span>
        <span className="truncate text-neutral-500 dark:text-neutral-400">{status.name}</span>
      </p>
    );
  }
  const { added, total, failures } = status;
  const ok = failures.length === 0;
  const summary = ok
    ? `Added ${added} source${added === 1 ? '' : 's'}.`
    : added > 0
      ? `Added ${added} of ${total} · ${failures.length} failed.`
      : total === 1
        ? 'Could not add the dropped item.'
        : `Could not add any of the ${total} items.`;
  return (
    <div className="px-3.5 pb-3">
      <div
        className={cn(
          'flex items-start gap-2 rounded-md border px-3 py-2 text-xs',
          ok
            ? 'border-emerald-300 bg-emerald-50/70 text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-950/30 dark:text-emerald-200'
            : 'border-red-400/50 bg-red-50 text-red-700 dark:border-red-500/30 dark:bg-red-950/40 dark:text-red-300',
        )}
      >
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="font-medium">{summary}</span>
          {failures.length > 0 ? (
            <ul className="flex flex-col gap-0.5">
              {failures.map((f, i) => (
                <li key={`${f.name}-${i}`} className="break-words">
                  <span className="font-mono">{f.name}</span> — {f.error}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="-m-0.5 shrink-0 rounded p-0.5 opacity-70 transition-opacity hover:opacity-100"
        >
          <X className="h-3.5 w-3.5" aria-hidden />
        </button>
      </div>
    </div>
  );
}

function NewProjectForm({
  onCancel,
  onCreated,
}: {
  onCancel: () => void;
  onCreated: (projectId: string) => void;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const project = await createProject(name.trim(), description.trim() || undefined);
      onCreated(project.id);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-dashed border-neutral-300 p-3.5 dark:border-neutral-700">
      <FieldLabel label="Project name">
        <Input
          autoFocus
          value={name}
          maxLength={120}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={stopImplicitSubmit(() => void submit())}
          placeholder="e.g. Payments ledger rewrite"
        />
      </FieldLabel>
      <FieldLabel label="Description (optional)">
        <Textarea
          value={description}
          maxLength={4000}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What it is and your role — helps the brief focus."
          className="min-h-[64px]"
        />
      </FieldLabel>
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" size="sm" className="h-8" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          className="h-8"
          disabled={!name.trim() || busy}
          onClick={() => void submit()}
        >
          {busy ? 'Creating…' : 'Create project'}
        </Button>
      </div>
    </div>
  );
}
