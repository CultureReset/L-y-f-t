/**
 * A virtual driver.
 *
 * Signs in through the real API, goes online, drives a real route to a real
 * pickup, and runs the trip. It uses the same SDK the driver app uses and has
 * no privileged access — which is the point: if a simulated driver can
 * complete a ride, so can a person with a phone.
 */

import {
  bearingDegrees,
  formatMoney,
  haversineMeters,
  decodePolyline,
  meetingPoint,
  pointAlongPath,
  type LatLng,
  type Random,
  type Ride,
  type RideOffer,
} from '@lift/core';
import { LiftClient, RealtimeClient, channels } from '@lift/sdk';

export interface VirtualDriverOptions {
  readonly apiUrl: string;
  readonly phone: string;
  readonly name: { first: string; last: string };
  readonly start: LatLng;
  readonly random: Random;
  /** Metres per second while driving. */
  readonly speedMps?: number;
  /** How often a position is pushed. */
  readonly pingIntervalMs?: number;
  /** Probability of declining any given offer. */
  readonly declineRate?: number;
  /** Seconds a driver takes to notice and answer an offer. */
  readonly responseDelayMs?: number;
  readonly log?: (message: string) => void;
}

type Phase = 'offline' | 'idle' | 'to_pickup' | 'waiting' | 'to_dropoff';

export class VirtualDriver {
  readonly client: LiftClient;
  private readonly realtime: RealtimeClient;
  private readonly log: (message: string) => void;

  private driverId?: string;
  private position: LatLng;
  private bearing = 0;
  private phase: Phase = 'offline';
  private ride?: Ride;
  private path: LatLng[] = [];
  private travelled = 0;
  private waitUntil = 0;
  private timer?: ReturnType<typeof setInterval>;
  private answering = false;

  /** Counters the simulator reports at the end of a run. */
  readonly stats = { offers: 0, accepted: 0, declined: 0, completed: 0, earnings: 0 };

  constructor(private readonly options: VirtualDriverOptions) {
    this.position = options.start;
    this.log = options.log ?? (() => {});
    this.client = new LiftClient({ baseUrl: options.apiUrl });
    this.realtime = new RealtimeClient({
      url: () => this.client.realtimeUrl(),
      baseBackoffMs: 500,
    });
  }

  get id(): string | undefined {
    return this.driverId;
  }

  get currentPosition(): LatLng {
    return this.position;
  }

  /** Sign in, make sure the account can drive, and go online. */
  async start(): Promise<void> {
    await this.client.requestCode(this.options.phone);
    const session = await this.client.verifyCode({
      phone: this.options.phone,
      code: '000000',
      role: 'driver',
      firstName: this.options.name.first,
      lastName: this.options.name.last,
    });
    this.driverId = session.driverId;

    await this.ensureReadyToDrive();
    await this.client.goOnline(this.position);
    this.phase = 'idle';

    this.realtime.connect();
    if (this.driverId) {
      this.realtime.subscribe(channels.driver(this.driverId), (message) => {
        if (message.type === 'offer.sent') {
          const { offer } = message.payload as { offer: RideOffer };
          void this.considerOffer(offer);
        }
      });
    }

    this.timer = setInterval(
      () => void this.tick().catch((e) => this.log(`tick failed: ${String(e)}`)),
      this.options.pingIntervalMs ?? 1_000,
    );

    this.log(`${this.options.name.first} is online`);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.realtime.disconnect();
    try {
      await this.client.goOffline();
    } catch {
      // Going offline is best-effort during shutdown.
    }
  }

  /**
   * A brand-new driver account starts unapproved with no vehicle, so the
   * simulator walks the same onboarding a person would.
   */
  private async ensureReadyToDrive(): Promise<void> {
    const status = await this.client.driverStatus();
    if (status.canGoOnline) return;

    if (!status.vehicle) {
      const spec = this.options.random.pick([
        { make: 'Toyota', model: 'Camry', seats: 4 },
        { make: 'Honda', model: 'Accord', seats: 4 },
        { make: 'Tesla', model: 'Model 3', seats: 4 },
        { make: 'Honda', model: 'Odyssey', seats: 6 },
      ]);
      await this.client.addVehicle({
        make: spec.make,
        model: spec.model,
        year: new Date().getFullYear() - this.options.random.int(0, 5),
        color: this.options.random.pick(['black', 'white', 'silver', 'gray', 'blue']),
        licensePlate: `${this.options.random.int(1, 9)}SIM${this.options.random.int(100, 999)}`,
        seats: spec.seats,
        features: [],
      });
    }

    for (const type of [
      'drivers_license',
      'vehicle_registration',
      'insurance',
      'background_check',
      'profile_photo',
    ]) {
      await this.client.submitDocument({ type });
    }

    // Approval is an operator action; the simulator cannot grant it to itself,
    // so a driver who is still blocked is reported rather than forced online.
    const after = await this.client.driverStatus();
    if (!after.canGoOnline) {
      throw new Error(
        `${this.options.name.first} cannot go online: ${after.blockedReason ?? 'pending approval'}`,
      );
    }
  }

  /** Decide on an offer, after a human-like pause. */
  private async considerOffer(offer: RideOffer): Promise<void> {
    if (this.answering || this.phase !== 'idle') return;
    this.answering = true;
    this.stats.offers += 1;

    const delay = this.options.responseDelayMs ?? this.options.random.int(1_000, 4_000);
    await new Promise((resolve) => setTimeout(resolve, delay));

    try {
      if (this.options.random.bool(this.options.declineRate ?? 0.15)) {
        await this.client.declineOffer(offer.id);
        this.stats.declined += 1;
        this.log(`${this.options.name.first} declined a ride`);
        return;
      }

      const { ride } = await this.client.acceptOffer(offer.id);
      this.stats.accepted += 1;
      this.adoptRide(ride);
      this.log(
        `${this.options.name.first} accepted ${ride.id} → ${ride.itinerary.dropoff.name}`,
      );
    } catch (e) {
      // Losing the race to another driver is normal, not an error.
      this.log(`${this.options.name.first} missed an offer (${String(e)})`);
    } finally {
      this.answering = false;
    }
  }

  private adoptRide(ride: Ride): void {
    this.ride = ride;
    this.phase = 'to_pickup';
    const leg = ride.legs.find((l) => l.kind === 'to_pickup');
    this.path = leg?.geometry
      ? decodePolyline(leg.geometry)
      : [this.position, meetingPoint(ride.itinerary.pickup)];
    this.travelled = 0;
  }

  /**
   * One step of the drive. Advances along the current route, pushes the new
   * position, and calls the lifecycle transitions as it reaches each point.
   */
  private async tick(): Promise<void> {
    if (this.phase === 'offline') return;

    const intervalMs = this.options.pingIntervalMs ?? 1_000;
    const speed = this.options.speedMps ?? 11;

    if (this.phase === 'idle') {
      // Drift slowly so the fleet on the ops map is not frozen.
      this.position = {
        lat: this.position.lat + this.options.random.float(-0.00012, 0.00012),
        lng: this.position.lng + this.options.random.float(-0.00012, 0.00012),
      };
      await this.push();
      return;
    }

    if (this.phase === 'waiting') {
      if (Date.now() >= this.waitUntil && this.ride) {
        await this.client.startTrip(this.ride.id);
        const leg = this.ride.legs.find((l) => l.kind !== 'to_pickup');
        this.path = leg?.geometry
          ? decodePolyline(leg.geometry)
          : [this.position, meetingPoint(this.ride.itinerary.dropoff)];
        this.travelled = 0;
        this.phase = 'to_dropoff';
        this.log(`${this.options.name.first} started the trip`);
      }
      await this.push();
      return;
    }

    // Driving: advance along the polyline.
    this.travelled += (speed * intervalMs) / 1000;
    if (this.path.length >= 2) {
      const at = pointAlongPath(this.path, this.travelled);
      this.position = at.position;
      this.bearing = at.bearing;
      await this.push();

      if (at.remaining > 15) return;
    }

    // Arrived at the end of the leg.
    if (!this.ride) return;

    if (this.phase === 'to_pickup') {
      await this.client.markArrived(this.ride.id);
      // A rider takes a moment to come out.
      this.waitUntil = Date.now() + this.options.random.int(3_000, 12_000);
      this.phase = 'waiting';
      this.log(`${this.options.name.first} arrived at the pickup`);
      return;
    }

    if (this.phase === 'to_dropoff') {
      const { ride } = await this.client.completeTrip(this.ride.id, {
        distanceMeters: Math.round(this.travelled),
      });
      this.stats.completed += 1;
      this.stats.earnings += ride.finalFare?.driverPayout.amount ?? 0;
      this.log(
        `${this.options.name.first} completed ${ride.id} · earned ${
          ride.finalFare ? formatMoney(ride.finalFare.driverPayout) : '—'
        }`,
      );

      // Rate the rider, then go back to waiting for work.
      await this.client
        .rateRider(ride.id, { stars: this.options.random.int(4, 6) as number })
        .catch(() => {});
      this.ride = undefined;
      this.path = [];
      this.phase = 'idle';
    }
  }

  /** Push the current position over the socket, or by HTTP if it is down. */
  private async push(): Promise<void> {
    const payload = {
      lat: this.position.lat,
      lng: this.position.lng,
      bearing: this.bearing,
      speed: this.phase === 'idle' || this.phase === 'waiting' ? 0 : (this.options.speedMps ?? 11),
      accuracy: 5,
    };
    if (this.realtime.isConnected) this.realtime.sendLocation(payload);
    else await this.client.updateLocation(payload).catch(() => {});
  }
}

/** Straight-line helper for logs and diagnostics. */
export const distanceTo = (from: LatLng, to: LatLng): number => haversineMeters(from, to);
export const headingTo = (from: LatLng, to: LatLng): number => bearingDegrees(from, to);
