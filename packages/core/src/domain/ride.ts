/**
 * The Ride aggregate — the object every other part of the platform revolves
 * around. A ride owns its itinerary, its assignment, its route legs, its fare,
 * and an append-only timeline of everything that happened to it.
 */

import { z } from 'zod';
import type { DriverId, RideId, RiderId, VehicleId } from '../util/ids.js';
import type { LatLng } from '../util/geo.js';
import type { Money } from '../util/money.js';
import type { Itinerary } from './place.js';
import { itineraryPlaces, placeSchema, waypointSchema } from './place.js';
import type { FareBreakdown } from '../pricing/types.js';

/**
 * Ride lifecycle.
 *
 *   draft ──▶ requested ──▶ accepted ──▶ arrived ──▶ in_progress ──▶ completed
 *     │           │             │           │             │
 *     │           ├─▶ expired   │           │             │
 *     └────────── └─────────────┴───────────┴─────────────┴──▶ cancelled
 *
 * `scheduled` is a parallel entry point that converts to `requested` when its
 * dispatch window opens.
 */
export const RIDE_STATUSES = [
  'draft',
  'scheduled',
  'requested',
  'accepted',
  'arrived',
  'in_progress',
  'completed',
  'cancelled',
  'expired',
] as const;

export type RideStatus = (typeof RIDE_STATUSES)[number];

export const TERMINAL_RIDE_STATUSES: readonly RideStatus[] = [
  'completed',
  'cancelled',
  'expired',
];

export const ACTIVE_RIDE_STATUSES: readonly RideStatus[] = [
  'requested',
  'accepted',
  'arrived',
  'in_progress',
];

export const isTerminal = (status: RideStatus): boolean =>
  TERMINAL_RIDE_STATUSES.includes(status);

export const isActive = (status: RideStatus): boolean =>
  ACTIVE_RIDE_STATUSES.includes(status);

/** Who caused a transition. Drives cancellation fees and audit trails. */
export type Actor =
  | { readonly kind: 'rider'; readonly riderId: RiderId }
  | { readonly kind: 'driver'; readonly driverId: DriverId }
  | { readonly kind: 'system'; readonly reason: string }
  | { readonly kind: 'admin'; readonly adminId: string };

export type CancellationReason =
  | 'rider_changed_mind'
  | 'rider_wait_too_long'
  | 'rider_wrong_address'
  | 'driver_no_show'
  | 'rider_no_show'
  | 'driver_unavailable'
  | 'driver_vehicle_issue'
  | 'no_drivers_found'
  | 'payment_failed'
  | 'safety_concern'
  | 'admin_intervention'
  | 'other';

export interface Cancellation {
  readonly reason: CancellationReason;
  readonly by: Actor;
  readonly at: number;
  readonly note?: string;
  /** Charged when a rider cancels after the free window closes. */
  readonly fee?: Money;
  readonly feeWaived?: boolean;
}

/** The driver/vehicle assigned to a ride, snapshotted at assignment time. */
export interface RideAssignment {
  readonly driverId: DriverId;
  readonly vehicleId: VehicleId;
  readonly assignedAt: number;
  /** Which offer produced this assignment — the audit link into dispatch. */
  readonly offerId: string;
  /** ETA to pickup at the moment of assignment, in ms. */
  readonly initialPickupEtaMs: number;
}

/**
 * A ride's route is stored as legs so the driver app can navigate one segment
 * at a time and the rider app can show the right line at the right moment.
 */
export interface RideLeg {
  readonly kind: 'to_pickup' | 'to_stop' | 'to_dropoff';
  readonly from: LatLng;
  readonly to: LatLng;
  readonly distanceMeters: number;
  readonly durationMs: number;
  /** Encoded polyline; decode with `decodePolyline`. */
  readonly geometry: string;
  readonly startedAt?: number;
  readonly completedAt?: number;
}

/** One entry in a ride's append-only history. */
export interface RideEvent {
  readonly at: number;
  readonly type: RideEventType;
  readonly actor: Actor;
  readonly note?: string;
  readonly data?: Record<string, unknown>;
}

export type RideEventType =
  | 'created'
  | 'requested'
  | 'offer_sent'
  | 'offer_declined'
  | 'offer_expired'
  | 'accepted'
  | 'driver_en_route'
  | 'driver_arrived'
  | 'rider_notified'
  | 'started'
  | 'stop_reached'
  | 'stop_departed'
  | 'completed'
  | 'cancelled'
  | 'expired'
  | 'fare_finalized'
  | 'payment_authorized'
  | 'payment_captured'
  | 'payment_failed'
  | 'tip_added'
  | 'rated'
  | 'route_updated'
  | 'note_added';

export interface Ride {
  readonly id: RideId;
  readonly riderId: RiderId;
  readonly status: RideStatus;
  /** Which class of service — resolved against the ride type catalog. */
  readonly rideTypeId: string;
  readonly itinerary: Itinerary;
  readonly assignment?: RideAssignment;
  readonly legs: readonly RideLeg[];
  /** Binding estimate shown before booking. */
  readonly quotedFare: FareBreakdown;
  /** Final fare, present once the ride completes. */
  readonly finalFare?: FareBreakdown;
  readonly paymentMethodId?: string;
  readonly cancellation?: Cancellation;
  readonly timeline: readonly RideEvent[];
  readonly riderNote?: string;
  readonly passengerCount: number;
  /** Set when the rider booked ahead; dispatch starts near this time. */
  readonly scheduledFor?: number;
  readonly requestedAt?: number;
  readonly acceptedAt?: number;
  readonly arrivedAt?: number;
  readonly startedAt?: number;
  readonly completedAt?: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly riderRating?: RideRating;
  readonly driverRating?: RideRating;
  /** Free-form bag for integrations — a partner booking ref, a promo code. */
  readonly metadata: Record<string, unknown>;
}

export interface RideRating {
  readonly stars: 1 | 2 | 3 | 4 | 5;
  readonly comment?: string;
  readonly tags: readonly string[];
  readonly submittedAt: number;
}

/** The leg the driver should currently be navigating, if any. */
export const currentLeg = (ride: Ride): RideLeg | undefined => {
  switch (ride.status) {
    case 'accepted':
      return ride.legs.find((l) => l.kind === 'to_pickup');
    case 'in_progress':
      return (
        ride.legs.find((l) => l.kind === 'to_stop' && !l.completedAt) ??
        ride.legs.find((l) => l.kind === 'to_dropoff')
      );
    default:
      return undefined;
  }
};

/** Distance and duration of the passenger-carrying portion of the ride. */
export const tripLegs = (ride: Ride): RideLeg[] =>
  ride.legs.filter((l) => l.kind !== 'to_pickup');

export const tripDistanceMeters = (ride: Ride): number =>
  tripLegs(ride).reduce((sum, l) => sum + l.distanceMeters, 0);

export const tripDurationMs = (ride: Ride): number =>
  tripLegs(ride).reduce((sum, l) => sum + l.durationMs, 0);

/** Wall-clock duration of the ride once it is finished. */
export const actualDurationMs = (ride: Ride): number | undefined =>
  ride.startedAt !== undefined && ride.completedAt !== undefined
    ? ride.completedAt - ride.startedAt
    : undefined;

export const appendEvent = (ride: Ride, event: RideEvent): Ride => ({
  ...ride,
  timeline: [...ride.timeline, event],
  updatedAt: event.at,
});

export const lastEventOfType = (
  ride: Ride,
  type: RideEventType,
): RideEvent | undefined => {
  for (let i = ride.timeline.length - 1; i >= 0; i--) {
    const event = ride.timeline[i]!;
    if (event.type === type) return event;
  }
  return undefined;
};

/** Every coordinate the ride touches — used to frame the map. */
export const rideCoordinates = (ride: Ride): LatLng[] =>
  itineraryPlaces(ride.itinerary).map((p) => p.pickupHint?.coordinates ?? p.coordinates);

export const statusLabel = (status: RideStatus): string =>
  ({
    draft: 'Draft',
    scheduled: 'Scheduled',
    requested: 'Finding your driver',
    accepted: 'Driver on the way',
    arrived: 'Your driver is here',
    in_progress: 'On the way',
    completed: 'Completed',
    cancelled: 'Cancelled',
    expired: 'No drivers found',
  })[status];

export const requestRideSchema = z.object({
  rideTypeId: z.string().min(1),
  pickup: placeSchema,
  dropoff: placeSchema,
  stops: z.array(waypointSchema).max(3).default([]),
  passengerCount: z.number().int().min(1).max(8).default(1),
  paymentMethodId: z.string().optional(),
  riderNote: z.string().max(300).optional(),
  scheduledFor: z.number().optional(),
  /** Ties the request to the quote the rider actually saw. */
  quoteId: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export type RequestRideInput = z.infer<typeof requestRideSchema>;

export const cancelRideSchema = z.object({
  reason: z
    .enum([
      'rider_changed_mind',
      'rider_wait_too_long',
      'rider_wrong_address',
      'driver_no_show',
      'rider_no_show',
      'driver_unavailable',
      'driver_vehicle_issue',
      'safety_concern',
      'other',
    ])
    .default('other'),
  note: z.string().max(300).optional(),
});

export const rateRideSchema = z.object({
  stars: z.number().int().min(1).max(5),
  comment: z.string().max(500).optional(),
  tags: z.array(z.string().max(40)).max(6).default([]),
  tipAmount: z.number().int().min(0).max(100_00).optional(),
});
