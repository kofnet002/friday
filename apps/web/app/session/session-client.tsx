'use client';

import * as Popover from '@radix-ui/react-popover';
import {
  forwardRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import {
  ChevronDown,
  ChevronUp,
  Download,
  Eraser,
  Keyboard,
  Loader2,
  MoreVertical,
  Move,
  Pause,
  Play,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  Square,
  X,
} from 'lucide-react';
import type {
  AnswerMessage,
  AnswerProvider,
  AnswerServerMessage,
  ClaudeModel,
  CodingLanguage,
  CodingMode,
  CodingSolutionServerMessage,
  ExtractedProblem,
  Project,
  QAHistoryRow,
  QdModel,
  QdState,
  QuestionCandidateEvent,
  TranscriptEvent,
  WsServerMessage,
} from '@friday/shared-types';

import { Button } from '@/components/ui/button';
import { PanelErrorBoundary } from '@/components/error-boundary';
import { AnswerWs } from '@/lib/answer-ws';
import { CodingWs } from '@/lib/coding-ws';
import {
  fetchSessionDetail,
  fetchSessionUsage,
  clearScreenContext,
  getCodingClaudeModelPreference,
  getCodingLanguagePreference,
  getOrCreateSessionId,
  onSessionIdChange,
  getProviderPreference,
  getQdModelPreference,
  patchSessionProvider,
  sessionExportUrl,
  setCodingClaudeModelPreference,
  setCodingLanguagePreference,
  setProviderPreference,
  setQdModelPreference,
  type SessionUsageSummary,
} from '@/lib/session-context';
import { TranscribeWs } from '@/lib/transcribe-ws';
import { cn } from '@/lib/utils';
import { normalizeQuestion, planScreenAnswer } from '@/lib/screen-question-routing';
import {
  indexAfterRemoval,
  isAtLatest,
  latestIndex,
  listPosition,
  resolveIndex,
  stepIndex,
} from '@/lib/answer-lists';

import { AssistPanel, type AssistView } from './assist-panel';
import { SetupForm } from '../setup/setup-form';
import { AnswerPanel, AudioBudgetPill, type AnswerStatus, type AudioUsage } from './answer-panel';
import {
  CodingPanel,
  type AgentSessionStats,
  type AgentStep,
  type CodingProblemTab,
  type CodingScratchState,
} from './coding-panel';
import { FeatureBar, SECONDARY_FEATURES, getFeatureWidth, type FeatureKey } from './feature-bar';
import { AttachedProjectChips, ProjectBriefModal } from './project-chips';
import {
  ConnectionPill,
  HistoryList,
  ModalShell,
  SettingsBody,
  ShortcutsModal,
} from './session-modals';

const MAX_CODING_TABS = 3;

type Status = 'idle' | 'starting' | 'recording' | 'paused' | 'error';

interface AnswerEntry {
  id: string;
  /** Multi-turn thread — first message is always a user turn (the original
   *  question), and the conversation alternates from there. `question` and
   *  `answer` are derived caches over this array; everything that needs the
   *  full thread (follow-ups, persistence) reads `messages` directly. */
  messages: AnswerMessage[];
  /** Stable identifier shared by every turn in this thread. Sent on each WS
   *  payload so the backend can persist follow-ups against the same row
   *  group in qa_history (idx_qa_thread). */
  threadId: string;
  /** First user message, cached for the panel header and history list. */
  question: string;
  /** Most recent assistant content. Tokens stream into this as they arrive
   *  AND into messages[messages.length-1].content so the two stay in sync.
   *  Cached separately so panel re-renders are cheap. */
  answer: string;
  status: AnswerStatus;
  error: string | null;
  marked: boolean;
  createdAt: number;
  /** Answers a question read off the screen. Shown in the Screen tab;
   *  everything else (spoken / typed) is shown in AI Help. */
  fromScreen?: boolean;
}

type TranscriptSource = 'interviewer' | 'candidate';

/** One finalized transcript line. `source` is set on the dual-stream path
 *  (system audio = interviewer, mic = candidate); null on single-stream. */
interface TranscriptLine {
  text: string;
  source: TranscriptSource | null;
  /** This interviewer line produced a detected question. */
  asked?: boolean;
}

type Interims = Record<TranscriptSource, string>;
const EMPTY_INTERIMS: Interims = { interviewer: '', candidate: '' };

/** A speculative answer: started when the interviewer *probably* finished a
 *  question (question_candidate), streaming into a hidden entry until the
 *  backend confirms (question_detected with the same candidate_id) or
 *  retracts it. `targetId` is set for a follow-up into an existing thread. */
interface PendingAnswer {
  candidateId: string;
  entry: AnswerEntry;
  targetId: string | null;
  streaming: boolean;
}

// Capture the candidate's mic alongside system audio. The backend uses it
// to tell the interviewer has finished (the candidate started answering)
// and as context for follow-ups; it's echo-cancelled in the helper.
const CAPTURE_MIC = true;

const AUTOSCROLL_THRESHOLD_PX = 48;

// The three scratch coding modes. Carved out as a type alias because
// codingScratchByMode keys against this set. `solve` uses tabs, and `agent`
// runs on the active tab (not a scratch buffer), so both are excluded.
type ScratchMode = Exclude<CodingMode, 'solve' | 'agent'>;
// Force-ask (⌘⇧Space) sends the last N finalized transcript chunks to the
// copilot. The interviewer's question often isn't the *last* thing said —
// they ask, then keep narrating. Keep this window wide enough that the
// question is included; the prompt instructs the LLM to extract it.
const RECENT_FINALS_JOIN = 8;

export function SessionClient() {
  const [sessionId, setSessionIdState] = useState<string>('');
  // Same id, readable from callbacks without re-subscribing.
  const sessionIdRef = useRef('');
  const [status, setStatus] = useState<Status>('idle');
  const audioStatusRef = useRef<Status>(status);
  audioStatusRef.current = status;
  const [error, setError] = useState<string | null>(null);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  // Per-provider latency for the answer stream. answerLatencyByProvider
  // holds the most-recent elapsed_ms keyed by the EFFECTIVE provider
  // (post-fallback). answerLatencyMs + answerLatencyProvider hold the
  // single most-recent value for the bar badge; the full map is shown
  // on hover.
  const [answerLatencyMs, setAnswerLatencyMs] = useState<number | null>(null);
  const [answerLatencyProvider, setAnswerLatencyProvider] = useState<AnswerProvider | null>(null);
  const [answerLatencyByProvider, setAnswerLatencyByProvider] = useState<
    Partial<Record<AnswerProvider, number>>
  >({});
  const answerStartedAtRef = useRef<number | null>(null);
  const answerEffectiveProviderRef = useRef<AnswerProvider | null>(null);
  const [finals, setFinals] = useState<TranscriptLine[]>([]);
  const [interims, setInterims] = useState<Interims>(EMPTY_INTERIMS);

  // Answer panel state — every ask appends a new AnswerEntry; the panel
  // displays entries[entryIndex] and the chevrons step the index. The
  // currently-streaming entry is tracked separately via streamingIdRef so
  // tokens always land on the right entry even if the user navigates away
  // while the LLM is still streaming.
  const [provider, setProvider] = useState<AnswerProvider>('gemini');
  // Claude model for screen mode (solving + screen reading). Kept in a ref
  // too so sockets/IPC created later pick up the current choice.
  const [codingClaudeModel, setCodingClaudeModel] = useState<ClaudeModel>('claude-opus-5-5');
  const codingClaudeModelRef = useRef<ClaudeModel>('claude-opus-5-5');
  const [entries, setEntries] = useState<AnswerEntry[]>([]);
  // entryIndex selects AI Help's entry and screenEntryIndex the Screen tab's;
  // both index the shared `entries` list (see lib/answer-lists).
  const [entryIndex, setEntryIndex] = useState(-1);
  const [screenEntryIndex, setScreenEntryIndex] = useState(-1);
  const [panelError, setPanelError] = useState<string | null>(null);
  const [answerConnected, setAnswerConnected] = useState(false);
  const streamingIdRef = useRef<string | null>(null);
  // request_id of the answer stream we currently expect events from. The
  // server echoes it on every event; anything else is a superseded stream's
  // trailing `cancelled` / tokens and must not touch the current entry.
  const activeRequestRef = useRef<string | null>(null);

  // Question-detection model + lifecycle state. The model is a user
  // preference; the state reflects the per-session detector's current
  // phase (idle/listening/detecting) and drives the Listen-panel pill.
  const [qdModel, setQdModelState] = useState<QdModel>('gemini-2.5-flash-lite');
  const [qdState, setQdState] = useState<QdState>('idle');
  // Non-null when the backend has fallen back from Gemini to GPT-4o for
  // QD (typically a 429). Reset when the user explicitly picks a new
  // model. Drives the "fallback" badge next to the QD dropdown.
  const [qdFallbackModel, setQdFallbackModel] = useState<string | null>(null);
  // Non-null when BOTH Gemini and the fallback provider are unavailable.
  // QD has effectively stopped — surfaced as a critical badge.
  const [qdError, setQdError] = useState<string | null>(null);
  // Briefly highlights the status pill when the detector saw a question
  // and suppressed it as a duplicate. Auto-clears.
  const [qdDedupAt, setQdDedupAt] = useState<number>(0);
  const qdModelRef = useRef<QdModel>('gemini-2.5-flash-lite');
  qdModelRef.current = qdModel;

  // Coding panel state
  const [codingActive, setCodingActive] = useState(false);
  const [codingPaused, setCodingPaused] = useState(false);
  const [codingStarting, setCodingStarting] = useState(false);
  const codingStartingRef = useRef(false);
  const [codingLanguage, setCodingLanguage] = useState<CodingLanguage>('Python');
  const [codingTabs, setCodingTabs] = useState<CodingProblemTab[]>([]);
  const [activeFingerprint, setActiveFingerprint] = useState<string | null>(null);
  const [codingFrame, setCodingFrame] = useState<{
    changed_bits: number;
    interval_ms: number;
  } | null>(null);
  const [codingError, setCodingError] = useState<string | null>(null);
  const screenContextRef = useRef<string | null>(null);
  const screenCaptureActiveRef = useRef(false);
  const answerScreenContext = () => ({
    screen_context: screenCaptureActiveRef.current ? (screenContextRef.current ?? '') : '',
  });
  const [scanState, setScanState] = useState<FridayScanState | null>(null);
  const [pendingScreenQuestion, setPendingScreenQuestion] = useState<{
    question: string;
    completeness: 'partial' | 'uncertain';
    missingSections: string[];
  } | null>(null);
  const askAnswerRef = useRef<
    (q: string, opts?: { autoDetected?: boolean; fromScreen?: boolean }) => string | undefined
  >(() => undefined);
  // The answer page the current guided scan is filling, so questions found
  // later in the scan join it instead of opening a new page.
  const scanAnswerRef = useRef<{ scanId: string; entryId: string } | null>(null);
  // Screen follow-ups waiting for the current answer to finish streaming
  // (starting one would cancel the stream in flight).
  const pendingScreenFollowUpsRef = useRef<{ entryId: string; text: string }[]>([]);
  const followUpRef = useRef<(q: string, opts?: { entryId?: string }) => void>(() => {});
  const flushScreenFollowUps = () => {
    // Deferred so a terminal stream message finishes updating state first.
    setTimeout(() => {
      if (streamingIdRef.current) return;
      const next = pendingScreenFollowUpsRef.current.shift();
      if (next) followUpRef.current(next.text, { entryId: next.entryId });
    }, 0);
  };
  const sendScreenFollowUp = (entryId: string, text: string) => {
    pendingScreenFollowUpsRef.current.push({ entryId, text });
    flushScreenFollowUps();
  };
  // Threads started from questions read off the screen. Their answers (and
  // follow-ups) use the Screen panel's Claude model, not AI Help's.
  const screenThreadIdsRef = useRef<Set<string>>(new Set());
  const screenClaudeModelFor = (threadId: string): ClaudeModel | undefined =>
    providerRef.current === 'claude' && screenThreadIdsRef.current.has(threadId)
      ? codingClaudeModelRef.current
      : undefined;
  // Questions already answered from the screen this session, so a rescan or
  // the watcher re-reading the same page doesn't answer them twice.
  const answeredScreenRef = useRef<Set<string>>(new Set());
  const [passagesRefreshKey, setPassagesRefreshKey] = useState(0);
  // Start fresh: forget remembered passages, the current screen text, and
  // which on-screen questions were already answered.
  const resetScreenContext = (sid: string) => {
    answeredScreenRef.current = new Set();
    // Refetch only once the backend has cleared, or the list would reappear.
    void clearScreenContext(sid).then(() => setPassagesRefreshKey((k) => k + 1));
  };
  const [codingConnected, setCodingConnected] = useState(false);
  // Coding panel mode (solve / explain / debug / tests). Each non-solve
  // mode keeps its OWN scratch buffer — switching from Explain to Debug
  // (or back) preserves both inputs AND output for the mode you left.
  // Solve mode uses the tab list, not this buffer.
  const [codingMode, setCodingMode] = useState<CodingMode>('solve');
  const blankScratch = (m: ScratchMode): CodingScratchState => ({
    mode: m,
    code: '',
    error: '',
    hint: '',
    output: '',
    status: 'idle',
    errorMessage: null,
  });
  const [codingScratchByMode, setCodingScratchByMode] = useState<
    Record<ScratchMode, CodingScratchState>
  >({
    explain: blankScratch('explain'),
    debug: blankScratch('debug'),
    tests: blankScratch('tests'),
  });
  // Which mode (if any) is currently streaming. The WS handler reads this
  // ref to route incoming tokens to the right scratch slice. null = no
  // scratch stream in flight (tokens go to the solve-mode active tab).
  const codingScratchStreamingModeRef = useRef<ScratchMode | null>(null);
  // True while an agent-mode run is streaming into the active tab. Agent runs
  // route by activeFingerprint (like solve) but need to be distinguished from
  // a normal solve so started/done/error patch the tab's `agent` slice.
  const codingAgentStreamingRef = useRef<boolean>(false);
  // Fingerprints that already got their ONE automatic agent escalation this
  // session. Prevents the verify-fail → agent → refine → verify-fail loop
  // from re-launching the agent forever (esp. when an OCR-corrupted example
  // can never pass). Manual Agent-button runs are not gated by this.
  const autoEscalatedRef = useRef<Set<string>>(new Set());
  // Session-cumulative agent usage — surfaced as a pill so subscription
  // spend is visible the way the cost pill shows API spend.
  const [agentStats, setAgentStats] = useState<AgentSessionStats>({ runs: 0, totalMs: 0 });
  const agentRunStartRef = useRef<number>(0);

  // Active feature popover (null = no popover open, transcript visible behind)
  const [activeFeature, setActiveFeature] = useState<FeatureKey | null>(null);
  const [assistView, setAssistView] = useState<AssistView>('answers');

  // Recording timer
  const [elapsedMs, setElapsedMs] = useState(0);
  const recordingStartRef = useRef<number | null>(null);

  // Modals + history
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [briefProject, setBriefProject] = useState<Project | null>(null);
  const [history, setHistory] = useState<QAHistoryRow[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [usage, setUsage] = useState<SessionUsageSummary | null>(null);
  // Audio minutes this session has used against its per-session cap. Seeded
  // from /usage, then kept live by the transcribe socket's audio_usage.
  const [audioUsage, setAudioUsage] = useState<AudioUsage | null>(null);
  // stop() is declared further down; the transcribe handler reaches it here.
  const stopRef = useRef<() => Promise<void>>(async () => {});
  const [desktopStatus, setDesktopStatus] = useState<FridayWindowStatus | null>(null);
  const [privacyMode, setPrivacyMode] = useState(false);
  const [desktopToast, setDesktopToast] = useState<string | null>(null);
  const [stealthMode, setStealthMode] = useState(false);
  const [shieldOpen, setShieldOpen] = useState(false);
  const [stealthDisableConfirmOpen, setStealthDisableConfirmOpen] = useState(false);
  // Parakeet-style chrome: ⋮ overflow holds non-hero actions; ^ collapses
  // the bar to brand+capture for a minimal footprint.
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  const transcribeRef = useRef<TranscribeWs | null>(null);
  const answerRef = useRef<AnswerWs | null>(null);
  const codingWsRef = useRef<CodingWs | null>(null);
  const lastSendAtRef = useRef<number>(0);
  const audioUnsubsRef = useRef<Array<() => void>>([]);
  const codingUnsubsRef = useRef<Array<() => void>>([]);
  const finalsRef = useRef<TranscriptLine[]>([]);
  const interimsRef = useRef<Interims>(EMPTY_INTERIMS);
  // Hidden speculative answer, if any (see PendingAnswer).
  const pendingRef = useRef<PendingAnswer | null>(null);
  // Audio framing negotiated at Start — resume must repeat it.
  const audioFormatRef = useRef<'tagged' | undefined>(undefined);
  // A question was detected while the interviewer's line was still a live
  // partial (they asked, then kept talking) — mark the line once it's final.
  const markNextInterviewerFinalRef = useRef(false);
  const providerRef = useRef<AnswerProvider>('gemini');
  const codingLanguageRef = useRef<CodingLanguage>('Python');
  const activeFingerprintRef = useRef<string | null>(null);
  const codingTabsRef = useRef<CodingProblemTab[]>([]);
  const toastTimerRef = useRef<number | null>(null);
  const shieldRef = useRef<HTMLDivElement>(null);
  const entriesRef = useRef<AnswerEntry[]>([]);
  // Mirror entryIndex into a ref so callbacks with stable identity
  // (onTranscribeMessage, followUp) can read the current value without
  // depending on it. Without this, the empty-deps useCallback below
  // would route auto-detected follow-ups to the index from the first
  // render even after the user chevroned away.
  const entryIndexRef = useRef<number>(-1);
  const screenEntryIndexRef = useRef<number>(-1);
  // Timestamp of the most recent force-ask. Auto-detected questions that
  // arrive within a short cooldown of a force-ask are suppressed — the
  // user already triggered a manual ask on substantially the same
  // transcript window, so the auto-detect is almost certainly redundant.
  const lastForceAskAtRef = useRef<number>(0);
  // Must exceed the backend's ceiling timer (4500ms default) PLUS typical
  // LLM latency (500-1500ms) so a force-ask reliably suppresses the
  // matching auto-detect that lands ~5-6s later. 7000ms gives a comfortable
  // margin without making the suppression window so wide that genuinely
  // separate questions get dropped.
  const FORCE_ASK_AUTODETECT_COOLDOWN_MS = 7000;

  finalsRef.current = finals;
  interimsRef.current = interims;
  providerRef.current = provider;
  codingLanguageRef.current = codingLanguage;
  activeFingerprintRef.current = activeFingerprint;
  codingTabsRef.current = codingTabs;
  entriesRef.current = entries;
  entryIndexRef.current = entryIndex;
  screenEntryIndexRef.current = screenEntryIndex;

  const currentIndex = resolveIndex(entries, entryIndex, false);
  const currentEntry = currentIndex >= 0 ? (entries[currentIndex] ?? null) : null;
  const screenIndex = resolveIndex(entries, screenEntryIndex, true);
  const screenEntry = screenIndex >= 0 ? (entries[screenIndex] ?? null) : null;
  /** AI Help's selected entry, else its newest; -1 when it has none. */
  const spokenIndexNow = () => {
    const idx = resolveIndex(entriesRef.current, entryIndexRef.current, false);
    return idx >= 0 ? idx : latestIndex(entriesRef.current, false);
  };

  const inElectron = typeof window !== 'undefined' && Boolean(window.friday);
  // Decided after mount: the server can't see window.friday, so rendering
  // the browser-only banner from `inElectron` made the server and the
  // Electron client disagree (hydration mismatch).
  const [showBrowserBanner, setShowBrowserBanner] = useState(false);
  useEffect(() => {
    setShowBrowserBanner(!window.friday);
  }, []);

  // On mount: resolve session_id and provider pref, then open the answer WS.
  useEffect(() => {
    const sid = getOrCreateSessionId();
    sessionIdRef.current = sid;
    setSessionIdState(sid);
    setProvider(getProviderPreference());
    const savedClaudeModel = getCodingClaudeModelPreference();
    codingClaudeModelRef.current = savedClaudeModel;
    setCodingClaudeModel(savedClaudeModel);
    setCodingLanguage(getCodingLanguagePreference());
    setQdModelState(getQdModelPreference());

    const ws = new AnswerWs(sid, {
      onMessage: onAnswerMessage,
      onOpen: () => setAnswerConnected(true),
      onClose: () => {
        setAnswerConnected(false);
        // A stream cut off by the drop will never get `done`; end it as an
        // error so it doesn't spin forever (the socket reconnects itself).
        if (streamingIdRef.current) {
          onAnswerMessage({
            type: 'error',
            message:
              'Connection to the backend dropped mid-answer. Ask again once Copilot is live.',
            ...(activeRequestRef.current ? { request_id: activeRequestRef.current } : {}),
          });
        }
      },
      onError: () => setAnswerConnected(false),
    });
    ws.connect();
    answerRef.current = ws;

    const codingWs = new CodingWs(sid, {
      onMessage: onCodingSolutionMessage,
      onOpen: () => setCodingConnected(true),
      onClose: () => setCodingConnected(false),
      onError: () => setCodingConnected(false),
    });
    codingWs.setClaudeModel(codingClaudeModelRef.current);
    codingWs.connect();
    codingWsRef.current = codingWs;

    return () => {
      ws.close();
      answerRef.current = null;
      codingWs.close();
      codingWsRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!inElectron || !window.friday?.appWindow) return;

    let mounted = true;
    window.friday.appWindow.status().then((status) => {
      if (!mounted) return;
      setDesktopStatus(status);
      setStealthMode(Boolean(status.stealth?.enabled));
    });

    const offStatus = window.friday.appWindow.onStatus((status) => {
      setDesktopStatus(status);
      setStealthMode(Boolean(status.stealth?.enabled));
    });
    const offToast = window.friday.appWindow.onToast((toast) => {
      setDesktopToast(toast.message);
      if (toastTimerRef.current) {
        window.clearTimeout(toastTimerRef.current);
      }
      toastTimerRef.current = window.setTimeout(() => {
        setDesktopToast(null);
        toastTimerRef.current = null;
      }, 1800);
    });

    return () => {
      mounted = false;
      offStatus();
      offToast();
      if (toastTimerRef.current) {
        window.clearTimeout(toastTimerRef.current);
        toastTimerRef.current = null;
      }
    };
  }, [inElectron]);

  useEffect(() => {
    if (!shieldOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!shieldRef.current?.contains(event.target as Node)) {
        setShieldOpen(false);
      }
    };
    window.addEventListener('mousedown', onPointerDown);
    return () => window.removeEventListener('mousedown', onPointerDown);
  }, [shieldOpen]);

  // Click-through routing: by default the Electron window ignores mouse
  // events so the desktop underneath stays clickable. While the cursor is
  // over any [data-interactive] surface (the bar, popovers, modals,
  // dropdowns) we flip the window to capture events. A small debounce on
  // the "leave" side bridges the visual gap between the bar and the
  // popover so brief gap-crossings don't drop interactivity mid-action.
  useEffect(() => {
    if (!inElectron) return;
    const api = window.friday?.appWindow;
    if (!api?.setInteractive) return;

    let lastInteractive = false;
    let pointerHeld = false;
    let leaveTimer: number | null = null;

    const apply = (next: boolean) => {
      if (next === lastInteractive) return;
      lastInteractive = next;
      void api.setInteractive(next);
    };

    const evaluate = (clientX: number, clientY: number) => {
      const el = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
      const wantsInteractive = !!el?.closest('[data-interactive="true"]');
      if (leaveTimer !== null) {
        window.clearTimeout(leaveTimer);
        leaveTimer = null;
      }
      if (wantsInteractive) {
        apply(true);
        return;
      }
      if (pointerHeld) return;
      leaveTimer = window.setTimeout(() => {
        leaveTimer = null;
        apply(false);
      }, 120);
    };

    const onMove = (e: MouseEvent) => evaluate(e.clientX, e.clientY);
    const onDown = (e: MouseEvent) => {
      pointerHeld = true;
      evaluate(e.clientX, e.clientY);
    };
    const onUp = (e: MouseEvent) => {
      pointerHeld = false;
      evaluate(e.clientX, e.clientY);
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mousedown', onDown);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('mouseup', onUp);
      if (leaveTimer !== null) window.clearTimeout(leaveTimer);
      void api.setInteractive(false);
    };
  }, [inElectron]);

  // Drop zones: while Setup is open, tell the desktop shell where files and
  // folders can be dropped. A drag from Finder sends no mouse moves to a
  // click-through window, so the hover routing above never flips it; the
  // shell polls the cursor against these rects instead.
  useEffect(() => {
    const setZones = window.friday?.appWindow?.setDropZones;
    if (!inElectron || !setZones || activeFeature !== 'setup') return;
    let last = '';
    const report = () => {
      const rects = Array.from(document.querySelectorAll<HTMLElement>('[data-drop-zone="true"]'))
        .map((el) => el.getBoundingClientRect())
        .filter((r) => r.width > 0 && r.height > 0)
        .map((r) => ({
          x: Math.round(r.left),
          y: Math.round(r.top),
          width: Math.round(r.width),
          height: Math.round(r.height),
        }));
      const key = JSON.stringify(rects);
      if (key === last) return;
      last = key;
      void setZones(rects);
    };
    report();
    // The popover animates in, can be resized and grows with its content;
    // re-measuring is cheap and only sends IPC when a rect changed.
    const id = window.setInterval(report, 250);
    return () => {
      window.clearInterval(id);
      void setZones([]);
    };
  }, [inElectron, activeFeature]);

  // ─── answer WS message handling ────────────────────────────────────────────
  const updateEntry = useCallback(
    (id: string, patch: Partial<AnswerEntry> | ((entry: AnswerEntry) => Partial<AnswerEntry>)) => {
      setEntries((prev) =>
        prev.map((e) =>
          e.id === id ? { ...e, ...(typeof patch === 'function' ? patch(e) : patch) } : e,
        ),
      );
    },
    [],
  );

  const onAnswerMessage = useCallback(
    (msg: AnswerServerMessage) => {
      if (msg.request_id && msg.request_id !== activeRequestRef.current) return;
      const id = streamingIdRef.current;
      if (!id) return;
      // Tokens for a hidden speculative answer accumulate on the pending
      // entry (no re-render) until the question is confirmed.
      const pending = pendingRef.current;
      const apply = (
        patch: Partial<AnswerEntry> | ((entry: AnswerEntry) => Partial<AnswerEntry>),
      ) => {
        if (pending && pending.streaming && pending.entry.id === id) {
          const delta = typeof patch === 'function' ? patch(pending.entry) : patch;
          pending.entry = { ...pending.entry, ...delta };
        } else {
          updateEntry(id, patch);
        }
      };
      if (msg.type === 'started') {
        // Reset the pending assistant turn — askAnswer/followUp already
        // appended an empty {role:'assistant', content:''} placeholder to
        // messages, so we just clear it here. error/marked reset belongs on
        // the entry (thread-level) not the turn.
        answerStartedAtRef.current = performance.now();
        answerEffectiveProviderRef.current = msg.provider;
        apply((e) => ({
          answer: '',
          error: null,
          marked: false,
          status: 'streaming',
          messages: e.messages.map((m, i) =>
            i === e.messages.length - 1 && m.role === 'assistant' ? { ...m, content: '' } : m,
          ),
        }));
        return;
      }
      if (msg.type === 'token') {
        apply((e) => {
          const last = e.messages[e.messages.length - 1];
          const updated =
            last && last.role === 'assistant'
              ? e.messages.map((m, i) =>
                  i === e.messages.length - 1 ? { ...m, content: m.content + msg.text } : m,
                )
              : [...e.messages, { role: 'assistant' as const, content: msg.text }];
          return { answer: e.answer + msg.text, messages: updated };
        });
        return;
      }
      if (msg.type === 'done') {
        // Record per-provider answer latency. Only fires on a real stream
        // completion so cancellations / errors don't pollute the map.
        const startedAt = answerStartedAtRef.current;
        const provider = answerEffectiveProviderRef.current;
        if (startedAt !== null && provider) {
          const elapsed = Math.max(0, performance.now() - startedAt);
          setAnswerLatencyMs(elapsed);
          setAnswerLatencyProvider(provider);
          setAnswerLatencyByProvider((prev) => ({ ...prev, [provider]: elapsed }));
        }
        answerStartedAtRef.current = null;
        apply({ status: 'done' });
        streamingIdRef.current = null;
        flushScreenFollowUps();
        return;
      }
      if (msg.type === 'cancelled') {
        answerStartedAtRef.current = null;
        apply({ status: 'cancelled' });
        streamingIdRef.current = null;
        flushScreenFollowUps();
        return;
      }
      if (msg.type === 'error') {
        answerStartedAtRef.current = null;
        apply({ status: 'error', error: msg.message });
        streamingIdRef.current = null;
        flushScreenFollowUps();
      }
      if (msg.type === 'limit_exceeded') {
        // Token budget spent: the backend refused the question outright.
        answerStartedAtRef.current = null;
        apply({ status: 'error', error: msg.message });
        streamingIdRef.current = null;
      }
      if (msg.type === 'provider_changed') {
        // Backend auto-fell-back to a different provider mid-call (primary
        // returned 503 or similar). Show a small ephemeral toast so the
        // user understands why the cost pill / badge shifted. The provider
        // selector in the panel does NOT change — the next call still
        // tries the user's choice first. We also re-anchor the latency
        // start time so the answerLatencyMs we record on `done` reflects
        // the time the EFFECTIVE provider took, not the failed primary +
        // the new one (which would punish the fallback unfairly).
        answerEffectiveProviderRef.current = msg.to;
        answerStartedAtRef.current = performance.now();
        showFallbackToast(`${msg.from} → ${msg.to} · fallback`);
      }
    },
    [updateEntry],
  );

  const showFallbackToast = (message: string) => {
    setDesktopToast(message);
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => {
      setDesktopToast(null);
      toastTimerRef.current = null;
    }, 2400);
  };

  // ─── transcribe WS message handling ────────────────────────────────────────
  const onTranscribeMessage = useCallback((msg: WsServerMessage) => {
    if (msg.type === 'ready') {
      setSessionIdState(msg.session_id);
      return;
    }
    if (msg.type === 'error') {
      setError(msg.message);
      setStatus('error');
      return;
    }
    if (msg.type === 'audio_usage') {
      setAudioUsage({ used: msg.used_minutes, limit: msg.limit_minutes });
      return;
    }
    if (msg.type === 'limit_exceeded') {
      // The backend drops audio from here on, so stop capturing instead of
      // showing "Listening…" over a dead stream.
      setAudioUsage({ used: msg.used_minutes, limit: msg.limit_minutes });
      void stopRef.current().then(() => {
        setError(
          `${msg.message} Start a new session from Setup, or raise SESSION_AUDIO_MINUTE_LIMIT.`,
        );
        setStatus('error');
      });
      return;
    }
    if (msg.type === 'transcript') {
      handleTranscript(msg);
      return;
    }
    if (msg.type === 'qd_state') {
      setQdState(msg.state);
      return;
    }
    if (msg.type === 'qd_fallback') {
      setQdFallbackModel(msg.model);
      setQdError(null);
      return;
    }
    if (msg.type === 'qd_error') {
      setQdError(msg.reason);
      return;
    }
    if (msg.type === 'qd_dedup') {
      setQdDedupAt(Date.now());
      return;
    }
    if (msg.type === 'question_candidate') {
      if (suppressAutoQuestion(msg.question)) return;
      startSpeculative(msg);
      return;
    }
    if (msg.type === 'question_retracted') {
      if (pendingRef.current?.candidateId === msg.candidate_id) discardPending();
      return;
    }
    if (msg.type === 'question_detected') {
      // A detection just succeeded, so an earlier failed call no longer applies.
      setQdError(null);
      // Confirms the speculative answer already streaming for this question:
      // reveal it (usually with tokens already in) instead of asking again.
      if (msg.candidate_id && revealPending(msg.candidate_id, msg.question)) {
        markAskedLine();
        setAssistView('answers');
        setActiveFeature('assist');
        return;
      }
      if (suppressAutoQuestion(msg.question)) return;
      markAskedLine();
      // Backend classifier already decided whether this is a follow-up of
      // the prior thread; route accordingly. Falling back to askAnswer
      // when the flag is missing keeps legacy events working.
      if (msg.is_follow_up && latestIndex(entriesRef.current, false) >= 0) {
        followUp(msg.question, { candidateId: msg.candidate_id });
      } else {
        askAnswer(msg.question, { autoDetected: true, candidateId: msg.candidate_id });
      }
      setAssistView('answers');
      setActiveFeature('assist');
    }
  }, []);

  // ─── coding mode ──────────────────────────────────────────────────────────
  const updateTab = (fingerprint: string, updater: (tab: CodingProblemTab) => CodingProblemTab) => {
    setCodingTabs((prev) => prev.map((t) => (t.fingerprint === fingerprint ? updater(t) : t)));
  };

  const onCodingSolutionMessage = useCallback((msg: CodingSolutionServerMessage) => {
    if (msg.type === 'screen_reference_saved') {
      setPassagesRefreshKey((k) => k + 1);
      return;
    }
    if (msg.type === 'screen_question_detected') {
      // During a combined session, the spoken question is the trigger and
      // the extracted screen text is supporting context for that answer.
      // Avoid racing it with answers generated from the screen alone —
      // unless the user explicitly scanned the page, which is a request.
      if (audioStatusRef.current === 'recording' && msg.source !== 'guided_scan') return;
      const lastEntry = entriesRef.current[entriesRef.current.length - 1];
      const recentQuestion = lastEntry
        ? [...lastEntry.messages].reverse().find((m) => m.role === 'user')?.content
        : undefined;
      const skip = new Set(answeredScreenRef.current);
      if (recentQuestion) skip.add(normalizeQuestion(recentQuestion));
      // One answer page per guided scan: answers found mid-scan start it,
      // questions found later in the same scan are added to it.
      const scanEntry =
        msg.scan_id && scanAnswerRef.current?.scanId === msg.scan_id
          ? entriesRef.current.find((e) => e.id === scanAnswerRef.current?.entryId)
          : undefined;
      const plan = planScreenAnswer({
        questions: msg.questions?.length ? msg.questions : [msg.question],
        completeness: msg.completeness,
        speculative: Boolean(msg.speculative),
        answered: skip,
        hasScanEntry: Boolean(scanEntry),
      });
      if (plan.text) {
        for (const question of plan.questions) {
          answeredScreenRef.current.add(normalizeQuestion(question));
        }
        if (plan.mode === 'followup' && scanEntry) {
          sendScreenFollowUp(scanEntry.id, plan.text);
        } else {
          const entryId = askAnswerRef.current(plan.text, {
            autoDetected: true,
            fromScreen: true,
          });
          if (msg.scan_id && entryId) {
            scanAnswerRef.current = { scanId: msg.scan_id, entryId };
          }
        }
        setAssistView('screen');
        setActiveFeature('assist');
      }
      if (plan.review && msg.completeness !== 'complete') {
        setPendingScreenQuestion({
          question: plan.review,
          completeness: msg.completeness,
          missingSections: msg.missing_sections ?? [],
        });
        if (!plan.text) setAssistView('screen');
        setActiveFeature('assist');
      }
      return;
    }
    // Problem-detected events are pushed from /api/vision/extract via
    // session_bus and arrive on this socket (it's always open while /session
    // is mounted, unlike /ws/transcribe which requires Start).
    if (msg.type === 'coding_problem_detected') {
      onCodingProblemDetected(msg.problem, msg.fingerprint);
      return;
    }
    // `saved` only fires for solve mode (other modes are ephemeral on the
    // backend). Route to tabs.
    if (msg.type === 'saved') {
      updateTab(msg.fingerprint, (t) => ({ ...t, savedId: msg.id }));
      return;
    }
    // Self-verification outcome — carries its own fingerprint so it routes
    // independent of the active tab (the user may have switched away while
    // the backend was running the sandbox).
    if (msg.type === 'test_results') {
      updateTab(msg.fingerprint, (t) => ({
        ...t,
        tests: {
          ran: msg.ran,
          cases: msg.cases,
          skipReason: msg.skip_reason ?? null,
        },
      }));
      // Auto-escalate: the fast solve failed its own examples, so hand the
      // problem to the Claude agent (writes + runs + fixes code until the
      // examples pass). Capped at ONCE per fingerprint for the session:
      // `tab.agent` alone is not a durable guard (a later refine solve resets
      // it for a clean slate), and an OCR-corrupted example can NEVER pass —
      // without the cap, each refine re-launched the agent in a quota-burning
      // loop. After the one auto-run, further escalation is the user's call
      // (the Agent button still works any time).
      const failed = msg.ran && msg.cases.length > 0 && msg.cases.some((c) => !c.ok);
      const tab = codingTabsRef.current.find((t) => t.fingerprint === msg.fingerprint);
      if (
        failed &&
        tab &&
        !tab.agent &&
        !codingAgentStreamingRef.current &&
        !autoEscalatedRef.current.has(msg.fingerprint)
      ) {
        autoEscalatedRef.current.add(msg.fingerprint);
        setActiveFingerprint(msg.fingerprint);
        showFallbackToast('Examples failed · escalating to Claude agent');
        requestAgentSolve(msg.fingerprint);
      }
      return;
    }
    if (msg.type === 'provider_changed') {
      // Mirror of the answer-side toast — surfaces a coding-WS fallback
      // (e.g. Gemini overloaded, switched to OpenAI mid-solve).
      showFallbackToast(`${msg.from} → ${msg.to} · fallback`);
      return;
    }

    // ─── Agent mode ───────────────────────────────────────────────────────
    // The agent runs the tool loop on the active tab. `started` with
    // mode 'agent' opens the trace; agent_* events append to it; the final
    // answer arrives whole in agent_solution (no `token` events). done /
    // cancelled / error close out the trace AND the tab status.
    if (msg.type === 'started' && msg.mode === 'agent') {
      codingAgentStreamingRef.current = true;
      agentRunStartRef.current = Date.now();
      const fp = activeFingerprintRef.current;
      if (fp) {
        updateTab(fp, (t) => ({
          ...t,
          status: 'streaming',
          error: null,
          // Keep the fast solution + its ✗ verdict visible while the agent
          // works below — the agent's verified answer replaces `solution`
          // when it finishes (agent_solution). Don't blank the panel.
          agent: { status: 'streaming', steps: [], startedAt: Date.now() },
        }));
      }
      return;
    }
    if (
      msg.type === 'agent_step' ||
      msg.type === 'agent_tool' ||
      msg.type === 'agent_tool_result' ||
      msg.type === 'agent_solution'
    ) {
      const fp = activeFingerprintRef.current;
      if (!fp) return;
      if (msg.type === 'agent_solution') {
        updateTab(fp, (t) => ({ ...t, solution: msg.text }));
        return;
      }
      const step: AgentStep =
        msg.type === 'agent_step'
          ? { kind: 'text', text: msg.text }
          : msg.type === 'agent_tool'
            ? { kind: 'tool', tool: msg.tool, summary: msg.summary }
            : { kind: 'result', ok: msg.ok, summary: msg.summary };
      updateTab(fp, (t) => ({
        ...t,
        agent: {
          status: t.agent?.status ?? 'streaming',
          steps: [...(t.agent?.steps ?? []), step],
          startedAt: t.agent?.startedAt ?? Date.now(),
        },
      }));
      return;
    }
    if (codingAgentStreamingRef.current) {
      const fp = activeFingerprintRef.current;
      const finalize = (status: CodingProblemTab['status']) => {
        codingAgentStreamingRef.current = false;
        // Every termination consumed subscription time — count it.
        const startedAt = agentRunStartRef.current;
        if (startedAt > 0) {
          const elapsed = Date.now() - startedAt;
          setAgentStats((prev) => ({ runs: prev.runs + 1, totalMs: prev.totalMs + elapsed }));
          agentRunStartRef.current = 0;
        }
        if (!fp) return;
        updateTab(fp, (t) => ({
          ...t,
          status,
          agent: t.agent ? { ...t.agent, status } : t.agent,
          ...(msg.type === 'error' ? { error: msg.message } : {}),
        }));
      };
      if (msg.type === 'done') return finalize('done');
      if (msg.type === 'cancelled') return finalize('cancelled');
      if (msg.type === 'error') return finalize('error');
      // saved / test_results fall through to the shared handlers above (they
      // route by their own fingerprint), so nothing else to do here.
    }

    // Stream routing: when a non-solve mode is in flight, the entire stream
    // belongs to that mode's scratch slice until done/cancelled/error.
    // Solve mode continues to route by active fingerprint.
    const streamingMode = codingScratchStreamingModeRef.current;
    if (streamingMode) {
      const patchScratch = (patch: Partial<CodingScratchState>) =>
        setCodingScratchByMode((prev) => ({
          ...prev,
          [streamingMode]: { ...prev[streamingMode], ...patch },
        }));
      if (msg.type === 'started') {
        patchScratch({ output: '', status: 'streaming', errorMessage: null });
        return;
      }
      if (msg.type === 'token') {
        setCodingScratchByMode((prev) => ({
          ...prev,
          [streamingMode]: {
            ...prev[streamingMode],
            output: prev[streamingMode].output + msg.text,
          },
        }));
        return;
      }
      if (msg.type === 'done') {
        patchScratch({ status: 'done' });
        codingScratchStreamingModeRef.current = null;
        return;
      }
      if (msg.type === 'cancelled') {
        patchScratch({ status: 'cancelled' });
        codingScratchStreamingModeRef.current = null;
        return;
      }
      if (msg.type === 'error') {
        patchScratch({ status: 'error', errorMessage: msg.message });
        codingScratchStreamingModeRef.current = null;
        return;
      }
      return;
    }

    const fp = activeFingerprintRef.current;
    if (!fp) return;
    if (msg.type === 'started') {
      updateTab(fp, (t) => ({
        ...t,
        solution: '',
        status: 'streaming',
        error: null,
        savedId: null,
        // A fresh stream invalidates any prior verification result.
        tests: null,
        // ...and any prior agent trace — this is a fresh one-shot solve.
        agent: null,
      }));
      return;
    }
    if (msg.type === 'token') {
      updateTab(fp, (t) => ({ ...t, solution: t.solution + msg.text }));
      return;
    }
    if (msg.type === 'done') {
      updateTab(fp, (t) => ({ ...t, status: 'done' }));
      return;
    }
    if (msg.type === 'cancelled') {
      updateTab(fp, (t) => ({ ...t, status: 'cancelled' }));
      return;
    }
    if (msg.type === 'error') {
      updateTab(fp, (t) => ({ ...t, status: 'error', error: msg.message }));
    }
  }, []);

  const requestSolve = (
    fingerprint: string,
    problem: ExtractedProblem,
    lang: CodingLanguage,
    opts: { feedback?: string; priorSolution?: string } = {},
  ) => {
    const ws = codingWsRef.current;
    if (!ws || !ws.isOpen()) {
      setCodingError('coding WS not connected');
      return;
    }
    ws.send({
      type: 'solve',
      problem,
      language: lang,
      provider: providerRef.current,
      // When the user fires "Refine with feedback" we forward the prior
      // attempt + their note so the backend flips into refine framing.
      // Empty strings are normalized to undefined so they don't trigger
      // the refine path on a stray click.
      feedback: opts.feedback?.trim() || undefined,
      prior_solution: opts.priorSolution?.trim() || undefined,
    });
    updateTab(fingerprint, (t) => ({
      ...t,
      language: lang,
      solution: '',
      status: 'streaming',
      error: null,
    }));
  };

  const onCodingRefine = (feedback: string) => {
    const fp = activeFingerprintRef.current;
    if (!fp) return;
    const tab = codingTabsRef.current.find((t) => t.fingerprint === fp);
    if (!tab) return;
    // Refines go to the CLAUDE AGENT, not another one-shot fast solve: a
    // refine means the fast answer already failed (locally or on the real
    // judge), and re-rolling the same model mostly re-rolls the same bug.
    // The agent gets the failed code + the user's feedback and diagnoses it
    // with its write→run→fix loop.
    showFallbackToast('Refining with Claude agent…');
    requestAgentSolve(fp, {
      feedback,
      // Send ONLY the code block, not the full Markdown response. With the
      // full response the model treats the previous attempt as "extend this
      // finished answer" and cosmetically refines instead of diagnosing.
      // Code-only framing makes "this is the buggy code you need to fix"
      // unambiguous.
      priorSolution: extractFirstCodeBlock(tab.solution),
    });
  };

  // Escalate the active problem to the Claude Code agent. Same {type:'solve'}
  // frame the backend already handles, tagged mode:'agent' so ws_coding routes
  // it to the CLI tool loop. The trace + verified answer stream back onto this
  // tab (see the agent-mode block in onCodingSolutionMessage).
  const requestAgentSolve = (
    fingerprint?: string,
    opts: { feedback?: string; priorSolution?: string } = {},
  ) => {
    const fp = fingerprint ?? activeFingerprintRef.current;
    if (!fp) return;
    const tab = codingTabsRef.current.find((t) => t.fingerprint === fp);
    if (!tab) return;
    const ws = codingWsRef.current;
    if (!ws || !ws.isOpen()) {
      setCodingError('coding WS not connected');
      return;
    }
    codingAgentStreamingRef.current = true;
    ws.send({
      type: 'solve',
      mode: 'agent',
      problem: tab.problem,
      language: codingLanguageRef.current,
      provider: providerRef.current,
      // Refine inputs — when present the agent starts from the failed
      // attempt + feedback (diagnose) instead of solving from scratch.
      feedback: opts.feedback?.trim() || undefined,
      prior_solution: opts.priorSolution?.trim() || undefined,
    });
    updateTab(fp, (t) => ({
      ...t,
      status: 'streaming',
      error: null,
      // Keep any existing fast solution + verdict on screen while the agent
      // runs; it's replaced only when the agent returns its verified answer.
      agent: { status: 'streaming', steps: [], startedAt: Date.now() },
    }));
  };

  const onCodingProblemDetected = (problem: ExtractedProblem, fingerprint: string) => {
    setCodingError(null);
    const lang = codingLanguageRef.current;
    const existing = codingTabsRef.current.find((t) => t.fingerprint === fingerprint);
    // A solve/agent is currently streaming somewhere. Weaker vision models
    // re-extract the SAME on-screen problem with slightly different text →
    // different fingerprints → a fresh tab whose auto-solve would cancel the
    // one already running (ws_coding is single-in-flight), so nothing ever
    // finishes. Never auto-solve — nor steal focus — while a solve is live.
    const anyStreaming = codingTabsRef.current.some((t) => t.status === 'streaming');
    // Auto-solve only when nothing is streaming AND this problem isn't already
    // solved (or solving). A re-emit of an existing tab just refreshes text.
    const shouldAutoSolve =
      !anyStreaming && (!existing || (existing.status !== 'streaming' && !existing.solution));

    setCodingTabs((prev) => {
      const ex = prev.find((t) => t.fingerprint === fingerprint);
      if (ex) {
        return prev.map((t) =>
          t.fingerprint === fingerprint
            ? {
                ...t,
                problem,
                // Reset for a fresh stream only when we're actually re-solving.
                ...(shouldAutoSolve
                  ? { solution: '', status: 'streaming' as const, error: null, tests: null }
                  : {}),
              }
            : t,
        );
      }
      const tab: CodingProblemTab = {
        fingerprint,
        problem,
        language: lang,
        solution: '',
        // Idle (not "streaming") when we're not kicking off a solve — otherwise
        // the tab shows "Generating…" forever with no request behind it.
        status: shouldAutoSolve ? 'streaming' : 'idle',
        error: null,
        savedId: null,
        tests: null,
        agent: null,
      };
      const next = [...prev, tab];
      return next.length > MAX_CODING_TABS ? next.slice(-MAX_CODING_TABS) : next;
    });
    if (audioStatusRef.current !== 'recording') setAssistView('screen');
    setActiveFeature('assist');
    // Keep focus on the in-flight solve; only jump to the new problem when we
    // actually start solving it (or it already exists as the active target).
    if (shouldAutoSolve || existing) {
      setActiveFingerprint(fingerprint);
    }
    if (shouldAutoSolve) {
      const ws = codingWsRef.current;
      if (ws && ws.isOpen()) {
        ws.send({ type: 'solve', problem, language: lang, provider: providerRef.current });
      }
    }
  };

  const handleTranscript = (event: TranscriptEvent) => {
    if (lastSendAtRef.current > 0) {
      setLatencyMs(Math.max(0, performance.now() - lastSendAtRef.current));
    }
    const source = event.source ?? null;
    const slot: TranscriptSource = source ?? 'interviewer';
    if (event.is_final) {
      const asked = source !== 'candidate' && markNextInterviewerFinalRef.current;
      if (asked) markNextInterviewerFinalRef.current = false;
      setFinals((prev) => [...prev, { text: event.text, source, asked }]);
      setInterims((prev) => ({ ...prev, [slot]: '' }));
    } else {
      setInterims((prev) => (prev[slot] === event.text ? prev : { ...prev, [slot]: event.text }));
    }
  };

  /** Highlight the interviewer line a detected question came from: the
   *  latest final one, or — if the interviewer is still mid-line — the
   *  line once it finalizes. */
  const markAskedLine = () => {
    if (interimsRef.current.interviewer) {
      markNextInterviewerFinalRef.current = true;
      return;
    }
    setFinals((prev) => {
      for (let i = prev.length - 1; i >= 0; i--) {
        const line = prev[i];
        if (!line || line.source === 'candidate') continue;
        if (line.asked) return prev;
        const next = [...prev];
        next[i] = { ...line, asked: true };
        return next;
      }
      return prev;
    });
  };

  /** True when an auto-detected question should be ignored. */
  const suppressAutoQuestion = (question: string): boolean => {
    // Force-ask cooldown: if the user just fired a manual ask, swallow
    // auto-detected questions for a short window. The user already
    // started a thread on substantially the same transcript content.
    const sinceForce = Date.now() - lastForceAskAtRef.current;
    if (sinceForce < FORCE_ASK_AUTODETECT_COOLDOWN_MS) return true;
    // Skip a question that matches the latest entry's most recent user
    // turn (a shallow normalized compare) so we don't create duplicates.
    const norm = question.trim().toLowerCase();
    const last = entriesRef.current[entriesRef.current.length - 1];
    if (last) {
      const recentUser = [...last.messages].reverse().find((m) => m.role === 'user')?.content;
      if (recentUser && recentUser.trim().toLowerCase() === norm) return true;
    }
    return false;
  };

  // ─── speculative answers (Flux EagerEndOfTurn) ─────────────────────────────
  const discardPending = () => {
    const pending = pendingRef.current;
    if (!pending) return;
    pendingRef.current = null;
    if (pending.streaming && streamingIdRef.current === pending.entry.id) {
      answerRef.current?.cancel?.();
      streamingIdRef.current = null;
    }
  };

  const startSpeculative = (msg: QuestionCandidateEvent) => {
    const ws = answerRef.current;
    if (!ws || !ws.isOpen()) return;
    // Same candidate again = the classifier's cleaned-up wording for the
    // answer already streaming. Relabel only; don't restart it.
    const existing = pendingRef.current;
    if (existing && existing.candidateId === msg.candidate_id) {
      const relabel = (m: AnswerMessage, i: number, all: AnswerMessage[]) =>
        i === all.length - 2 && m.role === 'user' ? { ...m, content: msg.question } : m;
      existing.entry = {
        ...existing.entry,
        question: existing.targetId ? existing.entry.question : msg.question,
        messages: existing.entry.messages.map(relabel),
      };
      return;
    }
    // Never cancel an answer the user is reading for a maybe-question —
    // that one waits for confirmation instead.
    if (streamingIdRef.current && !pendingRef.current) return;
    discardPending();
    const current = entriesRef.current[spokenIndexNow()];
    let entry: AnswerEntry;
    let wire: AnswerMessage[];
    let targetId: string | null = null;
    if (msg.is_follow_up && current) {
      const prior = current.messages.filter(
        (m, i) =>
          !(i === current.messages.length - 1 && m.role === 'assistant' && m.content === ''),
      );
      const messages: AnswerMessage[] = [
        ...prior,
        { role: 'user', content: msg.question },
        { role: 'assistant', content: '' },
      ];
      entry = { ...current, messages, answer: '', status: 'streaming', error: null };
      wire = messages.slice(0, -1);
      targetId = current.id;
    } else {
      entry = {
        id: newId(),
        messages: [
          { role: 'user', content: msg.question },
          { role: 'assistant', content: '' },
        ],
        threadId: newId(),
        question: msg.question,
        answer: '',
        status: 'streaming',
        error: null,
        marked: false,
        createdAt: Date.now(),
      };
      wire = [{ role: 'user', content: msg.question }];
    }
    pendingRef.current = { candidateId: msg.candidate_id, entry, targetId, streaming: true };
    streamingIdRef.current = entry.id;
    ws.send({
      type: 'question',
      request_id: beginRequest(),
      messages: wire,
      thread_id: entry.threadId,
      provider: providerRef.current,
      auto_detected: true,
      candidate_id: msg.candidate_id,
      session_context: answerScreenContext(),
      speculative: true,
    });
  };

  /** Promote the hidden answer for `candidateId` into the panel. Returns
   *  false when there's no matching pending answer. */
  const revealPending = (candidateId: string, question: string): boolean => {
    const pending = pendingRef.current;
    if (!pending || pending.candidateId !== candidateId) return false;
    pendingRef.current = null;
    pending.streaming = false;
    answerRef.current?.send({ type: 'commit', candidate_id: candidateId, question });
    // Show the confirmed wording (the answer may have started from raw text).
    const relabel = (m: AnswerMessage, i: number, all: AnswerMessage[]) =>
      i === all.length - 2 && m.role === 'user' ? { ...m, content: question } : m;
    const entry: AnswerEntry = {
      ...pending.entry,
      question: pending.targetId ? pending.entry.question : question,
      messages: pending.entry.messages.map(relabel),
    };
    setPanelError(null);
    if (pending.targetId) {
      const targetId = pending.targetId;
      setEntries((prev) => prev.map((e) => (e.id === targetId ? entry : e)));
    } else {
      setEntries((prev) => {
        const next = [...prev, entry];
        // Same auto-jump rule as an auto-detected askAnswer.
        if (isAtLatest(prev, entryIndexRef.current, false)) {
          setEntryIndex(next.length - 1);
        }
        return next;
      });
    }
    return true;
  };

  /** New answer request: becomes the only stream whose events we accept. */
  const beginRequest = (): string => {
    const rid = newId();
    activeRequestRef.current = rid;
    return rid;
  };

  const cancelInFlight = () => {
    if (pendingRef.current) {
      discardPending();
      return;
    }
    const ws = answerRef.current;
    if (!streamingIdRef.current || !ws) return;
    const oldId = streamingIdRef.current;
    ws.cancel?.();
    updateEntry(oldId, { status: 'cancelled' });
    streamingIdRef.current = null;
  };

  const newId = () =>
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `q_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const askAnswer = (
    q: string,
    opts: { autoDetected?: boolean; candidateId?: string; fromScreen?: boolean } = {},
  ) => {
    const ws = answerRef.current;
    if (!ws || !ws.isOpen()) {
      setPanelError('copilot WS not connected');
      return undefined;
    }
    // Cancel any in-flight stream before starting a new thread — tokens
    // route by streamingIdRef so otherwise the old entry would hang in
    // status='streaming' forever.
    cancelInFlight();
    const id = newId();
    const threadId = newId();
    if (opts.fromScreen) screenThreadIdsRef.current.add(threadId);
    const messages: AnswerMessage[] = [
      { role: 'user', content: q },
      { role: 'assistant', content: '' },
    ];
    const entry: AnswerEntry = {
      id,
      messages,
      threadId,
      question: q,
      answer: '',
      status: 'streaming',
      error: null,
      marked: false,
      createdAt: Date.now(),
      fromScreen: Boolean(opts.fromScreen),
    };
    setPanelError(null);
    // Screen answers page through the Screen tab's own list.
    const indexRef = opts.fromScreen ? screenEntryIndexRef : entryIndexRef;
    const setIndex = opts.fromScreen ? setScreenEntryIndex : setEntryIndex;
    setEntries((prev) => {
      const next = [...prev, entry];
      // Auto-jump rules:
      //   * Manual ask (force-ask / custom prompt) → always jump. User
      //     explicitly fired this and expects to see it.
      //   * Auto-detected → jump only when the user has no entry selected
      //     (idx < 0) or is parked at the latest entry. Anywhere else
      //     means the user is reading something older; don't yank them
      //     away mid-read.
      if (!opts.autoDetected || isAtLatest(prev, indexRef.current, Boolean(opts.fromScreen))) {
        setIndex(next.length - 1);
      }
      return next;
    });
    streamingIdRef.current = id;
    ws.send({
      type: 'question',
      request_id: beginRequest(),
      messages: [{ role: 'user', content: q }],
      thread_id: threadId,
      provider: providerRef.current,
      auto_detected: opts.autoDetected,
      candidate_id: opts.candidateId,
      session_context: answerScreenContext(),
      claude_model: screenClaudeModelFor(threadId),
      from_screen: screenThreadIdsRef.current.has(threadId),
    });
    return id;
  };
  askAnswerRef.current = askAnswer;

  const startGuidedScan = async (displayId?: string) => {
    const api = window.friday?.coding;
    if (!api) return;
    setCodingError(null);
    const result = await api.startGuidedScan(displayId || undefined);
    if (!result.ok) setCodingError(result.error || 'Could not start guided scan.');
  };

  const finishGuidedScan = () => {
    void window.friday?.coding.finishGuidedScan();
  };
  const cancelGuidedScan = () => {
    void window.friday?.coding.cancelGuidedScan();
  };
  const answerCapturedScreenQuestion = () => {
    if (!pendingScreenQuestion) return;
    askAnswerRef.current(pendingScreenQuestion.question, { fromScreen: true });
    setPendingScreenQuestion(null);
    setAssistView('screen');
    setActiveFeature('assist');
  };

  const followUp = (q: string, opts: { candidateId?: string; entryId?: string } = {}) => {
    const ws = answerRef.current;
    if (!ws || !ws.isOpen()) {
      setPanelError('copilot WS not connected');
      return;
    }
    // Read entryIndex from ref so this function (captured by stable
    // callbacks like onTranscribeMessage) targets the entry the user
    // is currently viewing, not the one they were viewing at first
    // render. Falls back to AI Help's newest entry when nothing is selected.
    // Screen follow-ups (scan pages, the Screen tab) name their entry.
    const current = opts.entryId
      ? entriesRef.current.find((e) => e.id === opts.entryId)
      : entriesRef.current[spokenIndexNow()];
    if (!current) {
      // No active thread — treat as a fresh ask. Matches what a user
      // probably means when they hit "More detail" on an empty panel.
      askAnswer(q);
      return;
    }
    // Stream might still be in flight for THIS entry; cancel it so the
    // new follow-up replaces the trailing assistant turn cleanly.
    cancelInFlight();
    const prior = current.messages.filter(
      (m, i) =>
        // Drop the trailing placeholder/in-progress assistant turn if it's
        // empty (i.e. user fired a follow-up before the previous answer
        // settled). The completed assistant turns are kept.
        !(i === current.messages.length - 1 && m.role === 'assistant' && m.content === ''),
    );
    const nextMessages: AnswerMessage[] = [
      ...prior,
      { role: 'user', content: q },
      { role: 'assistant', content: '' },
    ];
    setPanelError(null);
    updateEntry(current.id, {
      messages: nextMessages,
      answer: '',
      status: 'streaming',
      error: null,
    });
    streamingIdRef.current = current.id;
    ws.send({
      type: 'question',
      request_id: beginRequest(),
      // Send the full thread minus the trailing empty assistant placeholder
      // so the backend sees user/assistant/user… with the new turn last.
      messages: nextMessages.slice(0, -1),
      thread_id: current.threadId,
      provider: providerRef.current,
      candidate_id: opts.candidateId,
      session_context: answerScreenContext(),
      claude_model: screenClaudeModelFor(current.threadId),
      from_screen: screenThreadIdsRef.current.has(current.threadId),
    });
  };
  followUpRef.current = followUp;

  // ─── transcribe lifecycle ──────────────────────────────────────────────────
  const start = async (): Promise<boolean> => {
    setError(null);
    setStatus('starting');
    setLatencyMs(null);

    audioFormatRef.current = inElectron ? 'tagged' : undefined;
    const ws = new TranscribeWs(
      {
        onMessage: onTranscribeMessage,
        onOpen: () => {
          // ORDER MATTERS: set_qd_model BEFORE start. The backend's `start`
          // unblocks the Deepgram audio path; the first transcript final
          // can arrive within ~100ms of start. Sending the model first
          // guarantees detection on that very first final uses the user's
          // pick, not the server-side default.
          ws.sendControl({ type: 'set_qd_model', model: qdModelRef.current });
          ws.sendControl({ type: 'start', audio_format: audioFormatRef.current });
          // QD signals are per-detector (per-WS) on the backend. A fresh
          // socket = fresh detector, so clear any stale UI state from the
          // previous session.
          setQdFallbackModel(null);
          setQdState('idle');
          setQdError(null);
          setQdDedupAt(0);
          // The force-ask cooldown was set in the prior session and would
          // otherwise carry over and suppress legitimate auto-detects in
          // the new session for a few seconds.
          lastForceAskAtRef.current = 0;
        },
        onClose: () => setStatus((prev) => (prev === 'error' ? prev : 'idle')),
        onError: () => {
          setError('WebSocket error');
          setStatus('error');
        },
      },
      getOrCreateSessionId(),
    );
    ws.connect();
    transcribeRef.current = ws;

    if (!inElectron || !window.friday) {
      setError('Audio capture is only available inside the Friday desktop window.');
      setStatus('error');
      return false;
    }
    const result = await window.friday.audio.start({ mic: CAPTURE_MIC });
    if (!result.ok) {
      setError(result.error ?? 'audio start failed');
      setStatus('error');
      return false;
    }

    const offFrame = window.friday.audio.onFrame((chunk, source) => {
      if (source !== 'mic') lastSendAtRef.current = performance.now();
      transcribeRef.current?.sendTaggedAudio(chunk, source ?? 'system');
    });
    const offError = window.friday.audio.onError((msg) => {
      setError(msg);
      setStatus('error');
    });
    const offExit = window.friday.audio.onExit(() => {
      setStatus((prev) => (prev === 'recording' ? 'idle' : prev));
    });
    audioUnsubsRef.current = [offFrame, offError, offExit];
    setStatus('recording');
    // Open the unified workspace as soon as audio starts so the user can
    // see transcript + answers without an extra click.
    setAssistView('answers');
    setActiveFeature('assist');
    return true;
  };

  const teardownAudioListeners = () => {
    for (const off of audioUnsubsRef.current) off();
    audioUnsubsRef.current = [];
  };

  const closeAssistIfIdle = () => {
    setActiveFeature((prev) =>
      prev === 'assist' && assistView === 'answers' && !codingActive ? null : prev,
    );
  };

  const stop = async () => {
    teardownAudioListeners();
    if (inElectron && window.friday) {
      await window.friday.audio.stop();
    }
    transcribeRef.current?.close();
    transcribeRef.current = null;
    setStatus('idle');
    closeAssistIfIdle();
  };
  stopRef.current = stop;

  const pause = async () => {
    const actions: Promise<unknown>[] = [];
    if (inElectron && window.friday) actions.push(window.friday.audio.pause());
    if (codingActive && !codingPaused) actions.push(pauseScreenCapture());
    await Promise.all(actions);
    transcribeRef.current?.sendControl({ type: 'pause' });
    setStatus('paused');
    closeAssistIfIdle();
  };

  const resume = async () => {
    const actions: Promise<unknown>[] = [];
    if (inElectron && window.friday) actions.push(window.friday.audio.resume());
    if (codingActive && codingPaused) actions.push(resumeScreenCapture());
    await Promise.all(actions);
    transcribeRef.current?.sendControl({ type: 'start', audio_format: audioFormatRef.current });
    setStatus('recording');
  };

  const clearTranscript = () => {
    setFinals([]);
    setInterims(EMPTY_INTERIMS);
    setLatencyMs(null);
  };

  // Removes the entry a view is showing from the in-memory list. If it's
  // the streaming one, also tells the WS to cancel so the server stops
  // generating tokens we'd just throw away. Both views keep their place.
  const clearAnswer = (fromScreen: boolean) => {
    const removedIndex = resolveIndex(
      entries,
      fromScreen ? screenEntryIndex : entryIndex,
      fromScreen,
    );
    if (removedIndex < 0) return;
    const removed = entries[removedIndex];
    if (!removed) return;
    if (streamingIdRef.current === removed.id) {
      answerRef.current?.cancel();
      streamingIdRef.current = null;
    }
    setEntries((prev) => {
      const at = prev.findIndex((e) => e.id === removed.id);
      if (at < 0) return prev;
      setEntryIndex(indexAfterRemoval(prev, entryIndexRef.current, at, false));
      setScreenEntryIndex(indexAfterRemoval(prev, screenEntryIndexRef.current, at, true));
      return prev.filter((_, i) => i !== at);
    });
  };

  const cancelAnswer = () => {
    answerRef.current?.cancel();
  };

  const onMarkAnswered = (entry: AnswerEntry | null) => {
    if (!entry) return;
    updateEntry(entry.id, { marked: !entry.marked });
  };

  const onReask = (entry: AnswerEntry | null) => {
    if (!entry?.question) return;
    askAnswer(entry.question, { fromScreen: entry.fromScreen });
  };

  const goPrev = (fromScreen: boolean) => {
    const setIndex = fromScreen ? setScreenEntryIndex : setEntryIndex;
    setIndex((i) => stepIndex(entriesRef.current, i, -1, fromScreen));
  };

  const goNext = (fromScreen: boolean) => {
    const setIndex = fromScreen ? setScreenEntryIndex : setEntryIndex;
    setIndex((i) => stepIndex(entriesRef.current, i, 1, fromScreen));
  };

  const onCodingClaudeModelChange = (model: ClaudeModel) => {
    codingClaudeModelRef.current = model;
    setCodingClaudeModel(model);
    setCodingClaudeModelPreference(model);
    codingWsRef.current?.setClaudeModel(model);
    void window.friday?.coding?.setClaudeModel?.(model);
  };

  const onProviderChange = (p: AnswerProvider) => {
    setProvider(p);
    setProviderPreference(p);
    // Mirror the choice into the desktop capture so the next vision/extract
    // request uses the user-selected model. Best-effort — outside Electron
    // the API isn't there.
    void window.friday?.coding?.setProvider?.(p);
    // Persist to the server's session row so /api/vision/extract resolves
    // the right provider even when the desktop fires a capture before the
    // setProvider IPC has reached it.
    if (sessionId) void patchSessionProvider(sessionId, p);
  };

  const onQdModelChange = (m: QdModel) => {
    const samePick = m === qdModelRef.current;
    if (!samePick) {
      setQdModelState(m);
      setQdModelPreference(m);
    }
    // Always clear fallback/error badges — re-picking the current model
    // is an explicit "retry this model" gesture (the dropdown's only
    // way to ask the backend to lift fallback or unstick the error
    // state). The backend's set_model also resets _fallback_active.
    setQdFallbackModel(null);
    setQdError(null);
    // Push to the live transcribe WS so the next detection run uses the
    // new model. Send even on samePick so the backend's set_model runs
    // and clears its own sticky state. No-op when the socket isn't open
    // yet — set_qd_model is also sent on connect from the preference.
    transcribeRef.current?.sendControl({ type: 'set_qd_model', model: m });
  };

  const submitCustom = (q: string) => askAnswer(q);

  // ─── hotkeys: ⌘⇧␣ (force-ask), ⌘⇧C (coding), ⌘⇧. (panic blur) ─────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!e.metaKey || !e.shiftKey) return;
      if (e.code === 'Space' || e.key === ' ') {
        e.preventDefault();
        const recent = finalsRef.current
          .filter((line) => line.source !== 'candidate')
          .slice(-RECENT_FINALS_JOIN)
          .map((line) => line.text)
          .join(' ')
          .trim();
        if (recent) {
          lastForceAskAtRef.current = Date.now();
          askAnswer(recent);
          setAssistView('answers');
          setActiveFeature('assist');
        } else {
          setPanelError('no transcript yet');
        }
        return;
      }
      if (e.code === 'KeyC' || e.key?.toLowerCase() === 'c') {
        e.preventDefault();
        toggleCodingMode();
        return;
      }
      // Panic blur — when someone walks behind the screen, hit ⌘⇧. to
      // (a) flip privacyMode on so all rendered text + answers blur, and
      // (b) close every popover / modal so the bar collapses to a small
      // floating pill with no leaky indicators visible. Press again to
      // release.
      if (e.code === 'Period' || e.key === '.') {
        e.preventDefault();
        setPrivacyMode((v) => {
          const next = !v;
          if (next) {
            // Close anything that could reveal session context.
            setActiveFeature(null);
            setOverflowOpen(false);
            setShieldOpen(false);
            setShortcutsOpen(false);
            setStealthDisableConfirmOpen(false);
          }
          return next;
        });
        return;
      }
    };
    const slashHandler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === '/') {
        e.preventDefault();
        setShortcutsOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', handler);
    window.addEventListener('keydown', slashHandler);
    return () => {
      window.removeEventListener('keydown', handler);
      window.removeEventListener('keydown', slashHandler);
    };
  }, []);

  const toggleCodingMode = async (): Promise<boolean> => {
    const fridayApi = window.friday;
    if (!fridayApi?.coding) {
      setCodingError('Coding mode only works inside the Friday desktop window.');
      return false;
    }
    if (codingActive) {
      await fridayApi.coding.stop();
      screenCaptureActiveRef.current = false;
      for (const off of codingUnsubsRef.current) off();
      codingUnsubsRef.current = [];
      setCodingActive(false);
      setCodingPaused(false);
      setCodingFrame(null);
      screenContextRef.current = null;
      return true;
    }
    if (codingStartingRef.current) return false;
    screenContextRef.current = null;
    const sid = getOrCreateSessionId();
    // A new watch usually means a new assessment — don't answer it against
    // passages remembered from the last one.
    resetScreenContext(sid);
    codingStartingRef.current = true;
    setCodingStarting(true);
    try {
      const result = await fridayApi.coding.start(sid);
      if (!result.ok) {
        setCodingError(result.error ?? 'failed to start coding capture');
        return false;
      }
      screenCaptureActiveRef.current = true;
      setCodingPaused(false);
      // Push the renderer's currently-selected provider into the desktop
      // capture so the very first vision/extract uses the user's pick.
      void fridayApi.coding.setProvider?.(providerRef.current);
      void fridayApi.coding.setClaudeModel?.(codingClaudeModelRef.current);
      setCodingError(null);
      const offFrame = fridayApi.coding.onFrameProcessed((info) => {
        setCodingFrame({ changed_bits: info.changed_bits, interval_ms: info.interval_ms });
      });
      const offExt = fridayApi.coding.onExtractionResult((payload) => {
        const problem = payload.problem;
        if (!problem) {
          screenContextRef.current = null;
          return;
        }
        const parts = [
          problem.question,
          problem.visible_context,
          problem.title,
          problem.problem_statement,
          problem.function_signature,
          problem.screen_code,
          ...(problem.constraints ?? []).map((item) => `Constraint: ${item}`),
          ...(problem.examples ?? []).map(
            (example) => `Example: ${example.input} → ${example.output}`,
          ),
        ].filter((part): part is string => Boolean(part?.trim()));
        screenContextRef.current = parts.join('\n\n').slice(0, 20_000) || null;
      });
      const offErr = fridayApi.coding.onError((msg) => setCodingError(msg));
      const offScan = fridayApi.coding.onScanState((state) => setScanState(state));
      codingUnsubsRef.current = [offFrame, offExt, offErr, offScan];
      setCodingActive(true);
      return true;
    } finally {
      codingStartingRef.current = false;
      setCodingStarting(false);
    }
  };

  const pauseScreenCapture = async () => {
    if (!codingActive || codingPaused) return true;
    const result = await window.friday?.coding.pause();
    if (!result?.ok) {
      setCodingError('Could not pause screen analysis.');
      return false;
    }
    setCodingPaused(true);
    return true;
  };

  const resumeScreenCapture = async () => {
    if (!codingActive || !codingPaused) return true;
    const result = await window.friday?.coding.resume();
    if (!result?.ok) {
      setCodingError('Could not resume screen analysis.');
      return false;
    }
    setCodingPaused(false);
    return true;
  };

  const startAssistTogether = async () => {
    if (audioStatusRef.current === 'starting') return;
    setAssistView('answers');
    setActiveFeature('assist');

    const starts: Promise<boolean>[] = [];
    if (audioStatusRef.current === 'paused') {
      starts.push(resume().then(() => true));
    } else if (audioStatusRef.current !== 'recording') {
      starts.push(start());
    }
    if (!codingActive) starts.push(toggleCodingMode());
    else if (codingPaused && audioStatusRef.current !== 'paused') {
      starts.push(resumeScreenCapture());
    }
    await Promise.all(starts);
  };

  // ─── session switching ──────────────────────────────────────────────────────
  // Setup ("new session" or a pick from the sessions list) changes the current
  // session id. Everything bound to the old id moves over: the sockets
  // reconnect under the new id, live capture stops (its stream belongs to the
  // old session), and per-session panels reset so nothing from the old
  // session is shown as if it were the new one.
  const switchSession = async (id: string) => {
    if (!id || id === sessionIdRef.current) return;
    if (status === 'recording' || status === 'paused') await stop();
    if (codingActive) await toggleCodingMode();
    cancelInFlight();
    sessionIdRef.current = id;
    answerRef.current?.switchSession(id);
    codingWsRef.current?.switchSession(id);
    setSessionIdState(id);
    setUsage(null);
    setAudioUsage(null);
    setEntries([]);
    setEntryIndex(-1);
    setScreenEntryIndex(-1);
    setFinals([]);
    setInterims(EMPTY_INTERIMS);
    setError(null);
    showFallbackToast(`Session ${id.slice(0, 8)}`);
  };
  const switchSessionRef = useRef(switchSession);
  switchSessionRef.current = switchSession;
  useEffect(() => onSessionIdChange((id) => void switchSessionRef.current(id)), []);

  const onCodingLanguageChange = (lang: CodingLanguage) => {
    setCodingLanguage(lang);
    setCodingLanguagePreference(lang);
    const fp = activeFingerprintRef.current;
    if (fp) {
      const tab = codingTabsRef.current.find((t) => t.fingerprint === fp);
      if (tab) requestSolve(fp, tab.problem, lang);
    }
  };

  const onCodingRegenerate = () => {
    const fp = activeFingerprintRef.current;
    if (!fp) return;
    const tab = codingTabsRef.current.find((t) => t.fingerprint === fp);
    if (!tab) return;
    requestSolve(fp, tab.problem, codingLanguageRef.current);
  };

  const onCodingReExtract = async () => {
    const fridayApi = window.friday;
    if (!fridayApi?.coding) return;
    const result = await fridayApi.coding.forceExtract();
    if (!result.ok) setCodingError(result.error ?? 'force extract failed');
  };

  const onCodingCancel = () => {
    codingWsRef.current?.cancel();
  };

  // Non-solve mode runner. Sends a {type:'solve', mode:'explain' | 'debug' |
  // 'tests', …} payload over the coding WS; the backend dispatches to the
  // correct prompt. Sets codingScratchStreamingModeRef so the WS handler
  // routes tokens to the scratch slice belonging to THIS mode (not the
  // active tab, not whichever mode is currently visible if the user has
  // already switched away).
  const runCodingScratch = () => {
    // solve = tab flow, agent = action button on the active tab — neither
    // uses the scratch runner. (The mode strip never selects 'agent', but the
    // CodingMode type includes it, so guard for narrowing.)
    if (codingMode === 'solve' || codingMode === 'agent') return;
    const scratchMode = codingMode satisfies ScratchMode;
    const patchSlice = (patch: Partial<CodingScratchState>) =>
      setCodingScratchByMode((prev) => ({
        ...prev,
        [scratchMode]: { ...prev[scratchMode], ...patch },
      }));
    const ws = codingWsRef.current;
    if (!ws || !ws.isOpen()) {
      patchSlice({ status: 'error', errorMessage: 'coding WS not connected' });
      return;
    }
    // For tests mode the problem comes from the currently-active solve tab.
    const activeTab = codingTabsRef.current.find(
      (t) => t.fingerprint === activeFingerprintRef.current,
    );
    if (scratchMode === 'tests' && !activeTab) {
      patchSlice({
        status: 'error',
        errorMessage: 'tests mode needs a detected problem — switch to Solve first.',
      });
      return;
    }
    const slice = codingScratchByMode[scratchMode];
    patchSlice({ output: '', status: 'streaming', errorMessage: null });
    codingScratchStreamingModeRef.current = scratchMode;
    ws.send({
      type: 'solve',
      mode: scratchMode,
      problem: scratchMode === 'tests' && activeTab ? activeTab.problem : undefined,
      code: scratchMode === 'explain' || scratchMode === 'debug' ? slice.code : undefined,
      error: scratchMode === 'debug' ? slice.error : undefined,
      hint: slice.hint || undefined,
      language: codingLanguageRef.current,
      provider: providerRef.current,
    });
  };

  const cancelCodingScratch = () => {
    codingWsRef.current?.cancel();
  };

  const updateCodingScratch = (patch: Partial<CodingScratchState>) => {
    if (codingMode === 'solve' || codingMode === 'agent') return;
    const m = codingMode satisfies ScratchMode;
    setCodingScratchByMode((prev) => ({
      ...prev,
      [m]: { ...prev[m], ...patch },
    }));
  };

  const onCodingModeChange = (next: CodingMode) => {
    // Switching modes only cancels the in-flight stream — it does NOT
    // clear the other modes' scratch state. That's the whole point: the
    // user can flip Explain → Debug → Explain and find their prior output
    // intact on each side.
    if (codingScratchStreamingModeRef.current) {
      codingWsRef.current?.cancel();
      codingScratchStreamingModeRef.current = null;
    }
    setCodingMode(next);
  };

  const refreshHistory = useCallback(async () => {
    if (!sessionId) return;
    setHistoryLoading(true);
    try {
      const data = await fetchSessionDetail(sessionId);
      setHistory(data?.qa ?? []);
    } finally {
      setHistoryLoading(false);
    }
  }, [sessionId]);

  const refreshUsage = useCallback(async () => {
    if (!sessionId) return;
    const data = await fetchSessionUsage(sessionId);
    if (data) {
      setUsage(data);
      if (data.audio_minutes_limit) {
        setAudioUsage({ used: data.audio_minutes_used ?? 0, limit: data.audio_minutes_limit });
      }
    }
  }, [sessionId]);

  const exportSession = () => {
    if (!sessionId) return;
    window.open(sessionExportUrl(sessionId), '_blank');
  };

  const updateDesktopPreferences = async (patch: Partial<FridayWindowPreferences>) => {
    const appWindow = window.friday?.appWindow;
    if (!appWindow) return;
    const next = await appWindow.updatePreferences(patch);
    setDesktopStatus(next);
  };

  const applyStealthMode = useCallback(async (enable: boolean) => {
    const api = window.friday?.stealth;
    if (!api) return;
    const next = enable ? await api.enable() : await api.disable();
    setStealthMode(next.enabled);
    setDesktopStatus((prev) => (prev ? { ...prev, stealth: next } : prev));
  }, []);

  const toggleStealthMode = useCallback(() => {
    if (stealthMode) {
      setStealthDisableConfirmOpen(true);
      return;
    }
    void applyStealthMode(true);
  }, [stealthMode, applyStealthMode]);

  const confirmDisableStealth = useCallback(async () => {
    setStealthDisableConfirmOpen(false);
    await applyStealthMode(false);
  }, [applyStealthMode]);

  // Belt-and-suspenders: whenever privacyMode flips on, force every
  // popover/modal closed. The panic shortcut already does this, but
  // the same guarantee should hold if privacy was toggled from anywhere
  // else (settings panel, programmatic). Without this, an observer
  // could see a "live" / model selection / cost pill flashing visible
  // for the moment between the toggle and the next user action.
  useEffect(() => {
    if (!privacyMode) return;
    setActiveFeature(null);
    setOverflowOpen(false);
    setShieldOpen(false);
    setShortcutsOpen(false);
    setStealthDisableConfirmOpen(false);
  }, [privacyMode]);

  const centerDesktopWindow = async () => {
    const appWindow = window.friday?.appWindow;
    if (!appWindow) return;
    const next = await appWindow.center();
    setDesktopStatus(next);
  };

  const openStealthTestPage = () => {
    window.open('/stealth-test', '_blank', 'noopener,noreferrer');
  };

  // Refresh history + usage cost each time an entry transitions to 'done'
  // (best-effort, small fetches). A ref of already-handled ids prevents
  // firing on every token re-render.
  const refreshedDoneIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    let touched = false;
    for (const e of entries) {
      if (e.status === 'done' && !refreshedDoneIdsRef.current.has(e.id)) {
        refreshedDoneIdsRef.current.add(e.id);
        touched = true;
      }
    }
    if (touched) {
      void refreshHistory();
      void refreshUsage();
    }
  }, [entries, refreshHistory, refreshUsage]);

  // Refresh usage when a coding solution finishes streaming, and once on
  // initial session id resolution so the pill shows last-known total.
  const refreshedCodingIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    let touched = false;
    for (const tab of codingTabs) {
      if (tab.status === 'done' && !refreshedCodingIdsRef.current.has(tab.fingerprint)) {
        refreshedCodingIdsRef.current.add(tab.fingerprint);
        touched = true;
      }
    }
    if (touched) void refreshUsage();
  }, [codingTabs, refreshUsage]);

  useEffect(() => {
    void refreshUsage();
  }, [refreshUsage]);

  const onCloseCodingTab = (fingerprint: string) => {
    if (activeFingerprintRef.current === fingerprint) {
      // Cancel any in-flight stream for the tab we're closing.
      codingWsRef.current?.cancel();
    }
    // Closing a tab is a deliberate fresh start — re-arm its one automatic
    // agent escalation for a future re-detection.
    autoEscalatedRef.current.delete(fingerprint);
    setCodingTabs((prev) => {
      const next = prev.filter((t) => t.fingerprint !== fingerprint);
      if (activeFingerprintRef.current === fingerprint) {
        const fallback = next[next.length - 1]?.fingerprint ?? null;
        setActiveFingerprint(fallback);
      }
      return next;
    });
  };

  const onClearAllCodingTabs = () => {
    codingWsRef.current?.cancel();
    setCodingTabs([]);
    setActiveFingerprint(null);
    setCodingError(null);
  };

  useEffect(() => {
    return () => {
      teardownAudioListeners();
      transcribeRef.current?.close();
      transcribeRef.current = null;
    };
  }, []);

  // Recording timer — ticks every second while status is 'recording'.
  // Pauses (retains value) when status is 'paused'. Resets to 0 when idle.
  useEffect(() => {
    if (status === 'recording') {
      if (recordingStartRef.current === null) {
        recordingStartRef.current = Date.now() - elapsedMs;
      }
      const id = window.setInterval(() => {
        if (recordingStartRef.current !== null) {
          setElapsedMs(Date.now() - recordingStartRef.current);
        }
      }, 1000);
      return () => window.clearInterval(id);
    }
    if (status === 'paused') {
      recordingStartRef.current = null;
      return undefined;
    }
    if (status === 'idle' || status === 'error') {
      recordingStartRef.current = null;
      setElapsedMs(0);
    }
    return undefined;
    // elapsedMs intentionally omitted — we read its current value when
    // resuming from pause but don't want to re-create the interval each tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  const isRecording = status === 'recording';
  const isPaused = status === 'paused';
  const isLive = isRecording || isPaused;
  const elapsedDisplay = formatElapsed(elapsedMs);

  // AI Help (spoken / typed answers) and the Screen tab (answers to on-screen
  // questions) render the same answer panel over their own list.
  const renderAnswerPanel = (fromScreen: boolean): ReactNode => {
    const entry = fromScreen ? screenEntry : currentEntry;
    const { position, count } = listPosition(
      entries,
      fromScreen ? screenIndex : currentIndex,
      fromScreen,
    );
    return (
      <AnswerPanel
        variant={fromScreen ? 'screen' : 'listen'}
        provider={provider}
        onProviderChange={onProviderChange}
        qdModel={qdModel}
        onQdModelChange={onQdModelChange}
        audioUsage={audioUsage}
        qdState={qdState}
        qdFallbackModel={qdFallbackModel}
        qdError={qdError}
        qdDedupAt={qdDedupAt}
        question={entry?.question ?? null}
        answer={entry?.answer ?? ''}
        messages={entry?.messages ?? []}
        status={entry?.status ?? 'idle'}
        error={entry?.error ?? panelError}
        marked={Boolean(entry?.marked)}
        onMarkAnswered={() => onMarkAnswered(entry)}
        onCancel={cancelAnswer}
        onClear={() => clearAnswer(fromScreen)}
        onReask={() => onReask(entry)}
        entryIndex={position}
        entryCount={count}
        onPrev={() => goPrev(fromScreen)}
        onNext={() => goNext(fromScreen)}
        // Typing in the Screen tab stays in the screen thread, even before its
        // answer has text (errored, cancelled, first token pending).
        onSubmitCustom={
          fromScreen
            ? (q) =>
                entry ? followUp(q, { entryId: entry.id }) : askAnswer(q, { fromScreen: true })
            : submitCustom
        }
        // The Screen tab's follow-ups continue the screen thread it shows.
        onFollowUp={(q) => followUp(q, fromScreen && entry ? { entryId: entry.id } : {})}
        connected={answerConnected}
        privacyMode={privacyMode}
        listening={isLive}
        starting={status === 'starting'}
        onStart={start}
        transcriptSlot={
          fromScreen ? undefined : (
            <Transcript
              status={status}
              finals={finals}
              interims={interims}
              privacyMode={privacyMode}
              fill
            />
          )
        }
      />
    );
  };

  const renderFeatureContent = (key: FeatureKey | 'listen' | 'coding'): ReactNode => {
    if (key === 'assist') {
      return (
        <AssistPanel
          view={assistView}
          onViewChange={setAssistView}
          onStartTogether={startAssistTogether}
          audioStatus={isRecording ? 'live' : isPaused ? 'paused' : 'off'}
          screenStatus={codingActive ? (codingPaused ? 'paused' : 'live') : 'off'}
          starting={status === 'starting' || codingStarting}
          privacyMode={privacyMode}
        >
          {renderFeatureContent(assistView === 'answers' ? 'listen' : 'coding')}
        </AssistPanel>
      );
    }
    if (key === 'setup') {
      return <SetupForm onComplete={() => setActiveFeature(null)} />;
    }
    if (key === 'listen') {
      return <PanelErrorBoundary label="AI Help">{renderAnswerPanel(false)}</PanelErrorBoundary>;
    }
    if (key === 'coding') {
      return (
        <PanelErrorBoundary label="Coding mode">
          <CodingPanel
            active={codingActive}
            onToggle={toggleCodingMode}
            language={codingLanguage}
            onLanguageChange={onCodingLanguageChange}
            provider={provider}
            onProviderChange={onProviderChange}
            claudeModel={codingClaudeModel}
            onClaudeModelChange={onCodingClaudeModelChange}
            tabs={codingTabs}
            activeFingerprint={activeFingerprint}
            onSelectTab={setActiveFingerprint}
            onCloseTab={onCloseCodingTab}
            onClearAll={onClearAllCodingTabs}
            onRegenerate={onCodingRegenerate}
            onReExtract={onCodingReExtract}
            onCancel={onCodingCancel}
            onRefine={onCodingRefine}
            onAgentSolve={() => requestAgentSolve()}
            agentStats={agentStats}
            frameInfo={codingFrame}
            error={codingError}
            privacyMode={privacyMode}
            mode={codingMode}
            onModeChange={onCodingModeChange}
            scratch={
              // Solve/agent modes have no scratch view (tabs handle output) —
              // pass an empty slice so the prop stays typed; CodingPanel
              // ignores it when isSolveMode is true.
              codingMode === 'solve' || codingMode === 'agent'
                ? blankScratch('explain')
                : codingScratchByMode[codingMode]
            }
            onScratchChange={updateCodingScratch}
            onRunScratch={runCodingScratch}
            onCancelScratch={cancelCodingScratch}
            scanState={scanState}
            onStartScan={startGuidedScan}
            onFinishScan={finishGuidedScan}
            onCancelScan={cancelGuidedScan}
            pendingScreenQuestion={pendingScreenQuestion}
            onAnswerCapturedQuestion={answerCapturedScreenQuestion}
            onScanQuestionAgain={() => {
              setPendingScreenQuestion(null);
              void startGuidedScan();
            }}
            sessionId={getOrCreateSessionId()}
            passagesRefreshKey={passagesRefreshKey}
            onClearScreenContext={() => resetScreenContext(getOrCreateSessionId())}
            screenAnswers={screenEntry ? renderAnswerPanel(true) : null}
          />
        </PanelErrorBoundary>
      );
    }
    if (key === 'history') {
      return <HistoryList qa={history} loading={historyLoading} onExport={exportSession} />;
    }
    if (key === 'settings') {
      return (
        <SettingsBody
          desktopStatus={desktopStatus}
          stealthMode={stealthMode}
          privacyMode={privacyMode}
          onStealthModeChange={toggleStealthMode}
          onPrivacyModeChange={setPrivacyMode}
          onPreferenceChange={updateDesktopPreferences}
          onCenterWindow={centerDesktopWindow}
          onOpenStealthTest={openStealthTestPage}
        />
      );
    }
    return null;
  };

  return (
    <div className="pointer-events-none mx-auto flex w-fit max-w-full flex-col items-center gap-2 px-3 py-3">
      {/* Top control bar — single Parakeet-style opaque pill. The Popover
          anchor sits on the bar itself so feature panels drop straight
          beneath it. Secondary chrome (stealth, connection, cost, etc.)
          lives inside the ⋮ overflow popover to keep this row short. */}
      <Popover.Root
        open={activeFeature !== null}
        onOpenChange={(open) => {
          if (!open) setActiveFeature(null);
        }}
      >
        <Popover.Anchor asChild>
          <div
            data-interactive="true"
            className="session-bar pointer-events-auto flex items-center gap-x-2 rounded-2xl bg-white/55 px-3 py-2 backdrop-blur-2xl backdrop-saturate-150 dark:bg-neutral-900/55"
          >
            {/* Brand cluster: status dot + name + mic-state glyph. */}
            <span
              className="flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[13px] font-semibold text-neutral-800 dark:text-neutral-100"
              aria-label="Friday"
            >
              {/* Parakeet-style brand cluster: mascot → wordmark → status dot.
                  The dot was on the left before; moving it after the wordmark
                  matches Parakeet's pattern (avatar + name first, small status
                  indicators trail). */}
              <FridayMark className="h-5 w-5" />
              <span>Friday</span>
              <span className="relative flex h-2 w-2" aria-hidden>
                {/* In privacyMode, suppress the red pulsing ring + dot.
                    A red pulsing indicator is the single biggest tell
                    that "this app is recording something right now." We
                    fall back to a neutral gray dot regardless of
                    actual recording state. */}
                <span
                  className={cn(
                    'absolute inline-flex h-full w-full rounded-full opacity-75',
                    isRecording && !privacyMode ? 'animate-ping bg-red-400' : 'bg-transparent',
                  )}
                />
                <span
                  className={cn(
                    'relative inline-flex h-2 w-2 rounded-full',
                    privacyMode
                      ? 'bg-neutral-400 dark:bg-neutral-600'
                      : isRecording
                        ? 'bg-red-500'
                        : isPaused
                          ? 'bg-amber-500'
                          : 'bg-neutral-400 dark:bg-neutral-600',
                  )}
                />
              </span>
            </span>

            {/* Hero features collapse away so the minimal bar is just
                brand + capture + trailing controls. */}
            {!collapsed ? (
              <>
                <ClusterDivider />
                <FeatureBar
                  active={activeFeature}
                  // Opening AI Help only opens the panel. Starting the
                  // capture session is an explicit act on the panel's Start
                  // button — peeking at the panel must never hot-mic the user.
                  onChange={setActiveFeature}
                  badges={{
                    assist:
                      entries.some((e) => e.status === 'streaming') ||
                      codingTabs.some((t) => t.status === 'streaming') ||
                      (isLive &&
                        (finals.length > 0 || Boolean(interims.interviewer || interims.candidate))),
                  }}
                />
              </>
            ) : null}

            {/* Capture cluster — appears only while live (timer + pause + stop)
                or briefly during the starting handshake. Starting happens
                from the AI Help panel's Start button, so this slot is empty
                in the resting state. */}
            {status !== 'idle' ? (
              <>
                <ClusterDivider />
                <CaptureCluster
                  status={status}
                  screenActive={codingActive}
                  elapsedDisplay={elapsedDisplay}
                  onPause={pause}
                  onResume={resume}
                  onStop={stop}
                />
              </>
            ) : null}

            {/* Trailing controls: overflow, window actions, drag and collapse. */}
            <span aria-hidden className="mx-0.5 h-5 w-px bg-neutral-300/60 dark:bg-white/10" />

            <OverflowMenu
              open={overflowOpen}
              onOpenChange={setOverflowOpen}
              desktopStatus={desktopStatus}
              stealthMode={stealthMode}
              shieldOpen={shieldOpen}
              onShieldToggle={() => setShieldOpen((v) => !v)}
              transcribeStatus={
                status === 'recording' || status === 'paused'
                  ? 'live'
                  : status === 'error'
                    ? 'error'
                    : 'idle'
              }
              answerConnected={answerConnected}
              codingConnected={codingConnected}
              latencyMs={latencyMs}
              answerLatencyMs={answerLatencyMs}
              answerLatencyProvider={answerLatencyProvider}
              answerLatencyByProvider={answerLatencyByProvider}
              usage={usage}
              audioUsage={audioUsage}
              sessionId={sessionId}
              activeSecondaryFeature={
                activeFeature && SECONDARY_FEATURES.some((f) => f.key === activeFeature)
                  ? activeFeature
                  : null
              }
              onSecondaryFeature={(key) => {
                setActiveFeature(key);
                setOverflowOpen(false);
              }}
              onClearTranscript={() => {
                clearTranscript();
                setOverflowOpen(false);
              }}
              onShortcuts={() => {
                setShortcutsOpen(true);
                setOverflowOpen(false);
              }}
              onExport={() => {
                exportSession();
                setOverflowOpen(false);
              }}
              onOpenProject={(project) => {
                setBriefProject(project);
                setOverflowOpen(false);
              }}
            />

            {/* Drag handle — the entire .session-bar already has
                -webkit-app-region:drag, so this is purely an affordance.
                Kept as a non-button span so the drag region applies; matched
                visually to the overflow/collapse buttons either side of it. */}
            <span
              role="presentation"
              aria-label="Drag to move"
              title="Drag to move"
              className="flex h-7 w-7 items-center justify-center rounded-md text-neutral-500 transition-colors hover:bg-white/60 hover:text-neutral-800 dark:text-neutral-400 dark:hover:bg-white/10 dark:hover:text-neutral-100"
            >
              <Move className="h-3.5 w-3.5" aria-hidden />
            </span>

            <button
              type="button"
              onClick={() => {
                void window.friday?.appWindow.restart();
              }}
              aria-label="Restart Friday"
              title={`Restart Friday · Stealth will stay ${stealthMode ? 'on' : 'off'}`}
              className="flex h-8 w-8 items-center justify-center rounded-md text-neutral-500 transition-[background-color,color,transform] duration-150 hover:bg-white/60 hover:text-neutral-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-400 active:scale-[0.96] motion-reduce:transition-none motion-reduce:active:scale-100 dark:text-neutral-400 dark:hover:bg-white/10 dark:hover:text-neutral-100"
            >
              <RotateCcw className="h-4 w-4" aria-hidden />
            </button>

            <button
              type="button"
              onClick={() => {
                void window.friday?.appWindow.quit();
              }}
              aria-label="Quit Friday"
              title="Quit Friday"
              className="flex h-8 w-8 items-center justify-center rounded-md text-neutral-500 transition-[background-color,color,transform] duration-150 hover:bg-red-500/10 hover:text-red-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400 active:scale-[0.96] motion-reduce:transition-none motion-reduce:active:scale-100 dark:text-neutral-400 dark:hover:bg-red-400/10 dark:hover:text-red-300"
            >
              <X className="h-4 w-4" aria-hidden />
            </button>

            <button
              type="button"
              onClick={() => setCollapsed((v) => !v)}
              aria-label={collapsed ? 'Expand bar' : 'Collapse bar'}
              title={collapsed ? 'Expand' : 'Collapse'}
              className="flex h-7 w-7 items-center justify-center rounded-md text-neutral-500 transition-colors hover:bg-white/60 hover:text-neutral-800 dark:text-neutral-400 dark:hover:bg-white/10 dark:hover:text-neutral-100"
            >
              {collapsed ? (
                <ChevronDown className="h-3.5 w-3.5" aria-hidden />
              ) : (
                <ChevronUp className="h-3.5 w-3.5" aria-hidden />
              )}
            </button>
          </div>
        </Popover.Anchor>
        <Popover.Portal>
          {activeFeature ? (
            <Popover.Content
              align="center"
              sideOffset={10}
              collisionPadding={16}
              onOpenAutoFocus={(e) => e.preventDefault()}
              onInteractOutside={(e) => {
                const target = e.target as HTMLElement | null;
                if (target?.closest('[data-feature-trigger]')) {
                  e.preventDefault();
                }
              }}
              data-interactive="true"
              data-drop-zone={activeFeature === 'setup' ? 'true' : undefined}
              className={cn(
                'pointer-events-auto z-50 resize overflow-auto rounded-2xl border border-white/40 bg-white/85 p-5 shadow-[0_24px_60px_rgba(15,23,42,0.18)] backdrop-blur-2xl backdrop-saturate-150',
                'h-[68vh] min-h-[20rem] min-w-[24rem] max-h-[92vh]',
                'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:slide-in-from-top-1 motion-reduce:animate-none',
                'data-[state=open]:fade-in data-[state=closed]:fade-out',
                'data-[state=open]:zoom-in-95 data-[state=closed]:zoom-out-95',
                'duration-150',
                'dark:border-white/10 dark:bg-neutral-900/85 dark:shadow-[0_24px_60px_rgba(0,0,0,0.6)]',
                getFeatureWidth(activeFeature),
              )}
            >
              <Popover.Arrow className="fill-white/85 stroke-white/40 dark:fill-neutral-900/85 dark:stroke-white/10" />
              {renderFeatureContent(activeFeature)}
            </Popover.Content>
          ) : null}
        </Popover.Portal>
      </Popover.Root>

      {/* Banners */}
      {showBrowserBanner ? (
        <div
          data-interactive="true"
          className="pointer-events-auto rounded-md border border-amber-400/50 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-500/30 dark:bg-amber-950/40 dark:text-amber-200"
        >
          Open this page from the Friday desktop window — system-audio capture isn&apos;t available
          in a regular browser tab.
        </div>
      ) : null}
      {error ? (
        <div
          data-interactive="true"
          className="pointer-events-auto rounded-md border border-red-400/50 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-950/40 dark:text-red-300"
        >
          {error}
        </div>
      ) : null}
      {desktopToast ? <DesktopToast message={desktopToast} /> : null}

      <ShortcutsModal open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
      <ProjectBriefModal project={briefProject} onClose={() => setBriefProject(null)} />

      <ModalShell
        title="Disable stealth mode?"
        icon={<ShieldAlert className="h-3.5 w-3.5" />}
        open={stealthDisableConfirmOpen}
        onClose={() => setStealthDisableConfirmOpen(false)}
      >
        <div className="flex flex-col gap-4 text-sm">
          <p className="text-neutral-700 dark:text-neutral-200">
            Turning stealth mode off will release Electron content protection and the macOS
            window-sharing lock. The Friday window may then appear in screen-share, screen
            recordings, and screenshot tools.
          </p>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setStealthDisableConfirmOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => {
                void confirmDisableStealth();
              }}
            >
              Disable stealth
            </Button>
          </div>
        </div>
      </ModalShell>
    </div>
  );
}

// FridayMark — the Owl mascot. Pairs with the "Friday" wordmark in the brand
// cluster, the home hero, the favicon, and the macOS app icon. The /mascots
// page keeps Owl/Bat/Fox drafts side by side for the record.
function FridayMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" className={className} aria-hidden>
      <path d="M14 16 Q12 4 22 8 L20 20 Z" fill="#075985" />
      <path d="M50 16 Q52 4 42 8 L44 20 Z" fill="#075985" />
      <ellipse cx="32" cy="36" rx="20" ry="22" fill="#0284c7" />
      <ellipse cx="32" cy="42" rx="11" ry="14" fill="#7dd3fc" />
      <circle cx="23" cy="28" r="10" fill="#f0f9ff" />
      <circle cx="41" cy="28" r="10" fill="#f0f9ff" />
      <circle cx="23" cy="28" r="6" fill="#0c4a6e" />
      <circle cx="41" cy="28" r="6" fill="#0c4a6e" />
      <circle cx="23" cy="28" r="3" fill="#1e293b" />
      <circle cx="41" cy="28" r="3" fill="#1e293b" />
      <circle cx="24.5" cy="26.5" r="1.2" fill="white" />
      <circle cx="42.5" cy="26.5" r="1.2" fill="white" />
      <path d="M29 34 L35 34 L32 40 Z" fill="#f59e0b" />
      <path d="M14 36 Q10 44 14 50 Q18 46 16 40 Z" fill="#075985" />
      <path d="M50 36 Q54 44 50 50 Q46 46 48 40 Z" fill="#075985" />
    </svg>
  );
}

function CaptureCluster({
  status,
  screenActive,
  elapsedDisplay,
  onPause,
  onResume,
  onStop,
}: {
  status: Status;
  screenActive: boolean;
  elapsedDisplay: string;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
}) {
  const isRecording = status === 'recording';
  const isPaused = status === 'paused';
  const isLive = isRecording || isPaused;
  const isStarting = status === 'starting';
  const captureName = screenActive ? 'Assist' : 'listening';

  if (!isLive) {
    // Idle: nothing here — the session is started from the AI Help panel's
    // Start button. We still surface a small "Starting…" indicator so the user
    // gets feedback while the WS handshake / Deepgram connection comes up.
    if (!isStarting) return null;
    return (
      <span
        className={cn(
          'inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-medium',
          'border-sky-300/60 bg-sky-500/10 text-sky-700 dark:border-sky-500/40 dark:text-sky-300',
        )}
        aria-label="Starting"
        title="Starting…"
      >
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
        <span>Starting…</span>
      </span>
    );
  }

  // Live (recording or paused) — segmented pill: timer · pause/resume · stop.
  // Tint encodes status (red = recording, amber = paused). Pause stays on the
  // bar so the user can pause without opening the overflow menu.
  const tone = isRecording
    ? {
        wrap: 'border-red-400/40 bg-red-500/10 dark:border-red-500/40',
        text: 'text-red-700 dark:text-red-300',
        dot: 'animate-pulse bg-red-500',
        primaryHover: 'hover:bg-red-500/20',
      }
    : {
        wrap: 'border-amber-400/40 bg-amber-500/10 dark:border-amber-500/40',
        text: 'text-amber-700 dark:text-amber-300',
        dot: 'bg-amber-500',
        primaryHover: 'hover:bg-amber-500/20',
      };

  return (
    <div
      className={cn('inline-flex h-8 items-center gap-0.5 rounded-full border p-0.5', tone.wrap)}
      role="group"
      aria-label={isRecording ? `${captureName} active` : `${captureName} paused`}
    >
      <span
        className={cn(
          'flex items-center gap-1.5 px-2 font-mono text-[11px] tabular-nums',
          tone.text,
        )}
      >
        <span className={cn('h-1.5 w-1.5 rounded-full', tone.dot)} aria-hidden />
        {elapsedDisplay}
      </span>
      <button
        type="button"
        onClick={isRecording ? onPause : onResume}
        aria-label={isRecording ? `Pause ${captureName}` : `Resume ${captureName}`}
        title={isRecording ? `Pause ${captureName}` : `Resume ${captureName}`}
        className={cn(
          'flex h-6 w-6 items-center justify-center rounded-full transition-colors',
          tone.text,
          tone.primaryHover,
        )}
      >
        {isRecording ? (
          <Pause className="h-3 w-3" aria-hidden />
        ) : (
          <Play className="h-3 w-3" aria-hidden />
        )}
      </button>
      <button
        type="button"
        onClick={onStop}
        aria-label="Stop"
        title="Stop"
        className={cn(
          'flex h-6 w-6 items-center justify-center rounded-full transition-colors',
          'text-neutral-700 hover:bg-neutral-200/70 dark:text-neutral-300 dark:hover:bg-white/10',
        )}
      >
        <Square className="h-3 w-3" aria-hidden />
      </button>
    </div>
  );
}

// Pull the first fenced code block (```lang … ```) from a Markdown
// response. Falls back to the full string if no fence is found — better
// to send something than nothing.
function extractFirstCodeBlock(markdown: string): string {
  const fence = markdown.match(/```[a-zA-Z+#]*\n([\s\S]*?)```/);
  return (fence?.[1] ?? markdown).trim();
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

const StealthIndicator = forwardRef<
  HTMLDivElement,
  {
    desktopStatus: FridayWindowStatus | null;
    stealthMode: boolean;
    open: boolean;
    onToggle: () => void;
  }
>(function StealthIndicator({ desktopStatus, stealthMode, open, onToggle }, ref) {
  const screenShareProtected = Boolean(
    desktopStatus?.stealth.contentProtection &&
    (desktopStatus.stealth.nativeApplied || !desktopStatus.stealth.nativeSupported),
  );
  const tone = stealthMode
    ? 'border-emerald-300 bg-emerald-500/10 text-emerald-700 dark:border-emerald-700 dark:text-emerald-400'
    : 'border-red-300 bg-red-500/10 text-red-700 dark:border-red-800 dark:text-red-400';

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={onToggle}
        className={cn(
          'inline-flex h-8 w-8 items-center justify-center rounded-full border transition-colors',
          tone,
        )}
        aria-label="Stealth status"
        title={stealthMode ? 'Stealth active' : 'Stealth disabled'}
      >
        {stealthMode ? <ShieldCheck className="h-4 w-4" /> : <ShieldAlert className="h-4 w-4" />}
      </button>
      {open ? (
        <div className="absolute right-0 top-10 z-40 w-72 rounded-xl border border-neutral-200 bg-white/95 p-3 shadow-xl backdrop-blur dark:border-neutral-800 dark:bg-neutral-900/95">
          <div className="flex items-center gap-2">
            {stealthMode ? (
              <ShieldCheck className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
            ) : (
              <ShieldAlert className="h-4 w-4 text-red-600 dark:text-red-400" />
            )}
            <div className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
              Stealth status
            </div>
          </div>
          <div className="mt-3 space-y-2 text-xs text-neutral-600 dark:text-neutral-300">
            <StatusRow
              label="Screen-share protection"
              value={screenShareProtected ? 'Active' : 'Reduced'}
              tone={screenShareProtected ? 'good' : 'bad'}
            />
            <StatusRow
              label="Dock hidden"
              value={desktopStatus?.dockHidden ? 'Yes' : 'No'}
              tone={desktopStatus?.dockHidden ? 'good' : 'bad'}
            />
            <StatusRow
              label="Always on top"
              value={desktopStatus?.preferences.alwaysOnTop ? 'Yes' : 'No'}
              tone={desktopStatus?.preferences.alwaysOnTop ? 'good' : 'bad'}
            />
            <StatusRow
              label="Current opacity"
              value={desktopStatus ? `${Math.round(desktopStatus.opacity * 100)}%` : '—'}
            />
            <StatusRow
              label="Accessory app"
              value={desktopStatus?.accessoryApp ? 'Yes' : 'No'}
              tone={desktopStatus?.accessoryApp ? 'good' : 'bad'}
            />
            {desktopStatus?.redisAvailable !== null &&
            desktopStatus?.redisAvailable !== undefined ? (
              <StatusRow
                label="Redis session context"
                value={desktopStatus.redisAvailable ? 'Available' : 'Unavailable · reduced context'}
                tone={desktopStatus.redisAvailable ? 'good' : 'bad'}
              />
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
});

function StatusRow({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'good' | 'bad';
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span>{label}</span>
      <span
        className={cn(
          'font-medium',
          tone === 'good' && 'text-emerald-700 dark:text-emerald-400',
          tone === 'bad' && 'text-red-700 dark:text-red-400',
        )}
      >
        {value}
      </span>
    </div>
  );
}

function DesktopToast({ message }: { message: string }) {
  return (
    <div className="pointer-events-none fixed right-6 top-16 z-[90] rounded-full border border-neutral-200 bg-white/90 px-3 py-1.5 text-xs font-medium text-neutral-700 shadow-lg backdrop-blur dark:border-neutral-800 dark:bg-neutral-900/90 dark:text-neutral-200">
      {message}
    </div>
  );
}

function ClusterDivider() {
  return (
    <span
      aria-hidden
      className="hidden h-5 w-px bg-neutral-300/60 dark:bg-white/10 sm:inline-block"
    />
  );
}

// Descriptive session-cost pill: shows running USD spend + an itemized
// breakdown by call-kind on hover. Pulls from /api/sessions/{id}/usage,
// which aggregates the usage_log table. Tones scale with cost so a runaway
// session is visible at a glance.
function CostPill({ usage }: { usage: SessionUsageSummary | null }) {
  if (!usage) {
    return (
      <div
        className="flex items-center gap-1.5 rounded-full bg-neutral-100 px-2 py-1 font-mono text-[10px] text-neutral-500 dark:bg-neutral-800/80 dark:text-neutral-500"
        title="No LLM calls yet this session"
      >
        <span className="h-1.5 w-1.5 rounded-full bg-neutral-400" />
        <span>$0.0000</span>
      </div>
    );
  }
  const total = usage.total_cost_usd ?? 0;
  // Tone thresholds tuned to typical usage: <$0.05 = green (cheap), <$0.50
  // = amber (heavy session), >$0.50 = red (probably runaway coding mode).
  const tone =
    total < 0.05
      ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400'
      : total < 0.5
        ? 'bg-amber-500/15 text-amber-700 dark:text-amber-400'
        : 'bg-red-500/15 text-red-700 dark:text-red-400';
  const dot = total < 0.05 ? 'bg-emerald-500' : total < 0.5 ? 'bg-amber-500' : 'bg-red-500';

  // Multi-line tooltip with per-row breakdown so the user can see *what's*
  // costing them without opening the export.
  const breakdown = usage.rows
    .map((r) => {
      const cost = r.cost_usd ?? 0;
      const label = `${r.kind}${r.model ? ` · ${r.model}` : ''}`;
      return `${label}: ${r.calls}× → $${cost.toFixed(4)}`;
    })
    .join('\n');
  const tooltip = [
    `Session spend: $${total.toFixed(4)}`,
    `${usage.total_calls} LLM calls (${usage.total_input_tokens.toLocaleString()} in / ${usage.total_output_tokens.toLocaleString()} out tokens)`,
    breakdown ? '' : null,
    breakdown || null,
  ]
    .filter((s): s is string => s !== null)
    .join('\n');

  // Display formatting: keep 4 decimals while cheap so $0.0023 reads cleanly,
  // 2 decimals once we cross a cent so totals stay scannable.
  const displayCost = total >= 0.01 ? `$${total.toFixed(2)}` : `$${total.toFixed(4)}`;

  return (
    <div
      className={cn('flex items-center gap-1.5 rounded-full px-2 py-1 font-mono text-[10px]', tone)}
      title={tooltip}
      aria-label={`Session cost ${displayCost} across ${usage.total_calls} calls`}
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', dot)} />
      <span>{displayCost}</span>
      <span className="text-neutral-500 dark:text-neutral-400">·</span>
      <span>{usage.total_calls}</span>
      <span className="uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
        {usage.total_calls === 1 ? 'call' : 'calls'}
      </span>
    </div>
  );
}

function LatencyBadge({ ms }: { ms: number | null }) {
  if (ms === null) return null;
  const tone =
    ms < 500
      ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400'
      : ms < 1000
        ? 'bg-amber-500/15 text-amber-700 dark:text-amber-400'
        : 'bg-red-500/15 text-red-700 dark:text-red-400';
  const dot = ms < 500 ? 'bg-emerald-500' : ms < 1000 ? 'bg-amber-500' : 'bg-red-500';
  return (
    <div className={cn('flex items-center gap-1.5 rounded-full px-2 py-1', tone)}>
      <span className={cn('h-1.5 w-1.5 rounded-full', dot)} />
      <span className="font-mono">{Math.round(ms)} ms</span>
    </div>
  );
}

// Answer-stream latency, tagged with the effective provider (which can
// differ from the user's selection after auto-fallback). Hovering shows
// the per-provider history so you can compare Gemini vs OpenAI etc.
// Thresholds intentionally higher than transcribe latency — answer
// generation is bound by model latency (1–10s typical), not network.
function AnswerLatencyBadge({
  ms,
  provider,
  byProvider,
}: {
  ms: number;
  provider: AnswerProvider;
  byProvider: Partial<Record<AnswerProvider, number>>;
}) {
  const tone =
    ms < 1500
      ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400'
      : ms < 4000
        ? 'bg-amber-500/15 text-amber-700 dark:text-amber-400'
        : 'bg-red-500/15 text-red-700 dark:text-red-400';
  const dot = ms < 1500 ? 'bg-emerald-500' : ms < 4000 ? 'bg-amber-500' : 'bg-red-500';
  const shortName: Record<AnswerProvider, string> = {
    gemini: 'gem',
    openai: 'gpt',
    deepseek: 'ds',
    claude: 'cla',
  };
  // Tooltip: list every provider we've seen with their most recent
  // elapsed_ms. Useful when comparing providers or debugging slow runs.
  const tooltip = (Object.keys(byProvider) as AnswerProvider[])
    .map((p) => `${p}: ${Math.round(byProvider[p] ?? 0)} ms`)
    .join('\n');
  return (
    <div
      className={cn('flex items-center gap-1.5 rounded-full px-2 py-1', tone)}
      title={tooltip || undefined}
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', dot)} />
      <span className="font-mono">
        {shortName[provider]} · {Math.round(ms)} ms
      </span>
    </div>
  );
}

// Overflow menu — Parakeet's ⋮ trigger. Holds the secondary chrome that
// used to live on the second utility row: stealth status, connection pills,
// latency, cost, session id, the non-hero features (Setup, History,
// Settings), and the trio of session actions (clear, shortcuts, export).
//
// Built on a manual relative+absolute container rather than Radix Popover.
// We used to nest a Popover.Root here inside the feature Popover.Root's
// Anchor; that combination would silently swallow secondary-feature opens
// (Setup / History / Settings would not surface their popover when picked
// from inside the overflow). Plain divs sidestep the issue entirely.
function OverflowMenu({
  open,
  onOpenChange,
  desktopStatus,
  stealthMode,
  shieldOpen,
  onShieldToggle,
  transcribeStatus,
  answerConnected,
  codingConnected,
  latencyMs,
  answerLatencyMs,
  answerLatencyProvider,
  answerLatencyByProvider,
  usage,
  audioUsage,
  sessionId,
  activeSecondaryFeature,
  onSecondaryFeature,
  onClearTranscript,
  onShortcuts,
  onExport,
  onOpenProject,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  desktopStatus: FridayWindowStatus | null;
  stealthMode: boolean;
  shieldOpen: boolean;
  onShieldToggle: () => void;
  transcribeStatus: 'idle' | 'live' | 'error';
  answerConnected: boolean;
  codingConnected: boolean;
  latencyMs: number | null;
  answerLatencyMs: number | null;
  answerLatencyProvider: AnswerProvider | null;
  answerLatencyByProvider: Partial<Record<AnswerProvider, number>>;
  usage: SessionUsageSummary | null;
  audioUsage: AudioUsage | null;
  sessionId: string;
  activeSecondaryFeature: FeatureKey | null;
  onSecondaryFeature: (key: FeatureKey) => void;
  onClearTranscript: () => void;
  onShortcuts: () => void;
  onExport: () => void;
  onOpenProject: (project: Project) => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (panelRef.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      onOpenChange(false);
    };
    const escHandler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onOpenChange(false);
    };
    window.addEventListener('mousedown', handler);
    window.addEventListener('keydown', escHandler);
    return () => {
      window.removeEventListener('mousedown', handler);
      window.removeEventListener('keydown', escHandler);
    };
  }, [open, onOpenChange]);

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-label="More"
        aria-expanded={open}
        title="More"
        onClick={() => onOpenChange(!open)}
        className={cn(
          'flex h-7 w-7 items-center justify-center rounded-md text-neutral-500 transition-colors hover:bg-white/60 hover:text-neutral-800 dark:text-neutral-400 dark:hover:bg-white/10 dark:hover:text-neutral-100',
          open && 'bg-white/60 text-neutral-800 dark:bg-white/10 dark:text-neutral-100',
        )}
      >
        <MoreVertical className="h-4 w-4" aria-hidden />
      </button>
      {open ? (
        <div
          ref={panelRef}
          data-interactive="true"
          className="pointer-events-auto absolute right-0 top-full z-50 mt-2 w-72 rounded-xl bg-white/85 p-3 text-[12px] text-neutral-700 shadow-[0_20px_50px_rgba(15,23,42,0.16)] backdrop-blur-2xl backdrop-saturate-150 dark:bg-neutral-900/85 dark:text-neutral-200 dark:shadow-[0_20px_50px_rgba(0,0,0,0.55)]"
        >
          {/* Status section */}
          <div className="mb-2 px-1 text-[10px] font-semibold uppercase tracking-wider text-neutral-500 dark:text-neutral-500">
            Status
          </div>
          <div className="flex flex-col gap-1.5 px-1">
            <div className="flex items-center justify-between gap-2">
              <span className="text-neutral-600 dark:text-neutral-400">Stealth</span>
              <StealthIndicator
                desktopStatus={desktopStatus}
                stealthMode={stealthMode}
                open={shieldOpen}
                onToggle={onShieldToggle}
              />
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-neutral-600 dark:text-neutral-400">Connection</span>
              <ConnectionPill
                transcribe={transcribeStatus}
                answer={answerConnected}
                coding={codingConnected}
              />
            </div>
            {latencyMs !== null ? (
              <div className="flex items-center justify-between gap-2">
                <span className="text-neutral-600 dark:text-neutral-400">Transcribe</span>
                <LatencyBadge ms={latencyMs} />
              </div>
            ) : null}
            {answerLatencyMs !== null && answerLatencyProvider ? (
              <div className="flex items-center justify-between gap-2">
                <span className="text-neutral-600 dark:text-neutral-400">Answer</span>
                <AnswerLatencyBadge
                  ms={answerLatencyMs}
                  provider={answerLatencyProvider}
                  byProvider={answerLatencyByProvider}
                />
              </div>
            ) : null}
            <div className="flex items-center justify-between gap-2">
              <span className="text-neutral-600 dark:text-neutral-400">Cost</span>
              <CostPill usage={usage} />
            </div>
            {audioUsage ? (
              <div className="flex items-center justify-between gap-2">
                <span className="text-neutral-600 dark:text-neutral-400">Audio</span>
                <AudioBudgetPill usage={audioUsage} />
              </div>
            ) : null}
            {sessionId ? (
              <div className="flex items-center justify-between gap-2">
                <span className="text-neutral-600 dark:text-neutral-400">Session</span>
                <span className="rounded-full bg-black/5 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-neutral-600 dark:bg-white/5 dark:text-neutral-300">
                  {sessionId.slice(0, 8)}
                </span>
              </div>
            ) : null}
            {sessionId ? (
              <AttachedProjectChips sessionId={sessionId} onOpen={onOpenProject} />
            ) : null}
          </div>

          <div className="my-3 h-px bg-neutral-300/60 dark:bg-white/10" />

          {/* Secondary features */}
          <div className="mb-2 px-1 text-[10px] font-semibold uppercase tracking-wider text-neutral-500 dark:text-neutral-500">
            Open
          </div>
          <div className="flex flex-col">
            {SECONDARY_FEATURES.map((f) => {
              const Icon = f.icon;
              const isActive = activeSecondaryFeature === f.key;
              return (
                <button
                  key={f.key}
                  type="button"
                  data-feature-trigger
                  onClick={() => onSecondaryFeature(f.key)}
                  className={cn(
                    'flex items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-black/5 dark:hover:bg-white/10',
                    isActive && 'bg-black/5 text-neutral-900 dark:bg-white/10 dark:text-white',
                  )}
                >
                  <Icon
                    className="h-3.5 w-3.5 text-neutral-500 dark:text-neutral-400"
                    aria-hidden
                  />
                  <span>{f.label}</span>
                </button>
              );
            })}
          </div>

          <div className="my-3 h-px bg-neutral-300/60 dark:bg-white/10" />

          {/* Actions */}
          <div className="flex flex-col">
            <button
              type="button"
              onClick={onClearTranscript}
              className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-black/5 dark:hover:bg-white/10"
            >
              <Eraser className="h-3.5 w-3.5 text-neutral-500 dark:text-neutral-400" aria-hidden />
              <span>Clear transcript</span>
            </button>
            <button
              type="button"
              onClick={onShortcuts}
              className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-black/5 dark:hover:bg-white/10"
            >
              <span className="flex items-center gap-2">
                <Keyboard
                  className="h-3.5 w-3.5 text-neutral-500 dark:text-neutral-400"
                  aria-hidden
                />
                <span>Shortcuts</span>
              </span>
              <span className="font-mono text-[10px] text-neutral-500">⌘/</span>
            </button>
            <button
              type="button"
              onClick={onExport}
              className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-black/5 dark:hover:bg-white/10"
            >
              <Download
                className="h-3.5 w-3.5 text-neutral-500 dark:text-neutral-400"
                aria-hidden
              />
              <span>Export session</span>
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Transcript({
  status,
  finals,
  interims,
  privacyMode,
  compact = false,
  fill = false,
}: {
  status: Status;
  finals: TranscriptLine[];
  interims: Interims;
  privacyMode: boolean;
  /** Slim layout for embedded use inside the Listen panel. */
  compact?: boolean;
  /** Fills the parent column instead of using a fixed height (used in
   *  the side-by-side Listen layout where the column controls height). */
  fill?: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !pinned) return;
    el.scrollTop = el.scrollHeight;
  }, [finals, interims, pinned]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setPinned(distanceFromBottom <= AUTOSCROLL_THRESHOLD_PX);
  };

  const jumpToLatest = () => {
    setPinned(true);
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  };

  const empty = finals.length === 0 && !interims.interviewer && !interims.candidate;
  const emptyHeadline =
    status === 'idle' ? 'Press Start to listen' : status === 'paused' ? 'Paused' : 'Listening…';
  const emptyHint =
    status === 'idle'
      ? 'Play a video in any app and Friday will transcribe it here.'
      : status === 'paused'
        ? 'Hit Resume to keep transcribing.'
        : 'Waiting for the first words.';

  const glowTone = useMemo(() => {
    if (status === 'recording') return 'bg-sky-500/10 opacity-100 dark:bg-sky-400/10';
    if (status === 'paused') return 'bg-amber-400/10 opacity-80';
    return 'opacity-0';
  }, [status]);

  return (
    <div
      className={cn(
        'relative overflow-hidden rounded-xl',
        // In fill mode the outer wrapper must take the full height of its
        // parent column — otherwise the inner scroll div's `h-full` resolves
        // to the wrapper's intrinsic (content) height and nothing scrolls,
        // so newly-arriving transcript lines stack off the bottom edge.
        fill && 'flex h-full flex-col',
      )}
    >
      <div
        aria-hidden
        className={cn(
          'pointer-events-none absolute bottom-0 left-1/2 h-72 w-[60rem] -translate-x-1/2 rounded-full blur-3xl transition-opacity duration-500',
          glowTone,
        )}
      />
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className={cn(
          'relative z-10 overflow-y-auto scroll-smooth',
          fill ? 'min-h-0 flex-1 px-3 py-3' : compact ? 'h-[22vh] px-5 py-4' : 'h-[60vh] px-8 py-8',
        )}
      >
        <div
          className={cn(
            'mx-auto flex flex-col gap-4 tracking-normal',
            compact || fill
              ? 'max-w-[64ch] text-sm leading-snug'
              : 'max-w-[60ch] text-lg leading-relaxed',
          )}
        >
          {empty ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 py-16 text-center">
              <div
                className={cn(
                  'flex h-9 w-9 items-center justify-center rounded-full border',
                  status === 'recording'
                    ? 'border-sky-300 bg-sky-50 text-sky-600 dark:border-sky-500/40 dark:bg-sky-950/30 dark:text-sky-400'
                    : status === 'paused'
                      ? 'border-amber-300 bg-amber-50 text-amber-600 dark:border-amber-500/40 dark:bg-amber-950/30 dark:text-amber-400'
                      : 'border-neutral-300 bg-neutral-50 text-neutral-500 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-400',
                )}
                aria-hidden
              >
                <span
                  className={cn(
                    'inline-block h-2 w-2 rounded-full bg-current',
                    status === 'recording' && 'animate-pulse',
                  )}
                />
              </div>
              <p className="text-base font-medium text-neutral-700 dark:text-neutral-200">
                {emptyHeadline}
              </p>
              <p className="max-w-[36ch] text-sm text-neutral-500 dark:text-neutral-400">
                {emptyHint}
              </p>
            </div>
          ) : (
            <div
              role="log"
              aria-live="polite"
              className={cn('flex flex-col gap-3.5', privacyMode && 'select-none blur-md')}
            >
              {groupTurns(finals, interims).map((turn, i) => (
                <TranscriptTurn key={i} turn={turn} />
              ))}
            </div>
          )}
        </div>
      </div>
      {privacyMode ? (
        <div className="pointer-events-none absolute inset-x-6 top-6 z-20 rounded-lg border border-neutral-200/80 bg-white/85 px-3 py-2 text-xs font-medium text-neutral-700 shadow-sm backdrop-blur dark:border-neutral-800/80 dark:bg-neutral-900/85 dark:text-neutral-200">
          Stealth mode is on. Transcript content is masked in this window.
        </div>
      ) : null}
      {!pinned ? (
        <button
          type="button"
          onClick={jumpToLatest}
          className="absolute bottom-4 left-1/2 z-20 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-neutral-300 bg-white/90 px-3 py-1.5 text-xs font-medium text-neutral-700 shadow-md backdrop-blur transition-colors hover:bg-white dark:border-neutral-700 dark:bg-neutral-900/90 dark:text-neutral-200 dark:hover:bg-neutral-900"
        >
          <svg viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5" aria-hidden>
            <path
              fillRule="evenodd"
              d="M10 3a.75.75 0 0 1 .75.75v10.69l3.97-3.97a.75.75 0 1 1 1.06 1.06l-5.25 5.25a.75.75 0 0 1-1.06 0l-5.25-5.25a.75.75 0 1 1 1.06-1.06l3.97 3.97V3.75A.75.75 0 0 1 10 3Z"
              clipRule="evenodd"
            />
          </svg>
        </button>
      ) : null}
    </div>
  );
}

/** Consecutive lines from one speaker, plus that speaker's live partial. */
interface Turn {
  speaker: TranscriptSource;
  lines: TranscriptLine[];
  partial: string;
}

/** Group finals into speaker turns and attach each live partial to the
 *  speaker's trailing turn (or a new one if someone else spoke last). Lines
 *  without a source (single-stream sessions) count as the interviewer. */
function groupTurns(finals: TranscriptLine[], interims: Interims): Turn[] {
  const turns: Turn[] = [];
  for (const line of finals) {
    const speaker: TranscriptSource = line.source ?? 'interviewer';
    const last = turns[turns.length - 1];
    if (last && last.speaker === speaker) last.lines.push(line);
    else turns.push({ speaker, lines: [line], partial: '' });
  }
  for (const speaker of ['interviewer', 'candidate'] as const) {
    const partial = interims[speaker];
    if (!partial) continue;
    const last = turns[turns.length - 1];
    if (last && last.speaker === speaker) last.partial = partial;
    else turns.push({ speaker, lines: [], partial });
  }
  return turns;
}

function TranscriptTurn({ turn }: { turn: Turn }) {
  const isCandidate = turn.speaker === 'candidate';
  const asked = turn.lines.some((l) => l.asked);
  return (
    <section className={cn(isCandidate && 'pl-4')}>
      <header className="mb-1 flex items-baseline justify-between gap-2 text-[11px] font-medium">
        <span className="text-neutral-500 dark:text-neutral-400">
          {isCandidate ? 'You' : 'Interviewer'}
        </span>
        {asked ? <span className="text-sky-600 dark:text-sky-400">Question</span> : null}
      </header>
      <div className="flex flex-col gap-1.5">
        {turn.lines.map((line, i) => (
          <p
            key={i}
            className={cn(
              isCandidate
                ? 'text-[0.92em] text-neutral-500 dark:text-neutral-400'
                : cn(
                    'border-l-2 pl-2.5',
                    line.asked
                      ? 'border-sky-500 text-neutral-950 dark:border-sky-400 dark:text-white'
                      : 'border-neutral-300 text-neutral-800 dark:border-neutral-700 dark:text-neutral-200',
                  ),
            )}
          >
            {line.text}
          </p>
        ))}
        {turn.partial ? (
          <p
            className={cn(
              'italic',
              isCandidate
                ? 'text-[0.92em] text-neutral-400 dark:text-neutral-500'
                : 'border-l-2 border-sky-300/60 pl-2.5 text-sky-700 dark:border-sky-400/40 dark:text-sky-300',
            )}
          >
            {turn.partial}
            <span className="ml-1 inline-block animate-pulse motion-reduce:animate-none">▍</span>
          </p>
        ) : null}
      </div>
    </section>
  );
}
