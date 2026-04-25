'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import type {
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
import { AnswerWs } from '@/lib/answer-ws';
import { CodingWs } from '@/lib/coding-ws';
import {
  fetchSessionDetail,
  getCodingLanguagePreference,
  getOrCreateSessionId,
  getProviderPreference,
  sessionExportUrl,
  setCodingLanguagePreference,
  setProviderPreference,
} from '@/lib/session-context';
import { TranscribeWs } from '@/lib/transcribe-ws';
import { cn } from '@/lib/utils';

import { AnswerPanel, type AnswerStatus } from './answer-panel';
import { CodingPanel, type CodingProblemTab } from './coding-panel';
import { ConnectionPill, HistoryModal, ShortcutsModal } from './session-modals';

const MAX_CODING_TABS = 3;

type Status = 'idle' | 'starting' | 'recording' | 'paused' | 'error';

const AUTOSCROLL_THRESHOLD_PX = 48;
const RECENT_FINALS_JOIN = 2;

export function SessionClient() {
  const [sessionId, setSessionIdState] = useState<string>('');
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [finals, setFinals] = useState<string[]>([]);
  const [interim, setInterim] = useState<string>('');

  // Answer panel state
  const [provider, setProvider] = useState<AnswerProvider>('gemini');
  const [question, setQuestion] = useState<string | null>(null);
  const [answer, setAnswer] = useState<string>('');
  const [answerStatus, setAnswerStatus] = useState<AnswerStatus>('idle');
  const [answerError, setAnswerError] = useState<string | null>(null);
  const [marked, setMarked] = useState(false);
  const [answerConnected, setAnswerConnected] = useState(false);

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

  // Modals + history
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<QAHistoryRow[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

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

  finalsRef.current = finals;
  providerRef.current = provider;
  codingLanguageRef.current = codingLanguage;
  activeFingerprintRef.current = activeFingerprint;
  codingTabsRef.current = codingTabs;

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

  // ─── answer WS message handling ────────────────────────────────────────────
  const onAnswerMessage = useCallback((msg: AnswerServerMessage) => {
    if (msg.type === 'started') {
      setAnswer('');
      setAnswerError(null);
      setMarked(false);
      setAnswerStatus('streaming');
      return;
    }
    if (msg.type === 'token') {
      setAnswer((prev) => prev + msg.text);
      return;
    }
    if (msg.type === 'done') {
      setAnswerStatus('done');
      return;
    }
    if (msg.type === 'cancelled') {
      setAnswerStatus('cancelled');
      return;
    }
    if (msg.type === 'error') {
      setAnswerError(msg.message);
      setAnswerStatus('error');
    }
  }, []);

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
      askAnswer(msg.question);
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

  const askAnswer = (q: string) => {
    const ws = answerRef.current;
    if (!ws || !ws.isOpen()) {
      setAnswerError('copilot WS not connected');
      return;
    }
    setQuestion(q);
    setAnswer('');
    setAnswerError(null);
    setMarked(false);
    setAnswerStatus('streaming');
    ws.send({ type: 'question', question: q, provider: providerRef.current });
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
  };

  const teardownAudioListeners = () => {
    for (const off of audioUnsubsRef.current) off();
    audioUnsubsRef.current = [];
  };

  const stop = async () => {
    teardownAudioListeners();
    if (inElectron && window.friday) {
      await window.friday.audio.stop();
    }
    transcribeRef.current?.close();
    transcribeRef.current = null;
    setStatus('idle');
  };

  const pause = async () => {
    if (inElectron && window.friday) await window.friday.audio.pause();
    transcribeRef.current?.sendControl({ type: 'pause' });
    setStatus('paused');
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

  const clearAnswer = () => {
    setAnswer('');
    setQuestion(null);
    setAnswerError(null);
    setMarked(false);
    setAnswerStatus('idle');
  };

  const cancelAnswer = () => {
    answerRef.current?.cancel();
  };

  const onProviderChange = (p: AnswerProvider) => {
    setProvider(p);
    setProviderPreference(p);
  };

  const submitCustom = (q: string) => askAnswer(q);

  // ─── hotkeys: ⌘⇧␣ (force-ask) and ⌘⇧C (toggle coding mode) ────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!e.metaKey || !e.shiftKey) return;
      if (e.code === 'Space' || e.key === ' ') {
        e.preventDefault();
        const recent = finalsRef.current.slice(-RECENT_FINALS_JOIN).join(' ').trim();
        if (recent) askAnswer(recent);
        else setAnswerError('no transcript yet');
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

  const openHistory = () => {
    setHistoryOpen(true);
    refreshHistory();
  };

  const exportSession = () => {
    if (!sessionId) return;
    window.open(sessionExportUrl(sessionId), '_blank');
  };

  // Refresh history once any answer stream completes (best-effort; small fetch).
  useEffect(() => {
    if (answerStatus === 'done') {
      refreshHistory();
    }
  }, [answerStatus, refreshHistory]);

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

  const isRecording = status === 'recording';
  const isPaused = status === 'paused';
  const isLive = isRecording || isPaused;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-neutral-200 bg-white/70 p-3 shadow-sm backdrop-blur dark:border-neutral-800 dark:bg-neutral-900/60">
        <StatusPill status={status} />
        <div className="flex gap-2">
          {!isLive ? (
            <Button onClick={start} disabled={status === 'starting'}>
              {status === 'starting' ? 'Starting…' : 'Start'}
            </Button>
          ) : null}
          {isRecording ? (
            <Button onClick={pause} variant="outline">
              Pause
            </Button>
          ) : null}
          {isPaused ? <Button onClick={resume}>Resume</Button> : null}
          {isLive ? (
            <Button onClick={stop} variant="outline">
              Stop
            </Button>
          ) : null}
          <Button onClick={clearTranscript} variant="ghost">
            Clear transcript
          </Button>
          <Button
            onClick={toggleCodingMode}
            variant={codingActive ? 'outline' : 'default'}
            size="sm"
          >
            {codingActive ? 'Stop coding' : 'Coding mode'}
          </Button>
          <Button onClick={openHistory} variant="ghost" size="sm">
            History
          </Button>
          <Button onClick={exportSession} variant="ghost" size="sm">
            Export
          </Button>
          <Button onClick={() => setShortcutsOpen(true)} variant="ghost" size="sm">
            ⌘/
          </Button>
        </div>
        <div className="ml-auto flex items-center gap-3 text-xs">
          <ConnectionPill
            transcribe={
              status === 'recording' || status === 'paused'
                ? 'live'
                : status === 'error'
                  ? 'error'
                  : 'idle'
            }
            answer={answerConnected}
            coding={codingConnected}
          />
          <LatencyBadge ms={latencyMs} />
          {sessionId ? (
            <span className="font-mono text-neutral-500">session: {sessionId.slice(0, 8)}</span>
          ) : null}
        </div>
      </div>

      {!inElectron ? (
        <div className="rounded-md border border-amber-400/50 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-500/30 dark:bg-amber-950/40 dark:text-amber-200">
          Open this page from the Friday desktop window — system-audio capture isn't available in a
          regular browser tab.
        </div>
      ) : null}

      {error ? (
        <div className="rounded-md border border-red-400/50 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </div>
      ) : null}

      <div className="min-h-[60vh] flex-1">
        <PanelGroup direction="horizontal" autoSaveId="friday-session-layout">
          <Panel defaultSize={25} minSize={18} className="pr-2">
            <Transcript status={status} finals={finals} interim={interim} />
          </Panel>
          <PanelResizeHandle className="w-1 cursor-col-resize bg-neutral-200 transition-colors hover:bg-sky-400 dark:bg-neutral-800" />
          <Panel defaultSize={45} minSize={28} className="px-2">
            <AnswerPanel
              provider={provider}
              onProviderChange={onProviderChange}
              question={question}
              answer={answer}
              status={answerStatus}
              error={answerError}
              marked={marked}
              onMarkAnswered={() => setMarked((m) => !m)}
              onCancel={cancelAnswer}
              onClear={clearAnswer}
              onSubmitCustom={submitCustom}
              connected={answerConnected}
            />
          </Panel>
          <PanelResizeHandle className="w-1 cursor-col-resize bg-neutral-200 transition-colors hover:bg-sky-400 dark:bg-neutral-800" />
          <Panel defaultSize={30} minSize={0} collapsible collapsedSize={0} className="pl-2">
            <CodingPanel
              active={codingActive}
              onToggle={toggleCodingMode}
              language={codingLanguage}
              onLanguageChange={onCodingLanguageChange}
              provider={provider}
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
            />
          </Panel>
        </PanelGroup>
      </div>

      <ShortcutsModal open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
      <HistoryModal
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        qa={history}
        loading={historyLoading}
      />
    </div>
  );
}

function StatusPill({ status }: { status: Status }) {
  const preset = {
    idle: {
      label: 'IDLE',
      dot: 'bg-neutral-400',
      wrap: 'bg-neutral-200/60 text-neutral-600 dark:bg-neutral-800/80 dark:text-neutral-400',
    },
    starting: {
      label: 'STARTING',
      dot: 'animate-pulse bg-sky-500',
      wrap: 'bg-sky-500/10 text-sky-600 dark:text-sky-400',
    },
    recording: {
      label: 'REC',
      dot: 'animate-pulse bg-red-500',
      wrap: 'bg-red-500/10 text-red-600 dark:text-red-400',
    },
    paused: {
      label: 'PAUSED',
      dot: 'bg-amber-500',
      wrap: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
    },
    error: {
      label: 'ERROR',
      dot: 'bg-red-600',
      wrap: 'bg-red-600/10 text-red-700 dark:text-red-400',
    },
  }[status];

  return (
    <div
      className={cn(
        'flex items-center gap-2 rounded-full px-3 py-1 text-[11px] font-semibold tracking-[0.15em]',
        preset.wrap,
      )}
    >
      <span className={cn('h-2 w-2 rounded-full', preset.dot)} />
      {preset.label}
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

function Transcript({
  status,
  finals,
  interim,
}: {
  status: Status;
  finals: string[];
  interim: string;
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
  const placeholder =
    status === 'idle'
      ? 'Press Start — play a video in any app and Friday will transcribe it here.'
      : status === 'paused'
        ? 'Paused. Hit Resume to keep transcribing.'
        : 'Listening…';

  const glowTone = useMemo(() => {
    if (status === 'recording') return 'bg-sky-500/10 opacity-100 dark:bg-sky-400/10';
    if (status === 'paused') return 'bg-amber-400/10 opacity-80';
    return 'opacity-0';
  }, [status]);

  return (
    <div className="relative overflow-hidden rounded-2xl border border-neutral-200 bg-gradient-to-b from-white via-neutral-50 to-white shadow-inner dark:border-neutral-800 dark:from-neutral-950 dark:via-neutral-900 dark:to-neutral-950">
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
        className="relative z-10 h-[60vh] overflow-y-auto scroll-smooth px-8 py-8"
      >
        <div className="mx-auto flex max-w-[60ch] flex-col gap-4 text-lg leading-relaxed tracking-normal">
          {empty ? (
            <p className="text-center text-sm text-neutral-400 dark:text-neutral-600">
              {placeholder}
            </p>
          ) : (
            <>
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
            </>
          )}
        </div>
      </div>
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
          Jump to latest
        </button>
      ) : null}
    </div>
  );
}
