/**
 * The ride service.
 *
 * The orchestrator: it owns the ride lifecycle from request to receipt, and it
 * is the only place allowed to persist a status change. Every mutation follows
 * the same shape — load the ride, ask the domain state machine for the next
 * state, persist under an optimistic guard, then publish events. Because the
 * state machine rejects anything illegal, this file never has to re-check what
 * is allowed; it only has to arrange the effects.
 */

import {
  AppError,
  ACTIVE_RIDE_STATUSES,
  applyTransition,
  currentLeg,
  decodePolyline,
  emptyFare,
  freeCancellationRemainingMs,
  itineraryCoordinates,
  meetingPoint,
  metersToMiles,
  newRideId,
  standardCancellationPolicy,
  freeCancellationPolicy,
  tripDistanceMeters,
  type Actor,
  type Cancellation,
  type CancellationPolicy,
  type CancellationReason,
  type Clock,
  type DriverId,
  type FareBreakdown,
  type Itinerary,
  type Money,
  type PlatformConfig,
  type PlatformEvents,
  type Place,
  type Ride,
  type RideLeg,
  type RideId,
  type RiderId,
  type RideTypeCatalog,
  type OfferId,
  type VehicleId,
  type PaymentMethodId,
  type TypedEmitter,
  type Waypoint,
} from '@lift/core';
import type { GeoProvider, Route } from '@lift/geo';
import type {
  DriverRepository,
  RideRepository,
  RiderRepository,
  ShiftRepository,
  VehicleRepository,
} from '../repositories/types.js';
import type { PricingService } from './pricingService.js';
import type { PaymentService } from './paymentService.js';
import type { DispatchRuntime } from './dispatchRuntime.js';

export interface RideServiceDeps {
  readonly rides: RideRepository;
  readonly riders: RiderRepository;
  readonly drivers: DriverRepository;
  readonly vehicles: VehicleRepository;
  readonly shifts: ShiftRepository;
  readonly geo: GeoProvider;
  readonly catalog: RideTypeCatalog;
  readonly pricing: PricingService;
  readonly payments: PaymentService;
  readonly dispatch: DispatchRuntime;
  readonly config: PlatformConfig;
  readonly clock: Clock;
  readonly events: TypedEmitter<PlatformEvents>;
  readonly logger?: { error: (o: unknown, m?: string) => void };
}

export interface RequestRideInput {
  readonly riderId: RiderId;
  readonly rideTypeId: string;
  readonly pickup: Place;
  readonly dropoff: Place;
  readonly stops?: readonly Waypoint[];
  readonly passengerCount?: number;
  readonly paymentMethodId?: string;
  readonly riderNote?: string;
  readonly scheduledFor?: number;
  readonly quoteId?: string;
  readonly metadata?: Record<string, unknown>;
}

/** How many times a save may be retried when another writer got there first. */
const SAVE_RETRIES = 3;

export class RideService {
  private readonly cancellationPolicy: CancellationPolicy;

  constructor(private readonly deps: RideServiceDeps) {
    this.cancellationPolicy =
      deps.config.pricing.cancellationPolicy === 'free'
        ? freeCancellationPolicy()
        : standardCancellationPolicy();
  }

  // ------------------------------------------------------------- requesting

  /**
   * Create a ride and start the search. A rider may only have one ride in
   * flight, and the fare is re-derived server-side rather than trusted from the
   * client — the quote id only proves which price the rider was shown.
   */
  async requestRide(input: RequestRideInput): Promise<Ride> {
    const now = this.deps.clock.now();
    const rideType = this.deps.catalog.get(input.rideTypeId);
    if (!rideType) {
      throw new AppError('validation_failed', `Unknown ride type "${input.rideTypeId}"`);
    }

    const existing = await this.deps.rides.findActiveForRider(input.riderId);
    if (existing) {
      throw new AppError('conflict', 'Rider already has a ride in progress', {
        details: { rideId: existing.id, status: existing.status },
        userMessage: 'You already have a ride in progress.',
      });
    }

    const passengerCount = input.passengerCount ?? 1;
    if (passengerCount > rideType.maxPassengers) {
      throw new AppError(
        'validation_failed',
        `${rideType.name} carries at most ${rideType.maxPassengers} passengers`,
      );
    }

    const itinerary: Itinerary = {
      pickup: input.pickup,
      dropoff: input.dropoff,
      stops: input.stops ?? [],
    };

    // A cited quote must still be valid — a stale price is refused rather than
    // silently re-priced at whatever the market is doing now.
    if (input.quoteId && !this.deps.pricing.getQuote(input.quoteId)) {
      throw new AppError('quote_expired', 'That quote has expired', {
        userMessage: 'That price expired. Pull a fresh quote and try again.',
      });
    }

    const bundle = await this.deps.pricing.quote({
      itinerary,
      passengerCount,
      currency: this.deps.config.market.currency,
      ...(input.scheduledFor ? { scheduledFor: input.scheduledFor } : {}),
    });
    const quote = bundle.quotes.find((q) => q.rideType.id === rideType.id);
    if (!quote) {
      throw new AppError('validation_failed', `${rideType.name} is not available right now`);
    }
    if (!quote.available) {
      throw new AppError('validation_failed', quote.unavailableReason ?? 'Unavailable');
    }

    const isScheduled = input.scheduledFor !== undefined && input.scheduledFor > now;
    const draft: Ride = {
      id: newRideId(),
      riderId: input.riderId,
      status: isScheduled ? 'scheduled' : 'draft',
      rideTypeId: rideType.id,
      itinerary,
      legs: [],
      quotedFare: quote.fare,
      timeline: [
        { at: now, type: 'created', actor: { kind: 'rider', riderId: input.riderId } },
      ],
      passengerCount,
      createdAt: now,
      updatedAt: now,
      metadata: input.metadata ?? {},
      ...(input.paymentMethodId ? { paymentMethodId: input.paymentMethodId } : {}),
      ...(input.riderNote ? { riderNote: input.riderNote } : {}),
      ...(isScheduled ? { scheduledFor: input.scheduledFor } : {}),
    };

    const created = await this.deps.rides.create(draft);
    this.deps.events.emit('ride.created', { ride: created });

    // A ride booked for later waits for the scheduler to open its window.
    if (isScheduled) return created;

    return this.beginSearch(created, { kind: 'rider', riderId: input.riderId });
  }

  /** Move a ride into `requested` and hand it to dispatch. */
  async beginSearch(ride: Ride, actor: Actor): Promise<Ride> {
    const now = this.deps.clock.now();
    const requested = await this.transition(ride.id, { type: 'request', at: now }, actor);
    this.deps.events.emit('ride.requested', { ride: requested });
    await this.deps.dispatch.startSearch(requested);
    // Dispatch may have matched instantly, so return the freshest copy.
    return (await this.deps.rides.findById(ride.id)) ?? requested;
  }

  // -------------------------------------------------------------- assigning

  /**
   * Attach a driver to a ride. Called by the dispatch runtime when a driver
   * accepts; it computes the route legs the driver app will navigate.
   */
  async assignDriver(input: {
    rideId: RideId;
    driverId: DriverId;
    vehicleId: VehicleId;
    offerId: OfferId;
    pickupEtaMs: number;
  }): Promise<Ride> {
    const now = this.deps.clock.now();
    const ride = await this.requireRide(input.rideId);
    const driver = await this.deps.drivers.findById(input.driverId);
    if (!driver?.lastPosition) {
      throw new AppError('driver_unavailable', 'Driver has no known position');
    }

    const legs = await this.buildLegs(ride, driver.lastPosition);

    const assigned = await this.transition(
      ride.id,
      {
        type: 'assign',
        at: now,
        assignment: {
          driverId: input.driverId,
          vehicleId: input.vehicleId,
          assignedAt: now,
          offerId: input.offerId,
          initialPickupEtaMs: input.pickupEtaMs,
        },
        legs,
      },
      { kind: 'driver', driverId: input.driverId },
    );

    await this.deps.drivers.update(input.driverId, {
      availability: 'on_ride',
      currentRideId: ride.id,
    });
    this.deps.events.emit('driver.availability_changed', {
      driverId: input.driverId,
      from: 'offered',
      to: 'on_ride',
    });
    this.deps.events.emit('ride.matched', { ride: assigned, driverId: input.driverId });

    // Place the hold now that a real driver is committed to the trip.
    void this.authorizeFare(assigned).catch((e) =>
      this.deps.logger?.error({ err: e, rideId: ride.id }, 'fare authorization failed'),
    );

    return assigned;
  }

  // ------------------------------------------------------------- in-flight

  async markArrived(rideId: RideId, driverId: DriverId): Promise<Ride> {
    const ride = await this.requireAssignedRide(rideId, driverId);
    const arrived = await this.transition(
      ride.id,
      { type: 'arrive', at: this.deps.clock.now() },
      { kind: 'driver', driverId },
    );
    this.deps.events.emit('ride.driver_arrived', { ride: arrived });
    return arrived;
  }

  async startTrip(rideId: RideId, driverId: DriverId): Promise<Ride> {
    const ride = await this.requireAssignedRide(rideId, driverId);
    const started = await this.transition(
      ride.id,
      { type: 'start', at: this.deps.clock.now() },
      { kind: 'driver', driverId },
    );
    this.deps.events.emit('ride.started', { ride: started });
    return started;
  }

  /**
   * End the trip: price it against what actually happened, capture the fare,
   * release the driver, and update both parties' stats.
   */
  async completeTrip(
    rideId: RideId,
    driverId: DriverId,
    actuals: { distanceMeters?: number; durationMs?: number } = {},
  ): Promise<Ride> {
    const now = this.deps.clock.now();
    const ride = await this.requireAssignedRide(rideId, driverId);
    const rideType = this.deps.catalog.require(ride.rideTypeId);

    // Prefer measured values from the driver's device; fall back to the plan.
    const distanceMeters = actuals.distanceMeters ?? tripDistanceMeters(ride);
    const durationMs =
      actuals.durationMs ??
      (ride.startedAt !== undefined ? now - ride.startedAt : ride.quotedFare.durationMs);

    // Wait time is only billable once the driver actually announced arrival.
    const waitMinutes =
      ride.arrivedAt !== undefined && ride.startedAt !== undefined
        ? (ride.startedAt - ride.arrivedAt) / 60_000
        : 0;

    const finalFare = this.deps.pricing.finalize({
      rideType,
      itinerary: ride.itinerary,
      distanceMeters,
      durationMs,
      surgeMultiplier: ride.quotedFare.surgeMultiplier,
      waitMinutes,
      currency: ride.quotedFare.currency,
      quotedFare: ride.quotedFare,
      at: now,
      passengerCount: ride.passengerCount,
    });

    const completed = await this.transition(
      ride.id,
      { type: 'complete', at: now, finalFare },
      { kind: 'driver', driverId },
    );

    await this.releaseDriver(driverId, completed, finalFare.driverPayout);
    this.deps.events.emit('ride.completed', { ride: completed, fare: finalFare });

    void this.captureFare(completed).catch((e) =>
      this.deps.logger?.error({ err: e, rideId }, 'fare capture failed'),
    );

    return completed;
  }

  // ------------------------------------------------------------ cancelling

  /** What cancelling right now would cost, so the app can warn before it does. */
  async previewCancellation(rideId: RideId, by: Actor) {
    const ride = await this.requireRide(rideId);
    const rideType = this.deps.catalog.require(ride.rideTypeId);
    const assessment = this.cancellationPolicy.assess({
      ride,
      by,
      reason: 'rider_changed_mind',
      at: this.deps.clock.now(),
      rateCard: rideType.rateCard,
    });
    return {
      ...assessment,
      freeWindowRemainingMs: freeCancellationRemainingMs(
        ride,
        rideType.rateCard,
        this.deps.clock.now(),
      ),
    };
  }

  async cancelRide(input: {
    rideId: RideId;
    by: Actor;
    reason: CancellationReason;
    note?: string;
  }): Promise<Ride> {
    const now = this.deps.clock.now();
    const ride = await this.requireRide(input.rideId);
    const rideType = this.deps.catalog.require(ride.rideTypeId);

    const assessment = this.cancellationPolicy.assess({
      ride,
      by: input.by,
      reason: input.reason,
      at: now,
      rateCard: rideType.rateCard,
    });

    const cancellation: Cancellation = {
      reason: input.reason,
      by: input.by,
      at: now,
      feeWaived: assessment.waived,
      ...(input.note ? { note: input.note } : {}),
      ...(assessment.waived ? {} : { fee: assessment.fee }),
    };

    const cancelled = await this.transition(
      ride.id,
      { type: 'cancel', at: now, cancellation },
      input.by,
    );

    await this.deps.dispatch.cancelSearch(ride.id);
    if (ride.assignment) await this.releaseDriver(ride.assignment.driverId, cancelled);

    this.deps.events.emit('ride.cancelled', { ride: cancelled, cancellation });

    // Money moves after the ride is safely in its terminal state.
    void this.settleCancellation(cancelled, assessment.fee, assessment.waived).catch((e) =>
      this.deps.logger?.error({ err: e, rideId: ride.id }, 'cancellation settlement failed'),
    );

    return cancelled;
  }

  /** No driver was found before the search window closed. */
  async expireRide(rideId: RideId, searchedMs: number): Promise<Ride> {
    const expired = await this.transition(
      rideId,
      { type: 'expire', at: this.deps.clock.now() },
      { kind: 'system', reason: `no drivers found after ${Math.round(searchedMs / 1000)}s` },
    );
    this.deps.events.emit('ride.expired', { ride: expired });
    return expired;
  }

  // --------------------------------------------------------------- ratings

  async rateRide(input: {
    rideId: RideId;
    by: 'rider' | 'driver';
    stars: 1 | 2 | 3 | 4 | 5;
    comment?: string;
    tags?: readonly string[];
    tipAmount?: Money;
  }): Promise<Ride> {
    const now = this.deps.clock.now();
    const ride = await this.requireRide(input.rideId);
    if (ride.status !== 'completed') {
      throw new AppError('conflict', 'Only a completed ride can be rated');
    }

    const rating = {
      stars: input.stars,
      tags: input.tags ?? [],
      submittedAt: now,
      ...(input.comment ? { comment: input.comment } : {}),
    };

    let next: Ride = {
      ...ride,
      updatedAt: now,
      // A rider rates their driver, and vice versa.
      ...(input.by === 'rider' ? { driverRating: rating } : { riderRating: rating }),
      timeline: [
        ...ride.timeline,
        {
          at: now,
          type: 'rated' as const,
          actor:
            input.by === 'rider'
              ? { kind: 'rider' as const, riderId: ride.riderId }
              : { kind: 'driver' as const, driverId: ride.assignment!.driverId },
          data: { stars: input.stars },
        },
      ],
    };

    if (input.tipAmount && input.tipAmount.amount > 0 && next.finalFare) {
      next = { ...next, finalFare: this.deps.pricing.addTip(next.finalFare, input.tipAmount) };
    }

    const saved = await this.saveWithRetry(next, ride.updatedAt);
    await this.applyRating(saved, input.by, input.stars);

    if (input.tipAmount && input.tipAmount.amount > 0) {
      void this.chargeTip(saved, input.tipAmount).catch((e) =>
        this.deps.logger?.error({ err: e, rideId: input.rideId }, 'tip charge failed'),
      );
    }

    this.deps.events.emit('ride.rated', {
      rideId: saved.id,
      by: input.by,
      stars: input.stars,
    });
    return saved;
  }

  // ----------------------------------------------------------- scheduling

  /** Promote scheduled rides whose dispatch window has opened. */
  async releaseDueScheduledRides(): Promise<Ride[]> {
    const now = this.deps.clock.now();
    // Start looking for a driver before the pickup time, not at it.
    const leadMs = 10 * 60 * 1000;
    const due = await this.deps.rides.findDueScheduled(now, leadMs);
    const released: Ride[] = [];
    for (const ride of due) {
      try {
        released.push(
          await this.beginSearch(ride, { kind: 'system', reason: 'scheduled ride window opened' }),
        );
      } catch (e) {
        this.deps.logger?.error({ err: e, rideId: ride.id }, 'failed to release scheduled ride');
      }
    }
    return released;
  }

  // ----------------------------------------------------------------- reads

  async getRide(rideId: RideId): Promise<Ride> {
    return this.requireRide(rideId);
  }

  async activeRideForRider(riderId: RiderId): Promise<Ride | undefined> {
    return this.deps.rides.findActiveForRider(riderId);
  }

  async activeRideForDriver(driverId: DriverId): Promise<Ride | undefined> {
    return this.deps.rides.findActiveForDriver(driverId);
  }

  async history(query: {
    riderId?: RiderId;
    driverId?: DriverId;
    limit?: number;
    offset?: number;
  }): Promise<Ride[]> {
    return this.deps.rides.query({
      ...query,
      statuses: ['completed', 'cancelled', 'expired'],
      limit: query.limit ?? 20,
    });
  }

  /** Refresh the route from the driver's live position, e.g. after a detour. */
  async refreshRoute(rideId: RideId, from: { lat: number; lng: number }): Promise<Ride> {
    const ride = await this.requireRide(rideId);
    if (!ACTIVE_RIDE_STATUSES.includes(ride.status)) return ride;
    const legs = await this.buildLegs(ride, from);
    const next: Ride = {
      ...ride,
      legs,
      updatedAt: this.deps.clock.now(),
      timeline: [
        ...ride.timeline,
        {
          at: this.deps.clock.now(),
          type: 'route_updated' as const,
          actor: { kind: 'system' as const, reason: 'route refreshed from live position' },
        },
      ],
    };
    const saved = await this.saveWithRetry(next, ride.updatedAt);
    this.deps.events.emit('ride.route_updated', { rideId: saved.id, ride: saved });
    return saved;
  }

  // ------------------------------------------------------------- internals

  /**
   * The single path through which a ride's status changes: run the domain
   * transition, persist it under an optimistic guard, publish the change.
   */
  private async transition(
    rideId: RideId,
    action: Parameters<typeof applyTransition>[1],
    actor: Actor,
  ): Promise<Ride> {
    for (let attempt = 0; attempt < SAVE_RETRIES; attempt++) {
      const ride = await this.requireRide(rideId);
      const result = applyTransition(ride, action, actor);
      if (!result.ok) throw result.error;

      const saved = await this.deps.rides.save(result.value.ride, ride.updatedAt);
      if (saved) {
        this.deps.events.emit('ride.status_changed', {
          ride: saved,
          from: ride.status,
          to: saved.status,
        });
        return saved;
      }
      // Someone else wrote first; re-read and re-apply.
    }
    throw new AppError('conflict', 'Ride was modified concurrently; please retry', {
      details: { rideId },
    });
  }

  private async saveWithRetry(ride: Ride, expectedUpdatedAt: number): Promise<Ride> {
    const saved = await this.deps.rides.save(ride, expectedUpdatedAt);
    if (saved) return saved;
    // Re-read and reapply the same patch on top of the newer version.
    const current = await this.requireRide(ride.id);
    const merged = { ...current, ...ride, updatedAt: this.deps.clock.now() };
    const retried = await this.deps.rides.save(merged, current.updatedAt);
    if (!retried) throw new AppError('conflict', 'Ride was modified concurrently');
    return retried;
  }

  private async requireRide(rideId: RideId): Promise<Ride> {
    const ride = await this.deps.rides.findById(rideId);
    if (!ride) throw new AppError('not_found', 'Ride not found');
    return ride;
  }

  private async requireAssignedRide(rideId: RideId, driverId: DriverId): Promise<Ride> {
    const ride = await this.requireRide(rideId);
    if (ride.assignment?.driverId !== driverId) {
      throw new AppError('forbidden', 'You are not the driver on this ride');
    }
    return ride;
  }

  /**
   * Build the navigation legs: driver → pickup, then pickup → each stop →
   * dropoff. Every leg carries its own geometry so the driver app can navigate
   * one segment at a time.
   */
  private async buildLegs(ride: Ride, driverPosition: { lat: number; lng: number }): Promise<RideLeg[]> {
    if (!this.deps.geo.route) {
      throw new AppError('provider_unavailable', 'The configured geo provider cannot route');
    }
    const pickup = meetingPoint(ride.itinerary.pickup);
    const tripPoints = itineraryCoordinates(ride.itinerary);
    const now = this.deps.clock.now();

    const [toPickup, trip] = await Promise.all([
      this.deps.geo.route({ waypoints: [driverPosition, pickup], steps: true, departAt: now }),
      this.deps.geo.route({ waypoints: tripPoints, steps: true, departAt: now }),
    ]);

    const legs: RideLeg[] = [
      {
        kind: 'to_pickup',
        from: driverPosition,
        to: pickup,
        distanceMeters: toPickup.distanceMeters,
        durationMs: toPickup.durationInTrafficMs ?? toPickup.durationMs,
        geometry: toPickup.geometry,
      },
    ];

    // One leg per hop of the passenger-carrying portion.
    trip.legs.forEach((leg, index) => {
      const isLast = index === trip.legs.length - 1;
      legs.push({
        kind: isLast ? 'to_dropoff' : 'to_stop',
        from: leg.from,
        to: leg.to,
        distanceMeters: leg.distanceMeters,
        durationMs: leg.durationMs,
        geometry: leg.geometry,
      });
    });

    return legs;
  }

  /** Return a driver to the pool and roll their shift totals forward. */
  private async releaseDriver(
    driverId: DriverId,
    ride: Ride,
    payout?: Money,
  ): Promise<void> {
    const driver = await this.deps.drivers.findById(driverId);
    if (!driver) return;

    const completed = ride.status === 'completed';
    await this.deps.drivers.update(driverId, {
      availability: driver.availability === 'offline' ? 'offline' : 'available',
      currentRideId: undefined,
      lastOnlineAt: this.deps.clock.now(),
      ...(completed ? { totalRides: driver.totalRides + 1 } : {}),
    });
    this.deps.events.emit('driver.availability_changed', {
      driverId,
      from: 'on_ride',
      to: driver.availability === 'offline' ? 'offline' : 'available',
    });

    if (!completed || !payout) return;
    const shift = await this.deps.shifts.findOpen(driverId);
    if (!shift) return;
    await this.deps.shifts.update(shift.id, {
      ridesCompleted: shift.ridesCompleted + 1,
      grossEarnings: {
        amount: shift.grossEarnings.amount + payout.amount,
        currency: payout.currency,
      },
      distanceMeters: shift.distanceMeters + tripDistanceMeters(ride),
    });
  }

  private async applyRating(
    ride: Ride,
    by: 'rider' | 'driver',
    stars: number,
  ): Promise<void> {
    // A rider's stars land on the driver, and a driver's on the rider.
    if (by === 'rider' && ride.assignment) {
      const driver = await this.deps.drivers.findById(ride.assignment.driverId);
      if (!driver) return;
      const count = driver.ratingCount + 1;
      await this.deps.drivers.update(driver.id, {
        rating: rollingAverage(driver.rating, driver.ratingCount, stars),
        ratingCount: count,
      });
      return;
    }
    const rider = await this.deps.riders.findById(ride.riderId);
    if (!rider) return;
    await this.deps.riders.update(rider.id, {
      rating: rollingAverage(rider.rating, rider.ratingCount, stars),
      ratingCount: rider.ratingCount + 1,
    });
  }

  // ---------------------------------------------------------------- money

  private async authorizeFare(ride: Ride): Promise<void> {
    const method = await this.deps.payments.resolveMethod(
      ride.riderId,
      ride.paymentMethodId as PaymentMethodId | undefined,
    );
    await this.deps.payments.authorize({
      riderId: ride.riderId,
      paymentMethodId: method.id,
      // Hold the upper end of the estimate so a longer route still captures.
      amount: ride.quotedFare.estimateRange?.high ?? ride.quotedFare.total,
      rideId: ride.id,
      kind: 'ride_fare',
      idempotencyKey: `ride:${ride.id}:fare`,
      description: `Ride to ${ride.itinerary.dropoff.name}`,
    });
  }

  private async captureFare(ride: Ride): Promise<void> {
    if (!ride.finalFare) return;
    const held = await this.deps.payments.heldChargeFor(ride.id);
    if (held) {
      await this.deps.payments.capture(held.id, ride.finalFare.total);
      return;
    }
    // No hold exists (authorization failed earlier); charge directly.
    const method = await this.deps.payments.resolveMethod(
      ride.riderId,
      ride.paymentMethodId as PaymentMethodId | undefined,
    );
    await this.deps.payments.chargeImmediately({
      riderId: ride.riderId,
      paymentMethodId: method.id,
      amount: ride.finalFare.total,
      rideId: ride.id,
      kind: 'ride_fare',
      idempotencyKey: `ride:${ride.id}:fare:direct`,
    });
  }

  private async settleCancellation(
    ride: Ride,
    fee: Money,
    waived: boolean,
  ): Promise<void> {
    const held = await this.deps.payments.heldChargeFor(ride.id);

    if (waived || fee.amount <= 0) {
      if (held) await this.deps.payments.release(held.id);
      return;
    }
    // Convert the existing hold into the fee rather than charging twice.
    if (held) {
      await this.deps.payments.capture(held.id, fee);
      return;
    }
    const method = await this.deps.payments.resolveMethod(
      ride.riderId,
      ride.paymentMethodId as PaymentMethodId | undefined,
    );
    await this.deps.payments.chargeImmediately({
      riderId: ride.riderId,
      paymentMethodId: method.id,
      amount: fee,
      rideId: ride.id,
      kind: 'cancellation_fee',
      idempotencyKey: `ride:${ride.id}:cancellation`,
    });
  }

  private async chargeTip(ride: Ride, tip: Money): Promise<void> {
    const method = await this.deps.payments.resolveMethod(
      ride.riderId,
      ride.paymentMethodId as PaymentMethodId | undefined,
    );
    await this.deps.payments.chargeImmediately({
      riderId: ride.riderId,
      paymentMethodId: method.id,
      amount: tip,
      rideId: ride.id,
      kind: 'tip',
      idempotencyKey: `ride:${ride.id}:tip`,
    });
  }
}

/** Incremental mean, so a rating update never rescans a driver's history. */
const rollingAverage = (current: number, count: number, next: number): number => {
  const total = current * count + next;
  return Number((total / (count + 1)).toFixed(3));
};
