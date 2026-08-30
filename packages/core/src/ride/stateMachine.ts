/**
 * The ride state machine.
 *
 * Every status change in the platform goes through `applyTransition`. The
 * transition table below is the single authority on what can happen next and
 * who is allowed to make it happen — the HTTP layer, the dispatcher, the
 * driver app and the simulator all funnel through here, so an illegal
 * sequence is impossible to express rather than merely discouraged.
 */

import type {
  Actor,
  Cancellation,
  Ride,
  RideAssignment,
  RideEvent,
  RideEventType,
  RideLeg,
  RideStatus,
} from '../domain/ride.js';
import { appendEvent, isTerminal } from '../domain/ride.js';
import type { FareBreakdown } from '../pricing/types.js';
import { AppError } from '../util/errors.js';
import type { Result } from '../util/result.js';
import { err, ok } from '../util/result.js';

export type ActorKind = Actor['kind'];

/** The verbs the machine understands. One per meaningful lifecycle event. */
export type RideAction =
  | { readonly type: 'request'; readonly at: number }
  | {
      readonly type: 'assign';
      readonly at: number;
      readonly assignment: RideAssignment;
      readonly legs: readonly RideLeg[];
    }
  | { readonly type: 'arrive'; readonly at: number }
  | { readonly type: 'start'; readonly at: number }
  | {
      readonly type: 'complete';
      readonly at: number;
      readonly finalFare: FareBreakdown;
    }
  | { readonly type: 'cancel'; readonly at: number; readonly cancellation: Cancellation }
  | { readonly type: 'expire'; readonly at: number };

export type RideActionType = RideAction['type'];

interface TransitionRule {
  readonly from: readonly RideStatus[];
  readonly to: RideStatus;
  /** Roles permitted to trigger this action. */
  readonly actors: readonly ActorKind[];
  readonly event: RideEventType;
}

/**
 * The transition table. Read this to understand the entire ride lifecycle —
 * there is no other place where a status is allowed to change.
 */
export const TRANSITIONS: Record<RideActionType, TransitionRule> = {
  request: {
    from: ['draft', 'scheduled'],
    to: 'requested',
    actors: ['rider', 'system', 'admin'],
    event: 'requested',
  },
  assign: {
    from: ['requested'],
    to: 'accepted',
    actors: ['driver', 'system', 'admin'],
    event: 'accepted',
  },
  arrive: {
    from: ['accepted'],
    to: 'arrived',
    actors: ['driver', 'system', 'admin'],
    event: 'driver_arrived',
  },
  start: {
    // A driver may start the trip without tapping "arrived" first — riders are
    // often already at the curb, and forcing the extra tap loses data we'd
    // rather infer than block on.
    from: ['arrived', 'accepted'],
    to: 'in_progress',
    actors: ['driver', 'system', 'admin'],
    event: 'started',
  },
  complete: {
    from: ['in_progress'],
    to: 'completed',
    actors: ['driver', 'system', 'admin'],
    event: 'completed',
  },
  cancel: {
    from: ['draft', 'scheduled', 'requested', 'accepted', 'arrived'],
    to: 'cancelled',
    actors: ['rider', 'driver', 'system', 'admin'],
    event: 'cancelled',
  },
  expire: {
    from: ['requested', 'scheduled'],
    to: 'expired',
    actors: ['system', 'admin'],
    event: 'expired',
  },
};

export const canTransition = (from: RideStatus, action: RideActionType): boolean =>
  TRANSITIONS[action].from.includes(from);

export const allowedActions = (status: RideStatus): RideActionType[] =>
  (Object.keys(TRANSITIONS) as RideActionType[]).filter((a) => canTransition(status, a));

export const nextStatus = (action: RideActionType): RideStatus => TRANSITIONS[action].to;

const transitionError = (ride: Ride, action: RideActionType): AppError =>
  new AppError(
    'invalid_transition',
    `Cannot "${action}" a ride in status "${ride.status}"`,
    {
      details: {
        rideId: ride.id,
        status: ride.status,
        action,
        allowedFrom: TRANSITIONS[action].from,
      },
      userMessage: isTerminal(ride.status)
        ? 'This ride has already finished.'
        : "This ride can't do that right now.",
    },
  );

const actorError = (action: RideActionType, actor: Actor): AppError =>
  new AppError('forbidden', `A ${actor.kind} may not "${action}" this ride`, {
    details: { action, actorKind: actor.kind, allowed: TRANSITIONS[action].actors },
  });

/**
 * Apply an action to a ride, returning the next ride or an error. Pure: the
 * input ride is never mutated, which is what lets callers stage a transition,
 * persist it, and only then publish the resulting events.
 */
export const applyTransition = (
  ride: Ride,
  action: RideAction,
  actor: Actor,
): Result<{ ride: Ride; event: RideEvent }> => {
  const rule = TRANSITIONS[action.type];

  if (!rule.from.includes(ride.status)) return err(transitionError(ride, action.type));
  if (!rule.actors.includes(actor.kind)) return err(actorError(action.type, actor));

  const guard = GUARDS[action.type];
  const guardFailure = guard?.(ride, action, actor);
  if (guardFailure) return err(guardFailure);

  const event: RideEvent = {
    at: action.at,
    type: rule.event,
    actor,
    data: eventData(action),
  };

  let next: Ride = { ...ride, status: rule.to, updatedAt: action.at };

  switch (action.type) {
    case 'request':
      next = { ...next, requestedAt: action.at };
      break;
    case 'assign':
      next = {
        ...next,
        assignment: action.assignment,
        legs: action.legs,
        acceptedAt: action.at,
      };
      break;
    case 'arrive':
      next = { ...next, arrivedAt: action.at };
      break;
    case 'start':
      next = { ...next, startedAt: action.at };
      break;
    case 'complete':
      next = { ...next, completedAt: action.at, finalFare: action.finalFare };
      break;
    case 'cancel':
      next = { ...next, cancellation: action.cancellation };
      break;
    case 'expire':
      break;
  }

  return ok({ ride: appendEvent(next, event), event });
};

/**
 * Extra conditions a transition must satisfy beyond "the status allows it".
 * Kept separate from the table so the table stays readable.
 */
const GUARDS: Partial<
  Record<RideActionType, (ride: Ride, action: RideAction, actor: Actor) => AppError | undefined>
> = {
  assign: (ride, action) => {
    if (action.type !== 'assign') return undefined;
    if (ride.assignment) {
      return new AppError('conflict', 'Ride already has a driver assigned', {
        details: { rideId: ride.id, existing: ride.assignment.driverId },
        userMessage: 'Another driver got there first.',
      });
    }
    if (action.legs.length === 0) {
      return new AppError('validation_failed', 'Assignment requires at least one route leg');
    }
    return undefined;
  },
  complete: (ride, action) => {
    if (action.type !== 'complete') return undefined;
    if (ride.startedAt === undefined) {
      return new AppError('invalid_transition', 'Cannot complete a ride that never started');
    }
    if (action.at < ride.startedAt) {
      return new AppError('validation_failed', 'Completion time precedes start time');
    }
    return undefined;
  },
  cancel: (ride, action, actor) => {
    if (action.type !== 'cancel') return undefined;
    // Only the assigned driver may cancel as a driver.
    if (
      actor.kind === 'driver' &&
      ride.assignment &&
      ride.assignment.driverId !== actor.driverId
    ) {
      return new AppError('forbidden', 'Only the assigned driver can cancel this ride');
    }
    if (actor.kind === 'rider' && ride.riderId !== actor.riderId) {
      return new AppError('forbidden', 'Only the rider on this ride can cancel it');
    }
    return undefined;
  },
};

const eventData = (action: RideAction): Record<string, unknown> | undefined => {
  switch (action.type) {
    case 'assign':
      return {
        driverId: action.assignment.driverId,
        vehicleId: action.assignment.vehicleId,
        offerId: action.assignment.offerId,
        pickupEtaMs: action.assignment.initialPickupEtaMs,
      };
    case 'complete':
      return { total: action.finalFare.total.amount, currency: action.finalFare.total.currency };
    case 'cancel':
      return {
        reason: action.cancellation.reason,
        fee: action.cancellation.fee?.amount ?? 0,
        waived: action.cancellation.feeWaived ?? false,
      };
    default:
      return undefined;
  }
};

/**
 * A convenience wrapper that throws instead of returning a Result — used at
 * HTTP boundaries where the error handler already converts AppError to a
 * response.
 */
export const transitionOrThrow = (ride: Ride, action: RideAction, actor: Actor): Ride => {
  const result = applyTransition(ride, action, actor);
  if (!result.ok) throw result.error;
  return result.value.ride;
};
