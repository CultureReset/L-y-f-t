import { describe, expect, it } from 'vitest';
import { DispatchRegistry, DispatchSession } from './dispatcher.js';
import type { DispatchCommand, DriverCandidate, OfferPreview, RideOffer } from './types.js';
import {
  fairnessStrategy,
  fastestEtaStrategy,
  filterEligible,
  roundRobinStrategy,
  scoredStrategy,
} from './strategies.js';
import { T0, SF_PLACES, candidateAt, makeMatchRequest } from '../testing/factories.js';
import { fromDecimal } from '../util/money.js';
import { RideTypeCatalog } from '../catalog/rideTypes.js';

const buildPreview = (candidate: DriverCandidate): OfferPreview => ({
  rideTypeId: 'standard',
  pickupAddress: 'Ferry Building',
  pickupCoordinates: SF_PLACES.ferryBuilding,
  dropoffAddress: 'Mission Dolores Park',
  dropoffCoordinates: SF_PLACES.missionDolores,
  pickupEtaMs: candidate.etaToPickupMs,
  pickupDistanceMeters: candidate.distanceMeters,
  tripDistanceMeters: 4200,
  tripDurationMs: 840_000,
  estimatedPayout: fromDecimal(11.7),
  surgeMultiplier: 1,
  riderRating: 4.9,
  riderName: 'Avery C.',
  stopCount: 0,
  passengerCount: 1,
});

const session = (
  overrides: Partial<ConstructorParameters<typeof DispatchSession>[0]> = {},
): DispatchSession =>
  new DispatchSession({
    request: makeMatchRequest(),
    startedAt: T0,
    buildPreview,
    strategy: fastestEtaStrategy(),
    tuning: { offerTimeoutMs: 15_000, roundDelayMs: 1_000, searchTimeoutMs: 300_000 },
    ...overrides,
  });

const offersIn = (commands: readonly DispatchCommand[]): RideOffer[] =>
  commands.filter((c) => c.type === 'send_offer').map((c) => c.offer);

describe('DispatchSession', () => {
  it('offers the best-ranked driver first', () => {
    const near = candidateAt(500);
    const far = candidateAt(9000);
    const commands = session().tick(T0, [far, near]);
    const offers = offersIn(commands);
    expect(offers).toHaveLength(1);
    expect(offers[0]!.driverId).toBe(near.driverId);
    expect(offers[0]!.expiresAt).toBe(T0 + 15_000);
  });

  it('waits for an answer rather than offering the same ride twice', () => {
    const s = session();
    const drivers = [candidateAt(500), candidateAt(800)];
    expect(offersIn(s.tick(T0, drivers))).toHaveLength(1);
    expect(offersIn(s.tick(T0 + 1_000, drivers))).toHaveLength(0);
    expect(offersIn(s.tick(T0 + 5_000, drivers))).toHaveLength(0);
    expect(s.getStatus()).toBe('awaiting_response');
  });

  it('assigns the driver who accepts and stops searching', () => {
    const s = session();
    const offer = offersIn(s.tick(T0, [candidateAt(500)]))[0]!;
    const commands = s.accept(offer.id, T0 + 3_000);
    const assign = commands.find((c) => c.type === 'assign_driver');
    expect(assign).toMatchObject({ driverId: offer.driverId, offerId: offer.id });
    expect(s.getStatus()).toBe('matched');
    expect(s.isFinished()).toBe(true);
    expect(s.tick(T0 + 4_000, [candidateAt(100)])).toEqual([]);
  });

  it('moves to the next driver when the first declines', () => {
    const s = session();
    const near = candidateAt(500);
    const next = candidateAt(1500);
    const first = offersIn(s.tick(T0, [near, next]))[0]!;
    expect(first.driverId).toBe(near.driverId);

    s.decline(first.id, T0 + 4_000);
    const second = offersIn(s.tick(T0 + 4_001, [near, next]))[0]!;
    expect(second.driverId).toBe(next.driverId);
    expect(s.diagnostics().offersDeclined).toBe(1);
  });

  it('expires an unanswered offer and moves on', () => {
    const s = session();
    const near = candidateAt(500);
    const next = candidateAt(1500);
    const first = offersIn(s.tick(T0, [near, next]))[0]!;

    const atTimeout = s.tick(T0 + 15_000, [near, next]);
    expect(atTimeout.find((c) => c.type === 'expire_offer')).toMatchObject({
      offerId: first.id,
      driverId: near.driverId,
    });
    // The same tick issues the next offer.
    expect(offersIn(atTimeout)[0]!.driverId).toBe(next.driverId);
    expect(s.diagnostics().offersExpired).toBe(1);
  });

  it('never re-offers a ride to a driver who already declined it', () => {
    const s = session();
    const drivers = [candidateAt(500), candidateAt(1500), candidateAt(2500)];
    const seen: string[] = [];
    let now = T0;
    for (let i = 0; i < 3; i++) {
      const offer = offersIn(s.tick(now, drivers))[0];
      if (!offer) break;
      seen.push(offer.driverId);
      s.decline(offer.id, now);
      now += 1_500;
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toHaveLength(3);
  });

  it('gives up once the search window closes', () => {
    const s = session({ tuning: { searchTimeoutMs: 60_000, roundDelayMs: 1_000 } });
    s.tick(T0, []);
    const commands = s.tick(T0 + 60_000, [candidateAt(200)]);
    expect(commands).toContainEqual({
      type: 'no_drivers_found',
      rideId: s.rideId,
      searchedMs: 60_000,
    });
    expect(s.getStatus()).toBe('failed');
  });

  it('widens the radius each round when nobody is in range', () => {
    const s = session({
      tuning: {
        searchRadiusMeters: 1_000,
        radiusExpansionFactor: 2,
        maxSearchRadiusMeters: 8_000,
        roundDelayMs: 1_000,
      },
    });
    const distant = [candidateAt(3_500)];

    expect(offersIn(s.tick(T0, distant))).toHaveLength(0);
    expect(s.diagnostics().currentRadiusMeters).toBe(2_000);

    expect(offersIn(s.tick(T0 + 1_001, distant))).toHaveLength(0);
    expect(s.diagnostics().currentRadiusMeters).toBe(4_000);

    // Now 3.5 km is inside the radius.
    expect(offersIn(s.tick(T0 + 2_002, distant))).toHaveLength(1);
  });

  it('respects the round delay before widening again', () => {
    const s = session({ tuning: { searchRadiusMeters: 100, roundDelayMs: 5_000 } });
    s.tick(T0, [candidateAt(9_000)]);
    const radiusAfterFirst = s.diagnostics().currentRadiusMeters;
    s.tick(T0 + 1_000, [candidateAt(9_000)]);
    expect(s.diagnostics().currentRadiusMeters).toBe(radiusAfterFirst);
  });

  it('offers a batch of drivers at once and voids the losers on accept', () => {
    const s = session({ tuning: { offerBatchSize: 3 } });
    const drivers = [candidateAt(400), candidateAt(900), candidateAt(1400), candidateAt(6000)];
    const offers = offersIn(s.tick(T0, drivers));
    expect(offers).toHaveLength(3);

    const commands = s.accept(offers[1]!.id, T0 + 2_000);
    const expired = commands.filter((c) => c.type === 'expire_offer');
    expect(expired).toHaveLength(2);
    expect(commands.find((c) => c.type === 'assign_driver')).toMatchObject({
      driverId: offers[1]!.driverId,
    });
  });

  it('auto-accepts for a driver who opted in', () => {
    const s = session();
    const commands = s.tick(T0, [candidateAt(500, { autoAccept: true })]);
    expect(commands.find((c) => c.type === 'assign_driver')).toBeDefined();
    expect(s.getStatus()).toBe('matched');
  });

  it('ignores an accept for an offer that already expired', () => {
    const s = session();
    const offer = offersIn(s.tick(T0, [candidateAt(500)]))[0]!;
    s.tick(T0 + 15_000, [candidateAt(500)]);
    expect(s.accept(offer.id, T0 + 16_000)).toEqual([]);
  });

  it('ignores a duplicate accept — the second driver loses the race', () => {
    const s = session({ tuning: { offerBatchSize: 2 } });
    const offers = offersIn(s.tick(T0, [candidateAt(400), candidateAt(900)]));
    expect(s.accept(offers[0]!.id, T0 + 1_000)).not.toEqual([]);
    expect(s.accept(offers[1]!.id, T0 + 1_100)).toEqual([]);
  });

  it('voids outstanding offers when the rider cancels', () => {
    const s = session({ tuning: { offerBatchSize: 2 } });
    offersIn(s.tick(T0, [candidateAt(400), candidateAt(900)]));
    const commands = s.cancel();
    expect(commands.filter((c) => c.type === 'expire_offer')).toHaveLength(2);
    expect(s.getStatus()).toBe('cancelled');
    expect(s.tick(T0 + 1_000, [candidateAt(100)])).toEqual([]);
  });

  it('reports why candidates were rejected', () => {
    const s = session({ tuning: { searchRadiusMeters: 1_000 } });
    s.tick(T0, [
      candidateAt(5_000),
      candidateAt(500, { eligibleRideTypeIds: ['lux'] }),
      candidateAt(600, { acceptedRideTypeIds: ['xl'] }),
    ]);
    const reasons = s.diagnostics().rejectionReasons;
    expect(reasons['outside_search_radius']).toBe(1);
    expect(reasons['vehicle_not_eligible']).toBe(1);
    expect(reasons['ride_type_not_accepted']).toBe(1);
  });

  it('runs a full waterfall to a match deterministically', () => {
    const s = session({ strategy: roundRobinStrategy() });
    const drivers = [
      candidateAt(500, { driverId: 'drv_a' as never }),
      candidateAt(600, { driverId: 'drv_b' as never }),
      candidateAt(700, { driverId: 'drv_c' as never }),
    ];
    let now = T0;
    // a and b let the offer time out; c accepts.
    let offer = offersIn(s.tick(now, drivers))[0]!;
    expect(offer.driverId).toBe('drv_a');
    now += 15_000;
    offer = offersIn(s.tick(now, drivers))[0]!;
    expect(offer.driverId).toBe('drv_b');
    now += 15_000;
    offer = offersIn(s.tick(now, drivers))[0]!;
    expect(offer.driverId).toBe('drv_c');

    const assign = s.accept(offer.id, now + 2_000).find((c) => c.type === 'assign_driver');
    expect(assign).toMatchObject({ driverId: 'drv_c' });
    expect(s.diagnostics()).toMatchObject({ offersSent: 3, offersExpired: 2 });
  });
});

describe('filterEligible', () => {
  const catalog = new RideTypeCatalog();

  it('drops drivers beyond the search radius', () => {
    const { eligible, rejected } = filterEligible(
      [candidateAt(500), candidateAt(20_000)],
      makeMatchRequest(),
      { searchRadiusMeters: 5_000, now: T0 },
    );
    expect(eligible).toHaveLength(1);
    expect(rejected[0]!.reason).toBe('outside_search_radius');
  });

  it('respects a driver’s own pickup distance limit', () => {
    const { rejected } = filterEligible(
      [candidateAt(4_000, { maxPickupDistanceMeters: 2_000 })],
      makeMatchRequest(),
      { searchRadiusMeters: 10_000, now: T0 },
    );
    expect(rejected[0]!.reason).toBe('beyond_driver_pickup_limit');
  });

  it('treats an empty opt-in list as "everything I qualify for"', () => {
    const { eligible } = filterEligible(
      [candidateAt(500, { acceptedRideTypeIds: [] })],
      makeMatchRequest(),
      { searchRadiusMeters: 10_000, now: T0 },
    );
    expect(eligible).toHaveLength(1);
  });

  it('honours an active destination filter and ignores an expired one', () => {
    const filterFarAway = {
      lat: SF_PLACES.sfo.lat,
      lng: SF_PLACES.sfo.lng,
      radiusMeters: 2_000,
      expiresAt: T0 + 60_000,
    };
    const request = makeMatchRequest();

    const active = filterEligible(
      [candidateAt(500, { destinationFilter: filterFarAway })],
      request,
      { searchRadiusMeters: 10_000, now: T0 },
    );
    expect(active.rejected[0]!.reason).toBe('outside_destination_filter');

    const expired = filterEligible(
      [candidateAt(500, { destinationFilter: { ...filterFarAway, expiresAt: T0 - 1 } })],
      request,
      { searchRadiusMeters: 10_000, now: T0 },
    );
    expect(expired.eligible).toHaveLength(1);
  });

  it('drops a ride type that cannot carry the party', () => {
    const { rejected } = filterEligible(
      [candidateAt(500)],
      makeMatchRequest({ passengerCount: 6 }),
      { searchRadiusMeters: 10_000, now: T0, catalog },
    );
    expect(rejected[0]!.reason).toBe('too_many_passengers');
  });

  it('excludes drivers already offered this ride', () => {
    const driver = candidateAt(500);
    const { rejected } = filterEligible(
      [driver],
      makeMatchRequest({ excludedDriverIds: [driver.driverId] }),
      { searchRadiusMeters: 10_000, now: T0 },
    );
    expect(rejected[0]!.reason).toBe('already_offered');
  });
});

describe('scoredStrategy', () => {
  it('prefers a closer driver, all else equal', () => {
    const ranked = scoredStrategy().rank(
      [candidateAt(8_000), candidateAt(600)],
      makeMatchRequest(),
    );
    expect(ranked[0]!.candidate.distanceMeters).toBe(600);
    expect(ranked[0]!.score).toBeGreaterThan(ranked[1]!.score);
  });

  it('exposes a per-component breakdown of every score', () => {
    const ranked = scoredStrategy().rank([candidateAt(600)], makeMatchRequest());
    expect(Object.keys(ranked[0]!.components).sort()).toEqual([
      'acceptance',
      'eta',
      'idle_time',
      'proximity',
      'rating',
    ]);
  });

  it('promotes a slightly farther driver who has been idle much longer', () => {
    const busy = candidateAt(600, { idleSinceMs: 0 });
    const idle = candidateAt(1_200, { idleSinceMs: 30 * 60 * 1000 });
    const ranked = scoredStrategy().rank([busy, idle], makeMatchRequest());
    expect(ranked[0]!.candidate.driverId).toBe(idle.driverId);
  });

  it('does not let the idle bonus override a much closer driver', () => {
    // Fairness nudges the ordering; it must not send a car four times as far.
    const near = candidateAt(600, { idleSinceMs: 0 });
    const veryFarButIdle = candidateAt(2_400, { idleSinceMs: 60 * 60 * 1000 });
    const ranked = scoredStrategy().rank([near, veryFarButIdle], makeMatchRequest());
    expect(ranked[0]!.candidate.driverId).toBe(near.driverId);
  });

  it('fairnessStrategy reserves the top slot for the longest-idle driver', () => {
    const near = candidateAt(600, { idleSinceMs: 0 });
    const veryFarButIdle = candidateAt(2_400, { idleSinceMs: 60 * 60 * 1000 });
    const ranked = fairnessStrategy().rank([near, veryFarButIdle], makeMatchRequest());
    expect(ranked[0]!.candidate.driverId).toBe(veryFarButIdle.driverId);
    expect(ranked[1]!.candidate.driverId).toBe(near.driverId);
  });
});

describe('DispatchRegistry', () => {
  it('tracks sessions by ride and closes them', () => {
    const registry = new DispatchRegistry();
    const s = session();
    registry.open(s);
    expect(registry.get(s.rideId)).toBe(s);
    expect(registry.active()).toHaveLength(1);
    registry.close(s.rideId);
    expect(registry.get(s.rideId)).toBeUndefined();
  });

  it('does not report finished sessions as active', () => {
    const registry = new DispatchRegistry();
    const s = registry.open(session());
    const offer = offersIn(s.tick(T0, [candidateAt(500)]))[0]!;
    s.accept(offer.id, T0 + 1_000);
    expect(registry.active()).toHaveLength(0);
    expect(registry.size()).toBe(1);
  });
});
