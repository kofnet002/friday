// Run: node --experimental-strip-types --test app/session/scan-tabs.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';

import type { ExtractedProblem } from '@friday/shared-types';

import { isSameProblem, placeScannedTab } from './scan-tabs.ts';

const FULL =
  'Given an array of integers nums and an integer target, return indices of the two numbers' +
  ' such that they add up to target. You may assume that each input would have exactly one' +
  ' solution, and you may not use the same element twice.';

function problem(overrides: Partial<ExtractedProblem> = {}): ExtractedProblem {
  return {
    is_coding_problem: true,
    title: '1. Two Sum',
    problem_statement: FULL,
    confidence: 0.9,
    ...overrides,
  } as ExtractedProblem;
}

const tab = (fingerprint: string, p: ExtractedProblem) => ({ fingerprint, problem: p });

test('same title (normalized) is the same problem', () => {
  assert.ok(isSameProblem(problem({ title: '1.  two sum ' }), problem()));
  assert.ok(!isSameProblem(problem({ title: '2. Add Two Numbers' }), problem()));
});

test('untitled partial read matches by contained statement', () => {
  const top = problem({ title: null, problem_statement: FULL.slice(0, 110) });
  assert.ok(isSameProblem(top, problem()));
  const other = problem({
    title: null,
    problem_statement: 'Reverse a singly linked list in place.',
  });
  assert.ok(!isSameProblem(other, problem()));
});

test('scanned tab replaces partial tabs in place', () => {
  const tabs = [
    tab('a', problem({ title: 'Valid Parentheses' })),
    tab('partial-top', problem({ problem_statement: FULL.slice(0, 90) })),
    tab('partial-bottom', problem({ title: null, problem_statement: FULL.slice(60) })),
  ];
  const { tabs: next, replaced } = placeScannedTab(tabs, tab('scan', problem()), 3);
  assert.deepEqual(
    next.map((t) => t.fingerprint),
    ['a', 'scan'],
  );
  assert.deepEqual(replaced, ['partial-top', 'partial-bottom']);
});

test('unrelated scan is appended and the cap drops the oldest tab', () => {
  const tabs = [
    tab('a', problem({ title: 'A', problem_statement: 'alpha beta gamma delta' })),
    tab('b', problem({ title: 'B', problem_statement: 'one two three four' })),
    tab('c', problem({ title: 'C', problem_statement: 'red green blue yellow' })),
  ];
  const { tabs: next, replaced } = placeScannedTab(tabs, tab('scan', problem()), 3);
  assert.deepEqual(
    next.map((t) => t.fingerprint),
    ['b', 'c', 'scan'],
  );
  assert.deepEqual(replaced, []);
});

test('re-scan with an identical fingerprint keeps one tab', () => {
  const tabs = [
    tab('scan', problem()),
    tab('x', problem({ title: 'X', problem_statement: 'x y z w' })),
  ];
  const { tabs: next } = placeScannedTab(tabs, tab('scan', problem()), 3);
  assert.deepEqual(
    next.map((t) => t.fingerprint),
    ['scan', 'x'],
  );
});
