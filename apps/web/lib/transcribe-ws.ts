import type { WsControlMessage, WsServerMessage } from '@friday/shared-types';

export interface TranscribeWsHandlers {
  onMessage: (msg: WsServerMessage) => void;
  onOpen?: () => void;
  onClose?: (event: CloseEvent) => void;
  onError?: (event: Event) => void;
}

const BACKEND_WS_URL =
  process.env.NEXT_PUBLIC_BACKEND_WS_URL ?? 'ws://127.0.0.1:8000/ws/transcribe';

export type AudioSource = 'system' | 'mic';

// Source byte for tagged audio frames ({type:'start', audio_format:'tagged'}).
const SOURCE_BYTE: Record<AudioSource, number> = { system: 0, mic: 1 };

export class TranscribeWs {
  private ws: WebSocket | null = null;
  private handlers: TranscribeWsHandlers;
  private sessionId: string | null;

  /** `sessionId` ties the transcript to the setup session (resume, language,
   *  key terms) and to the answer socket's Redis keys. Without it the
   *  backend mints a throwaway id. */
  constructor(handlers: TranscribeWsHandlers, sessionId?: string | null) {
    this.handlers = handlers;
    this.sessionId = sessionId ?? null;
  }

  connect(): void {
    if (this.ws) return;
    const url = this.sessionId
      ? `${BACKEND_WS_URL}?session_id=${encodeURIComponent(this.sessionId)}`
      : BACKEND_WS_URL;
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => this.handlers.onOpen?.();
    ws.onmessage = (event) => {
      if (typeof event.data !== 'string') return;
      try {
        const msg = JSON.parse(event.data) as WsServerMessage;
        this.handlers.onMessage(msg);
      } catch {
        // ignore malformed
      }
    };
    ws.onclose = (event) => {
      this.ws = null;
      this.handlers.onClose?.(event);
    };
    ws.onerror = (event) => this.handlers.onError?.(event);
    this.ws = ws;
  }

  isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  sendControl(message: WsControlMessage): void {
    if (!this.isOpen()) return;
    this.ws?.send(JSON.stringify(message));
  }

  sendAudio(buffer: ArrayBuffer): void {
    if (!this.isOpen()) return;
    this.ws?.send(buffer);
  }

  /** Send one PCM frame prefixed with its source byte. Requires the session
   *  to have been started with `audio_format: 'tagged'`. */
  sendTaggedAudio(buffer: ArrayBuffer, source: AudioSource): void {
    if (!this.isOpen()) return;
    const framed = new Uint8Array(buffer.byteLength + 1);
    framed[0] = SOURCE_BYTE[source];
    framed.set(new Uint8Array(buffer), 1);
    this.ws?.send(framed.buffer);
  }

  close(): void {
    if (!this.ws) return;
    try {
      this.sendControl({ type: 'stop' });
    } catch {
      // ignore
    }
    this.ws.close();
    this.ws = null;
  }
}
