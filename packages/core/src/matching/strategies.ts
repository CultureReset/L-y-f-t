/**
 * Matching strategies and eligibility filtering.
 *
 * `filterEligible` enforces the hard constraints — a driver who fails one is
 * never offered the ride. A `MatchingStrategy` then orders whoever survives.
 * Hard rules and soft preferences stay cleanly separated.
 */

import type { RideTypeCatalog } from '../catalog/rideTypes.js';
import type { DriverCandidate, MatchRequest, MatchingStrategy, ScoredCandidate, ScoringComponent } from './types.js';
import { computeScore, defaultScoringComponents } from './scoring.js';
import { haversineMeters } from '../util/geo.js';

export interface EligibilityOptions {
  readonly searchRadiusMeters: number;
  readonly catalog?: RideTypeCatalog;
  readonly now: number;
}

export interface EligibilityRejection {
  readonly driverId: string;
  readonly reason: string;
}

/**
 * Apply every hard constraint. Returns both the survivors and why each other
 * candidate was dropped — the rejections are what make a "why did nobody get
 * this ride?" question answerable in ops.
 */
export const filterEligible = (
  candidates: readonly DriverCandidate[],
  request: MatchRequest,
  options: EligibilityOptions,
): { eligible: DriverCandidate[]; rejected: EligibilityRejection[] } => {
  const eligible: DriverCandidate[] = [];
  const rejected: EligibilityRejection[] = [];
  const excluded = new Set(request.excludedDriverIds);

  for (const candidate of candidates) {
    const reason = rejectionReason(candidate, request, options, excluded);
    if (reason) rejected.push({ driverId: candidate.driverId, reason });
    else eligible.push(candidate);
  }
  return { eligible, rejected };
};

const rejectionReason = (
  candidate: DriverCandidate,
  request: MatchRequest,
  options: EligibilityOptions,
  excluded: ReadonlySet<string>,
): string | undefined => {
  if (excluded.has(candidate.driverId)) return 'already_offered';

  if (!candidate.eligibleRideTypeIds.includes(request.rideTypeId)) {
    return 'vehicle_not_eligible';
  }

  // An empty opt-in list means "everything I qualify for".
  if (
    candidate.acceptedRideTypeIds.length > 0 &&
    !candidate.acceptedRideTypeIds.includes(request.rideTypeId)
  ) {
    return 'ride_type_not_accepted';
  }

  if (candidate.distanceMeters > options.searchRadiusMeters) return 'outside_search_radius';
  if (candidate.distanceMeters > candidate.maxPickupDistanceMeters) {
    return 'beyond_driver_pickup_limit';
  }

  const rideType = options.catalog?.get(request.rideTypeId);
  if (rideType && request.passengerCount > rideType.maxPassengers) {
    return 'too_many_passengers';
  }

  const filter = candidate.destinationFilter;
  if (filter && filter.expiresAt > options.now) {
    const distance = haversineMeters({ lat: filter.lat, lng: filter.lng }, request.dropoff);
    if (distance > filter.radiusMeters) return 'outside_destination_filter';
  }

  return undefined;
};

/** Closest driver wins. Simple, predictable, and the right default at low volume. */
export const nearestStrategy = (): MatchingStrategy => ({
  id: 'nearest',
  description: 'Ranks purely by straight-line distance to pickup',
  rank: (candidates) =>
    [...candidates]
      .sort((a, b) => a.distanceMeters - b.distanceMeters)
      .map((candidate, index) => ({
        candidate,
        score: 1 / (index + 1),
        components: { distance: candidate.distanceMeters },
      })),
});

/** Shortest ETA wins. Better than distance wherever real routing is available. */
export const fastestEtaStrategy = (): MatchingStrategy => ({
  id: 'fastest_eta',
  description: 'Ranks by estimated driving time to pickup',
  rank: (candidates) =>
    [...candidates]
      .sort((a, b) => a.etaToPickupMs - b.etaToPickupMs)
      .map((candidate, index) => ({
        candidate,
        score: 1 / (index + 1),
        components: { etaMs: candidate.etaToPickupMs },
      })),
});

/**
 * Weighted multi-factor scoring — the production default. Balances ETA against
 * driver quality and fleet fairness. Pass your own components to retune.
 */
export const scoredStrategy = (
  components: readonly ScoringComponent[] = defaultScoringComponents(),
): MatchingStrategy => ({
  id: 'scored',
  description: 'Weighted composite of ETA, proximity, quality, and fairness',
  rank: (candidates, request) =>
    candidates
      .map<ScoredCandidate>((candidate) => {
        const { score, components: breakdown } = computeScore(components, candidate, request);
        return { candidate, score, components: breakdown };
      })
      .sort((a, b) => b.score - a.score),
});

/**
 * Wraps another strategy and reserves the top slots for drivers who have been
 * idle longest, so a busy corner never starves the rest of the fleet.
 */
export const fairnessStrategy = (
  inner: MatchingStrategy = scoredStrategy(),
  options: { reserveTopSlots?: number; minIdleMs?: number } = {},
): MatchingStrategy => {
  const reserve = options.reserveTopSlots ?? 1;
  const minIdleMs = options.minIdleMs ?? 10 * 60 * 1000;
  return {
    id: `fairness(${inner.id})`,
    description: 'Promotes long-idle drivers ahead of the inner strategy ranking',
    rank: (candidates, request) => {
      const ranked = inner.rank(candidates, request);
      const longIdle = ranked
        .filter((r) => (r.candidate.idleSinceMs ?? 0) >= minIdleMs)
        .sort((a, b) => (b.candidate.idleSinceMs ?? 0) - (a.candidate.idleSinceMs ?? 0))
        .slice(0, reserve);
      if (longIdle.length === 0) return ranked;
      const promoted = new Set(longIdle.map((r) => r.candidate.driverId));
      return [...longIdle, ...ranked.filter((r) => !promoted.has(r.candidate.driverId))];
    },
  };
};

/** Deterministic round-robin over a stable ordering. Useful in tests. */
export const roundRobinStrategy = (): MatchingStrategy => ({
  id: 'round_robin',
  description: 'Stable alphabetical ordering; deterministic for tests',
  rank: (candidates) =>
    [...candidates]
      .sort((a, b) => a.driverId.localeCompare(b.driverId))
      .map((candidate, index) => ({ candidate, score: -index, components: {} })),
});

export const STRATEGIES: Record<string, () => MatchingStrategy> = {
  nearest: nearestStrategy,
  fastest_eta: fastestEtaStrategy,
  scored: scoredStrategy,
  fairness: () => fairnessStrategy(),
  round_robin: roundRobinStrategy,
};

export const strategyByName = (name: string): MatchingStrategy => {
  const factory = STRATEGIES[name];
  if (!factory) {
    throw new Error(
      `Unknown matching strategy "${name}". Available: ${Object.keys(STRATEGIES).join(', ')}`,
    );
  }
  return factory();
};
