import type { AnswerProvider } from './index';

export type ModelCapability = 'text' | 'vision' | 'coding';

export interface ModelOption {
  id: string;
  label: string;
  provider: AnswerProvider;
  capabilities: readonly ModelCapability[];
}

/** Reasoning effort, mapped per provider by the backend (Claude effort +
 *  adaptive thinking, OpenAI reasoning_effort, Gemini thinking budget/level).
 *  Absent = the provider's fast default. */
export const REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

/** The models offered by default. NOT an allowlist — any ID resolvable by
 *  `providerForModel` can be used (see the "Custom model…" picker option). */
export const MODEL_CATALOG: readonly ModelOption[] = [
  {
    id: 'gemini-2.5-flash',
    label: 'Gemini 2.5 Flash',
    provider: 'gemini',
    capabilities: ['text', 'vision', 'coding'],
  },
  {
    id: 'gemini-2.5-pro',
    label: 'Gemini 2.5 Pro',
    provider: 'gemini',
    capabilities: ['text', 'vision', 'coding'],
  },
  { id: 'gpt-4o', label: 'GPT-4o', provider: 'openai', capabilities: ['text', 'vision', 'coding'] },
  {
    id: 'gpt-5.5',
    label: 'GPT-5.5',
    provider: 'openai',
    capabilities: ['text', 'vision', 'coding'],
  },
  {
    id: 'gpt-5.6',
    label: 'GPT-5.6 (preview)',
    provider: 'openai',
    capabilities: ['text', 'vision', 'coding'],
  },
  {
    id: 'deepseek-chat',
    label: 'DeepSeek Chat',
    provider: 'deepseek',
    capabilities: ['text', 'coding'],
  },
  {
    id: 'claude-opus-5-5',
    label: 'Claude Opus 5.5',
    provider: 'claude',
    capabilities: ['text', 'vision', 'coding'],
  },
  {
    id: 'claude-sonnet-5-5',
    label: 'Claude Sonnet 5.5',
    provider: 'claude',
    capabilities: ['text', 'vision', 'coding'],
  },
  {
    id: 'claude-haiku-5-5',
    label: 'Claude Haiku 5.5',
    provider: 'claude',
    capabilities: ['text', 'vision', 'coding'],
  },
  {
    id: 'claude-opus-4-8',
    label: 'Claude Opus 4.8',
    provider: 'claude',
    capabilities: ['text', 'vision', 'coding'],
  },
  {
    id: 'claude-sonnet-4-6',
    label: 'Claude Sonnet 4.6',
    provider: 'claude',
    capabilities: ['text', 'vision', 'coding'],
  },
];

export function modelOption(id: string): ModelOption | undefined {
  return MODEL_CATALOG.find((model) => model.id === id);
}

const PROVIDERS: readonly AnswerProvider[] = ['gemini', 'openai', 'deepseek', 'claude'];

// Mirrors `_PREFIX_PROVIDERS` in apps/backend/app/models/catalog.py.
const PREFIX_PROVIDERS: readonly (readonly [string, AnswerProvider])[] = [
  ['claude-', 'claude'],
  ['gemini-', 'gemini'],
  ['deepseek-', 'deepseek'],
  ['gpt-', 'openai'],
  ['chatgpt-', 'openai'],
  ['ft:', 'openai'],
  ['o1', 'openai'],
  ['o3', 'openai'],
  ['o4', 'openai'],
];

// Mirrors `_MODEL_ID_RE` in the backend catalog.
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/;

export function isValidModelId(id: string): boolean {
  return MODEL_ID_RE.test(id);
}

/** Provider for any model ID: explicit `provider:model`, catalog entry, or
 *  vendor prefix. undefined when it can't be determined. */
export function providerForModel(id: string): AnswerProvider | undefined {
  if (!isValidModelId(id)) return undefined;
  const sep = id.indexOf(':');
  const head = id.slice(0, sep) as AnswerProvider;
  if (sep > 0 && PROVIDERS.includes(head)) {
    // Explicit provider:model — the model part must itself be a valid ID.
    return isValidModelId(id.slice(sep + 1)) ? head : undefined;
  }
  const known = modelOption(id);
  if (known) return known.provider;
  const lowered = id.toLowerCase();
  return PREFIX_PROVIDERS.find(([prefix]) => lowered.startsWith(prefix))?.[1];
}

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === 'string' && (REASONING_EFFORTS as readonly string[]).includes(value);
}
