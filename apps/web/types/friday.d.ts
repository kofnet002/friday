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

  interface FridayApi {
    platform: string;
    versions: Record<string, string>;
    audio: FridayAudioApi;
  }

  interface Window {
    friday?: FridayApi;
  }
}
