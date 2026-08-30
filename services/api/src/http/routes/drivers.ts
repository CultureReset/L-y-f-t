/**
 * Driver-facing routes: going online, location pings, offers, the trip
 * lifecycle, earnings, vehicles, and documents.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  AppError,
  DRIVER_DOCUMENT_TYPES,
  currentLeg,
  disputableRatings,
  driverPreferencesSchema,
  money,
  summarizeRatings,
  positionSchema,
  vehicleSchema,
  type OfferId,
  type Position,
  type RideId,
  type VehicleId,
} from '@lift/core';
import type { Container } from '../../container.js';
import { parse, rateLimit, requireDriver } from '../plugins.js';

export const registerDriverRoutes = (app: FastifyInstance, container: Container): void => {
  /** Everything the driver home screen needs, in one call. */
  app.get('/driver/status', async (request) => {
    const driverId = requireDriver(request);
    return container.drivers.getStatus(driverId);
  });

  app.post('/driver/online', async (request) => {
    const driverId = requireDriver(request);
    const body = parse(
      z.object({ position: positionSchema.optional() }),
      request.body ?? {},
    );
    const position = body.position
      ? ({ ...body.position, timestamp: body.position.timestamp ?? Date.now() } as Position)
      : undefined;
    return { driver: await container.drivers.goOnline(driverId, position) };
  });

  app.post('/driver/offline', async (request) => {
    const driverId = requireDriver(request);
    return { driver: await container.drivers.goOffline(driverId) };
  });

  /** A soft pause: stay online, stop receiving offers. */
  app.post('/driver/busy', async (request) => {
    const driverId = requireDriver(request);
    const { busy } = parse(z.object({ busy: z.boolean() }), request.body);
    return { driver: await container.drivers.setBusy(driverId, busy) };
  });

  /**
   * Location ping. The highest-frequency endpoint in the platform, so it
   * returns nothing but an acknowledgement.
   */
  app.post('/driver/location', async (request) => {
    const driverId = requireDriver(request);
    const body = parse(positionSchema, request.body);
    await container.drivers.updateLocation(driverId, {
      ...body,
      timestamp: body.timestamp ?? Date.now(),
    } as Position);
    return { ok: true };
  });

  // ---------------------------------------------------------------- offers

  app.get('/driver/offers', async (request) => {
    const driverId = requireDriver(request);
    return { offers: await container.drivers.pendingOffers(driverId) };
  });

  app.post('/driver/offers/:offerId/accept', async (request) => {
    const driverId = requireDriver(request);
    const { offerId } = parse(z.object({ offerId: z.string() }), request.params);
    const ride = await container.drivers.acceptOffer(driverId, offerId as OfferId);
    return { ride };
  });

  app.post('/driver/offers/:offerId/decline', async (request) => {
    const driverId = requireDriver(request);
    const { offerId } = parse(z.object({ offerId: z.string() }), request.params);
    await container.drivers.declineOffer(driverId, offerId as OfferId);
    return { ok: true };
  });

  // --------------------------------------------------------- the trip flow

  app.get('/driver/rides/active', async (request) => {
    const driverId = requireDriver(request);
    const ride = await container.rides.activeRideForDriver(driverId);
    if (!ride) return { ride: null };
    return { ride, ...(await riderDetails(container, ride.riderId)) };
  });

  app.post('/driver/rides/:rideId/arrived', async (request) => {
    const driverId = requireDriver(request);
    const { rideId } = parse(z.object({ rideId: z.string() }), request.params);
    return { ride: await container.rides.markArrived(rideId as RideId, driverId) };
  });

  app.post('/driver/rides/:rideId/start', async (request) => {
    const driverId = requireDriver(request);
    const { rideId } = parse(z.object({ rideId: z.string() }), request.params);
    return { ride: await container.rides.startTrip(rideId as RideId, driverId) };
  });

  app.post('/driver/rides/:rideId/complete', async (request) => {
    const driverId = requireDriver(request);
    const { rideId } = parse(z.object({ rideId: z.string() }), request.params);
    // The device's own odometer beats the planned route when it is available.
    const actuals = parse(
      z.object({
        distanceMeters: z.number().min(0).optional(),
        durationMs: z.number().min(0).optional(),
      }),
      request.body ?? {},
    );
    return { ride: await container.rides.completeTrip(rideId as RideId, driverId, actuals) };
  });

  app.post('/driver/rides/:rideId/cancel', async (request) => {
    const driverId = requireDriver(request);
    const { rideId } = parse(z.object({ rideId: z.string() }), request.params);
    const body = parse(
      z.object({
        reason: z
          .enum(['rider_no_show', 'driver_vehicle_issue', 'safety_concern', 'other'])
          .default('other'),
        note: z.string().max(300).optional(),
      }),
      request.body ?? {},
    );
    const ride = await container.rides.cancelRide({
      rideId: rideId as RideId,
      by: { kind: 'driver', driverId },
      reason: body.reason,
      ...(body.note ? { note: body.note } : {}),
    });
    return { ride };
  });

  /** Re-route from where the driver actually is, after a detour or a miss. */
  app.post('/driver/rides/:rideId/reroute', async (request) => {
    requireDriver(request);
    const { rideId } = parse(z.object({ rideId: z.string() }), request.params);
    const from = parse(
      z.object({ lat: z.number(), lng: z.number() }),
      request.body,
    );
    return { ride: await container.rides.refreshRoute(rideId as RideId, from) };
  });

  /**
   * Turn-by-turn for the leg the driver is on now.
   *
   * Computed on demand rather than stored with the ride: steps are large, they
   * go stale the moment the driver deviates, and the app asks for them again
   * anyway. `from` lets the app re-route from where it actually is.
   */
  app.get('/driver/rides/:rideId/navigation', async (request) => {
    const driverId = requireDriver(request);
    const { rideId } = parse(z.object({ rideId: z.string() }), request.params);
    const query = parse(
      z.object({ lat: z.coerce.number().optional(), lng: z.coerce.number().optional() }),
      request.query,
    );

    const ride = await container.rides.getRide(rideId as RideId);
    // Both sides must be defined: an unassigned ride must not be navigable by
    // whoever asks first.
    if (ride.assignment === undefined || ride.assignment.driverId !== driverId) {
      throw new AppError('forbidden', 'That ride is not yours');
    }

    const leg = currentLeg(ride);
    if (!leg) return { steps: [], leg: null };

    const from =
      query.lat !== undefined && query.lng !== undefined
        ? { lat: query.lat, lng: query.lng }
        : leg.from;

    if (!container.geo.route) {
      throw new AppError('provider_unavailable', 'The configured geo provider cannot route', {
        userMessage: 'Turn-by-turn is not available here. Use your own maps app.',
      });
    }

    const route = await container.geo.route({
      waypoints: [from, leg.to],
      steps: true,
    });

    // Steps live on the route's legs; a single-waypoint-pair route has one.
    const steps = route.legs.flatMap((routeLeg) => routeLeg.steps);

    return {
      leg: {
        kind: leg.kind,
        to: leg.to,
        destinationName:
          leg.kind === 'to_pickup'
            ? ride.itinerary.pickup.name
            : ride.itinerary.dropoff.name,
        destinationAddress:
          leg.kind === 'to_pickup'
            ? ride.itinerary.pickup.address
            : ride.itinerary.dropoff.address,
      },
      steps,
      distanceMeters: route.distanceMeters,
      durationMs: route.durationInTrafficMs ?? route.durationMs,
      geometry: route.geometry,
    };
  });

  app.post('/driver/rides/:rideId/rate', async (request) => {
    requireDriver(request);
    const { rideId } = parse(z.object({ rideId: z.string() }), request.params);
    const body = parse(
      z.object({
        stars: z.number().int().min(1).max(5),
        comment: z.string().max(500).optional(),
        tags: z.array(z.string().max(40)).max(6).default([]),
      }),
      request.body,
    );
    const ride = await container.rides.rateRide({
      rideId: rideId as RideId,
      by: 'driver',
      stars: body.stars as 1 | 2 | 3 | 4 | 5,
      tags: body.tags,
      ...(body.comment ? { comment: body.comment } : {}),
    });
    return { ride };
  });

  // ----------------------------------------------------------- preferences

  app.patch('/driver/preferences', async (request) => {
    const driverId = requireDriver(request);
    const patch = parse(driverPreferencesSchema.partial(), request.body);
    return { driver: await container.drivers.updatePreferences(driverId, patch) };
  });

  /** Filter for rides heading toward a destination — the "last ride home". */
  app.put('/driver/destination-filter', async (request) => {
    const driverId = requireDriver(request);
    const body = parse(
      z.object({
        address: z.string().min(1).max(200),
        lat: z.number(),
        lng: z.number(),
        radiusMeters: z.number().min(500).max(50_000).optional(),
        durationMs: z.number().min(60_000).max(8 * 3_600_000).optional(),
      }),
      request.body,
    );
    return { driver: await container.drivers.setDestinationFilter(driverId, body) };
  });

  app.delete('/driver/destination-filter', async (request) => {
    const driverId = requireDriver(request);
    return { driver: await container.drivers.setDestinationFilter(driverId, null) };
  });

  // -------------------------------------------------------------- vehicles

  app.get('/driver/vehicles', async (request) => {
    const driverId = requireDriver(request);
    return { vehicles: await container.drivers.listVehicles(driverId) };
  });

  app.post('/driver/vehicles', async (request) => {
    const driverId = requireDriver(request);
    const input = parse(vehicleSchema, request.body);
    const vehicle = await container.drivers.addVehicle(driverId, input);
    const profile = await container.drivers.getProfile(driverId);
    return {
      vehicle,
      // Tell the driver immediately which tiers this vehicle unlocks.
      qualification: container.drivers.qualification(vehicle, profile.rating).map((q) => ({
        rideTypeId: q.rideType.id,
        name: q.rideType.name,
        qualifies: q.qualifies,
      })),
    };
  });

  app.post('/driver/vehicles/:vehicleId/activate', async (request) => {
    const driverId = requireDriver(request);
    const { vehicleId } = parse(z.object({ vehicleId: z.string() }), request.params);
    return {
      driver: await container.drivers.setActiveVehicle(driverId, vehicleId as VehicleId),
    };
  });

  // ------------------------------------------------------------- documents

  app.post('/driver/documents', async (request) => {
    const driverId = requireDriver(request);
    const body = parse(
      z.object({
        type: z.enum(DRIVER_DOCUMENT_TYPES),
        fileUrl: z.string().url().optional(),
        expiresAt: z.number().optional(),
      }),
      request.body,
    );
    const driver = await container.drivers.submitDocument(driverId, {
      type: body.type,
      // Uploads land as pending until reviewed; nothing self-approves.
      status: 'pending',
      ...(body.fileUrl ? { fileUrl: body.fileUrl } : {}),
      ...(body.expiresAt ? { expiresAt: body.expiresAt } : {}),
    });
    return { driver };
  });

  // -------------------------------------------------------------- earnings

  app.get('/driver/earnings', async (request) => {
    const driverId = requireDriver(request);
    const query = parse(
      z.object({
        period: z.enum(['today', 'week', 'month', 'custom']).default('today'),
        since: z.coerce.number().optional(),
        until: z.coerce.number().optional(),
      }),
      request.query,
    );

    const now = container.clock.now();
    const { since, until } = resolvePeriod(query, now);
    const summary = await container.drivers.earnings(driverId, since, until);
    const rides = await container.repositories.rides.query({
      driverId,
      statuses: ['completed'],
      since,
      until,
      limit: 100,
    });

    return {
      summary,
      rides: rides.map((ride) => ({
        rideId: ride.id,
        completedAt: ride.completedAt,
        pickup: ride.itinerary.pickup.name,
        dropoff: ride.itinerary.dropoff.name,
        payout: ride.finalFare?.driverPayout,
        distanceMeters: ride.finalFare?.distanceMeters,
        rating: ride.driverRating?.stars,
      })),
    };
  });

  // ---------------------------------------------------------------- ratings

  /**
   * How the rating is made up. A driver can act on "three riders mentioned the
   * route"; they cannot act on "4.87".
   */
  app.get('/driver/ratings', async (request) => {
    const driverId = requireDriver(request);
    const rides = await container.repositories.rides.query({
      driverId,
      statuses: ['completed'],
      limit: 500,
    });

    const rated = rides
      .filter((ride) => ride.driverRating !== undefined)
      .map((ride) => ({
        rideId: ride.id,
        at: ride.driverRating!.submittedAt,
        rating: ride.driverRating!,
      }));

    return {
      breakdown: summarizeRatings(rated, { now: container.clock.now() }),
      disputable: disputableRatings(rated).map((trip) => trip.rideId),
      // Only ratings that came with something to read; a bare star is noise here.
      comments: rated
        .filter((trip) => (trip.rating.comment ?? '').trim().length > 0)
        .sort((a, b) => b.at - a.at)
        .slice(0, 20)
        .map((trip) => ({
          rideId: trip.rideId,
          stars: trip.rating.stars,
          comment: trip.rating.comment,
          tags: trip.rating.tags,
          at: trip.at,
        })),
    };
  });

  // ---------------------------------------------------------------- payouts

  app.get('/driver/payouts', async (request) => {
    const driverId = requireDriver(request);
    const [balance, history, destinations] = await Promise.all([
      container.payouts.balance(driverId),
      container.payouts.history(driverId),
      container.payouts.destinations(driverId),
    ]);
    return {
      balance,
      payouts: history,
      // Never return the gateway token to a client.
      destinations: destinations.map(({ gatewayToken: _omitted, ...safe }) => safe),
      policy: container.payouts.policy,
    };
  });

  /** Price a cash out without taking it — what the confirm sheet shows. */
  app.post('/driver/payouts/quote', async (request) => {
    const driverId = requireDriver(request);
    const body = parse(z.object({ amount: z.number().int().min(1) }), request.body);
    return {
      quote: await container.payouts.quote(
        driverId,
        money(body.amount, container.config.market.currency),
      ),
    };
  });

  app.post(
    '/driver/payouts/cashout',
    {
      // A double-tapped cash out must not become two.
      preHandler: rateLimit({
        windowMs: 30_000,
        max: 2,
        keyBy: (request) => request.actor?.driverId ?? request.ip,
      }),
    },
    async (request) => {
      const driverId = requireDriver(request);
      const body = parse(z.object({ amount: z.number().int().min(1) }), request.body);
      return {
        payout: await container.payouts.cashOut(
          driverId,
          money(body.amount, container.config.market.currency),
        ),
      };
    },
  );

  app.post('/driver/payouts/destinations', async (request) => {
    const driverId = requireDriver(request);
    const body = parse(
      z.object({
        label: z.string().min(1).max(60),
        gatewayToken: z.string().max(200).optional(),
        makeDefault: z.boolean().optional(),
      }),
      request.body,
    );
    const { gatewayToken: _omitted, ...destination } = await container.payouts.addDestination(
      driverId,
      body,
    );
    return { destination };
  });

  app.delete('/driver/payouts/destinations/:destinationId', async (request) => {
    const driverId = requireDriver(request);
    const { destinationId } = request.params as { destinationId: string };
    await container.payouts.removeDestination(driverId, destinationId);
    return { ok: true };
  });

  // ----------------------------------------------------------------- demand

  /**
   * Where the demand is. The same heat map the ops console sees, exposed to
   * drivers because deciding where to sit is the main thing they do between
   * trips — and hiding it only leaves them guessing.
   */
  app.get('/driver/demand', async (request) => {
    requireDriver(request);
    if (!container.surge.heatmap) return { cells: [], provider: container.surge.id };
    const bounds = parse(
      z.object({
        south: z.coerce.number(),
        west: z.coerce.number(),
        north: z.coerce.number(),
        east: z.coerce.number(),
      }),
      request.query,
    );
    return { cells: await container.surge.heatmap(bounds), provider: container.surge.id };
  });
};

const resolvePeriod = (
  query: { period: string; since?: number; until?: number },
  now: number,
): { since: number; until: number } => {
  if (query.period === 'custom' && query.since !== undefined) {
    return { since: query.since, until: query.until ?? now };
  }
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  switch (query.period) {
    case 'week':
      return { since: startOfToday.getTime() - 6 * 86_400_000, until: now };
    case 'month':
      return { since: startOfToday.getTime() - 29 * 86_400_000, until: now };
    default:
      return { since: startOfToday.getTime(), until: now };
  }
};

/** The rider details a driver is shown — a first name and a rating, no more. */
const riderDetails = async (container: Container, riderId: string) => {
  const rider = await container.repositories.riders.findById(riderId as never);
  if (!rider) return {};
  const user = await container.repositories.users.findById(rider.userId);
  return {
    rider: {
      riderId: rider.id,
      name: user ? `${user.firstName} ${user.lastName.charAt(0)}.`.trim() : 'Your rider',
      avatarUrl: user?.avatarUrl,
      rating: rider.rating,
      totalRides: rider.totalRides,
    },
  };
};
