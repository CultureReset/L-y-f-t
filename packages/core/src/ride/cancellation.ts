/**
 * Cancellation policy.
 *
 * Whether a cancellation costs anything is a policy decision, so it lives in a
 * `CancellationPolicy` you can replace, not scattered through the ride
 * service. The default policy: free before a driver is assigned, free for a
 * grace window after assignment, free whenever the fault lies with the driver
 * or the platform, and a flat fee otherwise.
 */

import type { RateCard } from '../pricing/types.js';
import { zero, type Money } from '../util/money.js';
import type { Actor, CancellationReason, Ride } from '../domain/ride.js';

export interface CancellationAssessment {
  readonly fee: Money;
  readonly waived: boolean;
  /** Rider-facing explanation of the outcome. */
  readonly explanation: string;
  /** Seconds of free-cancellation window remaining, if any. */
  readonly freeWindowRemainingMs?: number;
}

export interface CancellationPolicy {
  readonly id: string;
  assess(input: {
    ride: Ride;
    by: Actor;
    reason: CancellationReason;
    at: number;
    rateCard: RateCard;
  }): CancellationAssessment;
}

/** Reasons that are never the rider's fault, so never chargeable. */
const NON_CHARGEABLE_REASONS: readonly CancellationReason[] = [
  'driver_no_show',
  'driver_unavailable',
  'driver_vehicle_issue',
  'no_drivers_found',
  'safety_concern',
  'admin_intervention',
  'payment_failed',
];

export const standardCancellationPolicy = (): CancellationPolicy => ({
  id: 'standard',
  assess: ({ ride, by, reason, at, rateCard }) => {
    const free = (explanation: string, remaining?: number): CancellationAssessment => ({
      fee: zero(rateCard.currency),
      waived: true,
      explanation,
      ...(remaining !== undefined ? { freeWindowRemainingMs: remaining } : {}),
    });

    // Only riders are ever charged a cancellation fee.
    if (by.kind !== 'rider') {
      return free('No charge — this ride was cancelled on our side.');
    }

    if (NON_CHARGEABLE_REASONS.includes(reason)) {
      return free('No charge for this cancellation.');
    }

    // Nobody was assigned yet, so nobody drove anywhere.
    if (!ride.assignment) {
      return free("No charge — we hadn't matched you with a driver yet.");
    }

    const sinceAssignment = at - ride.assignment.assignedAt;
    if (sinceAssignment < rateCard.freeCancellationWindowMs) {
      return free(
        'No charge — you cancelled within the free window.',
        rateCard.freeCancellationWindowMs - sinceAssignment,
      );
    }

    // A driver who never showed up does not earn a cancellation fee, even when
    // the rider picks a generic reason.
    if (ride.status === 'accepted' && sinceAssignment > 20 * 60 * 1000) {
      return free('No charge — your driver was taking too long.');
    }

    return {
      fee: rateCard.cancellationFee,
      waived: false,
      explanation: 'Your driver was already on the way, so a cancellation fee applies.',
      freeWindowRemainingMs: 0,
    };
  },
});

/** Never charges. Useful in development, tests, and new markets. */
export const freeCancellationPolicy = (): CancellationPolicy => ({
  id: 'free',
  assess: ({ rateCard }) => ({
    fee: zero(rateCard.currency),
    waived: true,
    explanation: 'Cancellations are free.',
  }),
});

/**
 * How long the rider has left to cancel for free — the countdown the rider app
 * shows under "Cancel ride" once a driver is assigned.
 */
export const freeCancellationRemainingMs = (
  ride: Ride,
  rateCard: RateCard,
  now: number,
): number => {
  if (!ride.assignment) return Infinity;
  const remaining = rateCard.freeCancellationWindowMs - (now - ride.assignment.assignedAt);
  return Math.max(0, remaining);
};
