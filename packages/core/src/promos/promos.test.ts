/**
 * Promo eligibility.
 *
 * Every rejection is a decision a rider will argue with, so each one is
 * asserted individually rather than through a single happy path.
 */

import { describe, expect, it } from 'vitest';
import { fromDecimal } from '../util/money.js';
import {
  checkPromo,
  defaultPromos,
  normalizePromoCode,
  promoRejectionMessage,
  type Promo,
  type PromoEligibility,
} from './promos.js';

const T0 = 1_700_000_000_000;

const base: PromoEligibility = {
  now: T0,
  currency: 'USD',
  riderRedemptions: 0,
  totalRedemptions: 0,
  riderCompletedRides: 0,
};

const promo = (overrides: Partial<Promo> = {}): Promo => ({
  code: 'TEST10',
  label: '10% off',
  description: 'Ten percent off any ride.',
  kind: 'percent_off',
  value: 0.1,
  currency: 'USD',
  perRiderLimit: 1,
  active: true,
  ...overrides,
});

describe('normalising a code', () => {
  it('is forgiving about how a rider types it', () => {
    expect(normalizePromoCode('  ride 5 ')).toBe('RIDE5');
    expect(normalizePromoCode('welcome50')).toBe('WELCOME50');
  });
});

describe('checking a promo', () => {
  it('turns an eligible promo into what the pricing engine wants', () => {
    const result = checkPromo(promo({ maxDiscount: fromDecimal(5) }), base);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({
      code: 'TEST10',
      label: '10% off',
      kind: 'percent_off',
      value: 0.1,
      maxDiscount: fromDecimal(5),
    });
  });

  it('rejects a code that does not exist', () => {
    const result = checkPromo(undefined, base);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('unknown');
  });

  it('rejects an inactive, unstarted, or expired promo', () => {
    expect(checkPromo(promo({ active: false }), base)).toMatchObject({ error: 'inactive' });
    expect(checkPromo(promo({ startsAt: T0 + 1000 }), base)).toMatchObject({
      error: 'not_started',
    });
    // Expiry is exclusive: the instant it expires, it is expired.
    expect(checkPromo(promo({ expiresAt: T0 }), base)).toMatchObject({ error: 'expired' });
    expect(checkPromo(promo({ expiresAt: T0 + 1 }), base).ok).toBe(true);
  });

  it('enforces the per-rider limit and the total limit separately', () => {
    expect(
      checkPromo(promo({ perRiderLimit: 2 }), { ...base, riderRedemptions: 2 }),
    ).toMatchObject({ error: 'rider_limit_reached' });

    expect(
      checkPromo(promo({ perRiderLimit: 5, totalLimit: 100 }), {
        ...base,
        totalRedemptions: 100,
      }),
    ).toMatchObject({ error: 'total_limit_reached' });
  });

  it('holds a first-ride code back from anyone who has ridden', () => {
    const firstRide = promo({ firstRideOnly: true });
    expect(checkPromo(firstRide, base).ok).toBe(true);
    expect(checkPromo(firstRide, { ...base, riderCompletedRides: 1 })).toMatchObject({
      error: 'first_ride_only',
    });
  });

  it('restricts to named ride types, and ignores the restriction before one is chosen', () => {
    const luxOnly = promo({ rideTypeIds: ['lux'] });
    expect(checkPromo(luxOnly, { ...base, rideTypeId: 'standard' })).toMatchObject({
      error: 'ride_type_excluded',
    });
    expect(checkPromo(luxOnly, { ...base, rideTypeId: 'lux' }).ok).toBe(true);
    // On the confirm screen the rider has not picked a tier yet.
    expect(checkPromo(luxOnly, base).ok).toBe(true);
  });

  it('enforces a minimum fare only once a fare is known', () => {
    const bigTripsOnly = promo({ minimumFare: fromDecimal(20) });
    expect(checkPromo(bigTripsOnly, { ...base, fareTotal: fromDecimal(12) })).toMatchObject({
      error: 'below_minimum',
    });
    expect(checkPromo(bigTripsOnly, { ...base, fareTotal: fromDecimal(20) }).ok).toBe(true);
    expect(checkPromo(bigTripsOnly, base).ok).toBe(true);
  });

  it('refuses a code from another currency rather than discounting the wrong money', () => {
    expect(checkPromo(promo({ currency: 'EUR' }), base)).toMatchObject({
      error: 'wrong_currency',
    });
  });

  it('gives every rejection a message a rider could act on', () => {
    const rejections = [
      'unknown',
      'inactive',
      'not_started',
      'expired',
      'rider_limit_reached',
      'total_limit_reached',
      'first_ride_only',
      'ride_type_excluded',
      'below_minimum',
      'wrong_currency',
    ] as const;

    for (const rejection of rejections) {
      const message = promoRejectionMessage(rejection);
      expect(message.length, rejection).toBeGreaterThan(10);
      // Never leak the machine code into rider-facing copy.
      expect(message, rejection).not.toContain('_');
    }
  });
});

describe('the shipped catalog', () => {
  it('is priced in the market currency it is asked for', () => {
    for (const p of defaultPromos('EUR')) {
      expect(p.currency).toBe('EUR');
      expect(p.maxDiscount?.currency ?? 'EUR').toBe('EUR');
      expect(p.minimumFare?.currency ?? 'EUR').toBe('EUR');
    }
  });

  it('offers the welcome code to a new rider and not to a returning one', () => {
    const welcome = defaultPromos().find((p) => p.code === 'WELCOME50')!;
    expect(checkPromo(welcome, base).ok).toBe(true);
    expect(checkPromo(welcome, { ...base, riderCompletedRides: 3 }).ok).toBe(false);
  });
});
