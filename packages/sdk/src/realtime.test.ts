/**
 * Realtime client tests.
 *
 * Reconnection is the part of a mobile client that fails silently and ruins
 * live tracking, so it is tested against a fake socket that can be dropped,
 * reopened, and inspected.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RealtimeClient,
  channels,
  type RealtimeClientOptions,
  type WebSocketLike,
} from './realtime.js';

/** A WebSocket you drive by hand. */
class FakeSocket implements WebSocketLike {
  static instances: FakeSocket[] = [];

  readonly sent: string[] = [];
  readyState = 0;
  onopen: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  send(data: string): void {
    if (this.readyState !== 1) throw new Error('socket is not open');
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.({});
  }

  /** Simulate the server accepting the connection. */
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  /** Simulate a message arriving from the server. */
  deliver(message: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  /** Simulate the connection dropping. */
  drop(): void {
    this.readyState = 3;
    this.onclose?.({});
  }

  parsedSends(): Record<string, unknown>[] {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
  }
}

const latest = (): FakeSocket => FakeSocket.instances[FakeSocket.instances.length - 1]!;

const makeClient = (options: Partial<RealtimeClientOptions> = {}): RealtimeClient =>
  new RealtimeClient({
    url: () => 'ws://test/realtime?token=abc',
    createWebSocket: (url) => new FakeSocket(url),
    baseBackoffMs: 10,
    maxBackoffMs: 20,
    ...options,
  });

beforeEach(() => {
  FakeSocket.instances = [];
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('RealtimeClient', () => {
  it('connects and reports its status', () => {
    const client = makeClient();
    const statuses: string[] = [];
    client.onStatusChange((s) => statuses.push(s));

    client.connect();
    expect(client.getStatus()).toBe('connecting');

    latest().open();
    expect(client.getStatus()).toBe('connected');
    expect(statuses).toEqual(['connecting', 'connected']);
  });

  it('sends a subscribe frame once connected', () => {
    const client = makeClient();
    client.connect();
    latest().open();
    client.subscribe(channels.ride('rid_1'));

    expect(latest().parsedSends()).toContainEqual({
      type: 'subscribe',
      channel: 'ride:rid_1',
    });
  });

  it('remembers a subscription made before connecting', () => {
    const client = makeClient();
    client.subscribe(channels.ride('rid_1'));
    client.connect();
    latest().open();

    expect(latest().parsedSends()).toContainEqual({
      type: 'subscribe',
      channel: 'ride:rid_1',
    });
  });

  it('routes a message to that channel’s handler', () => {
    const client = makeClient();
    const onRide = vi.fn();
    const onOther = vi.fn();
    client.connect();
    latest().open();
    client.subscribe(channels.ride('rid_1'), onRide);
    client.subscribe(channels.ride('rid_2'), onOther);

    latest().deliver({
      type: 'ride.status_changed',
      channel: 'ride:rid_1',
      payload: { to: 'accepted' },
      at: 1,
      seq: 1,
    });

    expect(onRide).toHaveBeenCalledTimes(1);
    expect(onOther).not.toHaveBeenCalled();
  });

  it('routes by event type across channels', () => {
    const client = makeClient();
    const onOffer = vi.fn();
    client.connect();
    latest().open();
    client.on('offer.sent', onOffer);

    latest().deliver({ type: 'offer.sent', channel: 'driver:drv_1', payload: {}, at: 1, seq: 1 });
    latest().deliver({ type: 'ride.started', channel: 'ride:rid_1', payload: {}, at: 2, seq: 2 });

    expect(onOffer).toHaveBeenCalledTimes(1);
  });

  it('answers the server heartbeat without surfacing it to handlers', () => {
    const client = makeClient();
    const handler = vi.fn();
    client.connect();
    latest().open();
    client.onMessage(handler);

    latest().deliver({ type: 'ping', channel: 'direct', payload: {}, at: 1, seq: 1 });

    expect(handler).not.toHaveBeenCalled();
    expect(latest().parsedSends()).toContainEqual({ type: 'pong' });
  });

  describe('reconnection', () => {
    it('reconnects after an unexpected drop', () => {
      const client = makeClient();
      client.connect();
      latest().open();
      expect(FakeSocket.instances).toHaveLength(1);

      latest().drop();
      expect(client.getStatus()).toBe('reconnecting');

      vi.advanceTimersByTime(50);
      expect(FakeSocket.instances).toHaveLength(2);

      latest().open();
      expect(client.getStatus()).toBe('connected');
    });

    it('restores every subscription on the new connection', () => {
      const client = makeClient();
      client.connect();
      latest().open();
      client.subscribe(channels.ride('rid_1'));
      client.subscribe(channels.rider('rdr_1'));

      latest().drop();
      vi.advanceTimersByTime(50);
      latest().open();

      const resubscribed = latest()
        .parsedSends()
        .filter((m) => m.type === 'subscribe')
        .map((m) => m.channel);
      expect(resubscribed).toEqual(
        expect.arrayContaining(['ride:rid_1', 'rider:rdr_1']),
      );
    });

    it('backs off further with each consecutive failure', () => {
      const client = makeClient({ baseBackoffMs: 100, maxBackoffMs: 10_000 });
      client.connect();
      latest().open();

      latest().drop();
      // The first retry waits ~100ms (with jitter), so nothing at 50ms.
      vi.advanceTimersByTime(50);
      expect(FakeSocket.instances).toHaveLength(1);
      vi.advanceTimersByTime(150);
      expect(FakeSocket.instances).toHaveLength(2);

      // A second failure waits roughly twice as long.
      latest().drop();
      vi.advanceTimersByTime(120);
      expect(FakeSocket.instances).toHaveLength(2);
      vi.advanceTimersByTime(300);
      expect(FakeSocket.instances).toHaveLength(3);
    });

    it('gives up after the configured attempt limit', () => {
      const client = makeClient({ maxAttempts: 2 });
      client.connect();
      latest().open();

      for (let i = 0; i < 3; i++) {
        latest().drop();
        vi.advanceTimersByTime(100);
      }
      expect(client.getStatus()).toBe('closed');
    });

    it('does not reconnect after an intentional disconnect', () => {
      const client = makeClient();
      client.connect();
      latest().open();

      client.disconnect();
      vi.advanceTimersByTime(1_000);

      expect(FakeSocket.instances).toHaveLength(1);
      expect(client.getStatus()).toBe('closed');
    });

    it('re-reads the URL on reconnect so a refreshed token is used', () => {
      let token = 'first';
      const client = makeClient({ url: () => `ws://test/realtime?token=${token}` });
      client.connect();
      latest().open();

      token = 'second';
      latest().drop();
      vi.advanceTimersByTime(50);

      expect(latest().url).toContain('token=second');
    });
  });

  describe('offline behaviour', () => {
    it('drops location updates while disconnected rather than queuing stale ones', () => {
      const client = makeClient();
      client.connect();
      latest().open();
      const socket = latest();

      socket.drop();
      client.sendLocation({ lat: 37.7, lng: -122.4 });

      vi.advanceTimersByTime(50);
      latest().open();

      // The stale fix is gone; only the resubscribes were replayed.
      expect(latest().parsedSends().some((m) => m.type === 'location')).toBe(false);
    });

    it('sends a location fix while connected', () => {
      const client = makeClient();
      client.connect();
      latest().open();
      client.sendLocation({ lat: 37.7, lng: -122.4, bearing: 90 });

      expect(latest().parsedSends()).toContainEqual({
        type: 'location',
        lat: 37.7,
        lng: -122.4,
        bearing: 90,
      });
    });
  });

  it('stops delivering to an unsubscribed handler', () => {
    const client = makeClient();
    const handler = vi.fn();
    client.connect();
    latest().open();

    const off = client.subscribe(channels.ride('rid_1'), handler);
    latest().deliver({ type: 'x', channel: 'ride:rid_1', payload: {}, at: 1, seq: 1 });
    expect(handler).toHaveBeenCalledTimes(1);

    off();
    latest().deliver({ type: 'x', channel: 'ride:rid_1', payload: {}, at: 2, seq: 2 });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('survives a malformed frame', () => {
    const client = makeClient();
    const handler = vi.fn();
    client.connect();
    latest().open();
    client.onMessage(handler);

    latest().onmessage?.({ data: 'not json{' });
    expect(handler).not.toHaveBeenCalled();
    expect(client.getStatus()).toBe('connected');
  });

  it('reports a socket that fails to construct and retries', () => {
    const onError = vi.fn();
    let failNext = true;
    const client = new RealtimeClient({
      url: () => 'ws://test',
      onError,
      baseBackoffMs: 10,
      createWebSocket: (url) => {
        if (failNext) {
          failNext = false;
          throw new Error('no network');
        }
        return new FakeSocket(url);
      },
    });

    client.connect();
    expect(onError).toHaveBeenCalled();
    expect(client.getStatus()).toBe('reconnecting');

    vi.advanceTimersByTime(50);
    latest().open();
    expect(client.getStatus()).toBe('connected');
  });
});

describe('channel helpers', () => {
  it('build the names the server expects', () => {
    expect(channels.ride('rid_1')).toBe('ride:rid_1');
    expect(channels.driver('drv_1')).toBe('driver:drv_1');
    expect(channels.rider('rdr_1')).toBe('rider:rdr_1');
    expect(channels.ops).toBe('ops:all');
  });
});
