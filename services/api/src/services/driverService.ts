/**
 * Driver operations: onboarding, going online, location pings, offers, and
 * earnings. The ride lifecycle itself lives in `RideService` — this service
 * covers everything about the driver rather than about the trip.
 */

import {
  AppError,
  canGoOnline,
  missingDocuments,
  newVehicleId,
  vehicleQualifies,
  zero,
  add,
  type Clock,
  type DriverAvailability,
  type DriverDocument,
  type DriverPreferences,
  type DriverProfile,
  type DriverId,
  type DriverShift,
  type EarningsSummary,
  type LatLng,
  type Money,
  type PlatformConfig,
  type PlatformEvents,
  type Position,
  type RideOffer,
  type RideType,
  type RideTypeCatalog,
  type TypedEmitter,
  type Vehicle,
  type VehicleInput,
  type VehicleId,
} from '@lift/core';
import type {
  DriverRepository,
  OfferRepository,
  RideRepository,
  ShiftRepository,
  VehicleRepository,
} from '../repositories/types.js';
import type { DispatchRuntime } from './dispatchRuntime.js';

export interface DriverServiceDeps {
  readonly drivers: DriverRepository;
  readonly vehicles: VehicleRepository;
  readonly shifts: ShiftRepository;
  readonly rides: RideRepository;
  readonly offers: OfferRepository;
  readonly dispatch: DispatchRuntime;
  readonly catalog: RideTypeCatalog;
  readonly config: PlatformConfig;
  readonly clock: Clock;
  readonly events: TypedEmitter<PlatformEvents>;
}

/** What the driver's home screen needs in one call. */
export interface DriverStatus {
  readonly profile: DriverProfile;
  readonly vehicle?: Vehicle;
  readonly availability: DriverAvailability;
  readonly canGoOnline: boolean;
  readonly blockedReason?: string;
  readonly missingDocuments: readonly string[];
  readonly openShift?: DriverShift;
  readonly pendingOffers: readonly RideOffer[];
  readonly activeRideId?: string;
  /** Ride types this driver's vehicle qualifies for. */
  readonly eligibleRideTypes: readonly RideType[];
  readonly todayEarnings: EarningsSummary;
}

export class DriverService {
  constructor(private readonly deps: DriverServiceDeps) {}

  async getProfile(driverId: DriverId): Promise<DriverProfile> {
    const profile = await this.deps.drivers.findById(driverId);
    if (!profile) throw new AppError('not_found', 'Driver not found');
    return profile;
  }

  /** Everything the driver app's home screen renders. */
  async getStatus(driverId: DriverId): Promise<DriverStatus> {
    const profile = await this.getProfile(driverId);
    const now = this.deps.clock.now();
    const vehicle = profile.activeVehicleId
      ? await this.deps.vehicles.findById(profile.activeVehicleId)
      : undefined;
    const gate = canGoOnline(profile, now);
    const activeRide = await this.deps.rides.findActiveForDriver(driverId);
    const openShift = await this.deps.shifts.findOpen(driverId);

    return {
      profile,
      availability: profile.availability,
      canGoOnline: gate.allowed,
      missingDocuments: missingDocuments(profile, now),
      pendingOffers: await this.deps.offers.findPendingForDriver(driverId),
      eligibleRideTypes: vehicle
        ? this.deps.catalog.eligibleFor(vehicle, profile.rating)
        : [],
      todayEarnings: await this.earnings(driverId, startOfDay(now), now),
      ...(vehicle ? { vehicle } : {}),
      ...(gate.reason ? { blockedReason: gate.reason } : {}),
      ...(activeRide ? { activeRideId: activeRide.id } : {}),
      ...(openShift ? { openShift } : {}),
    };
  }

  // -------------------------------------------------------- going online

  /**
   * Go online. Refuses when onboarding is incomplete — the same check the
   * dispatcher relies on, applied at the point the driver would expect to hear
   * about it.
   */
  async goOnline(driverId: DriverId, position?: Position): Promise<DriverProfile> {
    const profile = await this.getProfile(driverId);
    const now = this.deps.clock.now();

    const gate = canGoOnline(profile, now);
    if (!gate.allowed) {
      throw new AppError('driver_unavailable', gate.reason ?? 'You cannot go online yet', {
        userMessage: gate.reason ?? 'You cannot go online yet.',
        details: { missingDocuments: missingDocuments(profile, now) },
      });
    }
    if (profile.availability !== 'offline') return profile;

    const updated = await this.deps.drivers.update(driverId, {
      availability: 'available',
      lastOnlineAt: now,
      ...(position ? { lastPosition: position } : {}),
    });

    // Reuse an open shift so a dropped connection does not split a day in two.
    const existingShift = await this.deps.shifts.findOpen(driverId);
    if (!existingShift) {
      const currency = this.deps.config.market.currency;
      await this.deps.shifts.open({
        id: `shift_${now.toString(36)}_${driverId}`,
        driverId,
        startedAt: now,
        ridesCompleted: 0,
        ridesDeclined: 0,
        offersReceived: 0,
        grossEarnings: zero(currency),
        tips: zero(currency),
        bonuses: zero(currency),
        onlineMillis: 0,
        distanceMeters: 0,
      });
    }

    this.deps.events.emit('driver.online', { driverId, at: now });
    this.deps.events.emit('driver.availability_changed', {
      driverId,
      from: 'offline',
      to: 'available',
    });
    return updated;
  }

  /** Go offline. A driver mid-trip stays on the ride until it ends. */
  async goOffline(driverId: DriverId): Promise<DriverProfile> {
    const profile = await this.getProfile(driverId);
    const now = this.deps.clock.now();

    if (profile.availability === 'on_ride') {
      throw new AppError('conflict', 'Finish your current ride before going offline', {
        userMessage: "You'll go offline once this ride is finished.",
      });
    }
    if (profile.availability === 'offline') return profile;

    const updated = await this.deps.drivers.update(driverId, { availability: 'offline' });

    const shift = await this.deps.shifts.findOpen(driverId);
    if (shift) {
      await this.deps.shifts.update(shift.id, {
        endedAt: now,
        onlineMillis: shift.onlineMillis + (now - shift.startedAt),
      });
    }

    this.deps.events.emit('driver.offline', {
      driverId,
      at: now,
      shiftMillis: shift ? now - shift.startedAt : 0,
    });
    this.deps.events.emit('driver.availability_changed', {
      driverId,
      from: profile.availability,
      to: 'offline',
    });
    return updated;
  }

  /** A soft pause: stay online but stop receiving offers. */
  async setBusy(driverId: DriverId, busy: boolean): Promise<DriverProfile> {
    const profile = await this.getProfile(driverId);
    if (profile.availability === 'on_ride' || profile.availability === 'offline') {
      return profile;
    }
    const to: DriverAvailability = busy ? 'busy' : 'available';
    const updated = await this.deps.drivers.update(driverId, { availability: to });
    this.deps.events.emit('driver.availability_changed', {
      driverId,
      from: profile.availability,
      to,
    });
    return updated;
  }

  // ------------------------------------------------------------- location

  /**
   * Record a location ping. The hot write path — a fleet of N drivers produces
   * a ping every few seconds each — so it does the minimum: index the position
   * and publish it.
   */
  async updateLocation(driverId: DriverId, position: Position): Promise<void> {
    await this.deps.drivers.updatePosition(driverId, position);
    const activeRide = await this.deps.rides.findActiveForDriver(driverId);
    this.deps.events.emit('driver.location_updated', {
      driverId,
      position,
      ...(activeRide ? { rideId: activeRide.id } : {}),
    });
  }

  // --------------------------------------------------------------- offers

  async acceptOffer(driverId: DriverId, offerId: string) {
    const profile = await this.getProfile(driverId);
    if (profile.availability === 'on_ride') {
      throw new AppError('driver_already_on_ride', 'You are already on a ride');
    }
    const ride = await this.deps.dispatch.acceptOffer(offerId as never, driverId);
    if (!ride) {
      // The offer expired, or another driver won the race.
      await this.recordOfferResponse(driverId, 'lost');
      throw new AppError('offer_already_resolved', 'That offer is no longer available');
    }
    await this.recordOfferResponse(driverId, 'accepted');
    return ride;
  }

  async declineOffer(driverId: DriverId, offerId: string): Promise<void> {
    await this.deps.dispatch.declineOffer(offerId as never, driverId);
    await this.recordOfferResponse(driverId, 'declined');
  }

  async pendingOffers(driverId: DriverId): Promise<RideOffer[]> {
    return this.deps.offers.findPendingForDriver(driverId);
  }

  // ---------------------------------------------------------- preferences

  async updatePreferences(
    driverId: DriverId,
    patch: Partial<DriverPreferences>,
  ): Promise<DriverProfile> {
    const profile = await this.getProfile(driverId);
    return this.deps.drivers.update(driverId, {
      preferences: { ...profile.preferences, ...patch },
    });
  }

  /** Only take rides heading toward a destination, until a deadline. */
  async setDestinationFilter(
    driverId: DriverId,
    filter: { address: string; lat: number; lng: number; radiusMeters?: number; durationMs?: number } | null,
  ): Promise<DriverProfile> {
    const profile = await this.getProfile(driverId);
    if (!filter) {
      const { destinationFilter: _removed, ...rest } = profile.preferences;
      return this.deps.drivers.update(driverId, { preferences: rest });
    }
    return this.deps.drivers.update(driverId, {
      preferences: {
        ...profile.preferences,
        destinationFilter: {
          address: filter.address,
          lat: filter.lat,
          lng: filter.lng,
          radiusMeters: filter.radiusMeters ?? 3_000,
          expiresAt: this.deps.clock.now() + (filter.durationMs ?? 2 * 60 * 60 * 1000),
        },
      },
    });
  }

  // ------------------------------------------------------------- vehicles

  async addVehicle(driverId: DriverId, input: VehicleInput): Promise<Vehicle> {
    const now = this.deps.clock.now();
    const vehicle: Vehicle = {
      id: newVehicleId(),
      driverId,
      make: input.make,
      model: input.model,
      year: input.year,
      color: input.color,
      licensePlate: input.licensePlate.toUpperCase(),
      seats: input.seats,
      features: input.features,
      activatedAt: now,
      ...(input.photoUrl ? { photoUrl: input.photoUrl } : {}),
    };
    const created = await this.deps.vehicles.create(vehicle);

    // A driver's first vehicle becomes their active one automatically.
    const profile = await this.getProfile(driverId);
    if (!profile.activeVehicleId) {
      await this.deps.drivers.update(driverId, { activeVehicleId: created.id });
    }
    return created;
  }

  async listVehicles(driverId: DriverId): Promise<Vehicle[]> {
    return this.deps.vehicles.findByDriver(driverId);
  }

  async setActiveVehicle(driverId: DriverId, vehicleId: VehicleId): Promise<DriverProfile> {
    const vehicle = await this.deps.vehicles.findById(vehicleId);
    if (!vehicle || vehicle.driverId !== driverId) {
      throw new AppError('not_found', 'Vehicle not found');
    }
    const profile = await this.getProfile(driverId);
    if (profile.availability === 'on_ride') {
      throw new AppError('conflict', 'You cannot switch vehicles mid-ride');
    }
    return this.deps.drivers.update(driverId, { activeVehicleId: vehicleId });
  }

  /** Ride types a vehicle qualifies for, with the reason when it does not. */
  qualification(vehicle: Vehicle, driverRating: number) {
    return this.deps.catalog.list().map((type) => ({
      rideType: type,
      qualifies: vehicleQualifies(type, vehicle, driverRating),
    }));
  }

  // ------------------------------------------------------------ documents

  async submitDocument(
    driverId: DriverId,
    document: DriverDocument,
  ): Promise<DriverProfile> {
    const profile = await this.getProfile(driverId);
    const documents = [
      ...profile.documents.filter((d) => d.type !== document.type),
      document,
    ];
    const updated = await this.deps.drivers.update(driverId, { documents });

    // Once nothing is outstanding, move the driver into review automatically.
    if (
      updated.approvalStatus === 'incomplete' &&
      missingDocuments(updated, this.deps.clock.now()).length === 0
    ) {
      return this.deps.drivers.update(driverId, { approvalStatus: 'pending_review' });
    }
    return updated;
  }

  // ------------------------------------------------------------- earnings

  /** Roll up a driver's completed rides over a period. */
  async earnings(driverId: DriverId, since: number, until: number): Promise<EarningsSummary> {
    const currency = this.deps.config.market.currency;
    const rides = await this.deps.rides.query({
      driverId,
      statuses: ['completed'],
      since,
      until,
      limit: 1000,
    });

    let rideEarnings: Money = zero(currency);
    let tips: Money = zero(currency);
    let distanceMeters = 0;

    for (const ride of rides) {
      const fare = ride.finalFare;
      if (!fare) continue;
      const tipItems = fare.items.filter((i) => i.kind === 'tip');
      const tipTotal = tipItems.reduce((sum, i) => sum + i.amount.amount, 0);
      // driverPayout already includes tips; separate them for the breakdown.
      rideEarnings = add(rideEarnings, {
        amount: fare.driverPayout.amount - tipTotal,
        currency,
      });
      tips = add(tips, { amount: tipTotal, currency });
      distanceMeters += fare.distanceMeters;
    }

    const shifts = await this.deps.shifts.listForDriver(driverId, since);
    const onlineMillis = shifts.reduce(
      (sum, s) => sum + (s.endedAt ? s.endedAt - s.startedAt : until - s.startedAt),
      0,
    );

    const bonuses = zero(currency);
    const total = add(add(rideEarnings, tips), bonuses);
    const hours = onlineMillis / 3_600_000;

    return {
      periodStart: since,
      periodEnd: until,
      rideEarnings,
      tips,
      bonuses,
      total,
      ridesCompleted: rides.length,
      onlineMillis,
      distanceMeters,
      perHour: {
        amount: hours > 0 ? Math.round(total.amount / hours) : 0,
        currency,
      },
    };
  }

  /** Availability counts across the fleet — the ops console's headline number. */
  async fleetSnapshot(): Promise<Record<string, number>> {
    return this.deps.drivers.countByAvailability();
  }

  async nearbyDrivers(center: LatLng, radiusMeters: number): Promise<DriverProfile[]> {
    return this.deps.drivers.findAvailableNear(center, radiusMeters, {
      staleAfterMs: this.deps.config.realtime.staleLocationMs,
      now: this.deps.clock.now(),
    });
  }

  /** Keep acceptance and completion rates current as offers resolve. */
  private async recordOfferResponse(
    driverId: DriverId,
    outcome: 'accepted' | 'declined' | 'lost',
  ): Promise<void> {
    // A race lost to another driver is not the driver's choice, so it does not
    // count against their acceptance rate.
    if (outcome === 'lost') return;

    const profile = await this.getProfile(driverId);
    const shift = await this.deps.shifts.findOpen(driverId);
    if (shift) {
      await this.deps.shifts.update(shift.id, {
        offersReceived: shift.offersReceived + 1,
        ridesDeclined: shift.ridesDeclined + (outcome === 'declined' ? 1 : 0),
      });
    }

    // Exponential moving average: recent behaviour matters more than history.
    const alpha = 0.05;
    const observed = outcome === 'accepted' ? 1 : 0;
    await this.deps.drivers.update(driverId, {
      acceptanceRate: Number(
        (profile.acceptanceRate * (1 - alpha) + observed * alpha).toFixed(4),
      ),
    });
  }
}

const startOfDay = (at: number): number => {
  const date = new Date(at);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
};
