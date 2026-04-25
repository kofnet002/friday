import type { ExtractedProblem } from '@friday/shared-types';

export {};

declare global {
  interface FridayAudioApi {
    start: () => Promise<{ ok: boolean; error?: string }>;
    stop: () => Promise<{ ok: boolean }>;
    pause: () => Promise<{ ok: boolean }>;
    resume: () => Promise<{ ok: boolean }>;
    isRunning: () => Promise<boolean>;
    onFrame: (cb: (chunk: ArrayBuffer) => void) => () => void;
    onError: (cb: (msg: string) => void) => () => void;
    onLog: (cb: (msg: string) => void) => () => void;
    onExit: (cb: (info: { code: number | null; signal: string | null }) => void) => () => void;
  }

  interface FridayCodingExtractionResult {
    problem: ExtractedProblem;
    emitted: boolean;
    cached: boolean;
    bytes: number;
  }

  interface FridayCodingFrameInfo {
    changed_bits: number;
    changed: boolean;
    interval_ms: number;
  }

  interface FridayCodingApi {
    start: (sessionId: string) => Promise<{ ok: boolean; error?: string }>;
    stop: () => Promise<{ ok: boolean }>;
    forceExtract: () => Promise<{ ok: boolean; error?: string }>;
    isActive: () => Promise<boolean>;
    onFrameProcessed: (cb: (info: FridayCodingFrameInfo) => void) => () => void;
    onExtractionResult: (cb: (payload: FridayCodingExtractionResult) => void) => () => void;
    onError: (cb: (msg: string) => void) => () => void;
    onLog: (cb: (msg: string) => void) => () => void;
  }

  interface FridayApi {
    platform: string;
    versions: Record<string, string>;
    audio: FridayAudioApi;
    coding: FridayCodingApi;
  }

  interface Window {
    friday?: FridayApi;
  }
}
