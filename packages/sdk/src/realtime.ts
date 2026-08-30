/**
 * The realtime client.
 *
 * Wraps a WebSocket with the things a phone actually needs: automatic
 * reconnection with backoff, channel subscriptions that survive a reconnect,
 * heartbeats, and a typed event surface. A rider watching their driver on the
 * map goes through a tunnel and comes back without noticing.
 */

export type RealtimeStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'closed';

export interface RealtimeMessage<T = unknown> {
  readonly type: string;
  readonly channel: string;
  readonly payload: T;
  readonly at: number;
  readonly seq: number;
}

export type MessageHandler = (message: RealtimeMessage) => void;
export type StatusHandler = (status: RealtimeStatus) => void;
export type Unsubscribe = () => void;

/** The minimal WebSocket surface this client needs. */
export interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  readyState: number;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

export interface RealtimeClientOptions {
  /** Called each time a connection is opened, so the token stays fresh. */
  readonly url: () => string;
  readonly createWebSocket?: WebSocketFactory;
  /** First reconnect delay; doubles up to `maxBackoffMs`. */
  readonly baseBackoffMs?: number;
  readonly maxBackoffMs?: number;
  /** Give up after this many consecutive failures. 0 means never. */
  readonly maxAttempts?: number;
  readonly onError?: (error: unknown) => void;
}

const OPEN = 1;

export class RealtimeClient {
  private socket?: WebSocketLike;
  private status: RealtimeStatus = 'idle';
  private attempts = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private intentionallyClosed = false;

  /** Channels to (re)subscribe on every connect. */
  private readonly channels = new Set<string>();
  private readonly handlers = new Map<string, Set<MessageHandler>>();
  private readonly anyHandlers = new Set<MessageHandler>();
  private readonly statusHandlers = new Set<StatusHandler>();
  /** Messages sent while disconnected, flushed on reconnect. */
  private readonly outbox: string[] = [];

  constructor(private readonly options: RealtimeClientOptions) {}

  getStatus(): RealtimeStatus {
    return this.status;
  }

  get isConnected(): boolean {
    return this.status === 'connected';
  }

  connect(): void {
    if (this.status === 'connected' || this.status === 'connecting') return;
    this.intentionallyClosed = false;
    this.open();
  }

  disconnect(): void {
    this.intentionallyClosed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.socket?.close(1000, 'client disconnect');
    this.socket = undefined;
    this.setStatus('closed');
  }

  /**
   * Subscribe to a channel. Safe to call before connecting and safe to call
   * twice — the subscription is remembered and re-sent after a reconnect.
   */
  subscribe(channel: string, handler?: MessageHandler): Unsubscribe {
    this.channels.add(channel);
    this.send({ type: 'subscribe', channel });

    if (!handler) return () => this.unsubscribe(channel);

    let set = this.handlers.get(channel);
    if (!set) {
      set = new Set();
      this.handlers.set(channel, set);
    }
    set.add(handler);

    return () => {
      set!.delete(handler);
      if (set!.size === 0) this.unsubscribe(channel);
    };
  }

  unsubscribe(channel: string): void {
    this.channels.delete(channel);
    this.handlers.delete(channel);
    this.send({ type: 'unsubscribe', channel });
  }

  /** Handle every message, whatever its channel. */
  onMessage(handler: MessageHandler): Unsubscribe {
    this.anyHandlers.add(handler);
    return () => this.anyHandlers.delete(handler);
  }

  /** Handle messages of one event type, e.g. `ride.status_changed`. */
  on(type: string, handler: MessageHandler): Unsubscribe {
    return this.onMessage((message) => {
      if (message.type === type) handler(message);
    });
  }

  onStatusChange(handler: StatusHandler): Unsubscribe {
    this.statusHandlers.add(handler);
    return () => this.statusHandlers.delete(handler);
  }

  /**
   * Stream a driver location over the socket. Cheaper than an HTTP round trip
   * every few seconds, and dropped rather than queued when offline — a stale
   * position is worse than none.
   */
  sendLocation(position: {
    lat: number;
    lng: number;
    bearing?: number;
    speed?: number;
    accuracy?: number;
  }): void {
    if (!this.isConnected) return;
    this.rawSend(JSON.stringify({ type: 'location', ...position }));
  }

  private send(message: Record<string, unknown>): void {
    const payload = JSON.stringify(message);
    if (this.isConnected) this.rawSend(payload);
    // Subscriptions are replayed from `channels` on reconnect, so only other
    // messages need queueing.
    else if (message.type !== 'subscribe' && message.type !== 'unsubscribe') {
      this.outbox.push(payload);
    }
  }

  private rawSend(payload: string): void {
    try {
      this.socket?.send(payload);
    } catch (e) {
      this.options.onError?.(e);
    }
  }

  private open(): void {
    this.setStatus(this.attempts === 0 ? 'connecting' : 'reconnecting');

    const factory =
      this.options.createWebSocket ??
      ((url: string) => new (globalThis as { WebSocket: new (u: string) => WebSocketLike }).WebSocket(url));

    let socket: WebSocketLike;
    try {
      socket = factory(this.options.url());
    } catch (e) {
      this.options.onError?.(e);
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.onopen = () => {
      this.attempts = 0;
      this.setStatus('connected');
      // Restore every subscription, then flush anything queued while away.
      for (const channel of this.channels) {
        this.rawSend(JSON.stringify({ type: 'subscribe', channel }));
      }
      while (this.outbox.length > 0) this.rawSend(this.outbox.shift()!);
    };

    socket.onmessage = (event) => {
      let message: RealtimeMessage;
      try {
        message = JSON.parse(String(event.data)) as RealtimeMessage;
      } catch {
        return;
      }
      // Answer the server's heartbeat so it does not sweep this connection.
      if (message.type === 'ping') {
        this.rawSend(JSON.stringify({ type: 'pong' }));
        return;
      }
      for (const handler of this.handlers.get(message.channel) ?? []) handler(message);
      for (const handler of this.anyHandlers) handler(message);
    };

    socket.onerror = (event) => {
      this.options.onError?.(event);
    };

    socket.onclose = () => {
      this.socket = undefined;
      if (this.intentionallyClosed) {
        this.setStatus('closed');
        return;
      }
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    const maxAttempts = this.options.maxAttempts ?? 0;
    if (maxAttempts > 0 && this.attempts >= maxAttempts) {
      this.setStatus('closed');
      return;
    }
    this.attempts += 1;
    this.setStatus('reconnecting');

    const base = this.options.baseBackoffMs ?? 500;
    const max = this.options.maxBackoffMs ?? 15_000;
    // Exponential backoff with jitter, so a server restart does not bring
    // every client back in the same millisecond.
    const delay = Math.min(max, base * 2 ** (this.attempts - 1));
    const jittered = delay * (0.7 + Math.random() * 0.6);

    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.open(), jittered);
  }

  private setStatus(status: RealtimeStatus): void {
    if (this.status === status) return;
    this.status = status;
    for (const handler of this.statusHandlers) handler(status);
  }
}

/** Channel name helpers, matching the server's naming. */
export const channels = {
  ride: (rideId: string): string => `ride:${rideId}`,
  driver: (driverId: string): string => `driver:${driverId}`,
  rider: (riderId: string): string => `rider:${riderId}`,
  ops: 'ops:all',
} as const;

export { OPEN as WEBSOCKET_OPEN };
