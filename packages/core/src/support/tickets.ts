/**
 * Support tickets.
 *
 * The same shape as the rest of the domain: an entity, a transition table that
 * is the single authority on what may happen next, and pure functions that
 * return a new ticket rather than mutating one. No I/O, no clock — the caller
 * passes `now`.
 *
 * Categories are a catalog, not an enum, for the same reason ride types are: a
 * market that wants a "vehicle cleanliness" queue should be able to add one
 * without touching this file.
 */

import { newMessageId, newTicketId, type MessageId, type RideId, type TicketId, type UserId } from '../util/ids.js';
import { err, ok, type Result } from '../util/result.js';

export type TicketStatus =
  /** Waiting on support. */
  | 'open'
  /** Support has replied and is waiting on the person who opened it. */
  | 'awaiting_reply'
  | 'resolved'
  | 'closed';

export type TicketPriority = 'low' | 'normal' | 'high' | 'urgent';

export type TicketAuthor = 'requester' | 'support' | 'system';

export interface TicketMessage {
  readonly id: MessageId;
  readonly from: TicketAuthor;
  /** The support agent or requester who wrote it; absent for system notes. */
  readonly authorId?: UserId;
  readonly text: string;
  readonly sentAt: number;
}

export interface SupportTicket {
  readonly id: TicketId;
  readonly requesterId: UserId;
  readonly requesterRole: 'rider' | 'driver';
  readonly category: string;
  readonly subject: string;
  readonly status: TicketStatus;
  readonly priority: TicketPriority;
  /** The trip this is about, when there is one. */
  readonly rideId?: RideId;
  readonly messages: readonly TicketMessage[];
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly resolvedAt?: number;
  /** Set when the requester has read everything support has written. */
  readonly requesterReadAt?: number;
}

// ------------------------------------------------------------------ catalog

export interface TicketCategory {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly audience: 'rider' | 'driver' | 'both';
  /** The ticket cannot be opened without naming a trip. */
  readonly requiresRide?: boolean;
  readonly priority: TicketPriority;
  /**
   * Posted by the system the moment the ticket opens, so nobody is left
   * staring at an empty thread wondering whether it sent.
   */
  readonly acknowledgement: string;
}

export interface TicketCatalog {
  readonly categories: readonly TicketCategory[];
}

export const findCategory = (
  catalog: TicketCatalog,
  id: string,
): TicketCategory | undefined => catalog.categories.find((category) => category.id === id);

/** Categories this person is allowed to open, in catalog order. */
export const categoriesFor = (
  catalog: TicketCatalog,
  audience: 'rider' | 'driver',
): TicketCategory[] =>
  catalog.categories.filter((c) => c.audience === 'both' || c.audience === audience);

/** Merge operator overrides into the shipped catalog, matching on id. */
export const mergeTicketCatalog = (
  base: TicketCatalog,
  overrides: TicketCatalog,
): TicketCatalog => {
  const byId = new Map(base.categories.map((c) => [c.id, c]));
  for (const category of overrides.categories) byId.set(category.id, category);
  return { categories: [...byId.values()] };
};

export const defaultTicketCatalog = (): TicketCatalog => ({
  categories: [
    {
      id: 'safety',
      label: 'Safety',
      description: 'Something on a trip made you feel unsafe.',
      audience: 'both',
      priority: 'urgent',
      acknowledgement:
        'This is with our safety team now and is being looked at ahead of everything else. If you are in immediate danger, call emergency services first.',
    },
    {
      id: 'fare_dispute',
      label: 'A charge or fare',
      description: 'A fare, a fee, or a charge you do not recognise.',
      audience: 'rider',
      requiresRide: true,
      priority: 'normal',
      acknowledgement:
        'We have your trip’s full fare breakdown and will come back to you with what each line was for, usually within a day.',
    },
    {
      id: 'lost_item',
      label: 'A lost item',
      description: 'You left something in the car.',
      audience: 'rider',
      requiresRide: true,
      priority: 'high',
      acknowledgement:
        'Your driver is being contacted now. Most items are returned the same day — keep your phone to hand.',
    },
    {
      id: 'driver_conduct',
      label: 'Your driver',
      description: 'How your driver behaved on a trip.',
      audience: 'rider',
      requiresRide: true,
      priority: 'high',
      acknowledgement:
        'Thank you for telling us. This is reviewed by a person, and you will not be matched with this driver again while it is open.',
    },
    {
      id: 'rider_conduct',
      label: 'Your rider',
      description: 'How a rider behaved on a trip.',
      audience: 'driver',
      requiresRide: true,
      priority: 'high',
      acknowledgement:
        'Thank you for telling us. This is reviewed by a person, and you will not be matched with this rider again while it is open.',
    },
    {
      id: 'earnings',
      label: 'Earnings',
      description: 'A trip’s pay, a bonus, or a payout.',
      audience: 'driver',
      priority: 'normal',
      acknowledgement:
        'We are pulling the breakdown for that trip and will come back to you with how the pay was made up.',
    },
    {
      id: 'account',
      label: 'Your account',
      description: 'Your details, documents, or closing your account.',
      audience: 'both',
      priority: 'low',
      acknowledgement:
        'We have your request. Anything that changes how you sign in is verified before it takes effect.',
    },
    {
      id: 'app_problem',
      label: 'The app',
      description: 'Something in the app is broken.',
      audience: 'both',
      priority: 'low',
      acknowledgement:
        'Thanks — this goes to the team with your app version and device attached, so there is nothing else you need to send.',
    },
  ],
});

// ---------------------------------------------------------- state machine

export type TicketAction =
  | 'requester_reply'
  | 'support_reply'
  | 'resolve'
  | 'reopen'
  | 'close';

interface TicketTransition {
  readonly from: readonly TicketStatus[];
  readonly to: TicketStatus;
  readonly by: readonly ('requester' | 'support')[];
}

/**
 * The single authority on a ticket's lifecycle. A closed ticket is final —
 * reopening a closed thread hides history, so a new ticket is opened instead.
 */
export const TICKET_TRANSITIONS: Record<TicketAction, TicketTransition> = {
  requester_reply: {
    from: ['open', 'awaiting_reply', 'resolved'],
    to: 'open',
    by: ['requester'],
  },
  support_reply: {
    from: ['open', 'awaiting_reply', 'resolved'],
    to: 'awaiting_reply',
    by: ['support'],
  },
  resolve: { from: ['open', 'awaiting_reply'], to: 'resolved', by: ['support'] },
  reopen: { from: ['resolved'], to: 'open', by: ['requester', 'support'] },
  close: { from: ['open', 'awaiting_reply', 'resolved'], to: 'closed', by: ['requester', 'support'] },
};

export interface OpenTicketInput {
  readonly requesterId: UserId;
  readonly requesterRole: 'rider' | 'driver';
  readonly category: TicketCategory;
  readonly subject: string;
  readonly body: string;
  readonly rideId?: RideId;
  readonly now: number;
}

export const openTicket = (input: OpenTicketInput): Result<SupportTicket, string> => {
  if (input.category.requiresRide && !input.rideId) {
    return err(`${input.category.label} requests must name a trip`);
  }
  const body = input.body.trim();
  if (body.length === 0) return err('Tell us what happened');

  const messages: TicketMessage[] = [
    {
      id: newMessageId(),
      from: 'requester',
      authorId: input.requesterId,
      text: body,
      sentAt: input.now,
    },
    // Acknowledging immediately is the difference between a support thread
    // people trust and one they open three times to check it sent.
    {
      id: newMessageId(),
      from: 'system',
      text: input.category.acknowledgement,
      sentAt: input.now,
    },
  ];

  return ok({
    id: newTicketId(),
    requesterId: input.requesterId,
    requesterRole: input.requesterRole,
    category: input.category.id,
    subject: input.subject.trim() || input.category.label,
    status: 'open',
    priority: input.category.priority,
    ...(input.rideId ? { rideId: input.rideId } : {}),
    messages,
    createdAt: input.now,
    updatedAt: input.now,
  });
};

export interface TicketActionInput {
  readonly action: TicketAction;
  readonly by: 'requester' | 'support';
  readonly authorId?: UserId;
  readonly text?: string;
  readonly now: number;
}

/** Apply an action to a ticket. Pure: returns a new ticket or an error. */
export const applyTicketAction = (
  ticket: SupportTicket,
  input: TicketActionInput,
): Result<SupportTicket, string> => {
  const transition = TICKET_TRANSITIONS[input.action];
  if (!transition) return err(`Unknown action ${input.action}`);
  if (!transition.by.includes(input.by)) {
    return err(`A ${input.by} cannot ${input.action.replace('_', ' ')} a ticket`);
  }
  if (!transition.from.includes(ticket.status)) {
    return err(`Cannot ${input.action.replace('_', ' ')} a ${ticket.status} ticket`);
  }

  const isReply = input.action === 'requester_reply' || input.action === 'support_reply';
  const text = input.text?.trim() ?? '';
  if (isReply && text.length === 0) return err('A reply cannot be empty');

  const message: TicketMessage | undefined = isReply
    ? {
        id: newMessageId(),
        from: input.by,
        ...(input.authorId ? { authorId: input.authorId } : {}),
        text,
        sentAt: input.now,
      }
    : text.length > 0
      ? { id: newMessageId(), from: 'system', text, sentAt: input.now }
      : undefined;

  return ok({
    ...ticket,
    status: transition.to,
    messages: message ? [...ticket.messages, message] : ticket.messages,
    updatedAt: input.now,
    ...(transition.to === 'resolved' ? { resolvedAt: input.now } : {}),
  });
};

/** Unread support replies — what a badge on the support tab counts. */
export const unreadForRequester = (ticket: SupportTicket): number =>
  ticket.messages.filter(
    (m) => m.from !== 'requester' && m.sentAt > (ticket.requesterReadAt ?? 0),
  ).length;

export const isTicketOpen = (ticket: SupportTicket): boolean =>
  ticket.status === 'open' || ticket.status === 'awaiting_reply';

export const ticketStatusLabel = (status: TicketStatus): string =>
  ({
    open: 'Open',
    awaiting_reply: 'Waiting for you',
    resolved: 'Resolved',
    closed: 'Closed',
  })[status];
