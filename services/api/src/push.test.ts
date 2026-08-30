/**
 * Push notification delivery.
 *
 * The backend has known how to send since the notification service existed;
 * what these check is the part that was missing — that a device can register,
 * that a message reaches it, and that registering does not leak a token
 * between two people who share a phone.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { asUser, bookStandardRide, createHarness, signIn, type Harness } from './testing/harness.js';

let harness: Harness;

beforeEach(async () => {
  harness = await createHarness();
});

afterEach(async () => {
  await harness.close();
});

describe('registering a device', () => {
  it('accepts a token and files it against the signed-in role', async () => {
    const { token, riderId } = await signIn(harness, '+14155551700');

    const response = await asUser(harness, token).post('/v1/auth/device', {
      token: 'ExponentPushToken[rider-phone]',
    });

    expect(response.json()).toEqual({ ok: true });
    expect(
      await harness.container.pushTokens.tokensFor({
        kind: 'rider',
        id: riderId as never,
      }),
    ).toEqual(['ExponentPushToken[rider-phone]']);
  });

  it('keeps a rider and a driver on one phone apart', async () => {
    const phone = '+14155551701';
    const rider = await signIn(harness, phone, 'rider');
    const driver = await signIn(harness, phone, 'driver');

    await asUser(harness, rider.token).post('/v1/auth/device', {
      token: 'ExponentPushToken[shared-phone]',
    });
    await asUser(harness, driver.token).post('/v1/auth/device', {
      token: 'ExponentPushToken[shared-phone]',
    });

    // The same physical device, filed under both roles — so a ride offer
    // reaches it as a driver and an arrival reaches it as a rider.
    expect(
      await harness.container.pushTokens.tokensFor({ kind: 'rider', id: rider.riderId as never }),
    ).toEqual(['ExponentPushToken[shared-phone]']);
    expect(
      await harness.container.pushTokens.tokensFor({
        kind: 'driver',
        id: driver.driverId as never,
      }),
    ).toEqual(['ExponentPushToken[shared-phone]']);
  });

  it('records every device a person signs in on', async () => {
    const { token, riderId } = await signIn(harness, '+14155551702');
    const rider = asUser(harness, token);

    await rider.post('/v1/auth/device', { token: 'ExponentPushToken[phone]' });
    await rider.post('/v1/auth/device', { token: 'ExponentPushToken[tablet]' });
    // A repeat of one already registered must not duplicate it.
    await rider.post('/v1/auth/device', { token: 'ExponentPushToken[phone]' });

    expect(
      await harness.container.pushTokens.tokensFor({ kind: 'rider', id: riderId as never }),
    ).toEqual(['ExponentPushToken[phone]', 'ExponentPushToken[tablet]']);
  });

  it('refuses an anonymous caller', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/device',
      payload: { token: 'ExponentPushToken[nobody]' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('rejects something that is not a token', async () => {
    const { token } = await signIn(harness, '+14155551703');
    expect((await asUser(harness, token).post('/v1/auth/device', { token: 'x' })).statusCode).toBe(
      422,
    );
  });
});

describe('what actually gets sent', () => {
  it('tells a driver about an offer, urgently, with a route to open', async () => {
    const { token } = await signIn(harness, '+14155551710');
    await bookStandardRide(harness, token);

    const offers = harness.push.sent.filter((m) => m.to.kind === 'driver');
    expect(offers.length).toBeGreaterThan(0);
    const offer = offers[0]!;
    // An offer countdown is already running when the notification lands.
    expect(offer.urgent).toBe(true);
    expect(offer.route).toBeTruthy();
    expect(offer.title.length).toBeGreaterThan(0);
  });

  it('tells the rider when a driver is on the way', async () => {
    const { token } = await signIn(harness, '+14155551711');
    const { rideId } = await bookStandardRide(harness, token);

    const before = harness.push.sent.length;
    const { token: driverToken, offerId } = await (
      await import('./testing/harness.js')
    ).driverWithPendingOffer(harness, rideId);
    await asUser(harness, driverToken).post(`/v1/driver/offers/${offerId}/accept`);

    const toRider = harness.push.sent.slice(before).filter((m) => m.to.kind === 'rider');
    expect(toRider.length).toBeGreaterThan(0);
    expect(toRider.some((m) => m.route?.includes(rideId))).toBe(true);
  });
});
