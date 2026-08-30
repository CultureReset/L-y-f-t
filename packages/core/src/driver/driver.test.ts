/**
 * Payout and rating rules.
 *
 * Both are about a driver's money and a driver's livelihood, so the edges get
 * asserted individually: cashing out everything must work, and one silent
 * one-star must not be indistinguishable from a considered one.
 */

import { describe, expect, it } from 'vitest';
import { fromDecimal, money } from '../util/money.js';
import type { RideRating } from '../domain/ride.js';
import {
  cashOutRejectionMessage,
  defaultPayoutPolicy,
  nextScheduledPayout,
  quoteCashOut,
  type PayoutBalance,
} from './payouts.js';
import { disputableRatings, summarizeRatings, type RatedTrip } from './ratings.js';

const policy = defaultPayoutPolicy();
const balance: PayoutBalance = {
  available: fromDecimal(120),
  pending: fromDecimal(30),
  currency: 'USD',
  nextScheduledAt: 0,
};

const request = (overrides: Partial<Parameters<typeof quoteCashOut>[0]> = {}) => ({
  amount: fromDecimal(50),
  balance,
  policy,
  instantsToday: 0,
  hasDestination: true,
  ...overrides,
});

describe('cashing out', () => {
  it('takes the fee out of the amount, never on top of it', () => {
    const result = quoteCashOut(request());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.gross).toEqual(fromDecimal(50));
    expect(result.value.fee).toEqual(fromDecimal(0.5));
    expect(result.value.net).toEqual(fromDecimal(49.5));
  });

  it('lets a driver cash out their entire balance', () => {
    // If the fee were added on top this would be refused, which is exactly the
    // case a driver hits when they need the money.
    const result = quoteCashOut(request({ amount: balance.available }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.net.amount).toBe(balance.available.amount - policy.instantFee.amount);
  });

  it('applies a percentage fee on top of the flat one when configured', () => {
    const withRate = { ...policy, instantFeeRate: 0.015 };
    const result = quoteCashOut(request({ policy: withRate }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 50c flat plus 1.5% of $50.
    expect(result.value.fee).toEqual(fromDecimal(1.25));
  });

  it('refuses more than the balance, ignoring what is still pending', () => {
    const result = quoteCashOut(request({ amount: fromDecimal(140) }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('exceeds_balance');
  });

  it('refuses an amount below the minimum', () => {
    expect(quoteCashOut(request({ amount: fromDecimal(2) }))).toMatchObject({
      error: 'below_minimum',
    });
  });

  it('refuses once the daily limit is used up', () => {
    expect(quoteCashOut(request({ instantsToday: 5 }))).toMatchObject({
      error: 'daily_limit_reached',
    });
  });

  it('refuses when there is nowhere to send the money', () => {
    expect(quoteCashOut(request({ hasDestination: false }))).toMatchObject({
      error: 'no_destination',
    });
  });

  it('refuses rather than paying out nothing when a fee would consume it all', () => {
    const expensive = {
      ...policy,
      minimumInstantAmount: money(100, 'USD'),
      instantFee: fromDecimal(5),
    };
    const result = quoteCashOut(request({ amount: fromDecimal(5), policy: expensive }));
    expect(result.ok).toBe(false);
  });

  it('explains every refusal in terms a driver can act on', () => {
    for (const rejection of [
      'below_minimum',
      'exceeds_balance',
      'daily_limit_reached',
      'no_destination',
    ] as const) {
      const message = cashOutRejectionMessage(rejection, policy);
      expect(message.length).toBeGreaterThan(10);
      expect(message).not.toContain('_');
    }
  });
});

describe('the scheduled payout', () => {
  it('lands on the policy weekday, and never today', () => {
    // A Tuesday. The policy pays on Tuesdays.
    const tuesday = new Date('2026-06-16T15:00:00').getTime();
    const next = new Date(nextScheduledPayout(tuesday, policy));

    expect(next.getDay()).toBe(2);
    // Today's payout has already run; the next one is next Tuesday morning.
    expect(next.getTime()).toBeGreaterThan(tuesday);
    expect(next.getDate()).toBe(23);
    expect(next.getHours()).toBe(9);
  });

  it('finds the coming weekday from any other day', () => {
    const sunday = new Date('2026-06-14T15:00:00').getTime();
    const next = new Date(nextScheduledPayout(sunday, policy));
    expect(next.getDay()).toBe(2);
    expect(next.getDate()).toBe(16);
  });
});

const rating = (stars: 1 | 2 | 3 | 4 | 5, extra: Partial<RideRating> = {}): RideRating => ({
  stars,
  tags: [],
  submittedAt: 0,
  ...extra,
});

describe('the rating breakdown', () => {
  const NOW = 1_700_000_000_000;
  const DAY = 86_400_000;

  const trips: RatedTrip[] = [
    { rideId: 'a', at: NOW - DAY, rating: rating(5, { tags: ['great_conversation'] }) },
    { rideId: 'b', at: NOW - 2 * DAY, rating: rating(5, { tags: ['clean_car', 'safe_driving'] }) },
    { rideId: 'c', at: NOW - 3 * DAY, rating: rating(4, { tags: ['clean_car'] }) },
    { rideId: 'd', at: NOW - 200 * DAY, rating: rating(1, { tags: ['route'] }) },
  ];

  it('counts every star value, including the ones with no ratings', () => {
    const summary = summarizeRatings(trips, { now: NOW });

    expect(summary.count).toBe(4);
    expect(summary.average).toBe(3.75);
    expect(summary.distribution).toEqual({ 1: 1, 2: 0, 3: 0, 4: 1, 5: 2 });
  });

  it('separates recent ratings so a driver can see a trend', () => {
    const summary = summarizeRatings(trips, { now: NOW });

    // The one-star is 200 days old and outside the default window.
    expect(summary.recentCount).toBe(3);
    expect(summary.recentAverage).toBeCloseTo(4.667, 2);
  });

  it('ranks tags by frequency, breaking ties predictably', () => {
    const summary = summarizeRatings(trips, { now: NOW });

    expect(summary.tags[0]).toEqual({ tag: 'clean_car', count: 2 });
    // The rest all appear once, so they are alphabetical rather than arbitrary.
    expect(summary.tags.slice(1).map((t) => t.tag)).toEqual([
      'great_conversation',
      'route',
      'safe_driving',
    ]);
  });

  it('handles a driver with no ratings without dividing by zero', () => {
    const summary = summarizeRatings([], { now: NOW });
    expect(summary.average).toBe(0);
    expect(summary.recentAverage).toBe(0);
    expect(summary.tags).toEqual([]);
  });

  it('flags a silent low rating as disputable, but not a considered one', () => {
    const silent: RatedTrip = { rideId: 'x', at: NOW, rating: rating(1) };
    const explained: RatedTrip = {
      rideId: 'y',
      at: NOW,
      rating: rating(1, { comment: 'Took a long detour' }),
    };
    const tagged: RatedTrip = { rideId: 'z', at: NOW, rating: rating(2, { tags: ['route'] }) };
    const good: RatedTrip = { rideId: 'w', at: NOW, rating: rating(5) };

    const disputable = disputableRatings([silent, explained, tagged, good]);
    expect(disputable.map((t) => t.rideId)).toEqual(['x']);
  });
});
