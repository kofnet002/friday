'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { TranscriptEvent, WsServerMessage } from '@friday/shared-types';

import { Button } from '@/components/ui/button';
import { TranscribeWs } from '@/lib/transcribe-ws';
import { cn } from '@/lib/utils';

type Status = 'idle' | 'starting' | 'recording' | 'paused' | 'error';

const AUTOSCROLL_THRESHOLD_PX = 48;

export function SessionClient() {
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [finals, setFinals] = useState<string[]>([]);
  const [interim, setInterim] = useState<string>('');

  const wsRef = useRef<TranscribeWs | null>(null);
  const lastSendAtRef = useRef<number>(0);
  const audioUnsubsRef = useRef<Array<() => void>>([]);
  const inElectron = typeof window !== 'undefined' && Boolean(window.friday);

  const onServerMessage = useCallback((msg: WsServerMessage) => {
    if (msg.type === 'ready') {
      setSessionId(msg.session_id);
      return;
    }
    if (msg.type === 'error') {
      setError(msg.message);
      setStatus('error');
      return;
    }
    if (msg.type === 'transcript') {
      handleTranscript(msg);
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

  const teardownAudioListeners = () => {
    for (const off of audioUnsubsRef.current) off();
    audioUnsubsRef.current = [];
  };

  const start = async () => {
    setError(null);
    setStatus('starting');
    setLatencyMs(null);

    const ws = new TranscribeWs({
      onMessage: onServerMessage,
      onOpen: () => {
        ws.sendControl({ type: 'start' });
      },
      onClose: () => {
        setStatus((prev) => (prev === 'error' ? prev : 'idle'));
      },
      onError: () => {
        setError('WebSocket error');
        setStatus('error');
      },
    });
    ws.connect();
    wsRef.current = ws;

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
      wsRef.current?.sendAudio(chunk);
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

  const stop = async () => {
    teardownAudioListeners();
    if (inElectron && window.friday) {
      await window.friday.audio.stop();
    }
    wsRef.current?.close();
    wsRef.current = null;
    setStatus('idle');
  };

  const pause = async () => {
    if (inElectron && window.friday) {
      await window.friday.audio.pause();
    }
    wsRef.current?.sendControl({ type: 'pause' });
    setStatus('paused');
  };

  const resume = async () => {
    if (inElectron && window.friday) {
      await window.friday.audio.resume();
    }
    wsRef.current?.sendControl({ type: 'start' });
    setStatus('recording');
  };

  const clear = () => {
    setFinals([]);
    setInterim('');
    setLatencyMs(null);
  };

  useEffect(() => {
    return () => {
      teardownAudioListeners();
      wsRef.current?.close();
      wsRef.current = null;
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
          <Button onClick={clear} variant="ghost">
            Clear
          </Button>
        </div>
        <div className="ml-auto flex items-center gap-3 text-xs">
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

      <Transcript status={status} finals={finals} interim={interim} />
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
  const endRef = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);

  // Auto-scroll to the latest line whenever content changes — but only if the
  // user hasn't scrolled up. If they have, leave them where they are.
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

  return (
    <div className="relative overflow-hidden rounded-2xl border border-neutral-200 bg-gradient-to-b from-white via-neutral-50 to-white shadow-inner dark:border-neutral-800 dark:from-neutral-950 dark:via-neutral-900 dark:to-neutral-950">
      <div
        aria-hidden
        className={cn(
          'pointer-events-none absolute bottom-0 left-1/2 h-72 w-[60rem] -translate-x-1/2 rounded-full blur-3xl transition-opacity duration-500',
          status === 'recording'
            ? 'bg-sky-500/10 opacity-100 dark:bg-sky-400/10'
            : status === 'paused'
              ? 'bg-amber-400/10 opacity-80'
              : 'opacity-0',
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
          <div ref={endRef} />
        </div>
      </div>

      {!pinned ? (
        <button
          type="button"
          onClick={jumpToLatest}
          className="absolute bottom-4 left-1/2 z-20 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-neutral-300 bg-white/90 px-3 py-1.5 text-xs font-medium text-neutral-700 shadow-md backdrop-blur transition-colors hover:bg-white dark:border-neutral-700 dark:bg-neutral-900/90 dark:text-neutral-200 dark:hover:bg-neutral-900"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 20 20"
            fill="currentColor"
            className="h-3.5 w-3.5"
            aria-hidden
          >
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
