/**
 * Driver ratings, payouts, and demand.
 *
 * The payout tests matter most: a balance that can be spent twice, or a fee
 * that makes cashing out your whole balance impossible, is somebody's wages.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  asUser,
  completeRide,
  createHarness,
  driverWithPendingOffer,
  bookStandardRide,
  signIn,
  type Harness,
} from './testing/harness.js';

let harness: Harness;

beforeEach(async () => {
  harness = await createHarness();
});

afterEach(async () => {
  await harness.close();
});

/** Drive a ride to completion and return the driver who took it. */
const rideWithDriver = async (riderPhone: string) => {
  const { token: riderToken } = await signIn(harness, riderPhone);
  const { rideId, driverToken, driverId } = await completeRide(harness, riderToken);
  return { riderToken, rideId, driverToken, driverId };
};

describe('the rating breakdown', () => {
  it('is empty for a driver nobody has rated', async () => {
    const { driverToken } = await rideWithDriver('+14155551600');

    const { breakdown, comments } = (
      await asUser(harness, driverToken).get('/v1/driver/ratings')
    ).json();

    expect(breakdown.count).toBe(0);
    expect(breakdown.average).toBe(0);
    expect(comments).toEqual([]);
  });

  it('counts stars, surfaces tags, and keeps the comments worth reading', async () => {
    const { riderToken, rideId, driverToken } = await rideWithDriver('+14155551601');

    await asUser(harness, riderToken).post(`/v1/rides/${rideId}/rate`, {
      stars: 5,
      tags: ['clean_car', 'safe_driving'],
      comment: 'Great route choice.',
    });

    const { breakdown, comments } = (
      await asUser(harness, driverToken).get('/v1/driver/ratings')
    ).json();

    expect(breakdown.count).toBe(1);
    expect(breakdown.average).toBe(5);
    expect(breakdown.distribution['5']).toBe(1);
    expect(breakdown.tags.map((t: { tag: string }) => t.tag)).toContain('clean_car');
    expect(comments[0].comment).toBe('Great route choice.');
  });

  it('flags a silent low rating as disputable', async () => {
    const { riderToken, rideId, driverToken } = await rideWithDriver('+14155551602');

    await asUser(harness, riderToken).post(`/v1/rides/${rideId}/rate`, { stars: 1, tags: [] });

    const { disputable } = (await asUser(harness, driverToken).get('/v1/driver/ratings')).json();
    expect(disputable).toEqual([rideId]);
  });

  it('is not readable by a rider', async () => {
    const { token } = await signIn(harness, '+14155551603');
    expect((await asUser(harness, token).get('/v1/driver/ratings')).statusCode).toBe(403);
  });
});

describe('the payout balance', () => {
  it('holds a just-finished trip as pending rather than available', async () => {
    const { driverToken } = await rideWithDriver('+14155551610');

    const { balance } = (await asUser(harness, driverToken).get('/v1/driver/payouts')).json();

    // The trip completed a moment ago, so its earnings have not settled.
    expect(balance.pending.amount).toBeGreaterThan(0);
    expect(balance.available.amount).toBe(0);
    expect(balance.nextScheduledAt).toBeGreaterThan(harness.clock.now());
  });

  it('moves earnings into the balance once they settle', async () => {
    const { driverToken } = await rideWithDriver('+14155551611');
    await harness.advance(25 * 60 * 60_000);

    const { balance } = (await asUser(harness, driverToken).get('/v1/driver/payouts')).json();
    expect(balance.available.amount).toBeGreaterThan(0);
    expect(balance.pending.amount).toBe(0);
  });
});

describe('cashing out', () => {
  /** A driver with a settled balance and somewhere to send it. */
  const readyDriver = async (phone: string) => {
    const { driverToken } = await rideWithDriver(phone);
    await harness.advance(25 * 60 * 60_000);
    await asUser(harness, driverToken).post('/v1/driver/payouts/destinations', {
      label: 'Chase ••••4321',
    });
    const { balance } = (await asUser(harness, driverToken).get('/v1/driver/payouts')).json();
    return { driverToken, available: balance.available.amount as number };
  };

  it('refuses before a destination exists', async () => {
    const { driverToken } = await rideWithDriver('+14155551620');
    await harness.advance(25 * 60 * 60_000);

    const response = await asUser(harness, driverToken).post('/v1/driver/payouts/quote', {
      amount: 500,
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().error.userMessage).toMatch(/bank account/i);
  });

  it('takes the fee out of the amount and reduces the balance by both', async () => {
    const { driverToken, available } = await readyDriver('+14155551621');
    const driver = asUser(harness, driverToken);

    const { quote } = (
      await driver.post('/v1/driver/payouts/quote', { amount: available })
    ).json();
    expect(quote.net.amount).toBe(available - quote.fee.amount);

    const { payout } = (
      await driver.post('/v1/driver/payouts/cashout', { amount: available })
    ).json();
    expect(payout.amount.amount).toBe(quote.net.amount);
    expect(payout.status).toBe('pending');
    expect(payout.destinationLabel).toBe('Chase ••••4321');

    // The whole balance is gone: the payout and its fee both came out of it.
    const { balance } = (await driver.get('/v1/driver/payouts')).json();
    expect(balance.available.amount).toBe(0);
  });

  it('will not pay the same money twice', async () => {
    const { driverToken, available } = await readyDriver('+14155551622');
    const driver = asUser(harness, driverToken);

    await driver.post('/v1/driver/payouts/cashout', { amount: available });
    const second = await driver.post('/v1/driver/payouts/cashout', { amount: available });

    expect(second.statusCode).toBe(422);
    expect(second.json().error.userMessage).toMatch(/available balance/i);
  });

  it('refuses an amount below the minimum', async () => {
    const { driverToken } = await readyDriver('+14155551623');

    const response = await asUser(harness, driverToken).post('/v1/driver/payouts/cashout', {
      amount: 100,
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().error.userMessage).toMatch(/start at/i);
  });

  it('keeps the gateway token off the wire', async () => {
    const { driverToken } = await rideWithDriver('+14155551624');
    const driver = asUser(harness, driverToken);

    await driver.post('/v1/driver/payouts/destinations', {
      label: 'Chase ••••4321',
      gatewayToken: 'ba_secret_token',
    });

    const body = (await driver.get('/v1/driver/payouts')).body;
    expect(body).toContain('Chase');
    expect(body).not.toContain('ba_secret_token');
  });
});

describe('the demand map', () => {
  it('answers a driver with whatever the surge provider can produce', async () => {
    const { driverToken } = await rideWithDriver('+14155551630');

    const response = await asUser(harness, driverToken).get(
      '/v1/driver/demand?south=37.7&west=-122.5&north=37.83&east=-122.35',
    );

    expect(response.statusCode).toBe(200);
    expect(response.json()).toHaveProperty('cells');
    expect(response.json()).toHaveProperty('provider');
  });

  it('is closed to a rider', async () => {
    const { token } = await signIn(harness, '+14155551631');
    const response = await asUser(harness, token).get(
      '/v1/driver/demand?south=37.7&west=-122.5&north=37.83&east=-122.35',
    );
    expect(response.statusCode).toBe(403);
  });
});
