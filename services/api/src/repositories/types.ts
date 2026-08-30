/**
 * Repository ports.
 *
 * Every persistence concern in the platform is expressed as one of these
 * interfaces. Two implementations ship: an in-memory one (the default — the
 * whole platform runs with no database) and a PostgreSQL one. Because the
 * services depend on these interfaces rather than on a driver, swapping the
 * store is a wiring change in the container and nothing else.
 */

import type {
  Charge,
  ChargeId,
  DriverId,
  DriverProfile,
  DriverShift,
  LatLng,
  MessageId,
  OfferId,
  PaymentMethod,
  PaymentMethodId,
  Place,
  PlaceId,
  Position,
  PromoRedemption,
  Ride,
  RideId,
  RideOffer,
  RideStatus,
  RiderId,
  RiderProfile,
  SavedPlace,
  SessionId,
  SupportTicket,
  TicketId,
  TicketStatus,
  User,
  UserId,
  Vehicle,
  VehicleId,
} from '@lift/core';

// ------------------------------------------------------------------ users

export interface UserRepository {
  create(user: User): Promise<User>;
  findById(id: UserId): Promise<User | undefined>;
  findByPhone(phone: string): Promise<User | undefined>;
  update(id: UserId, patch: Partial<User>): Promise<User>;
  list(limit?: number): Promise<User[]>;
}

export interface SessionRecord {
  readonly id: SessionId;
  readonly token: string;
  readonly userId: UserId;
  readonly role: 'rider' | 'driver' | 'admin';
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly lastSeenAt: number;
}

export interface SessionRepository {
  create(session: SessionRecord): Promise<SessionRecord>;
  findByToken(token: string): Promise<SessionRecord | undefined>;
  touch(token: string, at: number): Promise<void>;
  revoke(token: string): Promise<void>;
  revokeAllForUser(userId: UserId): Promise<void>;
}

/** One-time codes for phone verification. */
export interface VerificationRecord {
  readonly phone: string;
  readonly code: string;
  readonly expiresAt: number;
  readonly attempts: number;
}

export interface VerificationRepository {
  put(record: VerificationRecord): Promise<void>;
  get(phone: string): Promise<VerificationRecord | undefined>;
  incrementAttempts(phone: string): Promise<void>;
  clear(phone: string): Promise<void>;
}

// ----------------------------------------------------------------- riders

export interface RiderRepository {
  create(profile: RiderProfile): Promise<RiderProfile>;
  findById(id: RiderId): Promise<RiderProfile | undefined>;
  findByUserId(userId: UserId): Promise<RiderProfile | undefined>;
  update(id: RiderId, patch: Partial<RiderProfile>): Promise<RiderProfile>;
  addSavedPlace(id: RiderId, place: SavedPlace): Promise<RiderProfile>;
  removeSavedPlace(id: RiderId, placeId: PlaceId): Promise<RiderProfile>;
  /** Dropoffs from the rider's recent completed trips, most recent first. */
  recentPlaces(id: RiderId, limit: number): Promise<Place[]>;
}

// ---------------------------------------------------------------- drivers

export interface DriverRepository {
  create(profile: DriverProfile): Promise<DriverProfile>;
  findById(id: DriverId): Promise<DriverProfile | undefined>;
  findByUserId(userId: UserId): Promise<DriverProfile | undefined>;
  update(id: DriverId, patch: Partial<DriverProfile>): Promise<DriverProfile>;
  /**
   * Drivers available for dispatch within a radius. The hot path of the entire
   * platform — the memory implementation keeps a grid index, and the Postgres
   * one uses an indexed bounding-box query.
   */
  findAvailableNear(
    center: LatLng,
    radiusMeters: number,
    options?: { staleAfterMs?: number; now?: number },
  ): Promise<DriverProfile[]>;
  updatePosition(id: DriverId, position: Position): Promise<void>;
  list(limit?: number): Promise<DriverProfile[]>;
  countByAvailability(): Promise<Record<string, number>>;
}

export interface VehicleRepository {
  create(vehicle: Vehicle): Promise<Vehicle>;
  findById(id: VehicleId): Promise<Vehicle | undefined>;
  findByDriver(driverId: DriverId): Promise<Vehicle[]>;
  update(id: VehicleId, patch: Partial<Vehicle>): Promise<Vehicle>;
}

export interface ShiftRepository {
  open(shift: DriverShift): Promise<DriverShift>;
  findOpen(driverId: DriverId): Promise<DriverShift | undefined>;
  update(id: string, patch: Partial<DriverShift>): Promise<DriverShift>;
  listForDriver(driverId: DriverId, since: number): Promise<DriverShift[]>;
}

// ------------------------------------------------------------------ rides

export interface RideQuery {
  readonly riderId?: RiderId;
  readonly driverId?: DriverId;
  readonly statuses?: readonly RideStatus[];
  readonly since?: number;
  readonly until?: number;
  readonly limit?: number;
  readonly offset?: number;
}

export interface RideRepository {
  create(ride: Ride): Promise<Ride>;
  findById(id: RideId): Promise<Ride | undefined>;
  /**
   * Replace a ride, guarded by its previous `updatedAt`. Returns undefined when
   * the guard fails, which is how two concurrent writers — a driver tapping
   * "arrived" while dispatch expires an offer — are prevented from clobbering
   * each other.
   */
  save(ride: Ride, expectedUpdatedAt?: number): Promise<Ride | undefined>;
  query(query: RideQuery): Promise<Ride[]>;
  /** The rider's or driver's single in-flight ride, if any. */
  findActiveForRider(riderId: RiderId): Promise<Ride | undefined>;
  findActiveForDriver(driverId: DriverId): Promise<Ride | undefined>;
  /** Rides currently searching for a driver — what the dispatch loop iterates. */
  findSearching(): Promise<Ride[]>;
  /** Scheduled rides whose dispatch window has opened. */
  findDueScheduled(now: number, leadMs: number): Promise<Ride[]>;
  count(query: RideQuery): Promise<number>;
}

export interface OfferRepository {
  create(offer: RideOffer): Promise<RideOffer>;
  findById(id: OfferId): Promise<RideOffer | undefined>;
  update(id: OfferId, patch: Partial<RideOffer>): Promise<RideOffer>;
  findPendingForDriver(driverId: DriverId): Promise<RideOffer[]>;
  findForRide(rideId: RideId): Promise<RideOffer[]>;
}

// --------------------------------------------------------------- payments

export interface PaymentMethodRepository {
  create(method: PaymentMethod): Promise<PaymentMethod>;
  findById(id: PaymentMethodId): Promise<PaymentMethod | undefined>;
  listForRider(riderId: RiderId): Promise<PaymentMethod[]>;
  update(id: PaymentMethodId, patch: Partial<PaymentMethod>): Promise<PaymentMethod>;
  setDefault(riderId: RiderId, id: PaymentMethodId): Promise<void>;
}

export interface ChargeRepository {
  /** The idempotency key is stored with the charge so a retry returns the original. */
  create(charge: Charge, idempotencyKey?: string): Promise<Charge>;
  findById(id: ChargeId): Promise<Charge | undefined>;
  findByIdempotencyKey(key: string): Promise<Charge | undefined>;
  update(id: ChargeId, patch: Partial<Charge>): Promise<Charge>;
  listForRide(rideId: RideId): Promise<Charge[]>;
  listForRider(riderId: RiderId, limit: number): Promise<Charge[]>;
}

// ------------------------------------------------------------------- chat

export interface ChatMessage {
  readonly id: MessageId;
  readonly rideId: RideId;
  readonly from: 'rider' | 'driver';
  readonly text: string;
  readonly sentAt: number;
  readonly readAt?: number;
}

export interface ChatRepository {
  append(message: ChatMessage): Promise<ChatMessage>;
  listForRide(rideId: RideId): Promise<ChatMessage[]>;
  markRead(rideId: RideId, reader: 'rider' | 'driver', at: number): Promise<void>;
}

// --------------------------------------------------------------- promos

/**
 * Redemptions only. The promo *definitions* are a catalog supplied through the
 * container, exactly like ride types — what has to be persisted is who used
 * what, because that is the only part a limit depends on.
 */
export interface PromoRepository {
  record(redemption: PromoRedemption): Promise<PromoRedemption>;
  countForRider(code: string, riderId: RiderId): Promise<number>;
  countTotal(code: string): Promise<number>;
  listForRider(riderId: RiderId): Promise<PromoRedemption[]>;
}

// ---------------------------------------------------------------- support

export interface TicketQuery {
  readonly requesterId?: UserId;
  readonly statuses?: readonly TicketStatus[];
  readonly rideId?: RideId;
  readonly limit?: number;
}

export interface SupportRepository {
  create(ticket: SupportTicket): Promise<SupportTicket>;
  findById(id: TicketId): Promise<SupportTicket | undefined>;
  /**
   * Replace a ticket, guarded by its previous `updatedAt` — the same optimistic
   * concurrency the ride store uses, because an agent replying while the
   * requester replies is exactly as likely here.
   */
  save(ticket: SupportTicket, expectedUpdatedAt?: number): Promise<SupportTicket | undefined>;
  query(query: TicketQuery): Promise<SupportTicket[]>;
  countByStatus(): Promise<Record<string, number>>;
}

// ------------------------------------------------------------- the bundle

/** Everything the services need to persist, in one injectable bundle. */
export interface Repositories {
  readonly users: UserRepository;
  readonly sessions: SessionRepository;
  readonly verifications: VerificationRepository;
  readonly riders: RiderRepository;
  readonly drivers: DriverRepository;
  readonly vehicles: VehicleRepository;
  readonly shifts: ShiftRepository;
  readonly rides: RideRepository;
  readonly offers: OfferRepository;
  readonly paymentMethods: PaymentMethodRepository;
  readonly charges: ChargeRepository;
  readonly chat: ChatRepository;
  readonly promos: PromoRepository;
  readonly support: SupportRepository;
  /** Release connections; a no-op for the in-memory store. */
  close(): Promise<void>;
}
