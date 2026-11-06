// Pure grading helpers for the practice assessment (no imports beyond types,
// unit-tested).

import type { CaseResult } from './runner';
import type { TestCase } from './test-cases';

/** Order-sensitive deep equality on JSON-like values. */
export function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export interface CaseVerdict {
  passed: boolean;
  args: unknown[];
  expected: unknown;
  result: CaseResult;
}

export function judge(cases: TestCase[], results: CaseResult[]): CaseVerdict[] {
  return cases.map((c, i) => {
    const result = results[i] ?? { ok: false, error: 'not run', stdout: '', ms: 0 };
    return {
      passed: result.ok && sameValue(result.output, c.expected),
      args: c.args,
      expected: c.expected,
      result,
    };
  });
}

export function formatValue(value: unknown): string {
  if (value === undefined) return 'undefined';
  const text = JSON.stringify(value);
  return text.length > 400 ? `${text.slice(0, 400)}…` : text;
}

export function wordCount(text: string): number {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

/** Points for a coding question: proportional to hidden + sample cases passed. */
export function codingScore(points: number, passed: number, total: number): number {
  return total ? Math.round((points * passed) / total) : 0;
}

export function formatClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
