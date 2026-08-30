/**
 * The stock pricing rules.
 *
 * Each rule is an independent, testable unit that reads the context and the
 * running state and emits line items. To change how fares work — add a
 * congestion charge, a loyalty discount, a per-market airport fee — write a
 * rule and register it. Nothing here needs editing.
 */

import { metersToMiles } from '../util/geo.js';
import {
  add,
  clampAtLeastZero,
  formatMoney,
  money,
  multiply,
  rate,
  subtract,
  zero,
  type Money,
} from '../util/money.js';
import type {
  FareLineItem,
  PricingContext,
  PricingRule,
  PricingState,
  RateCard,
} from './types.js';

const item = (
  ruleId: string,
  code: string,
  label: string,
  amount: Money,
  kind: FareLineItem['kind'],
  extra: Partial<FareLineItem> = {},
): FareLineItem => ({ ruleId, code, label, amount, kind, ...extra });

/** The flat charge that starts every fare. */
export const baseFareRule = (card: RateCard): PricingRule => ({
  id: 'base_fare',
  phase: 'base',
  priority: 10,
  description: 'Flat charge applied to every ride',
  evaluate: () => [item('base_fare', 'base_fare', 'Base fare', card.baseFare, 'base')],
});

/** Per-mile distance charge. */
export const distanceRule = (card: RateCard): PricingRule => ({
  id: 'distance',
  phase: 'base',
  priority: 20,
  description: 'Per-mile charge across the trip distance',
  evaluate: (ctx) => {
    const miles = metersToMiles(ctx.distanceMeters);
    if (miles <= 0) return [];
    return [
      item('distance', 'distance', `Distance (${miles.toFixed(1)} mi)`, rate(card.perMile, miles), 'distance', {
        detail: `${formatMoney(card.perMile)}/mi × ${miles.toFixed(1)} mi`,
        meta: { miles, perMile: card.perMile.amount },
      }),
    ];
  },
});

/** Per-minute time charge across the estimated or actual trip duration. */
export const timeRule = (card: RateCard): PricingRule => ({
  id: 'time',
  phase: 'base',
  priority: 30,
  description: 'Per-minute charge across the trip duration',
  evaluate: (ctx) => {
    const mins = ctx.durationMs / 60_000;
    if (mins <= 0) return [];
    return [
      item('time', 'time', `Time (${Math.round(mins)} min)`, rate(card.perMinute, mins), 'time', {
        detail: `${formatMoney(card.perMinute)}/min × ${Math.round(mins)} min`,
        meta: { minutes: mins, perMinute: card.perMinute.amount },
      }),
    ];
  },
});

/**
 * Surge. Applied only to the base charges (base + distance + time), never to
 * fees or taxes — multiplying a fixed service fee by 2.1× would be wrong.
 * The multiplier is clamped to the rate card's ceiling as a safety rail.
 */
export const surgeRule = (card: RateCard): PricingRule => ({
  id: 'surge',
  phase: 'surge',
  priority: 10,
  description: 'Demand multiplier applied to base charges only',
  appliesTo: (ctx) => ctx.surgeMultiplier > 1,
  evaluate: (ctx, state) => {
    const multiplier = Math.min(ctx.surgeMultiplier, card.maxSurgeMultiplier);
    if (multiplier <= 1) return [];
    const uplift = subtract(multiply(state.baseCharges, multiplier), state.baseCharges);
    if (uplift.amount === 0) return [];
    return [
      item('surge', 'surge', `Busy area (${multiplier.toFixed(1)}×)`, uplift, 'surge', {
        detail: 'Higher demand than usual right now',
        meta: { multiplier, requested: ctx.surgeMultiplier, capped: multiplier < ctx.surgeMultiplier },
      }),
    ];
  },
});

/** Per-stop charge for multi-stop itineraries. */
export const extraStopRule = (perStop: Money): PricingRule => ({
  id: 'extra_stops',
  phase: 'surcharge',
  priority: 10,
  description: 'Charge for each intermediate stop',
  appliesTo: (ctx) => ctx.stopCount > 0,
  evaluate: (ctx) => [
    item(
      'extra_stops',
      'extra_stops',
      `Extra stop${ctx.stopCount > 1 ? 's' : ''} (${ctx.stopCount})`,
      rate(perStop, ctx.stopCount),
      'surcharge',
    ),
  ],
});

/** Charges the driver's waiting time past the free window at pickup. */
export const waitTimeRule = (card: RateCard): PricingRule => ({
  id: 'wait_time',
  phase: 'surcharge',
  priority: 20,
  description: 'Per-minute charge for waiting past the free window',
  appliesTo: (ctx) => (ctx.waitMinutes ?? 0) > card.freeWaitMinutes,
  evaluate: (ctx) => {
    const billable = (ctx.waitMinutes ?? 0) - card.freeWaitMinutes;
    if (billable <= 0) return [];
    return [
      item(
        'wait_time',
        'wait_time',
        `Wait time (${Math.round(billable)} min)`,
        rate(card.perMinuteWaiting, billable),
        'wait_time',
        { detail: `First ${card.freeWaitMinutes} min are free` },
      ),
    ];
  },
});

/** Zone-based surcharges supplied by the caller (airport, stadium, port). */
export const zoneSurchargeRule = (): PricingRule => ({
  id: 'zone_surcharges',
  phase: 'surcharge',
  priority: 30,
  description: 'Location-based surcharges such as airport pickup fees',
  appliesTo: (ctx) => (ctx.zoneSurcharges?.length ?? 0) > 0,
  evaluate: (ctx) =>
    (ctx.zoneSurcharges ?? []).map((z) =>
      item('zone_surcharges', z.code, z.label, z.amount, 'surcharge', {
        meta: { appliesAt: z.appliesAt },
      }),
    ),
});

/** Tolls reported by the routing provider, passed straight through. */
export const tollsRule = (): PricingRule => ({
  id: 'tolls',
  phase: 'surcharge',
  priority: 40,
  description: 'Tolls reported by the routing provider',
  appliesTo: (ctx) => (ctx.tolls?.amount ?? 0) > 0,
  evaluate: (ctx) => [item('tolls', 'tolls', 'Tolls', ctx.tolls!, 'toll')],
});

/**
 * Promo codes. Percentage discounts apply to the running total at discount
 * phase (base + surge + surcharges) and honour an optional cap; `fixed_fare`
 * replaces the total outright.
 */
export const promoRule = (): PricingRule => ({
  id: 'promo',
  phase: 'discount',
  priority: 10,
  description: 'Applies a promo code discount',
  appliesTo: (ctx) => ctx.promo !== undefined,
  evaluate: (ctx, state) => {
    const promo = ctx.promo!;
    let discount: Money;
    switch (promo.kind) {
      case 'percent_off': {
        discount = multiply(state.runningTotal, Math.min(1, promo.value));
        if (promo.maxDiscount && discount.amount > promo.maxDiscount.amount) {
          discount = promo.maxDiscount;
        }
        break;
      }
      case 'amount_off':
        discount = money(promo.value, ctx.currency);
        break;
      case 'fixed_fare':
        discount = clampAtLeastZero(
          subtract(state.runningTotal, money(promo.value, ctx.currency)),
        );
        break;
    }
    // Never discount below zero.
    if (discount.amount > state.runningTotal.amount) discount = state.runningTotal;
    if (discount.amount <= 0) return [];
    return [
      item('promo', `promo_${promo.code}`, promo.label, multiply(discount, -1), 'promo', {
        detail: promo.code,
        meta: { code: promo.code, kind: promo.kind },
      }),
    ];
  },
});

/**
 * The fare floor. If everything charged so far is below the minimum, top it up
 * so the driver is not paid a trivial amount for a short trip. Runs after
 * discounts so a promo can still take a fare below the minimum.
 */
export const minimumFareRule = (card: RateCard): PricingRule => ({
  id: 'minimum_fare',
  phase: 'fee',
  priority: 5,
  description: 'Tops short trips up to the minimum fare',
  appliesTo: (ctx) => !ctx.promo || ctx.promo.kind !== 'fixed_fare',
  evaluate: (_ctx, state) => {
    if (state.runningTotal.amount >= card.minimumFare.amount) return [];
    const topUp = subtract(card.minimumFare, state.runningTotal);
    if (topUp.amount <= 0) return [];
    return [
      item('minimum_fare', 'minimum_adjustment', 'Minimum fare adjustment', topUp, 'minimum_adjustment', {
        detail: `Minimum fare is ${formatMoney(card.minimumFare)}`,
      }),
    ];
  },
});

/** The platform's flat per-ride service fee. */
export const serviceFeeRule = (card: RateCard): PricingRule => ({
  id: 'service_fee',
  phase: 'fee',
  priority: 20,
  description: 'Flat platform service fee',
  appliesTo: () => card.serviceFee.amount > 0,
  evaluate: () => [
    item('service_fee', 'service_fee', 'Service fee', card.serviceFee, 'fee', {
      detail: 'Supports the platform, insurance, and support',
    }),
  ],
});

/** Sales tax on the taxable subtotal. */
export const taxRule = (card: RateCard): PricingRule => ({
  id: 'tax',
  phase: 'tax',
  priority: 10,
  description: 'Sales tax on the taxable subtotal',
  appliesTo: () => card.taxRate > 0,
  evaluate: (_ctx, state) => {
    const tax = multiply(state.runningTotal, card.taxRate);
    if (tax.amount <= 0) return [];
    return [
      item('tax', 'tax', 'Taxes', tax, 'tax', {
        detail: `${(card.taxRate * 100).toFixed(2)}%`,
      }),
    ];
  },
});

/**
 * The standard rule set for a rate card, in the order the engine will run
 * them. Compose your own array to change pricing behaviour wholesale.
 */
export const standardRules = (
  card: RateCard,
  options: { perStopCharge?: Money } = {},
): PricingRule[] => [
  baseFareRule(card),
  distanceRule(card),
  timeRule(card),
  surgeRule(card),
  extraStopRule(options.perStopCharge ?? money(150, card.currency)),
  waitTimeRule(card),
  zoneSurchargeRule(),
  tollsRule(),
  promoRule(),
  minimumFareRule(card),
  serviceFeeRule(card),
  taxRule(card),
];

/**
 * Cancellation fees are priced by their own tiny rule set rather than by
 * special-casing the main pipeline.
 */
export const cancellationRules = (card: RateCard): PricingRule[] => [
  {
    id: 'cancellation_fee',
    phase: 'base',
    priority: 10,
    description: 'Flat fee for a late cancellation',
    evaluate: () => [
      item(
        'cancellation_fee',
        'cancellation_fee',
        'Cancellation fee',
        card.cancellationFee,
        'cancellation',
        { detail: 'Charged when a ride is cancelled after the free window' },
      ),
    ],
  },
];

/** Sum of items in the given kinds — used by the engine for subtotals. */
export const sumOfKinds = (
  items: readonly FareLineItem[],
  kinds: readonly FareLineItem['kind'][],
  currency: Money['currency'],
): Money =>
  items
    .filter((i) => kinds.includes(i.kind))
    .reduce<Money>((acc, i) => add(acc, i.amount), zero(currency));
