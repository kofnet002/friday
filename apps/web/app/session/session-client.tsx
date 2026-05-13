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
  ShieldAlert,
  ShieldCheck,
  Square,
} from 'lucide-react';
import type {
  AnswerMessage,
  AnswerProvider,
  AnswerServerMessage,
  CodingLanguage,
  CodingSolutionServerMessage,
  ExtractedProblem,
  QAHistoryRow,
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
  getCodingLanguagePreference,
  getOrCreateSessionId,
  getProviderPreference,
  patchSessionProvider,
  sessionExportUrl,
  setCodingLanguagePreference,
  setProviderPreference,
  type SessionUsageSummary,
} from '@/lib/session-context';
import { TranscribeWs } from '@/lib/transcribe-ws';
import { cn } from '@/lib/utils';

import { SetupForm } from '../setup/setup-form';
import { AnswerPanel, type AnswerStatus } from './answer-panel';
import { CodingPanel, type CodingProblemTab } from './coding-panel';
import { FeatureBar, SECONDARY_FEATURES, getFeatureWidth, type FeatureKey } from './feature-bar';
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
}

const AUTOSCROLL_THRESHOLD_PX = 48;
// Force-ask (⌘⇧Space) sends the last N finalized transcript chunks to the
// copilot. The interviewer's question often isn't the *last* thing said —
// they ask, then keep narrating. Keep this window wide enough that the
// question is included; the prompt instructs the LLM to extract it.
const RECENT_FINALS_JOIN = 8;

export function SessionClient() {
  const [sessionId, setSessionIdState] = useState<string>('');
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [finals, setFinals] = useState<string[]>([]);
  const [interim, setInterim] = useState<string>('');

  // Answer panel state — every ask appends a new AnswerEntry; the panel
  // displays entries[entryIndex] and the chevrons step the index. The
  // currently-streaming entry is tracked separately via streamingIdRef so
  // tokens always land on the right entry even if the user navigates away
  // while the LLM is still streaming.
  const [provider, setProvider] = useState<AnswerProvider>('gemini');
  const [entries, setEntries] = useState<AnswerEntry[]>([]);
  const [entryIndex, setEntryIndex] = useState(-1);
  const [panelError, setPanelError] = useState<string | null>(null);
  const [answerConnected, setAnswerConnected] = useState(false);
  const streamingIdRef = useRef<string | null>(null);

  // Coding panel state
  const [codingActive, setCodingActive] = useState(false);
  const [codingLanguage, setCodingLanguage] = useState<CodingLanguage>('Python');
  const [codingTabs, setCodingTabs] = useState<CodingProblemTab[]>([]);
  const [activeFingerprint, setActiveFingerprint] = useState<string | null>(null);
  const [codingFrame, setCodingFrame] = useState<{
    changed_bits: number;
    interval_ms: number;
  } | null>(null);
  const [codingError, setCodingError] = useState<string | null>(null);
  const [codingConnected, setCodingConnected] = useState(false);

  // Active feature popover (null = no popover open, transcript visible behind)
  const [activeFeature, setActiveFeature] = useState<FeatureKey | null>(null);

  // Recording timer
  const [elapsedMs, setElapsedMs] = useState(0);
  const recordingStartRef = useRef<number | null>(null);

  // Modals + history
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [history, setHistory] = useState<QAHistoryRow[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [usage, setUsage] = useState<SessionUsageSummary | null>(null);
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
  const finalsRef = useRef<string[]>([]);
  const providerRef = useRef<AnswerProvider>('gemini');
  const codingLanguageRef = useRef<CodingLanguage>('Python');
  const activeFingerprintRef = useRef<string | null>(null);
  const codingTabsRef = useRef<CodingProblemTab[]>([]);
  const toastTimerRef = useRef<number | null>(null);
  const shieldRef = useRef<HTMLDivElement>(null);
  const entriesRef = useRef<AnswerEntry[]>([]);

  finalsRef.current = finals;
  providerRef.current = provider;
  codingLanguageRef.current = codingLanguage;
  activeFingerprintRef.current = activeFingerprint;
  codingTabsRef.current = codingTabs;
  entriesRef.current = entries;

  const currentEntry = entryIndex >= 0 && entryIndex < entries.length ? entries[entryIndex] : null;

  const inElectron = typeof window !== 'undefined' && Boolean(window.friday);

  // On mount: resolve session_id and provider pref, then open the answer WS.
  useEffect(() => {
    const sid = getOrCreateSessionId();
    setSessionIdState(sid);
    setProvider(getProviderPreference());
    setCodingLanguage(getCodingLanguagePreference());

    const ws = new AnswerWs(sid, {
      onMessage: onAnswerMessage,
      onOpen: () => setAnswerConnected(true),
      onClose: () => setAnswerConnected(false),
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
      const id = streamingIdRef.current;
      if (!id) return;
      if (msg.type === 'started') {
        // Reset the pending assistant turn — askAnswer/followUp already
        // appended an empty {role:'assistant', content:''} placeholder to
        // messages, so we just clear it here. error/marked reset belongs on
        // the entry (thread-level) not the turn.
        updateEntry(id, (e) => ({
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
        updateEntry(id, (e) => {
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
        updateEntry(id, { status: 'done' });
        streamingIdRef.current = null;
        return;
      }
      if (msg.type === 'cancelled') {
        updateEntry(id, { status: 'cancelled' });
        streamingIdRef.current = null;
        return;
      }
      if (msg.type === 'error') {
        updateEntry(id, { status: 'error', error: msg.message });
        streamingIdRef.current = null;
      }
    },
    [updateEntry],
  );

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
    if (msg.type === 'transcript') {
      handleTranscript(msg);
      return;
    }
    if (msg.type === 'question_detected') {
      // The backend detector can fire multiple times for the same
      // question while the speaker keeps talking — the recent transcript
      // window still contains the question, the model still sees it as
      // a question. Skip if it matches the latest entry's question (a
      // shallow normalized compare) so we don't create stuck duplicates.
      const norm = msg.question.trim().toLowerCase();
      const last = entriesRef.current[entriesRef.current.length - 1];
      if (last && last.question.trim().toLowerCase() === norm) return;
      askAnswer(msg.question, { autoDetected: true });
      setActiveFeature('listen');
    }
  }, []);

  // ─── coding mode ──────────────────────────────────────────────────────────
  const updateTab = (fingerprint: string, updater: (tab: CodingProblemTab) => CodingProblemTab) => {
    setCodingTabs((prev) => prev.map((t) => (t.fingerprint === fingerprint ? updater(t) : t)));
  };

  const onCodingSolutionMessage = useCallback((msg: CodingSolutionServerMessage) => {
    // Problem-detected events are pushed from /api/vision/extract via
    // session_bus and arrive on this socket (it's always open while /session
    // is mounted, unlike /ws/transcribe which requires Start).
    if (msg.type === 'coding_problem_detected') {
      onCodingProblemDetected(msg.problem, msg.fingerprint);
      return;
    }
    if (msg.type === 'saved') {
      updateTab(msg.fingerprint, (t) => ({ ...t, savedId: msg.id }));
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

  const requestSolve = (fingerprint: string, problem: ExtractedProblem, lang: CodingLanguage) => {
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
    });
    updateTab(fingerprint, (t) => ({
      ...t,
      language: lang,
      solution: '',
      status: 'streaming',
      error: null,
    }));
  };

  const onCodingProblemDetected = (problem: ExtractedProblem, fingerprint: string) => {
    setCodingError(null);
    const lang = codingLanguageRef.current;
    setCodingTabs((prev) => {
      const existing = prev.find((t) => t.fingerprint === fingerprint);
      if (existing) {
        return prev.map((t) => (t.fingerprint === fingerprint ? { ...t, problem } : t));
      }
      const tab: CodingProblemTab = {
        fingerprint,
        problem,
        language: lang,
        solution: '',
        status: 'streaming',
        error: null,
        savedId: null,
      };
      const next = [...prev, tab];
      return next.length > MAX_CODING_TABS ? next.slice(-MAX_CODING_TABS) : next;
    });
    setActiveFingerprint(fingerprint);
    setActiveFeature('coding');
    // Auto-kick off the solve.
    const ws = codingWsRef.current;
    if (ws && ws.isOpen()) {
      ws.send({ type: 'solve', problem, language: lang, provider: providerRef.current });
    }
  };

  const handleTranscript = (event: TranscriptEvent) => {
    if (lastSendAtRef.current > 0) {
      setLatencyMs(Math.max(0, performance.now() - lastSendAtRef.current));
    }
    if (event.is_final) {
      setFinals((prev) => [...prev, event.text]);
      setInterim('');
    } else {
      setInterim(event.text);
    }
  };

  const cancelInFlight = () => {
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

  const askAnswer = (q: string, opts: { autoDetected?: boolean } = {}) => {
    const ws = answerRef.current;
    if (!ws || !ws.isOpen()) {
      setPanelError('copilot WS not connected');
      return;
    }
    // Cancel any in-flight stream before starting a new thread — tokens
    // route by streamingIdRef so otherwise the old entry would hang in
    // status='streaming' forever.
    cancelInFlight();
    const id = newId();
    const threadId = newId();
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
    };
    setPanelError(null);
    setEntries((prev) => {
      const next = [...prev, entry];
      // Auto-jump to the new entry — the user just asked and wants to see
      // the answer. They can chevron back to older ones afterward.
      setEntryIndex(next.length - 1);
      return next;
    });
    streamingIdRef.current = id;
    ws.send({
      type: 'question',
      messages: [{ role: 'user', content: q }],
      thread_id: threadId,
      provider: providerRef.current,
      auto_detected: opts.autoDetected,
    });
  };

  const followUp = (q: string) => {
    const ws = answerRef.current;
    if (!ws || !ws.isOpen()) {
      setPanelError('copilot WS not connected');
      return;
    }
    const current = entriesRef.current[entryIndex];
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
      // Send the full thread minus the trailing empty assistant placeholder
      // so the backend sees user/assistant/user… with the new turn last.
      messages: nextMessages.slice(0, -1),
      thread_id: current.threadId,
      provider: providerRef.current,
    });
  };

  // ─── transcribe lifecycle ──────────────────────────────────────────────────
  const start = async () => {
    setError(null);
    setStatus('starting');
    setLatencyMs(null);

    const ws = new TranscribeWs({
      onMessage: onTranscribeMessage,
      onOpen: () => ws.sendControl({ type: 'start' }),
      onClose: () => setStatus((prev) => (prev === 'error' ? prev : 'idle')),
      onError: () => {
        setError('WebSocket error');
        setStatus('error');
      },
    });
    ws.connect();
    transcribeRef.current = ws;

    if (!inElectron || !window.friday) {
      setError('Audio capture is only available inside the Friday desktop window.');
      setStatus('error');
      return;
    }
    const result = await window.friday.audio.start();
    if (!result.ok) {
      setError(result.error ?? 'audio start failed');
      setStatus('error');
      return;
    }

    const offFrame = window.friday.audio.onFrame((chunk) => {
      lastSendAtRef.current = performance.now();
      transcribeRef.current?.sendAudio(chunk);
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
    // Pop the Listen panel as soon as we start capturing so the user can
    // see transcript + answers without an extra click.
    setActiveFeature('listen');
  };

  const teardownAudioListeners = () => {
    for (const off of audioUnsubsRef.current) off();
    audioUnsubsRef.current = [];
  };

  const closeListenIfOpen = () => {
    setActiveFeature((prev) => (prev === 'listen' ? null : prev));
  };

  const stop = async () => {
    teardownAudioListeners();
    if (inElectron && window.friday) {
      await window.friday.audio.stop();
    }
    transcribeRef.current?.close();
    transcribeRef.current = null;
    setStatus('idle');
    closeListenIfOpen();
  };

  const pause = async () => {
    if (inElectron && window.friday) await window.friday.audio.pause();
    transcribeRef.current?.sendControl({ type: 'pause' });
    setStatus('paused');
    closeListenIfOpen();
  };

  const resume = async () => {
    if (inElectron && window.friday) await window.friday.audio.resume();
    transcribeRef.current?.sendControl({ type: 'start' });
    setStatus('recording');
  };

  const clearTranscript = () => {
    setFinals([]);
    setInterim('');
    setLatencyMs(null);
  };

  // Removes the currently-displayed entry from the in-memory list. If it's
  // the streaming one, also tells the WS to cancel so the server stops
  // generating tokens we'd just throw away.
  const clearAnswer = () => {
    if (entryIndex < 0) return;
    const removed = entries[entryIndex];
    if (removed && streamingIdRef.current === removed.id) {
      answerRef.current?.cancel();
      streamingIdRef.current = null;
    }
    setEntries((prev) => {
      const next = prev.filter((_, i) => i !== entryIndex);
      // Keep the user on the nearest neighbor (previous entry if there is
      // one, otherwise the new tail; -1 if the list is now empty).
      setEntryIndex(next.length === 0 ? -1 : Math.min(entryIndex, next.length - 1));
      return next;
    });
  };

  const cancelAnswer = () => {
    answerRef.current?.cancel();
  };

  const onMarkAnswered = () => {
    const current = entryIndex >= 0 ? entries[entryIndex] : null;
    if (!current) return;
    updateEntry(current.id, { marked: !current.marked });
  };

  const onReask = () => {
    const current = entryIndex >= 0 ? entries[entryIndex] : null;
    if (!current?.question) return;
    askAnswer(current.question);
  };

  const goPrev = () => {
    setEntryIndex((i) => Math.max(0, i - 1));
  };

  const goNext = () => {
    setEntryIndex((i) => Math.min(entries.length - 1, i + 1));
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

  const submitCustom = (q: string) => askAnswer(q);

  // ─── hotkeys: ⌘⇧␣ (force-ask) and ⌘⇧C (toggle coding mode) ────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!e.metaKey || !e.shiftKey) return;
      if (e.code === 'Space' || e.key === ' ') {
        e.preventDefault();
        const recent = finalsRef.current.slice(-RECENT_FINALS_JOIN).join(' ').trim();
        if (recent) {
          askAnswer(recent);
          setActiveFeature('listen');
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

  const toggleCodingMode = async () => {
    const fridayApi = window.friday;
    if (!fridayApi?.coding) {
      setCodingError('Coding mode only works inside the Friday desktop window.');
      return;
    }
    if (codingActive) {
      await fridayApi.coding.stop();
      for (const off of codingUnsubsRef.current) off();
      codingUnsubsRef.current = [];
      setCodingActive(false);
      setCodingFrame(null);
      return;
    }
    const sid = getOrCreateSessionId();
    const result = await fridayApi.coding.start(sid);
    if (!result.ok) {
      setCodingError(result.error ?? 'failed to start coding capture');
      return;
    }
    // Push the renderer's currently-selected provider into the desktop
    // capture so the very first vision/extract uses the user's pick.
    void fridayApi.coding.setProvider?.(providerRef.current);
    setCodingError(null);
    const offFrame = fridayApi.coding.onFrameProcessed((info) => {
      setCodingFrame({ changed_bits: info.changed_bits, interval_ms: info.interval_ms });
    });
    const offExt = fridayApi.coding.onExtractionResult((payload) => {
      // The real "problem detected" pathway is the transcribe WS event; this
      // callback is purely informational (e.g., for debugging cache hits).
      if (!payload.emitted && payload.problem?.is_coding_problem === false) {
        // No-op: ignore non-problem frames.
      }
    });
    const offErr = fridayApi.coding.onError((msg) => setCodingError(msg));
    codingUnsubsRef.current = [offFrame, offExt, offErr];
    setCodingActive(true);
  };

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
    if (data) setUsage(data);
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

  const renderFeatureContent = (key: FeatureKey) => {
    if (key === 'setup') {
      return <SetupForm onComplete={() => setActiveFeature(null)} />;
    }
    if (key === 'listen') {
      return (
        <PanelErrorBoundary label="Listen">
          <AnswerPanel
            provider={provider}
            onProviderChange={onProviderChange}
            question={currentEntry?.question ?? null}
            answer={currentEntry?.answer ?? ''}
            messages={currentEntry?.messages ?? []}
            status={currentEntry?.status ?? 'idle'}
            error={currentEntry?.error ?? panelError}
            marked={Boolean(currentEntry?.marked)}
            onMarkAnswered={onMarkAnswered}
            onCancel={cancelAnswer}
            onClear={clearAnswer}
            onReask={onReask}
            entryIndex={entries.length === 0 ? 0 : entryIndex + 1}
            entryCount={entries.length}
            onPrev={goPrev}
            onNext={goNext}
            onSubmitCustom={submitCustom}
            onFollowUp={followUp}
            connected={answerConnected}
            privacyMode={privacyMode}
            transcriptSlot={
              <Transcript
                status={status}
                finals={finals}
                interim={interim}
                privacyMode={privacyMode}
                fill
              />
            }
          />
        </PanelErrorBoundary>
      );
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
            tabs={codingTabs}
            activeFingerprint={activeFingerprint}
            onSelectTab={setActiveFingerprint}
            onCloseTab={onCloseCodingTab}
            onClearAll={onClearAllCodingTabs}
            onRegenerate={onCodingRegenerate}
            onReExtract={onCodingReExtract}
            onCancel={onCodingCancel}
            frameInfo={codingFrame}
            error={codingError}
            privacyMode={privacyMode}
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
                <span
                  className={cn(
                    'absolute inline-flex h-full w-full rounded-full opacity-75',
                    isRecording ? 'animate-ping bg-red-400' : 'bg-transparent',
                  )}
                />
                <span
                  className={cn(
                    'relative inline-flex h-2 w-2 rounded-full',
                    isRecording
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
                  onChange={(next) => {
                    // AI Help doubles as the start-listening CTA when idle —
                    // there's no separate Listen button on the bar anymore.
                    if (next === 'listen' && status === 'idle') {
                      start();
                    }
                    setActiveFeature(next);
                  }}
                  badges={{
                    listen:
                      entries.some((e) => e.status === 'streaming') ||
                      (isLive && (finals.length > 0 || Boolean(interim))),
                    coding: codingTabs.some((t) => t.status === 'streaming'),
                  }}
                />
              </>
            ) : null}

            {/* Capture cluster — appears only while live (timer + pause + stop)
                or briefly during the starting handshake. AI Help is the start
                CTA when idle, so this slot is empty in the resting state. */}
            {status !== 'idle' ? (
              <>
                <ClusterDivider />
                <CaptureCluster
                  status={status}
                  elapsedDisplay={elapsedDisplay}
                  onPause={pause}
                  onResume={resume}
                  onStop={stop}
                />
              </>
            ) : null}

            {/* Trailing trio: ⋮ overflow · ✥ move · ^ collapse */}
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
              usage={usage}
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
            />

            {/* Drag handle — the entire .session-bar already has
                -webkit-app-region:drag, so this is purely an affordance.
                Kept as a non-button span so the drag region applies; matched
                visually to the overflow/collapse buttons either side of it. */}
            <span
              role="presentation"
              aria-label="Drag to move"
              title="Drag to move"
              className="flex h-7 w-7 cursor-grab items-center justify-center rounded-md text-neutral-500 transition-colors hover:bg-white/60 hover:text-neutral-800 active:cursor-grabbing dark:text-neutral-400 dark:hover:bg-white/10 dark:hover:text-neutral-100"
            >
              <Move className="h-3.5 w-3.5" aria-hidden />
            </span>

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
              className={cn(
                'pointer-events-auto z-50 resize overflow-auto rounded-2xl border border-white/40 bg-white/85 p-5 shadow-[0_24px_60px_rgba(15,23,42,0.18)] backdrop-blur-2xl backdrop-saturate-150',
                'h-[68vh] min-h-[20rem] min-w-[24rem] max-h-[92vh]',
                'data-[state=open]:animate-in data-[state=closed]:animate-out',
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
      {!inElectron ? (
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
  elapsedDisplay,
  onPause,
  onResume,
  onStop,
}: {
  status: Status;
  elapsedDisplay: string;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
}) {
  const isRecording = status === 'recording';
  const isPaused = status === 'paused';
  const isLive = isRecording || isPaused;
  const isStarting = status === 'starting';

  if (!isLive) {
    // Idle: nothing here — AI Help is the entry point and starts the session
    // when clicked. We still surface a small "Starting…" indicator so the user
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
      aria-label={isRecording ? 'Listening' : 'Paused'}
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
        aria-label={isRecording ? 'Pause' : 'Resume'}
        title={isRecording ? 'Pause' : 'Resume'}
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
  usage,
  sessionId,
  activeSecondaryFeature,
  onSecondaryFeature,
  onClearTranscript,
  onShortcuts,
  onExport,
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
  usage: SessionUsageSummary | null;
  sessionId: string;
  activeSecondaryFeature: FeatureKey | null;
  onSecondaryFeature: (key: FeatureKey) => void;
  onClearTranscript: () => void;
  onShortcuts: () => void;
  onExport: () => void;
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
                <span className="text-neutral-600 dark:text-neutral-400">Latency</span>
                <LatencyBadge ms={latencyMs} />
              </div>
            ) : null}
            <div className="flex items-center justify-between gap-2">
              <span className="text-neutral-600 dark:text-neutral-400">Cost</span>
              <CostPill usage={usage} />
            </div>
            {sessionId ? (
              <div className="flex items-center justify-between gap-2">
                <span className="text-neutral-600 dark:text-neutral-400">Session</span>
                <span className="rounded-full bg-black/5 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-neutral-600 dark:bg-white/5 dark:text-neutral-300">
                  {sessionId.slice(0, 8)}
                </span>
              </div>
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
  interim,
  privacyMode,
  compact = false,
  fill = false,
}: {
  status: Status;
  finals: string[];
  interim: string;
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
  }, [finals, interim, pinned]);

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

  const empty = finals.length === 0 && !interim;
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
          fill
            ? 'min-h-0 flex-1 px-4 pb-4 pt-8'
            : compact
              ? 'h-[22vh] px-5 py-4'
              : 'h-[60vh] px-8 py-8',
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
            <div className={cn(privacyMode && 'select-none blur-sm')}>
              {finals.map((text, idx) => (
                <p
                  key={idx}
                  className="text-neutral-900 transition-opacity duration-200 dark:text-neutral-100"
                >
                  {text}
                </p>
              ))}
              {interim ? (
                <p className="italic text-sky-600 dark:text-sky-300">
                  {interim}
                  <span className="ml-1 inline-block animate-pulse">▍</span>
                </p>
              ) : null}
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
