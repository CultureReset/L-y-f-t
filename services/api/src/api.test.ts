/**
 * End-to-end API tests.
 *
 * These exercise the whole platform through its HTTP surface — auth, quoting,
 * dispatch, the trip lifecycle, payments, ratings — with nothing mocked below
 * the route handler. If these pass, a rider can get a ride.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DOLORES_PARK,
  FERRY_BUILDING,
  asUser,
  bookStandardRide,
  createHarness,
  driverWithPendingOffer,
  signIn,
  type Harness,
} from './testing/harness.js';
import { DEMO_DRIVER_PHONE, DEMO_RIDER_PHONE } from './seed.js';

let harness: Harness;

beforeEach(async () => {
  harness = await createHarness();
});

afterEach(async () => {
  await harness.close();
});

describe('bootstrap', () => {
  it('serves a health check describing what is running', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      store: 'memory',
      geoProvider: 'mock',
      dispatchStrategy: 'scored',
    });
  });

  it('serves the client bootstrap config with ride types and features', async () => {
    const body = (await harness.app.inject({ method: 'GET', url: '/config' })).json();
    expect(body.rideTypes.map((t: { id: string }) => t.id)).toContain('standard');
    expect(body.market.name).toBe('San Francisco');
    expect(body.features.tipping).toBe(true);
    // Ride types arrive in display order so the picker needs no sorting.
    const orders = body.rideTypes.map((t: { displayOrder: number }) => t.displayOrder);
    expect(orders).toEqual([...orders].sort((a: number, b: number) => a - b));
  });

  it('returns the platform error envelope for an unknown route', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/v1/nope' });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('not_found');
  });
});

describe('authentication', () => {
  it('signs a rider in with a phone and code, creating their profile', async () => {
    const { token, riderId } = await signIn(harness, '+14155551234', 'rider', {
      firstName: 'Sam',
    });
    expect(token).toBeTruthy();
    expect(riderId).toMatch(/^rdr_/);

    const me = (await asUser(harness, token).get('/v1/auth/me')).json();
    expect(me.user.firstName).toBe('Sam');
    expect(me.rider).not.toBeNull();
    // A rider gets no driver profile until they ask for one.
    expect(me.driver).toBeNull();
  });

  it('rejects a wrong code', async () => {
    await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/code',
      payload: { phone: '+14155551235' },
    });
    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/verify',
      payload: { phone: '+14155551235', code: '999999' },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('unauthorized');
  });

  it('rejects a code that was never requested', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/verify',
      payload: { phone: '+14155559999', code: '000000' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('normalizes phone numbers so formatting does not create two accounts', async () => {
    const first = await signIn(harness, '+1 (415) 555-1240');
    const second = await signIn(harness, '4155551240');
    const a = (await asUser(harness, first.token).get('/v1/auth/me')).json();
    const b = (await asUser(harness, second.token).get('/v1/auth/me')).json();
    expect(a.user.id).toBe(b.user.id);
  });

  it('refuses protected endpoints without a token', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/v1/rides/active' });
    expect(response.statusCode).toBe(401);
  });

  it('refuses a revoked token', async () => {
    const { token } = await signIn(harness, '+14155551241');
    await asUser(harness, token).post('/v1/auth/signout');
    const response = await asUser(harness, token).get('/v1/rides/active');
    expect(response.statusCode).toBe(401);
  });

  it('lets one account switch from riding to driving', async () => {
    const { token } = await signIn(harness, '+14155551242', 'rider');
    const switched = (await asUser(harness, token).post('/v1/auth/role', { role: 'driver' })).json();
    expect(switched.driverId).toMatch(/^drv_/);

    const me = (await asUser(harness, switched.token).get('/v1/auth/me')).json();
    expect(me.user.roles).toEqual(expect.arrayContaining(['rider', 'driver']));
    // A brand-new driver has not been approved to drive.
    expect(me.driver.approvalStatus).toBe('incomplete');
  });

  it('rate limits code requests', async () => {
    const phone = '+14155551243';
    const codes = [];
    for (let i = 0; i < 7; i++) {
      codes.push(
        await harness.app.inject({ method: 'POST', url: '/v1/auth/code', payload: { phone } }),
      );
    }
    expect(codes.some((r) => r.statusCode === 429)).toBe(true);
  });
});

describe('place search', () => {
  it('returns sections from the registered sources', async () => {
    const { token } = await signIn(harness, DEMO_RIDER_PHONE);
    const body = (
      await asUser(harness, token).get(
        '/v1/places/search?q=dolores&lat=37.7955&lng=-122.3937&field=dropoff',
      )
    ).json();
    const names = body.sections.flatMap((s: { results: { place: { name: string } }[] }) =>
      s.results.map((r) => r.place.name),
    );
    expect(names).toContain('Mission Dolores Park');
  });

  it('shows the rider’s saved places before they type anything', async () => {
    const { token } = await signIn(harness, DEMO_RIDER_PHONE);
    const body = (await asUser(harness, token).get('/v1/places/search?q=')).json();
    const saved = body.sections.find((s: { sourceId: string }) => s.sourceId === 'saved');
    expect(saved.results.map((r: { place: { name: string } }) => r.place.name)).toEqual(
      expect.arrayContaining(['Home', 'Work']),
    );
  });

  it('reverse geocodes a dropped pin', async () => {
    const body = (
      await harness.app.inject({
        method: 'GET',
        url: '/v1/places/reverse?lat=37.7955&lng=-122.3937',
      })
    ).json();
    expect(body.place.name).toBe('Ferry Building');
  });

  it('lists the configured place sources', async () => {
    const body = (await harness.app.inject({ method: 'GET', url: '/v1/places/sources' })).json();
    expect(body.sources.map((s: { id: string }) => s.id)).toEqual(
      expect.arrayContaining(['saved', 'recent', 'current_location']),
    );
  });
});

describe('quoting', () => {
  it('prices every ride type for one itinerary', async () => {
    const body = (
      await harness.app.inject({
        method: 'POST',
        url: '/v1/rides/quote',
        payload: { pickup: FERRY_BUILDING, dropoff: DOLORES_PARK, passengerCount: 1 },
      })
    ).json();

    expect(body.quoteId).toMatch(/^qt_/);
    expect(body.route.distanceMeters).toBeGreaterThan(0);
    expect(body.route.geometry.length).toBeGreaterThan(10);

    const byId = Object.fromEntries(
      body.quotes.map((q: { rideTypeId: string }) => [q.rideTypeId, q]),
    );
    expect(byId.shared.fare.total.amount).toBeLessThan(byId.standard.fare.total.amount);
    expect(byId.lux.fare.total.amount).toBeGreaterThan(byId.xl.fare.total.amount);

    // Every quote's line items must sum exactly to its total.
    for (const quote of body.quotes) {
      const summed = quote.fare.items.reduce(
        (acc: number, i: { amount: { amount: number } }) => acc + i.amount.amount,
        0,
      );
      expect(summed).toBe(quote.fare.total.amount);
    }
  });

  it('derives the pickup ETA from the real seeded fleet', async () => {
    const body = (
      await harness.app.inject({
        method: 'POST',
        url: '/v1/rides/quote',
        payload: { pickup: FERRY_BUILDING, dropoff: DOLORES_PARK },
      })
    ).json();
    const standard = body.quotes.find((q: { rideTypeId: string }) => q.rideTypeId === 'standard');
    expect(standard.pickupEtaMs).toBeGreaterThan(0);
    expect(standard.pickupEtaMs).toBeLessThan(30 * 60_000);
  });

  it('marks a ride type unavailable when the party is too big for it', async () => {
    const body = (
      await harness.app.inject({
        method: 'POST',
        url: '/v1/rides/quote',
        payload: { pickup: FERRY_BUILDING, dropoff: DOLORES_PARK, passengerCount: 6 },
      })
    ).json();
    const standard = body.quotes.find((q: { rideTypeId: string }) => q.rideTypeId === 'standard');
    const xl = body.quotes.find((q: { rideTypeId: string }) => q.rideTypeId === 'xl');
    expect(standard.available).toBe(false);
    expect(standard.unavailableReason).toMatch(/up to 4/);
    expect(xl.available).toBe(true);
  });

  it('rejects a malformed itinerary with a validation error', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/rides/quote',
      payload: { pickup: { name: 'nowhere' } },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe('validation_failed');
  });
});

describe('the ride lifecycle', () => {
  let riderToken: string;

  beforeEach(async () => {
    riderToken = (await signIn(harness, DEMO_RIDER_PHONE)).token;
  });

  it('runs a full ride from request to receipt', async () => {
    // 1. The rider books.
    const { rideId, body } = await bookStandardRide(harness, riderToken);
    expect(body.ride.status).toBe('requested');

    // 2. Dispatch has already offered the ride to its best candidate.
    const { token: driverToken, offerId, driverId } = await driverWithPendingOffer(
      harness,
      rideId,
    );
    const driver = asUser(harness, driverToken);

    const offers = (await driver.get('/v1/driver/offers')).json();
    expect(offers.offers).toHaveLength(1);
    const preview = offers.offers[0].preview;
    expect(preview.pickupAddress).toBe('Ferry Building');
    expect(preview.estimatedPayout.amount).toBeGreaterThan(0);
    expect(preview.pickupEtaMs).toBeGreaterThan(0);

    // 3. The driver accepts.
    const accepted = (await driver.post(`/v1/driver/offers/${offerId}/accept`)).json();
    expect(accepted.ride.status).toBe('accepted');
    expect(accepted.ride.assignment.driverId).toBe(driverId);
    // Route legs are computed at assignment: driver→pickup, then pickup→dropoff.
    expect(accepted.ride.legs.map((l: { kind: string }) => l.kind)).toEqual([
      'to_pickup',
      'to_dropoff',
    ]);

    // 4. The rider can now see their driver and vehicle.
    const active = (await asUser(harness, riderToken).get('/v1/rides/active')).json();
    expect(active.ride.status).toBe('accepted');
    expect(active.driver.name).toMatch(/^\w+ \w\.$/);
    expect(active.vehicle.licensePlate).toBeTruthy();

    // 5. Arrive, start, complete.
    await harness.advance(4 * 60_000);
    expect((await driver.post(`/v1/driver/rides/${rideId}/arrived`)).json().ride.status).toBe(
      'arrived',
    );

    await harness.advance(90_000);
    expect((await driver.post(`/v1/driver/rides/${rideId}/start`)).json().ride.status).toBe(
      'in_progress',
    );

    await harness.advance(12 * 60_000);
    const completed = (await driver.post(`/v1/driver/rides/${rideId}/complete`)).json();
    expect(completed.ride.status).toBe('completed');
    expect(completed.ride.finalFare.estimated).toBe(false);
    expect(completed.ride.finalFare.total.amount).toBeGreaterThan(0);

    // 6. The receipt reflects what happened, and the fare was captured.
    const receipt = (await asUser(harness, riderToken).get(`/v1/rides/${rideId}/receipt`)).json();
    expect(receipt.receipt.fare.total.amount).toBe(completed.ride.finalFare.total.amount);
    expect(receipt.receipt.charges.some((c: { status: string }) => c.status === 'captured')).toBe(
      true,
    );

    // 7. The driver is back in the pool.
    const status = (await driver.get('/v1/driver/status')).json();
    expect(status.availability).toBe('available');
    expect(status.todayEarnings.ridesCompleted).toBe(1);
    expect(status.todayEarnings.total.amount).toBeGreaterThan(0);
  });

  it('records a full timeline of the ride', async () => {
    const { rideId } = await bookStandardRide(harness, riderToken);
    const { token: driverToken, offerId } = await driverWithPendingOffer(harness, rideId);
    const driver = asUser(harness, driverToken);

    await driver.post(`/v1/driver/offers/${offerId}/accept`);
    await harness.advance(60_000);
    await driver.post(`/v1/driver/rides/${rideId}/arrived`);
    await harness.advance(60_000);
    await driver.post(`/v1/driver/rides/${rideId}/start`);
    await harness.advance(600_000);
    await driver.post(`/v1/driver/rides/${rideId}/complete`);

    const detail = (await asUser(harness, riderToken).get(`/v1/rides/${rideId}`)).json();
    expect(detail.timeline.map((e: { title: string }) => e.title)).toEqual([
      'Ride created',
      'Looking for a driver',
      'Driver accepted',
      'Driver arrived',
      'Trip started',
      'Trip completed',
    ]);
    expect(detail.durations.timeToMatchMs).toBeGreaterThanOrEqual(0);
    expect(detail.durations.tripMs).toBe(600_000);
  });

  it('charges wait time when the rider keeps the driver waiting', async () => {
    const { rideId } = await bookStandardRide(harness, riderToken);
    const { token: driverToken, offerId } = await driverWithPendingOffer(harness, rideId);
    const driver = asUser(harness, driverToken);

    await driver.post(`/v1/driver/offers/${offerId}/accept`);
    await driver.post(`/v1/driver/rides/${rideId}/arrived`);
    // Eight minutes at the curb; the first two are free.
    await harness.advance(8 * 60_000);
    await driver.post(`/v1/driver/rides/${rideId}/start`);
    await harness.advance(5 * 60_000);
    const completed = (await driver.post(`/v1/driver/rides/${rideId}/complete`)).json();

    const waitItem = completed.ride.finalFare.items.find(
      (i: { code: string }) => i.code === 'wait_time',
    );
    expect(waitItem).toBeDefined();
    expect(waitItem.amount.amount).toBeGreaterThan(0);
  });

  it('prices the final fare from the distance the driver actually reports', async () => {
    const { rideId } = await bookStandardRide(harness, riderToken);
    const { token: driverToken, offerId } = await driverWithPendingOffer(harness, rideId);
    const driver = asUser(harness, driverToken);

    await driver.post(`/v1/driver/offers/${offerId}/accept`);
    await driver.post(`/v1/driver/rides/${rideId}/start`);
    await harness.advance(15 * 60_000);

    // A detour: 12 km driven rather than the ~7 km planned.
    const completed = (
      await driver.post(`/v1/driver/rides/${rideId}/complete`, {
        distanceMeters: 12_000,
        durationMs: 15 * 60_000,
      })
    ).json();

    expect(completed.ride.finalFare.distanceMeters).toBe(12_000);
    expect(completed.ride.finalFare.total.amount).toBeGreaterThan(
      completed.ride.quotedFare.total.amount,
    );
  });

  it('refuses a second ride while one is in flight', async () => {
    await bookStandardRide(harness, riderToken);
    const response = await asUser(harness, riderToken).post('/v1/rides', {
      rideTypeId: 'standard',
      pickup: FERRY_BUILDING,
      dropoff: DOLORES_PARK,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.userMessage).toMatch(/already have a ride/);
  });

  it('refuses to start a ride that has no driver', async () => {
    const { rideId } = await bookStandardRide(harness, riderToken);
    const { token: driverToken } = await driverWithPendingOffer(harness, rideId);
    // The driver never accepted, so they are not on this ride.
    const response = await asUser(harness, driverToken).post(
      `/v1/driver/rides/${rideId}/start`,
    );
    expect(response.statusCode).toBe(403);
  });

  it('hides a ride from an unrelated rider', async () => {
    const { rideId } = await bookStandardRide(harness, riderToken);
    const stranger = (await signIn(harness, '+14155557777')).token;
    const body = (await asUser(harness, stranger).get(`/v1/rides/${rideId}`)).json();
    expect(body.ride).toBeNull();
  });
});

describe('dispatch behaviour', () => {
  let riderToken: string;

  beforeEach(async () => {
    riderToken = (await signIn(harness, DEMO_RIDER_PHONE)).token;
  });

  it('moves to another driver when the first declines', async () => {
    const { rideId } = await bookStandardRide(harness, riderToken);
    const first = await driverWithPendingOffer(harness, rideId);

    await asUser(harness, first.token).post(`/v1/driver/offers/${first.offerId}/decline`);

    const second = await driverWithPendingOffer(harness, rideId);
    expect(second.driverId).not.toBe(first.driverId);

    const accepted = (
      await asUser(harness, second.token).post(`/v1/driver/offers/${second.offerId}/accept`)
    ).json();
    expect(accepted.ride.assignment.driverId).toBe(second.driverId);
  });

  it('expires an unanswered offer and offers the ride to somebody else', async () => {
    const { rideId } = await bookStandardRide(harness, riderToken);
    const first = await driverWithPendingOffer(harness, rideId);

    // Let the offer time out rather than answering it.
    await harness.advance(16_000);

    const offers = await harness.container.repositories.offers.findForRide(rideId as never);
    expect(offers.find((o) => o.id === first.offerId)!.status).toBe('expired');

    const second = await driverWithPendingOffer(harness, rideId);
    expect(second.driverId).not.toBe(first.driverId);
  });

  it('releases a driver back to the pool after they decline', async () => {
    const { rideId } = await bookStandardRide(harness, riderToken);
    const first = await driverWithPendingOffer(harness, rideId);

    const beforeDecline = await harness.container.repositories.drivers.findById(
      first.driverId as never,
    );
    expect(beforeDecline!.availability).toBe('offered');

    await asUser(harness, first.token).post(`/v1/driver/offers/${first.offerId}/decline`);

    const afterDecline = await harness.container.repositories.drivers.findById(
      first.driverId as never,
    );
    expect(afterDecline!.availability).toBe('available');
  });

  it('refuses an offer that has already been accepted by someone else', async () => {
    const { rideId } = await bookStandardRide(harness, riderToken);
    const winner = await driverWithPendingOffer(harness, rideId);
    await asUser(harness, winner.token).post(`/v1/driver/offers/${winner.offerId}/accept`);

    const response = await asUser(harness, winner.token).post(
      `/v1/driver/offers/${winner.offerId}/accept`,
    );
    expect(response.statusCode).toBe(409);
  });

  it('gives up and expires the ride when no driver is reachable', async () => {
    const empty = await createHarness({ seed: false });
    try {
      const { token } = await signIn(empty, '+14155550100', 'rider', { firstName: 'Avery' });
      const { rideId } = await bookStandardRide(empty, token);

      // Run out the whole search window.
      await empty.advance(5 * 60_000 + 1_000);

      const ride = await empty.container.repositories.rides.findById(rideId as never);
      expect(ride!.status).toBe('expired');
    } finally {
      await empty.close();
    }
  });

  it('does not offer a ride to a driver who is offline', async () => {
    const { rideId } = await bookStandardRide(harness, riderToken);
    const offers = await harness.container.repositories.offers.findForRide(rideId as never);
    for (const offer of offers) {
      const driver = await harness.container.repositories.drivers.findById(offer.driverId);
      expect(driver!.approvalStatus).toBe('approved');
    }
  });
});

describe('cancellation', () => {
  let riderToken: string;

  beforeEach(async () => {
    riderToken = (await signIn(harness, DEMO_RIDER_PHONE)).token;
  });

  it('is free before a driver is assigned', async () => {
    const { rideId } = await bookStandardRide(harness, riderToken);
    const rider = asUser(harness, riderToken);

    const preview = (await rider.get(`/v1/rides/${rideId}/cancellation-preview`)).json();
    expect(preview.waived).toBe(true);
    expect(preview.fee.amount).toBe(0);

    const cancelled = (
      await rider.post(`/v1/rides/${rideId}/cancel`, { reason: 'rider_changed_mind' })
    ).json();
    expect(cancelled.ride.status).toBe('cancelled');
    expect(cancelled.ride.cancellation.feeWaived).toBe(true);
  });

  it('is free inside the grace window after a driver accepts', async () => {
    const { rideId } = await bookStandardRide(harness, riderToken);
    const { token: driverToken, offerId } = await driverWithPendingOffer(harness, rideId);
    await asUser(harness, driverToken).post(`/v1/driver/offers/${offerId}/accept`);

    await harness.advance(30_000);
    const preview = (
      await asUser(harness, riderToken).get(`/v1/rides/${rideId}/cancellation-preview`)
    ).json();
    expect(preview.waived).toBe(true);
    expect(preview.freeWindowRemainingMs).toBeGreaterThan(0);
  });

  it('charges a fee once the grace window has closed', async () => {
    const { rideId } = await bookStandardRide(harness, riderToken);
    const { token: driverToken, offerId } = await driverWithPendingOffer(harness, rideId);
    await asUser(harness, driverToken).post(`/v1/driver/offers/${offerId}/accept`);

    // The free window is two minutes.
    await harness.advance(3 * 60_000);
    const rider = asUser(harness, riderToken);

    const preview = (await rider.get(`/v1/rides/${rideId}/cancellation-preview`)).json();
    expect(preview.waived).toBe(false);
    expect(preview.fee.amount).toBe(500);

    const cancelled = (await rider.post(`/v1/rides/${rideId}/cancel`, {})).json();
    expect(cancelled.ride.cancellation.fee.amount).toBe(500);
  });

  it('never charges the rider when the driver cancels', async () => {
    const { rideId } = await bookStandardRide(harness, riderToken);
    const { token: driverToken, offerId, driverId } = await driverWithPendingOffer(
      harness,
      rideId,
    );
    await asUser(harness, driverToken).post(`/v1/driver/offers/${offerId}/accept`);
    await harness.advance(5 * 60_000);

    const cancelled = (
      await asUser(harness, driverToken).post(`/v1/driver/rides/${rideId}/cancel`, {
        reason: 'driver_vehicle_issue',
      })
    ).json();
    expect(cancelled.ride.cancellation.feeWaived).toBe(true);

    // And the driver goes back on the road.
    const driver = await harness.container.repositories.drivers.findById(driverId as never);
    expect(driver!.availability).toBe('available');
  });

  it('refuses to cancel a trip already under way', async () => {
    const { rideId } = await bookStandardRide(harness, riderToken);
    const { token: driverToken, offerId } = await driverWithPendingOffer(harness, rideId);
    const driver = asUser(harness, driverToken);
    await driver.post(`/v1/driver/offers/${offerId}/accept`);
    await driver.post(`/v1/driver/rides/${rideId}/start`);

    const response = await asUser(harness, riderToken).post(`/v1/rides/${rideId}/cancel`, {});
    expect(response.statusCode).toBe(409);
  });
});

describe('ratings and tips', () => {
  it('applies a rider’s stars to the driver and a tip to their payout', async () => {
    const riderToken = (await signIn(harness, DEMO_RIDER_PHONE)).token;
    const { rideId } = await bookStandardRide(harness, riderToken);
    const { token: driverToken, offerId, driverId } = await driverWithPendingOffer(
      harness,
      rideId,
    );
    const driver = asUser(harness, driverToken);

    await driver.post(`/v1/driver/offers/${offerId}/accept`);
    await driver.post(`/v1/driver/rides/${rideId}/start`);
    await harness.advance(10 * 60_000);
    const completed = (await driver.post(`/v1/driver/rides/${rideId}/complete`)).json();
    const payoutBefore = completed.ride.finalFare.driverPayout.amount;

    const before = await harness.container.repositories.drivers.findById(driverId as never);

    const rated = (
      await asUser(harness, riderToken).post(`/v1/rides/${rideId}/rate`, {
        stars: 5,
        comment: 'Great conversation',
        tags: ['friendly', 'smooth_ride'],
        tipAmount: 500,
      })
    ).json();

    expect(rated.ride.driverRating.stars).toBe(5);
    // The tip goes entirely to the driver.
    expect(rated.ride.finalFare.driverPayout.amount).toBe(payoutBefore + 500);
    expect(rated.ride.finalFare.total.amount).toBe(completed.ride.finalFare.total.amount + 500);

    const after = await harness.container.repositories.drivers.findById(driverId as never);
    expect(after!.ratingCount).toBe(before!.ratingCount + 1);
  });

  it('lets the driver rate the rider', async () => {
    const riderToken = (await signIn(harness, DEMO_RIDER_PHONE)).token;
    const { rideId } = await bookStandardRide(harness, riderToken);
    const { token: driverToken, offerId } = await driverWithPendingOffer(harness, rideId);
    const driver = asUser(harness, driverToken);

    await driver.post(`/v1/driver/offers/${offerId}/accept`);
    await driver.post(`/v1/driver/rides/${rideId}/start`);
    await harness.advance(60_000);
    await driver.post(`/v1/driver/rides/${rideId}/complete`);

    const rated = (await driver.post(`/v1/driver/rides/${rideId}/rate`, { stars: 4 })).json();
    expect(rated.ride.riderRating.stars).toBe(4);
  });

  it('refuses to rate a ride that has not finished', async () => {
    const riderToken = (await signIn(harness, DEMO_RIDER_PHONE)).token;
    const { rideId } = await bookStandardRide(harness, riderToken);
    const response = await asUser(harness, riderToken).post(`/v1/rides/${rideId}/rate`, {
      stars: 5,
    });
    expect(response.statusCode).toBe(409);
  });
});

describe('the driver experience', () => {
  it('blocks a driver from going online before onboarding is finished', async () => {
    const { token } = await signIn(harness, '+14155558881', 'driver');
    const response = await asUser(harness, token).post('/v1/driver/online');
    expect(response.statusCode).toBe(409);
    expect(response.json().error.userMessage).toMatch(/onboarding|vehicle|document/i);
  });

  it('walks a new driver through onboarding to being dispatchable', async () => {
    const { token, driverId } = await signIn(harness, '+14155558882', 'driver');
    const driver = asUser(harness, token);

    // A vehicle unlocks the tiers it qualifies for.
    const vehicle = (
      await driver.post('/v1/driver/vehicles', {
        make: 'Toyota',
        model: 'Sienna',
        year: new Date().getFullYear() - 1,
        color: 'silver',
        licensePlate: '8XYZ123',
        seats: 6,
        features: [],
      })
    ).json();
    expect(vehicle.vehicle.licensePlate).toBe('8XYZ123');
    const qualifiesForXl = vehicle.qualification.find(
      (q: { rideTypeId: string }) => q.rideTypeId === 'xl',
    );
    expect(qualifiesForXl.qualifies).toBe(true);

    // Documents move them into review.
    for (const type of [
      'drivers_license',
      'vehicle_registration',
      'insurance',
      'background_check',
      'profile_photo',
    ]) {
      await driver.post('/v1/driver/documents', { type });
    }

    let status = (await driver.get('/v1/driver/status')).json();
    expect(status.canGoOnline).toBe(false);
    expect(status.missingDocuments).toHaveLength(5); // pending, not approved

    // An operator approves everything.
    await harness.container.repositories.drivers.update(driverId as never, {
      approvalStatus: 'approved',
      documents: [
        { type: 'drivers_license', status: 'approved' },
        { type: 'vehicle_registration', status: 'approved' },
        { type: 'insurance', status: 'approved' },
        { type: 'background_check', status: 'approved' },
        { type: 'profile_photo', status: 'approved' },
      ],
    });

    status = (await driver.get('/v1/driver/status')).json();
    expect(status.canGoOnline).toBe(true);
    expect(status.missingDocuments).toHaveLength(0);

    const online = (
      await driver.post('/v1/driver/online', {
        position: { lat: 37.7955, lng: -122.3937 },
      })
    ).json();
    expect(online.driver.availability).toBe('available');
    expect((await driver.get('/v1/driver/status')).json().openShift).toBeDefined();
  });

  it('accepts location pings and makes the driver findable at the new spot', async () => {
    const { token } = await signIn(harness, DEMO_DRIVER_PHONE, 'driver');
    const driver = asUser(harness, token);

    await driver.post('/v1/driver/location', {
      lat: 37.7955,
      lng: -122.3937,
      bearing: 90,
      speed: 8,
    });

    const nearby = await harness.container.drivers.nearbyDrivers(
      { lat: 37.7955, lng: -122.3937 },
      500,
    );
    expect(nearby.length).toBeGreaterThan(0);
  });

  it('goes offline and closes the shift', async () => {
    const { token } = await signIn(harness, DEMO_DRIVER_PHONE, 'driver');
    const driver = asUser(harness, token);
    await driver.post('/v1/driver/online');
    await harness.advance(30 * 60_000);

    const offline = (await driver.post('/v1/driver/offline')).json();
    expect(offline.driver.availability).toBe('offline');
    expect((await driver.get('/v1/driver/status')).json().openShift).toBeUndefined();
  });

  it('refuses to go offline mid-ride', async () => {
    const riderToken = (await signIn(harness, DEMO_RIDER_PHONE)).token;
    const { rideId } = await bookStandardRide(harness, riderToken);
    const { token: driverToken, offerId } = await driverWithPendingOffer(harness, rideId);
    const driver = asUser(harness, driverToken);
    await driver.post(`/v1/driver/offers/${offerId}/accept`);

    const response = await driver.post('/v1/driver/offline');
    expect(response.statusCode).toBe(409);
  });

  it('honours a destination filter by not offering rides that go elsewhere', async () => {
    const riderToken = (await signIn(harness, DEMO_RIDER_PHONE)).token;

    // Point every seeded driver at the airport, far from the Dolores dropoff.
    for (const driver of await harness.container.repositories.drivers.list(50)) {
      await harness.container.repositories.drivers.update(driver.id, {
        preferences: {
          ...driver.preferences,
          destinationFilter: {
            address: 'SFO',
            lat: 37.6213,
            lng: -122.379,
            radiusMeters: 2_000,
            expiresAt: harness.clock.now() + 3_600_000,
          },
        },
      });
    }

    const { rideId } = await bookStandardRide(harness, riderToken);
    const offers = await harness.container.repositories.offers.findForRide(rideId as never);
    expect(offers).toHaveLength(0);
  });

  it('reports earnings for the day', async () => {
    const riderToken = (await signIn(harness, DEMO_RIDER_PHONE)).token;
    const { rideId } = await bookStandardRide(harness, riderToken);
    const { token: driverToken, offerId } = await driverWithPendingOffer(harness, rideId);
    const driver = asUser(harness, driverToken);

    await driver.post(`/v1/driver/offers/${offerId}/accept`);
    await driver.post(`/v1/driver/rides/${rideId}/start`);
    await harness.advance(10 * 60_000);
    await driver.post(`/v1/driver/rides/${rideId}/complete`);

    const earnings = (await driver.get('/v1/driver/earnings?period=today')).json();
    expect(earnings.summary.ridesCompleted).toBe(1);
    expect(earnings.summary.total.amount).toBeGreaterThan(0);
    expect(earnings.rides).toHaveLength(1);
    expect(earnings.rides[0].pickup).toBe('Ferry Building');
  });
});

describe('rider account', () => {
  it('manages saved places', async () => {
    const { token } = await signIn(harness, '+14155556001');
    const rider = asUser(harness, token);

    const saved = (
      await rider.post('/v1/rider/places', { label: 'Gym', place: DOLORES_PARK })
    ).json();
    expect(saved.places).toHaveLength(1);
    expect(saved.places[0].icon).toBe('star');

    const removed = (await rider.delete(`/v1/rider/places/${saved.places[0].id}`)).json();
    expect(removed.places).toHaveLength(0);
  });

  it('manages payment methods and keeps exactly one default', async () => {
    const { token } = await signIn(harness, '+14155556002');
    const rider = asUser(harness, token);

    const first = (
      await rider.post('/v1/rider/payment-methods', {
        kind: 'card',
        brand: 'visa',
        last4: '4242',
      })
    ).json();
    // The first card added becomes the default automatically.
    expect(first.method.isDefault).toBe(true);
    expect(first.method.displayLabel).toBe('Visa •••• 4242');
    // A gateway token must never reach the client.
    expect(first.method.gatewayToken).toBeUndefined();

    const second = (
      await rider.post('/v1/rider/payment-methods', {
        kind: 'card',
        brand: 'amex',
        last4: '0005',
      })
    ).json();

    const updated = (
      await rider.post(`/v1/rider/payment-methods/${second.method.id}/default`)
    ).json();
    expect(updated.methods.filter((m: { isDefault: boolean }) => m.isDefault)).toHaveLength(1);
    expect(updated.methods[0].id).toBe(second.method.id);
  });

  it('lists ride history after a completed ride', async () => {
    const riderToken = (await signIn(harness, DEMO_RIDER_PHONE)).token;
    const { rideId } = await bookStandardRide(harness, riderToken);
    const { token: driverToken, offerId } = await driverWithPendingOffer(harness, rideId);
    const driver = asUser(harness, driverToken);
    await driver.post(`/v1/driver/offers/${offerId}/accept`);
    await driver.post(`/v1/driver/rides/${rideId}/start`);
    await harness.advance(60_000);
    await driver.post(`/v1/driver/rides/${rideId}/complete`);

    const history = (await asUser(harness, riderToken).get('/v1/rides/history')).json();
    expect(history.rides.map((r: { id: string }) => r.id)).toContain(rideId);
  });
});

describe('in-ride chat', () => {
  it('opens once a driver is assigned and closes when the ride ends', async () => {
    const riderToken = (await signIn(harness, DEMO_RIDER_PHONE)).token;
    const { rideId } = await bookStandardRide(harness, riderToken);
    const rider = asUser(harness, riderToken);

    // Nobody to talk to yet.
    const tooEarly = await rider.post(`/v1/rides/${rideId}/messages`, { text: 'hello?' });
    expect(tooEarly.statusCode).toBe(409);

    const { token: driverToken, offerId } = await driverWithPendingOffer(harness, rideId);
    const driver = asUser(harness, driverToken);
    await driver.post(`/v1/driver/offers/${offerId}/accept`);

    await rider.post(`/v1/rides/${rideId}/messages`, { text: "I'm by the clock tower" });
    await driver.post(`/v1/rides/${rideId}/messages`, { text: 'Two minutes away' });

    const messages = (await rider.get(`/v1/rides/${rideId}/messages`)).json();
    expect(messages.messages.map((m: { from: string }) => m.from)).toEqual(['rider', 'driver']);

    await driver.post(`/v1/driver/rides/${rideId}/start`);
    await harness.advance(60_000);
    await driver.post(`/v1/driver/rides/${rideId}/complete`);

    const tooLate = await rider.post(`/v1/rides/${rideId}/messages`, { text: 'thanks!' });
    expect(tooLate.statusCode).toBe(409);
  });
});

describe('notifications', () => {
  it('pushes the milestones a rider and driver should hear about', async () => {
    const riderToken = (await signIn(harness, DEMO_RIDER_PHONE)).token;
    const { rideId } = await bookStandardRide(harness, riderToken);
    const { token: driverToken, offerId } = await driverWithPendingOffer(harness, rideId);
    const driver = asUser(harness, driverToken);

    await driver.post(`/v1/driver/offers/${offerId}/accept`);
    await driver.post(`/v1/driver/rides/${rideId}/arrived`);
    await driver.post(`/v1/driver/rides/${rideId}/start`);
    await harness.advance(60_000);
    await driver.post(`/v1/driver/rides/${rideId}/complete`);

    const titles = harness.push.sent.map((m) => m.title);
    expect(titles).toEqual(
      expect.arrayContaining([
        expect.stringContaining('New ride'),
        'Your driver is on the way',
        'Your driver is here',
        "You've arrived",
      ]),
    );
    // The offer push must reach the driver, not the rider.
    const offerPush = harness.push.sent.find((m) => m.title.startsWith('New ride'));
    expect(offerPush!.to.kind).toBe('driver');
  });
});

describe('payments', () => {
  it('surfaces a declined card rather than silently completing the ride', async () => {
    const declining = await createHarness({ declineRate: 1, seed: { driverCount: 4, seed: 3 } });
    try {
      const riderToken = (await signIn(declining, DEMO_RIDER_PHONE)).token;
      const { rideId } = await bookStandardRide(declining, riderToken);
      const { token: driverToken, offerId } = await driverWithPendingOffer(declining, rideId);
      const driver = asUser(declining, driverToken);

      await driver.post(`/v1/driver/offers/${offerId}/accept`);
      await driver.post(`/v1/driver/rides/${rideId}/start`);
      await declining.advance(60_000);
      await driver.post(`/v1/driver/rides/${rideId}/complete`);
      // Settlement is asynchronous; let the microtask queue drain.
      await new Promise((resolve) => setTimeout(resolve, 10));

      const charges = await declining.container.payments.chargesForRide(rideId as never);
      expect(charges.some((c) => c.status === 'failed')).toBe(true);
      const failure = declining.push.sent.find((m) => m.title === 'Payment problem');
      expect(failure).toBeDefined();
    } finally {
      await declining.close();
    }
  });

  it('authorizes a hold once a driver is assigned', async () => {
    const riderToken = (await signIn(harness, DEMO_RIDER_PHONE)).token;
    const { rideId } = await bookStandardRide(harness, riderToken);
    const { token: driverToken, offerId } = await driverWithPendingOffer(harness, rideId);
    await asUser(harness, driverToken).post(`/v1/driver/offers/${offerId}/accept`);
    await new Promise((resolve) => setTimeout(resolve, 10));

    const held = await harness.container.payments.heldChargeFor(rideId as never);
    expect(held).toBeDefined();
    expect(held!.status).toBe('authorized');
  });
});
