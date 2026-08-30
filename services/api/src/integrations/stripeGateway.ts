/**
 * Stripe payment gateway.
 *
 * Implements the platform's `PaymentGateway` port against Stripe's Payment
 * Intents API, using the authorize-then-capture flow the ride lifecycle already
 * expects: a hold goes on when a driver is assigned, and it is captured for the
 * real amount when the trip ends — so a longer route or a tip never needs a
 * second card interaction.
 *
 * Deliberately written against the REST API with `fetch` rather than the Stripe
 * SDK: the SDK is a large dependency for four calls, and this keeps the adapter
 * readable as a worked example of what any processor integration has to do.
 *
 * Set `PAYMENT_GATEWAY=stripe` and `PAYMENT_API_KEY=sk_...` to use it.
 */

import type { AuthorizeRequest, GatewayResult, Money, PaymentGateway } from '@lift/core';

const STRIPE_API = 'https://api.stripe.com/v1';

export interface StripeGatewayOptions {
  readonly secretKey: string;
  /** Injected so tests can drive the adapter without a network. */
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  /** Statement descriptor suffix, as it appears on a card statement. */
  readonly statementDescriptor?: string;
}

interface StripeError {
  readonly type?: string;
  readonly code?: string;
  readonly decline_code?: string;
  readonly message?: string;
}

interface StripePaymentIntent {
  readonly id: string;
  readonly status: string;
  readonly amount: number;
  readonly amount_received?: number;
  readonly last_payment_error?: StripeError;
}

interface StripeRefund {
  readonly id: string;
  readonly status: string;
}

export const createStripeGateway = (options: StripeGatewayOptions): PaymentGateway => {
  if (!options.secretKey) throw new Error('createStripeGateway requires a secretKey');
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = options.timeoutMs ?? 20_000;

  /**
   * Stripe speaks form-encoded bodies, not JSON. Errors come back as a 4xx with
   * an `error` object, which is mapped onto the platform's own failure codes so
   * the rider sees a sensible message rather than a Stripe string.
   */
  const call = async <T>(
    path: string,
    form: Record<string, string | undefined>,
    idempotencyKey?: string,
  ): Promise<{ ok: true; data: T } | { ok: false; error: StripeError }> => {
    const body = new URLSearchParams();
    for (const [key, value] of Object.entries(form)) {
      if (value !== undefined) body.set(key, value);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await doFetch(`${STRIPE_API}${path}`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${options.secretKey}`,
          'content-type': 'application/x-www-form-urlencoded',
          // Stripe replays the original response for a repeated key, which is
          // what makes a retried authorization safe.
          ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
        },
        body: body.toString(),
      });

      const payload = (await response.json()) as { error?: StripeError } & T;
      if (!response.ok || payload.error) {
        return { ok: false, error: payload.error ?? { message: `HTTP ${response.status}` } };
      }
      return { ok: true, data: payload };
    } catch (e) {
      const aborted = e instanceof Error && e.name === 'AbortError';
      return {
        ok: false,
        error: {
          code: aborted ? 'processing_error' : 'api_connection_error',
          message: aborted ? 'The payment request timed out' : String(e),
        },
      };
    } finally {
      clearTimeout(timer);
    }
  };

  const failure = (error: StripeError): GatewayResult => ({
    ok: false,
    // `decline_code` is the specific reason (insufficient_funds); `code` is the
    // general one. Prefer the specific.
    failureCode: error.decline_code ?? error.code ?? error.type ?? 'payment_failed',
    failureMessage: error.message ?? 'The payment could not be processed.',
  });

  return {
    id: 'stripe',

    async authorize(request: AuthorizeRequest): Promise<GatewayResult> {
      const result = await call<StripePaymentIntent>(
        '/payment_intents',
        {
          amount: String(request.amount.amount),
          currency: request.amount.currency.toLowerCase(),
          payment_method: request.paymentMethodId,
          // Hold the funds; the platform captures at ride completion.
          capture_method: 'manual',
          confirm: 'true',
          // A ridehail charge happens after the rider has left the app, so the
          // payment method must be usable off-session.
          off_session: 'true',
          description: request.description,
          'metadata[rideId]': request.rideId,
          'metadata[riderId]': request.riderId,
          'metadata[kind]': request.kind,
          statement_descriptor_suffix: options.statementDescriptor,
        },
        request.idempotencyKey,
      );

      if (!result.ok) return failure(result.error);

      // A confirmed intent that still needs action (3-D Secure) is not a hold
      // the platform can rely on, so it is reported as a failure the rider can
      // act on rather than treated as success.
      if (result.data.status === 'requires_action') {
        return {
          ok: false,
          reference: result.data.id,
          failureCode: 'authentication_required',
          failureMessage: 'Your bank needs to verify this payment.',
        };
      }
      if (result.data.status !== 'requires_capture' && result.data.status !== 'succeeded') {
        return {
          ok: false,
          reference: result.data.id,
          failureCode: result.data.status,
          failureMessage: result.data.last_payment_error?.message ?? 'The card was not authorized.',
        };
      }

      return { ok: true, reference: result.data.id };
    },

    async capture(reference: string, amount: Money): Promise<GatewayResult> {
      const result = await call<StripePaymentIntent>(
        `/payment_intents/${reference}/capture`,
        // Capturing less than the hold is normal — the final fare is usually
        // below the upper estimate the hold was placed for.
        { amount_to_capture: String(amount.amount) },
        `capture:${reference}:${amount.amount}`,
      );
      if (!result.ok) return failure(result.error);
      return { ok: true, reference: result.data.id };
    },

    async void(reference: string): Promise<GatewayResult> {
      const result = await call<StripePaymentIntent>(
        `/payment_intents/${reference}/cancel`,
        { cancellation_reason: 'abandoned' },
        `void:${reference}`,
      );
      if (!result.ok) return failure(result.error);
      return { ok: true, reference: result.data.id };
    },

    async refund(reference: string, amount: Money): Promise<GatewayResult> {
      const result = await call<StripeRefund>(
        '/refunds',
        { payment_intent: reference, amount: String(amount.amount) },
        `refund:${reference}:${amount.amount}`,
      );
      if (!result.ok) return failure(result.error);
      return { ok: true, reference: result.data.id };
    },
  };
};
