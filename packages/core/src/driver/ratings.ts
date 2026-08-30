/**
 * How a driver's rating is made up.
 *
 * A single averaged number tells a driver nothing they can act on. The
 * distribution and the tags do: "four riders mentioned the route" is something
 * you can change; "4.87" is not.
 */

import type { RideRating } from '../domain/ride.js';

export interface RatingBreakdown {
  readonly average: number;
  readonly count: number;
  /** How many of each star value, 1 through 5. */
  readonly distribution: Readonly<Record<1 | 2 | 3 | 4 | 5, number>>;
  /** The most common tags riders attached, most frequent first. */
  readonly tags: readonly { readonly tag: string; readonly count: number }[];
  /** Ratings from the recent window only — is it getting better or worse? */
  readonly recentAverage: number;
  readonly recentCount: number;
}

export interface RatedTrip {
  readonly rideId: string;
  readonly at: number;
  readonly rating: RideRating;
}

/**
 * Build the breakdown. `recentWindowMs` decides what counts as recent, so a
 * market with low volume can widen it without a code change.
 */
export const summarizeRatings = (
  trips: readonly RatedTrip[],
  options: { now: number; recentWindowMs?: number; topTags?: number },
): RatingBreakdown => {
  const distribution: Record<1 | 2 | 3 | 4 | 5, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  const tagCounts = new Map<string, number>();
  const recentAfter = options.now - (options.recentWindowMs ?? 30 * 24 * 60 * 60 * 1000);

  let total = 0;
  let recentTotal = 0;
  let recentCount = 0;

  for (const trip of trips) {
    const stars = trip.rating.stars;
    distribution[stars] += 1;
    total += stars;
    if (trip.at >= recentAfter) {
      recentTotal += stars;
      recentCount += 1;
    }
    for (const tag of trip.rating.tags) {
      tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    }
  }

  const tags = [...tagCounts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    // Ties broken alphabetically so the order is stable between calls.
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
    .slice(0, options.topTags ?? 6);

  return {
    average: trips.length > 0 ? total / trips.length : 0,
    count: trips.length,
    distribution,
    tags,
    recentAverage: recentCount > 0 ? recentTotal / recentCount : 0,
    recentCount,
  };
};

/**
 * Ratings a driver could plausibly get removed. A one- or two-star with no
 * comment and no tags carries no information, and most platforms discount
 * them rather than let one silent tap move an average.
 */
export const disputableRatings = (trips: readonly RatedTrip[]): RatedTrip[] =>
  trips.filter(
    (trip) =>
      trip.rating.stars <= 2 &&
      trip.rating.tags.length === 0 &&
      (trip.rating.comment ?? '').trim().length === 0,
  );
