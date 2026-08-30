/**
 * Promotions.
 *
 * A promo is a *definition* — what it takes off and who may use it — plus the
 * rules for whether it applies to a particular trip. Deciding that is pure and
 * lives here; storing redemptions and counting them is the backend's job.
 *
 * The pricing engine already knows how to apply a `PromoApplication`; this
 * turns a code a rider typed into one, or explains why it cannot.
 */

import { formatMoney, money, type CurrencyCode, type Money } from '../util/money.js';
import type { PromoApplication } from '../pricing/types.js';
import { err, ok, type Result } from '../util/result.js';

export interface Promo {
  /** The code as typed, normalised to upper case. */
  readonly code: string;
  readonly label: string;
  readonly description: string;
  readonly kind: 'percent_off' | 'amount_off' | 'fixed_fare';
  /** A fraction for `percent_off`, minor units otherwise. */
  readonly value: number;
  readonly currency: CurrencyCode;
  readonly maxDiscount?: Money;
  /** Minimum fare before the discount applies at all. */
  readonly minimumFare?: Money;
  readonly startsAt?: number;
  readonly expiresAt?: number;
  /** How many times one rider may use it. */
  readonly perRiderLimit: number;
  /** How many times it may be used across everyone; absent means unlimited. */
  readonly totalLimit?: number;
  /** Restricts the promo to a subset of ride types. */
  readonly rideTypeIds?: readonly string[];
  /** Only new riders — nobody with a completed trip. */
  readonly firstRideOnly?: boolean;
  readonly active: boolean;
}

/** Everything the check needs that this module cannot work out for itself. */
export interface PromoEligibility {
  readonly now: number;
  readonly currency: CurrencyCode;
  readonly riderRedemptions: number;
  readonly totalRedemptions: number;
  readonly riderCompletedRides: number;
  readonly rideTypeId?: string;
  readonly fareTotal?: Money;
}

export type PromoRejection =
  | 'unknown'
  | 'inactive'
  | 'not_started'
  | 'expired'
  | 'rider_limit_reached'
  | 'total_limit_reached'
  | 'first_ride_only'
  | 'ride_type_excluded'
  | 'below_minimum'
  | 'wrong_currency';

/** Copy a rider should actually see. Codes are for logs, not for people. */
export const promoRejectionMessage = (rejection: PromoRejection, promo?: Promo): string => {
  switch (rejection) {
    case 'unknown':
      return 'That code is not one we recognise.';
    case 'inactive':
      return 'That code is no longer available.';
    case 'not_started':
      return 'That code is not active yet.';
    case 'expired':
      return 'That code has expired.';
    case 'rider_limit_reached':
      return "You've already used that code.";
    case 'total_limit_reached':
      return 'That code has been fully claimed.';
    case 'first_ride_only':
      return 'That code is only for your first ride.';
    case 'ride_type_excluded':
      return 'That code does not apply to this kind of ride.';
    case 'below_minimum':
      return promo?.minimumFare
        ? `That code needs a fare of at least ${formatMoney(promo.minimumFare)}.`
        : 'This trip is too small for that code.';
    case 'wrong_currency':
      return 'That code is for a different region.';
  }
};

export const normalizePromoCode = (code: string): string =>
  code.trim().toUpperCase().replace(/\s+/g, '');

/**
 * Decide whether a promo applies. Pure — every input that could vary is passed
 * in, which is what makes the whole matrix testable without a database.
 */
export const checkPromo = (
  promo: Promo | undefined,
  eligibility: PromoEligibility,
): Result<PromoApplication, PromoRejection> => {
  if (!promo) return err('unknown');
  if (!promo.active) return err('inactive');
  if (promo.currency !== eligibility.currency) return err('wrong_currency');
  if (promo.startsAt !== undefined && eligibility.now < promo.startsAt) return err('not_started');
  if (promo.expiresAt !== undefined && eligibility.now >= promo.expiresAt) return err('expired');
  if (eligibility.riderRedemptions >= promo.perRiderLimit) return err('rider_limit_reached');
  if (promo.totalLimit !== undefined && eligibility.totalRedemptions >= promo.totalLimit) {
    return err('total_limit_reached');
  }
  if (promo.firstRideOnly && eligibility.riderCompletedRides > 0) return err('first_ride_only');
  if (
    promo.rideTypeIds &&
    eligibility.rideTypeId !== undefined &&
    !promo.rideTypeIds.includes(eligibility.rideTypeId)
  ) {
    return err('ride_type_excluded');
  }
  if (
    promo.minimumFare &&
    eligibility.fareTotal &&
    eligibility.fareTotal.amount < promo.minimumFare.amount
  ) {
    return err('below_minimum');
  }

  return ok({
    code: promo.code,
    label: promo.label,
    kind: promo.kind,
    value: promo.value,
    ...(promo.maxDiscount ? { maxDiscount: promo.maxDiscount } : {}),
  });
};

/** A rider's saved code and what it is worth to them. */
export interface PromoWallet {
  readonly promo: Promo;
  readonly redemptionsLeft: number;
}

/** A redemption, recorded so limits mean something. */
export interface PromoRedemption {
  readonly code: string;
  readonly riderId: string;
  readonly rideId?: string;
  readonly redeemedAt: number;
}

/**
 * The shipped promos. Like ride types, these are a catalog rather than a
 * constant — an operator replaces the whole set through the container.
 */
export const defaultPromos = (currency: CurrencyCode = 'USD'): Promo[] => {
  const cap = money(1000, currency);
  const minimum = money(1000, currency);
  const fiveOff = money(500, currency);

  return [
    {
      code: 'WELCOME50',
      label: '50% off your first ride',
      // Built from the money values rather than written out, so the copy is
      // right in every market instead of only the one it was written for.
      description: `Half off, up to ${formatMoney(cap, { showCents: false })}, on your first trip with us.`,
      kind: 'percent_off',
      value: 0.5,
      currency,
      maxDiscount: cap,
      perRiderLimit: 1,
      firstRideOnly: true,
      active: true,
    },
    {
      code: 'RIDE5',
      label: `${formatMoney(fiveOff, { showCents: false })} off`,
      description: `Takes ${formatMoney(fiveOff, { showCents: false })} off any trip over ${formatMoney(minimum, { showCents: false })}.`,
      kind: 'amount_off',
      value: 500,
      currency,
      minimumFare: minimum,
      perRiderLimit: 3,
      active: true,
    },
  ];
};
