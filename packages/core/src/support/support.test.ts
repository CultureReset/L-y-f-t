/**
 * Support domain tests.
 *
 * The help centre's contract is that it never shows someone an article they
 * cannot act on; the ticket machine's is that a transition is legal or it is
 * refused, with the same table deciding for everyone.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { resetIdGenerator, sequentialIdGenerator, setIdGenerator, type RideId, type UserId } from '../util/ids.js';
import {
  defaultHelpCenter,
  findArticle,
  findTopic,
  mergeHelpCenter,
  resolveTopics,
  type HelpCenter,
} from './helpCenter.js';
import {
  applyTicketAction,
  categoriesFor,
  defaultTicketCatalog,
  findCategory,
  mergeTicketCatalog,
  openTicket,
  unreadForRequester,
  type SupportTicket,
} from './tickets.js';

const T0 = 1_700_000_000_000;
const requesterId = 'usr_1' as UserId;

beforeEach(() => {
  setIdGenerator(sequentialIdGenerator());
  return () => resetIdGenerator();
});

describe('help centre', () => {
  const center = defaultHelpCenter();

  it('hides ride-specific topics when there is no ride', () => {
    const withoutRide = resolveTopics(center, { audience: 'rider' });
    const withRide = resolveTopics(center, { audience: 'rider', rideStatus: 'in_progress' });

    expect(withoutRide.map((t) => t.id)).not.toContain('current_ride');
    expect(withRide.map((t) => t.id)).toContain('current_ride');
  });

  it('never shows a rider a driver topic, or the reverse', () => {
    const riderTopics = resolveTopics(center, { audience: 'rider' }).map((t) => t.id);
    const driverTopics = resolveTopics(center, { audience: 'driver' }).map((t) => t.id);

    expect(riderTopics).not.toContain('earnings');
    expect(driverTopics).not.toContain('fares');
    // A shared topic reaches both.
    expect(riderTopics).toContain('account');
    expect(driverTopics).toContain('account');
  });

  it('finds a topic and an article by id', () => {
    expect(findTopic(center, 'fares')?.title).toBe('Fares and charges');
    expect(findArticle(center, 'fares', 'cancel_fee')?.title).toMatch(/cancellation fee/i);
    expect(findArticle(center, 'fares', 'nope')).toBeUndefined();
  });

  it('every ticket action names a category that exists', () => {
    const catalog = defaultTicketCatalog();
    const actions = center.topics
      .flatMap((t) => t.articles)
      .flatMap((a) => a.actions ?? [])
      .filter((a) => a.kind === 'open_ticket');

    expect(actions.length).toBeGreaterThan(0);
    for (const action of actions) {
      expect(findCategory(catalog, action.category), action.category).toBeDefined();
    }
  });

  it('an override replaces a topic by id and appends a new one', () => {
    const overrides: HelpCenter = {
      topics: [
        { ...findTopic(center, 'fares')!, title: 'Tarifs' },
        {
          id: 'airport',
          title: 'Airport pickups',
          summary: 'Where to meet your driver.',
          icon: '✈️',
          audience: 'rider',
          articles: [],
        },
      ],
    };
    const merged = mergeHelpCenter(center, overrides);

    expect(findTopic(merged, 'fares')?.title).toBe('Tarifs');
    expect(findTopic(merged, 'airport')).toBeDefined();
    expect(merged.topics).toHaveLength(center.topics.length + 1);
  });
});

describe('ticket catalog', () => {
  const catalog = defaultTicketCatalog();

  it('offers a rider only what a rider can raise', () => {
    const ids = categoriesFor(catalog, 'rider').map((c) => c.id);
    expect(ids).toContain('fare_dispute');
    expect(ids).not.toContain('earnings');
    expect(ids).not.toContain('rider_conduct');
  });

  it('merges an operator override in place', () => {
    const merged = mergeTicketCatalog(catalog, {
      categories: [
        {
          id: 'cleanliness',
          label: 'Vehicle cleanliness',
          description: 'The car was not clean.',
          audience: 'rider',
          requiresRide: true,
          priority: 'normal',
          acknowledgement: 'Thanks — we will look into it.',
        },
      ],
    });
    expect(findCategory(merged, 'cleanliness')).toBeDefined();
    expect(findCategory(merged, 'fare_dispute')).toBeDefined();
  });
});

describe('opening a ticket', () => {
  const catalog = defaultTicketCatalog();
  const fareDispute = findCategory(catalog, 'fare_dispute')!;
  const appProblem = findCategory(catalog, 'app_problem')!;

  it('acknowledges immediately so nobody wonders whether it sent', () => {
    const result = openTicket({
      requesterId,
      requesterRole: 'rider',
      category: fareDispute,
      subject: '',
      body: 'I was charged twice',
      rideId: 'rid_1' as RideId,
      now: T0,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('open');
    expect(result.value.priority).toBe('normal');
    // Falls back to the category label rather than shipping an empty subject.
    expect(result.value.subject).toBe('A charge or fare');
    expect(result.value.messages).toHaveLength(2);
    expect(result.value.messages[1]!.from).toBe('system');
    expect(result.value.messages[1]!.text).toBe(fareDispute.acknowledgement);
  });

  it('refuses a category that needs a trip without one', () => {
    const result = openTicket({
      requesterId,
      requesterRole: 'rider',
      category: fareDispute,
      subject: 'x',
      body: 'x',
      now: T0,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/must name a trip/);
  });

  it('refuses an empty body', () => {
    const result = openTicket({
      requesterId,
      requesterRole: 'rider',
      category: appProblem,
      subject: 'x',
      body: '   ',
      now: T0,
    });
    expect(result.ok).toBe(false);
  });

  it('takes a safety report at urgent priority', () => {
    const safety = findCategory(catalog, 'safety')!;
    const result = openTicket({
      requesterId,
      requesterRole: 'rider',
      category: safety,
      subject: '',
      body: 'The driver took a route I did not recognise',
      now: T0,
    });
    expect(result.ok && result.value.priority).toBe('urgent');
  });
});

describe('the ticket state machine', () => {
  const catalog = defaultTicketCatalog();
  const open = (): SupportTicket => {
    const result = openTicket({
      requesterId,
      requesterRole: 'rider',
      category: findCategory(catalog, 'app_problem')!,
      subject: 'Map is blank',
      body: 'The map does not render',
      now: T0,
    });
    if (!result.ok) throw new Error(result.error);
    return result.value;
  };

  it('moves to awaiting_reply when support answers, and back on a reply', () => {
    const ticket = open();
    const answered = applyTicketAction(ticket, {
      action: 'support_reply',
      by: 'support',
      text: 'Which device are you on?',
      now: T0 + 1000,
    });
    expect(answered.ok && answered.value.status).toBe('awaiting_reply');
    if (!answered.ok) return;

    const replied = applyTicketAction(answered.value, {
      action: 'requester_reply',
      by: 'requester',
      text: 'A Pixel 8',
      now: T0 + 2000,
    });
    expect(replied.ok && replied.value.status).toBe('open');
    expect(replied.ok && replied.value.messages).toHaveLength(4);
  });

  it('refuses an action the actor is not allowed to take', () => {
    const result = applyTicketAction(open(), {
      action: 'resolve',
      by: 'requester',
      now: T0 + 1000,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/cannot resolve/);
  });

  it('refuses an empty reply', () => {
    const result = applyTicketAction(open(), {
      action: 'requester_reply',
      by: 'requester',
      text: '  ',
      now: T0 + 1000,
    });
    expect(result.ok).toBe(false);
  });

  it('stamps resolvedAt, and a reply reopens rather than being lost', () => {
    const ticket = open();
    const resolved = applyTicketAction(ticket, { action: 'resolve', by: 'support', now: T0 + 1000 });
    expect(resolved.ok && resolved.value.resolvedAt).toBe(T0 + 1000);
    if (!resolved.ok) return;

    const reopened = applyTicketAction(resolved.value, {
      action: 'requester_reply',
      by: 'requester',
      text: 'It is happening again',
      now: T0 + 5000,
    });
    expect(reopened.ok && reopened.value.status).toBe('open');
  });

  it('treats a closed ticket as final', () => {
    const ticket = open();
    const closed = applyTicketAction(ticket, { action: 'close', by: 'requester', now: T0 + 1000 });
    expect(closed.ok).toBe(true);
    if (!closed.ok) return;

    for (const action of ['requester_reply', 'support_reply', 'resolve', 'reopen'] as const) {
      const result = applyTicketAction(closed.value, {
        action,
        by: action === 'support_reply' || action === 'resolve' ? 'support' : 'requester',
        text: 'still broken',
        now: T0 + 2000,
      });
      expect(result.ok, action).toBe(false);
    }
  });

  it('never mutates the ticket it was given', () => {
    const ticket = open();
    const before = JSON.stringify(ticket);
    applyTicketAction(ticket, { action: 'close', by: 'requester', now: T0 + 1000 });
    expect(JSON.stringify(ticket)).toBe(before);
  });

  it('counts only what the requester has not read', () => {
    const ticket = open();
    // The acknowledgement is unread until they open the thread.
    expect(unreadForRequester(ticket)).toBe(1);
    expect(unreadForRequester({ ...ticket, requesterReadAt: T0 })).toBe(0);

    const answered = applyTicketAction(ticket, {
      action: 'support_reply',
      by: 'support',
      text: 'Try updating the app',
      now: T0 + 3000,
    });
    expect(answered.ok).toBe(true);
    if (!answered.ok) return;
    expect(unreadForRequester({ ...answered.value, requesterReadAt: T0 + 1000 })).toBe(1);
  });
});
