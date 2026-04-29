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
  Download,
  Eraser,
  Keyboard,
  Pause,
  Play,
  ShieldAlert,
  ShieldCheck,
  Square,
} from 'lucide-react';
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
import { PanelErrorBoundary } from '@/components/error-boundary';
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

import { SetupForm } from '../setup/setup-form';
import { AnswerPanel, type AnswerStatus } from './answer-panel';
import { CodingPanel, type CodingProblemTab } from './coding-panel';
import { FeatureBar, getFeatureWidth, type FeatureKey } from './feature-bar';
import {
  ConnectionPill,
  HistoryList,
  ModalShell,
  SettingsBody,
  ShortcutsModal,
} from './session-modals';

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

  // Active feature popover (null = no popover open, transcript visible behind)
  const [activeFeature, setActiveFeature] = useState<FeatureKey | null>(null);

  // Recording timer
  const [elapsedMs, setElapsedMs] = useState(0);
  const recordingStartRef = useRef<number | null>(null);

  // Modals + history
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [history, setHistory] = useState<QAHistoryRow[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [desktopStatus, setDesktopStatus] = useState<FridayWindowStatus | null>(null);
  const [privacyMode, setPrivacyMode] = useState(false);
  const [desktopToast, setDesktopToast] = useState<string | null>(null);
  const [stealthMode, setStealthMode] = useState(false);
  const [shieldOpen, setShieldOpen] = useState(false);
  const [stealthDisableConfirmOpen, setStealthDisableConfirmOpen] = useState(false);

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
        if (recent) {
          askAnswer(recent);
          setActiveFeature('listen');
        } else {
          setAnswerError('no transcript yet');
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
          <div className="flex flex-col gap-3">
            <Transcript
              status={status}
              finals={finals}
              interim={interim}
              privacyMode={privacyMode}
              compact
            />
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
              privacyMode={privacyMode}
            />
          </div>
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
    <div className="mx-auto flex w-fit max-w-full flex-col items-center gap-2">
      {/* Top control bar — brand · status · capture+transcript · other features.
          Wrapped in a single Popover so all feature popovers anchor to the
          whole bar (centered underneath) rather than to each individual icon. */}
      <Popover.Root
        open={activeFeature !== null}
        onOpenChange={(open) => {
          if (!open) setActiveFeature(null);
        }}
      >
        <Popover.Anchor asChild>
          <div className="flex items-center gap-x-2 rounded-2xl border border-white/40 bg-white/55 px-3 py-2 shadow-[0_12px_36px_rgba(15,23,42,0.12)] backdrop-blur-2xl backdrop-saturate-150 dark:border-white/10 dark:bg-neutral-900/55 dark:shadow-[0_12px_36px_rgba(0,0,0,0.55)]">
            {/* Brand */}
            <span
              className="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-sm font-semibold text-neutral-800 dark:text-neutral-100"
              aria-label="Friday"
            >
              <span className="relative flex h-2 w-2">
                <span
                  className={cn(
                    'absolute inline-flex h-full w-full rounded-full opacity-75',
                    isRecording ? 'animate-ping bg-sky-400' : 'bg-transparent',
                  )}
                />
                <span
                  className={cn(
                    'relative inline-flex h-2 w-2 rounded-full',
                    isRecording
                      ? 'bg-sky-500'
                      : isPaused
                        ? 'bg-amber-500'
                        : 'bg-neutral-400 dark:bg-neutral-600',
                  )}
                />
              </span>
              Friday
            </span>

            <ClusterDivider />

            {/* Recording status with inline timer */}
            <div className="flex items-center gap-2">
              <StatusPill status={status} />
              <span
                className={cn(
                  'font-mono text-xs tabular-nums',
                  isLive
                    ? 'text-neutral-700 dark:text-neutral-200'
                    : 'text-neutral-400 dark:text-neutral-600',
                )}
                aria-label="elapsed time"
              >
                {elapsedDisplay}
              </span>
            </div>

            {/* Capture controls — icon-only when active, text on Start */}
            <div className="flex items-center gap-0.5">
              {!isLive ? (
                <Button onClick={start} disabled={status === 'starting'} size="sm">
                  <Play className="mr-1 h-3.5 w-3.5" aria-hidden />
                  {status === 'starting' ? 'Starting…' : 'Start'}
                </Button>
              ) : null}
              {isRecording ? (
                <Button
                  onClick={pause}
                  variant="outline"
                  size="sm"
                  aria-label="pause"
                  className="!px-2"
                >
                  <Pause className="h-3.5 w-3.5" aria-hidden />
                </Button>
              ) : null}
              {isPaused ? (
                <Button onClick={resume} size="sm" aria-label="resume" className="!px-2">
                  <Play className="h-3.5 w-3.5" aria-hidden />
                </Button>
              ) : null}
              {isLive ? (
                <Button
                  onClick={stop}
                  variant="outline"
                  size="sm"
                  aria-label="stop"
                  className="!px-2"
                >
                  <Square className="h-3.5 w-3.5" aria-hidden />
                </Button>
              ) : null}
            </div>

            <ClusterDivider />

            {/* Feature cluster — all features share one anchored popover */}
            <FeatureBar
              active={activeFeature}
              onChange={setActiveFeature}
              badges={{
                listen:
                  answerStatus === 'streaming' ||
                  (isLive && (finals.length > 0 || Boolean(interim))),
                coding: codingTabs.some((t) => t.status === 'streaming'),
              }}
            />
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
              className={cn(
                'z-50 max-h-[78vh] overflow-auto rounded-2xl border border-white/40 bg-white/85 p-5 shadow-[0_24px_60px_rgba(15,23,42,0.18)] backdrop-blur-2xl',
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

      {/* Utility row — sits centered beneath the main bar */}
      <div className="flex items-center gap-2 rounded-full border border-white/40 bg-white/55 px-3 py-1 text-[11px] shadow-[0_8px_24px_rgba(15,23,42,0.10)] backdrop-blur-2xl backdrop-saturate-150 dark:border-white/10 dark:bg-neutral-900/55 dark:shadow-[0_8px_24px_rgba(0,0,0,0.45)]">
        <StealthIndicator
          ref={shieldRef}
          desktopStatus={desktopStatus}
          stealthMode={stealthMode}
          open={shieldOpen}
          onToggle={() => setShieldOpen((value) => !value)}
        />
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
          <span className="rounded-full bg-white/60 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-neutral-600 dark:bg-white/5 dark:text-neutral-300">
            {sessionId.slice(0, 8)}
          </span>
        ) : null}
        <span aria-hidden className="h-3.5 w-px bg-neutral-300/50 dark:bg-white/10" />
        <button
          type="button"
          onClick={clearTranscript}
          aria-label="clear transcript"
          title="Clear transcript"
          className="rounded-md p-1 text-neutral-500 transition-colors hover:bg-white/60 hover:text-neutral-800 dark:text-neutral-400 dark:hover:bg-white/10 dark:hover:text-neutral-100"
        >
          <Eraser className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => setShortcutsOpen(true)}
          aria-label="keyboard shortcuts"
          title="Shortcuts (⌘/)"
          className="rounded-md p-1 text-neutral-500 transition-colors hover:bg-white/60 hover:text-neutral-800 dark:text-neutral-400 dark:hover:bg-white/10 dark:hover:text-neutral-100"
        >
          <Keyboard className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={exportSession}
          aria-label="export session"
          title="Export session"
          className="rounded-md p-1 text-neutral-500 transition-colors hover:bg-white/60 hover:text-neutral-800 dark:text-neutral-400 dark:hover:bg-white/10 dark:hover:text-neutral-100"
        >
          <Download className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Banners */}
      {!inElectron ? (
        <div className="rounded-md border border-amber-400/50 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-500/30 dark:bg-amber-950/40 dark:text-amber-200">
          Open this page from the Friday desktop window — system-audio capture isn&apos;t available
          in a regular browser tab.
        </div>
      ) : null}
      {error ? (
        <div className="rounded-md border border-red-400/50 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-950/40 dark:text-red-300">
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

function ClusterDivider() {
  return (
    <span
      aria-hidden
      className="hidden h-5 w-px bg-neutral-200 dark:bg-neutral-800 sm:inline-block"
    />
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
  privacyMode,
  compact = false,
}: {
  status: Status;
  finals: string[];
  interim: string;
  privacyMode: boolean;
  /** Slim layout for embedded use inside the Listen panel. */
  compact?: boolean;
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
        className={cn(
          'relative z-10 overflow-y-auto scroll-smooth',
          compact ? 'h-[22vh] px-5 py-4' : 'h-[60vh] px-8 py-8',
        )}
      >
        <div
          className={cn(
            'mx-auto flex flex-col gap-4 tracking-normal',
            compact ? 'max-w-[64ch] text-sm leading-snug' : 'max-w-[60ch] text-lg leading-relaxed',
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
          Jump to latest
        </button>
      ) : null}
    </div>
  );
}
