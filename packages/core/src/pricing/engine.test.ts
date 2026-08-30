import { beforeEach, describe, expect, it } from 'vitest';
import { PricingEngine, applyTip, emptyFare, findLineItem } from './engine.js';
import { standardRules } from './rules.js';
import type { PricingContext, PricingRule, RateCard } from './types.js';
import { DEFAULT_RIDE_TYPES, RideTypeCatalog, baseRateCard } from '../catalog/rideTypes.js';
import { fromDecimal, money, toDecimal } from '../util/money.js';
import { milesToMeters } from '../util/geo.js';

const AT = 1_700_000_000_000;

const context = (overrides: Partial<PricingContext> = {}): PricingContext => ({
  rideTypeId: 'standard',
  currency: 'USD',
  distanceMeters: milesToMeters(5),
  durationMs: 15 * 60 * 1000,
  surgeMultiplier: 1,
  at: AT,
  pickup: { lat: 37.7749, lng: -122.4194 },
  dropoff: { lat: 37.8044, lng: -122.2712 },
  stopCount: 0,
  passengerCount: 1,
  isEstimate: false,
  ...overrides,
});

describe('PricingEngine', () => {
  let card: RateCard;
  let engine: PricingEngine;

  beforeEach(() => {
    card = baseRateCard();
    engine = new PricingEngine(standardRules(card), card);
  });

  it('prices a standard trip from base + distance + time + service fee', () => {
    const fare = engine.price(context());
    // 2.50 base + (1.15 × 5) + (0.28 × 15) + 3.15 fee = 2.50 + 5.75 + 4.20 + 3.15
    expect(toDecimal(fare.total)).toBeCloseTo(15.6, 2);
    expect(findLineItem(fare, 'base_fare')?.amount.amount).toBe(250);
    expect(findLineItem(fare, 'distance')?.amount.amount).toBe(575);
    expect(findLineItem(fare, 'time')?.amount.amount).toBe(420);
    expect(findLineItem(fare, 'service_fee')?.amount.amount).toBe(315);
  });

  it('every line item sums exactly to the total', () => {
    const fare = engine.price(context({ surgeMultiplier: 1.8, stopCount: 2 }));
    const summed = fare.items.reduce((acc, i) => acc + i.amount.amount, 0);
    expect(summed).toBe(fare.total.amount);
  });

  it('applies surge to base charges only, never to fees', () => {
    const plain = engine.price(context());
    const surged = engine.price(context({ surgeMultiplier: 2 }));
    const baseCharges = 250 + 575 + 420;
    expect(findLineItem(surged, 'surge')?.amount.amount).toBe(baseCharges);
    // The service fee is identical in both fares.
    expect(findLineItem(surged, 'service_fee')?.amount.amount).toBe(
      findLineItem(plain, 'service_fee')?.amount.amount,
    );
    expect(surged.surgeMultiplier).toBe(2);
  });

  it('caps surge at the rate card ceiling', () => {
    const fare = engine.price(context({ surgeMultiplier: 99 }));
    expect(fare.surgeMultiplier).toBe(card.maxSurgeMultiplier);
    expect(findLineItem(fare, 'surge')?.meta?.['capped']).toBe(true);
  });

  it('tops a short trip up to the minimum fare', () => {
    const fare = engine.price(
      context({ distanceMeters: milesToMeters(0.3), durationMs: 90_000 }),
    );
    const adjustment = findLineItem(fare, 'minimum_adjustment');
    expect(adjustment).toBeDefined();
    // Minimum ($7.00) plus the service fee ($3.15).
    expect(toDecimal(fare.total)).toBeCloseTo(10.15, 2);
  });

  it('does not add a minimum adjustment when the fare already clears it', () => {
    const fare = engine.price(context());
    expect(findLineItem(fare, 'minimum_adjustment')).toBeUndefined();
  });

  it('charges per extra stop', () => {
    const fare = engine.price(context({ stopCount: 2 }));
    expect(findLineItem(fare, 'extra_stops')?.amount.amount).toBe(300);
  });

  it('charges wait time only past the free window', () => {
    expect(findLineItem(engine.price(context({ waitMinutes: 2 })), 'wait_time')).toBeUndefined();
    const charged = engine.price(context({ waitMinutes: 7 }));
    // 5 billable minutes at $0.45.
    expect(findLineItem(charged, 'wait_time')?.amount.amount).toBe(225);
  });

  it('adds zone surcharges and tolls', () => {
    const fare = engine.price(
      context({
        zoneSurcharges: [
          {
            code: 'airport_sfo',
            label: 'SFO airport fee',
            amount: fromDecimal(5.5),
            appliesAt: 'pickup',
          },
        ],
        tolls: fromDecimal(8),
      }),
    );
    expect(findLineItem(fare, 'airport_sfo')?.amount.amount).toBe(550);
    expect(findLineItem(fare, 'tolls')?.amount.amount).toBe(800);
  });

  describe('promos', () => {
    it('applies a percentage discount as a negative line item', () => {
      const fare = engine.price(
        context({
          promo: { code: 'SAVE20', label: '20% off', kind: 'percent_off', value: 0.2 },
        }),
      );
      const discount = findLineItem(fare, 'promo_SAVE20');
      expect(discount!.amount.amount).toBeLessThan(0);
      // 20% of the $12.45 pre-fee subtotal.
      expect(discount!.amount.amount).toBe(-249);
    });

    it('honours a discount cap', () => {
      const fare = engine.price(
        context({
          promo: {
            code: 'CAP',
            label: 'Half off up to $1',
            kind: 'percent_off',
            value: 0.5,
            maxDiscount: fromDecimal(1),
          },
        }),
      );
      expect(findLineItem(fare, 'promo_CAP')?.amount.amount).toBe(-100);
    });

    it('never discounts a fare below zero', () => {
      const fare = engine.price(
        context({
          promo: { code: 'HUGE', label: '$500 off', kind: 'amount_off', value: 50_000 },
        }),
      );
      expect(fare.total.amount).toBeGreaterThanOrEqual(0);
    });

    it('lets a fixed-fare promo bypass the minimum fare', () => {
      const fare = engine.price(
        context({
          distanceMeters: milesToMeters(0.2),
          durationMs: 60_000,
          promo: { code: 'FLAT5', label: 'Flat $5', kind: 'fixed_fare', value: 500 },
        }),
      );
      expect(findLineItem(fare, 'minimum_adjustment')).toBeUndefined();
    });
  });

  it('splits the fare into a driver payout and platform revenue', () => {
    const fare = engine.price(context());
    // 25% commission on the pre-fee subtotal.
    expect(fare.driverPayout.amount).toBe(Math.round(fare.subtotal.amount * 0.75));
    expect(fare.platformRevenue.amount).toBeGreaterThan(0);
    expect(fare.driverPayout.amount + fare.platformRevenue.amount).toBe(fare.total.amount);
  });

  it('marks estimates with a quote id, expiry, and a range', () => {
    const quote = engine.price(context({ isEstimate: true }));
    expect(quote.estimated).toBe(true);
    expect(quote.quoteId).toMatch(/^quote_/);
    expect(quote.validUntil).toBe(AT + 5 * 60 * 1000);
    expect(quote.estimateRange!.low.amount).toBeLessThan(quote.total.amount);
    expect(quote.estimateRange!.high.amount).toBeGreaterThan(quote.total.amount);
  });

  it('finalize carries the original quote id onto the final fare', () => {
    const quote = engine.price(context({ isEstimate: true }));
    const final = engine.finalize(context({ distanceMeters: milesToMeters(6) }), quote);
    expect(final.estimated).toBe(false);
    expect(final.quoteId).toBe(quote.quoteId);
    expect(final.total.amount).toBeGreaterThan(quote.total.amount);
  });

  it('rejects a rule that emits the wrong currency', () => {
    const rogue: PricingRule = {
      id: 'rogue',
      phase: 'fee',
      priority: 1,
      evaluate: () => [
        { ruleId: 'rogue', code: 'x', label: 'x', amount: money(100, 'EUR'), kind: 'fee' },
      ],
    };
    const bad = new PricingEngine([...standardRules(card), rogue], card);
    expect(() => bad.price(context())).toThrow(/emitted EUR into a USD fare/);
  });

  it('runs rules in phase order regardless of registration order', () => {
    const shuffled = [...standardRules(card)].reverse();
    const fare = new PricingEngine(shuffled, card).price(context({ surgeMultiplier: 2 }));
    const codes = fare.items.map((i) => i.code);
    expect(codes.indexOf('base_fare')).toBeLessThan(codes.indexOf('surge'));
    expect(codes.indexOf('surge')).toBeLessThan(codes.indexOf('service_fee'));
  });

  it('prices every ride type in the catalog, cheapest tier first', () => {
    const catalog = new RideTypeCatalog(DEFAULT_RIDE_TYPES);
    const totals = catalog.list().map((type) => ({
      id: type.id,
      total: PricingEngine.forRideType(type).price(context({ rideTypeId: type.id })).total
        .amount,
    }));
    const standard = totals.find((t) => t.id === 'standard')!.total;
    expect(totals.find((t) => t.id === 'shared')!.total).toBeLessThan(standard);
    expect(totals.find((t) => t.id === 'xl')!.total).toBeGreaterThan(standard);
    expect(totals.find((t) => t.id === 'lux')!.total).toBeGreaterThan(
      totals.find((t) => t.id === 'xl')!.total,
    );
  });

  it('applies tax when the rate card carries a rate', () => {
    const taxed = { ...card, taxRate: 0.08875 };
    const fare = new PricingEngine(standardRules(taxed), taxed).price(context());
    expect(findLineItem(fare, 'tax')).toBeDefined();
    expect(fare.items.at(-1)?.code).toBe('tax');
  });
});

describe('applyTip', () => {
  it('adds the tip to the total and to the driver in full', () => {
    const card = baseRateCard();
    const fare = new PricingEngine(standardRules(card), card).price(context());
    const tipped = applyTip(fare, fromDecimal(5));
    expect(tipped.total.amount).toBe(fare.total.amount + 500);
    expect(tipped.driverPayout.amount).toBe(fare.driverPayout.amount + 500);
    expect(tipped.platformRevenue.amount).toBe(fare.platformRevenue.amount);
  });

  it('ignores a zero tip', () => {
    const fare = emptyFare('standard', 'USD', AT);
    expect(applyTip(fare, money(0))).toBe(fare);
  });
});
