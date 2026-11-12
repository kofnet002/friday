import type {
  ClaudeModel,
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

// Reconnect backoff: 1s → 2s → 4s … capped. The coding socket is the delivery
// channel for vision detections (session_bus) — if it silently dies, every
// extraction is dropped on the floor (emitted=False) while the desktop keeps
// paying for vision calls. Reconnecting is what makes an overnight blip
// self-heal instead of bricking the panel until a manual reload.
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

export class CodingWs {
  private ws: WebSocket | null = null;
  private handlers: CodingWsHandlers;
  private sessionId: string;
  private closedByUser = false;
  private reconnectAttempt = 0;
  private reconnectTimer: number | null = null;

  constructor(sessionId: string, handlers: CodingWsHandlers) {
    this.sessionId = sessionId;
    this.handlers = handlers;
  }

  connect(): void {
    if (this.ws) return;
    this.closedByUser = false;
    this.open();
  }

  private open(): void {
    const ws = new WebSocket(
      `${BACKEND_WS_URL}/ws/coding-solution?session_id=${encodeURIComponent(this.sessionId)}`,
    );
    ws.onopen = () => {
      this.reconnectAttempt = 0;
      this.handlers.onOpen?.();
    };
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
      this.scheduleReconnect();
    };
    ws.onerror = (event) => this.handlers.onError?.(event);
    this.ws = ws;
  }

  private scheduleReconnect(): void {
    if (this.closedByUser || this.reconnectTimer !== null) return;
    const delay = Math.min(
      RECONNECT_MAX_MS,
      RECONNECT_BASE_MS * 2 ** Math.min(this.reconnectAttempt, 5),
    );
    this.reconnectAttempt += 1;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.closedByUser && !this.ws) this.open();
    }, delay);
  }

  /** Rebind to another session: reopen the socket under the new id right
   *  away (if it was connected or reconnecting). */
  switchSession(sessionId: string): void {
    if (sessionId === this.sessionId) return;
    this.sessionId = sessionId;
    const active = this.ws !== null || this.reconnectTimer !== null;
    if (this.closedByUser || !active) return;
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const old = this.ws;
    this.ws = null;
    if (old) {
      old.onclose = null;
      old.onmessage = null;
      old.onerror = null;
      try {
        old.close();
      } catch {
        // ignore
      }
    }
    this.reconnectAttempt = 0;
    this.open();
  }

  isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private claudeModel: ClaudeModel | null = null;

  /** Claude model screen mode should use; attached to every Claude request. */
  setClaudeModel(model: ClaudeModel | null): void {
    this.claudeModel = model;
  }

  send(message: CodingSolutionClientMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const outgoing =
      message.type === 'solve' && message.provider === 'claude' && this.claudeModel
        ? { ...message, claude_model: message.claude_model ?? this.claudeModel }
        : message;
    this.ws.send(JSON.stringify(outgoing));
  }

  cancel(): void {
    this.send({ type: 'cancel' });
  }

  close(): void {
    this.closedByUser = true;
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
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
