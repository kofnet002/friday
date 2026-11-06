'use client';

import { ImagePlus, Play, Plus, ScanText, Square, Trash2, X } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
} from 'react';

import { MODEL_CATALOG, REASONING_EFFORTS } from '@friday/shared-types';

import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';

import { AnswerCard, EMPTY_RUN, type RunState } from './answer-card';
import { extractQuestion, streamAnswer } from './lab-api';
import { problemToQuestion } from './lab-helpers';

interface Lane {
  id: string;
  model: string;
  effort: string | null;
}

interface Shot {
  id: string;
  name: string;
  dataUrl: string;
}

interface SavedConfig {
  lanes: Lane[];
  visionModel: string;
  rubric: string;
}

const STORAGE_KEY = 'friday.lab.config';
// Best picks from the Nov 2026 eval: Opus 5.5 answered best at any effort;
// gpt-5.6 is the strongest OpenAI answer (at high) and the most accurate reader.
const DEFAULT_CONFIG: SavedConfig = {
  lanes: [
    { id: 'a', model: 'claude-opus-5-5', effort: null },
    { id: 'b', model: 'gpt-5.6', effort: 'high' },
  ],
  visionModel: 'gpt-5.6',
  rubric: '',
};
const EXTRA_MODELS = [
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-5.4-mini',
  'claude-fable-5-1',
  'gpt-5.5-pro',
];
const MODEL_IDS = [...MODEL_CATALOG.map((m) => m.id), ...EXTRA_MODELS];
const VISION_MODEL_IDS = [
  ...MODEL_CATALOG.filter((m) => m.capabilities.includes('vision')).map((m) => m.id),
  'gpt-5.4-mini',
];
const MAX_SHOTS = 8;

function loadConfig(): SavedConfig {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_CONFIG;
    const parsed = JSON.parse(raw) as Partial<SavedConfig>;
    return {
      lanes:
        Array.isArray(parsed.lanes) && parsed.lanes.length ? parsed.lanes : DEFAULT_CONFIG.lanes,
      visionModel: parsed.visionModel || DEFAULT_CONFIG.visionModel,
      rubric: typeof parsed.rubric === 'string' ? parsed.rubric : '',
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

function saveConfig(config: SavedConfig): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch {
    // Storage blocked (private window) — config just won't persist.
  }
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('could not read image'));
    reader.readAsDataURL(file);
  });
}

const newId = () => Math.random().toString(36).slice(2, 10);

export default function LabPage() {
  const [config, setConfig] = useState<SavedConfig>(DEFAULT_CONFIG);
  const [shots, setShots] = useState<Shot[]>([]);
  const [question, setQuestion] = useState('');
  const [reading, setReading] = useState(false);
  const [readNote, setReadNote] = useState<string | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [runs, setRuns] = useState<Record<string, RunState>>({});
  const [dragging, setDragging] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => setConfig(loadConfig()), []);

  const update = useCallback((patch: Partial<SavedConfig>) => {
    setConfig((prev) => {
      const next = { ...prev, ...patch };
      saveConfig(next);
      return next;
    });
  }, []);

  const running = Object.values(runs).some((r) => r.status === 'running');

  async function addFiles(files: Iterable<File>) {
    const images = [...files].filter((f) => f.type.startsWith('image/'));
    const added = await Promise.all(
      images.map(async (f) => ({
        id: newId(),
        name: f.name || 'pasted image',
        dataUrl: await readAsDataUrl(f),
      })),
    );
    setShots((prev) => [...prev, ...added].slice(0, MAX_SHOTS));
  }

  function onPaste(e: ClipboardEvent) {
    const files = [...e.clipboardData.files];
    if (files.some((f) => f.type.startsWith('image/'))) {
      e.preventDefault();
      void addFiles(files);
    }
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setDragging(false);
    void addFiles(e.dataTransfer.files);
  }

  async function readScreens() {
    setReading(true);
    setReadError(null);
    setReadNote(null);
    try {
      const result = await extractQuestion(
        shots.map((s) => s.dataUrl),
        config.visionModel,
      );
      setQuestion(problemToQuestion(result.problem));
      setReadNote(
        `Read by ${result.model} in ${(result.ms / 1000).toFixed(1)}s — edit below if anything is off.`,
      );
    } catch (err) {
      setReadError(err instanceof Error ? err.message : 'could not read the screenshots');
    } finally {
      setReading(false);
    }
  }

  function patchRun(id: string, patch: (prev: RunState) => Partial<RunState>) {
    setRuns((prev) => {
      const current = prev[id] ?? EMPTY_RUN;
      return { ...prev, [id]: { ...current, ...patch(current) } };
    });
  }

  function runAll() {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const startedAt = Date.now();
    setRuns(
      Object.fromEntries(
        config.lanes.map((l) => [l.id, { ...EMPTY_RUN, status: 'running' as const, startedAt }]),
      ),
    );
    for (const lane of config.lanes) {
      void streamAnswer(
        { question, model: lane.model.trim(), effort: lane.effort },
        {
          onToken: (text) =>
            patchRun(lane.id, (r) => ({
              text: r.text + text,
              firstTokenAt: r.firstTokenAt ?? Date.now(),
            })),
          onDone: (done) => patchRun(lane.id, () => ({ status: 'done', done })),
          onError: (message) => patchRun(lane.id, () => ({ status: 'error', error: message })),
        },
        controller.signal,
      );
    }
  }

  function stop() {
    abortRef.current?.abort();
    setRuns((prev) =>
      Object.fromEntries(
        Object.entries(prev).map(([id, r]) => [
          id,
          r.status === 'running' ? { ...r, status: 'error' as const, error: 'Stopped.' } : r,
        ]),
      ),
    );
  }

  function setLane(id: string, patch: Partial<Lane>) {
    update({ lanes: config.lanes.map((l) => (l.id === id ? { ...l, ...patch } : l)) });
  }

  return (
    <main
      // Always dark: `dark` here turns on every dark: style below it,
      // whatever theme the rest of the app uses.
      className="dark min-h-screen bg-neutral-950 text-neutral-200 [color-scheme:dark]"
      onPaste={onPaste}
    >
      <div className="mx-auto flex max-w-[1600px] flex-col gap-8 px-4 py-8 sm:px-8">
        <header className="flex flex-col gap-1">
          <span className="font-mono text-xs uppercase tracking-[0.25em] text-sky-400">
            Friday · Model lab
          </span>
          <h1 className="text-3xl font-semibold tracking-tight text-neutral-50 sm:text-4xl">
            Same question, several models.
          </h1>
          <p className="max-w-2xl text-sm text-neutral-400">
            Drop or paste screenshots of a question (or type it), then run it on the models below.
            Answers use Friday&rsquo;s real live-answer prompt and are never switched to another
            provider behind your back.
          </p>
        </header>

        <section className="grid gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
          {/* 1 · screenshots */}
          <div className="flex flex-col gap-3">
            <h2 className="text-xs font-semibold uppercase tracking-[0.18em] text-neutral-400">
              1 · Screenshots
            </h2>
            <div
              role="button"
              tabIndex={0}
              onClick={() => fileInput.current?.click()}
              onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && fileInput.current?.click()}
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
              className={`flex min-h-[9rem] cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-dashed px-4 py-6 text-center text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/40 ${
                dragging
                  ? 'border-sky-400 bg-sky-950/30 text-sky-200'
                  : 'border-neutral-700 text-neutral-400 hover:border-neutral-500'
              }`}
            >
              <ImagePlus className="h-6 w-6" aria-hidden />
              <span>
                Drop images, click to choose, or paste (⌘V). In page order, up to {MAX_SHOTS}.
              </span>
              <input
                ref={fileInput}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(e) => {
                  if (e.target.files) void addFiles(e.target.files);
                  e.target.value = '';
                }}
              />
            </div>
            {shots.length > 0 && (
              <ol className="grid grid-cols-4 gap-2">
                {shots.map((s, i) => (
                  <li
                    key={s.id}
                    className="group relative overflow-hidden rounded-lg border border-neutral-800"
                  >
                    <img
                      src={s.dataUrl}
                      alt={`Screenshot ${i + 1}`}
                      className="aspect-video w-full object-cover object-top"
                    />
                    <span className="absolute left-1 top-1 rounded bg-black/70 px-1.5 font-mono text-[10px]">
                      {i + 1}
                    </span>
                    <button
                      type="button"
                      onClick={() => setShots((prev) => prev.filter((x) => x.id !== s.id))}
                      className="absolute right-1 top-1 rounded bg-black/70 p-0.5 text-neutral-300 hover:text-white"
                      aria-label={`Remove screenshot ${i + 1}`}
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </li>
                ))}
              </ol>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-2 text-xs text-neutral-400">
                Read with
                <input
                  list="lab-vision-models"
                  value={config.visionModel}
                  onChange={(e) => update({ visionModel: e.target.value })}
                  className="h-9 w-48 rounded-md border border-neutral-700 bg-neutral-950/60 px-2 font-mono text-xs text-neutral-100 focus-visible:border-sky-400 focus-visible:outline-none"
                />
              </label>
              <Button type="button" onClick={readScreens} disabled={!shots.length || reading}>
                <ScanText className="mr-1.5 h-4 w-4" />
                {reading ? 'Reading…' : 'Read screenshots'}
              </Button>
              {shots.length > 0 && (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setShots([])}
                  disabled={reading}
                >
                  Clear
                </Button>
              )}
            </div>
            {readNote && <p className="text-xs text-emerald-300/90">{readNote}</p>}
            {readError && (
              <p className="rounded-md bg-rose-950/60 px-3 py-2 text-xs text-rose-200">
                {readError}
              </p>
            )}
          </div>

          {/* 2 · question */}
          <div className="flex flex-col gap-3">
            <h2 className="text-xs font-semibold uppercase tracking-[0.18em] text-neutral-400">
              2 · Question
            </h2>
            <Textarea
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="The full question the models will answer. Filled in by “Read screenshots”, or type / paste it here."
              className="min-h-[16rem] font-mono text-xs leading-relaxed"
            />
            <details className="rounded-lg border border-neutral-800 px-3 py-2 text-sm">
              <summary className="cursor-pointer text-xs text-neutral-400">
                Must-mention checks (optional)
                {config.rubric.trim()
                  ? ` · ${config.rubric.trim().split('\n').filter(Boolean).length}`
                  : ''}
              </summary>
              <p className="mt-2 text-xs text-neutral-500">
                One per line. A line passes when the answer contains it; separate alternatives with{' '}
                <code>|</code>.
              </p>
              <Textarea
                value={config.rubric}
                onChange={(e) => update({ rubric: e.target.value })}
                placeholder={
                  'payment link | checkout link\nInvalidRequestError\nsilently replace | lose their membership'
                }
                className="mt-2 min-h-[6rem] font-mono text-xs"
              />
            </details>
          </div>
        </section>

        {/* 3 · models */}
        <section className="flex flex-col gap-3">
          <h2 className="text-xs font-semibold uppercase tracking-[0.18em] text-neutral-400">
            3 · Models
          </h2>
          <ul className="flex flex-wrap gap-2">
            {config.lanes.map((lane) => (
              <li
                key={lane.id}
                className="flex items-center gap-1.5 rounded-lg border border-neutral-800 bg-neutral-900/60 p-1.5"
              >
                <input
                  list="lab-models"
                  value={lane.model}
                  onChange={(e) => setLane(lane.id, { model: e.target.value })}
                  aria-label="Model"
                  className="h-8 w-44 rounded-md border border-neutral-700 bg-neutral-950/60 px-2 font-mono text-xs text-neutral-100 focus-visible:border-sky-400 focus-visible:outline-none"
                />
                <select
                  value={lane.effort ?? ''}
                  onChange={(e) => setLane(lane.id, { effort: e.target.value || null })}
                  aria-label="Reasoning effort"
                  className="h-8 rounded-md border border-neutral-700 bg-neutral-950/60 px-2 text-xs text-neutral-100"
                >
                  <option value="">default effort</option>
                  {REASONING_EFFORTS.map((e) => (
                    <option key={e} value={e}>
                      {e}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => update({ lanes: config.lanes.filter((l) => l.id !== lane.id) })}
                  disabled={config.lanes.length === 1}
                  className="rounded-md p-1.5 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200 disabled:opacity-30"
                  aria-label={`Remove ${lane.model}`}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
            <li>
              <Button
                type="button"
                variant="ghost"
                onClick={() =>
                  update({
                    lanes: [
                      ...config.lanes,
                      { id: newId(), model: 'claude-sonnet-5-5', effort: 'high' },
                    ],
                  })
                }
                disabled={config.lanes.length >= 6}
              >
                <Plus className="mr-1 h-4 w-4" /> Add model
              </Button>
            </li>
          </ul>
          <div className="flex items-center gap-3">
            {running ? (
              <Button
                type="button"
                variant="outline"
                onClick={stop}
                className="border-rose-800 text-rose-200 hover:bg-rose-950/60"
              >
                <Square className="mr-1.5 h-4 w-4" /> Stop
              </Button>
            ) : (
              <Button type="button" onClick={runAll} disabled={!question.trim()}>
                <Play className="mr-1.5 h-4 w-4" /> Run{' '}
                {config.lanes.length === 1 ? 'model' : `${config.lanes.length} models`}
              </Button>
            )}
            <span className="text-xs text-neutral-500">
              Each run is billed to that provider. Opus 5.5 ≈ $0.09 per long answer.
            </span>
          </div>
        </section>

        {Object.keys(runs).length > 0 && (
          <section className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
            {config.lanes.flatMap((lane) => {
              const run = runs[lane.id];
              return run
                ? [
                    <AnswerCard
                      key={lane.id}
                      model={lane.model}
                      effort={lane.effort}
                      run={run}
                      rubric={config.rubric}
                    />,
                  ]
                : [];
            })}
          </section>
        )}
      </div>

      <datalist id="lab-models">
        {MODEL_IDS.map((id) => (
          <option key={id} value={id} />
        ))}
      </datalist>
      <datalist id="lab-vision-models">
        {VISION_MODEL_IDS.map((id) => (
          <option key={id} value={id} />
        ))}
      </datalist>
    </main>
  );
}
