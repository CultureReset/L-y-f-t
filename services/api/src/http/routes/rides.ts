/**
 * Rider-facing ride routes: quote, request, watch, cancel, rate.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  buildTimeline,
  money,
  placeSchema,
  rideDurations,
  waypointSchema,
  type Place,
  type RideId,
} from '@lift/core';
import type { Container } from '../../container.js';
import { parse, requireActor, requireRider } from '../plugins.js';

const quoteSchema = z.object({
  pickup: placeSchema,
  dropoff: placeSchema,
  stops: z.array(waypointSchema).max(3).default([]),
  passengerCount: z.number().int().min(1).max(8).default(1),
  scheduledFor: z.number().optional(),
  promoCode: z.string().max(40).optional(),
});

const requestSchema = z.object({
  rideTypeId: z.string().min(1),
  pickup: placeSchema,
  dropoff: placeSchema,
  stops: z.array(waypointSchema).max(3).default([]),
  passengerCount: z.number().int().min(1).max(8).default(1),
  paymentMethodId: z.string().optional(),
  riderNote: z.string().max(300).optional(),
  scheduledFor: z.number().optional(),
  quoteId: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const registerRideRoutes = (app: FastifyInstance, container: Container): void => {
  /** The classes of service this market offers. */
  app.get('/ride-types', async () => ({
    rideTypes: container.catalog.list().map((type) => ({
      id: type.id,
      name: type.name,
      tagline: type.tagline,
      description: type.description,
      icon: type.icon,
      maxPassengers: type.maxPassengers,
      badge: type.badge,
      shared: type.shared,
      displayOrder: type.displayOrder,
    })),
  }));

  /**
   * Price every ride type for one itinerary. This is what populates the
   * rider's picker, so it returns fares, ETAs, and the route in one call.
   */
  app.post('/rides/quote', async (request) => {
    const input = parse(quoteSchema, request.body);
    const bundle = await container.pricing.quote({
      itinerary: {
        pickup: input.pickup as Place,
        dropoff: input.dropoff as Place,
        stops: input.stops as never,
      },
      passengerCount: input.passengerCount,
      ...(input.scheduledFor ? { scheduledFor: input.scheduledFor } : {}),
    });

    return {
      quoteId: bundle.quoteId,
      expiresAt: bundle.expiresAt,
      route: {
        distanceMeters: bundle.route.distanceMeters,
        durationMs: bundle.route.durationInTrafficMs ?? bundle.route.durationMs,
        geometry: bundle.route.geometry,
        bounds: bundle.route.bounds,
      },
      quotes: bundle.quotes.map((quote) => ({
        rideTypeId: quote.rideType.id,
        name: quote.rideType.name,
        tagline: quote.rideType.tagline,
        icon: quote.rideType.icon,
        badge: quote.rideType.badge,
        maxPassengers: quote.rideType.maxPassengers,
        fare: quote.fare,
        pickupEtaMs: quote.pickupEtaMs,
        tripDurationMs: quote.tripDurationMs,
        tripDistanceMeters: quote.tripDistanceMeters,
        surgeMultiplier: quote.surgeMultiplier,
        available: quote.available,
        unavailableReason: quote.unavailableReason,
      })),
    };
  });

  /** Book a ride and start the search for a driver. */
  app.post('/rides', async (request) => {
    const riderId = requireRider(request);
    const input = parse(requestSchema, request.body);
    const ride = await container.rides.requestRide({
      riderId,
      rideTypeId: input.rideTypeId,
      pickup: input.pickup as Place,
      dropoff: input.dropoff as Place,
      stops: input.stops as never,
      passengerCount: input.passengerCount,
      ...(input.paymentMethodId ? { paymentMethodId: input.paymentMethodId } : {}),
      ...(input.riderNote ? { riderNote: input.riderNote } : {}),
      ...(input.scheduledFor ? { scheduledFor: input.scheduledFor } : {}),
      ...(input.quoteId ? { quoteId: input.quoteId } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
    });
    return { ride };
  });

  /** The rider's ride in flight, if any — polled on app launch. */
  app.get('/rides/active', async (request) => {
    const riderId = requireRider(request);
    const ride = await container.rides.activeRideForRider(riderId);
    if (!ride) return { ride: null };
    return { ride, ...(await rideExtras(container, ride.id)) };
  });

  app.get('/rides/history', async (request) => {
    const riderId = requireRider(request);
    const query = parse(
      z.object({
        limit: z.coerce.number().int().min(1).max(50).default(20),
        offset: z.coerce.number().int().min(0).default(0),
      }),
      request.query,
    );
    const rides = await container.rides.history({ riderId, ...query });
    return { rides };
  });

  app.get('/rides/:rideId', async (request) => {
    const actor = requireActor(request);
    const { rideId } = parse(z.object({ rideId: z.string() }), request.params);
    const ride = await container.rides.getRide(rideId as RideId);

    // A ride is visible only to its rider, its assigned driver, or an admin.
    // Both sides of each comparison must be defined: an anonymous-ish actor
    // with no driver profile must not match an unassigned ride's `undefined`.
    const permitted =
      actor.role === 'admin' ||
      (actor.riderId !== undefined && ride.riderId === actor.riderId) ||
      (actor.driverId !== undefined &&
        ride.assignment?.driverId === actor.driverId);
    if (!permitted) {
      return { ride: null, error: 'You do not have access to this ride' };
    }

    return {
      ride,
      timeline: buildTimeline(ride),
      durations: rideDurations(ride),
      ...(await rideExtras(container, ride.id)),
    };
  });

  /** What cancelling right now would cost. */
  app.get('/rides/:rideId/cancellation-preview', async (request) => {
    const riderId = requireRider(request);
    const { rideId } = parse(z.object({ rideId: z.string() }), request.params);
    return container.rides.previewCancellation(rideId as RideId, {
      kind: 'rider',
      riderId,
    });
  });

  app.post('/rides/:rideId/cancel', async (request) => {
    const riderId = requireRider(request);
    const { rideId } = parse(z.object({ rideId: z.string() }), request.params);
    const body = parse(
      z.object({
        reason: z
          .enum([
            'rider_changed_mind',
            'rider_wait_too_long',
            'rider_wrong_address',
            'driver_no_show',
            'safety_concern',
            'other',
          ])
          .default('other'),
        note: z.string().max(300).optional(),
      }),
      request.body ?? {},
    );

    const ride = await container.rides.cancelRide({
      rideId: rideId as RideId,
      by: { kind: 'rider', riderId },
      reason: body.reason,
      ...(body.note ? { note: body.note } : {}),
    });
    return { ride };
  });

  /** Rate the driver, optionally with a tip. */
  app.post('/rides/:rideId/rate', async (request) => {
    requireRider(request);
    const { rideId } = parse(z.object({ rideId: z.string() }), request.params);
    const body = parse(
      z.object({
        stars: z.number().int().min(1).max(5),
        comment: z.string().max(500).optional(),
        tags: z.array(z.string().max(40)).max(6).default([]),
        tipAmount: z.number().int().min(0).max(20_000).optional(),
      }),
      request.body,
    );

    const ride = await container.rides.rateRide({
      rideId: rideId as RideId,
      by: 'rider',
      stars: body.stars as 1 | 2 | 3 | 4 | 5,
      tags: body.tags,
      ...(body.comment ? { comment: body.comment } : {}),
      ...(body.tipAmount
        ? { tipAmount: money(body.tipAmount, container.config.market.currency) }
        : {}),
    });
    return { ride };
  });

  /** The receipt for a finished ride. */
  app.get('/rides/:rideId/receipt', async (request) => {
    const actor = requireActor(request);
    const { rideId } = parse(z.object({ rideId: z.string() }), request.params);
    const ride = await container.rides.getRide(rideId as RideId);
    if (ride.riderId !== actor.riderId && actor.role !== 'admin') {
      return { receipt: null };
    }
    const charges = await container.payments.chargesForRide(ride.id);
    return {
      receipt: {
        rideId: ride.id,
        status: ride.status,
        completedAt: ride.completedAt,
        pickup: ride.itinerary.pickup,
        dropoff: ride.itinerary.dropoff,
        fare: ride.finalFare ?? ride.quotedFare,
        durations: rideDurations(ride),
        charges: charges.map((c) => ({
          id: c.id,
          kind: c.kind,
          status: c.status,
          amount: c.amount,
        })),
      },
    };
  });

  // ------------------------------------------------------------------ chat

  app.get('/rides/:rideId/messages', async (request) => {
    requireActor(request);
    const { rideId } = parse(z.object({ rideId: z.string() }), request.params);
    return { messages: await container.chat.history(rideId as RideId) };
  });

  app.post('/rides/:rideId/messages', async (request) => {
    const actor = requireActor(request);
    const { rideId } = parse(z.object({ rideId: z.string() }), request.params);
    const { text } = parse(z.object({ text: z.string().min(1).max(500) }), request.body);
    const ride = await container.rides.getRide(rideId as RideId);
    const from = ride.riderId === actor.riderId ? 'rider' : 'driver';
    return { message: await container.chat.send({ rideId: rideId as RideId, from, text }) };
  });

  app.get('/rides/quick-replies', async (request) => {
    const actor = requireActor(request);
    return {
      replies: container.chat.quickReplies(actor.driverId ? 'driver' : 'rider'),
    };
  });
};

/** The driver and vehicle details a rider needs while a ride is live. */
const rideExtras = async (container: Container, rideId: RideId) => {
  const ride = await container.repositories.rides.findById(rideId);
  if (!ride?.assignment) return {};

  const [driver, vehicle] = await Promise.all([
    container.repositories.drivers.findById(ride.assignment.driverId),
    container.repositories.vehicles.findById(ride.assignment.vehicleId),
  ]);
  if (!driver) return {};
  const user = await container.repositories.users.findById(driver.userId);

  return {
    driver: {
      driverId: driver.id,
      // Riders see a first name and initial, never full contact details.
      name: user ? `${user.firstName} ${user.lastName.charAt(0)}.`.trim() : 'Your driver',
      avatarUrl: user?.avatarUrl,
      rating: driver.rating,
      totalRides: driver.totalRides,
      memberSince: driver.memberSince,
      position: driver.lastPosition,
    },
    vehicle: vehicle
      ? {
          make: vehicle.make,
          model: vehicle.model,
          color: vehicle.color,
          licensePlate: vehicle.licensePlate,
          photoUrl: vehicle.photoUrl,
        }
      : undefined,
  };
};
