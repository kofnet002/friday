import type { AnswerProvider, ExtractedProblem } from '@friday/shared-types';

export {};

declare global {
  interface FridayAudioApi {
    start: (opts?: { mic?: boolean }) => Promise<{ ok: boolean; error?: string }>;
    stop: () => Promise<{ ok: boolean }>;
    pause: () => Promise<{ ok: boolean }>;
    resume: () => Promise<{ ok: boolean }>;
    isRunning: () => Promise<boolean>;
    onFrame: (cb: (chunk: ArrayBuffer, source: 'system' | 'mic') => void) => () => void;
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

  interface FridayScanState {
    state: 'capturing' | 'combining' | 'complete' | 'partial' | 'failed' | 'cancelled';
    frames: number;
    displayId?: string;
    limitReached?: boolean;
    partial?: boolean;
    error?: string;
  }

  interface FridayScanDisplay {
    displayId: string;
    label: string;
    isPrimary: boolean;
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
    startGuidedScan: (displayId?: string | null) => Promise<{ ok: boolean; error?: string }>;
    finishGuidedScan: () => Promise<{ ok: boolean; error?: string; partial?: boolean }>;
    cancelGuidedScan: () => Promise<{ ok: boolean; error?: string }>;
    listDisplays: () => Promise<FridayScanDisplay[]>;
    setScanDisplay: (displayId: string | null) => Promise<{ ok: boolean }>;
    getScanDisplay: () => Promise<string | null>;
    onScanState: (cb: (state: FridayScanState) => void) => () => void;
    isActive: () => Promise<boolean>;
    setProvider: (provider: AnswerProvider) => Promise<{ ok: boolean; provider: string | null }>;
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
    stealthEnabled: boolean;
    /** Snap the OS cursor to the bottom-right corner on the OFF→ON
     *  stealth transition. Off by default; surprises users on first use. */
    moveCursorOnStealth: boolean;
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
    redisAvailable?: boolean | null;
  }

  interface FridayWindowToast {
    message: string;
    timestamp: number;
  }

  interface FridayWindowApi {
    status: () => Promise<FridayWindowStatus>;
    quit: () => Promise<{ ok: boolean }>;
    restart: () => Promise<{ ok: boolean }>;
    toggleVisibility: () => Promise<FridayWindowStatus>;
    center: () => Promise<FridayWindowStatus>;
    updatePreferences: (patch: Partial<FridayWindowPreferences>) => Promise<FridayWindowStatus>;
    setOpacity: (value: number) => Promise<FridayWindowStatus>;
    setInteractive: (value: boolean) => Promise<{ ok: boolean; interactive?: boolean }>;
    /** Viewport rects (CSS px) where a drag from Finder should be accepted
     *  even though the window is click-through. Absent in older shells. */
    setDropZones?: (rects: FridayRect[]) => Promise<{ ok: boolean; zones: number }>;
    onStatus: (cb: (status: FridayWindowStatus) => void) => () => void;
    onToast: (cb: (toast: FridayWindowToast) => void) => () => void;
  }

  interface FridayRect {
    x: number;
    y: number;
    width: number;
    height: number;
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
    /** Absolute path of a dropped/picked File ('' when not on disk).
     *  Desktop only; absent in older shells. */
    getPathForFile?: (file: File) => string;
    /** Native folder picker (hidden from screen capture while stealth is
     *  on). `path` is null when cancelled. Absent in older shells. */
    chooseFolder?: () => Promise<{ path: string | null; hidden: boolean }>;
    audio: FridayAudioApi;
    coding: FridayCodingApi;
    appWindow: FridayWindowApi;
    stealth: FridayStealthApi;
  }

  interface Window {
    friday?: FridayApi;
  }
}
