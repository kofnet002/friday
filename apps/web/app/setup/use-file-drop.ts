'use client';

import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';

import { addProjectSource, errorMessage, uploadProjectFile } from '@/lib/projects';

// Mirrors TEXT_EXTENSIONS in app.services.context_sources.files plus PDF/DOCX.
const UPLOAD_EXTENSIONS = [
  '.pdf',
  '.docx',
  '.md',
  '.markdown',
  '.txt',
  '.rst',
  '.json',
  '.jsonl',
  '.yaml',
  '.yml',
  '.toml',
  '.csv',
  '.diff',
  '.patch',
  '.py',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.swift',
  '.rb',
  '.php',
  '.cs',
  '.cpp',
  '.c',
  '.h',
  '.hpp',
  '.sql',
  '.sh',
  '.html',
  '.css',
  '.scss',
  '.vue',
  '.svelte',
];

export const UPLOAD_ACCEPT = UPLOAD_EXTENSIONS.join(',');

/** Matches MAX_UPLOAD_BYTES in app.api.projects. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export const FOLDER_DROP_UNSUPPORTED =
  'Folders can be dropped in the Friday desktop app — in the browser, use the Folder tab and paste the path.';

/** Client-side mirror of the backend's upload checks. Returns an error
 *  message, or null when the file looks acceptable. */
export function checkUploadFile(file: File): string | null {
  const name = file.name.toLowerCase();
  const typeOk =
    UPLOAD_EXTENSIONS.some((ext) => name.endsWith(ext)) ||
    file.type.startsWith('text/') ||
    file.type.endsWith('pdf') ||
    file.type.includes('wordprocessingml');
  if (!typeOk) return 'Unsupported file type — use PDF, DOCX, Markdown, text or code';
  if (file.size > MAX_UPLOAD_BYTES) return 'Too large (25 MB max)';
  if (file.size === 0) return 'Empty file';
  return null;
}

export type DroppedItem =
  | { kind: 'file'; file: File }
  | { kind: 'folder'; name: string; file: File | null };

function carriesFiles(e: DragEvent | globalThis.DragEvent): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes('Files');
}

/** Read the dropped entries. Must run synchronously inside the drop event —
 *  the DataTransfer is emptied once the handler returns. */
function readDropped(dt: DataTransfer): DroppedItem[] {
  const items = Array.from(dt.items ?? []).filter((it) => it.kind === 'file');
  if (items.length === 0) {
    return Array.from(dt.files).map((file) => ({ kind: 'file', file }));
  }
  const out: DroppedItem[] = [];
  for (const item of items) {
    const entry = item.webkitGetAsEntry?.() ?? null;
    const file = item.getAsFile();
    if (entry?.isDirectory) out.push({ kind: 'folder', name: entry.name, file });
    else if (file) out.push({ kind: 'file', file });
  }
  return out;
}

/** Turns an element into a file drop target. Spread `dropHandlers` onto it
 *  and render an overlay while `dragging`. Only reacts to drags carrying
 *  files, so text/element drags inside the target behave normally. */
export function useFileDrop(onDrop: (items: DroppedItem[]) => void) {
  const [dragging, setDragging] = useState(false);
  // dragenter/dragleave fire for every child crossed; count them so moving
  // between children doesn't flicker the overlay.
  const depth = useRef(0);

  const dropHandlers = {
    onDragEnter: (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      e.preventDefault();
      depth.current += 1;
      setDragging(true);
    },
    onDragOver: (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    },
    onDragLeave: (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDragging(false);
    },
    onDrop: (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      e.preventDefault();
      // Nested drop targets (none today) must not double-handle.
      e.stopPropagation();
      depth.current = 0;
      setDragging(false);
      const items = readDropped(e.dataTransfer);
      if (items.length > 0) onDrop(items);
    },
  };

  return { dragging, dropHandlers };
}

/** Stop a file dropped outside any drop target from replacing the page
 *  (the browser default is to open it). Mount for the page's lifetime. */
export function useWindowDropGuard() {
  useEffect(() => {
    const guard = (e: globalThis.DragEvent) => {
      // A drop target already handled it (React's root listener runs first).
      if (e.defaultPrevented || !carriesFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'none';
    };
    window.addEventListener('dragover', guard);
    window.addEventListener('drop', guard);
    return () => {
      window.removeEventListener('dragover', guard);
      window.removeEventListener('drop', guard);
    };
  }, []);
}

export type UploadFailure = { name: string; error: string };

export type UploadStatus =
  | { phase: 'working'; current: number; total: number; name: string }
  | { phase: 'done'; added: number; total: number; failures: UploadFailure[] };

const SUCCESS_DISMISS_MS = 6000;

/** Adds dropped/picked files and folders to a project one at a time. Items
 *  added while a run is in progress join the queue (the total grows).
 *  `onFinished` fires once the queue drains with at least one success. */
export function useSourceQueue(projectId: string, onFinished: () => void) {
  const [status, setStatus] = useState<UploadStatus | null>(null);
  const queue = useRef<DroppedItem[]>([]);
  const running = useRef(false);
  const run = useRef({ done: 0, total: 0, added: 0, failures: [] as UploadFailure[] });
  const finishedRef = useRef(onFinished);
  useEffect(() => {
    finishedRef.current = onFinished;
  }, [onFinished]);

  const addOne = useCallback(
    async (item: DroppedItem): Promise<void> => {
      if (item.kind === 'folder') {
        const getPath = typeof window !== 'undefined' ? window.friday?.getPathForFile : undefined;
        if (!getPath) throw new Error(FOLDER_DROP_UNSUPPORTED);
        const path = item.file ? getPath(item.file) : '';
        if (!path) throw new Error('Could not read the folder path — use the Folder tab instead');
        await addProjectSource(projectId, { kind: 'folder', path });
        return;
      }
      const problem = checkUploadFile(item.file);
      if (problem) throw new Error(problem);
      await uploadProjectFile(projectId, item.file);
    },
    [projectId],
  );

  const add = useCallback(
    async (items: DroppedItem[]) => {
      if (items.length === 0) return;
      queue.current.push(...items);
      if (!running.current) {
        run.current = { done: 0, total: 0, added: 0, failures: [] };
      }
      run.current.total += items.length;
      if (running.current) {
        setStatus((s) => (s?.phase === 'working' ? { ...s, total: run.current.total } : s));
        return;
      }
      running.current = true;
      let item: DroppedItem | undefined;
      while ((item = queue.current.shift())) {
        const name = item.kind === 'folder' ? `${item.name}/` : item.file.name;
        setStatus({
          phase: 'working',
          current: run.current.done + 1,
          total: run.current.total,
          name,
        });
        try {
          await addOne(item);
          run.current.added += 1;
        } catch (err) {
          run.current.failures.push({ name, error: errorMessage(err) });
        }
        run.current.done += 1;
      }
      running.current = false;
      const { added, total, failures } = run.current;
      setStatus({ phase: 'done', added, total, failures: [...failures] });
      if (added > 0) finishedRef.current();
    },
    [addOne],
  );

  // A clean run's summary clears itself; failures stay until dismissed.
  useEffect(() => {
    if (status?.phase !== 'done' || status.failures.length > 0) return;
    const id = window.setTimeout(() => setStatus(null), SUCCESS_DISMISS_MS);
    return () => window.clearTimeout(id);
  }, [status]);

  const dismiss = useCallback(() => setStatus(null), []);

  return { status, add, dismiss };
}
