import type {
  AnswerProvider,
  ClaudeModel,
  CodingLanguage,
  InterviewType,
  QAHistoryRow,
  QdModel,
  SessionContextResponse,
  SessionRow,
} from '@friday/shared-types';

const SESSION_ID_KEY = 'friday.session.id';
const PROVIDER_KEY = 'friday.session.provider';
const CODING_LANGUAGE_KEY = 'friday.session.coding_language';
const QD_MODEL_KEY = 'friday.session.qd_model';
const QD_MODELS: readonly QdModel[] = [
  'gemini-2.5-flash-lite',
  'gemini-2.5-flash',
  'gemini-2.5-pro',
  'gpt-4o-mini',
  'gpt-4o',
  'claude-haiku-4-5',
  'claude-opus-5-5',
];
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

const SESSION_CHANGED_EVENT = 'friday:session-changed';

export function setSessionId(id: string): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(SESSION_ID_KEY, id);
  // The live session page (same window, e.g. Setup opened from the overlay)
  // holds sockets bound to the old id; tell it to move over.
  window.dispatchEvent(new CustomEvent<string>(SESSION_CHANGED_EVENT, { detail: id }));
}

/** Calls `cb` when the current session id changes, in this window or another. */
export function onSessionIdChange(cb: (id: string) => void): () => void {
  const local = (e: Event) => cb((e as CustomEvent<string>).detail);
  const other = (e: StorageEvent) => {
    if (e.key === SESSION_ID_KEY && e.newValue) cb(e.newValue);
  };
  window.addEventListener(SESSION_CHANGED_EVENT, local);
  window.addEventListener('storage', other);
  return () => {
    window.removeEventListener(SESSION_CHANGED_EVENT, local);
    window.removeEventListener('storage', other);
  };
}

export function readSessionId(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(SESSION_ID_KEY);
}

export function getProviderPreference(): AnswerProvider {
  if (typeof window === 'undefined') return 'gemini';
  const raw = window.localStorage.getItem(PROVIDER_KEY);
  if (raw === 'openai') return 'openai';
  if (raw === 'deepseek') return 'deepseek';
  if (raw === 'claude') return 'claude';
  return 'gemini';
}

export function setProviderPreference(p: AnswerProvider): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(PROVIDER_KEY, p);
}

const CLAUDE_MODEL_KEY = 'friday.session.coding_claude_model';
/** Claude models offered in screen mode, in picker order. */
export const CLAUDE_MODEL_OPTIONS: readonly { id: ClaudeModel; label: string }[] = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5' },
  { id: 'claude-fable-5-2', label: 'Claude Fable 5.2' },
];

export function getCodingClaudeModelPreference(): ClaudeModel {
  if (typeof window === 'undefined') return 'claude-opus-5-5';
  const raw = window.localStorage.getItem(CLAUDE_MODEL_KEY);
  const match = CLAUDE_MODEL_OPTIONS.find((option) => option.id === raw);
  return match ? match.id : 'claude-opus-5-5';
}

export function setCodingClaudeModelPreference(model: ClaudeModel): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(CLAUDE_MODEL_KEY, model);
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

export function getQdModelPreference(): QdModel {
  if (typeof window === 'undefined') return 'gemini-2.5-flash-lite';
  const raw = window.localStorage.getItem(QD_MODEL_KEY);
  if (raw && (QD_MODELS as readonly string[]).includes(raw)) {
    return raw as QdModel;
  }
  return 'gemini-2.5-flash-lite';
}

export function setQdModelPreference(model: QdModel): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(QD_MODEL_KEY, model);
}

export const ALL_QD_MODELS = QD_MODELS;

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
  interview_type?: InterviewType | null;
  default_provider?: AnswerProvider | null;
}): Promise<boolean> {
  // /api/sessions handles the fuller schema (interview_type, default_provider).
  const res = await fetch(`${BACKEND_HTTP_URL}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return res.ok;
}

export async function fetchLatestSession(): Promise<SessionRow | null> {
  try {
    const res = await fetch(`${BACKEND_HTTP_URL}/api/sessions/latest`);
    if (!res.ok) return null;
    const data = (await res.json()) as { session: SessionRow | null };
    return data.session ?? null;
  } catch {
    return null;
  }
}

export async function fetchSessionDetail(
  sessionId: string,
): Promise<{ qa: QAHistoryRow[] } | null> {
  try {
    const res = await fetch(`${BACKEND_HTTP_URL}/api/sessions/${sessionId}`);
    if (!res.ok) return null;
    return (await res.json()) as { qa: QAHistoryRow[] };
  } catch {
    return null;
  }
}

export function sessionExportUrl(sessionId: string): string {
  return `${BACKEND_HTTP_URL}/api/sessions/${sessionId}/export`;
}

export interface SessionUsageRow {
  kind: string; // 'answer' | 'coding_solution' | 'vision' | 'question_detection' | ...
  provider: string | null;
  model: string | null;
  calls: number;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
}

export interface SessionUsageSummary {
  session_id: string;
  rows: SessionUsageRow[];
  total_cost_usd: number;
  total_calls: number;
  total_input_tokens: number;
  total_output_tokens: number;
  token_limit?: number;
  audio_minutes_used?: number;
  audio_minutes_limit?: number;
}

/**
 * Mirror a runtime provider change into the server's session row so
 * desktop-driven /api/vision/extract calls (which don't otherwise know the
 * user's current pick) honor it.
 */
/** Forget the session's remembered passages and current screen text. */
export async function clearScreenContext(sessionId: string): Promise<boolean> {
  if (!sessionId) return false;
  try {
    const res = await fetch(
      `${BACKEND_HTTP_URL}/api/vision/screen-context?session_id=${encodeURIComponent(sessionId)}`,
      { method: 'DELETE' },
    );
    return res.ok;
  } catch {
    return false;
  }
}

/** A kept screenshot; `label` names the figures it shows (null if unlabelled). */
export type SavedImage = { key: string; label: string | null };

export type SavedPassage = { id: string; text: string; images: SavedImage[]; saved_at: number };

/** The session's remembered passages, oldest first; null when unreachable. */
export async function fetchSavedPassages(sessionId: string): Promise<SavedPassage[] | null> {
  if (!sessionId) return null;
  try {
    const res = await fetch(
      `${BACKEND_HTTP_URL}/api/vision/screen-context?session_id=${encodeURIComponent(sessionId)}`,
    );
    if (!res.ok) return null;
    return ((await res.json()) as { references: SavedPassage[] }).references;
  } catch {
    return null;
  }
}

export async function removeSavedPassage(sessionId: string, id: string): Promise<boolean> {
  if (!sessionId || !id) return false;
  try {
    const res = await fetch(
      `${BACKEND_HTTP_URL}/api/vision/screen-reference/${encodeURIComponent(id)}?session_id=${encodeURIComponent(sessionId)}`,
      { method: 'DELETE' },
    );
    return res.ok;
  } catch {
    return false;
  }
}

export function screenImageUrl(sessionId: string, key: string): string {
  return `${BACKEND_HTTP_URL}/api/vision/screen-image/${encodeURIComponent(key)}?session_id=${encodeURIComponent(sessionId)}`;
}

export async function patchSessionProvider(
  sessionId: string,
  provider: AnswerProvider,
): Promise<boolean> {
  if (!sessionId) return false;
  try {
    const res = await fetch(`${BACKEND_HTTP_URL}/api/sessions/${sessionId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId, default_provider: provider }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function fetchSessionUsage(sessionId: string): Promise<SessionUsageSummary | null> {
  if (!sessionId) return null;
  try {
    const res = await fetch(`${BACKEND_HTTP_URL}/api/sessions/${sessionId}/usage`);
    if (!res.ok) return null;
    return (await res.json()) as SessionUsageSummary;
  } catch {
    return null;
  }
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

export interface SessionOverviewRow {
  session_id: string;
  job_title: string | null;
  company: string | null;
  interview_type: string | null;
  created_at: number;
  last_active_at: number;
  has_resume: boolean;
  qa_count: number;
  cost_usd: number;
  audio_minutes_used: number;
}

export interface SessionsOverview {
  sessions: SessionOverviewRow[];
  audio_minutes_limit: number;
}

export async function fetchSessionsOverview(limit = 20): Promise<SessionsOverview | null> {
  try {
    const res = await fetch(`${BACKEND_HTTP_URL}/api/sessions/overview?limit=${limit}`);
    if (!res.ok) return null;
    return (await res.json()) as SessionsOverview;
  } catch {
    return null;
  }
}

/** New session id carrying over `sessionId`'s role, resume and projects.
 *  Null when that session was never saved (nothing to carry over). */
export async function forkSession(sessionId: string): Promise<string | null> {
  try {
    const res = await fetch(`${BACKEND_HTTP_URL}/api/sessions/${sessionId}/fork`, {
      method: 'POST',
    });
    if (!res.ok) return null;
    return ((await res.json()) as { session_id: string }).session_id;
  } catch {
    return null;
  }
}
