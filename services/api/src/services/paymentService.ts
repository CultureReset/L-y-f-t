/**
 * Payments.
 *
 * Wraps a `PaymentGateway` with the platform's own bookkeeping: charge records,
 * idempotency, and the authorize-then-capture flow. The in-memory gateway makes
 * the full payment path exercisable with no keys, including a configurable
 * decline rate so the failure branches are actually testable.
 */

import {
  AppError,
  isUsable,
  newChargeId,
  seededRandom,
  type AuthorizeRequest,
  type Charge,
  type Clock,
  type GatewayResult,
  type Money,
  type PaymentGateway,
  type PaymentMethod,
  type PaymentMethodId,
  type PlatformEvents,
  type RideId,
  type RiderId,
  type TypedEmitter,
} from '@lift/core';
import type { ChargeRepository, PaymentMethodRepository } from '../repositories/types.js';

/**
 * A gateway that keeps everything in memory. Approves by default; set
 * `declineRate` to exercise the decline path deterministically.
 */
export const createMemoryGateway = (
  options: { declineRate?: number; seed?: number } = {},
): PaymentGateway => {
  const random = seededRandom(options.seed ?? 1);
  const declineRate = options.declineRate ?? 0;
  const references = new Map<string, { amount: Money; captured: boolean; voided: boolean }>();

  return {
    id: 'memory',
    async authorize(request: AuthorizeRequest): Promise<GatewayResult> {
      if (declineRate > 0 && random.bool(declineRate)) {
        return {
          ok: false,
          failureCode: 'card_declined',
          failureMessage: 'The card issuer declined this charge.',
        };
      }
      const reference = `auth_${Math.random().toString(36).slice(2, 12)}`;
      references.set(reference, { amount: request.amount, captured: false, voided: false });
      return { ok: true, reference };
    },
    async capture(reference: string, amount: Money): Promise<GatewayResult> {
      const held = references.get(reference);
      if (!held) return { ok: false, failureCode: 'unknown_reference' };
      if (held.voided) return { ok: false, failureCode: 'authorization_voided' };
      references.set(reference, { ...held, amount, captured: true });
      return { ok: true, reference };
    },
    async void(reference: string): Promise<GatewayResult> {
      const held = references.get(reference);
      if (!held) return { ok: false, failureCode: 'unknown_reference' };
      references.set(reference, { ...held, voided: true });
      return { ok: true, reference };
    },
    async refund(reference: string): Promise<GatewayResult> {
      if (!references.has(reference)) return { ok: false, failureCode: 'unknown_reference' };
      return { ok: true, reference };
    },
  };
};

export interface PaymentServiceDeps {
  readonly gateway: PaymentGateway;
  readonly methods: PaymentMethodRepository;
  readonly charges: ChargeRepository;
  readonly clock: Clock;
  readonly events: TypedEmitter<PlatformEvents>;
}

export class PaymentService {
  constructor(private readonly deps: PaymentServiceDeps) {}

  /** The rider's default method, or the only usable one they have. */
  async resolveMethod(
    riderId: RiderId,
    preferred?: PaymentMethodId,
  ): Promise<PaymentMethod> {
    const now = this.deps.clock.now();
    if (preferred) {
      const method = await this.deps.methods.findById(preferred);
      if (!method || method.riderId !== riderId) {
        throw new AppError('not_found', 'Payment method not found');
      }
      if (!isUsable(method, now)) {
        throw new AppError('payment_method_required', 'That payment method has expired', {
          userMessage: 'That card has expired. Add another to keep riding.',
        });
      }
      return method;
    }

    const methods = await this.deps.methods.listForRider(riderId);
    const usable = methods.filter((m) => isUsable(m, now));
    const chosen = usable.find((m) => m.isDefault) ?? usable[0];
    if (!chosen) {
      throw new AppError('payment_method_required', 'Rider has no usable payment method');
    }
    return chosen;
  }

  /**
   * Place a hold. Idempotent: repeating a request with the same key returns the
   * original charge rather than authorizing a second time.
   */
  async authorize(input: {
    riderId: RiderId;
    paymentMethodId: PaymentMethodId;
    amount: Money;
    rideId?: RideId;
    kind: Charge['kind'];
    idempotencyKey: string;
    description?: string;
  }): Promise<Charge> {
    const existing = await this.deps.charges.findByIdempotencyKey(input.idempotencyKey);
    if (existing) return existing;

    const now = this.deps.clock.now();
    const result = await this.deps.gateway.authorize({
      riderId: input.riderId,
      paymentMethodId: input.paymentMethodId,
      amount: input.amount,
      kind: input.kind,
      idempotencyKey: input.idempotencyKey,
      ...(input.rideId ? { rideId: input.rideId } : {}),
      ...(input.description ? { description: input.description } : {}),
    });

    const charge: Charge = {
      id: newChargeId(),
      riderId: input.riderId,
      paymentMethodId: input.paymentMethodId,
      amount: input.amount,
      kind: input.kind,
      status: result.ok ? 'authorized' : 'failed',
      createdAt: now,
      ...(input.rideId ? { rideId: input.rideId } : {}),
      ...(result.ok ? { authorizedAt: now } : {}),
      ...(result.reference ? { gatewayReference: result.reference } : {}),
      ...(result.failureCode ? { failureCode: result.failureCode } : {}),
      ...(result.failureMessage ? { failureMessage: result.failureMessage } : {}),
    };

    const saved = await this.deps.charges.create(charge, input.idempotencyKey);

    if (saved.status === 'authorized') {
      this.deps.events.emit('payment.authorized', { charge: saved });
      return saved;
    }

    this.deps.events.emit('payment.failed', {
      charge: saved,
      reason: saved.failureCode ?? 'unknown',
    });
    throw new AppError('payment_declined', saved.failureMessage ?? 'Payment declined', {
      details: { chargeId: saved.id, code: saved.failureCode },
    });
  }

  /**
   * Capture a held authorization for the final amount. When the final fare
   * exceeds the hold — a longer route, a tip — the gateway is asked for the new
   * amount, and a gateway that refuses leaves the charge failed rather than
   * silently under-collecting.
   */
  async capture(chargeId: Charge['id'], finalAmount?: Money): Promise<Charge> {
    const charge = await this.deps.charges.findById(chargeId);
    if (!charge) throw new AppError('not_found', 'Charge not found');
    if (charge.status === 'captured') return charge;
    if (charge.status !== 'authorized' || !charge.gatewayReference) {
      throw new AppError('conflict', `Cannot capture a charge in status "${charge.status}"`);
    }

    const amount = finalAmount ?? charge.amount;
    const result = await this.deps.gateway.capture(charge.gatewayReference, amount);
    const now = this.deps.clock.now();

    if (!result.ok) {
      const failed = await this.deps.charges.update(chargeId, {
        status: 'failed',
        failureCode: result.failureCode ?? 'capture_failed',
        failureMessage: result.failureMessage ?? 'Could not capture payment',
      });
      this.deps.events.emit('payment.failed', {
        charge: failed,
        reason: failed.failureCode ?? 'capture_failed',
      });
      throw new AppError('payment_declined', 'Could not capture payment', {
        details: { chargeId },
      });
    }

    const captured = await this.deps.charges.update(chargeId, {
      status: 'captured',
      capturedAt: now,
      amount,
    });
    this.deps.events.emit('payment.captured', { charge: captured });
    return captured;
  }

  /** Release a hold on a ride that never happened. */
  async release(chargeId: Charge['id']): Promise<Charge> {
    const charge = await this.deps.charges.findById(chargeId);
    if (!charge) throw new AppError('not_found', 'Charge not found');
    if (charge.status !== 'authorized' || !charge.gatewayReference) return charge;
    await this.deps.gateway.void(charge.gatewayReference);
    return this.deps.charges.update(chargeId, { status: 'voided' });
  }

  async refund(chargeId: Charge['id'], amount: Money): Promise<Charge> {
    const charge = await this.deps.charges.findById(chargeId);
    if (!charge) throw new AppError('not_found', 'Charge not found');
    if (!charge.gatewayReference) throw new AppError('conflict', 'Charge was never authorized');
    const result = await this.deps.gateway.refund(charge.gatewayReference, amount);
    if (!result.ok) throw new AppError('conflict', 'Refund was rejected by the gateway');
    const isFull = amount.amount >= charge.amount.amount;
    const refunded = await this.deps.charges.update(chargeId, {
      status: isFull ? 'refunded' : 'partially_refunded',
      refundedAmount: amount,
    });
    this.deps.events.emit('payment.refunded', { charge: refunded });
    return refunded;
  }

  /** Every charge recorded against a ride. */
  async chargesForRide(rideId: RideId): Promise<Charge[]> {
    return this.deps.charges.listForRide(rideId);
  }

  /** The live authorization hold on a ride, if one succeeded. */
  async heldChargeFor(rideId: RideId): Promise<Charge | undefined> {
    const charges = await this.deps.charges.listForRide(rideId);
    return charges.find((c) => c.kind === 'ride_fare' && c.status === 'authorized');
  }

  /** Charge a rider directly, with no prior hold — tips and cancellation fees. */
  async chargeImmediately(input: {
    riderId: RiderId;
    paymentMethodId: PaymentMethodId;
    amount: Money;
    rideId?: RideId;
    kind: Charge['kind'];
    idempotencyKey: string;
    description?: string;
  }): Promise<Charge> {
    const authorized = await this.authorize(input);
    return this.capture(authorized.id, input.amount);
  }
}
