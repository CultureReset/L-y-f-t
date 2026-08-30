/**
 * Money is stored as integer minor units (cents) with an explicit currency.
 * Floating point never touches a running fare total; rounding happens only at
 * well-defined boundaries — `fromDecimal`, `rate`, and `multiply`.
 */

export type CurrencyCode = 'USD' | 'CAD' | 'EUR' | 'GBP' | 'MXN';

export interface Money {
  /** Integer minor units, e.g. 1250 === $12.50. */
  readonly amount: number;
  readonly currency: CurrencyCode;
}

const MINOR_UNITS: Record<CurrencyCode, number> = {
  USD: 100,
  CAD: 100,
  EUR: 100,
  GBP: 100,
  MXN: 100,
};

const SYMBOLS: Record<CurrencyCode, string> = {
  USD: '$',
  CAD: 'CA$',
  EUR: '€',
  GBP: '£',
  MXN: 'MX$',
};

export const money = (amount: number, currency: CurrencyCode = 'USD'): Money => ({
  amount: Math.round(amount),
  currency,
});

export const zero = (currency: CurrencyCode = 'USD'): Money => money(0, currency);

export const fromDecimal = (value: number, currency: CurrencyCode = 'USD'): Money =>
  money(value * MINOR_UNITS[currency], currency);

export const toDecimal = (m: Money): number => m.amount / MINOR_UNITS[m.currency];

const assertSameCurrency = (a: Money, b: Money): void => {
  if (a.currency !== b.currency) {
    throw new Error(`Currency mismatch: ${a.currency} vs ${b.currency}`);
  }
};

export const add = (a: Money, b: Money): Money => {
  assertSameCurrency(a, b);
  return money(a.amount + b.amount, a.currency);
};

export const subtract = (a: Money, b: Money): Money => {
  assertSameCurrency(a, b);
  return money(a.amount - b.amount, a.currency);
};

export const sum = (items: readonly Money[], currency: CurrencyCode = 'USD'): Money =>
  items.reduce<Money>((acc, m) => add(acc, m), zero(currency));

/** Multiply by a unitless factor: a surge multiplier, a commission rate. */
export const multiply = (m: Money, factor: number): Money =>
  money(m.amount * factor, m.currency);

/** Charge a per-unit rate for a quantity, e.g. $1.15/mile across 4.2 miles. */
export const rate = (perUnit: Money, quantity: number): Money =>
  money(perUnit.amount * quantity, perUnit.currency);

export const maxMoney = (a: Money, b: Money): Money => {
  assertSameCurrency(a, b);
  return a.amount >= b.amount ? a : b;
};

export const minMoney = (a: Money, b: Money): Money => {
  assertSameCurrency(a, b);
  return a.amount <= b.amount ? a : b;
};

export const clampAtLeastZero = (m: Money): Money => (m.amount < 0 ? zero(m.currency) : m);

export const isZero = (m: Money): boolean => m.amount === 0;
export const isPositive = (m: Money): boolean => m.amount > 0;

export const compareMoney = (a: Money, b: Money): number => {
  assertSameCurrency(a, b);
  return a.amount - b.amount;
};

export const formatMoney = (m: Money, opts: { showCents?: boolean } = {}): string => {
  const showCents = opts.showCents ?? true;
  const decimal = toDecimal(m);
  const sign = decimal < 0 ? '-' : '';
  const abs = Math.abs(decimal);
  const body = showCents ? abs.toFixed(2) : Math.round(abs).toString();
  return `${sign}${SYMBOLS[m.currency]}${body}`;
};

/**
 * Split an amount across N parties by weight without losing or inventing
 * cents — the remainder is distributed to the largest fractional parts.
 * Used to split a fare between the driver payout and the platform take.
 */
export const allocate = (m: Money, weights: readonly number[]): Money[] => {
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  if (totalWeight <= 0) throw new Error('allocate: weights must sum to a positive number');
  const raw = weights.map((w) => (m.amount * w) / totalWeight);
  const floored = raw.map((v) => Math.floor(v));
  let remainder = m.amount - floored.reduce((a, b) => a + b, 0);
  const order = raw
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac);
  for (const { i } of order) {
    if (remainder <= 0) break;
    floored[i] = (floored[i] ?? 0) + 1;
    remainder--;
  }
  return floored.map((amount) => money(amount, m.currency));
};
