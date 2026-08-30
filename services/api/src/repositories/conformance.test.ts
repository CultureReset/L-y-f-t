/**
 * Repository conformance.
 *
 * One suite, run against every store. This is what makes "swap the database"
 * a real claim rather than a hopeful one: the in-memory store and PostgreSQL
 * must be indistinguishable through the ports, including the subtle parts —
 * optimistic concurrency, the radius query, payment idempotency.
 *
 * The Postgres pass is skipped when no TEST_DATABASE_URL is configured, so the
 * suite stays runnable anywhere.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  T0,
  SF_PLACES,
  makeDriverProfile,
  makeRide,
  makeRiderProfile,
  makeUser,
  makeVehicle,
  newChargeId,
  newDriverId,
  newMessageId,
  newOfferId,
  newPaymentMethodId,
  newPlaceId,
  newRiderId,
  newPayoutId,
  newSessionId,
  newTicketId,
  newUserId,
  newVehicleId,
  destination,
  fromDecimal,
  type DriverProfile,
  type Position,
  type RiderId,
  type SessionId,
  type Payout,
  type SupportTicket,
  type UserId,
} from '@lift/core';
import type { Repositories } from './types.js';
import { createMemoryRepositories } from './memory/index.js';
import { createPostgresRepositories } from './postgres/index.js';

const positionAt = (lat: number, lng: number, at = T0): Position => ({
  lat,
  lng,
  timestamp: at,
});

/** Place a driver a set distance north of the Ferry Building. */
const driverNorthOfFerry = async (
  repos: Repositories,
  meters: number,
  overrides: Partial<DriverProfile> = {},
): Promise<DriverProfile> => {
  const user = await repos.users.create(makeUser({ phone: uniquePhone(), roles: ['driver'] }));
  const coords = destination(SF_PLACES.ferryBuilding, 0, meters);
  return repos.drivers.create(
    makeDriverProfile({
      userId: user.id,
      lastPosition: positionAt(coords.lat, coords.lng),
      ...overrides,
    }),
  );
};

let phoneCounter = 0;
const uniquePhone = (): string => `+1415555${String(1000 + phoneCounter++).slice(-4)}`;

const suites: { name: string; create: () => Promise<Repositories> | Repositories; skip: boolean }[] = [
  { name: 'memory', create: createMemoryRepositories, skip: false },
  {
    name: 'postgres',
    skip: !process.env.TEST_DATABASE_URL,
    create: async () => {
      const repos = await createPostgresRepositories({
        connectionString: process.env.TEST_DATABASE_URL!,
      });
      // Each run starts from a clean database.
      const pg = await import('pg');
      const pool = new pg.default.Pool({ connectionString: process.env.TEST_DATABASE_URL! });
      await pool.query(
        `TRUNCATE push_tokens, payouts, payout_destinations, support_tickets,
                  promo_redemptions,
                  chat_messages, charges,
                  payment_methods, offers, rides, shifts, vehicles, drivers,
                  riders, verifications, sessions, users RESTART IDENTITY CASCADE`,
      );
      await pool.end();
      return repos;
    },
  },
];

for (const suite of suites) {
  describe.skipIf(suite.skip)(`${suite.name} repositories`, () => {
    let repos: Repositories;

    beforeAll(async () => {
      repos = await suite.create();
    });

    afterAll(async () => {
      await repos.close();
    });

    describe('users', () => {
      it('creates, finds by id and by phone, and updates', async () => {
        const phone = uniquePhone();
        const user = await repos.users.create(makeUser({ phone }));
        expect(await repos.users.findById(user.id)).toMatchObject({ id: user.id, phone });
        expect(await repos.users.findByPhone(phone)).toMatchObject({ id: user.id });

        const updated = await repos.users.update(user.id, { firstName: 'Jordan' });
        expect(updated.firstName).toBe('Jordan');
        expect((await repos.users.findById(user.id))!.firstName).toBe('Jordan');
      });

      it('returns undefined for an unknown id', async () => {
        expect(await repos.users.findById(newUserId())).toBeUndefined();
      });

      it('refuses a duplicate phone number', async () => {
        const phone = uniquePhone();
        await repos.users.create(makeUser({ phone }));
        await expect(repos.users.create(makeUser({ phone }))).rejects.toThrow();
      });
    });

    describe('sessions', () => {
      it('round-trips a token and revokes it', async () => {
        const user = await repos.users.create(makeUser({ phone: uniquePhone() }));
        const token = `tok_${Math.random().toString(36).slice(2)}`;
        await repos.sessions.create({
          id: newSessionId(),
          token,
          userId: user.id,
          role: 'rider',
          createdAt: Date.now(),
          lastSeenAt: Date.now(),
          expiresAt: Date.now() + 60_000,
        });
        expect(await repos.sessions.findByToken(token)).toMatchObject({ userId: user.id });
        await repos.sessions.revoke(token);
        expect(await repos.sessions.findByToken(token)).toBeUndefined();
      });

      it('treats an expired session as absent', async () => {
        const user = await repos.users.create(makeUser({ phone: uniquePhone() }));
        const token = `tok_${Math.random().toString(36).slice(2)}`;
        await repos.sessions.create({
          id: newSessionId(),
          token,
          userId: user.id,
          role: 'rider',
          createdAt: Date.now() - 10_000,
          lastSeenAt: Date.now() - 10_000,
          expiresAt: Date.now() - 1,
        });
        expect(await repos.sessions.findByToken(token)).toBeUndefined();
      });

      it('revokes every session a user holds', async () => {
        const user = await repos.users.create(makeUser({ phone: uniquePhone() }));
        const tokens = ['a', 'b', 'c'].map((s) => `tok_${s}_${Math.random()}`);
        for (const token of tokens) {
          await repos.sessions.create({
            id: newSessionId(),
            token,
            userId: user.id,
            role: 'rider',
            createdAt: Date.now(),
            lastSeenAt: Date.now(),
            expiresAt: Date.now() + 60_000,
          });
        }
        await repos.sessions.revokeAllForUser(user.id);
        for (const token of tokens) {
          expect(await repos.sessions.findByToken(token)).toBeUndefined();
        }
      });
    });

    describe('verifications', () => {
      it('stores, counts attempts against, and clears a code', async () => {
        const phone = uniquePhone();
        await repos.verifications.put({
          phone,
          code: '123456',
          expiresAt: Date.now() + 60_000,
          attempts: 0,
        });
        expect((await repos.verifications.get(phone))!.code).toBe('123456');

        await repos.verifications.incrementAttempts(phone);
        expect((await repos.verifications.get(phone))!.attempts).toBe(1);

        await repos.verifications.clear(phone);
        expect(await repos.verifications.get(phone)).toBeUndefined();
      });

      it('replaces a pending code rather than accumulating them', async () => {
        const phone = uniquePhone();
        await repos.verifications.put({ phone, code: '111111', expiresAt: Date.now() + 60_000, attempts: 0 });
        await repos.verifications.put({ phone, code: '222222', expiresAt: Date.now() + 60_000, attempts: 0 });
        expect((await repos.verifications.get(phone))!.code).toBe('222222');
      });
    });

    describe('riders', () => {
      let riderId: RiderId;

      beforeEach(async () => {
        const user = await repos.users.create(makeUser({ phone: uniquePhone() }));
        const rider = await repos.riders.create(makeRiderProfile({ userId: user.id }));
        riderId = rider.id;
      });

      it('saves and removes a saved place', async () => {
        const placeId = newPlaceId();
        const withHome = await repos.riders.addSavedPlace(riderId, {
          id: placeId,
          label: 'Home',
          icon: 'home',
          place: {
            id: newPlaceId(),
            name: '123 Main St',
            address: '123 Main St, San Francisco, CA',
            coordinates: SF_PLACES.castro,
            category: 'home',
            source: 'saved',
          },
          createdAt: T0,
        });
        expect(withHome.savedPlaces).toHaveLength(1);

        const removed = await repos.riders.removeSavedPlace(riderId, placeId);
        expect(removed.savedPlaces).toHaveLength(0);
      });

      it('replaces a saved place with the same label instead of duplicating it', async () => {
        const make = (name: string) => ({
          id: newPlaceId(),
          label: 'Home',
          icon: 'home' as const,
          place: {
            id: newPlaceId(),
            name,
            address: `${name}, San Francisco, CA`,
            coordinates: SF_PLACES.castro,
            category: 'home' as const,
            source: 'saved' as const,
          },
          createdAt: T0,
        });
        await repos.riders.addSavedPlace(riderId, make('Old address'));
        const profile = await repos.riders.addSavedPlace(riderId, make('New address'));
        expect(profile.savedPlaces).toHaveLength(1);
        expect(profile.savedPlaces[0]!.place.name).toBe('New address');
      });

      it('derives recent places from completed rides, most recent first', async () => {
        const dropoff = (name: string, coords: { lat: number; lng: number }) => ({
          id: newPlaceId(),
          name,
          address: `${name}, San Francisco, CA`,
          coordinates: coords,
          category: 'address' as const,
          source: 'seed' as const,
        });

        for (const [index, place] of [
          dropoff('First stop', SF_PLACES.castro),
          dropoff('Second stop', SF_PLACES.chinatown),
        ].entries()) {
          const ride = makeRide({
            riderId,
            status: 'completed',
            createdAt: T0 + index * 1000,
            updatedAt: T0 + index * 1000,
          });
          await repos.rides.create({
            ...ride,
            itinerary: { ...ride.itinerary, dropoff: place },
          });
        }

        const recents = await repos.riders.recentPlaces(riderId, 5);
        expect(recents.map((p) => p.name)).toContain('Second stop');
        expect(recents.length).toBeGreaterThanOrEqual(2);
      });
    });

    describe('drivers', () => {
      it('creates and updates a profile', async () => {
        const user = await repos.users.create(makeUser({ phone: uniquePhone(), roles: ['driver'] }));
        const driver = await repos.drivers.create(makeDriverProfile({ userId: user.id }));
        expect(await repos.drivers.findByUserId(user.id)).toMatchObject({ id: driver.id });

        const updated = await repos.drivers.update(driver.id, { availability: 'offline' });
        expect(updated.availability).toBe('offline');
        expect((await repos.drivers.findById(driver.id))!.availability).toBe('offline');
      });

      it('finds available drivers inside a radius and excludes those outside it', async () => {
        const near = await driverNorthOfFerry(repos, 800);
        const far = await driverNorthOfFerry(repos, 9_000);

        const found = await repos.drivers.findAvailableNear(SF_PLACES.ferryBuilding, 2_000);
        const ids = found.map((d) => d.id);
        expect(ids).toContain(near.id);
        expect(ids).not.toContain(far.id);
      });

      it('excludes drivers who are not available or not approved', async () => {
        const offline = await driverNorthOfFerry(repos, 500, { availability: 'offline' });
        const onRide = await driverNorthOfFerry(repos, 500, { availability: 'on_ride' });
        const pending = await driverNorthOfFerry(repos, 500, { approvalStatus: 'pending_review' });

        const found = await repos.drivers.findAvailableNear(SF_PLACES.ferryBuilding, 3_000);
        const ids = found.map((d) => d.id);
        expect(ids).not.toContain(offline.id);
        expect(ids).not.toContain(onRide.id);
        expect(ids).not.toContain(pending.id);
      });

      it('excludes a driver whose position has gone stale', async () => {
        const user = await repos.users.create(makeUser({ phone: uniquePhone(), roles: ['driver'] }));
        const coords = destination(SF_PLACES.ferryBuilding, 0, 500);
        const stale = await repos.drivers.create(
          makeDriverProfile({
            userId: user.id,
            lastPosition: positionAt(coords.lat, coords.lng, Date.now() - 10 * 60 * 1000),
          }),
        );

        const fresh = await repos.drivers.findAvailableNear(SF_PLACES.ferryBuilding, 3_000, {
          staleAfterMs: 60_000,
          now: Date.now(),
        });
        expect(fresh.map((d) => d.id)).not.toContain(stale.id);

        const all = await repos.drivers.findAvailableNear(SF_PLACES.ferryBuilding, 3_000);
        expect(all.map((d) => d.id)).toContain(stale.id);
      });

      it('moves a driver between locations and re-finds them', async () => {
        const driver = await driverNorthOfFerry(repos, 6_000);
        expect(
          (await repos.drivers.findAvailableNear(SF_PLACES.ferryBuilding, 1_500)).map((d) => d.id),
        ).not.toContain(driver.id);

        const closer = destination(SF_PLACES.ferryBuilding, 0, 400);
        await repos.drivers.updatePosition(driver.id, positionAt(closer.lat, closer.lng));

        expect(
          (await repos.drivers.findAvailableNear(SF_PLACES.ferryBuilding, 1_500)).map((d) => d.id),
        ).toContain(driver.id);
      });

      it('counts drivers by availability', async () => {
        const counts = await repos.drivers.countByAvailability();
        expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
      });
    });

    describe('vehicles', () => {
      it('creates, lists by driver, and updates', async () => {
        const driverId = newDriverId();
        const user = await repos.users.create(makeUser({ phone: uniquePhone(), roles: ['driver'] }));
        const driver = await repos.drivers.create(
          makeDriverProfile({ id: driverId, userId: user.id }),
        );
        const vehicle = await repos.vehicles.create(makeVehicle({ driverId: driver.id }));

        expect((await repos.vehicles.findByDriver(driver.id)).map((v) => v.id)).toContain(vehicle.id);
        const updated = await repos.vehicles.update(vehicle.id, { color: 'black' });
        expect(updated.color).toBe('black');
        expect((await repos.vehicles.findById(vehicle.id))!.color).toBe('black');
      });
    });

    describe('rides', () => {
      let riderId: RiderId;

      beforeEach(async () => {
        const user = await repos.users.create(makeUser({ phone: uniquePhone() }));
        riderId = (await repos.riders.create(makeRiderProfile({ userId: user.id }))).id;
      });

      it('creates and reads back a ride with its full itinerary', async () => {
        const ride = await repos.rides.create(makeRide({ riderId }));
        const found = await repos.rides.findById(ride.id);
        expect(found!.itinerary.pickup.name).toBe(ride.itinerary.pickup.name);
        expect(found!.status).toBe('draft');
      });

      it('saves under an optimistic guard and rejects a stale write', async () => {
        const ride = await repos.rides.create(makeRide({ riderId }));

        const first = await repos.rides.save(
          { ...ride, status: 'requested', updatedAt: ride.updatedAt + 1 },
          ride.updatedAt,
        );
        expect(first).toBeDefined();

        // A second writer holding the original version must be refused.
        const stale = await repos.rides.save(
          { ...ride, status: 'cancelled', updatedAt: ride.updatedAt + 2 },
          ride.updatedAt,
        );
        expect(stale).toBeUndefined();
        expect((await repos.rides.findById(ride.id))!.status).toBe('requested');
      });

      it('saves without a guard when none is supplied', async () => {
        const ride = await repos.rides.create(makeRide({ riderId }));
        const saved = await repos.rides.save({ ...ride, status: 'requested' });
        expect(saved!.status).toBe('requested');
      });

      it('finds the rider’s single active ride', async () => {
        await repos.rides.create(makeRide({ riderId, status: 'completed' }));
        const active = await repos.rides.create(makeRide({ riderId, status: 'accepted' }));
        expect((await repos.rides.findActiveForRider(riderId))!.id).toBe(active.id);
      });

      it('finds the driver’s active ride through the assignment', async () => {
        const driverId = newDriverId();
        const ride = await repos.rides.create(
          makeRide({
            riderId,
            status: 'in_progress',
            assignment: {
              driverId,
              vehicleId: newVehicleId(),
              assignedAt: T0,
              offerId: newOfferId(),
              initialPickupEtaMs: 120_000,
            },
          }),
        );
        expect((await repos.rides.findActiveForDriver(driverId))!.id).toBe(ride.id);
      });

      it('lists rides searching for a driver', async () => {
        const searching = await repos.rides.create(makeRide({ riderId, status: 'requested' }));
        await repos.rides.create(makeRide({ riderId: newRiderId(), status: 'completed' }));
        expect((await repos.rides.findSearching()).map((r) => r.id)).toContain(searching.id);
      });

      it('finds scheduled rides whose window has opened, and not those still ahead', async () => {
        const now = Date.now();
        const due = await repos.rides.create(
          makeRide({ riderId, status: 'scheduled', scheduledFor: now + 60_000 }),
        );
        const notYet = await repos.rides.create(
          makeRide({ riderId: newRiderId(), status: 'scheduled', scheduledFor: now + 3 * 3_600_000 }),
        );

        const ids = (await repos.rides.findDueScheduled(now, 10 * 60 * 1000)).map((r) => r.id);
        expect(ids).toContain(due.id);
        expect(ids).not.toContain(notYet.id);
      });

      it('queries by status and orders newest first', async () => {
        await repos.rides.create(
          makeRide({ riderId, status: 'completed', createdAt: T0, updatedAt: T0 }),
        );
        await repos.rides.create(
          makeRide({ riderId, status: 'completed', createdAt: T0 + 5000, updatedAt: T0 + 5000 }),
        );
        const rides = await repos.rides.query({ riderId, statuses: ['completed'], limit: 10 });
        expect(rides.length).toBeGreaterThanOrEqual(2);
        expect(rides[0]!.createdAt).toBeGreaterThanOrEqual(rides[1]!.createdAt);
      });

      it('paginates', async () => {
        for (let i = 0; i < 5; i++) {
          await repos.rides.create(
            makeRide({ riderId, status: 'completed', createdAt: T0 + i, updatedAt: T0 + i }),
          );
        }
        const page1 = await repos.rides.query({ riderId, limit: 2, offset: 0 });
        const page2 = await repos.rides.query({ riderId, limit: 2, offset: 2 });
        expect(page1).toHaveLength(2);
        expect(page2).toHaveLength(2);
        expect(page1.map((r) => r.id)).not.toEqual(page2.map((r) => r.id));
      });

      it('counts matching rides', async () => {
        await repos.rides.create(makeRide({ riderId, status: 'cancelled' }));
        expect(await repos.rides.count({ riderId, statuses: ['cancelled'] })).toBeGreaterThan(0);
      });
    });

    describe('offers', () => {
      it('creates, finds pending for a driver, and resolves', async () => {
        const driverId = newDriverId();
        const rideId = (await repos.rides.create(makeRide({ riderId: newRiderId() }))).id;
        const offer = await repos.offers.create({
          id: newOfferId(),
          rideId,
          driverId,
          vehicleId: newVehicleId(),
          status: 'pending',
          sentAt: Date.now(),
          expiresAt: Date.now() + 15_000,
          round: 0,
          preview: {
            rideTypeId: 'standard',
            pickupAddress: 'Ferry Building',
            pickupCoordinates: SF_PLACES.ferryBuilding,
            dropoffAddress: 'Dolores Park',
            dropoffCoordinates: SF_PLACES.missionDolores,
            pickupEtaMs: 180_000,
            pickupDistanceMeters: 900,
            tripDistanceMeters: 4200,
            tripDurationMs: 840_000,
            estimatedPayout: fromDecimal(11.7),
            surgeMultiplier: 1,
            riderRating: 4.9,
            riderName: 'Avery C.',
            stopCount: 0,
            passengerCount: 1,
          },
        });

        expect((await repos.offers.findPendingForDriver(driverId)).map((o) => o.id)).toContain(offer.id);
        await repos.offers.update(offer.id, { status: 'accepted' });
        expect(await repos.offers.findPendingForDriver(driverId)).toHaveLength(0);
        expect((await repos.offers.findForRide(rideId)).map((o) => o.id)).toContain(offer.id);
      });
    });

    describe('payment methods', () => {
      let riderId: RiderId;

      beforeEach(async () => {
        const user = await repos.users.create(makeUser({ phone: uniquePhone() }));
        riderId = (await repos.riders.create(makeRiderProfile({ userId: user.id }))).id;
      });

      it('keeps exactly one default as it moves between methods', async () => {
        const visa = await repos.paymentMethods.create({
          id: newPaymentMethodId(),
          riderId,
          kind: 'card',
          brand: 'visa',
          last4: '4242',
          isDefault: true,
          createdAt: Date.now(),
        });
        const amex = await repos.paymentMethods.create({
          id: newPaymentMethodId(),
          riderId,
          kind: 'card',
          brand: 'amex',
          last4: '0005',
          isDefault: false,
          createdAt: Date.now() + 1,
        });

        await repos.paymentMethods.setDefault(riderId, amex.id);
        const methods = await repos.paymentMethods.listForRider(riderId);
        expect(methods.filter((m) => m.isDefault)).toHaveLength(1);
        expect(methods.find((m) => m.isDefault)!.id).toBe(amex.id);
        expect(methods[0]!.id).toBe(amex.id);
        expect(methods.map((m) => m.id)).toContain(visa.id);
      });

      it('hides a removed method', async () => {
        const method = await repos.paymentMethods.create({
          id: newPaymentMethodId(),
          riderId,
          kind: 'card',
          brand: 'visa',
          last4: '1111',
          isDefault: false,
          createdAt: Date.now(),
        });
        await repos.paymentMethods.update(method.id, { removedAt: Date.now(), isDefault: false });
        expect((await repos.paymentMethods.listForRider(riderId)).map((m) => m.id)).not.toContain(
          method.id,
        );
      });
    });

    describe('charges', () => {
      it('enforces idempotency: the same key returns the original charge', async () => {
        const riderId = newRiderId();
        const key = `idem_${Math.random().toString(36).slice(2)}`;
        const first = await repos.charges.create(
          {
            id: newChargeId(),
            riderId,
            paymentMethodId: newPaymentMethodId(),
            amount: fromDecimal(15),
            status: 'authorized',
            kind: 'ride_fare',
            createdAt: Date.now(),
          },
          key,
        );

        const duplicate = await repos.charges.create(
          {
            id: newChargeId(),
            riderId,
            paymentMethodId: newPaymentMethodId(),
            amount: fromDecimal(99),
            status: 'authorized',
            kind: 'ride_fare',
            createdAt: Date.now(),
          },
          key,
        );

        expect(duplicate.id).toBe(first.id);
        expect(duplicate.amount.amount).toBe(1500);
        expect((await repos.charges.findByIdempotencyKey(key))!.id).toBe(first.id);
      });

      it('lists charges for a ride and updates a status', async () => {
        const rideId = (await repos.rides.create(makeRide({ riderId: newRiderId() }))).id;
        const charge = await repos.charges.create({
          id: newChargeId(),
          riderId: newRiderId(),
          rideId,
          paymentMethodId: newPaymentMethodId(),
          amount: fromDecimal(20),
          status: 'authorized',
          kind: 'ride_fare',
          createdAt: Date.now(),
        });
        await repos.charges.update(charge.id, { status: 'captured' });
        const forRide = await repos.charges.listForRide(rideId);
        expect(forRide).toHaveLength(1);
        expect(forRide[0]!.status).toBe('captured');
      });
    });

    describe('chat', () => {
      it('appends, lists in order, and marks the other party’s messages read', async () => {
        const rideId = (await repos.rides.create(makeRide({ riderId: newRiderId() }))).id;
        await repos.chat.append({
          id: newMessageId(),
          rideId,
          from: 'rider',
          text: "I'm out front",
          sentAt: T0,
        });
        await repos.chat.append({
          id: newMessageId(),
          rideId,
          from: 'driver',
          text: 'Almost there',
          sentAt: T0 + 1000,
        });

        const messages = await repos.chat.listForRide(rideId);
        expect(messages.map((m) => m.text)).toEqual(["I'm out front", 'Almost there']);

        await repos.chat.markRead(rideId, 'driver', T0 + 2000);
        const afterRead = await repos.chat.listForRide(rideId);
        // The driver read the rider's message, not their own.
        expect(afterRead.find((m) => m.from === 'rider')!.readAt).toBe(T0 + 2000);
        expect(afterRead.find((m) => m.from === 'driver')!.readAt).toBeUndefined();
      });
    });

    describe('support tickets', () => {
      const makeTicket = (overrides: Partial<SupportTicket> = {}): SupportTicket => ({
        id: newTicketId(),
        requesterId: newUserId(),
        requesterRole: 'rider',
        category: 'fare_dispute',
        subject: 'My fare was higher than the estimate',
        status: 'open',
        priority: 'normal',
        messages: [
          { id: newMessageId(), from: 'requester', text: 'This cost more than quoted', sentAt: T0 },
        ],
        createdAt: T0,
        updatedAt: T0,
        ...overrides,
      });

      it('round-trips a ticket with its whole thread', async () => {
        const ticket = makeTicket();
        await repos.support.create(ticket);
        expect(await repos.support.findById(ticket.id)).toEqual(ticket);
      });

      it('refuses a save whose guard is stale', async () => {
        const ticket = await repos.support.create(makeTicket());
        const replied = { ...ticket, status: 'awaiting_reply' as const, updatedAt: T0 + 1000 };
        expect(await repos.support.save(replied, T0)).toEqual(replied);
        // A second writer still holding the original updatedAt loses.
        expect(await repos.support.save({ ...ticket, updatedAt: T0 + 2000 }, T0)).toBeUndefined();
      });

      it('filters by requester, ride, and status, newest activity first', async () => {
        const requesterId = newUserId() as UserId;
        const rideId = (await repos.rides.create(makeRide({ riderId: newRiderId() }))).id;
        await repos.support.create(makeTicket({ requesterId, updatedAt: T0 }));
        await repos.support.create(
          makeTicket({ requesterId, rideId, status: 'resolved', updatedAt: T0 + 5000 }),
        );
        await repos.support.create(makeTicket({ updatedAt: T0 + 9000 }));

        const mine = await repos.support.query({ requesterId });
        expect(mine).toHaveLength(2);
        expect(mine[0]!.updatedAt).toBe(T0 + 5000);

        expect(await repos.support.query({ rideId })).toHaveLength(1);
        expect(await repos.support.query({ statuses: ['resolved'] })).toHaveLength(1);
        expect(await repos.support.query({ requesterId, limit: 1 })).toHaveLength(1);
      });

      it('counts the queue by status', async () => {
        // The store is shared across this suite, so the assertion is on the
        // delta rather than on absolute numbers.
        const before = await repos.support.countByStatus();
        await repos.support.create(makeTicket());
        await repos.support.create(makeTicket());
        await repos.support.create(makeTicket({ status: 'resolved' }));

        const after = await repos.support.countByStatus();
        expect(after.open! - (before.open ?? 0)).toBe(2);
        expect(after.resolved! - (before.resolved ?? 0)).toBe(1);
        expect(after.closed).toBeUndefined();
      });
    });

    describe('payouts', () => {
      const makePayout = (driverId: DriverProfile['id'], overrides: Partial<Payout> = {}): Payout => ({
        id: newPayoutId(),
        driverId,
        kind: 'instant',
        amount: fromDecimal(49.5),
        fee: fromDecimal(0.5),
        status: 'pending',
        requestedAt: T0,
        destinationLabel: 'Chase ••••4321',
        ...overrides,
      });

      it('round-trips a payout and updates its status', async () => {
        const driver = await driverNorthOfFerry(repos, 100);
        const payout = await repos.payouts.create(makePayout(driver.id));

        expect(await repos.payouts.findById(payout.id)).toEqual(payout);

        const paid = await repos.payouts.update(payout.id, {
          status: 'paid',
          settledAt: T0 + 60_000,
        });
        expect(paid.status).toBe('paid');
        expect((await repos.payouts.findById(payout.id))?.settledAt).toBe(T0 + 60_000);
      });

      it('lists a driver’s payouts newest first, and nobody else’s', async () => {
        const mine = await driverNorthOfFerry(repos, 100);
        const theirs = await driverNorthOfFerry(repos, 200);
        await repos.payouts.create(makePayout(mine.id, { requestedAt: T0 }));
        await repos.payouts.create(makePayout(mine.id, { requestedAt: T0 + 5000 }));
        await repos.payouts.create(makePayout(theirs.id));

        const list = await repos.payouts.listForDriver(mine.id);
        expect(list).toHaveLength(2);
        expect(list[0]!.requestedAt).toBe(T0 + 5000);
        expect(await repos.payouts.listForDriver(mine.id, 1)).toHaveLength(1);
      });

      it('counts instant cash outs from a moment, inclusive', async () => {
        const driver = await driverNorthOfFerry(repos, 100);
        await repos.payouts.create(makePayout(driver.id, { requestedAt: T0 - 1 }));
        await repos.payouts.create(makePayout(driver.id, { requestedAt: T0 }));
        await repos.payouts.create(
          makePayout(driver.id, { kind: 'scheduled', requestedAt: T0 + 1000 }),
        );

        // The boundary itself counts, and a scheduled payout is not an instant.
        expect(await repos.payouts.countInstantSince(driver.id, T0)).toBe(1);
        expect(await repos.payouts.countInstantSince(driver.id, T0 - 1)).toBe(2);
      });

      it('commits the amount and the fee, and releases a failed payout', async () => {
        const driver = await driverNorthOfFerry(repos, 100);
        expect(await repos.payouts.totalCommitted(driver.id)).toBe(0);

        await repos.payouts.create(makePayout(driver.id));
        // 4950 to the driver plus a 50 fee, both out of the balance.
        expect(await repos.payouts.totalCommitted(driver.id)).toBe(5000);

        const failed = await repos.payouts.create(
          makePayout(driver.id, { amount: fromDecimal(10), fee: fromDecimal(0) }),
        );
        expect(await repos.payouts.totalCommitted(driver.id)).toBe(6000);

        // A payout that failed never left, so the money is available again.
        await repos.payouts.update(failed.id, { status: 'failed' });
        expect(await repos.payouts.totalCommitted(driver.id)).toBe(5000);
      });

      it('keeps at most one default destination per driver', async () => {
        const driver = await driverNorthOfFerry(repos, 100);
        const base = { driverId: driver.id, createdAt: T0 };

        await repos.payouts.addDestination({
          ...base,
          id: 'pod_1',
          label: 'Chase ••••4321',
          isDefault: true,
        });
        await repos.payouts.addDestination({
          ...base,
          id: 'pod_2',
          label: 'Ally ••••9876',
          isDefault: true,
        });

        const destinations = await repos.payouts.listDestinations(driver.id);
        expect(destinations).toHaveLength(2);
        expect(destinations.filter((d) => d.isDefault).map((d) => d.id)).toEqual(['pod_2']);

        await repos.payouts.removeDestination('pod_1');
        expect(await repos.payouts.listDestinations(driver.id)).toHaveLength(1);
      });
    });

    describe('promo redemptions', () => {
      it('counts per rider and across everyone, scoped to the code', async () => {
        const riderA = newRiderId();
        const riderB = newRiderId();
        const code = `SAVE${Date.now()}`;

        await repos.promos.record({ code, riderId: riderA, redeemedAt: T0 });
        await repos.promos.record({ code, riderId: riderA, redeemedAt: T0 + 1000 });
        await repos.promos.record({ code, riderId: riderB, redeemedAt: T0 + 2000 });
        await repos.promos.record({ code: `${code}X`, riderId: riderA, redeemedAt: T0 });

        expect(await repos.promos.countForRider(code, riderA)).toBe(2);
        expect(await repos.promos.countForRider(code, riderB)).toBe(1);
        expect(await repos.promos.countTotal(code)).toBe(3);
        // An unused code has no redemptions rather than an error.
        expect(await repos.promos.countTotal('NEVER_USED')).toBe(0);
      });

      it('records the ride a code was used on, when there is one', async () => {
        const riderId = newRiderId();
        const rideId = (await repos.rides.create(makeRide({ riderId }))).id;
        const code = `TRIP${Date.now()}`;

        await repos.promos.record({ code, riderId, rideId, redeemedAt: T0 });
        await repos.promos.record({ code: `${code}B`, riderId, redeemedAt: T0 + 1000 });

        const history = await repos.promos.listForRider(riderId);
        expect(history).toHaveLength(2);
        expect(history.find((r) => r.code === code)?.rideId).toBe(rideId);
        // A code redeemed outside a ride carries no ride id at all.
        expect(history.find((r) => r.code === `${code}B`)?.rideId).toBeUndefined();
      });
    });

    describe('push tokens', () => {
      it('files a device under a recipient and reads it back', async () => {
        const riderId = newRiderId();
        await repos.pushTokens.register({ kind: 'rider', id: riderId }, 'tok_phone', T0);
        await repos.pushTokens.register({ kind: 'rider', id: riderId }, 'tok_tablet', T0 + 1);

        expect(await repos.pushTokens.tokensFor({ kind: 'rider', id: riderId })).toEqual([
          'tok_phone',
          'tok_tablet',
        ]);
      });

      it('is idempotent: the apps register on every launch', async () => {
        const riderId = newRiderId();
        await repos.pushTokens.register({ kind: 'rider', id: riderId }, 'tok_same', T0);
        await repos.pushTokens.register({ kind: 'rider', id: riderId }, 'tok_same', T0 + 5000);

        expect(await repos.pushTokens.tokensFor({ kind: 'rider', id: riderId })).toEqual([
          'tok_same',
        ]);
      });

      it('keeps the two roles on one device apart', async () => {
        const riderId = newRiderId();
        const driverId = newDriverId();
        await repos.pushTokens.register({ kind: 'rider', id: riderId }, 'tok_shared', T0);
        await repos.pushTokens.register({ kind: 'driver', id: driverId }, 'tok_shared', T0);

        expect(await repos.pushTokens.tokensFor({ kind: 'rider', id: riderId })).toEqual([
          'tok_shared',
        ]);
        expect(await repos.pushTokens.tokensFor({ kind: 'driver', id: driverId })).toEqual([
          'tok_shared',
        ]);
      });

      it('removes an uninstalled device from every role it was filed under', async () => {
        const riderId = newRiderId();
        const driverId = newDriverId();
        await repos.pushTokens.register({ kind: 'rider', id: riderId }, 'tok_gone', T0);
        await repos.pushTokens.register({ kind: 'driver', id: driverId }, 'tok_gone', T0);
        await repos.pushTokens.register({ kind: 'rider', id: riderId }, 'tok_kept', T0);

        await repos.pushTokens.remove('tok_gone');

        expect(await repos.pushTokens.tokensFor({ kind: 'rider', id: riderId })).toEqual([
          'tok_kept',
        ]);
        expect(await repos.pushTokens.tokensFor({ kind: 'driver', id: driverId })).toEqual([]);
      });

      it('has nothing for someone who never registered', async () => {
        expect(await repos.pushTokens.tokensFor({ kind: 'rider', id: newRiderId() })).toEqual([]);
      });
    });
  });
}
