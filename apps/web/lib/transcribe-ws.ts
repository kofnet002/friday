import type { WsControlMessage, WsServerMessage } from '@friday/shared-types';

export interface TranscribeWsHandlers {
  onMessage: (msg: WsServerMessage) => void;
  onOpen?: () => void;
  onClose?: (event: CloseEvent) => void;
  onError?: (event: Event) => void;
}

const BACKEND_WS_URL =
  process.env.NEXT_PUBLIC_BACKEND_WS_URL ?? 'ws://127.0.0.1:8000/ws/transcribe';

export class TranscribeWs {
  private ws: WebSocket | null = null;
  private handlers: TranscribeWsHandlers;

  constructor(handlers: TranscribeWsHandlers) {
    this.handlers = handlers;
  }

  connect(): void {
    if (this.ws) return;
    const ws = new WebSocket(BACKEND_WS_URL);
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
