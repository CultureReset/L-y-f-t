/**
 * Promo code API tests.
 *
 * The behaviour that matters at this layer is the split between checking and
 * redeeming: a rider must be able to check a limited-use code as often as they
 * like without spending it, and booking must spend it exactly once.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  asUser,
  bookStandardRide,
  completeRide,
  createHarness,
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

const phone = '+14155551300';

describe('checking a code', () => {
  it('accepts a real code and does not consume it', async () => {
    const { token } = await signIn(harness, phone);
    const rider = asUser(harness, token);

    for (let i = 0; i < 3; i++) {
      const response = await rider.post('/v1/rider/promos/check', { code: 'welcome50' });
      expect(response.statusCode).toBe(200);
      expect(response.json().promo.code).toBe('WELCOME50');
    }

    // WELCOME50 is a one-per-rider code; three checks must not have spent it.
    const wallet = await rider.get('/v1/rider/promos');
    expect(wallet.json().promos.map((p: { promo: { code: string } }) => p.promo.code)).toContain(
      'WELCOME50',
    );
  });

  it('explains why a code was refused rather than just saying no', async () => {
    const { token } = await signIn(harness, phone);

    const response = await asUser(harness, token).post('/v1/rider/promos/check', {
      code: 'NOPE',
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().error.userMessage).toMatch(/not one we recognise/i);
  });

  it('withholds a first-ride code from someone who has already ridden', async () => {
    const { token } = await signIn(harness, phone);
    await completeRide(harness, token);

    const response = await asUser(harness, token).post('/v1/rider/promos/check', {
      code: 'WELCOME50',
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().error.userMessage).toMatch(/first ride/i);
  });
});

describe('quoting with a code', () => {
  it('discounts the fare and names the promo on the fare breakdown', async () => {
    const { token } = await signIn(harness, phone);
    const rider = asUser(harness, token);

    const plain = await rider.post('/v1/rides/quote', {
      pickup: { ...FERRY },
      dropoff: { ...DOLORES },
    });
    const discounted = await rider.post('/v1/rides/quote', {
      pickup: { ...FERRY },
      dropoff: { ...DOLORES },
      promoCode: 'WELCOME50',
    });

    expect(discounted.json().promo.code).toBe('WELCOME50');
    const before = plain.json().quotes[0].fare.total.amount;
    const after = discounted.json().quotes[0].fare.total.amount;
    expect(after).toBeLessThan(before);

    const line = discounted
      .json()
      .quotes[0].fare.items.find((l: { code: string }) => l.code === 'promo_WELCOME50');
    expect(line).toBeDefined();
    // A discount is a negative line, and the total is still the sum of lines.
    expect(line.amount.amount).toBeLessThan(0);
  });

  it('prices without the discount and says why when a code does not apply', async () => {
    const { token } = await signIn(harness, phone);

    const response = await asUser(harness, token).post('/v1/rides/quote', {
      pickup: { ...FERRY },
      dropoff: { ...DOLORES },
      promoCode: 'GARBAGE',
    });

    // The quote itself still succeeds — a bad code should not block booking.
    expect(response.statusCode).toBe(200);
    expect(response.json().promo).toBeUndefined();
    expect(response.json().promoError).toMatch(/not one we recognise/i);
    expect(response.json().quotes.length).toBeGreaterThan(0);
  });
});

describe('booking with a code', () => {
  it('records the redemption once, and only after the ride exists', async () => {
    const { token, riderId } = await signIn(harness, phone);

    await bookStandardRide(harness, token, { promoCode: 'WELCOME50' });

    const redemptions = await harness.container.repositories.promos.listForRider(
      riderId as never,
    );
    expect(redemptions).toHaveLength(1);
    expect(redemptions[0]!.code).toBe('WELCOME50');
    expect(redemptions[0]!.rideId).toBeDefined();
  });

  it('refuses a second use of a one-per-rider code', async () => {
    const { token } = await signIn(harness, phone);
    await completeRide(harness, token);

    const response = await asUser(harness, token).post('/v1/rides', {
      rideTypeId: 'standard',
      pickup: { ...FERRY },
      dropoff: { ...DOLORES },
      passengerCount: 1,
      promoCode: 'WELCOME50',
    });

    expect(response.statusCode).toBe(422);
  });

  it('stamps the code on the ride so a receipt can show it', async () => {
    const { token } = await signIn(harness, phone);
    const { body } = await bookStandardRide(harness, token, { promoCode: 'WELCOME50' });

    expect(body.ride.metadata).toMatchObject({ promoCode: 'WELCOME50' });
  });
});

describe('the promo wallet', () => {
  it('lists only codes this rider can still use', async () => {
    const { token } = await signIn(harness, phone);

    const before = (await asUser(harness, token).get('/v1/rider/promos')).json().promos;
    expect(before.map((p: { promo: { code: string } }) => p.promo.code)).toContain('WELCOME50');

    await completeRide(harness, token);

    const after = (await asUser(harness, token).get('/v1/rider/promos')).json().promos;
    // A completed ride disqualifies the first-ride code but not the others.
    expect(after.map((p: { promo: { code: string } }) => p.promo.code)).not.toContain(
      'WELCOME50',
    );
    expect(after.map((p: { promo: { code: string } }) => p.promo.code)).toContain('RIDE5');
  });

  it('is empty when the market has promo codes turned off', async () => {
    await harness.close();
    harness = await createHarness({ config: { features: { promoCodes: false } } });
    const { token } = await signIn(harness, phone);

    expect((await asUser(harness, token).get('/v1/rider/promos')).json().promos).toEqual([]);
    expect(
      (await asUser(harness, token).post('/v1/rider/promos/check', { code: 'WELCOME50' }))
        .statusCode,
    ).toBe(422);
  });
});

const FERRY = {
  id: 'plc_ferry',
  name: 'Ferry Building',
  address: '1 Ferry Building, San Francisco, CA 94111',
  coordinates: { lat: 37.7955, lng: -122.3937 },
  category: 'venue' as const,
  source: 'seed' as const,
};

const DOLORES = {
  id: 'plc_dolores',
  name: 'Mission Dolores Park',
  address: 'Dolores St & 19th St, San Francisco, CA 94114',
  coordinates: { lat: 37.7596, lng: -122.4269 },
  category: 'venue' as const,
  source: 'seed' as const,
};
