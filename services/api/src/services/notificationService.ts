/**
 * Notifications.
 *
 * Subscribes to domain events and turns the ones a person should hear about
 * into push messages. The transport is a port: development logs to the console,
 * production sends through APNs/FCM, and neither the ride service nor the
 * dispatcher knows which is in play.
 */

import {
  formatDuration,
  formatMoney,
  type DriverId,
  type PlatformEvents,
  type RiderId,
  type TypedEmitter,
  type Unsubscribe,
} from '@lift/core';

export interface PushMessage {
  readonly to: { kind: 'rider'; id: RiderId } | { kind: 'driver'; id: DriverId };
  readonly title: string;
  readonly body: string;
  /** Deep-link target, e.g. `ride/rid_123`. */
  readonly route?: string;
  /** High-priority alerts bypass a device's quiet hours. */
  readonly urgent?: boolean;
  readonly data?: Record<string, unknown>;
}

export interface PushTransport {
  readonly id: string;
  send(message: PushMessage): Promise<void>;
}

/** Logs instead of sending. The default outside production. */
export const consolePushTransport = (
  log: (message: string) => void = console.log,
): PushTransport => ({
  id: 'console',
  send: async (message) => {
    log(`[push → ${message.to.kind} ${message.to.id}] ${message.title} — ${message.body}`);
  },
});

/** Collects messages instead of sending them. Used by tests. */
export const recordingPushTransport = (): PushTransport & { sent: PushMessage[] } => {
  const sent: PushMessage[] = [];
  return {
    id: 'recording',
    sent,
    send: async (message) => {
      sent.push(message);
    },
  };
};

export class NotificationService {
  private readonly subscriptions: Unsubscribe[] = [];

  constructor(
    private readonly events: TypedEmitter<PlatformEvents>,
    private readonly transport: PushTransport,
  ) {}

  /** Wire up every notification the platform sends. */
  start(): void {
    if (this.subscriptions.length > 0) return;

    this.on('ride.matched', ({ ride }) => {
      const etaMs = ride.assignment?.initialPickupEtaMs ?? 0;
      return {
        to: { kind: 'rider', id: ride.riderId },
        title: 'Your driver is on the way',
        body: `Arriving in about ${formatDuration(etaMs)}.`,
        route: `ride/${ride.id}`,
      };
    });

    this.on('ride.driver_arrived', ({ ride }) => ({
      to: { kind: 'rider', id: ride.riderId },
      title: 'Your driver is here',
      body: `Look for them at ${ride.itinerary.pickup.name}.`,
      route: `ride/${ride.id}`,
      urgent: true,
    }));

    this.on('ride.started', ({ ride }) => ({
      to: { kind: 'rider', id: ride.riderId },
      title: `On the way to ${ride.itinerary.dropoff.name}`,
      body: 'Sit back and enjoy the ride.',
      route: `ride/${ride.id}`,
    }));

    this.on('ride.completed', ({ ride, fare }) => ({
      to: { kind: 'rider', id: ride.riderId },
      title: "You've arrived",
      body: `Your fare was ${formatMoney(fare.total)}. Rate your driver?`,
      route: `ride/${ride.id}/rate`,
    }));

    this.on('ride.expired', ({ ride }) => ({
      to: { kind: 'rider', id: ride.riderId },
      title: 'No drivers available',
      body: "We couldn't find you a driver. Try again in a few minutes.",
      route: 'home',
      urgent: true,
    }));

    this.on('ride.cancelled', ({ ride, cancellation }) => {
      // Tell whichever party did not do the cancelling.
      if (cancellation.by.kind === 'rider') {
        if (!ride.assignment) return undefined;
        return {
          to: { kind: 'driver', id: ride.assignment.driverId },
          title: 'Ride cancelled',
          body: 'Your rider cancelled. You’re back online.',
          route: 'home',
          urgent: true,
        };
      }
      return {
        to: { kind: 'rider', id: ride.riderId },
        title: 'Your ride was cancelled',
        body: "We're finding you another driver.",
        route: `ride/${ride.id}`,
        urgent: true,
      };
    });

    this.on('offer.sent', ({ offer }) => ({
      to: { kind: 'driver', id: offer.driverId },
      title: `New ride · ${formatMoney(offer.preview.estimatedPayout)}`,
      body: `${formatDuration(offer.preview.pickupEtaMs)} away · ${offer.preview.pickupAddress}`,
      route: `offer/${offer.id}`,
      urgent: true,
      data: { offerId: offer.id, expiresAt: offer.expiresAt },
    }));

    this.on('chat.message', ({ rideId, from, riderId, driverId, text }) => ({
      // A message notifies the party who did not send it.
      to:
        from === 'rider'
          ? { kind: 'driver' as const, id: driverId }
          : { kind: 'rider' as const, id: riderId },
      title: from === 'rider' ? 'Message from your rider' : 'Message from your driver',
      body: text,
      route: `ride/${rideId}/chat`,
    }));

    this.on('payment.failed', ({ charge }) => ({
      to: { kind: 'rider', id: charge.riderId },
      title: 'Payment problem',
      body: charge.failureMessage ?? 'We could not process your payment.',
      route: 'wallet',
      urgent: true,
    }));
  }

  stop(): void {
    for (const off of this.subscriptions) off();
    this.subscriptions.length = 0;
  }

  private on<K extends keyof PlatformEvents>(
    event: K,
    build: (payload: PlatformEvents[K]) => PushMessage | undefined,
  ): void {
    this.subscriptions.push(
      this.events.on(event, (payload) => {
        const message = build(payload);
        if (!message || !message.to.id) return;
        // A failed push must never affect the ride it was describing.
        void this.transport.send(message).catch(() => {});
      }),
    );
  }
}
