/**
 * Human-readable ride timelines — what the rider sees in their trip history
 * and what an ops agent reads when investigating a ride.
 */

import type { Ride, RideEvent } from '../domain/ride.js';
import { formatClockTime } from '../util/time.js';

export interface TimelineEntry {
  readonly at: number;
  readonly time: string;
  readonly title: string;
  readonly detail?: string;
  readonly icon: string;
  /** Distinguishes the milestones a rider cares about from internal noise. */
  readonly milestone: boolean;
}

const DESCRIPTIONS: Record<
  RideEvent['type'],
  { title: string; icon: string; milestone: boolean }
> = {
  created: { title: 'Ride created', icon: 'plus', milestone: false },
  requested: { title: 'Looking for a driver', icon: 'search', milestone: true },
  offer_sent: { title: 'Driver notified', icon: 'send', milestone: false },
  offer_declined: { title: 'Driver passed', icon: 'x', milestone: false },
  offer_expired: { title: 'Offer timed out', icon: 'clock', milestone: false },
  accepted: { title: 'Driver accepted', icon: 'check', milestone: true },
  driver_en_route: { title: 'Driver on the way', icon: 'car', milestone: false },
  driver_arrived: { title: 'Driver arrived', icon: 'pin', milestone: true },
  rider_notified: { title: 'Rider notified', icon: 'bell', milestone: false },
  started: { title: 'Trip started', icon: 'play', milestone: true },
  stop_reached: { title: 'Reached a stop', icon: 'pause', milestone: true },
  stop_departed: { title: 'Left the stop', icon: 'play', milestone: false },
  completed: { title: 'Trip completed', icon: 'flag', milestone: true },
  cancelled: { title: 'Ride cancelled', icon: 'x-circle', milestone: true },
  expired: { title: 'No drivers found', icon: 'alert', milestone: true },
  fare_finalized: { title: 'Fare finalized', icon: 'receipt', milestone: false },
  payment_authorized: { title: 'Payment authorized', icon: 'card', milestone: false },
  payment_captured: { title: 'Payment charged', icon: 'card', milestone: true },
  payment_failed: { title: 'Payment failed', icon: 'alert', milestone: true },
  tip_added: { title: 'Tip added', icon: 'heart', milestone: false },
  rated: { title: 'Rated', icon: 'star', milestone: false },
  route_updated: { title: 'Route updated', icon: 'route', milestone: false },
  note_added: { title: 'Note added', icon: 'note', milestone: false },
};

export const buildTimeline = (
  ride: Ride,
  options: { milestonesOnly?: boolean; locale?: string } = {},
): TimelineEntry[] =>
  ride.timeline
    .filter((e) => !options.milestonesOnly || DESCRIPTIONS[e.type].milestone)
    .map((event) => {
      const meta = DESCRIPTIONS[event.type];
      return {
        at: event.at,
        time: formatClockTime(event.at, options.locale),
        title: meta.title,
        detail: event.note ?? detailFor(event),
        icon: meta.icon,
        milestone: meta.milestone,
      };
    });

const detailFor = (event: RideEvent): string | undefined => {
  switch (event.type) {
    case 'cancelled':
      return typeof event.data?.['reason'] === 'string'
        ? humanize(event.data['reason'] as string)
        : undefined;
    case 'accepted':
      return event.actor.kind === 'driver' ? undefined : 'Assigned by dispatch';
    default:
      return undefined;
  }
};

const humanize = (code: string): string =>
  code.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

/** Key durations, for the receipt and for ops analytics. */
export interface RideDurations {
  readonly timeToMatchMs?: number;
  readonly pickupMs?: number;
  readonly waitAtPickupMs?: number;
  readonly tripMs?: number;
  readonly totalMs?: number;
}

export const rideDurations = (ride: Ride): RideDurations => ({
  timeToMatchMs:
    ride.requestedAt !== undefined && ride.acceptedAt !== undefined
      ? ride.acceptedAt - ride.requestedAt
      : undefined,
  pickupMs:
    ride.acceptedAt !== undefined && ride.arrivedAt !== undefined
      ? ride.arrivedAt - ride.acceptedAt
      : undefined,
  waitAtPickupMs:
    ride.arrivedAt !== undefined && ride.startedAt !== undefined
      ? ride.startedAt - ride.arrivedAt
      : undefined,
  tripMs:
    ride.startedAt !== undefined && ride.completedAt !== undefined
      ? ride.completedAt - ride.startedAt
      : undefined,
  totalMs:
    ride.requestedAt !== undefined && ride.completedAt !== undefined
      ? ride.completedAt - ride.requestedAt
      : undefined,
});
