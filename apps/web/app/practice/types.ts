// Shapes shared by every practice test.

import type { TestCase } from './test-cases';

export type Language = 'python' | 'javascript';

export type Block =
  | { t: 'p'; text: string }
  | { t: 'h'; text: string }
  | { t: 'list'; items: string[]; ordered?: boolean }
  | { t: 'code'; text: string }
  | { t: 'table'; head: string[]; rows: string[][] }
  | { t: 'example'; input: string; output: string; explanation?: string }
  | { t: 'note'; text: string };

interface BaseQuestion {
  id: string;
  title: string;
  points: number;
  blocks: Block[];
}

export interface CodingQuestion extends BaseQuestion {
  kind: 'coding';
  difficulty: 'Easy' | 'Medium' | 'Hard';
  fn: Record<Language, string>;
  /** Argument names, for showing test inputs. */
  params: string[];
  starter: Record<Language, string>;
  tests: TestCase[];
}

export interface ChoiceItem {
  id: string;
  prompt: string;
  code?: string;
  options: string[];
  answer: number;
}

export interface ChoiceQuestion extends BaseQuestion {
  kind: 'choice';
  items: ChoiceItem[];
}

export interface WrittenPart {
  id: string;
  label: string;
  maxWords: number;
}

export interface WrittenQuestion extends BaseQuestion {
  kind: 'written';
  parts: WrittenPart[];
}

export type Question = CodingQuestion | ChoiceQuestion | WrittenQuestion;

export const LANGUAGES: { id: Language; label: string }[] = [
  { id: 'python', label: 'Python 3' },
  { id: 'javascript', label: 'JavaScript' },
];

export interface TestInfo {
  /** The (fictional) assessment platform shown in the header. */
  platform: string;
  company: string;
  name: string;
  minutes: number;
}

export interface PracticeTest {
  id: string;
  /** localStorage key for an attempt, one per test. */
  storageKey: string;
  info: TestInfo;
  questions: readonly [Question, ...Question[]];
}
