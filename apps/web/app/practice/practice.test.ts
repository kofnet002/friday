import { test } from 'node:test';
import assert from 'node:assert/strict';

import { codingScore, formatClock, judge, sameValue, wordCount } from './grading.ts';
import {
  BOOKING_CASES,
  GATEWAY_CASES,
  PLOW_CASES,
  SAMPLE_COUNT,
  type TestCase,
} from './test-cases.ts';
import { PAGE_CASES, SPIKE_CASES, TRIAGE_CASES } from './hercules-cases.ts';

// Independent reference solutions: every stored expected value must match.
function mergeBookings(bookings: number[][], buffer: number): number[][] {
  const sorted = bookings.map((b) => [...b]).sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const out: number[][] = [];
  for (const b of sorted) {
    const last = out[out.length - 1];
    if (last && (b[0] - last[1] < buffer || b[0] < last[1])) last[1] = Math.max(last[1], b[1]);
    else out.push(b);
  }
  return out;
}

function rejectedRequests(
  requests: [number, string, number][],
  window: number,
  perClient: number,
  globalLimit: number,
  vip: string[],
): number[] {
  const accepted: [number, string, number][] = [];
  const rejected: number[] = [];
  requests.forEach(([t, client, cost], i) => {
    const live = accepted.filter(([s]) => t - s < window);
    const global = live.reduce((sum, r) => sum + r[2], 0);
    const mine = live.filter((r) => r[1] === client).reduce((sum, r) => sum + r[2], 0);
    if (global + cost > globalLimit || (!vip.includes(client) && mine + cost > perClient))
      rejected.push(i);
    else accepted.push([t, client, cost]);
  });
  return rejected;
}

// Bellman-Ford style relaxation over (cell, direction) — deliberately a
// different algorithm from the Dijkstra used to generate the data.
function minPlowCost(grid: number[][], turnCost: number): number {
  const R = grid.length;
  const C = grid[0].length;
  if (!grid[0][0] || !grid[R - 1][C - 1]) return -1;
  if (R === 1 && C === 1) return 0;
  const dirs = [
    [0, 1],
    [1, 0],
    [0, -1],
    [-1, 0],
  ];
  const INF = Number.POSITIVE_INFINITY;
  const best = grid.map((row) => row.map(() => [INF, INF, INF, INF]));
  for (let k = 0; k < 4; k++) {
    const [r, c] = dirs[k];
    if (r >= 0 && c >= 0 && r < R && c < C && grid[r][c]) best[r][c][k] = grid[r][c];
  }
  for (let changed = true; changed; ) {
    changed = false;
    for (let r = 0; r < R; r++)
      for (let c = 0; c < C; c++)
        for (let k = 0; k < 4; k++) {
          const d = best[r][c][k];
          if (d === INF) continue;
          for (let j = 0; j < 4; j++) {
            const nr = r + dirs[j][0];
            const nc = c + dirs[j][1];
            if (nr < 0 || nc < 0 || nr >= R || nc >= C || !grid[nr][nc]) continue;
            const nd = d + grid[nr][nc] + (j === k ? 0 : turnCost);
            if (nd < best[nr][nc][j]) {
              best[nr][nc][j] = nd;
              changed = true;
            }
          }
        }
  }
  const end = Math.min(...best[R - 1][C - 1]);
  return end === INF ? -1 : end;
}

function checkAll(cases: TestCase[], fn: (...args: never[]) => unknown) {
  cases.forEach((c, i) => {
    const args = structuredClone(c.args) as never[];
    assert.deepEqual(fn(...args), c.expected, `case ${i}`);
  });
}

test('booking cases match the reference', () => checkAll(BOOKING_CASES, mergeBookings as never));
test('gateway cases match the reference', () => checkAll(GATEWAY_CASES, rejectedRequests as never));
test('plow cases match an independent algorithm', () => checkAll(PLOW_CASES, minPlowCost as never));

test('every question has samples and hidden cases', () => {
  for (const cases of [
    BOOKING_CASES,
    GATEWAY_CASES,
    PLOW_CASES,
    TRIAGE_CASES,
    PAGE_CASES,
    SPIKE_CASES,
  ]) {
    assert.ok(cases.length > SAMPLE_COUNT);
  }
});

test('judge compares output in order and marks errors as failed', () => {
  const cases: TestCase[] = [
    { args: [], expected: [1, 2] },
    { args: [], expected: [1, 2] },
    { args: [], expected: 3 },
  ];
  const verdicts = judge(cases, [
    { ok: true, output: [1, 2], stdout: '', ms: 1 },
    { ok: true, output: [2, 1], stdout: '', ms: 1 },
    { ok: false, error: 'boom', stdout: '', ms: 1 },
  ]);
  assert.deepEqual(
    verdicts.map((v) => v.passed),
    [true, false, false],
  );
  assert.ok(sameValue({ a: [1] }, { a: [1] }));
});

test('scoring, word count and clock formatting', () => {
  assert.equal(codingScore(25, 7, 7), 25);
  assert.equal(codingScore(25, 3, 7), 11);
  assert.equal(codingScore(25, 0, 0), 0);
  assert.equal(wordCount('  a b\nc '), 3);
  assert.equal(formatClock(90 * 60 * 1000), '1:30:00');
  assert.equal(formatClock(61_500), '01:02');
  assert.equal(formatClock(-5), '00:00');
});

// ─── Practice 2 ───────────────────────────────────────────────────────────

const SLA: Record<string, number> = { P1: 60, P2: 240, P3: 1440, P4: 4320 };

function triageQueue(tickets: [string, string, number, string][], now: number): string[] {
  const key = (t: [string, string, number, string]) =>
    [t[3] === 'open' ? 0 : 1, t[2] + SLA[t[1]] - now, t[1], t[0]] as const;
  return tickets
    .filter((t) => t[3] !== 'solved')
    .map(key)
    .sort((a, b) => {
      for (let i = 0; i < a.length; i++) {
        if (a[i] < b[i]) return -1;
        if (a[i] > b[i]) return 1;
      }
      return 0;
    })
    .map((k) => k[3]);
}

// Walks the list position by position instead of comparing against the cursor.
function fetchPage(
  orders: [number, number, boolean][],
  cursor: [number, number] | null,
  limit: number,
): number[] {
  const all = [...orders].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  let start = 0;
  if (cursor) {
    while (
      start < all.length &&
      (all[start][1] > cursor[0] || (all[start][1] === cursor[0] && all[start][0] >= cursor[1]))
    )
      start++;
  }
  return all
    .slice(start)
    .filter((o) => !o[2])
    .slice(0, limit)
    .map((o) => o[0]);
}

// Brute force: re-scans every earlier error for each event.
function spikeAlerts(logs: string[], window: number, threshold: number): [string, number][] {
  const errs = logs
    .map((line, i) => ({ f: line.trim().split(/\s+/), i }))
    .filter(({ f }) => f.length === 4 && /^\d+$/.test(f[0]) && /^\d{3}$/.test(f[2]))
    .filter(({ f }) => Number(f[2]) >= 500 && Number(f[2]) <= 599)
    .map(({ f, i }) => ({ t: Number(f[0]), app: f[1], i }))
    .sort((a, b) => a.t - b.t || a.i - b.i);
  const out: [string, number][] = [];
  const inIncident = new Set<string>();
  errs.forEach((e, k) => {
    const earlier = errs.slice(0, k).filter((x) => x.app === e.app && x.t > e.t - window);
    if (earlier.length === 0) inIncident.delete(e.app);
    if (!inIncident.has(e.app) && earlier.length + 1 >= threshold) {
      out.push([e.app, e.t]);
      inIncident.add(e.app);
    }
  });
  return out;
}

test('practice 2 triage cases match the reference', () =>
  checkAll(TRIAGE_CASES, triageQueue as never));
test('practice 2 pagination cases match the reference', () =>
  checkAll(PAGE_CASES, fetchPage as never));
test('practice 2 spike cases match the reference', () =>
  checkAll(SPIKE_CASES, spikeAlerts as never));

test('the shipped pagination bug fails the samples it is meant to', () => {
  // The starter code from the editor, in JS: no id tie-break, <= cursor, no deleted filter.
  const buggy = (
    orders: [number, number, boolean][],
    cursor: [number, number] | null,
    limit: number,
  ) => {
    let rows = [...orders].sort((a, b) => b[1] - a[1]);
    if (cursor !== null) rows = rows.filter((o) => o[1] <= cursor[0]);
    return rows.slice(0, limit).map((o) => o[0]);
  };
  const samples = PAGE_CASES.slice(0, SAMPLE_COUNT);
  const failing = samples.filter((c) => {
    const [orders, cursor, limit] = structuredClone(c.args) as Parameters<typeof buggy>;
    return JSON.stringify(buggy(orders, cursor, limit)) !== JSON.stringify(c.expected);
  });
  assert.equal(failing.length, samples.length);
});
