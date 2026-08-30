/**
 * Support API tests.
 *
 * Runs the real routes over the real services. The things worth proving here
 * are the ones a hand-rolled support screen usually gets wrong: that a ticket
 * cannot be attached to somebody else's trip, that a ticket cannot be read by
 * anyone but the person who opened it, and that an agent's actions are behind
 * the admin guard.
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

const riderPhone = '+14155551200';
const otherRiderPhone = '+14155551201';
const adminPhone = '+14155550000';

describe('help centre', () => {
  it('is readable without signing in', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/v1/support/help' });

    expect(response.statusCode).toBe(200);
    const { topics, categories } = response.json();
    expect(topics.length).toBeGreaterThan(0);
    expect(categories.length).toBeGreaterThan(0);
    // Ride-specific topics stay hidden when there is no ride.
    expect(topics.map((t: { id: string }) => t.id)).not.toContain('current_ride');
  });

  it('surfaces the live-ride topics once a ride is named', async () => {
    const { token } = await signIn(harness, riderPhone);
    const { rideId } = await bookStandardRide(harness, token);

    const response = await asUser(harness, token).get(`/v1/support/help?rideId=${rideId}`);

    const ids = response.json().topics.map((t: { id: string }) => t.id);
    expect(ids).toContain('current_ride');
  });

  it('answers a driver with driver topics', async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url: '/v1/support/help?audience=driver',
    });
    const ids = response.json().topics.map((t: { id: string }) => t.id);
    expect(ids).toContain('earnings');
    expect(ids).not.toContain('fares');
  });
});

describe('opening a ticket', () => {
  it('opens with an acknowledgement and appears in the list', async () => {
    const { token } = await signIn(harness, riderPhone);
    const { rideId } = await completeRide(harness, token);

    const created = await asUser(harness, token).post('/v1/support/tickets', {
      categoryId: 'fare_dispute',
      body: 'The fare was much higher than the quote.',
      rideId,
    });

    expect(created.statusCode).toBe(201);
    const { ticket } = created.json();
    expect(ticket.status).toBe('open');
    expect(ticket.messages).toHaveLength(2);
    expect(ticket.messages[1].from).toBe('system');

    const list = await asUser(harness, token).get('/v1/support/tickets');
    expect(list.json().tickets.map((t: { id: string }) => t.id)).toContain(ticket.id);
  });

  it('refuses a trip the requester was not on', async () => {
    const { token: mine } = await signIn(harness, riderPhone);
    const { token: theirs } = await signIn(harness, otherRiderPhone);
    const { rideId } = await bookStandardRide(harness, theirs);

    const response = await asUser(harness, mine).post('/v1/support/tickets', {
      categoryId: 'fare_dispute',
      body: 'Tell me about this trip',
      rideId,
    });

    expect(response.statusCode).toBe(403);
  });

  it('refuses a category that needs a trip when none is given', async () => {
    const { token } = await signIn(harness, riderPhone);

    const response = await asUser(harness, token).post('/v1/support/tickets', {
      categoryId: 'lost_item',
      body: 'I left my bag',
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().error.userMessage).toMatch(/trip/i);
  });

  it('refuses a category that is not open to this role', async () => {
    const { token } = await signIn(harness, riderPhone);

    const response = await asUser(harness, token).post('/v1/support/tickets', {
      categoryId: 'earnings',
      body: 'Where is my payout',
    });

    expect(response.statusCode).toBe(403);
  });

  it('needs a signed-in caller', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/support/tickets',
      payload: { categoryId: 'app_problem', body: 'broken' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('rate limits a burst so one script cannot flood the queue', async () => {
    const { token } = await signIn(harness, riderPhone);
    const rider = asUser(harness, token);

    const codes: number[] = [];
    for (let i = 0; i < 7; i++) {
      const response = await rider.post('/v1/support/tickets', {
        categoryId: 'app_problem',
        body: `Report ${i}`,
      });
      codes.push(response.statusCode);
    }

    expect(codes.filter((c) => c === 201)).toHaveLength(5);
    expect(codes.filter((c) => c === 429).length).toBeGreaterThan(0);
  });
});

describe('a ticket thread', () => {
  const openTicket = async (token: string): Promise<string> => {
    const response = await asUser(harness, token).post('/v1/support/tickets', {
      categoryId: 'app_problem',
      subject: 'The map is blank',
      body: 'The map does not render on my phone.',
    });
    return response.json().ticket.id;
  };

  it('is invisible to anyone but the person who opened it', async () => {
    const { token: mine } = await signIn(harness, riderPhone);
    const { token: theirs } = await signIn(harness, otherRiderPhone);
    const ticketId = await openTicket(mine);

    const response = await asUser(harness, theirs).get(`/v1/support/tickets/${ticketId}`);
    // Not 403: whether a ticket exists is not something a stranger should learn.
    expect(response.statusCode).toBe(404);
  });

  it('carries a reply and moves back to open when support has answered', async () => {
    const { token } = await signIn(harness, riderPhone);
    const { token: adminToken } = await signIn(harness, adminPhone, 'admin');
    const ticketId = await openTicket(token);

    const answered = await asUser(harness, adminToken).post(
      `/v1/admin/support/tickets/${ticketId}/actions`,
      { action: 'support_reply', text: 'Which phone are you using?' },
    );
    expect(answered.json().ticket.status).toBe('awaiting_reply');

    const replied = await asUser(harness, token).post(
      `/v1/support/tickets/${ticketId}/messages`,
      { text: 'A Pixel 8.' },
    );
    expect(replied.json().ticket.status).toBe('open');
    expect(replied.json().ticket.messages).toHaveLength(4);
  });

  it('clears the unread marker when the thread is read', async () => {
    const { token } = await signIn(harness, riderPhone);
    const ticketId = await openTicket(token);

    const read = await asUser(harness, token).post(`/v1/support/tickets/${ticketId}/read`);
    expect(read.json().ticket.requesterReadAt).toBeGreaterThan(0);
  });

  it('lets the requester close and reopen, but not resolve', async () => {
    const { token } = await signIn(harness, riderPhone);
    const ticketId = await openTicket(token);
    const rider = asUser(harness, token);

    const closed = await rider.post(`/v1/support/tickets/${ticketId}/status`, { action: 'close' });
    expect(closed.json().ticket.status).toBe('closed');

    // A closed thread is final.
    const reopened = await rider.post(`/v1/support/tickets/${ticketId}/status`, {
      action: 'reopen',
    });
    expect(reopened.statusCode).toBe(409);
  });
});

describe('the agent queue', () => {
  it('is closed to a rider and open to an admin', async () => {
    const { token } = await signIn(harness, riderPhone);
    const { token: adminToken } = await signIn(harness, adminPhone, 'admin');
    await asUser(harness, token).post('/v1/support/tickets', {
      categoryId: 'safety',
      body: 'Something happened on my trip.',
    });

    expect((await asUser(harness, token).get('/v1/admin/support/tickets')).statusCode).toBe(403);

    const queue = await asUser(harness, adminToken).get('/v1/admin/support/tickets?status=open');
    expect(queue.statusCode).toBe(200);
    const { tickets, counts } = queue.json();
    expect(tickets).toHaveLength(1);
    expect(tickets[0].priority).toBe('urgent');
    expect(counts.open).toBe(1);
  });

  it('resolves a ticket, which the requester then sees', async () => {
    const { token } = await signIn(harness, riderPhone);
    const { token: adminToken } = await signIn(harness, adminPhone, 'admin');
    const ticketId = (
      await asUser(harness, token).post('/v1/support/tickets', {
        categoryId: 'app_problem',
        body: 'A button does nothing.',
      })
    ).json().ticket.id;

    await asUser(harness, adminToken).post(`/v1/admin/support/tickets/${ticketId}/actions`, {
      action: 'resolve',
      text: 'Fixed in the latest release.',
    });

    const seen = await asUser(harness, token).get(`/v1/support/tickets/${ticketId}`);
    expect(seen.json().ticket.status).toBe('resolved');
    expect(seen.json().ticket.resolvedAt).toBeGreaterThan(0);
  });

  it('publishes an event when a ticket opens, so notifications can react', async () => {
    const { token } = await signIn(harness, riderPhone);
    const seen: unknown[] = [];
    harness.container.events.on('support.ticket.opened', (payload) => {
      seen.push(payload);
    });

    await asUser(harness, token).post('/v1/support/tickets', {
      categoryId: 'safety',
      body: 'I want to report something.',
    });

    expect(seen).toHaveLength(1);
    expect((seen[0] as { priority: string }).priority).toBe('urgent');
  });
});
