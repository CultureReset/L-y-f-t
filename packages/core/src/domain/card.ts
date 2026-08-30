/**
 * Card input validation.
 *
 * Pure, so both apps and any future web checkout share one implementation of
 * "is this a plausible card?" — and so the rules are testable without a form.
 *
 * Nothing here touches the network. A real deployment tokenises the number
 * with the gateway's own SDK in the client; the platform API only ever
 * receives the brand, the last four, and the resulting token. This module is
 * what lets the form say "that number is wrong" before any of that happens.
 */

export type CardBrand =
  | 'visa'
  | 'mastercard'
  | 'amex'
  | 'discover'
  | 'diners'
  | 'jcb'
  | 'unionpay'
  | 'unknown';

interface BrandRule {
  readonly brand: CardBrand;
  readonly pattern: RegExp;
  /** Valid lengths for the number, digits only. */
  readonly lengths: readonly number[];
  readonly cvcLength: number;
  /** Where the spaces go when the number is displayed. */
  readonly gaps: readonly number[];
}

/**
 * Ordered most specific first, because several prefixes overlap — 3 is Amex
 * or Diners or JCB depending on what follows.
 */
const BRANDS: readonly BrandRule[] = [
  { brand: 'amex', pattern: /^3[47]/, lengths: [15], cvcLength: 4, gaps: [4, 10] },
  // Diners' 14-digit form prints 4-6-4; its longer forms group in fours like
  // everything else, which `gapsFor` sorts out.
  { brand: 'diners', pattern: /^3(?:0[0-5]|[68])/, lengths: [14, 16, 19], cvcLength: 3, gaps: [4, 10] },
  { brand: 'jcb', pattern: /^35(?:2[89]|[3-8])/, lengths: [16, 17, 18, 19], cvcLength: 3, gaps: [4, 8, 12, 16] },
  { brand: 'unionpay', pattern: /^62/, lengths: [16, 17, 18, 19], cvcLength: 3, gaps: [4, 8, 12, 16] },
  { brand: 'discover', pattern: /^(6011|64[4-9]|65)/, lengths: [16, 19], cvcLength: 3, gaps: [4, 8, 12, 16] },
  { brand: 'mastercard', pattern: /^(5[1-5]|2[2-7])/, lengths: [16], cvcLength: 3, gaps: [4, 8, 12] },
  { brand: 'visa', pattern: /^4/, lengths: [13, 16, 19], cvcLength: 3, gaps: [4, 8, 12, 16] },
];

const DEFAULT_RULE: BrandRule = {
  brand: 'unknown',
  pattern: /^/,
  lengths: [12, 13, 14, 15, 16, 17, 18, 19],
  cvcLength: 3,
  gaps: [4, 8, 12, 16],
};

/**
 * Diners is the one brand whose grouping depends on how long the number is,
 * so the gaps are resolved against the digits rather than the brand alone.
 */
const gapsFor = (rule: BrandRule, length: number): readonly number[] =>
  rule.brand === 'diners' && length > 14 ? [4, 8, 12, 16] : rule.gaps;

export const digitsOnly = (value: string): string => value.replace(/\D/g, '');

export const detectCardBrand = (number: string): CardBrand => {
  const digits = digitsOnly(number);
  if (digits.length === 0) return 'unknown';
  return BRANDS.find((rule) => rule.pattern.test(digits))?.brand ?? 'unknown';
};

const ruleFor = (number: string): BrandRule => {
  const digits = digitsOnly(number);
  return BRANDS.find((rule) => rule.pattern.test(digits)) ?? DEFAULT_RULE;
};

/** How many digits the CVC should have for this number's brand. */
export const cvcLengthFor = (number: string): number => ruleFor(number).cvcLength;

export const maxCardDigits = (number: string): number => {
  const lengths = ruleFor(number).lengths;
  return lengths[lengths.length - 1] ?? 19;
};

/** Group digits the way the brand prints them, as the rider types. */
export const formatCardNumber = (value: string): string => {
  const rule = ruleFor(value);
  const digits = digitsOnly(value).slice(0, maxCardDigits(value));
  const gaps = gapsFor(rule, digits.length);
  let out = '';
  for (let i = 0; i < digits.length; i++) {
    if (gaps.includes(i)) out += ' ';
    out += digits[i];
  }
  return out;
};

/**
 * The Luhn check. It catches transposed and mistyped digits, which is the
 * overwhelming majority of what a form gets wrong — it says nothing about
 * whether the card exists.
 */
export const luhnValid = (number: string): boolean => {
  const digits = digitsOnly(number);
  if (digits.length < 12) return false;

  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let value = Number(digits[i]);
    if (double) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    double = !double;
  }
  return sum % 10 === 0;
};

export type CardFieldError =
  | 'number_incomplete'
  | 'number_invalid'
  | 'expiry_incomplete'
  | 'expiry_past'
  | 'cvc_invalid';

export interface CardInput {
  readonly number: string;
  readonly expiryMonth: number;
  readonly expiryYear: number;
  readonly cvc: string;
  readonly postalCode?: string;
}

export interface ValidatedCard {
  readonly brand: CardBrand;
  readonly last4: string;
  readonly expiryMonth: number;
  readonly expiryYear: number;
}

/**
 * Validate a card entry. Returns every problem rather than the first, so a
 * form can mark all of its bad fields at once instead of one per submit.
 */
export const validateCard = (
  input: CardInput,
  now: Date,
): { ok: true; card: ValidatedCard } | { ok: false; errors: CardFieldError[] } => {
  const errors: CardFieldError[] = [];
  const digits = digitsOnly(input.number);
  const rule = ruleFor(input.number);

  if (!rule.lengths.includes(digits.length)) {
    errors.push(digits.length < (rule.lengths[0] ?? 12) ? 'number_incomplete' : 'number_invalid');
  } else if (!luhnValid(digits)) {
    errors.push('number_invalid');
  }

  if (
    !Number.isInteger(input.expiryMonth) ||
    input.expiryMonth < 1 ||
    input.expiryMonth > 12 ||
    !Number.isInteger(input.expiryYear) ||
    input.expiryYear < 100
  ) {
    errors.push('expiry_incomplete');
  } else {
    // A card is good through the last day of its expiry month.
    const expiresAfter = new Date(input.expiryYear, input.expiryMonth, 1);
    if (expiresAfter <= now) errors.push('expiry_past');
  }

  if (digitsOnly(input.cvc).length !== rule.cvcLength) errors.push('cvc_invalid');

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    card: {
      brand: rule.brand,
      last4: digits.slice(-4),
      expiryMonth: input.expiryMonth,
      expiryYear: input.expiryYear,
    },
  };
};

export const cardErrorMessage = (error: CardFieldError): string =>
  ({
    number_incomplete: 'That card number is too short.',
    number_invalid: 'Check that card number.',
    expiry_incomplete: 'Enter the expiry as MM/YY.',
    expiry_past: 'That card has expired.',
    cvc_invalid: 'Check the security code.',
  })[error];

/** Two-digit year as typed, resolved into the century that makes sense. */
export const expandYear = (twoDigit: number, now: Date): number => {
  const century = Math.floor(now.getFullYear() / 100) * 100;
  return century + twoDigit;
};
