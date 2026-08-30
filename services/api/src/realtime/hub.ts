/**
 * The realtime hub.
 *
 * Every live update in both apps — a car moving on the map, an offer landing on
 * a driver's phone, a status change, a chat message — arrives through here.
 *
 * The model is channel-based. A connection subscribes to channels it is
 * authorised for (`ride:<id>`, `driver:<id>`, `rider:<id>`), and the hub mirrors
 * domain events onto those channels. Because the hub subscribes to the event
 * emitter rather than being called by the services, no service knows that
 * realtime exists.
 */

import type {
  DriverId,
  PlatformEvents,
  RideId,
  RiderId,
  TypedEmitter,
  Unsubscribe,
} from '@lift/core';

export type ChannelName = string;

export const rideChannel = (rideId: RideId): ChannelName => `ride:${rideId}`;
export const driverChannel = (driverId: DriverId): ChannelName => `driver:${driverId}`;
export const riderChannel = (riderId: RiderId): ChannelName => `rider:${riderId}`;
/** Fleet-wide feed for the ops console. */
export const OPS_CHANNEL: ChannelName = 'ops:all';

/** A message pushed down a socket. */
export interface RealtimeMessage<T = unknown> {
  readonly type: string;
  readonly channel: ChannelName;
  readonly payload: T;
  readonly at: number;
  /** Monotonic per-connection, so a client can spot a gap. */
  readonly seq: number;
}

/** The transport the hub writes to. Abstracted so tests need no real socket. */
export interface RealtimeConnection {
  readonly id: string;
  readonly userId: string;
  readonly role: 'rider' | 'driver' | 'admin';
  send(message: RealtimeMessage): void;
  close(reason?: string): void;
}

interface ConnectionState {
  readonly connection: RealtimeConnection;
  readonly channels: Set<ChannelName>;
  seq: number;
  lastSeenAt: number;
}

export class RealtimeHub {
  private readonly connections = new Map<string, ConnectionState>();
  private readonly channelIndex = new Map<ChannelName, Set<string>>();
  private unsubscribe?: Unsubscribe;
  private heartbeat?: ReturnType<typeof setInterval>;

  constructor(
    private readonly events: TypedEmitter<PlatformEvents>,
    private readonly options: {
      heartbeatIntervalMs?: number;
      /** Drop a connection that has not been heard from in this long. */
      idleTimeoutMs?: number;
      logger?: { info: (o: unknown, m?: string) => void };
    } = {},
  ) {}

  /** Begin mirroring domain events onto channels. */
  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.events.onAny((name, payload) => {
      for (const { channel, type, body } of routeEvent(name, payload)) {
        this.publish(channel, type, body);
      }
    });

    const interval = this.options.heartbeatIntervalMs ?? 25_000;
    this.heartbeat = setInterval(() => this.sweep(), interval);
    this.heartbeat.unref?.();
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
  }

  add(connection: RealtimeConnection): void {
    this.connections.set(connection.id, {
      connection,
      channels: new Set(),
      seq: 0,
      lastSeenAt: Date.now(),
    });
  }

  remove(connectionId: string): void {
    const state = this.connections.get(connectionId);
    if (!state) return;
    for (const channel of state.channels) {
      const subscribers = this.channelIndex.get(channel);
      subscribers?.delete(connectionId);
      if (subscribers?.size === 0) this.channelIndex.delete(channel);
    }
    this.connections.delete(connectionId);
  }

  subscribe(connectionId: string, channel: ChannelName): void {
    const state = this.connections.get(connectionId);
    if (!state) return;
    state.channels.add(channel);
    let subscribers = this.channelIndex.get(channel);
    if (!subscribers) {
      subscribers = new Set();
      this.channelIndex.set(channel, subscribers);
    }
    subscribers.add(connectionId);
  }

  unsubscribeFrom(connectionId: string, channel: ChannelName): void {
    const state = this.connections.get(connectionId);
    if (!state) return;
    state.channels.delete(channel);
    this.channelIndex.get(channel)?.delete(connectionId);
  }

  /** Record that a client is alive, for the idle sweep. */
  touch(connectionId: string): void {
    const state = this.connections.get(connectionId);
    if (state) state.lastSeenAt = Date.now();
  }

  /** Push a message to every subscriber of a channel. */
  publish(channel: ChannelName, type: string, payload: unknown): void {
    const subscribers = this.channelIndex.get(channel);
    if (!subscribers || subscribers.size === 0) return;
    const at = Date.now();
    for (const connectionId of subscribers) {
      const state = this.connections.get(connectionId);
      if (!state) continue;
      state.seq += 1;
      try {
        state.connection.send({ type, channel, payload, at, seq: state.seq });
      } catch {
        // A socket that refuses a write is already gone.
        this.remove(connectionId);
      }
    }
  }

  /** Push directly to one connection, e.g. to answer a subscribe request. */
  sendTo(connectionId: string, type: string, payload: unknown): void {
    const state = this.connections.get(connectionId);
    if (!state) return;
    state.seq += 1;
    state.connection.send({
      type,
      channel: 'direct',
      payload,
      at: Date.now(),
      seq: state.seq,
    });
  }

  connectionCount(): number {
    return this.connections.size;
  }

  channelCount(): number {
    return this.channelIndex.size;
  }

  subscriberCount(channel: ChannelName): number {
    return this.channelIndex.get(channel)?.size ?? 0;
  }

  /** Close connections that have gone quiet, and ping the rest. */
  private sweep(): void {
    const idleTimeoutMs = this.options.idleTimeoutMs ?? 90_000;
    const now = Date.now();
    for (const [id, state] of this.connections) {
      if (now - state.lastSeenAt > idleTimeoutMs) {
        state.connection.close('idle timeout');
        this.remove(id);
        continue;
      }
      state.seq += 1;
      try {
        state.connection.send({
          type: 'ping',
          channel: 'direct',
          payload: { at: now },
          at: now,
          seq: state.seq,
        });
      } catch {
        this.remove(id);
      }
    }
  }
}

interface RoutedMessage {
  readonly channel: ChannelName;
  readonly type: string;
  readonly body: unknown;
}

/**
 * Map one domain event onto the channels that should see it.
 *
 * This is the platform's fan-out policy in one readable place: a rider sees
 * their own ride, a driver sees theirs, and ops sees everything.
 */
const routeEvent = (name: keyof PlatformEvents, payload: unknown): RoutedMessage[] => {
  const out: RoutedMessage[] = [];
  const add = (channel: ChannelName, body: unknown): void => {
    out.push({ channel, type: name, body });
  };

  switch (name) {
    case 'ride.created':
    case 'ride.requested':
    case 'ride.matched':
    case 'ride.driver_arrived':
    case 'ride.started':
    case 'ride.completed':
    case 'ride.cancelled':
    case 'ride.expired':
    case 'ride.status_changed': {
      const { ride } = payload as { ride: { id: RideId; riderId: RiderId; assignment?: { driverId: DriverId } } };
      add(rideChannel(ride.id), payload);
      add(riderChannel(ride.riderId), payload);
      if (ride.assignment) add(driverChannel(ride.assignment.driverId), payload);
      add(OPS_CHANNEL, payload);
      break;
    }
    case 'ride.route_updated': {
      const { rideId } = payload as { rideId: RideId };
      add(rideChannel(rideId), payload);
      break;
    }
    case 'ride.rated': {
      const { rideId } = payload as { rideId: RideId };
      add(rideChannel(rideId), payload);
      add(OPS_CHANNEL, payload);
      break;
    }
    case 'offer.sent': {
      const { offer } = payload as { offer: { driverId: DriverId; rideId: RideId } };
      // Only the driver being offered the ride hears about it.
      add(driverChannel(offer.driverId), payload);
      add(OPS_CHANNEL, payload);
      break;
    }
    case 'offer.declined':
    case 'offer.expired': {
      const { driverId, rideId } = payload as { driverId: DriverId; rideId: RideId };
      add(driverChannel(driverId), payload);
      add(rideChannel(rideId), payload);
      add(OPS_CHANNEL, payload);
      break;
    }
    case 'driver.location_updated': {
      const { driverId, rideId } = payload as { driverId: DriverId; rideId?: RideId };
      // The rider watching the car move is on the ride channel.
      if (rideId) add(rideChannel(rideId), payload);
      add(driverChannel(driverId), payload);
      add(OPS_CHANNEL, payload);
      break;
    }
    case 'driver.availability_changed':
    case 'driver.online':
    case 'driver.offline': {
      const { driverId } = payload as { driverId: DriverId };
      add(driverChannel(driverId), payload);
      add(OPS_CHANNEL, payload);
      break;
    }
    case 'chat.message':
    case 'safety.alert': {
      const { rideId } = payload as { rideId: RideId };
      add(rideChannel(rideId), payload);
      add(OPS_CHANNEL, payload);
      break;
    }
    case 'payment.authorized':
    case 'payment.captured':
    case 'payment.failed':
    case 'payment.refunded': {
      const { charge } = payload as { charge: { riderId: RiderId; rideId?: RideId } };
      add(riderChannel(charge.riderId), payload);
      if (charge.rideId) add(rideChannel(charge.rideId), payload);
      break;
    }
    default:
      add(OPS_CHANNEL, payload);
  }
  return out;
};
