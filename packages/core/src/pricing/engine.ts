/**
 * The pricing engine.
 *
 * It knows how to run rules in phase order and fold their output into a
 * `FareBreakdown`. It knows nothing about what any particular rule charges —
 * that keeps the arithmetic in one auditable place while leaving policy fully
 * pluggable.
 */

import type { RideType, RideTypeId } from '../catalog/rideTypes.js';
import { newId } from '../util/ids.js';
import {
  add,
  clampAtLeastZero,
  money,
  multiply,
  subtract,
  zero,
  type CurrencyCode,
  type Money,
} from '../util/money.js';
import { PRICING_PHASES } from './types.js';
import type {
  FareBreakdown,
  FareLineItem,
  PricingContext,
  PricingPhase,
  PricingRule,
  PricingState,
  RateCard,
} from './types.js';
import { cancellationRules, standardRules } from './rules.js';

/** Line item kinds that make up the surge base. */
const BASE_KINDS: readonly FareLineItem['kind'][] = ['base', 'distance', 'time'];

/** Fees the platform keeps in full rather than sharing with the driver. */
const PLATFORM_RETAINED_KINDS: readonly FareLineItem['kind'][] = ['fee', 'tax'];

export interface PricingEngineOptions {
  /** How long a quote stays valid before the API rejects it. */
  readonly quoteTtlMs?: number;
  /** Width of the estimate range shown pre-booking, as a ratio. */
  readonly estimateSpread?: number;
}

export class PricingEngine {
  private readonly quoteTtlMs: number;
  private readonly estimateSpread: number;

  constructor(
    private readonly rules: readonly PricingRule[],
    private readonly card: RateCard,
    options: PricingEngineOptions = {},
  ) {
    this.quoteTtlMs = options.quoteTtlMs ?? 5 * 60 * 1000;
    this.estimateSpread = options.estimateSpread ?? 0.12;
  }

  /** Build the engine a ride type's standard pipeline. */
  static forRideType(type: RideType, options: PricingEngineOptions = {}): PricingEngine {
    return new PricingEngine(standardRules(type.rateCard), type.rateCard, options);
  }

  /** Engine that prices a late cancellation. */
  static cancellationFor(type: RideType): PricingEngine {
    return new PricingEngine(cancellationRules(type.rateCard), type.rateCard);
  }

  /** Rules sorted into execution order: by phase, then by priority. */
  private ordered(): PricingRule[] {
    const phaseIndex = (phase: PricingPhase): number => PRICING_PHASES.indexOf(phase);
    return [...this.rules].sort(
      (a, b) => phaseIndex(a.phase) - phaseIndex(b.phase) || a.priority - b.priority,
    );
  }

  /**
   * Run the pipeline. Each rule sees every item emitted before it, so
   * percentage-based rules compose correctly without knowing about each other.
   */
  price(context: PricingContext): FareBreakdown {
    const currency = context.currency;
    let items: FareLineItem[] = [];

    for (const rule of this.ordered()) {
      if (rule.appliesTo && !rule.appliesTo(context)) continue;
      const state = buildState(items, currency);
      const emitted = rule.evaluate(context, state);
      for (const emittedItem of emitted) {
        if (emittedItem.amount.currency !== currency) {
          throw new Error(
            `Rule "${rule.id}" emitted ${emittedItem.amount.currency} into a ${currency} fare`,
          );
        }
        items.push(emittedItem);
      }
    }

    // Guard against a rule set that somehow produces a negative charge.
    const rawTotal = items.reduce<Money>((acc, i) => add(acc, i.amount), zero(currency));
    const total = clampAtLeastZero(rawTotal);

    const subtotal = sumWhere(items, (i) => !isDiscount(i) && !isPlatformRetained(i), currency);
    const platformRetained = sumWhere(items, isPlatformRetained, currency);
    const discounts = sumWhere(items, isDiscount, currency);

    // The driver earns their share of the ride subtotal. Discounts funded by
    // the platform (promos) do not reduce the driver's payout.
    const driverPayout = clampAtLeastZero(
      multiply(subtotal, 1 - this.card.commissionRate),
    );
    const platformRevenue = clampAtLeastZero(
      add(subtract(subtotal, driverPayout), add(platformRetained, discounts)),
    );

    const surgeApplied = items.find((i) => i.kind === 'surge');
    const surgeMultiplier =
      (surgeApplied?.meta?.['multiplier'] as number | undefined) ?? 1;

    const breakdown: FareBreakdown = {
      currency,
      rideTypeId: context.rideTypeId,
      items,
      subtotal,
      total,
      driverPayout,
      platformRevenue,
      surgeMultiplier,
      distanceMeters: context.distanceMeters,
      durationMs: context.durationMs,
      estimated: context.isEstimate,
      computedAt: context.at,
    };

    if (!context.isEstimate) return breakdown;

    return {
      ...breakdown,
      quoteId: newId('ride').replace('rid_', 'quote_'),
      validUntil: context.at + this.quoteTtlMs,
      estimateRange: {
        low: money(Math.round(total.amount * (1 - this.estimateSpread)), currency),
        high: money(Math.round(total.amount * (1 + this.estimateSpread)), currency),
      },
    };
  }

  /**
   * Re-price a completed ride against what actually happened. Identical to
   * `price` but flagged as final so the receipt can say so, and carrying the
   * original quote id for comparison.
   */
  finalize(context: PricingContext, quotedFare?: FareBreakdown): FareBreakdown {
    const final = this.price({ ...context, isEstimate: false });
    if (!quotedFare) return final;
    return {
      ...final,
      quoteId: quotedFare.quoteId,
    };
  }
}

const isDiscount = (i: FareLineItem): boolean =>
  i.kind === 'discount' || i.kind === 'promo' || i.amount.amount < 0;

const isPlatformRetained = (i: FareLineItem): boolean =>
  PLATFORM_RETAINED_KINDS.includes(i.kind);

const sumWhere = (
  items: readonly FareLineItem[],
  predicate: (i: FareLineItem) => boolean,
  currency: CurrencyCode,
): Money =>
  items.filter(predicate).reduce<Money>((acc, i) => add(acc, i.amount), zero(currency));

const buildState = (items: readonly FareLineItem[], currency: CurrencyCode): PricingState => ({
  items,
  runningTotal: items.reduce<Money>((acc, i) => add(acc, i.amount), zero(currency)),
  baseCharges: items
    .filter((i) => BASE_KINDS.includes(i.kind))
    .reduce<Money>((acc, i) => add(acc, i.amount), zero(currency)),
});

/** Add a tip to a finalized fare. Tips are never commissioned. */
export const applyTip = (fare: FareBreakdown, tip: Money): FareBreakdown => {
  if (tip.amount <= 0) return fare;
  const tipItem: FareLineItem = {
    ruleId: 'tip',
    code: 'tip',
    label: 'Tip',
    amount: tip,
    kind: 'tip',
    detail: 'Goes entirely to your driver',
  };
  return {
    ...fare,
    items: [...fare.items, tipItem],
    total: add(fare.total, tip),
    driverPayout: add(fare.driverPayout, tip),
  };
};

/** Items a rider should see on a receipt. */
export const riderVisibleItems = (fare: FareBreakdown): FareLineItem[] =>
  fare.items.filter((i) => !i.internal);

/** Convenience: look up a line item by code. */
export const findLineItem = (
  fare: FareBreakdown,
  code: string,
): FareLineItem | undefined => fare.items.find((i) => i.code === code);

/** A zero fare, used for a draft ride before any quote exists. */
export const emptyFare = (
  rideTypeId: RideTypeId,
  currency: CurrencyCode,
  at: number,
): FareBreakdown => ({
  currency,
  rideTypeId,
  items: [],
  subtotal: zero(currency),
  total: zero(currency),
  driverPayout: zero(currency),
  platformRevenue: zero(currency),
  surgeMultiplier: 1,
  distanceMeters: 0,
  durationMs: 0,
  estimated: true,
  computedAt: at,
});
