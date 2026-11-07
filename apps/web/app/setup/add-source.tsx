'use client';

import { ClipboardPaste, FolderGit2, Loader2, TerminalSquare, Upload } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import type { ClaudeCodeProject, ProjectSourceCreated } from '@friday/shared-types';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import {
  addProjectSource,
  errorMessage,
  listClaudeCodeProjects,
  uploadProjectFile,
} from '@/lib/projects';
import { cn } from '@/lib/utils';

import {
  Checkbox,
  ErrorNote,
  FieldLabel,
  formatBytes,
  formatDate,
  stopImplicitSubmit,
} from './project-ui';
import { UPLOAD_ACCEPT, checkUploadFile } from './use-file-drop';

type Tab = 'upload' | 'paste' | 'folder' | 'claude_code';

const TABS: Array<{ key: Tab; label: string; icon: typeof Upload }> = [
  { key: 'upload', label: 'Upload', icon: Upload },
  { key: 'paste', label: 'Paste', icon: ClipboardPaste },
  { key: 'folder', label: 'Folder', icon: FolderGit2 },
  { key: 'claude_code', label: 'Claude Code', icon: TerminalSquare },
];

export function AddSource({
  projectId,
  onAdded,
  onAddFiles,
}: {
  projectId: string;
  onAdded: (sources: ProjectSourceCreated[]) => void;
  /** Several files picked at once go to the card's sequential uploader. */
  onAddFiles: (files: File[]) => void;
}) {
  const [tab, setTab] = useState<Tab>('upload');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (fn: () => Promise<ProjectSourceCreated[]>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      onAdded(await fn());
      return true;
    } catch (err) {
      setError(errorMessage(err));
      return false;
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">
      <div
        role="tablist"
        aria-label="Source type"
        className="flex flex-wrap items-center gap-1 rounded-lg border border-neutral-200 bg-neutral-50/60 p-1 dark:border-neutral-800 dark:bg-neutral-900/40"
      >
        {TABS.map(({ key, label, icon: Icon }) => {
          const active = key === tab;
          return (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => {
                setTab(key);
                setError(null);
              }}
              className={cn(
                'flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium transition-colors',
                active
                  ? 'bg-white text-sky-700 shadow-sm dark:bg-neutral-800 dark:text-sky-300'
                  : 'text-neutral-500 hover:bg-white/60 hover:text-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-800/50 dark:hover:text-neutral-200',
              )}
            >
              <Icon className="h-3.5 w-3.5" aria-hidden />
              {label}
            </button>
          );
        })}
      </div>

      {tab === 'upload' ? (
        <UploadTab
          busy={busy}
          onSubmit={(file, title) => {
            const problem = checkUploadFile(file);
            if (problem) {
              setError(`${file.name}: ${problem}`);
              return Promise.resolve(false);
            }
            return run(() => uploadProjectFile(projectId, file, title));
          }}
          onSubmitMany={onAddFiles}
        />
      ) : tab === 'paste' ? (
        <PasteTab
          busy={busy}
          onSubmit={(title, text) =>
            run(() => addProjectSource(projectId, { kind: 'text', title, text }))
          }
        />
      ) : tab === 'folder' ? (
        <FolderTab
          busy={busy}
          onSubmit={(path, includeDiff) =>
            run(() =>
              addProjectSource(projectId, { kind: 'folder', path, include_diff: includeDiff }),
            )
          }
        />
      ) : (
        <ClaudeCodeTab
          busy={busy}
          onSubmit={(dir, sessionIds, includeRepo) =>
            run(() =>
              addProjectSource(projectId, {
                kind: 'claude_code',
                project_dir: dir,
                session_ids: sessionIds,
                include_repo: includeRepo,
              }),
            )
          }
        />
      )}

      {error ? <ErrorNote>{error}</ErrorNote> : null}
    </div>
  );
}

function SubmitRow({
  busy,
  disabled,
  label,
  busyLabel,
  onClick,
  children,
}: {
  busy: boolean;
  disabled?: boolean;
  label: string;
  busyLabel: string;
  onClick: () => void;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="min-w-0">{children}</div>
      <Button type="button" size="sm" disabled={busy || disabled} onClick={onClick}>
        {busy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
        {busy ? busyLabel : label}
      </Button>
    </div>
  );
}

function UploadTab({
  busy,
  onSubmit,
  onSubmitMany,
}: {
  busy: boolean;
  onSubmit: (file: File, title?: string) => Promise<boolean>;
  onSubmitMany: (files: File[]) => void;
}) {
  const [files, setFiles] = useState<File[]>([]);
  const [title, setTitle] = useState('');
  const [inputKey, setInputKey] = useState(0);
  const single = files.length === 1 ? files[0] : null;

  const reset = () => {
    setFiles([]);
    setTitle('');
    setInputKey((k) => k + 1);
  };

  const submit = async () => {
    if (files.length === 0) return;
    if (!single) {
      onSubmitMany(files);
      reset();
      return;
    }
    if (await onSubmit(single, title.trim() || undefined)) reset();
  };

  const totalBytes = files.reduce((n, f) => n + f.size, 0);

  return (
    <div className="flex flex-col gap-3">
      {/* Drops here bubble to the project card's drop handler. */}
      <label
        className={cn(
          'group flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-lg border-2 border-dashed px-4 py-5 text-center transition-colors',
          files.length > 0
            ? 'border-sky-400/60 bg-sky-50/40 dark:border-sky-400/30 dark:bg-sky-950/20'
            : 'border-neutral-300 hover:border-sky-400 hover:bg-sky-50/40 dark:border-neutral-700 dark:hover:border-sky-400 dark:hover:bg-sky-950/20',
        )}
      >
        <input
          key={inputKey}
          type="file"
          multiple
          accept={UPLOAD_ACCEPT}
          onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
          className="sr-only"
        />
        <Upload
          className="h-4 w-4 text-neutral-400 group-hover:text-sky-500 dark:text-neutral-500"
          aria-hidden
        />
        <p className="max-w-full truncate text-sm font-medium text-neutral-800 dark:text-neutral-200">
          {single
            ? single.name
            : files.length > 1
              ? `${files.length} files`
              : 'Click or drop files'}
        </p>
        <p className="max-w-full truncate text-xs text-neutral-500 dark:text-neutral-400">
          {files.length > 1
            ? `${formatBytes(totalBytes)} · ${files.map((f) => f.name).join(', ')}`
            : single
              ? formatBytes(single.size)
              : 'PDF, DOCX, Markdown, text or source code · 25 MB max each'}
        </p>
      </label>
      {files.length > 1 ? null : (
        <FieldLabel label="Title (optional)">
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={stopImplicitSubmit(submit)}
            placeholder="Defaults to the file name"
          />
        </FieldLabel>
      )}
      <SubmitRow
        busy={busy}
        disabled={files.length === 0}
        label={files.length > 1 ? `Add ${files.length} files` : 'Add file'}
        busyLabel="Uploading…"
        onClick={submit}
      />
    </div>
  );
}

function PasteTab({
  busy,
  onSubmit,
}: {
  busy: boolean;
  onSubmit: (title: string | undefined, text: string) => Promise<boolean>;
}) {
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');

  const submit = async () => {
    if (!text.trim()) return;
    if (await onSubmit(title.trim() || undefined, text)) {
      setTitle('');
      setText('');
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <FieldLabel label="Title (optional)">
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={stopImplicitSubmit()}
          placeholder="e.g. PR description, design doc notes"
        />
      </FieldLabel>
      <FieldLabel label="Text">
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Paste a README, PR description, design notes…"
          className="min-h-[140px] font-mono text-xs"
        />
      </FieldLabel>
      <SubmitRow
        busy={busy}
        disabled={!text.trim()}
        label="Add text"
        busyLabel="Adding…"
        onClick={submit}
      />
    </div>
  );
}

function FolderTab({
  busy,
  onSubmit,
}: {
  busy: boolean;
  onSubmit: (path: string, includeDiff: boolean) => Promise<boolean>;
}) {
  const [path, setPath] = useState('');
  const [includeDiff, setIncludeDiff] = useState(false);

  const [picking, setPicking] = useState(false);
  // Desktop only: the native picker (hidden from screen capture in stealth).
  const [chooseFolder, setChooseFolder] = useState<FridayApi['chooseFolder']>();
  useEffect(() => setChooseFolder(() => window.friday?.chooseFolder), []);

  const submit = async () => {
    if (!path.trim()) return;
    if (await onSubmit(path.trim(), includeDiff)) setPath('');
  };

  const pick = async () => {
    if (!chooseFolder) return;
    setPicking(true);
    try {
      const { path: chosen } = await chooseFolder();
      if (chosen) setPath(chosen);
    } finally {
      setPicking(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <FieldLabel label="Absolute folder path">
        <div className="flex gap-2">
          <Input
            value={path}
            onChange={(e) => setPath(e.target.value)}
            onKeyDown={stopImplicitSubmit(submit)}
            placeholder="/Users/you/code/my-repo"
            className="font-mono text-xs"
            spellCheck={false}
          />
          {chooseFolder ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-9 shrink-0"
              onClick={pick}
              disabled={busy || picking}
            >
              {picking ? 'Choosing…' : 'Choose…'}
            </Button>
          ) : null}
        </div>
      </FieldLabel>
      <SubmitRow
        busy={busy}
        disabled={!path.trim()}
        label="Add folder"
        busyLabel="Reading folder…"
        onClick={submit}
      >
        <Checkbox checked={includeDiff} onChange={setIncludeDiff}>
          Include diff vs base branch
        </Checkbox>
      </SubmitRow>
    </div>
  );
}

function ClaudeCodeTab({
  busy,
  onSubmit,
}: {
  busy: boolean;
  onSubmit: (dir: string, sessionIds: string[], includeRepo: boolean) => Promise<boolean>;
}) {
  const [projects, setProjects] = useState<ClaudeCodeProject[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [dir, setDir] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [includeRepo, setIncludeRepo] = useState(true);

  useEffect(() => {
    let cancelled = false;
    listClaudeCodeProjects()
      .then((list) => {
        if (cancelled) return;
        setProjects(list);
        if (list[0]) {
          setDir(list[0].dir);
          setSelected(new Set(list[0].sessions.map((s) => s.id)));
        }
      })
      .catch((err) => {
        if (!cancelled) setLoadError(errorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const current = projects?.find((p) => p.dir === dir) ?? null;

  const pickProject = (nextDir: string) => {
    setDir(nextDir);
    const next = projects?.find((p) => p.dir === nextDir);
    setSelected(new Set(next?.sessions.map((s) => s.id) ?? []));
  };

  const toggle = (id: string, on: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  if (loadError) return <ErrorNote>{loadError}</ErrorNote>;
  if (!projects) {
    return (
      <p className="flex items-center gap-2 text-xs text-neutral-500 dark:text-neutral-400">
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
        Looking for Claude Code projects…
      </p>
    );
  }
  if (projects.length === 0) {
    return (
      <p className="text-xs text-neutral-500 dark:text-neutral-400">
        No Claude Code sessions found under ~/.claude/projects.
      </p>
    );
  }

  const sessions = current?.sessions ?? [];
  const allSelected = sessions.length > 0 && sessions.every((s) => selected.has(s.id));
  const chosen = sessions.filter((s) => selected.has(s.id)).map((s) => s.id);

  return (
    <div className="flex flex-col gap-3">
      <FieldLabel label="Claude Code project">
        <Select value={dir} onChange={(e) => pickProject(e.target.value)}>
          {projects.map((p) => (
            <option key={p.dir} value={p.dir}>
              {p.name} — {p.path}
            </option>
          ))}
        </Select>
      </FieldLabel>

      {current ? (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] font-medium uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
              Sessions · {chosen.length}/{sessions.length}
            </span>
            <button
              type="button"
              onClick={() =>
                setSelected(allSelected ? new Set() : new Set(sessions.map((s) => s.id)))
              }
              className="text-xs text-neutral-500 underline-offset-2 hover:text-neutral-800 hover:underline dark:hover:text-neutral-200"
            >
              {allSelected ? 'Select none' : 'Select all'}
            </button>
          </div>
          <ul className="max-h-56 overflow-y-auto rounded-md border border-neutral-200 dark:border-neutral-800">
            {sessions.map((s, i) => (
              <li
                key={s.id}
                className={cn(i > 0 && 'border-t border-neutral-200 dark:border-neutral-800')}
              >
                <label className="flex cursor-pointer items-start gap-2.5 px-3 py-2 hover:bg-neutral-50 dark:hover:bg-neutral-900/50">
                  <input
                    type="checkbox"
                    checked={selected.has(s.id)}
                    onChange={(e) => toggle(s.id, e.target.checked)}
                    className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-sky-600 dark:accent-sky-400"
                  />
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="line-clamp-2 break-words text-xs text-neutral-800 dark:text-neutral-200">
                      {s.first_prompt || (
                        <span className="italic text-neutral-500">No prompt text</span>
                      )}
                    </span>
                    <span className="font-mono text-[10px] text-neutral-500 dark:text-neutral-400">
                      {formatDate(s.modified_at)} · {formatBytes(s.bytes)} · {s.id.slice(0, 8)}
                    </span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <SubmitRow
        busy={busy}
        disabled={!current || chosen.length === 0}
        label="Add sessions"
        busyLabel="Reading sessions…"
        onClick={() => {
          if (current) void onSubmit(current.dir, chosen, includeRepo);
        }}
      >
        <Checkbox checked={includeRepo} onChange={setIncludeRepo}>
          Also include the repo folder
        </Checkbox>
      </SubmitRow>
    </div>
  );
}
