import type { AnswerProvider } from './index';

export type ModelCapability = 'text' | 'vision' | 'coding';

export interface ModelOption {
  id: string;
  label: string;
  provider: AnswerProvider;
  capabilities: readonly ModelCapability[];
}

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
