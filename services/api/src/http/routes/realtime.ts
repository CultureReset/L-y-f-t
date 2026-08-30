/**
 * The WebSocket endpoint.
 *
 * A client connects with its bearer token, subscribes to the channels it is
 * authorised for, and receives every relevant domain event. Authorisation is
 * enforced per subscribe: a rider can only watch their own rides, a driver
 * their own, and only an admin can watch the whole fleet.
 */

import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { z } from 'zod';
import type { Container } from '../../container.js';
import {
  OPS_CHANNEL,
  driverChannel,
  rideChannel,
  riderChannel,
  type RealtimeConnection,
} from '../../realtime/hub.js';

const clientMessageSchema = z.union([
  z.object({ type: z.literal('subscribe'), channel: z.string().min(1).max(100) }),
  z.object({ type: z.literal('unsubscribe'), channel: z.string().min(1).max(100) }),
  z.object({ type: z.literal('pong') }),
  z.object({
    type: z.literal('location'),
    lat: z.number(),
    lng: z.number(),
    bearing: z.number().optional(),
    speed: z.number().optional(),
    accuracy: z.number().optional(),
  }),
]);

export const registerRealtimeRoutes = (app: FastifyInstance, container: Container): void => {
  app.get('/realtime', { websocket: true }, async (socket: WebSocket, request) => {
    // The browser WebSocket API cannot set headers, so a token may also arrive
    // as a query parameter.
    const queryToken = (request.query as { token?: string } | undefined)?.token;
    const header = request.headers.authorization;
    const token = queryToken ?? (header?.startsWith('Bearer ') ? header.slice(7) : undefined);

    if (!token) {
      socket.send(JSON.stringify({ type: 'error', payload: { message: 'Token required' } }));
      socket.close(4401, 'unauthorized');
      return;
    }

    let session;
    try {
      session = await container.auth.authenticate(token);
    } catch {
      socket.send(JSON.stringify({ type: 'error', payload: { message: 'Invalid token' } }));
      socket.close(4401, 'unauthorized');
      return;
    }

    const [rider, driver] = await Promise.all([
      container.repositories.riders.findByUserId(session.userId),
      container.repositories.drivers.findByUserId(session.userId),
    ]);

    const connectionId = `ws_${Math.random().toString(36).slice(2, 12)}`;
    const connection: RealtimeConnection = {
      id: connectionId,
      userId: session.userId,
      role: session.role,
      send: (message) => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
      },
      close: (reason) => socket.close(1000, reason ?? 'closed'),
    };

    container.hub.add(connection);

    // Subscribe to the channels this identity always wants, so a client does
    // not have to ask for its own feed.
    if (rider) container.hub.subscribe(connectionId, riderChannel(rider.id));
    if (driver) container.hub.subscribe(connectionId, driverChannel(driver.id));
    if (session.role === 'admin') container.hub.subscribe(connectionId, OPS_CHANNEL);

    container.hub.sendTo(connectionId, 'connected', {
      connectionId,
      role: session.role,
      riderId: rider?.id,
      driverId: driver?.id,
      heartbeatIntervalMs: container.config.realtime.heartbeatIntervalMs,
    });

    socket.on('message', (raw: Buffer) => {
      container.hub.touch(connectionId);
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const result = clientMessageSchema.safeParse(parsed);
      if (!result.success) return;
      const message = result.data;

      switch (message.type) {
        case 'subscribe': {
          void authorizeChannel(container, message.channel, {
            riderId: rider?.id,
            driverId: driver?.id,
            role: session.role,
          }).then((allowed) => {
            if (allowed) {
              container.hub.subscribe(connectionId, message.channel);
              container.hub.sendTo(connectionId, 'subscribed', { channel: message.channel });
            } else {
              container.hub.sendTo(connectionId, 'error', {
                message: `Not authorized for channel ${message.channel}`,
              });
            }
          });
          break;
        }
        case 'unsubscribe':
          container.hub.unsubscribeFrom(connectionId, message.channel);
          break;
        case 'location': {
          // Drivers stream position over the socket rather than paying for an
          // HTTP round trip every few seconds.
          if (!driver) return;
          void container.drivers
            .updateLocation(driver.id, { ...message, timestamp: Date.now() })
            .catch(() => {});
          break;
        }
        case 'pong':
          break;
      }
    });

    socket.on('close', () => container.hub.remove(connectionId));
    socket.on('error', () => container.hub.remove(connectionId));
  });
};

/**
 * Channel authorisation. A ride channel is open to that ride's rider, its
 * assigned driver, and admins — nobody else.
 */
const authorizeChannel = async (
  container: Container,
  channel: string,
  actor: { riderId?: string; driverId?: string; role: string },
): Promise<boolean> => {
  if (actor.role === 'admin') return true;

  if (channel === OPS_CHANNEL) return false;

  if (channel.startsWith('rider:')) {
    return channel === riderChannel(actor.riderId as never);
  }
  if (channel.startsWith('driver:')) {
    return channel === driverChannel(actor.driverId as never);
  }
  if (channel.startsWith('ride:')) {
    const rideId = channel.slice('ride:'.length);
    const ride = await container.repositories.rides.findById(rideId as never);
    if (!ride) return false;
    return (
      ride.riderId === actor.riderId ||
      (ride.assignment?.driverId !== undefined &&
        ride.assignment.driverId === actor.driverId)
    );
  }
  return false;
};

export { rideChannel };
