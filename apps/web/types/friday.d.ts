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
    setProvider: (
      provider: 'gemini' | 'openai' | 'deepseek',
    ) => Promise<{ ok: boolean; provider: string | null }>;
    onFrameProcessed: (cb: (info: FridayCodingFrameInfo) => void) => () => void;
    onExtractionResult: (cb: (payload: FridayCodingExtractionResult) => void) => () => void;
    onError: (cb: (msg: string) => void) => () => void;
    onLog: (cb: (msg: string) => void) => () => void;
  }

  interface FridayWindowPreferences {
    accessoryApp: boolean;
    alwaysOnTop: boolean;
    dockHidden: boolean;
    visibleOnAllWorkspaces: boolean;
    hideWindowControls: boolean;
  }

  interface FridayWindowStatus {
    visible: boolean;
    focused: boolean;
    dockHidden: boolean;
    accessoryApp: boolean;
    opacity: number;
    bounds: {
      x?: number;
      y?: number;
      width: number;
      height: number;
    };
    preferences: FridayWindowPreferences;
    stealth: FridayStealthStatus;
  }

  interface FridayWindowToast {
    message: string;
    timestamp: number;
  }

  interface FridayWindowApi {
    status: () => Promise<FridayWindowStatus>;
    toggleVisibility: () => Promise<FridayWindowStatus>;
    center: () => Promise<FridayWindowStatus>;
    updatePreferences: (patch: Partial<FridayWindowPreferences>) => Promise<FridayWindowStatus>;
    setOpacity: (value: number) => Promise<FridayWindowStatus>;
    setInteractive: (value: boolean) => Promise<{ ok: boolean; interactive?: boolean }>;
    onStatus: (cb: (status: FridayWindowStatus) => void) => () => void;
    onToast: (cb: (toast: FridayWindowToast) => void) => () => void;
  }

  interface FridayStealthStatus {
    enabled: boolean;
    contentProtection: boolean;
    nativeSupported: boolean;
    nativeApplied: boolean;
    error: string | null;
  }

  interface FridayStealthApi {
    enable: () => Promise<FridayStealthStatus>;
    disable: () => Promise<FridayStealthStatus>;
    status: () => Promise<FridayStealthStatus>;
  }

  interface FridayApi {
    platform: string;
    versions: Record<string, string>;
    audio: FridayAudioApi;
    coding: FridayCodingApi;
    appWindow: FridayWindowApi;
    stealth: FridayStealthApi;
  }

  interface Window {
    friday?: FridayApi;
  }
}
