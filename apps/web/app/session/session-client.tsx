'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type {
  AnswerProvider,
  AnswerServerMessage,
  TranscriptEvent,
  WsServerMessage,
} from '@friday/shared-types';

import { Button } from '@/components/ui/button';
import { AnswerWs } from '@/lib/answer-ws';
import {
  getOrCreateSessionId,
  getProviderPreference,
  setProviderPreference,
} from '@/lib/session-context';
import { TranscribeWs } from '@/lib/transcribe-ws';
import { cn } from '@/lib/utils';

import { AnswerPanel, type AnswerStatus } from './answer-panel';

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

  const transcribeRef = useRef<TranscribeWs | null>(null);
  const answerRef = useRef<AnswerWs | null>(null);
  const lastSendAtRef = useRef<number>(0);
  const audioUnsubsRef = useRef<Array<() => void>>([]);
  const finalsRef = useRef<string[]>([]);
  const providerRef = useRef<AnswerProvider>('gemini');

  finalsRef.current = finals;
  providerRef.current = provider;

  const inElectron = typeof window !== 'undefined' && Boolean(window.friday);

  // On mount: resolve session_id and provider pref, then open the answer WS.
  useEffect(() => {
    const sid = getOrCreateSessionId();
    setSessionIdState(sid);
    setProvider(getProviderPreference());

    const ws = new AnswerWs(sid, {
      onMessage: onAnswerMessage,
      onOpen: () => setAnswerConnected(true),
      onClose: () => setAnswerConnected(false),
      onError: () => setAnswerConnected(false),
    });
    ws.connect();
    answerRef.current = ws;

    return () => {
      ws.close();
      answerRef.current = null;
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

  // ─── Cmd+Shift+Space hotkey: force-generate from recent transcript ────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.metaKey && e.shiftKey && (e.code === 'Space' || e.key === ' ')) {
        e.preventDefault();
        const recent = finalsRef.current.slice(-RECENT_FINALS_JOIN).join(' ').trim();
        if (recent) askAnswer(recent);
        else setAnswerError('no transcript yet');
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

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
        </div>
        <div className="ml-auto flex items-center gap-3 text-xs">
          <span className="hidden font-mono text-neutral-500 md:inline">⌘⇧␣ to force-ask</span>
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

      <div className="grid gap-4 lg:grid-cols-[3fr_2fr]">
        <Transcript status={status} finals={finals} interim={interim} />
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
      </div>
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
