/**
 * A virtual rider.
 *
 * Books rides at intervals between real places, watches them over the realtime
 * channel, and rates the driver at the end — exercising the same endpoints the
 * rider app calls, with no shortcuts.
 */

import {
  formatMoney,
  type LatLng,
  type Place,
  type Random,
  type Ride,
} from '@lift/core';
import { LiftClient, RealtimeClient, channels } from '@lift/sdk';

export interface VirtualRiderOptions {
  readonly apiUrl: string;
  readonly phone: string;
  readonly name: { first: string; last: string };
  readonly random: Random;
  /** Where the rider looks for places. */
  readonly near: LatLng;
  /** Seconds between one ride finishing and the next being booked. */
  readonly gapMs?: () => number;
  /** Probability of cancelling before a driver arrives. */
  readonly cancelRate?: number;
  readonly log?: (message: string) => void;
}

export class VirtualRider {
  readonly client: LiftClient;
  private readonly realtime: RealtimeClient;
  private readonly log: (message: string) => void;

  private riderId?: string;
  private places: Place[] = [];
  private stopped = false;
  private nextTimer?: ReturnType<typeof setTimeout>;

  readonly stats = { requested: 0, completed: 0, cancelled: 0, expired: 0, spent: 0 };

  constructor(private readonly options: VirtualRiderOptions) {
    this.log = options.log ?? (() => {});
    this.client = new LiftClient({ baseUrl: options.apiUrl });
    this.realtime = new RealtimeClient({
      url: () => this.client.realtimeUrl(),
      baseBackoffMs: 500,
    });
  }

  async start(): Promise<void> {
    await this.client.requestCode(this.options.phone);
    const session = await this.client.verifyCode({
      phone: this.options.phone,
      code: '000000',
      role: 'rider',
      firstName: this.options.name.first,
      lastName: this.options.name.last,
    });
    this.riderId = session.riderId;

    // A rider needs a payment method before the platform will let them book.
    const wallet = await this.client.paymentMethods();
    if (wallet.methods.length === 0) {
      await this.client.addPaymentMethod({
        kind: 'card',
        brand: 'visa',
        last4: String(this.options.random.int(1000, 9999)),
        expiryMonth: 12,
        expiryYear: new Date().getFullYear() + 3,
        makeDefault: true,
      });
    }

    // A previous run may have been killed mid-ride. The platform allows one
    // ride at a time per rider, so an inherited ride has to be cleared before
    // this rider can book anything.
    await this.clearInFlightRide();

    await this.loadPlaces();
    this.realtime.connect();
    this.scheduleNext(this.options.random.int(500, 4_000));
    this.log(`${this.options.name.first} is looking for a ride`);
  }

  stop(): void {
    this.stopped = true;
    if (this.nextTimer) clearTimeout(this.nextTimer);
    this.realtime.disconnect();
  }

  private async clearInFlightRide(): Promise<void> {
    try {
      const { ride } = await this.client.activeRide();
      if (!ride) return;
      await this.client.cancelRide(ride.id, { reason: 'rider_changed_mind' });
      this.log(`${this.options.name.first} cleared a leftover ride from a previous run`);
    } catch {
      // Nothing in flight, or it finished on its own. Either way, carry on.
    }
  }

  /** Pull a pool of real places to travel between. */
  private async loadPlaces(): Promise<void> {
    const { sections } = await this.client.searchPlaces({
      q: '',
      near: this.options.near,
      limit: 12,
    });
    const fromSources = sections.flatMap((s) => s.results.map((r) => r.place));

    // The empty query only returns saved/recent/nearby, so seed a few landmarks
    // by name to guarantee a varied pool on a fresh deployment.
    if (fromSources.length < 4) {
      for (const term of ['ferry', 'dolores', 'oracle', 'golden gate', 'chinatown', 'castro']) {
        const { sections: found } = await this.client.searchPlaces({
          q: term,
          near: this.options.near,
          limit: 1,
        });
        const place = found.flatMap((s) => s.results)[0]?.place;
        if (place) fromSources.push(place);
      }
    }

    // De-duplicate by coordinate so a round trip is never booked to itself.
    const seen = new Set<string>();
    this.places = fromSources.filter((p) => {
      const key = `${p.coordinates.lat.toFixed(4)},${p.coordinates.lng.toFixed(4)}`;
      if (seen.has(key) || (p.coordinates.lat === 0 && p.coordinates.lng === 0)) return false;
      seen.add(key);
      return true;
    });
  }

  private scheduleNext(delayMs: number): void {
    if (this.stopped) return;
    this.nextTimer = setTimeout(() => {
      void this.bookRide().catch((e) => this.log(`booking failed: ${String(e)}`));
    }, delayMs);
  }

  /** Book one ride and follow it to a terminal state. */
  private async bookRide(): Promise<void> {
    if (this.stopped || this.places.length < 2) return;

    // Never book a trip that starts where it ends.
    const pickup = this.options.random.pick(this.places);
    const candidates = this.places.filter((p) => p !== pickup);
    const dropoff = this.options.random.pick(candidates);

    const quote = await this.client.quote({ pickup, dropoff, passengerCount: 1 });
    const available = quote.quotes.filter((q) => q.available);
    if (available.length === 0) {
      this.scheduleNext(30_000);
      return;
    }

    /*
     * Weight the choice toward the everyday tiers. `available` only means the
     * party fits — a Lux or Access request still needs a driver whose vehicle
     * qualifies, so picking uniformly would mostly produce rides nobody in a
     * small simulated fleet can serve.
     */
    const weights: Record<string, number> = {
      standard: 10,
      shared: 6,
      xl: 3,
      lux: 1,
      access: 1,
    };
    const pool = available.flatMap((q) =>
      Array.from({ length: weights[q.rideTypeId] ?? 2 }, () => q),
    );
    const chosen = this.options.random.pick(pool);

    const { ride } = await this.client.requestRide({
      rideTypeId: chosen.rideTypeId,
      pickup,
      dropoff,
      quoteId: quote.quoteId,
    });
    this.stats.requested += 1;
    this.log(
      `${this.options.name.first} requested ${chosen.name}: ${pickup.name} → ${dropoff.name} (${formatMoney(chosen.fare.total)})`,
    );

    this.follow(ride);
  }

  /** Watch a ride to completion, then book another. */
  private follow(ride: Ride): void {
    const wantsToCancel = this.options.random.bool(this.options.cancelRate ?? 0.08);

    const unsubscribe = this.realtime.subscribe(channels.ride(ride.id), (message) => {
      const payload = message.payload as { ride?: Ride };
      const updated = payload.ride;
      if (!updated) return;

      // A flaky rider changes their mind shortly after being matched.
      if (wantsToCancel && updated.status === 'accepted') {
        void this.client
          .cancelRide(ride.id, { reason: 'rider_changed_mind' })
          .then(() => {
            this.stats.cancelled += 1;
            this.log(`${this.options.name.first} cancelled ${ride.id}`);
          })
          .catch(() => {});
        return;
      }

      if (updated.status === 'completed') {
        unsubscribe();
        this.stats.completed += 1;
        this.stats.spent += updated.finalFare?.total.amount ?? 0;
        this.log(
          `${this.options.name.first} arrived · paid ${
            updated.finalFare ? formatMoney(updated.finalFare.total) : '—'
          }`,
        );
        void this.rateAndRebook(ride.id);
        return;
      }

      if (updated.status === 'cancelled' || updated.status === 'expired') {
        unsubscribe();
        if (updated.status === 'expired') this.stats.expired += 1;
        this.scheduleNext(this.nextGap());
      }
    });

    // A safety net in case the socket misses the terminal event.
    setTimeout(
      () => {
        void this.client
          .ride(ride.id)
          .then((r) => {
            if (r.ride && ['completed', 'cancelled', 'expired'].includes(r.ride.status)) {
              unsubscribe();
              this.scheduleNext(this.nextGap());
            }
          })
          .catch(() => {});
      },
      10 * 60 * 1000,
    );
  }

  private async rateAndRebook(rideId: string): Promise<void> {
    const stars = this.options.random.int(4, 6);
    const tip = this.options.random.bool(0.4)
      ? this.options.random.pick([100, 200, 300, 500])
      : 0;
    await this.client
      .rateRide(rideId, { stars, ...(tip > 0 ? { tipAmount: tip } : {}) })
      .catch(() => {});
    this.scheduleNext(this.nextGap());
  }

  private nextGap(): number {
    return this.options.gapMs?.() ?? this.options.random.int(8_000, 30_000);
  }
}
