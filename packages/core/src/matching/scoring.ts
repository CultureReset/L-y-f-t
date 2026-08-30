/**
 * Scoring components for the composite matching strategy.
 *
 * Each component answers one question about a candidate and returns 0–1 where
 * 1 is best. The strategy weights and sums them. Add a component to change
 * what dispatch optimises for — the strategy itself never changes.
 */

import { haversineMeters } from '../util/geo.js';
import type { DriverCandidate, MatchRequest, ScoringComponent } from './types.js';

/** Closer is better, falling off linearly to zero at `horizonMeters`. */
export const proximityComponent = (
  weight = 0.5,
  horizonMeters = 10_000,
): ScoringComponent => ({
  id: 'proximity',
  weight,
  score: (candidate) =>
    Math.max(0, 1 - Math.min(candidate.distanceMeters, horizonMeters) / horizonMeters),
});

/** Sooner is better. Usually preferred over raw distance where routing exists. */
export const etaComponent = (weight = 0.6, horizonMs = 15 * 60 * 1000): ScoringComponent => ({
  id: 'eta',
  weight,
  score: (candidate) =>
    Math.max(0, 1 - Math.min(candidate.etaToPickupMs, horizonMs) / horizonMs),
});

/** Rewards well-rated drivers, normalised across the 4.0–5.0 band that matters. */
export const ratingComponent = (weight = 0.15): ScoringComponent => ({
  id: 'rating',
  weight,
  score: (candidate) => Math.max(0, Math.min(1, (candidate.rating - 4.0) / 1.0)),
});

/** Rewards drivers who reliably accept, which shortens time-to-match. */
export const acceptanceComponent = (weight = 0.1): ScoringComponent => ({
  id: 'acceptance',
  weight,
  score: (candidate) => Math.max(0, Math.min(1, candidate.acceptanceRate)),
});

/**
 * Fairness: a driver who has been idle longer scores higher, so work spreads
 * across the fleet instead of always landing on whoever happens to be closest.
 */
export const idleTimeComponent = (
  weight = 0.2,
  saturationMs = 20 * 60 * 1000,
): ScoringComponent => ({
  id: 'idle_time',
  weight,
  score: (candidate) =>
    Math.min(1, (candidate.idleSinceMs ?? 0) / saturationMs),
});

/**
 * Rewards a ride that ends near a driver's destination filter — the "one last
 * ride on my way home" case.
 */
export const destinationFitComponent = (weight = 0.25): ScoringComponent => ({
  id: 'destination_fit',
  weight,
  score: (candidate, request) => {
    const filter = candidate.destinationFilter;
    if (!filter) return 0.5; // neutral for drivers with no filter set
    const distance = haversineMeters(
      { lat: filter.lat, lng: filter.lng },
      request.dropoff,
    );
    return Math.max(0, 1 - distance / Math.max(1, filter.radiusMeters));
  },
});

/** Longer trips score higher — useful when you want to prioritise utilisation. */
export const tripValueComponent = (
  weight = 0.1,
  saturationMeters = 25_000,
): ScoringComponent => ({
  id: 'trip_value',
  weight,
  score: (_candidate, request) =>
    Math.min(1, request.estimatedTripDistanceMeters / saturationMeters),
});

/** The default mix: mostly "who gets there soonest", with fairness and quality. */
export const defaultScoringComponents = (): ScoringComponent[] => [
  etaComponent(0.55),
  proximityComponent(0.15),
  ratingComponent(0.1),
  acceptanceComponent(0.08),
  idleTimeComponent(0.12),
];

/** Compute the weighted score and keep the per-component breakdown. */
export const computeScore = (
  components: readonly ScoringComponent[],
  candidate: DriverCandidate,
  request: MatchRequest,
): { score: number; components: Record<string, number> } => {
  const breakdown: Record<string, number> = {};
  let total = 0;
  let totalWeight = 0;
  for (const component of components) {
    const raw = clamp01(component.score(candidate, request));
    const weighted = raw * component.weight;
    breakdown[component.id] = Number(weighted.toFixed(4));
    total += weighted;
    totalWeight += component.weight;
  }
  return {
    score: totalWeight > 0 ? Number((total / totalWeight).toFixed(6)) : 0,
    components: breakdown,
  };
};

const clamp01 = (v: number): number => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0);
