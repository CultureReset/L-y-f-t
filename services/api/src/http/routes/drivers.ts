/**
 * Driver-facing routes: going online, location pings, offers, the trip
 * lifecycle, earnings, vehicles, and documents.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  DRIVER_DOCUMENT_TYPES,
  driverPreferencesSchema,
  positionSchema,
  vehicleSchema,
  type OfferId,
  type Position,
  type RideId,
  type VehicleId,
} from '@lift/core';
import type { Container } from '../../container.js';
import { parse, requireDriver } from '../plugins.js';

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
