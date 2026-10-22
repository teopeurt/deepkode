// Responsibility: WS client —— subscribes to the /api/events event mirror: exponential-backoff reconnect (1s→2s→4s→… capped at 30s),
// connection-state notifications, event callbacks. The real service broadcasts the raw dsh log events of all sessions ({type,seq,time,data},
// only session events carry a session id); the frontend uses events as "change signals" to refresh the projection, and after reconnecting catches up by last_seq (REST refetch).
import type { WsEvent } from '../store/projection';

export type ConnState = 'online' | 'reconnect';

export interface EventsClientOpts {
  url?: string;
  onEvent: (ev: WsEvent) => void;
  /** Disconnect/reconnect state changes (online / reconnect) */
  onState: (s: ConnState) => void;
  /** Called after a successful reconnect (the frontend uses it to catch up by last_seq: refetch the current projection) */
  onReconnect?: () => void;
}

const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 30000;

export class EventsClient {
  private ws: WebSocket | null = null;
  private closed = false;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private opts: EventsClientOpts;

  constructor(opts: EventsClientOpts) {
    this.opts = opts;
  }

  connect() {
    this.closed = false;
    this.open();
  }

  private open() {
    const url = this.opts.url ?? `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/events`;
    this.opts.onState('reconnect');
    try {
      this.ws = new WebSocket(url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws.onopen = () => {
      this.attempt = 0;
      this.opts.onState('online');
      this.opts.onReconnect?.();
    };
    this.ws.onmessage = (e) => {
      try {
        this.opts.onEvent(JSON.parse(String(e.data)) as WsEvent);
      } catch {
        /* ignore frames that cannot be parsed */
      }
    };
    this.ws.onclose = () => {
      this.ws = null;
      if (!this.closed) this.scheduleReconnect();
    };
    this.ws.onerror = () => {
      // onclose fires afterwards and handles reconnection uniformly
      try { this.ws?.close(); } catch { /* ignore */ }
    };
  }

  private scheduleReconnect() {
    if (this.closed) return;
    const delay = Math.min(BACKOFF_BASE_MS * 2 ** this.attempt, BACKOFF_MAX_MS);
    this.attempt += 1;
    this.opts.onState('reconnect');
    this.timer = setTimeout(() => this.open(), delay);
  }

  close() {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    try { this.ws?.close(); } catch { /* ignore */ }
    this.ws = null;
  }
}
