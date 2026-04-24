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
  | { type: 'error'; message: string };

export interface TranscriptEvent {
  type: 'transcript';
  is_final: boolean;
  text: string;
  confidence: number;
  /** Seconds since epoch when the backend received/forwarded the transcript. */
  timestamp: number;
}
