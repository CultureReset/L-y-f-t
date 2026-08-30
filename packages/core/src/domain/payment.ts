/**
 * Payments.
 *
 * The platform never talks to a card network directly; it talks to a
 * `PaymentGateway`. The in-memory gateway makes the whole payment path work
 * with no keys and no network, and a Stripe/Adyen/Braintree adapter is a
 * matter of implementing four methods.
 */

import { z } from 'zod';
import type { ChargeId, PaymentMethodId, RideId, RiderId } from '../util/ids.js';
import type { Money } from '../util/money.js';

export type PaymentMethodKind = 'card' | 'apple_pay' | 'google_pay' | 'paypal' | 'cash' | 'business';

export interface PaymentMethod {
  readonly id: PaymentMethodId;
  readonly riderId: RiderId;
  readonly kind: PaymentMethodKind;
  /** Card brand or wallet name: "visa", "mastercard", "apple_pay". */
  readonly brand: string;
  /** Last four digits, when the method has them. */
  readonly last4?: string;
  readonly expiryMonth?: number;
  readonly expiryYear?: number;
  readonly isDefault: boolean;
  /** The gateway's own token. This platform never stores raw card data. */
  readonly gatewayToken?: string;
  readonly label?: string;
  readonly createdAt: number;
  readonly removedAt?: number;
}

export type ChargeStatus =
  | 'pending'
  | 'authorized'
  | 'captured'
  | 'failed'
  | 'refunded'
  | 'partially_refunded'
  | 'voided';

export interface Charge {
  readonly id: ChargeId;
  readonly rideId?: RideId;
  readonly riderId: RiderId;
  readonly paymentMethodId: PaymentMethodId;
  readonly amount: Money;
  readonly status: ChargeStatus;
  readonly kind: 'ride_fare' | 'tip' | 'cancellation_fee' | 'adjustment';
  readonly authorizedAt?: number;
  readonly capturedAt?: number;
  readonly refundedAmount?: Money;
  readonly failureCode?: string;
  readonly failureMessage?: string;
  readonly gatewayReference?: string;
  readonly createdAt: number;
}

export interface AuthorizeRequest {
  readonly riderId: RiderId;
  readonly paymentMethodId: PaymentMethodId;
  readonly amount: Money;
  readonly rideId?: RideId;
  readonly kind: Charge['kind'];
  /** Prevents a retried request from charging twice. */
  readonly idempotencyKey: string;
  readonly description?: string;
}

export interface GatewayResult {
  readonly ok: boolean;
  readonly reference?: string;
  readonly failureCode?: string;
  readonly failureMessage?: string;
}

/**
 * The gateway port. Implement this to plug in a real processor.
 *
 * The flow is authorize-then-capture: a hold is placed when the ride starts
 * and captured for the final amount when it ends, so route changes and tips
 * do not require a second card interaction.
 */
export interface PaymentGateway {
  readonly id: string;
  authorize(request: AuthorizeRequest): Promise<GatewayResult>;
  capture(reference: string, amount: Money): Promise<GatewayResult>;
  void(reference: string): Promise<GatewayResult>;
  refund(reference: string, amount: Money): Promise<GatewayResult>;
}

export const paymentMethodSchema = z.object({
  kind: z.enum(['card', 'apple_pay', 'google_pay', 'paypal', 'cash', 'business']),
  brand: z.string().min(1).max(30),
  last4: z.string().length(4).optional(),
  expiryMonth: z.number().int().min(1).max(12).optional(),
  expiryYear: z.number().int().min(new Date().getFullYear()).max(2100).optional(),
  gatewayToken: z.string().optional(),
  label: z.string().max(40).optional(),
  makeDefault: z.boolean().default(false),
});

export type PaymentMethodInput = z.infer<typeof paymentMethodSchema>;

/** "Visa •••• 4242" — how a method renders in a picker. */
export const paymentMethodLabel = (method: PaymentMethod): string => {
  if (method.label) return method.label;
  switch (method.kind) {
    case 'apple_pay':
      return 'Apple Pay';
    case 'google_pay':
      return 'Google Pay';
    case 'paypal':
      return 'PayPal';
    case 'cash':
      return 'Cash';
    case 'business':
      return `Business • ${method.brand}`;
    default:
      return `${titleCase(method.brand)} •••• ${method.last4 ?? '????'}`;
  }
};

const titleCase = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

export const isExpired = (method: PaymentMethod, now: number): boolean => {
  if (method.expiryYear === undefined || method.expiryMonth === undefined) return false;
  const expiry = new Date(method.expiryYear, method.expiryMonth, 1).getTime();
  return expiry <= now;
};

export const isUsable = (method: PaymentMethod, now: number): boolean =>
  !method.removedAt && !isExpired(method, now);
