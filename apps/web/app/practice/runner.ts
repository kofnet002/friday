// Runs candidate code against test cases in a Web Worker, so an infinite
// loop or a crash can't freeze the page. JavaScript runs natively; Python runs
// on Pyodide (CPython compiled to WebAssembly), loaded from the CDN the first
// time Python is used.

import type { Language } from './types';
import type { TestCase } from './test-cases';

const PYODIDE_URL = 'https://cdn.jsdelivr.net/pyodide/v0.26.4/full/';
const RUN_TIMEOUT_MS = 10_000;
const LOAD_TIMEOUT_MS = 90_000;

export interface CaseResult {
  ok: boolean;
  output?: unknown;
  error?: string;
  stdout: string;
  ms: number;
}

// Source of the worker. Kept as a string and started from a Blob URL so it
// needs no bundler configuration.
const WORKER_SOURCE = `
let pyodide = null;

async function ensurePython() {
  if (pyodide) return pyodide;
  importScripts('${PYODIDE_URL}pyodide.js');
  pyodide = await loadPyodide({ indexURL: '${PYODIDE_URL}' });
  return pyodide;
}

function runJs(code, fn, cases) {
  let logs = [];
  const fmt = (a) => (typeof a === 'string' ? a : JSON.stringify(a));
  self.console = { ...console, log: (...a) => logs.push(a.map(fmt).join(' ')) };
  let target;
  try {
    target = new Function(code + '\\n;return typeof ' + fn + " === 'function' ? " + fn + ' : undefined;')();
  } catch (e) {
    return cases.map(() => ({ ok: false, error: String(e), stdout: '', ms: 0 }));
  }
  if (!target) {
    return cases.map(() => ({ ok: false, error: 'function ' + fn + ' is not defined', stdout: '', ms: 0 }));
  }
  return cases.map((c) => {
    logs = [];
    const t0 = performance.now();
    try {
      const output = target(...structuredClone(c.args));
      return { ok: true, output: output === undefined ? null : output, stdout: logs.join('\\n'), ms: performance.now() - t0 };
    } catch (e) {
      return { ok: false, error: (e && e.stack) || String(e), stdout: logs.join('\\n'), ms: performance.now() - t0 };
    }
  });
}

async function runPython(code, fn, cases) {
  const py = await ensurePython();
  self.postMessage({ type: 'loaded' });
  let out = '';
  py.setStdout({ batched: (s) => { out += s + '\\n'; } });
  py.setStderr({ batched: (s) => { out += s + '\\n'; } });
  const ns = py.globals.get('dict')();
  try {
    py.runPython(code, { globals: ns });
  } catch (e) {
    ns.destroy();
    return cases.map(() => ({ ok: false, error: String(e.message || e), stdout: out, ms: 0 }));
  }
  const target = ns.get(fn);
  if (!target || typeof target.call !== 'function') {
    ns.destroy();
    return cases.map(() => ({ ok: false, error: 'function ' + fn + ' is not defined', stdout: out, ms: 0 }));
  }
  const results = cases.map((c) => {
    out = '';
    const t0 = performance.now();
    const args = c.args.map((a) => py.toPy(a));
    try {
      let value = target(...args);
      if (value && typeof value.toJs === 'function') {
        const proxy = value;
        value = proxy.toJs({ dict_converter: Object.fromEntries, create_pyproxies: false });
        proxy.destroy();
      }
      return { ok: true, output: value === undefined ? null : value, stdout: out.trimEnd(), ms: performance.now() - t0 };
    } catch (e) {
      return { ok: false, error: String(e.message || e), stdout: out.trimEnd(), ms: performance.now() - t0 };
    } finally {
      args.forEach((a) => a && a.destroy && a.destroy());
    }
  });
  target.destroy();
  ns.destroy();
  return results;
}

self.onmessage = async (event) => {
  const { id, language, code, fn, cases } = event.data;
  try {
    const results = language === 'python' ? await runPython(code, fn, cases) : runJs(code, fn, cases);
    self.postMessage({ type: 'done', id, results });
  } catch (e) {
    self.postMessage({ type: 'fatal', id, error: String((e && e.message) || e) });
  }
};
`;

let worker: Worker | null = null;
let pythonLoaded = false;
let nextId = 0;

function freshWorker(): Worker {
  const url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: 'text/javascript' }));
  const w = new Worker(url);
  URL.revokeObjectURL(url);
  return w;
}

function killWorker(): void {
  worker?.terminate();
  worker = null;
  pythonLoaded = false;
}

/** Run `fn` from `code` on every case. Resolves with one result per case;
 *  `onStatus` reports the slow first-time Python load. */
export function runCases(
  language: Language,
  code: string,
  fn: string,
  cases: TestCase[],
  onStatus: (status: string) => void = () => {},
): Promise<CaseResult[]> {
  worker ??= freshWorker();
  const w = worker;
  const id = ++nextId;
  const needsLoad = language === 'python' && !pythonLoaded;
  if (needsLoad) onStatus('Loading Python (first run only, ~10 s)…');

  return new Promise((resolve) => {
    const fail = (error: string) => {
      w.removeEventListener('message', onMessage);
      clearTimeout(timer);
      killWorker();
      resolve(cases.map(() => ({ ok: false, error, stdout: '', ms: 0 })));
    };
    let timer = setTimeout(
      () =>
        fail(
          needsLoad
            ? 'Python failed to load (network?)'
            : `Timed out after ${RUN_TIMEOUT_MS / 1000}s — infinite loop?`,
        ),
      needsLoad ? LOAD_TIMEOUT_MS : RUN_TIMEOUT_MS,
    );
    function onMessage(event: MessageEvent) {
      const msg = event.data as {
        type: string;
        id?: number;
        results?: CaseResult[];
        error?: string;
      };
      if (msg.type === 'loaded') {
        if (!pythonLoaded) {
          pythonLoaded = true;
          onStatus('Running…');
          clearTimeout(timer);
          timer = setTimeout(
            () => fail(`Timed out after ${RUN_TIMEOUT_MS / 1000}s — infinite loop?`),
            RUN_TIMEOUT_MS,
          );
        }
        return;
      }
      if (msg.id !== id) return;
      w.removeEventListener('message', onMessage);
      clearTimeout(timer);
      if (msg.type === 'fatal') {
        killWorker();
        resolve(
          cases.map(() => ({ ok: false, error: msg.error ?? 'runner crashed', stdout: '', ms: 0 })),
        );
      } else {
        resolve(msg.results ?? []);
      }
    }
    w.addEventListener('message', onMessage);
    w.postMessage({ id, language, code, fn, cases: cases.map((c) => ({ args: c.args })) });
  });
}
