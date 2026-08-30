/**
 * Matching types — the vocabulary the dispatcher speaks.
 *
 * The dispatcher never touches a database or a socket. It consumes
 * `DriverCandidate` records and emits `DispatchCommand`s, which the runtime
 * translates into pushes, persistence, and API calls. That separation is what
 * makes the whole matching path deterministically testable.
 */

import type { DriverId, OfferId, RideId, VehicleId } from '../util/ids.js';
import type { LatLng } from '../util/geo.js';
import type { RideTypeId } from '../catalog/rideTypes.js';
import type { Money } from '../util/money.js';

/** A driver the dispatcher may consider for a ride. */
export interface DriverCandidate {
  readonly driverId: DriverId;
  readonly vehicleId: VehicleId;
  readonly position: LatLng;
  /** Straight-line metres to pickup; the strategy may refine this with routing. */
  readonly distanceMeters: number;
  /** Estimated driving time to pickup. */
  readonly etaToPickupMs: number;
  readonly rating: number;
  readonly acceptanceRate: number;
  readonly completionRate: number;
  /** Ride types this driver's vehicle qualifies for. */
  readonly eligibleRideTypeIds: readonly RideTypeId[];
  /** Ride types the driver has opted into; empty means all eligible. */
  readonly acceptedRideTypeIds: readonly RideTypeId[];
  readonly maxPickupDistanceMeters: number;
  readonly autoAccept: boolean;
  /** Set when the driver is filtering for rides toward a destination. */
  readonly destinationFilter?: {
    readonly lat: number;
    readonly lng: number;
    readonly radiusMeters: number;
    readonly expiresAt: number;
  };
  /** How long since this driver last completed a ride; feeds fairness scoring. */
  readonly idleSinceMs?: number;
}

/** What the dispatcher is trying to fill. */
export interface MatchRequest {
  readonly rideId: RideId;
  readonly rideTypeId: RideTypeId;
  readonly pickup: LatLng;
  readonly dropoff: LatLng;
  readonly passengerCount: number;
  readonly requestedAt: number;
  /** Estimated payout, shown on the driver's offer card. */
  readonly estimatedPayout: Money;
  readonly estimatedTripDistanceMeters: number;
  readonly estimatedTripDurationMs: number;
  /** Drivers who already declined, timed out, or were cancelled on. */
  readonly excludedDriverIds: readonly DriverId[];
  readonly attributes?: Record<string, unknown>;
}

export interface ScoredCandidate {
  readonly candidate: DriverCandidate;
  /** Higher is better. */
  readonly score: number;
  /** Per-component contributions, for debugging why a driver was chosen. */
  readonly components: Readonly<Record<string, number>>;
}

/**
 * How a set of candidates is ordered. Swap the strategy to change dispatch
 * policy — nearest-first, score-based, fairness-weighted, or your own.
 */
export interface MatchingStrategy {
  readonly id: string;
  readonly description?: string;
  rank(
    candidates: readonly DriverCandidate[],
    request: MatchRequest,
  ): readonly ScoredCandidate[];
}

/** A single component of a composite score. */
export interface ScoringComponent {
  readonly id: string;
  /** Relative weight; components are normalised to 0–1 before weighting. */
  readonly weight: number;
  /** Returns a 0–1 value where 1 is the best possible. */
  score(candidate: DriverCandidate, request: MatchRequest): number;
}

export type OfferStatus = 'pending' | 'accepted' | 'declined' | 'expired' | 'cancelled';

/** A ride offered to one driver, awaiting their answer. */
export interface RideOffer {
  readonly id: OfferId;
  readonly rideId: RideId;
  readonly driverId: DriverId;
  readonly vehicleId: VehicleId;
  readonly status: OfferStatus;
  readonly sentAt: number;
  readonly expiresAt: number;
  readonly respondedAt?: number;
  /** Everything the driver's offer card renders. */
  readonly preview: OfferPreview;
  /** Which dispatch round produced this offer. */
  readonly round: number;
}

export interface OfferPreview {
  readonly rideTypeId: RideTypeId;
  readonly pickupAddress: string;
  readonly pickupCoordinates: LatLng;
  readonly dropoffAddress: string;
  readonly dropoffCoordinates: LatLng;
  readonly pickupEtaMs: number;
  readonly pickupDistanceMeters: number;
  readonly tripDistanceMeters: number;
  readonly tripDurationMs: number;
  readonly estimatedPayout: Money;
  readonly surgeMultiplier: number;
  readonly riderRating: number;
  readonly riderName: string;
  readonly stopCount: number;
  readonly passengerCount: number;
}

/**
 * Instructions the dispatcher hands back to the runtime. The dispatcher is
 * pure; the runtime performs the effects.
 */
export type DispatchCommand =
  | { readonly type: 'send_offer'; readonly offer: RideOffer }
  | { readonly type: 'expire_offer'; readonly offerId: OfferId; readonly driverId: DriverId }
  | {
      readonly type: 'assign_driver';
      readonly rideId: RideId;
      readonly offerId: OfferId;
      readonly driverId: DriverId;
      readonly vehicleId: VehicleId;
      readonly pickupEtaMs: number;
    }
  | { readonly type: 'no_drivers_found'; readonly rideId: RideId; readonly searchedMs: number }
  | { readonly type: 'search_exhausted_round'; readonly rideId: RideId; readonly round: number };

export type DispatchSessionStatus =
  | 'searching'
  | 'awaiting_response'
  | 'matched'
  | 'failed'
  | 'cancelled';

export interface DispatchTuning {
  readonly searchRadiusMeters: number;
  readonly offerTimeoutMs: number;
  readonly searchTimeoutMs: number;
  /** Drivers offered simultaneously. 1 = strictly sequential waterfall. */
  readonly offerBatchSize: number;
  /** Pause between rounds so the fleet has a moment to move. */
  readonly roundDelayMs: number;
  /** Grow the radius by this factor each round when nobody is found. */
  readonly radiusExpansionFactor: number;
  readonly maxSearchRadiusMeters: number;
}

export const defaultDispatchTuning = (): DispatchTuning => ({
  searchRadiusMeters: 8_000,
  offerTimeoutMs: 15_000,
  searchTimeoutMs: 5 * 60 * 1000,
  offerBatchSize: 1,
  roundDelayMs: 1_000,
  radiusExpansionFactor: 1.5,
  maxSearchRadiusMeters: 30_000,
});
