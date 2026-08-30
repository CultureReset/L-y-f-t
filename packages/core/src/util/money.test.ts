import { describe, expect, it } from 'vitest';
import {
  add,
  allocate,
  formatMoney,
  fromDecimal,
  money,
  multiply,
  rate,
  subtract,
  sum,
  toDecimal,
  zero,
} from './money.js';

describe('money', () => {
  it('stores minor units and round-trips decimals', () => {
    expect(fromDecimal(12.5).amount).toBe(1250);
    expect(toDecimal(money(1250))).toBe(12.5);
  });

  it('rounds rather than truncating on construction', () => {
    expect(fromDecimal(0.005).amount).toBe(1);
    expect(fromDecimal(0.004).amount).toBe(0);
  });

  it('adds and subtracts without floating point drift', () => {
    let total = zero();
    for (let i = 0; i < 10; i++) total = add(total, fromDecimal(0.1));
    expect(total.amount).toBe(100);
    expect(toDecimal(total)).toBe(1);
  });

  it('refuses to mix currencies', () => {
    expect(() => add(money(100, 'USD'), money(100, 'EUR'))).toThrow(/Currency mismatch/);
  });

  it('charges a per-unit rate', () => {
    // $1.15/mi across 4.2 mi = $4.83
    expect(rate(fromDecimal(1.15), 4.2).amount).toBe(483);
  });

  it('applies a multiplier', () => {
    expect(multiply(fromDecimal(10), 1.75).amount).toBe(1750);
  });

  it('sums a list', () => {
    expect(sum([fromDecimal(1.1), fromDecimal(2.2), fromDecimal(3.3)]).amount).toBe(660);
  });

  it('formats for display', () => {
    expect(formatMoney(fromDecimal(12.5))).toBe('$12.50');
    expect(formatMoney(fromDecimal(-3))).toBe('-$3.00');
    expect(formatMoney(fromDecimal(12.5), { showCents: false })).toBe('$13');
    expect(formatMoney(money(1000, 'GBP'))).toBe('£10.00');
  });

  describe('allocate', () => {
    it('splits without losing or inventing cents', () => {
      const parts = allocate(money(1000), [75, 25]);
      expect(parts.map((p) => p.amount)).toEqual([750, 250]);
    });

    it('distributes an indivisible remainder', () => {
      const parts = allocate(money(100), [1, 1, 1]);
      expect(parts.map((p) => p.amount)).toEqual([34, 33, 33]);
      expect(parts.reduce((a, p) => a + p.amount, 0)).toBe(100);
    });

    it('always conserves the total across many random splits', () => {
      for (let amount = 1; amount <= 500; amount += 7) {
        const parts = allocate(money(amount), [3, 5, 11]);
        expect(parts.reduce((a, p) => a + p.amount, 0)).toBe(amount);
      }
    });

    it('rejects non-positive weights', () => {
      expect(() => allocate(money(100), [0, 0])).toThrow();
    });
  });

  it('subtracts to a negative amount when asked', () => {
    expect(subtract(fromDecimal(5), fromDecimal(8)).amount).toBe(-300);
  });
});
