/**
 * Pricing types.
 *
 * A fare is never a single number — it is an ordered list of line items that
 * sums to a total. Every charge, discount, fee, and tax is a line item with a
 * stable `code`, so a receipt can be rendered, audited, and disputed without
 * anyone re-deriving arithmetic.
 */

import type { CurrencyCode, Money } from '../util/money.js';
import type { RideTypeId } from '../catalog/rideTypes.js';

export type LineItemKind =
  | 'base'
  | 'distance'
  | 'time'
  | 'surge'
  | 'surcharge'
  | 'fee'
  | 'tax'
  | 'toll'
  | 'discount'
  | 'promo'
  | 'tip'
  | 'wait_time'
  | 'cancellation'
  | 'minimum_adjustment'
  | 'adjustment';

export interface FareLineItem {
  /** Stable machine code, e.g. `base_fare`, `per_mile`, `service_fee`. */
  readonly code: string;
  /** Human label for the receipt: "Distance (4.2 mi)". */
  readonly label: string;
  readonly amount: Money;
  readonly kind: LineItemKind;
  /** Which rule produced this item — the audit trail. */
  readonly ruleId: string;
  /** Optional secondary text, e.g. "$1.15 × 4.2 mi". */
  readonly detail?: string;
  /** Hidden from the rider's receipt but kept for internal accounting. */
  readonly internal?: boolean;
  readonly meta?: Record<string, unknown>;
}

export interface FareBreakdown {
  readonly currency: CurrencyCode;
  readonly rideTypeId: RideTypeId;
  readonly items: readonly FareLineItem[];
  /** Sum of charges before discounts, taxes, and tip. */
  readonly subtotal: Money;
  /** What the rider is charged. */
  readonly total: Money;
  /** What the driver earns from this fare, tips excluded. */
  readonly driverPayout: Money;
  /** Platform take: `subtotal - driverPayout` plus platform-retained fees. */
  readonly platformRevenue: Money;
  readonly surgeMultiplier: number;
  readonly distanceMeters: number;
  readonly durationMs: number;
  /** True for a pre-ride quote, false once the ride is finalized. */
  readonly estimated: boolean;
  /** Range shown to the rider on the ride-type picker. */
  readonly estimateRange?: { readonly low: Money; readonly high: Money };
  readonly computedAt: number;
  /** Quotes go stale; the API rejects a request that cites an expired quote. */
  readonly validUntil?: number;
  readonly quoteId?: string;
}

/** Everything a pricing rule is allowed to look at. */
export interface PricingContext {
  readonly rideTypeId: RideTypeId;
  readonly currency: CurrencyCode;
  readonly distanceMeters: number;
  readonly durationMs: number;
  readonly surgeMultiplier: number;
  /** Wall-clock time the fare is computed for; drives time-of-day rules. */
  readonly at: number;
  readonly pickup: { readonly lat: number; readonly lng: number };
  readonly dropoff: { readonly lat: number; readonly lng: number };
  readonly stopCount: number;
  readonly passengerCount: number;
  /** Minutes the driver waited past the free window at pickup. */
  readonly waitMinutes?: number;
  /** Tolls reported by the routing provider. */
  readonly tolls?: Money;
  readonly promo?: PromoApplication;
  /** Airport, stadium, or other zone-based surcharges that apply. */
  readonly zoneSurcharges?: readonly ZoneSurcharge[];
  readonly isEstimate: boolean;
  /** Anything a custom rule needs — market id, partner id, loyalty tier. */
  readonly attributes?: Record<string, unknown>;
}

export interface ZoneSurcharge {
  readonly code: string;
  readonly label: string;
  readonly amount: Money;
  readonly appliesAt: 'pickup' | 'dropoff' | 'either';
}

export interface PromoApplication {
  readonly code: string;
  readonly label: string;
  readonly kind: 'percent_off' | 'amount_off' | 'fixed_fare';
  readonly value: number;
  /** Cap on how much a percentage discount can take off. */
  readonly maxDiscount?: Money;
}

/**
 * Rules run in phase order. Within a phase they run by ascending `priority`,
 * and each sees the running subtotal produced by the phases before it — that
 * ordering is what makes percentage-based rules (surge, promos, tax) correct
 * without any rule knowing about the others.
 */
export const PRICING_PHASES = [
  'base',
  'surge',
  'surcharge',
  'discount',
  'fee',
  'tax',
  'final',
] as const;

export type PricingPhase = (typeof PRICING_PHASES)[number];

/** The engine's running state, handed to each rule. */
export interface PricingState {
  readonly items: readonly FareLineItem[];
  /** Sum of every item emitted so far. */
  readonly runningTotal: Money;
  /** Sum of `base`, `distance`, and `time` items only — the surge base. */
  readonly baseCharges: Money;
}

/**
 * A pricing rule. Add one to change how fares are computed; you never edit the
 * engine. Rules are pure functions of context and running state.
 */
export interface PricingRule {
  readonly id: string;
  readonly phase: PricingPhase;
  /** Lower runs first within a phase. */
  readonly priority: number;
  readonly description?: string;
  /** Skip the rule entirely when this returns false. */
  appliesTo?(context: PricingContext): boolean;
  /** Return zero or more line items. Returning `[]` means "no charge". */
  evaluate(context: PricingContext, state: PricingState): readonly FareLineItem[];
}

/** Per-ride-type rates the built-in rules read. */
export interface RateCard {
  readonly currency: CurrencyCode;
  readonly baseFare: Money;
  readonly perMile: Money;
  readonly perMinute: Money;
  /** The fare floor; a `minimum_adjustment` item tops short trips up to it. */
  readonly minimumFare: Money;
  /** Flat platform fee added to every ride. */
  readonly serviceFee: Money;
  /** Share of the ride subtotal the platform keeps, 0–1. */
  readonly commissionRate: number;
  /** Charged when a rider cancels after the free window. */
  readonly cancellationFee: Money;
  /** How long a rider may cancel for free after a driver accepts, in ms. */
  readonly freeCancellationWindowMs: number;
  /** Free wait time at pickup before per-minute wait charges start. */
  readonly freeWaitMinutes: number;
  readonly perMinuteWaiting: Money;
  /** Cap on surge, so a bug can never produce a 40× fare. */
  readonly maxSurgeMultiplier: number;
  /** Tax applied to the taxable subtotal, 0–1. */
  readonly taxRate: number;
}
