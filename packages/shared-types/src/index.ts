export type Provider = 'gemini' | 'openai' | 'deepseek' | 'claude';

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

/** Models the user is allowed to pick for question detection. Mirrors
 *  `ALLOWED_QD_MODELS` in app.services.question_detection. Both Gemini
 *  (default) and OpenAI options are allowed so a power user can
 *  pre-emptively pick gpt-4o-mini when Gemini's quota is exhausted. */
export type QdModel = string;

/** Control messages sent from client → `/ws/transcribe`. */
export type WsControlMessage =
  | { type: 'start' }
  | { type: 'stop' }
  | { type: 'pause' }
  | { type: 'set_qd_model'; model: QdModel }
  /** Candidate asked to answer the newest question now (⌘⇧Space). The
   *  backend replies with `manual_question`. */
  | { type: 'detect_now' };

/** Lifecycle state of the per-session question detector. Used to show a
 *  "Listening / Analyzing" indicator in the Listen panel. */
export type QdState = 'idle' | 'listening' | 'detecting';

/** Server → client message on `/ws/transcribe`. */
export type WsServerMessage =
  | { type: 'ready'; session_id: string }
  | TranscriptEvent
  | QuestionDetectedEvent
  | { type: 'qd_state'; state: QdState }
  /** Fired once when the detector falls back from Gemini to GPT-4o
   *  (typically due to free-tier quota exhaustion). `model` is the model
   *  the detector switched to, currently always 'gpt-4o'. The UI uses
   *  this to show a small badge so the user knows their dropdown pick is
   *  being overridden until they change it. */
  | { type: 'qd_fallback'; model: string }
  /** Fired when both providers are unavailable (Gemini 429 → fallback
   *  also 429s) — QD has effectively stopped. Lets the UI show a clear
   *  "detection paused" state. */
  | { type: 'qd_error'; reason: string }
  /** Fired when the detector found a question but suppressed it as a
   *  duplicate of the most recent fire (within the cooldown). Lets the
   *  UI show a subtle "heard it" pulse without spawning a new entry. */
  | { type: 'qd_dedup'; question: string }
  /** Reply to `detect_now`: the newest question reconstructed from the
   *  transcript, or null when none was heard. */
  | { type: 'manual_question'; question: string | null }
  | { type: 'error'; message: string };

export interface TranscriptEvent {
  type: 'transcript';
  is_final: boolean;
  text: string;
  confidence: number;
  /** Seconds since epoch when the backend received/forwarded the transcript. */
  timestamp: number;
  /** Dominant speaker id for this segment, when Deepgram diarization is on.
   *  null when only one speaker has been heard so far or diarization was
   *  unavailable for the segment. */
  speaker?: number | null;
}

export interface QuestionDetectedEvent {
  type: 'question_detected';
  question: string;
  confidence: number;
  /** True when the detector + follow-up classifier think this question
   *  extends the prior thread rather than starting a new one. Frontend
   *  routes follow-ups through followUp() (append) instead of askAnswer()
   *  (new thread). Absent on legacy events. */
  is_follow_up?: boolean;
}

// ─── /ws/answer ──────────────────────────────────────────────────────────────

export type AnswerProvider = 'gemini' | 'openai' | 'deepseek' | 'claude';
import type { ReasoningEffort } from './model-catalog';
export type { ModelCapability, ModelOption, ReasoningEffort } from './model-catalog';
export {
  MODEL_CATALOG,
  REASONING_EFFORTS,
  isReasoningEffort,
  isValidModelId,
  modelOption,
  providerForModel,
} from './model-catalog';

export interface AnswerSessionContext {
  resume_text?: string;
  extra_instructions?: string;
  job_title?: string;
  company?: string;
  language?: string;
  recent_transcript?: string;
}

/** A single turn in an Answer thread. The tail of `messages` is always the
 *  current user turn the backend should respond to; everything before it is
 *  rendered as prior conversation in the prompt. */
export type AnswerRole = 'user' | 'assistant';
export interface AnswerMessage {
  role: AnswerRole;
  content: string;
}

/** Client → server. The legacy `{type:'question', question}` shape is still
 *  accepted by the backend (treated as a one-turn thread) so old clients
 *  keep working during a deploy. New clients should use `messages`. */
export type AnswerClientMessage =
  | {
      type: 'question';
      /** Full thread including the new user turn at the end. */
      messages?: AnswerMessage[];
      /** Legacy single-question payload. Used when `messages` is absent. */
      question?: string;
      /** Identifier shared across every turn in the same thread. Persisted
       *  on each qa_history row so the server-side history view can group
       *  follow-ups back into the conversation that produced them. */
      thread_id?: string;
      provider: AnswerProvider;
      model?: string;
      effort?: ReasoningEffort;
      session_context?: AnswerSessionContext;
      auto_detected?: boolean;
      /** Unique per send (a follow-up reuses `thread_id` but gets a fresh
       *  `request_id`). Echoed on every server message of that stream. */
      request_id?: string;
    }
  | { type: 'cancel' }
  | { type: 'ping' };

/** Server → client. `started.question` is the latest user turn (for legacy
 *  rendering); `started.thread_id` echoes the client's thread_id when one is
 *  provided so the client can correlate `saved` rows. Every message of a
 *  stream echoes the `request_id` the client sent, so messages from a stream
 *  the client already cancelled can be told apart from the current one.
 *  `pong` is connection-level and carries none. */
export type AnswerServerMessage =
  | ({ request_id?: string } & AnswerStreamMessage)
  | { type: 'pong' };

type AnswerStreamMessage =
  | {
      type: 'started';
      question: string;
      provider: AnswerProvider;
      thread_id?: string;
    }
  | { type: 'token'; text: string }
  | { type: 'done' }
  | { type: 'cancelled' }
  | { type: 'saved'; id: number; thread_id?: string }
  | {
      type: 'limit_exceeded';
      kind: 'tokens' | 'audio';
      message: string;
      used: number;
      limit: number;
    }
  /** Auto-fallback fired before any tokens streamed. The client should
   *  update its provider badge / cost attribution to `to`. `reason` is the
   *  trimmed error string from the failing upstream call. */
  | {
      type: 'provider_changed';
      from: AnswerProvider;
      to: AnswerProvider;
      reason: string;
    }
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

export type InterviewType = 'technical' | 'behavioral' | 'system_design' | 'mixed';

export interface SessionRow {
  session_id: string;
  job_title?: string | null;
  company?: string | null;
  language?: string | null;
  extra_instructions?: string | null;
  resume_text?: string | null;
  interview_type?: InterviewType | null;
  default_provider?: AnswerProvider | null;
  default_model?: string | null;
  has_resume?: number | boolean;
  created_at: number;
}

export interface QAHistoryRow {
  id: number;
  question: string;
  answer: string;
  provider: AnswerProvider | string;
  model?: string | null;
  auto_detected: number | boolean;
  created_at: number;
}

// ─── coding mode ─────────────────────────────────────────────────────────────

export type CodingPlatform = 'leetcode' | 'turing' | 'hackerrank' | 'coderpad' | 'other';

export type CodingDifficulty = 'easy' | 'medium' | 'hard';

export type CodingLanguage = 'Python' | 'JavaScript' | 'TypeScript' | 'Java' | 'C++' | 'Go';

export interface CodingExample {
  input: string;
  output: string;
  explanation?: string | null;
  /** Extractor couldn't reconcile this example with the statement (OCR
   *  misread). Excluded from self-verification to avoid false failures. */
  unreliable?: boolean;
}

/** Mirrors backend app.models.coding.ExtractedProblem. */
export interface ExtractedProblem {
  is_coding_problem: boolean;
  platform?: CodingPlatform | null;
  title?: string | null;
  difficulty?: CodingDifficulty | null;
  problem_statement?: string | null;
  examples?: CodingExample[] | null;
  constraints?: string[] | null;
  function_signature?: string | null;
  language_hint?: string | null;
  confidence: number;
}

/** Pushed over /ws/transcribe when vision extraction has a new problem. */
export interface CodingProblemDetectedEvent {
  type: 'coding_problem_detected';
  problem: ExtractedProblem;
  fingerprint: string;
}

export interface ScreenQuestionDetectedEvent {
  type: 'screen_question_detected';
  question: string;
  fingerprint: string;
}

/** Operating modes for /ws/coding-solution. `solve` is the existing
 *  problem→solution path. `explain` walks through a code snippet, `debug`
 *  diagnoses + fixes a snippet given an error message, `tests` generates
 *  edge-case test inputs for a problem. `agent` drives the local Claude Code
 *  CLI's tool loop (write code → run → fix) to verify a solution before
 *  answering — for hard problems the one-shot providers fail. */
export type CodingMode = 'solve' | 'explain' | 'debug' | 'tests' | 'agent';

// /ws/coding-solution protocol. The legacy {type:'solve'} payload still
// works; new modes route via {type:'solve' with mode:'…'} so the WS
// frame type stays a single 'solve' string the server already handles.
export type CodingSolutionClientMessage =
  | {
      type: 'solve';
      model?: string;
      effort?: ReasoningEffort;
      /** Defaults to 'solve' when absent — keeps legacy clients working. */
      mode?: CodingMode;
      /** Required for solve and tests modes. */
      problem?: ExtractedProblem;
      /** Required for explain and debug modes. */
      code?: string;
      /** Required for debug mode (the error message / stack trace). */
      error?: string;
      /** Optional free-text context for any mode (e.g. file name, function
       *  the user has selected, what they were trying to do). */
      hint?: string;
      /** Refine inputs for solve mode — the previous solution that failed
       *  and the user's note about what went wrong (e.g. "Case 2 failed,
       *  expected 94 got 64"). When either is set the solve prompt flips
       *  into refine framing. */
      prior_solution?: string;
      feedback?: string;
      language: CodingLanguage;
      provider: AnswerProvider;
      extra_instructions?: string;
    }
  | { type: 'cancel' }
  | { type: 'ping' };

/** Result of running a generated solution against one extracted example.
 *  `actual` is the repr() of what the solution returned; `error` is set
 *  instead when the call raised. Exactly one of actual/error is present. */
export interface CodingTestCaseResult {
  ok: boolean;
  input: string;
  expected: string;
  actual?: string | null;
  error?: string | null;
}

export type CodingSolutionServerMessage =
  | { type: 'screen_question_detected'; question: string; fingerprint: string }
  | {
      type: 'started';
      provider: AnswerProvider;
      language: CodingLanguage;
      model: string;
      mode?: CodingMode;
    }
  | { type: 'token'; text: string }
  | { type: 'done' }
  | { type: 'cancelled' }
  | { type: 'pong' }
  | { type: 'error'; message: string }
  | { type: 'saved'; id: number; fingerprint: string }
  | { type: 'provider_changed'; from: AnswerProvider; to: AnswerProvider; reason: string }
  /** Self-verification outcome for a just-streamed solve solution. `ran`
   *  is false when verification was skipped (non-Python, no examples,
   *  blocked code) — `skip_reason` says why and `cases` is empty. */
  | {
      type: 'test_results';
      fingerprint: string;
      ran: boolean;
      cases: CodingTestCaseResult[];
      skip_reason?: string | null;
    }
  /** Agent-mode trace events (mode: 'agent'). The agent works in a tool loop
   *  and emits its progress live; the final answer arrives whole in
   *  `agent_solution` (agent mode streams no `token` events). */
  | { type: 'agent_step'; text: string }
  | { type: 'agent_tool'; tool: string; summary: string }
  | { type: 'agent_tool_result'; ok: boolean; summary: string }
  /** `provisional: true` = the agent's examples pass but it's still hardening
   *  (perf gate / edge cases); the final message replaces it if improved. */
  | { type: 'agent_solution'; text: string; provisional?: boolean }
  | CodingProblemDetectedEvent;
