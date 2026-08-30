/**
 * Vendor adapter tests.
 *
 * Each adapter takes an injectable `fetch`, so the request it builds and the
 * response it interprets are both testable without an account. What matters
 * here is the mapping in each direction: does it send what the vendor expects,
 * and does it turn a vendor failure into something the platform can act on?
 */

import { describe, expect, it, vi } from 'vitest';
import { fromDecimal, type RiderId } from '@lift/core';
import { createStripeGateway } from './stripeGateway.js';
import { createTwilioSender } from './twilioSender.js';
import { createExpoPushTransport } from './expoPush.js';
import { createMemoryRepositories } from '../repositories/memory/index.js';

/** A fetch that returns a canned response and records what it was called with. */
const fakeFetch = (
  responses: { status?: number; body: unknown }[] | { status?: number; body: unknown },
) => {
  const queue = Array.isArray(responses) ? [...responses] : [responses];
  const calls: { url: string; init: RequestInit; form: URLSearchParams }[] = [];

  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const next = queue.length > 1 ? queue.shift()! : queue[0]!;
    calls.push({
      url: String(url),
      init: init ?? {},
      form: new URLSearchParams(String(init?.body ?? '')),
    });
    return {
      ok: (next.status ?? 200) < 400,
      status: next.status ?? 200,
      json: async () => next.body,
      text: async () => JSON.stringify(next.body),
    } as Response;
  });

  return Object.assign(fn as unknown as typeof fetch, { calls });
};

describe('Stripe gateway', () => {
  const authorizeRequest = {
    riderId: 'rdr_1' as RiderId,
    paymentMethodId: 'pm_card_visa' as never,
    amount: fromDecimal(24.5),
    rideId: 'rid_1' as never,
    kind: 'ride_fare' as const,
    idempotencyKey: 'ride:rid_1:fare',
    description: 'Ride to Dolores Park',
  };

  it('places a manual-capture hold with the idempotency key', async () => {
    const doFetch = fakeFetch({ body: { id: 'pi_123', status: 'requires_capture' } });
    const gateway = createStripeGateway({ secretKey: 'sk_test', fetch: doFetch });

    const result = await gateway.authorize(authorizeRequest);

    expect(result).toEqual({ ok: true, reference: 'pi_123' });
    const call = doFetch.calls[0]!;
    expect(call.url).toContain('/payment_intents');
    expect(call.form.get('amount')).toBe('2450');
    expect(call.form.get('currency')).toBe('usd');
    // The whole ride lifecycle depends on the hold not capturing immediately.
    expect(call.form.get('capture_method')).toBe('manual');
    // A ridehail charge happens after the rider has closed the app.
    expect(call.form.get('off_session')).toBe('true');
    expect(call.form.get('metadata[rideId]')).toBe('rid_1');
    expect((call.init.headers as Record<string, string>)['idempotency-key']).toBe(
      'ride:rid_1:fare',
    );
  });

  it('maps a decline onto its specific reason, not the generic one', async () => {
    const doFetch = fakeFetch({
      status: 402,
      body: {
        error: {
          type: 'card_error',
          code: 'card_declined',
          decline_code: 'insufficient_funds',
          message: 'Your card has insufficient funds.',
        },
      },
    });
    const gateway = createStripeGateway({ secretKey: 'sk_test', fetch: doFetch });

    const result = await gateway.authorize(authorizeRequest);

    expect(result.ok).toBe(false);
    expect(result.failureCode).toBe('insufficient_funds');
    expect(result.failureMessage).toMatch(/insufficient funds/i);
  });

  it('treats a 3-D Secure challenge as a failure rather than a usable hold', async () => {
    const doFetch = fakeFetch({ body: { id: 'pi_sca', status: 'requires_action' } });
    const gateway = createStripeGateway({ secretKey: 'sk_test', fetch: doFetch });

    const result = await gateway.authorize(authorizeRequest);

    expect(result.ok).toBe(false);
    expect(result.failureCode).toBe('authentication_required');
    // The reference is still returned so the intent can be recovered.
    expect(result.reference).toBe('pi_sca');
  });

  it('captures less than the hold, which is the normal case', async () => {
    const doFetch = fakeFetch({ body: { id: 'pi_123', status: 'succeeded' } });
    const gateway = createStripeGateway({ secretKey: 'sk_test', fetch: doFetch });

    const result = await gateway.capture('pi_123', fromDecimal(19.75));

    expect(result.ok).toBe(true);
    expect(doFetch.calls[0]!.url).toContain('/payment_intents/pi_123/capture');
    expect(doFetch.calls[0]!.form.get('amount_to_capture')).toBe('1975');
  });

  it('voids a hold when a ride never happens', async () => {
    const doFetch = fakeFetch({ body: { id: 'pi_123', status: 'canceled' } });
    const gateway = createStripeGateway({ secretKey: 'sk_test', fetch: doFetch });

    expect((await gateway.void('pi_123')).ok).toBe(true);
    expect(doFetch.calls[0]!.url).toContain('/cancel');
  });

  it('refunds a captured charge', async () => {
    const doFetch = fakeFetch({ body: { id: 're_1', status: 'succeeded' } });
    const gateway = createStripeGateway({ secretKey: 'sk_test', fetch: doFetch });

    const result = await gateway.refund('pi_123', fromDecimal(5));

    expect(result.ok).toBe(true);
    expect(doFetch.calls[0]!.form.get('payment_intent')).toBe('pi_123');
    expect(doFetch.calls[0]!.form.get('amount')).toBe('500');
  });

  it('reports a network failure as a failure rather than throwing', async () => {
    const gateway = createStripeGateway({
      secretKey: 'sk_test',
      fetch: (async () => {
        throw new Error('socket hang up');
      }) as unknown as typeof fetch,
    });

    const result = await gateway.authorize(authorizeRequest);
    expect(result.ok).toBe(false);
    expect(result.failureCode).toBe('api_connection_error');
  });

  it('refuses to be built without a key', () => {
    expect(() => createStripeGateway({ secretKey: '' })).toThrow(/secretKey/);
  });
});

describe('Twilio sender', () => {
  it('sends the code from a plain number', async () => {
    const doFetch = fakeFetch({ body: { sid: 'SM123' } });
    const sender = createTwilioSender({
      accountSid: 'AC123',
      authToken: 'secret',
      from: '+14155550000',
      brandName: 'Lyft Clone',
      fetch: doFetch,
    });

    await sender.send('+14155550100', '482913');

    const call = doFetch.calls[0]!;
    expect(call.url).toContain('/Accounts/AC123/Messages.json');
    expect(call.form.get('To')).toBe('+14155550100');
    expect(call.form.get('From')).toBe('+14155550000');
    expect(call.form.get('Body')).toBe(
      '482913 is your Lyft Clone verification code. Never share it.',
    );
    expect((call.init.headers as Record<string, string>).authorization).toMatch(/^Basic /);
  });

  it('uses a Messaging Service when given one', async () => {
    const doFetch = fakeFetch({ body: { sid: 'SM123' } });
    const sender = createTwilioSender({
      accountSid: 'AC123',
      authToken: 'secret',
      from: 'MG9999',
      fetch: doFetch,
    });

    await sender.send('+14155550100', '000000');

    expect(doFetch.calls[0]!.form.get('MessagingServiceSid')).toBe('MG9999');
    expect(doFetch.calls[0]!.form.get('From')).toBeNull();
  });

  it('throws with Twilio’s own reason when the send is rejected', async () => {
    const doFetch = fakeFetch({
      status: 400,
      body: { code: 21211, message: "The 'To' number is not a valid phone number." },
    });
    const sender = createTwilioSender({
      accountSid: 'AC123',
      authToken: 'secret',
      from: '+14155550000',
      fetch: doFetch,
    });

    await expect(sender.send('nonsense', '000000')).rejects.toThrow(/21211.*not a valid/);
  });

  it('refuses to be built without credentials', () => {
    expect(() =>
      createTwilioSender({ accountSid: '', authToken: '', from: '' }),
    ).toThrow(/accountSid/);
  });
});

describe('Expo push transport', () => {
  const message = {
    to: { kind: 'driver' as const, id: 'drv_1' as never },
    title: 'New ride · $11.70',
    body: '4 min away · Ferry Building',
    route: 'offer/ofr_1',
    urgent: true,
  };

  it('sends to every device a person has registered', async () => {
    const tokens = createMemoryRepositories().pushTokens;
    await tokens.register({ kind: 'driver', id: 'drv_1' as never }, 'ExponentPushToken[phone]', 0);
    await tokens.register({ kind: 'driver', id: 'drv_1' as never }, 'ExponentPushToken[tablet]', 0);

    const doFetch = fakeFetch({ body: { data: [{ status: 'ok' }, { status: 'ok' }] } });
    const transport = createExpoPushTransport({ tokens, fetch: doFetch });

    await transport.send(message);

    const sent = JSON.parse(String(doFetch.calls[0]!.init.body)) as Record<string, unknown>[];
    expect(sent).toHaveLength(2);
    expect(sent[0]!.title).toBe('New ride · $11.70');
    expect(sent[0]!.data).toMatchObject({ route: 'offer/ofr_1' });
  });

  it('marks an urgent message high priority with a short TTL', async () => {
    const tokens = createMemoryRepositories().pushTokens;
    await tokens.register({ kind: 'driver', id: 'drv_1' as never }, 'ExponentPushToken[x]', 0);
    const doFetch = fakeFetch({ body: { data: [{ status: 'ok' }] } });
    const transport = createExpoPushTransport({ tokens, fetch: doFetch });

    await transport.send(message);

    const [sent] = JSON.parse(String(doFetch.calls[0]!.init.body)) as Record<string, unknown>[];
    // An offer countdown is worthless if it arrives late.
    expect(sent!.priority).toBe('high');
    expect(sent!.ttl).toBe(60);
  });

  it('prunes a token whose app has been uninstalled', async () => {
    const tokens = createMemoryRepositories().pushTokens;
    await tokens.register({ kind: 'driver', id: 'drv_1' as never }, 'ExponentPushToken[gone]', 0);
    const doFetch = fakeFetch({
      body: { data: [{ status: 'error', details: { error: 'DeviceNotRegistered' } }] },
    });
    const transport = createExpoPushTransport({ tokens, fetch: doFetch });

    await transport.send(message);

    // Otherwise it is retried on every notification, forever.
    expect(await tokens.size()).toBe(0);
  });

  it('keeps a token that failed for a transient reason', async () => {
    const tokens = createMemoryRepositories().pushTokens;
    await tokens.register({ kind: 'driver', id: 'drv_1' as never }, 'ExponentPushToken[ok]', 0);
    const doFetch = fakeFetch({
      body: { data: [{ status: 'error', details: { error: 'MessageRateExceeded' } }] },
    });
    const transport = createExpoPushTransport({
      tokens,
      fetch: doFetch,
      logger: { error: () => {} },
    });

    await transport.send(message);
    expect(await tokens.size()).toBe(1);
  });

  it('does nothing when nobody has registered a device', async () => {
    const doFetch = fakeFetch({ body: { data: [] } });
    const transport = createExpoPushTransport({
      tokens: createMemoryRepositories().pushTokens,
      fetch: doFetch,
    });

    await transport.send(message);
    expect(doFetch.calls).toHaveLength(0);
  });
});
