/**
 * The API test harness.
 *
 * Builds the entire platform in one process: in-memory store, mock geo, a
 * hand-driven clock, and a Fastify instance exercised through `inject` rather
 * than a socket. Every test therefore runs the real routes, the real services,
 * the real dispatcher and the real state machine — nothing stubbed, and nothing
 * that depends on wall-clock timing.
 */

import { ManualClock, loadPlatformConfig, type PlatformConfig } from '@lift/core';
import { MockGeoProvider } from '@lift/geo';
import type { FastifyInstance } from 'fastify';
import { createContainer, type Container } from '../container.js';
import { buildServer } from '../server.js';
import { createMemoryRepositories } from '../repositories/memory/index.js';
import type { ServerConfig } from '../config/env.js';
import { recordingPushTransport } from '../services/notificationService.js';
import { seedDemoData, type SeedOptions } from '../seed.js';

export const T0 = 1_700_000_000_000;

export interface Harness {
  readonly app: FastifyInstance;
  readonly container: Container;
  readonly clock: ManualClock;
  readonly push: ReturnType<typeof recordingPushTransport>;
  /** Advance time and let the dispatch loop react to it. */
  advance(ms: number): Promise<void>;
  close(): Promise<void>;
}

export interface HarnessOptions {
  readonly config?: Record<string, unknown>;
  readonly seed?: SeedOptions | false;
  readonly declineRate?: number;
}

const serverConfig: ServerConfig = {
  host: '127.0.0.1',
  port: 0,
  logLevel: 'silent',
  corsOrigins: true,
  store: 'memory',
  nodeEnv: 'test',
  seedOnBoot: false,
  devAuthCode: '000000',
};

export const createHarness = async (options: HarnessOptions = {}): Promise<Harness> => {
  const clock = new ManualClock(T0);
  const push = recordingPushTransport();

  const overrides = (options.config ?? {}) as Record<string, Record<string, unknown>>;
  const config: PlatformConfig = loadPlatformConfig({
    ...overrides,
    // Dispatch is driven by hand in tests, never by a timer.
    dispatch: { ...overrides.dispatch, tickIntervalMs: 60_000 },
    geo: { provider: 'mock', ...overrides.geo },
    payments: {
      gateway: 'memory',
      simulatedDeclineRate: options.declineRate ?? 0,
      ...overrides.payments,
    },
  });

  const container = await createContainer(config, serverConfig, {
    clock,
    repositories: createMemoryRepositories(clock),
    // Traffic simulation reads the wall clock, so it stays off in tests.
    geo: new MockGeoProvider({ simulateTraffic: false }),
    pushTransport: push,
  });

  // Realtime and notifications are wired up; only the dispatch timer is not.
  container.hub.start();
  container.notifications.start();

  if (options.seed !== false) {
    await seedDemoData(container, { driverCount: 6, seed: 7, ...options.seed });
  }

  const app = await buildServer(container);
  await app.ready();

  return {
    app,
    container,
    clock,
    push,
    async advance(ms: number) {
      clock.advance(ms);
      await container.dispatch.tick();
    },
    async close() {
      await app.close();
      await container.stop();
    },
  };
};

/** Sign in and return a bearer token plus whichever profile ids it carries. */
export const signIn = async (
  harness: Harness,
  phone: string,
  role: 'rider' | 'driver' = 'rider',
  extra: { firstName?: string; lastName?: string } = {},
): Promise<{ token: string; riderId?: string; driverId?: string }> => {
  await harness.app.inject({ method: 'POST', url: '/v1/auth/code', payload: { phone } });
  const response = await harness.app.inject({
    method: 'POST',
    url: '/v1/auth/verify',
    payload: { phone, code: '000000', role, ...extra },
  });
  const body = response.json();
  if (!body.token) {
    throw new Error(`Sign-in failed: ${response.statusCode} ${response.body}`);
  }
  return { token: body.token, riderId: body.riderId, driverId: body.driverId };
};

const auth = (token: string): Record<string, string> => ({
  authorization: `Bearer ${token}`,
});

/** Request helpers that carry a bearer token. */
export const asUser = (harness: Harness, token: string) => ({
  get: (url: string) => harness.app.inject({ method: 'GET', url, headers: auth(token) }),
  post: (url: string, payload?: unknown) =>
    harness.app.inject({ method: 'POST', url, payload: payload ?? {}, headers: auth(token) }),
  patch: (url: string, payload?: unknown) =>
    harness.app.inject({ method: 'PATCH', url, payload: payload ?? {}, headers: auth(token) }),
  put: (url: string, payload?: unknown) =>
    harness.app.inject({ method: 'PUT', url, payload: payload ?? {}, headers: auth(token) }),
  delete: (url: string) =>
    harness.app.inject({ method: 'DELETE', url, headers: auth(token) }),
});

/** The two landmarks the tests book between. */
export const FERRY_BUILDING = {
  id: 'plc_ferry',
  name: 'Ferry Building',
  address: '1 Ferry Building, San Francisco, CA 94111',
  coordinates: { lat: 37.7955, lng: -122.3937 },
  category: 'venue' as const,
  source: 'seed' as const,
};

export const DOLORES_PARK = {
  id: 'plc_dolores',
  name: 'Mission Dolores Park',
  address: 'Dolores St & 19th St, San Francisco, CA 94114',
  coordinates: { lat: 37.7596, lng: -122.4269 },
  category: 'venue' as const,
  source: 'seed' as const,
};

/**
 * Find whichever seeded driver currently holds a pending offer and sign in as
 * them. Dispatch picks the best driver, so a test cannot know in advance which
 * one that will be — and should not care.
 */
export const driverWithPendingOffer = async (
  harness: Harness,
  rideId: string,
): Promise<{ token: string; driverId: string; offerId: string }> => {
  const offers = await harness.container.repositories.offers.findForRide(rideId as never);
  const pending = offers.find((o) => o.status === 'pending');
  if (!pending) throw new Error(`No pending offer for ride ${rideId}`);

  const driver = await harness.container.repositories.drivers.findById(pending.driverId);
  if (!driver) throw new Error('Offer references an unknown driver');
  const user = await harness.container.repositories.users.findById(driver.userId);
  if (!user) throw new Error('Driver has no user record');

  const { token } = await signIn(harness, user.phone, 'driver');
  return { token, driverId: driver.id, offerId: pending.id };
};

/** Book a standard ride between the two landmarks and return the ride id. */
export const bookStandardRide = async (
  harness: Harness,
  riderToken: string,
  overrides: Record<string, unknown> = {},
): Promise<{ rideId: string; body: { ride: Record<string, unknown> } }> => {
  const response = await asUser(harness, riderToken).post('/v1/rides', {
    rideTypeId: 'standard',
    pickup: FERRY_BUILDING,
    dropoff: DOLORES_PARK,
    passengerCount: 1,
    ...overrides,
  });
  const body = response.json();
  if (!body.ride) {
    throw new Error(`Booking failed: ${response.statusCode} ${response.body}`);
  }
  return { rideId: body.ride.id, body };
};

/**
 * Drive a ride from request all the way to completed, returning the tokens and
 * ids involved. The shortest path to "I need a finished ride to test against".
 */
export const completeRide = async (
  harness: Harness,
  riderToken: string,
): Promise<{ rideId: string; driverToken: string; driverId: string }> => {
  const { rideId } = await bookStandardRide(harness, riderToken);
  const { token: driverToken, driverId } = await driverWithPendingOffer(harness, rideId);
  const driver = asUser(harness, driverToken);

  await driver.post(`/v1/driver/offers/${(await driverWithPendingOffer(harness, rideId)).offerId}/accept`);
  await harness.advance(60_000);
  await driver.post(`/v1/driver/rides/${rideId}/arrived`);
  await harness.advance(60_000);
  await driver.post(`/v1/driver/rides/${rideId}/start`);
  await harness.advance(10 * 60_000);
  await driver.post(`/v1/driver/rides/${rideId}/complete`);

  return { rideId, driverToken, driverId };
};
