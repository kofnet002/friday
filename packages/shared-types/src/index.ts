export type Provider = 'gemini' | 'openai';

/** Mirrors backend `app.api.chat.ChatRequest` (Pydantic v2). */
export interface ChatRequest {
  provider: Provider;
  message: string;
}

/** SSE event payloads emitted by `POST /api/chat`. */
export interface ChatTokenEvent {
  text: string;
}

export interface ChatErrorEvent {
  message: string;
}

export type ChatEventName = 'token' | 'done' | 'error';

/** Control messages sent from client → `/ws/transcribe`. */
export type WsControlMessage = { type: 'start' } | { type: 'stop' } | { type: 'pause' };

/** Server → client message on `/ws/transcribe`. */
export type WsServerMessage =
  | { type: 'ready'; session_id: string }
  | TranscriptEvent
  | QuestionDetectedEvent
  | { type: 'error'; message: string };

export interface TranscriptEvent {
  type: 'transcript';
  is_final: boolean;
  text: string;
  confidence: number;
  /** Seconds since epoch when the backend received/forwarded the transcript. */
  timestamp: number;
}

export interface QuestionDetectedEvent {
  type: 'question_detected';
  question: string;
  confidence: number;
}

// ─── /ws/answer ──────────────────────────────────────────────────────────────

export type AnswerProvider = 'gemini' | 'openai';

export interface AnswerSessionContext {
  resume_text?: string;
  extra_instructions?: string;
  job_title?: string;
  company?: string;
  language?: string;
  recent_transcript?: string;
}

/** Client → server. */
export type AnswerClientMessage =
  | {
      type: 'question';
      question: string;
      provider: AnswerProvider;
      session_context?: AnswerSessionContext;
    }
  | { type: 'cancel' }
  | { type: 'ping' };

/** Server → client. */
export type AnswerServerMessage =
  | { type: 'started'; question: string; provider: AnswerProvider }
  | { type: 'token'; text: string }
  | { type: 'done' }
  | { type: 'cancelled' }
  | { type: 'pong' }
  | { type: 'error'; message: string };

// ─── /setup / context API ────────────────────────────────────────────────────

export interface SessionContextPayload {
  session_id: string;
  job_title?: string | null;
  company?: string | null;
  language?: string | null;
  extra_instructions?: string | null;
}

export interface SessionContextResponse {
  session_id: string;
  exists: boolean;
  job_title?: string | null;
  company?: string | null;
  language?: string | null;
  extra_instructions?: string | null;
  resume_excerpt?: string | null;
  resume_chars?: number;
}
