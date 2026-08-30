/**
 * The in-memory store.
 *
 * The platform's default persistence layer: zero setup, and fast enough that
 * the entire API test suite and the fleet simulator run against it. It
 * implements exactly the same ports as PostgreSQL, so anything that works here
 * works there.
 *
 * Everything is stored as immutable snapshots; reads return the stored object
 * rather than a copy, and every write replaces rather than mutates, which
 * matches how the domain layer already treats its entities.
 */

import {
  ACTIVE_RIDE_STATUSES,
  systemClock,
  cellKey,
  haversineMeters,
  neighborCells,
  notFound,
  type Charge,
  type ChargeId,
  type Clock,
  type DriverId,
  type DriverProfile,
  type DriverShift,
  type LatLng,
  type OfferId,
  type PaymentMethod,
  type PaymentMethodId,
  type Place,
  type PlaceId,
  type Position,
  type Ride,
  type RideId,
  type RideOffer,
  type RiderId,
  type RiderProfile,
  type SavedPlace,
  type SessionId,
  type SupportTicket,
  type TicketId,
  type User,
  type UserId,
  type Vehicle,
  type VehicleId,
} from '@lift/core';
import type {
  ChatMessage,
  ChatRepository,
  ChargeRepository,
  DriverRepository,
  OfferRepository,
  PaymentMethodRepository,
  Repositories,
  RideQuery,
  RideRepository,
  RiderRepository,
  SessionRecord,
  SessionRepository,
  ShiftRepository,
  SupportRepository,
  TicketQuery,
  UserRepository,
  VehicleRepository,
  VerificationRecord,
  VerificationRepository,
} from '../types.js';

/** Grid resolution for the driver index; ~1.1 km cells. */
const DRIVER_GRID_DEGREES = 0.01;

class MemoryUserRepository implements UserRepository {
  private readonly byId = new Map<UserId, User>();
  private readonly byPhone = new Map<string, UserId>();

  async create(user: User): Promise<User> {
    if (this.byPhone.has(user.phone)) {
      throw new Error(`A user already exists with phone ${user.phone}`);
    }
    this.byId.set(user.id, user);
    this.byPhone.set(user.phone, user.id);
    return user;
  }

  async findById(id: UserId): Promise<User | undefined> {
    return this.byId.get(id);
  }

  async findByPhone(phone: string): Promise<User | undefined> {
    const id = this.byPhone.get(phone);
    return id ? this.byId.get(id) : undefined;
  }

  async update(id: UserId, patch: Partial<User>): Promise<User> {
    const existing = this.byId.get(id);
    if (!existing) throw notFound('User');
    const next = { ...existing, ...patch, id };
    if (patch.phone && patch.phone !== existing.phone) {
      this.byPhone.delete(existing.phone);
      this.byPhone.set(patch.phone, id);
    }
    this.byId.set(id, next);
    return next;
  }

  async list(limit = 100): Promise<User[]> {
    return [...this.byId.values()].slice(0, limit);
  }
}

class MemorySessionRepository implements SessionRepository {
  private readonly byToken = new Map<string, SessionRecord>();
  private readonly byUser = new Map<UserId, Set<string>>();

  constructor(private readonly clock: Clock) {}

  async create(session: SessionRecord): Promise<SessionRecord> {
    this.byToken.set(session.token, session);
    let tokens = this.byUser.get(session.userId);
    if (!tokens) {
      tokens = new Set();
      this.byUser.set(session.userId, tokens);
    }
    tokens.add(session.token);
    return session;
  }

  async findByToken(token: string): Promise<SessionRecord | undefined> {
    const session = this.byToken.get(token);
    if (!session) return undefined;
    // Expired sessions are indistinguishable from absent ones.
    if (session.expiresAt <= this.clock.now()) {
      await this.revoke(token);
      return undefined;
    }
    return session;
  }

  async touch(token: string, at: number): Promise<void> {
    const session = this.byToken.get(token);
    if (session) this.byToken.set(token, { ...session, lastSeenAt: at });
  }

  async revoke(token: string): Promise<void> {
    const session = this.byToken.get(token);
    if (!session) return;
    this.byToken.delete(token);
    this.byUser.get(session.userId)?.delete(token);
  }

  async revokeAllForUser(userId: UserId): Promise<void> {
    for (const token of this.byUser.get(userId) ?? []) this.byToken.delete(token);
    this.byUser.delete(userId);
  }
}

class MemoryVerificationRepository implements VerificationRepository {
  private readonly byPhone = new Map<string, VerificationRecord>();

  constructor(private readonly clock: Clock) {}

  async put(record: VerificationRecord): Promise<void> {
    this.byPhone.set(record.phone, record);
  }

  async get(phone: string): Promise<VerificationRecord | undefined> {
    const record = this.byPhone.get(phone);
    if (record && record.expiresAt <= this.clock.now()) {
      this.byPhone.delete(phone);
      return undefined;
    }
    return record;
  }

  async incrementAttempts(phone: string): Promise<void> {
    const record = this.byPhone.get(phone);
    if (record) this.byPhone.set(phone, { ...record, attempts: record.attempts + 1 });
  }

  async clear(phone: string): Promise<void> {
    this.byPhone.delete(phone);
  }
}

class MemoryRiderRepository implements RiderRepository {
  private readonly byId = new Map<RiderId, RiderProfile>();
  private readonly byUserId = new Map<UserId, RiderId>();

  constructor(private readonly rides: () => RideRepository) {}

  async create(profile: RiderProfile): Promise<RiderProfile> {
    this.byId.set(profile.id, profile);
    this.byUserId.set(profile.userId, profile.id);
    return profile;
  }

  async findById(id: RiderId): Promise<RiderProfile | undefined> {
    return this.byId.get(id);
  }

  async findByUserId(userId: UserId): Promise<RiderProfile | undefined> {
    const id = this.byUserId.get(userId);
    return id ? this.byId.get(id) : undefined;
  }

  async update(id: RiderId, patch: Partial<RiderProfile>): Promise<RiderProfile> {
    const existing = this.byId.get(id);
    if (!existing) throw notFound('Rider');
    const next = { ...existing, ...patch, id };
    this.byId.set(id, next);
    return next;
  }

  async addSavedPlace(id: RiderId, place: SavedPlace): Promise<RiderProfile> {
    const existing = this.byId.get(id);
    if (!existing) throw notFound('Rider');
    // A label is a shortcut, so re-saving "Home" replaces it rather than
    // leaving the rider with two.
    const savedPlaces = [
      ...existing.savedPlaces.filter(
        (s) => s.label.toLowerCase() !== place.label.toLowerCase(),
      ),
      place,
    ];
    return this.update(id, { savedPlaces });
  }

  async removeSavedPlace(id: RiderId, placeId: PlaceId): Promise<RiderProfile> {
    const existing = this.byId.get(id);
    if (!existing) throw notFound('Rider');
    return this.update(id, {
      savedPlaces: existing.savedPlaces.filter((s) => s.id !== placeId),
    });
  }

  async recentPlaces(id: RiderId, limit: number): Promise<Place[]> {
    const rides = await this.rides().query({
      riderId: id,
      statuses: ['completed'],
      limit: 50,
    });
    const seen = new Set<string>();
    const places: Place[] = [];
    for (const ride of rides) {
      const place = ride.itinerary.dropoff;
      const key = `${place.coordinates.lat.toFixed(4)},${place.coordinates.lng.toFixed(4)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      places.push(place);
      if (places.length >= limit) break;
    }
    return places;
  }
}

class MemoryDriverRepository implements DriverRepository {
  private readonly byId = new Map<DriverId, DriverProfile>();
  private readonly byUserId = new Map<UserId, DriverId>();
  /** Grid cell → driver ids. Keeps radius queries off a full scan. */
  private readonly grid = new Map<string, Set<DriverId>>();
  private readonly cellOf = new Map<DriverId, string>();

  async create(profile: DriverProfile): Promise<DriverProfile> {
    this.byId.set(profile.id, profile);
    this.byUserId.set(profile.userId, profile.id);
    if (profile.lastPosition) this.reindex(profile.id, profile.lastPosition);
    return profile;
  }

  async findById(id: DriverId): Promise<DriverProfile | undefined> {
    return this.byId.get(id);
  }

  async findByUserId(userId: UserId): Promise<DriverProfile | undefined> {
    const id = this.byUserId.get(userId);
    return id ? this.byId.get(id) : undefined;
  }

  async update(id: DriverId, patch: Partial<DriverProfile>): Promise<DriverProfile> {
    const existing = this.byId.get(id);
    if (!existing) throw notFound('Driver');
    const next = { ...existing, ...patch, id };
    this.byId.set(id, next);
    if (patch.lastPosition) this.reindex(id, patch.lastPosition);
    return next;
  }

  async updatePosition(id: DriverId, position: Position): Promise<void> {
    const existing = this.byId.get(id);
    if (!existing) throw notFound('Driver');
    this.byId.set(id, { ...existing, lastPosition: position });
    this.reindex(id, position);
  }

  async findAvailableNear(
    center: LatLng,
    radiusMeters: number,
    options: { staleAfterMs?: number; now?: number } = {},
  ): Promise<DriverProfile[]> {
    const now = options.now ?? Date.now();
    const staleAfterMs = options.staleAfterMs ?? Number.POSITIVE_INFINITY;
    const out: DriverProfile[] = [];

    for (const key of neighborCells(center, radiusMeters, DRIVER_GRID_DEGREES)) {
      for (const driverId of this.grid.get(key) ?? []) {
        const driver = this.byId.get(driverId);
        if (!driver?.lastPosition) continue;
        if (driver.approvalStatus !== 'approved') continue;
        if (driver.availability !== 'available') continue;
        // A driver whose app stopped reporting is not dispatchable.
        if (now - driver.lastPosition.timestamp > staleAfterMs) continue;
        if (haversineMeters(center, driver.lastPosition) > radiusMeters) continue;
        out.push(driver);
      }
    }
    return out;
  }

  async list(limit = 200): Promise<DriverProfile[]> {
    return [...this.byId.values()].slice(0, limit);
  }

  async countByAvailability(): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const driver of this.byId.values()) {
      counts[driver.availability] = (counts[driver.availability] ?? 0) + 1;
    }
    return counts;
  }

  private reindex(id: DriverId, position: LatLng): void {
    const key = cellKey(position, DRIVER_GRID_DEGREES);
    const previous = this.cellOf.get(id);
    if (previous === key) return;
    if (previous) this.grid.get(previous)?.delete(id);
    let bucket = this.grid.get(key);
    if (!bucket) {
      bucket = new Set();
      this.grid.set(key, bucket);
    }
    bucket.add(id);
    this.cellOf.set(id, key);
  }
}

class MemoryVehicleRepository implements VehicleRepository {
  private readonly byId = new Map<VehicleId, Vehicle>();

  async create(vehicle: Vehicle): Promise<Vehicle> {
    this.byId.set(vehicle.id, vehicle);
    return vehicle;
  }

  async findById(id: VehicleId): Promise<Vehicle | undefined> {
    return this.byId.get(id);
  }

  async findByDriver(driverId: DriverId): Promise<Vehicle[]> {
    return [...this.byId.values()].filter((v) => v.driverId === driverId);
  }

  async update(id: VehicleId, patch: Partial<Vehicle>): Promise<Vehicle> {
    const existing = this.byId.get(id);
    if (!existing) throw notFound('Vehicle');
    const next = { ...existing, ...patch, id };
    this.byId.set(id, next);
    return next;
  }
}

class MemoryShiftRepository implements ShiftRepository {
  private readonly byId = new Map<string, DriverShift>();

  async open(shift: DriverShift): Promise<DriverShift> {
    this.byId.set(shift.id, shift);
    return shift;
  }

  async findOpen(driverId: DriverId): Promise<DriverShift | undefined> {
    for (const shift of this.byId.values()) {
      if (shift.driverId === driverId && shift.endedAt === undefined) return shift;
    }
    return undefined;
  }

  async update(id: string, patch: Partial<DriverShift>): Promise<DriverShift> {
    const existing = this.byId.get(id);
    if (!existing) throw notFound('Shift');
    const next = { ...existing, ...patch, id };
    this.byId.set(id, next);
    return next;
  }

  async listForDriver(driverId: DriverId, since: number): Promise<DriverShift[]> {
    return [...this.byId.values()]
      .filter((s) => s.driverId === driverId && s.startedAt >= since)
      .sort((a, b) => b.startedAt - a.startedAt);
  }
}

class MemoryRideRepository implements RideRepository {
  private readonly byId = new Map<RideId, Ride>();

  async create(ride: Ride): Promise<Ride> {
    this.byId.set(ride.id, ride);
    return ride;
  }

  async findById(id: RideId): Promise<Ride | undefined> {
    return this.byId.get(id);
  }

  async save(ride: Ride, expectedUpdatedAt?: number): Promise<Ride | undefined> {
    const current = this.byId.get(ride.id);
    if (!current) throw notFound('Ride');
    // Optimistic concurrency: refuse a write built on a stale read.
    if (expectedUpdatedAt !== undefined && current.updatedAt !== expectedUpdatedAt) {
      return undefined;
    }
    this.byId.set(ride.id, ride);
    return ride;
  }

  async query(query: RideQuery): Promise<Ride[]> {
    let rides = [...this.byId.values()];
    if (query.riderId) rides = rides.filter((r) => r.riderId === query.riderId);
    if (query.driverId) {
      rides = rides.filter((r) => r.assignment?.driverId === query.driverId);
    }
    if (query.statuses) {
      const statuses = new Set(query.statuses);
      rides = rides.filter((r) => statuses.has(r.status));
    }
    if (query.since !== undefined) rides = rides.filter((r) => r.createdAt >= query.since!);
    if (query.until !== undefined) rides = rides.filter((r) => r.createdAt <= query.until!);
    rides.sort((a, b) => b.createdAt - a.createdAt);
    const offset = query.offset ?? 0;
    return rides.slice(offset, offset + (query.limit ?? 25));
  }

  async findActiveForRider(riderId: RiderId): Promise<Ride | undefined> {
    return [...this.byId.values()]
      .filter((r) => r.riderId === riderId && ACTIVE_RIDE_STATUSES.includes(r.status))
      .sort((a, b) => b.createdAt - a.createdAt)[0];
  }

  async findActiveForDriver(driverId: DriverId): Promise<Ride | undefined> {
    return [...this.byId.values()]
      .filter(
        (r) =>
          r.assignment?.driverId === driverId && ACTIVE_RIDE_STATUSES.includes(r.status),
      )
      .sort((a, b) => b.createdAt - a.createdAt)[0];
  }

  async findSearching(): Promise<Ride[]> {
    return [...this.byId.values()].filter((r) => r.status === 'requested');
  }

  async findDueScheduled(now: number, leadMs: number): Promise<Ride[]> {
    return [...this.byId.values()].filter(
      (r) =>
        r.status === 'scheduled' &&
        r.scheduledFor !== undefined &&
        r.scheduledFor - leadMs <= now,
    );
  }

  async count(query: RideQuery): Promise<number> {
    const all = await this.query({ ...query, limit: Number.MAX_SAFE_INTEGER, offset: 0 });
    return all.length;
  }
}

class MemoryOfferRepository implements OfferRepository {
  private readonly byId = new Map<OfferId, RideOffer>();

  constructor(private readonly clock: Clock) {}

  async create(offer: RideOffer): Promise<RideOffer> {
    this.byId.set(offer.id, offer);
    return offer;
  }

  async findById(id: OfferId): Promise<RideOffer | undefined> {
    return this.byId.get(id);
  }

  async update(id: OfferId, patch: Partial<RideOffer>): Promise<RideOffer> {
    const existing = this.byId.get(id);
    if (!existing) throw notFound('Offer');
    const next = { ...existing, ...patch, id };
    this.byId.set(id, next);
    return next;
  }

  async findPendingForDriver(driverId: DriverId): Promise<RideOffer[]> {
    const now = this.clock.now();
    return [...this.byId.values()].filter(
      (o) => o.driverId === driverId && o.status === 'pending' && o.expiresAt > now,
    );
  }

  async findForRide(rideId: RideId): Promise<RideOffer[]> {
    return [...this.byId.values()]
      .filter((o) => o.rideId === rideId)
      .sort((a, b) => a.sentAt - b.sentAt);
  }
}

class MemoryPaymentMethodRepository implements PaymentMethodRepository {
  private readonly byId = new Map<PaymentMethodId, PaymentMethod>();

  async create(method: PaymentMethod): Promise<PaymentMethod> {
    this.byId.set(method.id, method);
    if (method.isDefault) await this.setDefault(method.riderId, method.id);
    return this.byId.get(method.id)!;
  }

  async findById(id: PaymentMethodId): Promise<PaymentMethod | undefined> {
    return this.byId.get(id);
  }

  async listForRider(riderId: RiderId): Promise<PaymentMethod[]> {
    return [...this.byId.values()]
      .filter((m) => m.riderId === riderId && !m.removedAt)
      .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.createdAt - b.createdAt);
  }

  async update(id: PaymentMethodId, patch: Partial<PaymentMethod>): Promise<PaymentMethod> {
    const existing = this.byId.get(id);
    if (!existing) throw notFound('Payment method');
    const next = { ...existing, ...patch, id };
    this.byId.set(id, next);
    return next;
  }

  async setDefault(riderId: RiderId, id: PaymentMethodId): Promise<void> {
    for (const method of this.byId.values()) {
      if (method.riderId !== riderId) continue;
      this.byId.set(method.id, { ...method, isDefault: method.id === id });
    }
  }
}

class MemoryChargeRepository implements ChargeRepository {
  private readonly byId = new Map<ChargeId, Charge>();
  private readonly byIdempotencyKey = new Map<string, ChargeId>();

  async create(charge: Charge, idempotencyKey?: string): Promise<Charge> {
    // A repeated key must return the original charge, never authorize twice.
    if (idempotencyKey) {
      const existingId = this.byIdempotencyKey.get(idempotencyKey);
      const existing = existingId ? this.byId.get(existingId) : undefined;
      if (existing) return existing;
    }
    this.byId.set(charge.id, charge);
    if (idempotencyKey) this.byIdempotencyKey.set(idempotencyKey, charge.id);
    return charge;
  }

  async findById(id: ChargeId): Promise<Charge | undefined> {
    return this.byId.get(id);
  }

  async findByIdempotencyKey(key: string): Promise<Charge | undefined> {
    const id = this.byIdempotencyKey.get(key);
    return id ? this.byId.get(id) : undefined;
  }

  async update(id: ChargeId, patch: Partial<Charge>): Promise<Charge> {
    const existing = this.byId.get(id);
    if (!existing) throw notFound('Charge');
    const next = { ...existing, ...patch, id };
    this.byId.set(id, next);
    return next;
  }

  async listForRide(rideId: RideId): Promise<Charge[]> {
    return [...this.byId.values()].filter((c) => c.rideId === rideId);
  }

  async listForRider(riderId: RiderId, limit: number): Promise<Charge[]> {
    return [...this.byId.values()]
      .filter((c) => c.riderId === riderId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit);
  }
}

class MemoryChatRepository implements ChatRepository {
  private readonly byRide = new Map<RideId, ChatMessage[]>();

  async append(message: ChatMessage): Promise<ChatMessage> {
    const existing = this.byRide.get(message.rideId) ?? [];
    this.byRide.set(message.rideId, [...existing, message]);
    return message;
  }

  async listForRide(rideId: RideId): Promise<ChatMessage[]> {
    return this.byRide.get(rideId) ?? [];
  }

  async markRead(rideId: RideId, reader: 'rider' | 'driver', at: number): Promise<void> {
    const messages = this.byRide.get(rideId);
    if (!messages) return;
    this.byRide.set(
      rideId,
      // A reader marks the *other* party's messages as read.
      messages.map((m) => (m.from !== reader && !m.readAt ? { ...m, readAt: at } : m)),
    );
  }
}

/**
 * Build the full in-memory repository bundle.
 *
 * The clock is injected because expiry decisions — sessions, verification
 * codes, pending offers — must agree with whatever clock the rest of the
 * platform is running on, including a hand-driven one in tests.
 */
class MemorySupportRepository implements SupportRepository {
  private readonly byId = new Map<TicketId, SupportTicket>();

  async create(ticket: SupportTicket): Promise<SupportTicket> {
    this.byId.set(ticket.id, ticket);
    return ticket;
  }

  async findById(id: TicketId): Promise<SupportTicket | undefined> {
    return this.byId.get(id);
  }

  async save(ticket: SupportTicket, expectedUpdatedAt?: number): Promise<SupportTicket | undefined> {
    const current = this.byId.get(ticket.id);
    if (!current) throw notFound(`Ticket ${ticket.id}`);
    // Same optimistic guard as rides: a stale writer loses rather than wins.
    if (expectedUpdatedAt !== undefined && current.updatedAt !== expectedUpdatedAt) {
      return undefined;
    }
    this.byId.set(ticket.id, ticket);
    return ticket;
  }

  async query(query: TicketQuery): Promise<SupportTicket[]> {
    let tickets = [...this.byId.values()];
    if (query.requesterId) tickets = tickets.filter((t) => t.requesterId === query.requesterId);
    if (query.rideId) tickets = tickets.filter((t) => t.rideId === query.rideId);
    if (query.statuses) {
      const wanted = new Set(query.statuses);
      tickets = tickets.filter((t) => wanted.has(t.status));
    }
    // Most recently touched first — a support queue is read newest-activity down.
    tickets.sort((a, b) => b.updatedAt - a.updatedAt);
    return query.limit ? tickets.slice(0, query.limit) : tickets;
  }

  async countByStatus(): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const ticket of this.byId.values()) {
      counts[ticket.status] = (counts[ticket.status] ?? 0) + 1;
    }
    return counts;
  }
}

export const createMemoryRepositories = (clock: Clock = systemClock): Repositories => {
  const rides = new MemoryRideRepository();
  const charges = new MemoryChargeRepository();
  return {
    users: new MemoryUserRepository(),
    sessions: new MemorySessionRepository(clock),
    verifications: new MemoryVerificationRepository(clock),
    riders: new MemoryRiderRepository(() => rides),
    drivers: new MemoryDriverRepository(),
    vehicles: new MemoryVehicleRepository(),
    shifts: new MemoryShiftRepository(),
    rides,
    offers: new MemoryOfferRepository(clock),
    paymentMethods: new MemoryPaymentMethodRepository(),
    charges,
    chat: new MemoryChatRepository(),
    support: new MemorySupportRepository(),
    close: async () => {},
  };
};

export type { SessionId };
