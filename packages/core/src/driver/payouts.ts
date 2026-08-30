/**
 * Driver payouts.
 *
 * Earnings become a balance, and a balance becomes a payout. Both the
 * scheduled payout and the instant cash out are decided here, purely: what is
 * available, what a cash out costs, and whether one is allowed right now.
 *
 * The numbers are all `Money`, so nothing rounds through a float, and the fee
 * comes out of the payout rather than being added to it — a driver cashing out
 * their whole balance must never end up owing anything.
 */

import { money, subtract, multiply, type CurrencyCode, type Money } from '../util/money.js';
import { err, ok, type Result } from '../util/result.js';

export type PayoutStatus = 'pending' | 'paid' | 'failed';
export type PayoutKind = 'scheduled' | 'instant';

export interface Payout {
  readonly id: string;
  readonly driverId: string;
  readonly kind: PayoutKind;
  /** What the driver receives, after any fee. */
  readonly amount: Money;
  readonly fee: Money;
  readonly status: PayoutStatus;
  readonly requestedAt: number;
  readonly settledAt?: number;
  /** The destination as the driver would recognise it: "Chase ••••4321". */
  readonly destinationLabel?: string;
  readonly failureReason?: string;
}

export interface PayoutPolicy {
  /** Below this, an instant cash out is refused — fees would eat it. */
  readonly minimumInstantAmount: Money;
  /** Flat fee per instant cash out. */
  readonly instantFee: Money;
  /** Additional percentage fee, as a fraction. */
  readonly instantFeeRate: number;
  /** How many instant cash outs a driver may take per day. */
  readonly instantPerDayLimit: number;
  /** Which weekday the scheduled payout lands on, 0 = Sunday. */
  readonly scheduledWeekday: number;
}

export const defaultPayoutPolicy = (currency: CurrencyCode = 'USD'): PayoutPolicy => ({
  minimumInstantAmount: money(500, currency),
  instantFee: money(50, currency),
  instantFeeRate: 0,
  instantPerDayLimit: 5,
  scheduledWeekday: 2,
});

export interface PayoutBalance {
  /** Settled earnings not yet paid out. */
  readonly available: Money;
  /** Earned on trips that have not yet settled. */
  readonly pending: Money;
  readonly currency: CurrencyCode;
  readonly nextScheduledAt: number;
}

export type CashOutRejection =
  | 'below_minimum'
  | 'exceeds_balance'
  | 'daily_limit_reached'
  | 'no_destination';

/** Kept local so the domain does not depend on a locale for one message. */
const formatAmount = (m: Money): string =>
  `${m.currency === 'USD' ? '$' : ''}${(m.amount / 100).toFixed(2)}`;

export const cashOutRejectionMessage = (
  rejection: CashOutRejection,
  policy: PayoutPolicy,
): string => {
  switch (rejection) {
    case 'below_minimum':
      return `Cash outs start at ${formatAmount(policy.minimumInstantAmount)}.`;
    case 'exceeds_balance':
      return 'That is more than your available balance.';
    case 'daily_limit_reached':
      return `You have used all ${policy.instantPerDayLimit} cash outs for today.`;
    case 'no_destination':
      return 'Add a bank account before cashing out.';
  }
};

export interface CashOutRequest {
  readonly amount: Money;
  readonly balance: PayoutBalance;
  readonly policy: PayoutPolicy;
  readonly instantsToday: number;
  readonly hasDestination: boolean;
}

export interface CashOutQuote {
  /** What leaves the balance. */
  readonly gross: Money;
  readonly fee: Money;
  /** What reaches the driver's bank. */
  readonly net: Money;
}

/**
 * Price and authorise an instant cash out. The fee is deducted from the
 * requested amount, so cashing out the whole balance is always possible.
 */
export const quoteCashOut = (request: CashOutRequest): Result<CashOutQuote, CashOutRejection> => {
  if (!request.hasDestination) return err('no_destination');
  if (request.instantsToday >= request.policy.instantPerDayLimit) {
    return err('daily_limit_reached');
  }
  if (request.amount.amount > request.balance.available.amount) return err('exceeds_balance');
  if (request.amount.amount < request.policy.minimumInstantAmount.amount) {
    return err('below_minimum');
  }

  const percentage = multiply(request.amount, request.policy.instantFeeRate);
  const fee = money(request.policy.instantFee.amount + percentage.amount, request.amount.currency);
  const net = subtract(request.amount, fee);
  // A fee larger than the amount would leave a driver worse off for asking.
  if (net.amount <= 0) return err('below_minimum');

  return ok({ gross: request.amount, fee, net });
};

/**
 * When the next scheduled payout lands, given the policy's weekday. Takes
 * `now` rather than reading a clock, like everything else in the domain.
 */
export const nextScheduledPayout = (now: number, policy: PayoutPolicy): number => {
  const date = new Date(now);
  const daysAhead = (policy.scheduledWeekday - date.getDay() + 7) % 7 || 7;
  const next = new Date(date);
  next.setDate(date.getDate() + daysAhead);
  next.setHours(9, 0, 0, 0);
  return next.getTime();
};
