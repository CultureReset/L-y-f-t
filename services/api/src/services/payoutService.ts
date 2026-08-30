/**
 * Driver payouts.
 *
 * The balance is derived, never stored: it is everything a driver has earned
 * on completed trips, minus everything already paid out or in flight. Storing
 * a balance means two sources of truth that will eventually disagree, and the
 * one that disagrees is somebody's wages.
 *
 * The policy — minimum, fee, daily limit, payout weekday — is injected, so a
 * market changes it in the container rather than here.
 */

import {
  AppError,
  cashOutRejectionMessage,
  money,
  newId,
  newPayoutId,
  nextScheduledPayout,
  quoteCashOut,
  type CashOutQuote,
  type Clock,
  type CurrencyCode,
  type DriverId,
  type Money,
  type Payout,
  type PayoutBalance,
  type PayoutPolicy,
} from '@lift/core';
import type {
  PayoutDestination,
  PayoutRepository,
  RideRepository,
} from '../repositories/types.js';

export interface PayoutServiceDeps {
  readonly payouts: PayoutRepository;
  readonly rides: RideRepository;
  readonly policy: PayoutPolicy;
  readonly currency: CurrencyCode;
  readonly clock: Clock;
}

export class PayoutService {
  constructor(private readonly deps: PayoutServiceDeps) {}

  get policy(): PayoutPolicy {
    return this.deps.policy;
  }

  /**
   * What a driver has, and what is still settling. "Pending" is the earnings
   * from trips completed in the last day — a real deployment would key this
   * off the charge settling rather than a clock, but the shape is the same and
   * the seam is here.
   */
  async balance(driverId: DriverId): Promise<PayoutBalance> {
    const now = this.deps.clock.now();
    const rides = await this.deps.rides.query({
      driverId,
      statuses: ['completed'],
      limit: 1000,
    });

    const settleAfter = now - 24 * 60 * 60 * 1000;
    let earned = 0;
    let pending = 0;
    for (const ride of rides) {
      const payout = ride.finalFare?.driverPayout;
      if (!payout) continue;
      if ((ride.completedAt ?? ride.updatedAt) >= settleAfter) pending += payout.amount;
      else earned += payout.amount;
    }

    const committed = await this.deps.payouts.totalCommitted(driverId);
    return {
      // A driver who has been paid more than they earned is a bug elsewhere;
      // showing a negative balance here would only compound it.
      available: money(Math.max(0, earned - committed), this.deps.currency),
      pending: money(pending, this.deps.currency),
      currency: this.deps.currency,
      nextScheduledAt: nextScheduledPayout(now, this.deps.policy),
    };
  }

  /** Price a cash out without taking it — what the confirm sheet shows. */
  async quote(driverId: DriverId, amount: Money): Promise<CashOutQuote> {
    const [balance, instantsToday, destinations] = await Promise.all([
      this.balance(driverId),
      this.instantsToday(driverId),
      this.deps.payouts.listDestinations(driverId),
    ]);

    const result = quoteCashOut({
      amount,
      balance,
      policy: this.deps.policy,
      instantsToday,
      hasDestination: destinations.length > 0,
    });

    if (!result.ok) {
      throw new AppError('validation_failed', `Cash out rejected: ${result.error}`, {
        userMessage: cashOutRejectionMessage(result.error, this.deps.policy),
        details: { reason: result.error },
      });
    }
    return result.value;
  }

  /**
   * Take the cash out. Re-quotes rather than trusting a quote the client sends
   * back, because the balance may have moved since the sheet was drawn.
   */
  async cashOut(driverId: DriverId, amount: Money): Promise<Payout> {
    const quote = await this.quote(driverId, amount);
    const destinations = await this.deps.payouts.listDestinations(driverId);
    const destination = destinations.find((d) => d.isDefault) ?? destinations[0];

    const payout: Payout = {
      id: newPayoutId(),
      driverId,
      kind: 'instant',
      amount: quote.net,
      fee: quote.fee,
      // An instant cash out is only instant once the processor confirms it.
      status: 'pending',
      requestedAt: this.deps.clock.now(),
      ...(destination ? { destinationLabel: destination.label } : {}),
    };
    return this.deps.payouts.create(payout);
  }

  async history(driverId: DriverId, limit = 50): Promise<Payout[]> {
    return this.deps.payouts.listForDriver(driverId, limit);
  }

  async destinations(driverId: DriverId): Promise<PayoutDestination[]> {
    return this.deps.payouts.listDestinations(driverId);
  }

  async addDestination(
    driverId: DriverId,
    input: { label: string; gatewayToken?: string; makeDefault?: boolean },
  ): Promise<PayoutDestination> {
    const existing = await this.deps.payouts.listDestinations(driverId);
    return this.deps.payouts.addDestination({
      id: newId('payoutDestination'),
      driverId,
      label: input.label,
      // The first one a driver adds is their default, whatever they asked for.
      isDefault: input.makeDefault ?? existing.length === 0,
      createdAt: this.deps.clock.now(),
      ...(input.gatewayToken ? { gatewayToken: input.gatewayToken } : {}),
    });
  }

  async removeDestination(driverId: DriverId, id: string): Promise<void> {
    const destinations = await this.deps.payouts.listDestinations(driverId);
    if (!destinations.some((d) => d.id === id)) {
      throw new AppError('not_found', `Payout destination ${id} not found`);
    }
    await this.deps.payouts.removeDestination(id);
  }

  /** Instant cash outs taken since local midnight — what the limit counts. */
  private async instantsToday(driverId: DriverId): Promise<number> {
    const midnight = new Date(this.deps.clock.now());
    midnight.setHours(0, 0, 0, 0);
    return this.deps.payouts.countInstantSince(driverId, midnight.getTime());
  }
}
