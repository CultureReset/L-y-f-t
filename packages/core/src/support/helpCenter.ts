/**
 * The help centre.
 *
 * A support screen full of hardcoded copy is the usual shortcut, and it is the
 * first thing a real operator needs to change. So the help centre is *data*: a
 * catalog of topics and articles that the platform config supplies, filtered
 * for the person asking and the ride they are asking about.
 *
 * Every article can carry actions, and an action is one of a small closed set
 * the apps know how to perform. That keeps the catalog declarative — a new
 * article is a data change, never a code change — while still letting an
 * article do something rather than only say something.
 */

import type { RideStatus } from '../domain/ride.js';

/** Who a topic is written for. */
export type HelpAudience = 'rider' | 'driver' | 'both';

/**
 * What an article's button does. The apps implement these four verbs; the
 * catalog chooses among them.
 */
export type HelpAction =
  | { readonly kind: 'open_ticket'; readonly label: string; readonly category: string }
  | { readonly kind: 'route'; readonly label: string; readonly path: string }
  | { readonly kind: 'call'; readonly label: string; readonly number: 'emergency' | string }
  | { readonly kind: 'link'; readonly label: string; readonly url: string };

export interface HelpArticle {
  readonly id: string;
  readonly title: string;
  /** Paragraphs. Kept as an array so the apps control typography, not the copy. */
  readonly body: readonly string[];
  readonly actions?: readonly HelpAction[];
}

export interface HelpTopic {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly icon: string;
  readonly audience: HelpAudience;
  /** Hidden unless the person is asking about a specific ride. */
  readonly requiresRide?: boolean;
  /** Narrows further: only shown when the ride is in one of these states. */
  readonly rideStatuses?: readonly RideStatus[];
  readonly articles: readonly HelpArticle[];
}

export interface HelpCenter {
  readonly topics: readonly HelpTopic[];
}

export interface HelpContext {
  readonly audience: 'rider' | 'driver';
  readonly rideStatus?: RideStatus;
}

/** The topics worth showing this person right now, in catalog order. */
export const resolveTopics = (center: HelpCenter, context: HelpContext): HelpTopic[] =>
  center.topics.filter((topic) => {
    if (topic.audience !== 'both' && topic.audience !== context.audience) return false;
    if (topic.requiresRide && context.rideStatus === undefined) return false;
    if (topic.rideStatuses && !topic.rideStatuses.includes(context.rideStatus as RideStatus)) {
      return false;
    }
    return true;
  });

export const findTopic = (center: HelpCenter, topicId: string): HelpTopic | undefined =>
  center.topics.find((topic) => topic.id === topicId);

export const findArticle = (
  center: HelpCenter,
  topicId: string,
  articleId: string,
): HelpArticle | undefined => findTopic(center, topicId)?.articles.find((a) => a.id === articleId);

/**
 * Merge an operator's overrides into the shipped catalog. Topics are matched by
 * id: a matching id replaces the shipped topic, a new id is appended. This is
 * how a market swaps out a single article without forking the whole catalog.
 */
export const mergeHelpCenter = (base: HelpCenter, overrides: HelpCenter): HelpCenter => {
  const byId = new Map(base.topics.map((topic) => [topic.id, topic]));
  for (const topic of overrides.topics) byId.set(topic.id, topic);
  return { topics: [...byId.values()] };
};

/**
 * The shipped catalog. Deliberately covers the questions that actually generate
 * support volume in a ridehail product rather than a generic FAQ.
 */
export const defaultHelpCenter = (): HelpCenter => ({
  topics: [
    {
      id: 'current_ride',
      title: 'A problem right now',
      summary: 'Your driver, your route, or your safety on this trip.',
      icon: '🚗',
      audience: 'rider',
      requiresRide: true,
      articles: [
        {
          id: 'driver_not_arriving',
          title: 'My driver is not arriving',
          body: [
            'Check the map — if the car has not moved for several minutes, your driver may be stuck or have a problem.',
            'Message them first. If they do not answer within a couple of minutes, cancel and rebook; a cancellation for a driver who never moved is not charged.',
          ],
          actions: [
            { kind: 'open_ticket', label: 'Report this driver', category: 'driver_conduct' },
          ],
        },
        {
          id: 'wrong_car',
          title: 'The car does not match the app',
          body: [
            'Do not get in. The plate, make, model, and colour in the app are the only reliable check.',
            'A driver may occasionally switch vehicles without updating the app — but verify by asking them to confirm your first name before you open the door, never the other way round.',
          ],
          actions: [
            { kind: 'route', label: 'Open safety tools', path: '/safety' },
            { kind: 'open_ticket', label: 'Report a vehicle mismatch', category: 'safety' },
          ],
        },
        {
          id: 'feel_unsafe',
          title: 'I feel unsafe',
          body: [
            'Trust that feeling. Ask the driver to pull over somewhere public and end the ride.',
            'Your trip can be shared live with someone you choose, and emergency services can be called from the safety screen with your ride details on hand.',
          ],
          actions: [
            { kind: 'call', label: 'Call emergency services', number: 'emergency' },
            { kind: 'route', label: 'Open safety tools', path: '/safety' },
          ],
        },
      ],
    },
    {
      id: 'fares',
      title: 'Fares and charges',
      summary: 'Why a trip cost what it did, and how to dispute it.',
      icon: '💳',
      audience: 'rider',
      articles: [
        {
          id: 'fare_higher',
          title: 'My fare was higher than the estimate',
          body: [
            'Your receipt breaks the fare into every line that made it up — base, distance, time, surge, surcharges, discounts, and tax. The total is the sum of those lines and nothing else.',
            'The usual causes are a longer route than estimated, waiting time at pickup, or a surge multiplier that applied when you booked.',
          ],
          actions: [
            { kind: 'route', label: 'See your trips', path: '/activity' },
            { kind: 'open_ticket', label: 'Dispute this fare', category: 'fare_dispute' },
          ],
        },
        {
          id: 'cancel_fee',
          title: 'I was charged a cancellation fee',
          body: [
            'A fee applies once a driver has been assigned and has started driving to you, or after the free window has passed.',
            'It is waived when the driver had not moved, when they were the one who cancelled, or when the app assigned a driver much further away than quoted.',
          ],
          actions: [
            { kind: 'open_ticket', label: 'Ask for a review', category: 'fare_dispute' },
          ],
        },
        {
          id: 'unknown_charge',
          title: 'I do not recognise a charge',
          body: [
            'Every charge in your wallet names the trip it came from and the card it went to. A hold placed at booking is released, not captured, if the ride does not happen — your bank may take a few days to drop it.',
          ],
          actions: [
            { kind: 'route', label: 'Open wallet', path: '/wallet' },
            { kind: 'open_ticket', label: 'Report an unknown charge', category: 'fare_dispute' },
          ],
        },
      ],
    },
    {
      id: 'lost_item',
      title: 'Lost something',
      summary: 'Left a phone, bag, or keys in the car.',
      icon: '🎒',
      audience: 'rider',
      articles: [
        {
          id: 'left_item',
          title: 'I left something in the car',
          body: [
            'Tell us which trip and what you left, and your driver is contacted with your number. Most items come back the same day.',
            'If it is a phone, use someone else’s device to call it first — drivers usually answer.',
          ],
          actions: [
            { kind: 'open_ticket', label: 'Report a lost item', category: 'lost_item' },
          ],
        },
      ],
    },
    {
      id: 'account',
      title: 'Account and privacy',
      summary: 'Your details, your data, and closing your account.',
      icon: '👤',
      audience: 'both',
      articles: [
        {
          id: 'change_number',
          title: 'Changing your phone number',
          body: [
            'Your number is how you sign in, so changing it needs to be verified rather than edited. Open a request and both the old and new number are confirmed before the switch.',
          ],
          actions: [
            { kind: 'open_ticket', label: 'Request a number change', category: 'account' },
          ],
        },
        {
          id: 'delete_account',
          title: 'Deleting your account',
          body: [
            'Deleting removes your profile, saved places, and payment methods. Trip and payment records are kept for the period tax and safety law requires, then deleted too.',
            'Any trip in progress must finish first.',
          ],
          actions: [
            { kind: 'open_ticket', label: 'Request account deletion', category: 'account' },
          ],
        },
      ],
    },
    {
      id: 'earnings',
      title: 'Earnings and payouts',
      summary: 'What you were paid and when it arrives.',
      icon: '💰',
      audience: 'driver',
      articles: [
        {
          id: 'trip_pay',
          title: 'A trip paid less than I expected',
          body: [
            'Each trip breaks down into the fare you earned, any bonus, tips, and the platform’s commission. The breakdown is on the trip in your earnings history.',
            'A route shorter than the one quoted to the rider pays less; a longer one pays more.',
          ],
          actions: [
            { kind: 'route', label: 'Open earnings', path: '/earnings' },
            { kind: 'open_ticket', label: 'Ask about a trip', category: 'earnings' },
          ],
        },
        {
          id: 'payout_timing',
          title: 'When do I get paid?',
          body: [
            'Earnings settle to your balance as each trip completes and pay out on the schedule set for your market. An instant cash out is available once your balance clears the minimum.',
          ],
          actions: [{ kind: 'route', label: 'Open earnings', path: '/earnings' }],
        },
      ],
    },
    {
      id: 'driver_account',
      title: 'Documents and approval',
      summary: 'Getting on the road and staying there.',
      icon: '📄',
      audience: 'driver',
      articles: [
        {
          id: 'documents_pending',
          title: 'My documents are still pending',
          body: [
            'A document is checked for expiry, legibility, and that the name matches your profile. Most are reviewed within a day.',
            'A rejected document tells you why on the onboarding screen — re-upload rather than opening a request.',
          ],
          actions: [{ kind: 'route', label: 'Open onboarding', path: '/onboarding' }],
        },
        {
          id: 'deactivated',
          title: 'I cannot go online',
          body: [
            'Going online needs an approved profile, at least one approved vehicle, and every required document in date.',
            'If all of those are green and you still cannot go online, open a request and it is looked at by a person.',
          ],
          actions: [
            { kind: 'open_ticket', label: 'I still cannot go online', category: 'account' },
          ],
        },
      ],
    },
    {
      id: 'rider_conduct',
      title: 'A problem with a rider',
      summary: 'Report what happened on a trip.',
      icon: '⚠️',
      audience: 'driver',
      articles: [
        {
          id: 'report_rider',
          title: 'Reporting a rider',
          body: [
            'Report anything that made the trip unsafe or unacceptable — the rider is reviewed and you will not be matched with them again while it is open.',
          ],
          actions: [
            { kind: 'open_ticket', label: 'Report a rider', category: 'rider_conduct' },
          ],
        },
      ],
    },
  ],
});
