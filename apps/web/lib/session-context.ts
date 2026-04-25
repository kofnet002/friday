import type { AnswerProvider, CodingLanguage, SessionContextResponse } from '@friday/shared-types';

const SESSION_ID_KEY = 'friday.session.id';
const PROVIDER_KEY = 'friday.session.provider';
const CODING_LANGUAGE_KEY = 'friday.session.coding_language';
const CODING_LANGUAGES: readonly CodingLanguage[] = [
  'Python',
  'JavaScript',
  'TypeScript',
  'Java',
  'C++',
  'Go',
];

export function getOrCreateSessionId(): string {
  if (typeof window === 'undefined') return '';
  const existing = window.localStorage.getItem(SESSION_ID_KEY);
  if (existing) return existing;
  const id = crypto.randomUUID();
  window.localStorage.setItem(SESSION_ID_KEY, id);
  return id;
}

export function setSessionId(id: string): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(SESSION_ID_KEY, id);
}

export function readSessionId(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(SESSION_ID_KEY);
}

export function getProviderPreference(): AnswerProvider {
  if (typeof window === 'undefined') return 'gemini';
  const raw = window.localStorage.getItem(PROVIDER_KEY);
  return raw === 'openai' ? 'openai' : 'gemini';
}

export function setProviderPreference(p: AnswerProvider): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(PROVIDER_KEY, p);
}

export function getCodingLanguagePreference(): CodingLanguage {
  if (typeof window === 'undefined') return 'Python';
  const raw = window.localStorage.getItem(CODING_LANGUAGE_KEY);
  if (raw && (CODING_LANGUAGES as readonly string[]).includes(raw)) {
    return raw as CodingLanguage;
  }
  return 'Python';
}

export function setCodingLanguagePreference(lang: CodingLanguage): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(CODING_LANGUAGE_KEY, lang);
}

export const ALL_CODING_LANGUAGES = CODING_LANGUAGES;

const BACKEND_HTTP_URL = process.env.NEXT_PUBLIC_BACKEND_URL ?? 'http://127.0.0.1:8000';

export async function fetchContext(sessionId: string): Promise<SessionContextResponse | null> {
  try {
    const res = await fetch(`${BACKEND_HTTP_URL}/api/context/${sessionId}`);
    if (!res.ok) return null;
    return (await res.json()) as SessionContextResponse;
  } catch {
    return null;
  }
}

export async function saveContext(payload: {
  session_id: string;
  job_title?: string;
  company?: string;
  language?: string;
  extra_instructions?: string;
}): Promise<boolean> {
  const res = await fetch(`${BACKEND_HTTP_URL}/api/context`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return res.ok;
}

export async function uploadResume(
  sessionId: string,
  file: File,
): Promise<{ ok: boolean; chars?: number; error?: string }> {
  const form = new FormData();
  form.append('session_id', sessionId);
  form.append('file', file);
  try {
    const res = await fetch(`${BACKEND_HTTP_URL}/api/context/resume`, {
      method: 'POST',
      body: form,
    });
    if (!res.ok) {
      const detail = await res.text();
      return { ok: false, error: `HTTP ${res.status}: ${detail.slice(0, 200)}` };
    }
    const data = (await res.json()) as { chars: number };
    return { ok: true, chars: data.chars };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
