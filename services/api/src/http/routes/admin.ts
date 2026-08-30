/**
 * Operations console API.
 *
 * Read-mostly endpoints for watching the platform run: the live fleet, rides in
 * flight, dispatch diagnostics, and the levers an operator can pull.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { buildTimeline, rideDurations, type RideId } from '@lift/core';
import type { Container } from '../../container.js';
import { parse, requireAdmin } from '../plugins.js';

export const registerAdminRoutes = (app: FastifyInstance, container: Container): void => {
  /** Headline numbers for the ops dashboard. */
  app.get('/admin/overview', async (request) => {
    requireAdmin(request);
    const now = container.clock.now();
    const dayAgo = now - 86_400_000;

    const [fleet, searching, active, completedToday, cancelledToday] = await Promise.all([
      container.drivers.fleetSnapshot(),
      container.repositories.rides.findSearching(),
      container.repositories.rides.query({
        statuses: ['accepted', 'arrived', 'in_progress'],
        limit: 500,
      }),
      container.repositories.rides.count({ statuses: ['completed'], since: dayAgo }),
      container.repositories.rides.count({ statuses: ['cancelled'], since: dayAgo }),
    ]);

    return {
      at: now,
      fleet,
      rides: {
        searching: searching.length,
        inProgress: active.length,
        completedToday,
        cancelledToday,
      },
      dispatch: {
        activeSearches: container.dispatch.activeSearches(),
      },
      realtime: {
        connections: container.hub.connectionCount(),
        channels: container.hub.channelCount(),
      },
      config: {
        market: container.config.market.name,
        geoProvider: container.geo.id,
        surgeProvider: container.surge.id,
        dispatchStrategy: container.config.dispatch.strategy,
        store: container.server.store,
      },
    };
  });

  /** Every driver with a known position — the live map layer. */
  app.get('/admin/drivers', async (request) => {
    requireAdmin(request);
    const drivers = await container.repositories.drivers.list(500);
    return {
      drivers: await Promise.all(
        drivers.map(async (driver) => {
          const user = await container.repositories.users.findById(driver.userId);
          return {
            driverId: driver.id,
            name: user ? `${user.firstName} ${user.lastName}`.trim() : 'Unknown',
            availability: driver.availability,
            approvalStatus: driver.approvalStatus,
            position: driver.lastPosition,
            rating: driver.rating,
            totalRides: driver.totalRides,
            acceptanceRate: driver.acceptanceRate,
            currentRideId: driver.currentRideId,
          };
        }),
      ),
    };
  });

  /** Rides matching a filter, for the ops ride list. */
  app.get('/admin/rides', async (request) => {
    requireAdmin(request);
    const query = parse(
      z.object({
        status: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
        offset: z.coerce.number().int().min(0).default(0),
      }),
      request.query,
    );
    const rides = await container.repositories.rides.query({
      limit: query.limit,
      offset: query.offset,
      ...(query.status ? { statuses: query.status.split(',') as never } : {}),
    });
    return { rides };
  });

  /**
   * Everything known about one ride, including why dispatch made the choices
   * it did — the first thing an operator opens when a rider complains.
   */
  app.get('/admin/rides/:rideId', async (request) => {
    requireAdmin(request);
    const { rideId } = parse(z.object({ rideId: z.string() }), request.params);
    const ride = await container.rides.getRide(rideId as RideId);
    const [offers, charges] = await Promise.all([
      container.repositories.offers.findForRide(ride.id),
      container.payments.chargesForRide(ride.id),
    ]);

    return {
      ride,
      timeline: buildTimeline(ride),
      durations: rideDurations(ride),
      offers,
      charges,
      dispatch: container.dispatch.diagnosticsFor(ride.id) ?? null,
    };
  });

  /** Cancel a ride on a rider's behalf. */
  app.post('/admin/rides/:rideId/cancel', async (request) => {
    const actor = requireAdmin(request);
    const { rideId } = parse(z.object({ rideId: z.string() }), request.params);
    const { note } = parse(
      z.object({ note: z.string().max(300).optional() }),
      request.body ?? {},
    );
    const ride = await container.rides.cancelRide({
      rideId: rideId as RideId,
      by: { kind: 'admin', adminId: actor.userId },
      reason: 'admin_intervention',
      ...(note ? { note } : {}),
    });
    return { ride };
  });

  /** Approve or suspend a driver. */
  app.post('/admin/drivers/:driverId/approval', async (request) => {
    requireAdmin(request);
    const { driverId } = parse(z.object({ driverId: z.string() }), request.params);
    const { status } = parse(
      z.object({
        status: z.enum(['incomplete', 'pending_review', 'approved', 'suspended', 'rejected']),
      }),
      request.body,
    );
    const driver = await container.repositories.drivers.update(driverId as never, {
      approvalStatus: status,
      // A suspended driver comes off the road immediately.
      ...(status === 'suspended' ? { availability: 'offline' as const } : {}),
    });
    return { driver };
  });

  /** The surge heat map, when the configured provider can produce one. */
  app.get('/admin/surge', async (request) => {
    requireAdmin(request);
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

  /** The live configuration, so an operator can see what is actually running. */
  app.get('/admin/config', async (request) => {
    requireAdmin(request);
    return {
      config: container.config,
      providers: {
        geo: { id: container.geo.id, capabilities: container.geo.capabilities },
        surge: container.surge.id,
        placeSources: container.places.list().map((s) => s.id),
        rideTypes: container.catalog.listAll().map((t) => ({ id: t.id, enabled: t.enabled })),
      },
    };
  });
};
