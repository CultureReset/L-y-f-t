/**
 * Promo codes.
 *
 * The catalog of promos is injected, so an operator supplies their own without
 * touching this file; what lives here is the part that needs the database —
 * counting redemptions, and recording one when a ride is booked with a code.
 *
 * Validation and redemption are deliberately separate. A rider checks a code
 * on the confirm screen long before they book, and checking must not consume
 * a limited-use code.
 */

import {
  AppError,
  checkPromo,
  normalizePromoCode,
  promoRejectionMessage,
  type Clock,
  type CurrencyCode,
  type Money,
  type Promo,
  type PromoApplication,
  type PromoWallet,
  type RideId,
  type RiderId,
} from '@lift/core';
import type { PromoRepository, RideRepository } from '../repositories/types.js';

export interface PromoServiceDeps {
  readonly promos: PromoRepository;
  readonly rides: RideRepository;
  readonly catalog: readonly Promo[];
  readonly currency: CurrencyCode;
  readonly clock: Clock;
}

export class PromoService {
  constructor(private readonly deps: PromoServiceDeps) {}

  find(code: string): Promo | undefined {
    const normalized = normalizePromoCode(code);
    return this.deps.catalog.find((promo) => promo.code === normalized);
  }

  /**
   * Check a code against this rider and, optionally, this trip. Throws with
   * the rider-facing reason rather than a boolean, because "no" is only useful
   * with a "why".
   */
  async validate(input: {
    code: string;
    riderId: RiderId;
    rideTypeId?: string;
    fareTotal?: Money;
  }): Promise<PromoApplication> {
    const promo = this.find(input.code);
    const eligibility = await this.eligibilityFor(promo, input.riderId, {
      ...(input.rideTypeId ? { rideTypeId: input.rideTypeId } : {}),
      ...(input.fareTotal ? { fareTotal: input.fareTotal } : {}),
    });

    const result = checkPromo(promo, eligibility);
    if (!result.ok) {
      throw new AppError('validation_failed', `Promo rejected: ${result.error}`, {
        userMessage: promoRejectionMessage(result.error, promo),
        details: { reason: result.error },
      });
    }
    return result.value;
  }

  /** Same check, but silent — used when pricing a quote that carries a code. */
  async applyIfValid(input: {
    code: string;
    riderId: RiderId;
    rideTypeId?: string;
  }): Promise<PromoApplication | undefined> {
    try {
      return await this.validate(input);
    } catch {
      return undefined;
    }
  }

  /** Record the use. Called once a ride is actually booked, never on a check. */
  async redeem(input: { code: string; riderId: RiderId; rideId?: RideId }): Promise<void> {
    await this.deps.promos.record({
      code: normalizePromoCode(input.code),
      riderId: input.riderId,
      ...(input.rideId ? { rideId: input.rideId } : {}),
      redeemedAt: this.deps.clock.now(),
    });
  }

  /** Every promo this rider could still use, with what is left on each. */
  async walletFor(riderId: RiderId): Promise<PromoWallet[]> {
    const wallet: PromoWallet[] = [];
    for (const promo of this.deps.catalog) {
      if (!promo.active) continue;
      const eligibility = await this.eligibilityFor(promo, riderId);
      const result = checkPromo(promo, eligibility);
      if (!result.ok) continue;
      wallet.push({
        promo,
        redemptionsLeft: promo.perRiderLimit - eligibility.riderRedemptions,
      });
    }
    return wallet;
  }

  private async eligibilityFor(
    promo: Promo | undefined,
    riderId: RiderId,
    extra: { rideTypeId?: string; fareTotal?: Money } = {},
  ): Promise<Parameters<typeof checkPromo>[1]> {
    // An unknown code short-circuits before any of these counts are needed.
    if (!promo) {
      return {
        now: this.deps.clock.now(),
        currency: this.deps.currency,
        riderRedemptions: 0,
        totalRedemptions: 0,
        riderCompletedRides: 0,
        ...extra,
      };
    }

    const [riderRedemptions, totalRedemptions, riderCompletedRides] = await Promise.all([
      this.deps.promos.countForRider(promo.code, riderId),
      promo.totalLimit === undefined ? Promise.resolve(0) : this.deps.promos.countTotal(promo.code),
      promo.firstRideOnly
        ? this.deps.rides.count({ riderId, statuses: ['completed'] })
        : Promise.resolve(0),
    ]);

    return {
      now: this.deps.clock.now(),
      currency: this.deps.currency,
      riderRedemptions,
      totalRedemptions,
      riderCompletedRides,
      ...extra,
    };
  }
}
