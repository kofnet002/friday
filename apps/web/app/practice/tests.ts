// Every practice test, by the id used in its URL (/practice, /practice/2).

import { HERCULES } from './hercules';
import { NORTHWIND } from './northwind';
import type { PracticeTest } from './types';

export const PRACTICE_TESTS = {
  '1': NORTHWIND,
  '2': HERCULES,
} as const satisfies Record<string, PracticeTest>;

export type PracticeTestId = keyof typeof PRACTICE_TESTS;
