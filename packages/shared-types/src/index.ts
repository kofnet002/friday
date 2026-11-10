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
 *  `ALLOWED_QD_MODELS` in app.services.question_detection. Gemini
 *  (default), OpenAI and Claude options are allowed so a power user can
 *  pre-emptively pick gpt-4o-mini when Gemini's quota is exhausted, or
 *  move detection onto their Claude subscription entirely. The Claude
 *  options run through the local `claude` CLI when only
 *  CLAUDE_CODE_OAUTH_TOKEN is set, which adds process-startup latency per
 *  detection — Haiku is the sane pick there. */
export type QdModel =
  | 'gemini-2.5-flash-lite'
  | 'gemini-2.5-flash'
  | 'gemini-2.5-pro'
  | 'gpt-4o-mini'
  | 'gpt-4o'
  | 'claude-haiku-4-5'
  | 'claude-opus-5-5';

/** Control messages sent from client → `/ws/transcribe`. */
export type WsControlMessage =
  /** `audio_format: 'tagged'` — every binary frame starts with one source
   *  byte (0 = system audio / interviewer, 1 = mic / candidate). Omitted =
   *  raw system-audio PCM (legacy). */
  | { type: 'start'; audio_format?: 'tagged' }
  | { type: 'stop' }
  | { type: 'pause' }
  | { type: 'set_qd_model'; model: QdModel };

/** Lifecycle state of the per-session question detector. Used to show a
 *  "Listening / Analyzing" indicator in the Listen panel. */
export type QdState = 'idle' | 'listening' | 'detecting';

/** Server → client message on `/ws/transcribe`. */
export type WsServerMessage =
  | { type: 'ready'; session_id: string }
  | TranscriptEvent
  | QuestionDetectedEvent
  | QuestionCandidateEvent
  | QuestionRetractedEvent
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
  /** The session's audio budget so far: sent on `start` and about once a
   *  second while audio flows. */
  | { type: 'audio_usage'; used_minutes: number; limit_minutes: number }
  /** The session's audio budget is spent; the backend drops audio from here
   *  on. Also sent on `start` when the session was already over. */
  | {
      type: 'limit_exceeded';
      kind: 'audio';
      message: string;
      used_minutes: number;
      limit_minutes: number;
    }
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
  /** Which audio source the line came from on the dual-stream (Flux) path:
   *  system audio = interviewer, mic = candidate. Absent on the single-
   *  stream path. */
  source?: 'interviewer' | 'candidate';
}

/** Classifier verdict for an answerable question. `addendum` = a constraint
 *  added to the question already being answered (re-answer the thread). */
export type QuestionKind = 'new_question' | 'follow_up' | 'addendum';

export interface QuestionDetectedEvent {
  type: 'question_detected';
  question: string;
  confidence: number;
  /** True when the classifier thinks this question extends the prior
   *  thread (follow-up or addendum) rather than starting a new one.
   *  Frontend routes these through followUp() (append) instead of
   *  askAnswer() (new thread). Absent on legacy events. */
  is_follow_up?: boolean;
  kind?: QuestionKind;
  /** Present on the Flux path. When it matches a pending
   *  `question_candidate`, this CONFIRMS that candidate — reveal the answer
   *  already streaming for it instead of asking again. */
  candidate_id?: string;
}

/** The interviewer has *probably* finished a question (Flux
 *  EagerEndOfTurn). Start the answer now, hidden; reveal it on the matching
 *  `question_detected`, drop it on `question_retracted`. */
export interface QuestionCandidateEvent {
  type: 'question_candidate';
  candidate_id: string;
  question: string;
  confidence: number;
  is_follow_up: boolean;
  kind: QuestionKind;
  /** Sent with the raw turn text the moment the turn looks like a question,
   *  before the classifier has ruled. A later candidate with the SAME id
   *  carries the reconstructed question (relabel only — keep streaming); a
   *  retraction drops it. */
  provisional?: boolean;
}

/** The interviewer kept talking — discard the speculative answer. */
export interface QuestionRetractedEvent {
  type: 'question_retracted';
  candidate_id: string;
}

// ─── /ws/answer ──────────────────────────────────────────────────────────────

export type AnswerProvider = 'gemini' | 'openai' | 'deepseek' | 'claude';

export interface AnswerSessionContext {
  resume_text?: string;
  extra_instructions?: string;
  job_title?: string;
  company?: string;
  language?: string;
  recent_transcript?: string;
  /** Latest extracted content from the user's active screen. */
  screen_context?: string;
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
      session_context?: AnswerSessionContext;
      auto_detected?: boolean;
      /** Correlates the answer with a detected question (latency timeline). */
      candidate_id?: string;
      /** Unique per request; echoed on every server event of this stream. */
      request_id?: string;
      /** Started before the question was confirmed; the server persists it
       *  only after a matching `commit`. */
      speculative?: boolean;
    }
  /** Confirms a speculative answer so the server saves it. `question` is
   *  the confirmed wording, saved instead of the raw turn text the answer
   *  was requested with. */
  | { type: 'commit'; candidate_id: string; question?: string }
  | { type: 'cancel' }
  | { type: 'ping' };

/** Server → client. `started.question` is the latest user turn (for legacy
 *  rendering); `started.thread_id` echoes the client's thread_id when one is
 *  provided so the client can correlate `saved` rows. */
export type AnswerServerMessage = (
  | {
      type: 'started';
      question: string;
      provider: AnswerProvider;
      thread_id?: string;
    }
  | { type: 'token'; text: string }
  | { type: 'done' }
  | { type: 'cancelled' }
  | { type: 'pong' }
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
  | { type: 'error'; message: string }
) & {
  /** Echo of the request's `request_id` on every event of its stream. A
   *  superseded stream's trailing events (its `cancelled`, late tokens)
   *  carry the old id — drop them. Absent on pong / legacy servers. */
  request_id?: string;
};

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
  interview_type?: InterviewType | null;
  default_provider?: string | null;
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
  is_screen_question?: boolean;
  question?: string | null;
  visible_context?: string | null;
  screen_code?: string | null;
  completeness?: 'complete' | 'partial' | 'uncertain';
  missing_sections?: string[];
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
  source?: 'single_frame' | 'guided_scan';
}

export interface ScreenQuestionDetectedEvent {
  type: 'screen_question_detected';
  question: string;
  screen_code?: string | null;
  completeness: 'complete' | 'partial' | 'uncertain';
  missing_sections: string[];
  source: 'single_frame' | 'guided_scan';
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
  | CodingProblemDetectedEvent
  | ScreenQuestionDetectedEvent
  | FunctionCallDetectedEvent;

// ─── function-calling assessments ────────────────────────────────────────────
// A "Function Calling Test": given a task and a catalog of tools, pick the
// correct tool and construct its argument payload. Detected on-screen by vision
// (like a coding problem) or entered by hand; solved + self-verified via the
// REST endpoints under /api/function-call.

/** One callable tool. `parameters` (OpenAI shape) or `input_schema`
 *  (Anthropic shape) is a JSON-Schema object describing the arguments. */
export interface FunctionCallToolSpec {
  name: string;
  description?: string | null;
  parameters?: Record<string, unknown> | null;
  input_schema?: Record<string, unknown> | null;
}

/** Mirrors backend app.models.function_calling.ExtractedFunctionCall. */
export interface ExtractedFunctionCall {
  is_function_call: boolean;
  title?: string | null;
  question?: string | null;
  tools?: FunctionCallToolSpec[] | null;
  confidence: number;
}

/** Pushed over /ws/coding-solution when vision detects a function-calling
 *  assessment on a frame the coding detector rejected. */
export interface FunctionCallDetectedEvent {
  type: 'function_call_detected';
  assessment: ExtractedFunctionCall;
  fingerprint: string;
}

/** One structural self-verify check. `kind` ∈ tool-exists | unknown-tool |
 *  missing-required | unexpected-param | type-mismatch. */
export interface FunctionCallCheckResult {
  ok: boolean;
  kind: string;
  detail: string;
  field?: string | null;
}

/** Structural self-verify of a predicted call against the tool catalog.
 *  `ran` false = skipped (no tool named / empty catalog). */
export interface FunctionCallCheck {
  ran: boolean;
  ok: boolean;
  skip_reason?: string | null;
  checks: FunctionCallCheckResult[];
}

/** Graded comparison against an answer key (present only when the request
 *  supplied expected_tool). */
export interface FunctionCallGrade {
  correct: boolean;
  tool_match: boolean;
  payload_match: boolean;
  expected_tool: string;
  predicted_tool?: string | null;
  payload_diff?: string | null;
}

/** Response of POST /api/function-call/solve. */
export interface FunctionCallSolveResponse {
  prediction: { tool: string | null; arguments: Record<string, unknown> };
  model: string;
  check: FunctionCallCheck;
  grade?: FunctionCallGrade;
}

// ─── project context library ─────────────────────────────────────────────────
// Mirrors app.api.projects. Projects are library-level (not per session);
// sessions attach them so live answers can draw on each project's brief.

/** none → never generated · generating → background job running ·
 *  ready → current · stale → sources changed since the brief was made ·
 *  error → last generation failed (see `brief_error`). */
export type BriefStatus = 'none' | 'generating' | 'ready' | 'stale' | 'error';

export type ProjectSourceKind = 'file' | 'text' | 'folder' | 'claude_code';

/** Row shape of `projects` (GET /api/projects/{id}, PATCH, session links). */
export interface Project {
  id: string;
  name: string;
  description: string | null;
  brief: string | null;
  brief_status: BriefStatus;
  brief_error: string | null;
  /** 1 once the user hand-edits the brief; regenerating then needs force. */
  brief_edited: number | boolean;
  brief_model: string | null;
  created_at: number;
  updated_at: number;
}

/** GET /api/projects adds aggregate source stats to each row. */
export interface ProjectSummary extends Project {
  source_count: number;
  source_chars: number;
}

export interface ProjectSource {
  id: string;
  project_id: string;
  kind: ProjectSourceKind;
  title: string;
  /** File name, folder path or Claude Code project dir; null for pasted text. */
  origin: string | null;
  chars: number;
  meta: Record<string, unknown>;
  created_at: number;
}

/** Abbreviated source returned by the add-source endpoints. */
export interface ProjectSourceCreated {
  id: string;
  kind: ProjectSourceKind;
  title: string;
  chars: number;
}

/** Body of POST /api/projects/{id}/sources (file uploads are multipart). */
export type ProjectSourceCreate =
  | { kind: 'text'; title?: string; text: string }
  | { kind: 'folder'; path: string; include_diff?: boolean; title?: string }
  | {
      kind: 'claude_code';
      project_dir: string;
      session_ids?: string[];
      /** Also ingest the repo folder the sessions ran in. */
      include_repo?: boolean;
      title?: string;
    };

export interface ClaudeCodeSession {
  id: string;
  bytes: number;
  modified_at: number;
  first_prompt: string | null;
}

/** One entry of GET /api/claude-code/projects (~/.claude/projects/*). */
export interface ClaudeCodeProject {
  /** "<config dir>/<project dir>", e.g. ".claude-work/-Users-me-app" —
   *  pass back as `project_dir`. */
  dir: string;
  /** Claude Code profile (config dir) it came from: "default" for
   *  ~/.claude, "work" for ~/.claude-work. */
  profile: string;
  /** Working directory the sessions ran in. */
  path: string;
  name: string;
  modified_at: number;
  sessions: ClaudeCodeSession[];
}
