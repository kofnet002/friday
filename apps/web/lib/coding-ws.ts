import type {
  CodingSolutionClientMessage,
  CodingSolutionServerMessage,
} from '@friday/shared-types';

export interface CodingWsHandlers {
  onMessage: (msg: CodingSolutionServerMessage) => void;
  onOpen?: () => void;
  onClose?: (event: CloseEvent) => void;
  onError?: (event: Event) => void;
}

const BACKEND_WS_URL = process.env.NEXT_PUBLIC_BACKEND_WS_URL ?? 'ws://127.0.0.1:8000';

export class CodingWs {
  private ws: WebSocket | null = null;
  private handlers: CodingWsHandlers;
  private sessionId: string;

  constructor(sessionId: string, handlers: CodingWsHandlers) {
    this.sessionId = sessionId;
    this.handlers = handlers;
  }

  connect(): void {
    if (this.ws) return;
    const ws = new WebSocket(
      `${BACKEND_WS_URL}/ws/coding-solution?session_id=${encodeURIComponent(this.sessionId)}`,
    );
    ws.onopen = () => this.handlers.onOpen?.();
    ws.onmessage = (event) => {
      if (typeof event.data !== 'string') return;
      try {
        const msg = JSON.parse(event.data) as CodingSolutionServerMessage;
        this.handlers.onMessage(msg);
      } catch {
        // ignore
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

  send(message: CodingSolutionClientMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(message));
  }

  cancel(): void {
    this.send({ type: 'cancel' });
  }

  close(): void {
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
  }
}
