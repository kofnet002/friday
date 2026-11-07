'use client';

import { FolderKanban } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { Project } from '@friday/shared-types';

import { Markdown } from '@/lib/markdown';
import { fetchSessionProjects } from '@/lib/projects';

import { BriefStatusBadge } from '../setup/project-ui';
import { ModalShell } from './session-modals';

/** Attached-project chips for the overflow menu's Status block. Fetches on
 *  mount — the menu unmounts when closed, so each open is fresh after the
 *  user changes attachments in Setup. Renders nothing when none attached. */
export function AttachedProjectChips({
  sessionId,
  onOpen,
}: {
  sessionId: string;
  onOpen: (project: Project) => void;
}) {
  const [projects, setProjects] = useState<Project[]>([]);

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    fetchSessionProjects(sessionId)
      .then((rows) => {
        if (!cancelled) setProjects(rows);
      })
      .catch(() => {
        /* backend down — the menu just omits the row */
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  if (projects.length === 0) return null;
  return (
    <div className="flex items-start justify-between gap-2">
      <span className="shrink-0 text-neutral-600 dark:text-neutral-400">Projects</span>
      <div className="flex min-w-0 flex-wrap justify-end gap-1">
        {projects.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => onOpen(p)}
            title={`View the “${p.name}” brief`}
            className="inline-flex max-w-[10rem] items-center gap-1 rounded-full bg-black/5 px-2 py-0.5 text-[10px] text-neutral-700 transition-colors hover:bg-sky-500/15 hover:text-sky-700 dark:bg-white/5 dark:text-neutral-300 dark:hover:bg-sky-400/15 dark:hover:text-sky-300"
          >
            <FolderKanban className="h-2.5 w-2.5 shrink-0" aria-hidden />
            <span className="truncate">{p.name}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** Read-only view of an attached project's brief. */
export function ProjectBriefModal({
  project,
  onClose,
}: {
  project: Project | null;
  onClose: () => void;
}) {
  return (
    <ModalShell
      title={project?.name ?? 'Project'}
      icon={<FolderKanban className="h-3.5 w-3.5" />}
      open={project !== null}
      onClose={onClose}
      wide
    >
      {project ? (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <BriefStatusBadge status={project.brief_status} />
            {project.brief_status === 'stale' ? (
              <span className="text-xs text-neutral-500 dark:text-neutral-400">
                Sources changed since this brief was written.
              </span>
            ) : null}
          </div>
          {project.brief?.trim() ? (
            <Markdown text={project.brief} />
          ) : (
            <p className="text-sm text-neutral-500 dark:text-neutral-400">
              No brief yet — generate one from Setup → Projects. Until then, live answers fall back
              to the raw sources when they fit.
            </p>
          )}
        </div>
      ) : null}
    </ModalShell>
  );
}
