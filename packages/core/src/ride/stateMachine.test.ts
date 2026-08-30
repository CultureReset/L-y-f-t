import { beforeEach, describe, expect, it } from 'vitest';
import {
  TRANSITIONS,
  allowedActions,
  applyTransition,
  canTransition,
  transitionOrThrow,
} from './stateMachine.js';
import type { RideAction } from './stateMachine.js';
import { RIDE_STATUSES, isActive, isTerminal } from '../domain/ride.js';
import type { Actor, Ride, RideStatus } from '../domain/ride.js';
import { emptyFare } from '../pricing/engine.js';
import { isErr, isOk } from '../util/result.js';
import { T0, SF_PLACES, makeLeg, makeRide } from '../testing/factories.js';
import { newDriverId, newOfferId, newRiderId, newVehicleId } from '../util/ids.js';

const rider = (id = newRiderId()): Actor => ({ kind: 'rider', riderId: id });
const driver = (id = newDriverId()): Actor => ({ kind: 'driver', driverId: id });
const system: Actor = { kind: 'system', reason: 'test' };

const legs = [makeLeg(SF_PLACES.chinatown, SF_PLACES.ferryBuilding, 'to_pickup')];

const assignment = () => ({
  driverId: newDriverId(),
  vehicleId: newVehicleId(),
  assignedAt: T0 + 1000,
  offerId: newOfferId(),
  initialPickupEtaMs: 240_000,
});

/** Drives a ride through the happy path up to the requested status. */
const rideAt = (status: RideStatus): Ride => {
  const riderId = newRiderId();
  let ride = makeRide({ riderId });
  const drive = (action: RideAction, actor: Actor): void => {
    const result = applyTransition(ride, action, actor);
    if (!result.ok) throw result.error;
    ride = result.value.ride;
  };
  if (status === 'draft') return ride;
  drive({ type: 'request', at: T0 }, rider(riderId));
  if (status === 'requested') return ride;
  drive({ type: 'assign', at: T0 + 1000, assignment: assignment(), legs }, system);
  if (status === 'accepted') return ride;
  drive({ type: 'arrive', at: T0 + 200_000 }, system);
  if (status === 'arrived') return ride;
  drive({ type: 'start', at: T0 + 260_000 }, system);
  if (status === 'in_progress') return ride;
  drive(
    { type: 'complete', at: T0 + 1_100_000, finalFare: emptyFare('standard', 'USD', T0) },
    system,
  );
  return ride;
};

describe('ride state machine', () => {
  describe('the happy path', () => {
    it('walks draft → requested → accepted → arrived → in_progress → completed', () => {
      const ride = rideAt('completed');
      expect(ride.status).toBe('completed');
      expect(ride.timeline.map((e) => e.type)).toEqual([
        'requested',
        'accepted',
        'driver_arrived',
        'started',
        'completed',
      ]);
    });

    it('stamps a timestamp at each milestone', () => {
      const ride = rideAt('completed');
      expect(ride.requestedAt).toBe(T0);
      expect(ride.acceptedAt).toBe(T0 + 1000);
      expect(ride.arrivedAt).toBe(T0 + 200_000);
      expect(ride.startedAt).toBe(T0 + 260_000);
      expect(ride.completedAt).toBe(T0 + 1_100_000);
    });

    it('records the assignment and route legs when a driver is assigned', () => {
      const ride = rideAt('accepted');
      expect(ride.assignment).toBeDefined();
      expect(ride.legs).toHaveLength(1);
      expect(ride.legs[0]!.kind).toBe('to_pickup');
    });

    it('lets a driver start the trip without tapping arrived first', () => {
      const result = applyTransition(rideAt('accepted'), { type: 'start', at: T0 + 300_000 }, system);
      expect(isOk(result)).toBe(true);
      expect(isOk(result) && result.value.ride.status).toBe('in_progress');
    });
  });

  describe('illegal transitions', () => {
    it('refuses to start a ride that was never requested', () => {
      const result = applyTransition(makeRide(), { type: 'start', at: T0 }, system);
      expect(isErr(result)).toBe(true);
      expect(isErr(result) && result.error.code).toBe('invalid_transition');
    });

    it('refuses to complete a ride that never started', () => {
      const result = applyTransition(
        rideAt('arrived'),
        { type: 'complete', at: T0, finalFare: emptyFare('standard', 'USD', T0) },
        system,
      );
      expect(isErr(result) && result.error.code).toBe('invalid_transition');
    });

    it('refuses to act on a ride in any terminal status', () => {
      for (const status of ['completed', 'cancelled', 'expired'] as const) {
        const ride = { ...makeRide(), status };
        for (const action of Object.keys(TRANSITIONS)) {
          expect(canTransition(status, action as never)).toBe(false);
        }
        const result = applyTransition(ride, { type: 'arrive', at: T0 }, system);
        expect(isErr(result)).toBe(true);
      }
    });

    it('refuses to double-assign a ride', () => {
      const ride = rideAt('accepted');
      const result = applyTransition(
        { ...ride, status: 'requested' },
        { type: 'assign', at: T0 + 5000, assignment: assignment(), legs },
        system,
      );
      expect(isErr(result) && result.error.code).toBe('conflict');
      expect(isErr(result) && result.error.userMessage).toMatch(/Another driver/);
    });

    it('refuses an assignment with no route legs', () => {
      const result = applyTransition(
        rideAt('requested'),
        { type: 'assign', at: T0, assignment: assignment(), legs: [] },
        system,
      );
      expect(isErr(result) && result.error.code).toBe('validation_failed');
    });

    it('refuses a completion timestamped before the start', () => {
      const result = applyTransition(
        rideAt('in_progress'),
        { type: 'complete', at: T0, finalFare: emptyFare('standard', 'USD', T0) },
        system,
      );
      expect(isErr(result) && result.error.code).toBe('validation_failed');
    });
  });

  describe('actor permissions', () => {
    it('will not let a rider mark themselves as picked up', () => {
      const ride = rideAt('accepted');
      const result = applyTransition(ride, { type: 'start', at: T0 + 5000 }, rider(ride.riderId));
      expect(isErr(result) && result.error.code).toBe('forbidden');
    });

    it('will not let a driver expire a ride', () => {
      const result = applyTransition(rideAt('requested'), { type: 'expire', at: T0 }, driver());
      expect(isErr(result) && result.error.code).toBe('forbidden');
    });

    it('will not let an unrelated driver cancel an assigned ride', () => {
      const ride = rideAt('accepted');
      const result = applyTransition(
        ride,
        {
          type: 'cancel',
          at: T0 + 5000,
          cancellation: { reason: 'other', by: driver(), at: T0 + 5000 },
        },
        driver(),
      );
      expect(isErr(result) && result.error.message).toMatch(/Only the assigned driver/);
    });

    it('lets the assigned driver cancel', () => {
      const ride = rideAt('accepted');
      const assignedDriver = driver(ride.assignment!.driverId);
      const result = applyTransition(
        ride,
        {
          type: 'cancel',
          at: T0 + 5000,
          cancellation: { reason: 'driver_vehicle_issue', by: assignedDriver, at: T0 + 5000 },
        },
        assignedDriver,
      );
      expect(isOk(result)).toBe(true);
    });

    it('will not let a different rider cancel someone else’s ride', () => {
      const ride = rideAt('requested');
      const result = applyTransition(
        ride,
        {
          type: 'cancel',
          at: T0,
          cancellation: { reason: 'other', by: rider(), at: T0 },
        },
        rider(),
      );
      expect(isErr(result) && result.error.message).toMatch(/Only the rider/);
    });
  });

  describe('cancellation and expiry', () => {
    it('can be cancelled from every pre-trip status', () => {
      for (const status of ['requested', 'accepted', 'arrived'] as const) {
        const ride = rideAt(status);
        const result = applyTransition(
          ride,
          {
            type: 'cancel',
            at: T0 + 10_000,
            cancellation: { reason: 'rider_changed_mind', by: rider(ride.riderId), at: T0 + 10_000 },
          },
          rider(ride.riderId),
        );
        expect(isOk(result)).toBe(true);
        expect(isOk(result) && result.value.ride.status).toBe('cancelled');
      }
    });

    it('cannot be cancelled once the trip is under way', () => {
      const ride = rideAt('in_progress');
      const result = applyTransition(
        ride,
        {
          type: 'cancel',
          at: T0,
          cancellation: { reason: 'other', by: rider(ride.riderId), at: T0 },
        },
        rider(ride.riderId),
      );
      expect(isErr(result) && result.error.code).toBe('invalid_transition');
    });

    it('records the cancellation reason and fee on the ride', () => {
      const ride = rideAt('accepted');
      const result = applyTransition(
        ride,
        {
          type: 'cancel',
          at: T0 + 400_000,
          cancellation: {
            reason: 'rider_changed_mind',
            by: rider(ride.riderId),
            at: T0 + 400_000,
            fee: { amount: 500, currency: 'USD' },
          },
        },
        rider(ride.riderId),
      );
      expect(isOk(result) && result.value.ride.cancellation?.fee?.amount).toBe(500);
      expect(isOk(result) && result.value.event.data?.['fee']).toBe(500);
    });

    it('expires a search that found nobody', () => {
      const result = applyTransition(rideAt('requested'), { type: 'expire', at: T0 + 300_000 }, system);
      expect(isOk(result) && result.value.ride.status).toBe('expired');
    });
  });

  it('never mutates the input ride', () => {
    const ride = rideAt('requested');
    const snapshot = JSON.stringify(ride);
    applyTransition(ride, { type: 'assign', at: T0, assignment: assignment(), legs }, system);
    expect(JSON.stringify(ride)).toBe(snapshot);
  });

  it('transitionOrThrow throws the underlying AppError', () => {
    expect(() => transitionOrThrow(makeRide(), { type: 'start', at: T0 }, system)).toThrow(
      /Cannot "start"/,
    );
  });

  describe('status helpers', () => {
    it('classifies every status as active, terminal, or neither', () => {
      for (const status of RIDE_STATUSES) {
        expect(isActive(status) && isTerminal(status)).toBe(false);
      }
      expect(RIDE_STATUSES.filter(isTerminal)).toEqual(['completed', 'cancelled', 'expired']);
    });

    it('reports the actions available from a status', () => {
      expect(allowedActions('requested').sort()).toEqual(['assign', 'cancel', 'expire']);
      expect(allowedActions('in_progress')).toEqual(['complete']);
      expect(allowedActions('completed')).toEqual([]);
    });
  });
});
