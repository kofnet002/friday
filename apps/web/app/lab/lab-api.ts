// Network client for the backend model lab (/api/lab/*).

import { parseSseStream } from '@/lib/sse';

import type { LabProblem } from './lab-helpers';

export type { LabProblem } from './lab-helpers';

const BACKEND_HTTP_URL = process.env.NEXT_PUBLIC_BACKEND_URL ?? 'http://127.0.0.1:8000';

export interface ExtractResult {
  problem: LabProblem;
  model: string;
  ms: number;
}

export interface AnswerUsage {
  input: number | null;
  output: number | null;
  cost: number | null;
}

export interface AnswerDone {
  first_token_ms: number | null;
  total_ms: number;
  usage: AnswerUsage | null;
}

export interface AnswerHandlers {
  onToken: (text: string) => void;
  onDone: (done: AnswerDone) => void;
  onError: (message: string) => void;
}

async function errorDetail(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { detail?: unknown };
    if (typeof body.detail === 'string') return body.detail;
    return JSON.stringify(body.detail ?? body);
  } catch {
    return `HTTP ${res.status}`;
  }
}

export async function extractQuestion(images: string[], model: string): Promise<ExtractResult> {
  const res = await fetch(`${BACKEND_HTTP_URL}/api/lab/extract`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ images_base64: images, model }),
  });
  if (!res.ok) throw new Error(await errorDetail(res));
  return (await res.json()) as ExtractResult;
}

export async function streamAnswer(
  request: { question: string; model: string; effort: string | null },
  handlers: AnswerHandlers,
  signal: AbortSignal,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${BACKEND_HTTP_URL}/api/lab/answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      signal,
    });
  } catch (err) {
    if (signal.aborted) return;
    handlers.onError(err instanceof Error ? err.message : 'request failed');
    return;
  }
  if (!res.ok) {
    handlers.onError(await errorDetail(res));
    return;
  }
  let finished = false;
  try {
    for await (const event of parseSseStream(res)) {
      const data = JSON.parse(event.data) as Record<string, unknown>;
      if (event.event === 'token') handlers.onToken(String(data.text ?? ''));
      else if (event.event === 'done') {
        finished = true;
        handlers.onDone(data as unknown as AnswerDone);
      } else if (event.event === 'error') {
        finished = true;
        handlers.onError(String(data.message ?? 'unknown error'));
      }
    }
  } catch (err) {
    if (signal.aborted) return;
    finished = true;
    handlers.onError(err instanceof Error ? err.message : 'stream failed');
  }
  if (!finished && !signal.aborted) handlers.onError('stream ended without a result');
}
