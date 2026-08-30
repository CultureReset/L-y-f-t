/**
 * Card input validation.
 *
 * The test numbers are the standard published test PANs — they are designed to
 * be shared and correspond to no real account.
 */

import { describe, expect, it } from 'vitest';
import {
  cardErrorMessage,
  cvcLengthFor,
  detectCardBrand,
  expandYear,
  formatCardNumber,
  luhnValid,
  validateCard,
} from './card.js';

const NOW = new Date('2026-06-15T12:00:00Z');

describe('brand detection', () => {
  it('reads the brand off the prefix', () => {
    expect(detectCardBrand('4242424242424242')).toBe('visa');
    expect(detectCardBrand('5555555555554444')).toBe('mastercard');
    // The 2-series is Mastercard too, which a naive "starts with 5" misses.
    expect(detectCardBrand('2223003122003222')).toBe('mastercard');
    expect(detectCardBrand('378282246310005')).toBe('amex');
    expect(detectCardBrand('6011111111111117')).toBe('discover');
    expect(detectCardBrand('3056930009020004')).toBe('diners');
    expect(detectCardBrand('3566002020360505')).toBe('jcb');
    expect(detectCardBrand('6200000000000005')).toBe('unionpay');
  });

  it('says nothing about an empty or unrecognised number', () => {
    expect(detectCardBrand('')).toBe('unknown');
    expect(detectCardBrand('9999')).toBe('unknown');
  });

  it('knows Amex takes a four-digit code', () => {
    expect(cvcLengthFor('378282246310005')).toBe(4);
    expect(cvcLengthFor('4242424242424242')).toBe(3);
  });
});

describe('formatting as you type', () => {
  it('groups in fours for most brands and 4-6-5 for Amex', () => {
    expect(formatCardNumber('4242424242424242')).toBe('4242 4242 4242 4242');
    expect(formatCardNumber('378282246310005')).toBe('3782 822463 10005');
  });

  it('ignores anything that is not a digit, and stops at the brand length', () => {
    expect(formatCardNumber('4242-4242 4242x4242')).toBe('4242 4242 4242 4242');
    expect(formatCardNumber('42424242424242429999')).toBe('4242 4242 4242 4242 999');
  });
});

describe('the Luhn check', () => {
  it('accepts real test numbers', () => {
    for (const number of [
      '4242424242424242',
      '5555555555554444',
      '378282246310005',
      '6011111111111117',
    ]) {
      expect(luhnValid(number), number).toBe(true);
    }
  });

  it('catches a single transposed digit, which is the common typo', () => {
    expect(luhnValid('4242424242424241')).toBe(false);
    expect(luhnValid('4242424242422442')).toBe(false);
  });

  it('rejects anything too short to be a card', () => {
    expect(luhnValid('4242')).toBe(false);
    expect(luhnValid('')).toBe(false);
  });
});

describe('validating a whole entry', () => {
  const good = {
    number: '4242 4242 4242 4242',
    expiryMonth: 12,
    expiryYear: 2030,
    cvc: '123',
  };

  it('returns the brand and last four, never the number', () => {
    const result = validateCard(good, NOW);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.card).toEqual({
      brand: 'visa',
      last4: '4242',
      expiryMonth: 12,
      expiryYear: 2030,
    });
    // Nothing in the result can carry the full number onward.
    expect(JSON.stringify(result.card)).not.toContain('4242 4242');
  });

  it('reports every bad field at once rather than one per submit', () => {
    const result = validateCard(
      { number: '4242424242424241', expiryMonth: 1, expiryYear: 2020, cvc: '1' },
      NOW,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual(
      expect.arrayContaining(['number_invalid', 'expiry_past', 'cvc_invalid']),
    );
  });

  it('treats a card as good through the last day of its expiry month', () => {
    // NOW is mid-June 2026.
    expect(validateCard({ ...good, expiryMonth: 6, expiryYear: 2026 }, NOW).ok).toBe(true);
    expect(validateCard({ ...good, expiryMonth: 5, expiryYear: 2026 }, NOW).ok).toBe(false);
  });

  it('wants four digits for an Amex code and three for a Visa', () => {
    const amex = { number: '378282246310005', expiryMonth: 12, expiryYear: 2030 };
    expect(validateCard({ ...amex, cvc: '123' }, NOW).ok).toBe(false);
    expect(validateCard({ ...amex, cvc: '1234' }, NOW).ok).toBe(true);
    expect(validateCard({ ...good, cvc: '1234' }, NOW).ok).toBe(false);
  });

  it('calls a too-short number incomplete rather than wrong', () => {
    const result = validateCard({ ...good, number: '4242 4242' }, NOW);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContain('number_incomplete');
  });

  it('gives every error a message that names the field', () => {
    for (const error of [
      'number_incomplete',
      'number_invalid',
      'expiry_incomplete',
      'expiry_past',
      'cvc_invalid',
    ] as const) {
      expect(cardErrorMessage(error).length).toBeGreaterThan(10);
      expect(cardErrorMessage(error)).not.toContain('_');
    }
  });
});

describe('two-digit years', () => {
  it('resolves into the current century', () => {
    expect(expandYear(30, NOW)).toBe(2030);
    expect(expandYear(26, NOW)).toBe(2026);
  });
});
