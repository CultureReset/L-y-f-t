/**
 * The dispatch runtime.
 *
 * The domain `DispatchSession` is pure — it consumes candidates and emits
 * commands. This class is the other half: it gathers candidates from the driver
 * repository, drives every open session from a single interval, and performs
 * the effects the commands describe (persisting offers, flipping driver
 * availability, publishing realtime events, handing assignments back to the
 * ride service).
 *
 * One timer serves the whole process regardless of how many rides are
 * searching, and the timer is optional: tests and the simulator call `tick()`
 * by hand and get a fully deterministic dispatch.
 */

import {
  DispatchRegistry,
  DispatchSession,
  meetingPoint,
  haversineMeters,
  publicName,
  vehicleQualifies,
  type Clock,
  type DispatchCommand,
  type DriverCandidate,
  type DriverId,
  type DriverProfile,
  type LatLng,
  type MatchRequest,
  type OfferId,
  type OfferPreview,
  type PlatformConfig,
  type PlatformEvents,
  type Ride,
  type RideId,
  type RideOffer,
  type RideTypeCatalog,
  type TypedEmitter,
  type Vehicle,
  type VehicleId,
} from '@lift/core';
import type { GeoProvider } from '@lift/geo';
import type {
  DriverRepository,
  OfferRepository,
  RideRepository,
  RiderRepository,
  UserRepository,
  VehicleRepository,
} from '../repositories/types.js';

export interface DispatchHandlers {
  /** A driver won the ride; the ride service performs the assignment. */
  onAssign(input: {
    rideId: RideId;
    driverId: DriverId;
    vehicleId: VehicleId;
    offerId: OfferId;
    pickupEtaMs: number;
  }): Promise<void>;
  /** The search window closed with nobody found. */
  onNoDrivers(rideId: RideId, searchedMs: number): Promise<void>;
}

export interface DispatchRuntimeDeps {
  readonly drivers: DriverRepository;
  readonly vehicles: VehicleRepository;
  readonly rides: RideRepository;
  readonly riders: RiderRepository;
  readonly users: UserRepository;
  readonly offers: OfferRepository;
  readonly geo: GeoProvider;
  readonly catalog: RideTypeCatalog;
  readonly config: PlatformConfig;
  readonly clock: Clock;
  readonly events: TypedEmitter<PlatformEvents>;
  readonly strategyFor?: (rideTypeId: string) => DispatchSession['strategy'] | undefined;
  readonly logger?: { info: (o: unknown, m?: string) => void; error: (o: unknown, m?: string) => void };
}

export class DispatchRuntime {
  private readonly registry = new DispatchRegistry();
  private readonly sessionByOffer = new Map<OfferId, RideId>();
  private timer?: ReturnType<typeof setInterval>;
  private handlers?: DispatchHandlers;
  /** Guards against a slow tick overlapping the next one. */
  private ticking = false;

  constructor(private readonly deps: DispatchRuntimeDeps) {}

  setHandlers(handlers: DispatchHandlers): void {
    this.handlers = handlers;
  }

  /** Begin searching for a driver for a requested ride. */
  async startSearch(ride: Ride): Promise<void> {
    if (this.registry.get(ride.id)) return;

    const rideType = this.deps.catalog.require(ride.rideTypeId);
    const riderName = await this.riderDisplayName(ride);
    const riderRating = (await this.deps.riders.findById(ride.riderId))?.rating ?? 5;
    const pickup = meetingPoint(ride.itinerary.pickup);
    const dropoff = meetingPoint(ride.itinerary.dropoff);

    const request: MatchRequest = {
      rideId: ride.id,
      rideTypeId: ride.rideTypeId,
      pickup,
      dropoff,
      passengerCount: ride.passengerCount,
      requestedAt: ride.requestedAt ?? this.deps.clock.now(),
      estimatedPayout: ride.quotedFare.driverPayout,
      estimatedTripDistanceMeters: ride.quotedFare.distanceMeters,
      estimatedTripDurationMs: ride.quotedFare.durationMs,
      excludedDriverIds: [],
    };

    const buildPreview = (candidate: DriverCandidate): OfferPreview => ({
      rideTypeId: ride.rideTypeId,
      pickupAddress: ride.itinerary.pickup.name || ride.itinerary.pickup.address,
      pickupCoordinates: pickup,
      dropoffAddress: ride.itinerary.dropoff.name || ride.itinerary.dropoff.address,
      dropoffCoordinates: dropoff,
      pickupEtaMs: candidate.etaToPickupMs,
      pickupDistanceMeters: Math.round(candidate.distanceMeters),
      tripDistanceMeters: ride.quotedFare.distanceMeters,
      tripDurationMs: ride.quotedFare.durationMs,
      estimatedPayout: ride.quotedFare.driverPayout,
      surgeMultiplier: ride.quotedFare.surgeMultiplier,
      riderRating,
      riderName,
      stopCount: ride.itinerary.stops.length,
      passengerCount: ride.passengerCount,
    });

    const dispatchConfig = this.deps.config.dispatch;
    const session = new DispatchSession({
      request,
      startedAt: this.deps.clock.now(),
      buildPreview,
      catalog: this.deps.catalog,
      ...(this.deps.strategyFor?.(ride.rideTypeId)
        ? { strategy: this.deps.strategyFor(ride.rideTypeId)! }
        : {}),
      tuning: {
        // A ride type's own tuning wins over the platform default.
        searchRadiusMeters: rideType.dispatch.searchRadiusMeters,
        offerTimeoutMs: rideType.dispatch.offerTimeoutMs,
        searchTimeoutMs: rideType.dispatch.searchTimeoutMs,
        offerBatchSize: rideType.dispatch.offerBatchSize,
        roundDelayMs: dispatchConfig.roundDelayMs,
        radiusExpansionFactor: dispatchConfig.radiusExpansionFactor,
        maxSearchRadiusMeters: dispatchConfig.maxSearchRadiusMeters,
      },
    });

    this.registry.open(session);
    // Offer immediately rather than waiting for the next interval — the rider
    // is staring at a "finding your driver" screen.
    await this.tickSession(session);
  }

  /** Stop searching, voiding any outstanding offers. */
  async cancelSearch(rideId: RideId): Promise<void> {
    const session = this.registry.get(rideId);
    if (!session) return;
    await this.execute(session.cancel());
    this.registry.close(rideId);
  }

  async acceptOffer(offerId: OfferId, driverId: DriverId): Promise<Ride | undefined> {
    const offer = await this.deps.offers.findById(offerId);
    if (!offer) throw new Error('Offer not found');
    if (offer.driverId !== driverId) throw new Error('That offer belongs to another driver');

    const session = this.registry.get(offer.rideId);
    if (!session) return undefined;

    const commands = session.accept(offerId, this.deps.clock.now());
    if (commands.length === 0) return undefined;

    await this.deps.offers.update(offerId, {
      status: 'accepted',
      respondedAt: this.deps.clock.now(),
    });
    await this.execute(commands);
    this.registry.close(offer.rideId);
    return this.deps.rides.findById(offer.rideId);
  }

  async declineOffer(offerId: OfferId, driverId: DriverId): Promise<void> {
    const offer = await this.deps.offers.findById(offerId);
    if (!offer || offer.driverId !== driverId) return;

    const now = this.deps.clock.now();
    await this.deps.offers.update(offerId, { status: 'declined', respondedAt: now });
    await this.releaseDriver(driverId);

    const session = this.registry.get(offer.rideId);
    session?.decline(offerId, now);
    this.deps.events.emit('offer.declined', { offerId, driverId, rideId: offer.rideId });

    // Move to the next driver right away rather than waiting a full tick.
    if (session) await this.tickSession(session);
  }

  /** Advance every open search. Called on an interval, or by hand in tests. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const session of this.registry.active()) {
        await this.tickSession(session);
      }
      for (const session of this.registry.active()) {
        if (session.isFinished()) this.registry.close(session.rideId);
      }
    } finally {
      this.ticking = false;
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch((e) =>
        this.deps.logger?.error({ err: e }, 'dispatch tick failed'),
      );
    }, this.deps.config.dispatch.tickIntervalMs);
    // Never keep the process alive purely for dispatch.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  activeSearches(): number {
    return this.registry.active().length;
  }

  diagnosticsFor(rideId: RideId) {
    return this.registry.get(rideId)?.diagnostics();
  }

  // ------------------------------------------------------------- internals

  private async tickSession(session: DispatchSession): Promise<void> {
    const ride = await this.deps.rides.findById(session.rideId);
    // The ride was cancelled or otherwise left the search while we were away.
    if (!ride || ride.status !== 'requested') {
      await this.execute(session.cancel());
      this.registry.close(session.rideId);
      return;
    }

    const candidates = await this.gatherCandidates(ride);
    const commands = session.tick(this.deps.clock.now(), candidates);
    await this.execute(commands);
    if (session.isFinished()) this.registry.close(session.rideId);
  }

  /**
   * Turn nearby driver profiles into dispatch candidates, including the real
   * ETA from the routing provider when it can answer a matrix query in one
   * call. Falls back to a straight-line estimate otherwise.
   */
  private async gatherCandidates(ride: Ride): Promise<DriverCandidate[]> {
    const rideType = this.deps.catalog.require(ride.rideTypeId);
    const pickup = meetingPoint(ride.itinerary.pickup);
    const now = this.deps.clock.now();

    const nearby = await this.deps.drivers.findAvailableNear(
      pickup,
      this.deps.config.dispatch.maxSearchRadiusMeters,
      { staleAfterMs: this.deps.config.realtime.staleLocationMs, now },
    );
    if (nearby.length === 0) return [];

    const withVehicles = await Promise.all(
      nearby.map(async (driver) => ({
        driver,
        vehicle: driver.activeVehicleId
          ? await this.deps.vehicles.findById(driver.activeVehicleId)
          : undefined,
      })),
    );

    const usable = withVehicles.filter(
      (entry): entry is { driver: DriverProfile; vehicle: Vehicle } =>
        entry.vehicle !== undefined && entry.driver.lastPosition !== undefined,
    );
    if (usable.length === 0) return [];

    const etas = await this.estimateEtas(
      usable.map((u) => u.driver.lastPosition as LatLng),
      pickup,
    );

    return usable.map(({ driver, vehicle }, index) => {
      const position = driver.lastPosition!;
      const eligibleRideTypeIds = this.deps.catalog
        .list()
        .filter((type) => vehicleQualifies(type, vehicle, driver.rating))
        .map((type) => type.id);
      const estimate = etas[index];

      return {
        driverId: driver.id,
        vehicleId: vehicle.id,
        position,
        distanceMeters: estimate?.distanceMeters ?? haversineMeters(position, pickup),
        etaToPickupMs:
          estimate?.durationMs ??
          Math.round((haversineMeters(position, pickup) / 8.9) * 1000 * rideType.etaMultiplier),
        rating: driver.rating,
        acceptanceRate: driver.acceptanceRate,
        completionRate: driver.completionRate,
        eligibleRideTypeIds,
        acceptedRideTypeIds: driver.preferences.acceptedRideTypeIds,
        maxPickupDistanceMeters: driver.preferences.maxPickupDistanceMeters,
        autoAccept: driver.preferences.autoAcceptOffers,
        idleSinceMs: driver.lastOnlineAt ? now - driver.lastOnlineAt : 0,
        ...(driver.preferences.destinationFilter
          ? { destinationFilter: driver.preferences.destinationFilter }
          : {}),
      } satisfies DriverCandidate;
    });
  }

  private async estimateEtas(
    origins: readonly LatLng[],
    pickup: LatLng,
  ): Promise<({ distanceMeters: number; durationMs: number } | undefined)[]> {
    if (!this.deps.geo.matrix || origins.length === 0) return origins.map(() => undefined);
    try {
      const matrix = await this.deps.geo.matrix({
        origins: [...origins],
        destinations: [pickup],
        departAt: this.deps.clock.now(),
      });
      return origins.map((_, i) => {
        const estimate = matrix[i]?.[0];
        // An unreachable pair comes back as Infinity. Treating it as "no
        // estimate" falls through to the straight-line path below rather than
        // ranking that driver as instantly available.
        if (!estimate || !Number.isFinite(estimate.durationMs)) return undefined;
        return estimate;
      });
    } catch (e) {
      // A routing outage must not stop dispatch; fall back to straight lines.
      this.deps.logger?.error({ err: e }, 'ETA matrix failed; using straight-line estimates');
      return origins.map(() => undefined);
    }
  }

  private async execute(commands: readonly DispatchCommand[]): Promise<void> {
    for (const command of commands) {
      try {
        await this.executeOne(command);
      } catch (e) {
        this.deps.logger?.error({ err: e, command: command.type }, 'dispatch command failed');
      }
    }
  }

  private async executeOne(command: DispatchCommand): Promise<void> {
    switch (command.type) {
      case 'send_offer': {
        await this.sendOffer(command.offer);
        break;
      }
      case 'expire_offer': {
        const offer = await this.deps.offers.findById(command.offerId);
        // Only a still-pending offer expires; an accepted one must not be undone.
        if (offer?.status === 'pending') {
          await this.deps.offers.update(command.offerId, {
            status: 'expired',
            respondedAt: this.deps.clock.now(),
          });
          await this.releaseDriver(command.driverId);
          this.deps.events.emit('offer.expired', {
            offerId: command.offerId,
            driverId: command.driverId,
            rideId: offer.rideId,
          });
        }
        this.sessionByOffer.delete(command.offerId);
        break;
      }
      case 'assign_driver': {
        await this.handlers?.onAssign({
          rideId: command.rideId,
          driverId: command.driverId,
          vehicleId: command.vehicleId,
          offerId: command.offerId,
          pickupEtaMs: command.pickupEtaMs,
        });
        break;
      }
      case 'no_drivers_found': {
        await this.handlers?.onNoDrivers(command.rideId, command.searchedMs);
        this.registry.close(command.rideId);
        break;
      }
      case 'search_exhausted_round':
        this.deps.logger?.info(
          { rideId: command.rideId, round: command.round },
          'dispatch round found nobody; widening search',
        );
        break;
    }
  }

  private async sendOffer(offer: RideOffer): Promise<void> {
    await this.deps.offers.create(offer);
    this.sessionByOffer.set(offer.id, offer.rideId);
    this.registry.trackOffer(offer.id, offer.rideId);

    // Hold the driver so a second ride cannot offer to them concurrently.
    const driver = await this.deps.drivers.findById(offer.driverId);
    if (driver?.availability === 'available') {
      await this.deps.drivers.update(offer.driverId, { availability: 'offered' });
      this.deps.events.emit('driver.availability_changed', {
        driverId: offer.driverId,
        from: 'available',
        to: 'offered',
      });
    }
    this.deps.events.emit('offer.sent', { offer });
  }

  /** Return a driver to the pool after a decline, timeout, or lost race. */
  private async releaseDriver(driverId: DriverId): Promise<void> {
    const driver = await this.deps.drivers.findById(driverId);
    if (!driver || driver.availability !== 'offered') return;
    await this.deps.drivers.update(driverId, { availability: 'available' });
    this.deps.events.emit('driver.availability_changed', {
      driverId,
      from: 'offered',
      to: 'available',
    });
  }

  private async riderDisplayName(ride: Ride): Promise<string> {
    const rider = await this.deps.riders.findById(ride.riderId);
    if (!rider) return 'Rider';
    const user = await this.deps.users.findById(rider.userId);
    return user ? publicName(user) : 'Rider';
  }
}
