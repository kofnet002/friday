'use client';

import {
  AlertTriangle,
  FileText,
  FolderGit2,
  Loader2,
  NotebookPen,
  Pencil,
  Plus,
  RefreshCw,
  TerminalSquare,
  Trash2,
  Wand2,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { Project, ProjectSource, ProjectSourceKind } from '@friday/shared-types';

import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Markdown } from '@/lib/markdown';
import {
  ProjectsApiError,
  deleteProject,
  deleteProjectSource,
  errorMessage,
  fetchProject,
  generateBrief,
  updateProject,
} from '@/lib/projects';
import { cn } from '@/lib/utils';

import { AddSource } from './add-source';
import { BriefStatusBadge, ErrorNote, formatChars } from './project-ui';

const POLL_MS = 2000;

const SOURCE_ICON: Record<ProjectSourceKind, typeof FileText> = {
  file: FileText,
  text: NotebookPen,
  folder: FolderGit2,
  claude_code: TerminalSquare,
};

export function ProjectDetail({
  projectId,
  reloadKey,
  onChanged,
  onDeleted,
  onAddFiles,
}: {
  projectId: string;
  /** Changing this refetches the project (e.g. after a drop on the card). */
  reloadKey?: number;
  /** Called after anything that changes the list row (sources, brief status). */
  onChanged: () => void;
  onDeleted: () => void;
  /** Queue several picked files on the card's uploader (progress shows there). */
  onAddFiles: (files: File[]) => void;
}) {
  const [project, setProject] = useState<Project | null>(null);
  const [sources, setSources] = useState<ProjectSource[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await fetchProject(projectId);
      setProject(data.project);
      setSources(data.sources);
      setLoadError(null);
      return data.project;
    } catch (err) {
      setLoadError(errorMessage(err));
      return null;
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load, reloadKey]);

  // Brief generation runs in the background — poll until it settles.
  const generating = project?.brief_status === 'generating';
  useEffect(() => {
    if (!generating) return;
    const id = window.setInterval(async () => {
      const next = await load();
      if (next && next.brief_status !== 'generating') onChanged();
    }, POLL_MS);
    return () => window.clearInterval(id);
  }, [generating, load, onChanged]);

  const refresh = async () => {
    await load();
    onChanged();
  };

  const removeSource = async (sourceId: string) => {
    setRemovingId(sourceId);
    setActionError(null);
    try {
      await deleteProjectSource(projectId, sourceId);
      await refresh();
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setRemovingId(null);
    }
  };

  const remove = async () => {
    setDeleting(true);
    setActionError(null);
    try {
      await deleteProject(projectId);
      onDeleted();
    } catch (err) {
      setActionError(errorMessage(err));
      setDeleting(false);
    }
  };

  if (loadError && !project) return <ErrorNote>{loadError}</ErrorNote>;
  if (!project) {
    return (
      <p className="flex items-center gap-2 text-xs text-neutral-500 dark:text-neutral-400">
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
        Loading project…
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      {project.description ? (
        <p className="whitespace-pre-wrap text-xs text-neutral-600 dark:text-neutral-400">
          {project.description}
        </p>
      ) : null}

      {/* Sources */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <SubHeading>Sources · {sources.length}</SubHeading>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() => setAddOpen((v) => !v)}
          >
            {addOpen ? (
              <X className="mr-1 h-3.5 w-3.5" aria-hidden />
            ) : (
              <Plus className="mr-1 h-3.5 w-3.5" aria-hidden />
            )}
            {addOpen ? 'Close' : 'Add source'}
          </Button>
        </div>

        {sources.length > 0 ? (
          <ul className="overflow-hidden rounded-lg border border-neutral-200 dark:border-neutral-800">
            {sources.map((s, i) => {
              const Icon = SOURCE_ICON[s.kind] ?? FileText;
              return (
                <li
                  key={s.id}
                  className={cn(
                    'flex items-center gap-2.5 px-3 py-2',
                    i > 0 && 'border-t border-neutral-200 dark:border-neutral-800',
                  )}
                >
                  <Icon className="h-3.5 w-3.5 shrink-0 text-neutral-400" aria-hidden />
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm text-neutral-800 dark:text-neutral-200">
                      {s.title}
                    </span>
                    <span className="truncate text-[11px] text-neutral-500 dark:text-neutral-400">
                      {formatChars(s.chars)}
                      {s.meta?.truncated ? ' · truncated' : ''}
                      {s.origin && s.origin !== s.title ? ` · ${s.origin}` : ''}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => void removeSource(s.id)}
                    disabled={removingId === s.id}
                    aria-label={`Remove ${s.title}`}
                    title="Remove source"
                    className="rounded-md p-1 text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-red-600 disabled:opacity-50 dark:hover:bg-neutral-800 dark:hover:text-red-400"
                  >
                    {removingId === s.id ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                    ) : (
                      <Trash2 className="h-3.5 w-3.5" aria-hidden />
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        ) : !addOpen ? (
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            No sources yet — add or drop files, notes, a repo folder or Claude Code sessions.
          </p>
        ) : null}

        {addOpen ? (
          <AddSource
            projectId={projectId}
            onAdded={() => {
              setAddOpen(false);
              void refresh();
            }}
            onAddFiles={(files) => {
              setAddOpen(false);
              onAddFiles(files);
            }}
          />
        ) : null}
      </div>

      <BriefPanel
        project={project}
        hasSources={sources.length > 0}
        onProject={(p) => {
          setProject(p);
          onChanged();
        }}
      />

      {actionError ? <ErrorNote>{actionError}</ErrorNote> : null}

      {/* Danger zone */}
      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-neutral-200 pt-3 dark:border-neutral-800">
        {confirmDelete ? (
          <>
            <span className="mr-auto text-xs text-neutral-600 dark:text-neutral-300">
              Delete “{project.name}” and all its sources?
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8"
              onClick={() => setConfirmDelete(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              className="h-8 bg-red-600 text-white hover:bg-red-700 dark:bg-red-600 dark:text-white dark:hover:bg-red-700"
              disabled={deleting}
              onClick={() => void remove()}
            >
              {deleting ? 'Deleting…' : 'Delete project'}
            </Button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmDelete(true)}
            className="inline-flex items-center gap-1.5 text-xs text-neutral-500 transition-colors hover:text-red-600 dark:text-neutral-400 dark:hover:text-red-400"
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden />
            Delete project
          </button>
        )}
      </div>
    </div>
  );
}

function BriefPanel({
  project,
  hasSources,
  onProject,
}: {
  project: Project;
  hasSources: boolean;
  onProject: (p: Project) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [starting, setStarting] = useState(false);
  const [confirmOverwrite, setConfirmOverwrite] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const status = project.brief_status;
  const generating = status === 'generating';
  const hasBrief = Boolean(project.brief?.trim());

  const generate = async (force: boolean) => {
    setStarting(true);
    setError(null);
    try {
      onProject(await generateBrief(project.id, force));
      setConfirmOverwrite(false);
      setDraft(null);
    } catch (err) {
      if (err instanceof ProjectsApiError && err.status === 409) setConfirmOverwrite(true);
      else setError(errorMessage(err));
    } finally {
      setStarting(false);
    }
  };

  const save = async () => {
    if (draft === null) return;
    setSaving(true);
    setError(null);
    try {
      onProject(await updateProject(project.id, { brief: draft }));
      setDraft(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <SubHeading>Brief</SubHeading>
          <BriefStatusBadge status={status} />
          {project.brief_edited ? (
            <span className="text-[10px] uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
              edited
            </span>
          ) : project.brief_model && hasBrief ? (
            <span className="truncate font-mono text-[10px] text-neutral-500 dark:text-neutral-400">
              {project.brief_model}
            </span>
          ) : null}
        </div>
        {draft === null ? (
          <div className="flex items-center gap-1">
            {hasBrief && !generating ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={() => {
                  setDraft(project.brief ?? '');
                  setConfirmOverwrite(false);
                }}
              >
                <Pencil className="mr-1 h-3.5 w-3.5" aria-hidden />
                Edit
              </Button>
            ) : null}
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 px-2 text-xs"
              disabled={!hasSources || generating || starting}
              title={hasSources ? undefined : 'Add at least one source first'}
              onClick={() => void generate(false)}
            >
              {generating || starting ? (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" aria-hidden />
              ) : hasBrief ? (
                <RefreshCw className="mr-1 h-3.5 w-3.5" aria-hidden />
              ) : (
                <Wand2 className="mr-1 h-3.5 w-3.5" aria-hidden />
              )}
              {generating ? 'Generating…' : hasBrief ? 'Regenerate' : 'Generate brief'}
            </Button>
          </div>
        ) : null}
      </div>

      {confirmOverwrite ? (
        <div className="flex flex-col gap-2 rounded-md border border-amber-300 bg-amber-50/70 px-3 py-2 text-xs text-amber-800 sm:flex-row sm:items-center sm:justify-between dark:border-amber-500/30 dark:bg-amber-950/30 dark:text-amber-200">
          <span>You edited this brief by hand. Regenerating will overwrite your edits.</span>
          <div className="flex shrink-0 gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => setConfirmOverwrite(false)}
            >
              Keep edits
            </Button>
            <Button
              type="button"
              size="sm"
              className="h-7 px-2 text-xs"
              disabled={starting}
              onClick={() => void generate(true)}
            >
              Overwrite
            </Button>
          </div>
        </div>
      ) : null}

      {generating ? (
        <p className="flex items-center gap-2 rounded-md border border-sky-200 bg-sky-50/60 px-3 py-2 text-xs text-sky-700 dark:border-sky-500/30 dark:bg-sky-950/30 dark:text-sky-300">
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden />
          Reading the sources and writing the brief — this can take a minute.
        </p>
      ) : null}

      {status === 'stale' && draft === null ? (
        <p className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50/70 px-3 py-2 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-950/30 dark:text-amber-200">
          <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
          Sources changed since this brief was written. Regenerate to include them.
        </p>
      ) : null}

      {status === 'error' && project.brief_error ? (
        <ErrorNote>Brief generation failed: {project.brief_error}</ErrorNote>
      ) : null}

      {error ? <ErrorNote>{error}</ErrorNote> : null}

      {draft !== null ? (
        <div className="flex flex-col gap-2">
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className="min-h-[280px] font-mono text-xs leading-relaxed"
            aria-label="Brief markdown"
          />
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8"
              onClick={() => setDraft(null)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              className="h-8"
              disabled={saving || !draft.trim()}
              onClick={() => void save()}
            >
              {saving ? 'Saving…' : 'Save brief'}
            </Button>
          </div>
        </div>
      ) : hasBrief ? (
        <div
          className={cn(
            'max-h-[28rem] overflow-y-auto rounded-lg border border-neutral-200 bg-neutral-50/40 px-4 py-1 dark:border-neutral-800 dark:bg-neutral-900/30',
            generating && 'opacity-60',
          )}
        >
          <Markdown text={project.brief ?? ''} />
        </div>
      ) : !generating ? (
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          {hasSources
            ? 'Generate a brief to distill the sources into talking points Friday can use live.'
            : 'Add sources, then generate a brief.'}
        </p>
      ) : null}
    </div>
  );
}

function SubHeading({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[11px] font-medium uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
      {children}
    </span>
  );
}
