/**
 * The PostgreSQL store.
 *
 * Implements exactly the same ports as the in-memory store, so switching is a
 * matter of `STORE=postgres DATABASE_URL=...` and nothing else.
 *
 * Aggregates the domain owns (rides, offers, vehicles, shifts, charges) are
 * persisted as a JSONB document with generated columns for the fields queries
 * filter on — one source of truth, no mapping layer to drift, and real indexes
 * where they matter. See `schema.sql` for the indexes and the query each serves.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import {
  ACTIVE_RIDE_STATUSES,
  systemClock,
  haversineMeters,
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
  type Payout,
  type Place,
  type PlaceId,
  type Position,
  type PromoRedemption,
  type Ride,
  type RideId,
  type RideOffer,
  type RiderId,
  type RiderProfile,
  type SavedPlace,
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
  PayoutDestination,
  PayoutRepository,
  PushRecipient,
  PushTokenRepository,
  PromoRepository,
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

const { Pool } = pg;
type Pool = pg.Pool;

export interface PostgresOptions {
  readonly connectionString: string;
  readonly max?: number;
  /** Apply schema.sql at startup. On by default; disable if you run migrations. */
  readonly migrate?: boolean;
  /** Clock used for expiry predicates; injected so tests can drive it. */
  readonly clock?: Clock;
  readonly ssl?: boolean;
}

class PgUserRepository implements UserRepository {
  constructor(private readonly pool: Pool) {}

  async create(user: User): Promise<User> {
    await this.pool.query(
      `INSERT INTO users (id, phone, email, first_name, last_name, avatar_url, roles,
                          locale, currency, created_at, disabled_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        user.id, user.phone, user.email ?? null, user.firstName, user.lastName,
        user.avatarUrl ?? null, user.roles, user.locale, user.currency,
        user.createdAt, user.disabledAt ?? null,
      ],
    );
    return user;
  }

  async findById(id: UserId): Promise<User | undefined> {
    const { rows } = await this.pool.query('SELECT * FROM users WHERE id = $1', [id]);
    return rows[0] ? toUser(rows[0]) : undefined;
  }

  async findByPhone(phone: string): Promise<User | undefined> {
    const { rows } = await this.pool.query('SELECT * FROM users WHERE phone = $1', [phone]);
    return rows[0] ? toUser(rows[0]) : undefined;
  }

  async update(id: UserId, patch: Partial<User>): Promise<User> {
    const current = await this.findById(id);
    if (!current) throw notFound('User');
    const next = { ...current, ...patch, id };
    await this.pool.query(
      `UPDATE users SET phone=$2, email=$3, first_name=$4, last_name=$5, avatar_url=$6,
                        roles=$7, locale=$8, currency=$9, disabled_at=$10
       WHERE id=$1`,
      [
        id, next.phone, next.email ?? null, next.firstName, next.lastName,
        next.avatarUrl ?? null, next.roles, next.locale, next.currency,
        next.disabledAt ?? null,
      ],
    );
    return next;
  }

  async list(limit = 100): Promise<User[]> {
    const { rows } = await this.pool.query(
      'SELECT * FROM users ORDER BY created_at DESC LIMIT $1',
      [limit],
    );
    return rows.map(toUser);
  }
}

class PgSessionRepository implements SessionRepository {
  constructor(
    private readonly pool: Pool,
    private readonly clock: Clock,
  ) {}

  async create(session: SessionRecord): Promise<SessionRecord> {
    await this.pool.query(
      `INSERT INTO sessions (id, token, user_id, role, created_at, expires_at, last_seen_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        session.id, session.token, session.userId, session.role,
        session.createdAt, session.expiresAt, session.lastSeenAt,
      ],
    );
    return session;
  }

  async findByToken(token: string): Promise<SessionRecord | undefined> {
    const { rows } = await this.pool.query(
      'SELECT * FROM sessions WHERE token = $1 AND expires_at > $2',
      [token, this.clock.now()],
    );
    const row = rows[0];
    if (!row) return undefined;
    return {
      id: row.id,
      token: row.token,
      userId: row.user_id,
      role: row.role,
      createdAt: Number(row.created_at),
      expiresAt: Number(row.expires_at),
      lastSeenAt: Number(row.last_seen_at),
    };
  }

  async touch(token: string, at: number): Promise<void> {
    await this.pool.query('UPDATE sessions SET last_seen_at = $2 WHERE token = $1', [token, at]);
  }

  async revoke(token: string): Promise<void> {
    await this.pool.query('DELETE FROM sessions WHERE token = $1', [token]);
  }

  async revokeAllForUser(userId: UserId): Promise<void> {
    await this.pool.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
  }
}

class PgVerificationRepository implements VerificationRepository {
  constructor(
    private readonly pool: Pool,
    private readonly clock: Clock,
  ) {}

  async put(record: VerificationRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO verifications (phone, code, expires_at, attempts) VALUES ($1,$2,$3,$4)
       ON CONFLICT (phone) DO UPDATE SET code = $2, expires_at = $3, attempts = $4`,
      [record.phone, record.code, record.expiresAt, record.attempts],
    );
  }

  async get(phone: string): Promise<VerificationRecord | undefined> {
    const { rows } = await this.pool.query(
      'SELECT * FROM verifications WHERE phone = $1 AND expires_at > $2',
      [phone, this.clock.now()],
    );
    const row = rows[0];
    return row
      ? {
          phone: row.phone,
          code: row.code,
          expiresAt: Number(row.expires_at),
          attempts: row.attempts,
        }
      : undefined;
  }

  async incrementAttempts(phone: string): Promise<void> {
    await this.pool.query(
      'UPDATE verifications SET attempts = attempts + 1 WHERE phone = $1',
      [phone],
    );
  }

  async clear(phone: string): Promise<void> {
    await this.pool.query('DELETE FROM verifications WHERE phone = $1', [phone]);
  }
}

class PgRiderRepository implements RiderRepository {
  constructor(private readonly pool: Pool) {}

  async create(profile: RiderProfile): Promise<RiderProfile> {
    await this.pool.query(
      `INSERT INTO riders (id, user_id, default_payment_method_id, rating, rating_count,
                           total_rides, saved_places, preferences, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        profile.id, profile.userId, profile.defaultPaymentMethodId ?? null,
        profile.rating, profile.ratingCount, profile.totalRides,
        JSON.stringify(profile.savedPlaces), JSON.stringify(profile.preferences),
        profile.createdAt,
      ],
    );
    return profile;
  }

  async findById(id: RiderId): Promise<RiderProfile | undefined> {
    const { rows } = await this.pool.query('SELECT * FROM riders WHERE id = $1', [id]);
    return rows[0] ? toRider(rows[0]) : undefined;
  }

  async findByUserId(userId: UserId): Promise<RiderProfile | undefined> {
    const { rows } = await this.pool.query('SELECT * FROM riders WHERE user_id = $1', [userId]);
    return rows[0] ? toRider(rows[0]) : undefined;
  }

  async update(id: RiderId, patch: Partial<RiderProfile>): Promise<RiderProfile> {
    const current = await this.findById(id);
    if (!current) throw notFound('Rider');
    const next = { ...current, ...patch, id };
    await this.pool.query(
      `UPDATE riders SET default_payment_method_id=$2, rating=$3, rating_count=$4,
                         total_rides=$5, saved_places=$6, preferences=$7
       WHERE id=$1`,
      [
        id, next.defaultPaymentMethodId ?? null, next.rating, next.ratingCount,
        next.totalRides, JSON.stringify(next.savedPlaces), JSON.stringify(next.preferences),
      ],
    );
    return next;
  }

  async addSavedPlace(id: RiderId, place: SavedPlace): Promise<RiderProfile> {
    const current = await this.findById(id);
    if (!current) throw notFound('Rider');
    const savedPlaces = [
      ...current.savedPlaces.filter(
        (s) => s.label.toLowerCase() !== place.label.toLowerCase(),
      ),
      place,
    ];
    return this.update(id, { savedPlaces });
  }

  async removeSavedPlace(id: RiderId, placeId: PlaceId): Promise<RiderProfile> {
    const current = await this.findById(id);
    if (!current) throw notFound('Rider');
    return this.update(id, {
      savedPlaces: current.savedPlaces.filter((s) => s.id !== placeId),
    });
  }

  async recentPlaces(id: RiderId, limit: number): Promise<Place[]> {
    const { rows } = await this.pool.query(
      `SELECT DISTINCT ON (doc#>>'{itinerary,dropoff,address}')
              doc#>'{itinerary,dropoff}' AS place, created_at
       FROM rides
       WHERE rider_id = $1 AND status = 'completed'
       ORDER BY doc#>>'{itinerary,dropoff,address}', created_at DESC
       LIMIT $2`,
      [id, limit],
    );
    return rows.map((r) => r.place as Place);
  }
}

class PgDriverRepository implements DriverRepository {
  constructor(private readonly pool: Pool) {}

  async create(profile: DriverProfile): Promise<DriverProfile> {
    await this.pool.query(
      `INSERT INTO drivers (id, user_id, approval_status, availability, active_vehicle_id,
                            current_ride_id, lat, lng, position_at, rating, rating_count,
                            total_rides, acceptance_rate, completion_rate, documents,
                            preferences, last_position, member_since, last_online_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
      driverParams(profile),
    );
    return profile;
  }

  async findById(id: DriverId): Promise<DriverProfile | undefined> {
    const { rows } = await this.pool.query('SELECT * FROM drivers WHERE id = $1', [id]);
    return rows[0] ? toDriver(rows[0]) : undefined;
  }

  async findByUserId(userId: UserId): Promise<DriverProfile | undefined> {
    const { rows } = await this.pool.query('SELECT * FROM drivers WHERE user_id = $1', [userId]);
    return rows[0] ? toDriver(rows[0]) : undefined;
  }

  async update(id: DriverId, patch: Partial<DriverProfile>): Promise<DriverProfile> {
    const current = await this.findById(id);
    if (!current) throw notFound('Driver');
    // `undefined` in a patch means "clear this field", which is how a driver
    // is released from a ride.
    const next: DriverProfile = { ...current, ...patch, id };
    await this.pool.query(
      `UPDATE drivers SET user_id=$2, approval_status=$3, availability=$4, active_vehicle_id=$5,
                          current_ride_id=$6, lat=$7, lng=$8, position_at=$9, rating=$10,
                          rating_count=$11, total_rides=$12, acceptance_rate=$13,
                          completion_rate=$14, documents=$15, preferences=$16,
                          last_position=$17, member_since=$18, last_online_at=$19
       WHERE id=$1`,
      driverParams(next),
    );
    return next;
  }

  async updatePosition(id: DriverId, position: Position): Promise<void> {
    const { rowCount } = await this.pool.query(
      `UPDATE drivers SET lat=$2, lng=$3, position_at=$4, last_position=$5 WHERE id=$1`,
      [id, position.lat, position.lng, position.timestamp, JSON.stringify(position)],
    );
    if (rowCount === 0) throw notFound('Driver');
  }

  /**
   * A bounding box narrows the candidate set using the partial index, then the
   * exact haversine distance filters the corners of the box. Cheaper than
   * computing a great-circle distance across every row.
   */
  async findAvailableNear(
    center: LatLng,
    radiusMeters: number,
    options: { staleAfterMs?: number; now?: number } = {},
  ): Promise<DriverProfile[]> {
    const now = options.now ?? Date.now();
    const latDelta = radiusMeters / 111_320;
    const lngDelta =
      radiusMeters / (111_320 * Math.max(0.01, Math.cos((center.lat * Math.PI) / 180)));
    const staleCutoff =
      options.staleAfterMs === undefined || !Number.isFinite(options.staleAfterMs)
        ? 0
        : now - options.staleAfterMs;

    const { rows } = await this.pool.query(
      `SELECT * FROM drivers
       WHERE availability = 'available'
         AND approval_status = 'approved'
         AND lat BETWEEN $1 AND $2
         AND lng BETWEEN $3 AND $4
         AND position_at >= $5`,
      [
        center.lat - latDelta, center.lat + latDelta,
        center.lng - lngDelta, center.lng + lngDelta,
        staleCutoff,
      ],
    );

    return rows
      .map(toDriver)
      .filter(
        (d) => d.lastPosition && haversineMeters(center, d.lastPosition) <= radiusMeters,
      );
  }

  async list(limit = 200): Promise<DriverProfile[]> {
    const { rows } = await this.pool.query('SELECT * FROM drivers LIMIT $1', [limit]);
    return rows.map(toDriver);
  }

  async countByAvailability(): Promise<Record<string, number>> {
    const { rows } = await this.pool.query(
      'SELECT availability, COUNT(*)::int AS count FROM drivers GROUP BY availability',
    );
    return Object.fromEntries(rows.map((r) => [r.availability, r.count]));
  }
}

class PgVehicleRepository implements VehicleRepository {
  constructor(private readonly pool: Pool) {}

  async create(vehicle: Vehicle): Promise<Vehicle> {
    await this.pool.query(
      'INSERT INTO vehicles (id, driver_id, doc) VALUES ($1,$2,$3)',
      [vehicle.id, vehicle.driverId, JSON.stringify(vehicle)],
    );
    return vehicle;
  }

  async findById(id: VehicleId): Promise<Vehicle | undefined> {
    const { rows } = await this.pool.query('SELECT doc FROM vehicles WHERE id = $1', [id]);
    return rows[0]?.doc as Vehicle | undefined;
  }

  async findByDriver(driverId: DriverId): Promise<Vehicle[]> {
    const { rows } = await this.pool.query(
      'SELECT doc FROM vehicles WHERE driver_id = $1',
      [driverId],
    );
    return rows.map((r) => r.doc as Vehicle);
  }

  async update(id: VehicleId, patch: Partial<Vehicle>): Promise<Vehicle> {
    const current = await this.findById(id);
    if (!current) throw notFound('Vehicle');
    const next = { ...current, ...patch, id };
    await this.pool.query('UPDATE vehicles SET doc = $2 WHERE id = $1', [
      id,
      JSON.stringify(next),
    ]);
    return next;
  }
}

class PgShiftRepository implements ShiftRepository {
  constructor(private readonly pool: Pool) {}

  async open(shift: DriverShift): Promise<DriverShift> {
    await this.pool.query(
      'INSERT INTO shifts (id, driver_id, started_at, ended_at, doc) VALUES ($1,$2,$3,$4,$5)',
      [shift.id, shift.driverId, shift.startedAt, shift.endedAt ?? null, JSON.stringify(shift)],
    );
    return shift;
  }

  async findOpen(driverId: DriverId): Promise<DriverShift | undefined> {
    const { rows } = await this.pool.query(
      'SELECT doc FROM shifts WHERE driver_id = $1 AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1',
      [driverId],
    );
    return rows[0]?.doc as DriverShift | undefined;
  }

  async update(id: string, patch: Partial<DriverShift>): Promise<DriverShift> {
    const { rows } = await this.pool.query('SELECT doc FROM shifts WHERE id = $1', [id]);
    const current = rows[0]?.doc as DriverShift | undefined;
    if (!current) throw notFound('Shift');
    const next = { ...current, ...patch, id };
    await this.pool.query('UPDATE shifts SET ended_at = $2, doc = $3 WHERE id = $1', [
      id,
      next.endedAt ?? null,
      JSON.stringify(next),
    ]);
    return next;
  }

  async listForDriver(driverId: DriverId, since: number): Promise<DriverShift[]> {
    const { rows } = await this.pool.query(
      'SELECT doc FROM shifts WHERE driver_id = $1 AND started_at >= $2 ORDER BY started_at DESC',
      [driverId, since],
    );
    return rows.map((r) => r.doc as DriverShift);
  }
}

class PgRideRepository implements RideRepository {
  constructor(private readonly pool: Pool) {}

  async create(ride: Ride): Promise<Ride> {
    await this.pool.query('INSERT INTO rides (id, doc, updated_at) VALUES ($1,$2,$3)', [
      ride.id,
      JSON.stringify(ride),
      ride.updatedAt,
    ]);
    return ride;
  }

  async findById(id: RideId): Promise<Ride | undefined> {
    const { rows } = await this.pool.query('SELECT doc FROM rides WHERE id = $1', [id]);
    return rows[0]?.doc as Ride | undefined;
  }

  /**
   * Guarded write. The `updated_at = $3` predicate is the optimistic-concurrency
   * check: if another writer has moved the ride on, zero rows match and the
   * caller re-reads rather than clobbering.
   */
  async save(ride: Ride, expectedUpdatedAt?: number): Promise<Ride | undefined> {
    if (expectedUpdatedAt === undefined) {
      const { rowCount } = await this.pool.query(
        'UPDATE rides SET doc = $2, updated_at = $3 WHERE id = $1',
        [ride.id, JSON.stringify(ride), ride.updatedAt],
      );
      if (rowCount === 0) throw notFound('Ride');
      return ride;
    }
    const { rowCount } = await this.pool.query(
      'UPDATE rides SET doc = $2, updated_at = $3 WHERE id = $1 AND updated_at = $4',
      [ride.id, JSON.stringify(ride), ride.updatedAt, expectedUpdatedAt],
    );
    if (rowCount === 0) {
      // Distinguish "gone" from "someone else wrote first".
      const exists = await this.findById(ride.id);
      if (!exists) throw notFound('Ride');
      return undefined;
    }
    return ride;
  }

  async query(query: RideQuery): Promise<Ride[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    const push = (clause: string, value: unknown): void => {
      params.push(value);
      where.push(clause.replace('?', `$${params.length}`));
    };

    if (query.riderId) push('rider_id = ?', query.riderId);
    if (query.driverId) push('driver_id = ?', query.driverId);
    if (query.statuses?.length) push('status = ANY(?)', [...query.statuses]);
    if (query.since !== undefined) push('created_at >= ?', query.since);
    if (query.until !== undefined) push('created_at <= ?', query.until);

    params.push(query.limit ?? 25);
    const limitParam = `$${params.length}`;
    params.push(query.offset ?? 0);
    const offsetParam = `$${params.length}`;

    const { rows } = await this.pool.query(
      `SELECT doc FROM rides
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY created_at DESC
       LIMIT ${limitParam} OFFSET ${offsetParam}`,
      params,
    );
    return rows.map((r) => r.doc as Ride);
  }

  async findActiveForRider(riderId: RiderId): Promise<Ride | undefined> {
    const { rows } = await this.pool.query(
      `SELECT doc FROM rides WHERE rider_id = $1 AND status = ANY($2)
       ORDER BY created_at DESC LIMIT 1`,
      [riderId, [...ACTIVE_RIDE_STATUSES]],
    );
    return rows[0]?.doc as Ride | undefined;
  }

  async findActiveForDriver(driverId: DriverId): Promise<Ride | undefined> {
    const { rows } = await this.pool.query(
      `SELECT doc FROM rides WHERE driver_id = $1 AND status = ANY($2)
       ORDER BY created_at DESC LIMIT 1`,
      [driverId, [...ACTIVE_RIDE_STATUSES]],
    );
    return rows[0]?.doc as Ride | undefined;
  }

  async findSearching(): Promise<Ride[]> {
    const { rows } = await this.pool.query(
      "SELECT doc FROM rides WHERE status = 'requested'",
    );
    return rows.map((r) => r.doc as Ride);
  }

  async findDueScheduled(now: number, leadMs: number): Promise<Ride[]> {
    const { rows } = await this.pool.query(
      "SELECT doc FROM rides WHERE status = 'scheduled' AND scheduled_for - $1 <= $2",
      [leadMs, now],
    );
    return rows.map((r) => r.doc as Ride);
  }

  async count(query: RideQuery): Promise<number> {
    const where: string[] = [];
    const params: unknown[] = [];
    const push = (clause: string, value: unknown): void => {
      params.push(value);
      where.push(clause.replace('?', `$${params.length}`));
    };
    if (query.riderId) push('rider_id = ?', query.riderId);
    if (query.driverId) push('driver_id = ?', query.driverId);
    if (query.statuses?.length) push('status = ANY(?)', [...query.statuses]);
    if (query.since !== undefined) push('created_at >= ?', query.since);
    if (query.until !== undefined) push('created_at <= ?', query.until);

    const { rows } = await this.pool.query(
      `SELECT COUNT(*)::int AS count FROM rides ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`,
      params,
    );
    return rows[0]?.count ?? 0;
  }
}

class PgOfferRepository implements OfferRepository {
  constructor(
    private readonly pool: Pool,
    private readonly clock: Clock,
  ) {}

  async create(offer: RideOffer): Promise<RideOffer> {
    await this.pool.query('INSERT INTO offers (id, doc) VALUES ($1,$2)', [
      offer.id,
      JSON.stringify(offer),
    ]);
    return offer;
  }

  async findById(id: OfferId): Promise<RideOffer | undefined> {
    const { rows } = await this.pool.query('SELECT doc FROM offers WHERE id = $1', [id]);
    return rows[0]?.doc as RideOffer | undefined;
  }

  async update(id: OfferId, patch: Partial<RideOffer>): Promise<RideOffer> {
    const current = await this.findById(id);
    if (!current) throw notFound('Offer');
    const next = { ...current, ...patch, id };
    await this.pool.query('UPDATE offers SET doc = $2 WHERE id = $1', [
      id,
      JSON.stringify(next),
    ]);
    return next;
  }

  async findPendingForDriver(driverId: DriverId): Promise<RideOffer[]> {
    const { rows } = await this.pool.query(
      `SELECT doc FROM offers WHERE driver_id = $1 AND status = 'pending' AND expires_at > $2`,
      [driverId, this.clock.now()],
    );
    return rows.map((r) => r.doc as RideOffer);
  }

  async findForRide(rideId: RideId): Promise<RideOffer[]> {
    const { rows } = await this.pool.query(
      'SELECT doc FROM offers WHERE ride_id = $1 ORDER BY sent_at',
      [rideId],
    );
    return rows.map((r) => r.doc as RideOffer);
  }
}

class PgPaymentMethodRepository implements PaymentMethodRepository {
  constructor(private readonly pool: Pool) {}

  async create(method: PaymentMethod): Promise<PaymentMethod> {
    // Clear any existing default first so the unique partial index holds.
    if (method.isDefault) {
      await this.pool.query(
        'UPDATE payment_methods SET is_default = FALSE WHERE rider_id = $1',
        [method.riderId],
      );
    }
    await this.pool.query(
      `INSERT INTO payment_methods (id, rider_id, is_default, removed_at, created_at, doc)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        method.id, method.riderId, method.isDefault, method.removedAt ?? null,
        method.createdAt, JSON.stringify(method),
      ],
    );
    return method;
  }

  async findById(id: PaymentMethodId): Promise<PaymentMethod | undefined> {
    const { rows } = await this.pool.query(
      'SELECT doc, is_default FROM payment_methods WHERE id = $1',
      [id],
    );
    if (!rows[0]) return undefined;
    return { ...(rows[0].doc as PaymentMethod), isDefault: rows[0].is_default };
  }

  async listForRider(riderId: RiderId): Promise<PaymentMethod[]> {
    const { rows } = await this.pool.query(
      `SELECT doc, is_default FROM payment_methods
       WHERE rider_id = $1 AND removed_at IS NULL
       ORDER BY is_default DESC, created_at`,
      [riderId],
    );
    return rows.map((r) => ({ ...(r.doc as PaymentMethod), isDefault: r.is_default }));
  }

  async update(id: PaymentMethodId, patch: Partial<PaymentMethod>): Promise<PaymentMethod> {
    const current = await this.findById(id);
    if (!current) throw notFound('Payment method');
    const next = { ...current, ...patch, id };
    await this.pool.query(
      'UPDATE payment_methods SET is_default = $2, removed_at = $3, doc = $4 WHERE id = $1',
      [id, next.isDefault, next.removedAt ?? null, JSON.stringify(next)],
    );
    return next;
  }

  async setDefault(riderId: RiderId, id: PaymentMethodId): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Clear before setting: the unique index permits only one default.
      await client.query(
        'UPDATE payment_methods SET is_default = FALSE WHERE rider_id = $1',
        [riderId],
      );
      await client.query(
        'UPDATE payment_methods SET is_default = TRUE WHERE id = $1 AND rider_id = $2 AND removed_at IS NULL',
        [id, riderId],
      );
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
}

class PgChargeRepository implements ChargeRepository {
  constructor(private readonly pool: Pool) {}

  async create(charge: Charge, idempotencyKey?: string): Promise<Charge> {
    // The unique index on idempotency_key makes a concurrent duplicate
    // impossible rather than merely unlikely.
    const { rows } = await this.pool.query(
      `INSERT INTO charges (id, rider_id, ride_id, idempotency_key, status, created_at, doc)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING doc`,
      [
        charge.id, charge.riderId, charge.rideId ?? null, idempotencyKey ?? null,
        charge.status, charge.createdAt, JSON.stringify(charge),
      ],
    );
    if (rows[0]) return rows[0].doc as Charge;
    // Lost the race; return whoever won it.
    const existing = idempotencyKey
      ? await this.findByIdempotencyKey(idempotencyKey)
      : undefined;
    if (!existing) throw new Error('Charge insert conflicted with no recoverable row');
    return existing;
  }

  async findById(id: ChargeId): Promise<Charge | undefined> {
    const { rows } = await this.pool.query('SELECT doc FROM charges WHERE id = $1', [id]);
    return rows[0]?.doc as Charge | undefined;
  }

  async findByIdempotencyKey(key: string): Promise<Charge | undefined> {
    const { rows } = await this.pool.query(
      'SELECT doc FROM charges WHERE idempotency_key = $1',
      [key],
    );
    return rows[0]?.doc as Charge | undefined;
  }

  async update(id: ChargeId, patch: Partial<Charge>): Promise<Charge> {
    const current = await this.findById(id);
    if (!current) throw notFound('Charge');
    const next = { ...current, ...patch, id };
    await this.pool.query('UPDATE charges SET status = $2, doc = $3 WHERE id = $1', [
      id,
      next.status,
      JSON.stringify(next),
    ]);
    return next;
  }

  async listForRide(rideId: RideId): Promise<Charge[]> {
    const { rows } = await this.pool.query(
      'SELECT doc FROM charges WHERE ride_id = $1 ORDER BY created_at',
      [rideId],
    );
    return rows.map((r) => r.doc as Charge);
  }

  async listForRider(riderId: RiderId, limit: number): Promise<Charge[]> {
    const { rows } = await this.pool.query(
      'SELECT doc FROM charges WHERE rider_id = $1 ORDER BY created_at DESC LIMIT $2',
      [riderId, limit],
    );
    return rows.map((r) => r.doc as Charge);
  }
}

class PgChatRepository implements ChatRepository {
  constructor(private readonly pool: Pool) {}

  async append(message: ChatMessage): Promise<ChatMessage> {
    await this.pool.query(
      'INSERT INTO chat_messages (id, ride_id, sender, text, sent_at, read_at) VALUES ($1,$2,$3,$4,$5,$6)',
      [message.id, message.rideId, message.from, message.text, message.sentAt, message.readAt ?? null],
    );
    return message;
  }

  async listForRide(rideId: RideId): Promise<ChatMessage[]> {
    const { rows } = await this.pool.query(
      'SELECT * FROM chat_messages WHERE ride_id = $1 ORDER BY sent_at',
      [rideId],
    );
    return rows.map((r) => ({
      id: r.id,
      rideId: r.ride_id,
      from: r.sender,
      text: r.text,
      sentAt: Number(r.sent_at),
      ...(r.read_at ? { readAt: Number(r.read_at) } : {}),
    }));
  }

  async markRead(rideId: RideId, reader: 'rider' | 'driver', at: number): Promise<void> {
    // A reader marks the other party's messages as read.
    await this.pool.query(
      'UPDATE chat_messages SET read_at = $3 WHERE ride_id = $1 AND sender <> $2 AND read_at IS NULL',
      [rideId, reader, at],
    );
  }
}

class PgPushTokenRepository implements PushTokenRepository {
  constructor(private readonly pool: Pool) {}

  async register(recipient: PushRecipient, token: string, at: number): Promise<void> {
    // Re-registering the same device refreshes when it was last seen rather
    // than failing — the apps call this on every launch.
    await this.pool.query(
      `INSERT INTO push_tokens (token, recipient_kind, recipient_id, registered_at)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (token, recipient_kind, recipient_id)
       DO UPDATE SET registered_at = EXCLUDED.registered_at`,
      [token, recipient.kind, recipient.id, at],
    );
  }

  async tokensFor(recipient: PushRecipient): Promise<string[]> {
    const { rows } = await this.pool.query(
      `SELECT token FROM push_tokens
        WHERE recipient_kind = $1 AND recipient_id = $2
        ORDER BY registered_at`,
      [recipient.kind, recipient.id],
    );
    return rows.map((r) => r.token as string);
  }

  async remove(token: string): Promise<void> {
    await this.pool.query('DELETE FROM push_tokens WHERE token = $1', [token]);
  }

  async size(): Promise<number> {
    const { rows } = await this.pool.query('SELECT COUNT(*)::int AS count FROM push_tokens');
    return (rows[0]?.count as number) ?? 0;
  }
}

class PgPayoutRepository implements PayoutRepository {
  constructor(private readonly pool: Pool) {}

  async create(payout: Payout): Promise<Payout> {
    await this.pool.query(
      'INSERT INTO payouts (id, driver_id, kind, status, requested_at, doc) VALUES ($1,$2,$3,$4,$5,$6)',
      [payout.id, payout.driverId, payout.kind, payout.status, payout.requestedAt, JSON.stringify(payout)],
    );
    return payout;
  }

  async findById(id: string): Promise<Payout | undefined> {
    const { rows } = await this.pool.query('SELECT doc FROM payouts WHERE id = $1', [id]);
    return rows[0] ? (rows[0].doc as Payout) : undefined;
  }

  async update(id: string, patch: Partial<Payout>): Promise<Payout> {
    const current = await this.findById(id);
    if (!current) throw notFound(`Payout ${id}`);
    const next = { ...current, ...patch };
    await this.pool.query('UPDATE payouts SET status = $2, doc = $3 WHERE id = $1', [
      id,
      next.status,
      JSON.stringify(next),
    ]);
    return next;
  }

  async listForDriver(driverId: DriverId, limit = 50): Promise<Payout[]> {
    const { rows } = await this.pool.query(
      'SELECT doc FROM payouts WHERE driver_id = $1 ORDER BY requested_at DESC LIMIT $2',
      [driverId, limit],
    );
    return rows.map((r) => r.doc as Payout);
  }

  async countInstantSince(driverId: DriverId, since: number): Promise<number> {
    const { rows } = await this.pool.query(
      `SELECT COUNT(*)::int AS count FROM payouts
        WHERE driver_id = $1 AND kind = 'instant' AND requested_at >= $2`,
      [driverId, since],
    );
    return (rows[0]?.count as number) ?? 0;
  }

  async totalCommitted(driverId: DriverId): Promise<number> {
    // A failed payout releases its money back to the balance.
    const { rows } = await this.pool.query(
      `SELECT COALESCE(SUM((doc->'amount'->>'amount')::BIGINT + (doc->'fee'->>'amount')::BIGINT), 0)::BIGINT AS total
         FROM payouts WHERE driver_id = $1 AND status <> 'failed'`,
      [driverId],
    );
    return Number(rows[0]?.total ?? 0);
  }

  async addDestination(destination: PayoutDestination): Promise<PayoutDestination> {
    if (destination.isDefault) {
      await this.pool.query(
        'UPDATE payout_destinations SET is_default = FALSE WHERE driver_id = $1',
        [destination.driverId],
      );
    }
    await this.pool.query(
      `INSERT INTO payout_destinations (id, driver_id, label, gateway_token, is_default, created_at)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        destination.id,
        destination.driverId,
        destination.label,
        destination.gatewayToken ?? null,
        destination.isDefault,
        destination.createdAt,
      ],
    );
    return destination;
  }

  async listDestinations(driverId: DriverId): Promise<PayoutDestination[]> {
    const { rows } = await this.pool.query(
      'SELECT * FROM payout_destinations WHERE driver_id = $1 ORDER BY created_at',
      [driverId],
    );
    return rows.map((r) => ({
      id: r.id as string,
      driverId: r.driver_id as DriverId,
      label: r.label as string,
      isDefault: r.is_default as boolean,
      createdAt: Number(r.created_at),
      ...(r.gateway_token ? { gatewayToken: r.gateway_token as string } : {}),
    }));
  }

  async removeDestination(id: string): Promise<void> {
    await this.pool.query('DELETE FROM payout_destinations WHERE id = $1', [id]);
  }
}

class PgPromoRepository implements PromoRepository {
  constructor(private readonly pool: Pool) {}

  async record(redemption: PromoRedemption): Promise<PromoRedemption> {
    await this.pool.query(
      'INSERT INTO promo_redemptions (code, rider_id, ride_id, redeemed_at) VALUES ($1,$2,$3,$4)',
      [redemption.code, redemption.riderId, redemption.rideId ?? null, redemption.redeemedAt],
    );
    return redemption;
  }

  async countForRider(code: string, riderId: RiderId): Promise<number> {
    const { rows } = await this.pool.query(
      'SELECT COUNT(*)::int AS count FROM promo_redemptions WHERE code = $1 AND rider_id = $2',
      [code, riderId],
    );
    return (rows[0]?.count as number) ?? 0;
  }

  async countTotal(code: string): Promise<number> {
    const { rows } = await this.pool.query(
      'SELECT COUNT(*)::int AS count FROM promo_redemptions WHERE code = $1',
      [code],
    );
    return (rows[0]?.count as number) ?? 0;
  }

  async listForRider(riderId: RiderId): Promise<PromoRedemption[]> {
    const { rows } = await this.pool.query(
      'SELECT * FROM promo_redemptions WHERE rider_id = $1 ORDER BY redeemed_at DESC',
      [riderId],
    );
    return rows.map((r) => ({
      code: r.code as string,
      riderId: r.rider_id as string,
      redeemedAt: Number(r.redeemed_at),
      ...(r.ride_id ? { rideId: r.ride_id as string } : {}),
    }));
  }
}

class PgSupportRepository implements SupportRepository {
  constructor(private readonly pool: Pool) {}

  async create(ticket: SupportTicket): Promise<SupportTicket> {
    await this.pool.query('INSERT INTO support_tickets (id, doc) VALUES ($1,$2)', [
      ticket.id,
      JSON.stringify(ticket),
    ]);
    return ticket;
  }

  async findById(id: TicketId): Promise<SupportTicket | undefined> {
    const { rows } = await this.pool.query('SELECT doc FROM support_tickets WHERE id = $1', [id]);
    return rows[0] ? (rows[0].doc as SupportTicket) : undefined;
  }

  async save(ticket: SupportTicket, expectedUpdatedAt?: number): Promise<SupportTicket | undefined> {
    // The guard lives in the WHERE clause so the database, not the process,
    // decides who won.
    const { rowCount } =
      expectedUpdatedAt === undefined
        ? await this.pool.query('UPDATE support_tickets SET doc = $2 WHERE id = $1', [
            ticket.id,
            JSON.stringify(ticket),
          ])
        : await this.pool.query(
            'UPDATE support_tickets SET doc = $2 WHERE id = $1 AND updated_at = $3',
            [ticket.id, JSON.stringify(ticket), expectedUpdatedAt],
          );
    return rowCount === 1 ? ticket : undefined;
  }

  async query(query: TicketQuery): Promise<SupportTicket[]> {
    const where: string[] = [];
    const values: unknown[] = [];
    if (query.requesterId) {
      values.push(query.requesterId);
      where.push(`requester_id = $${values.length}`);
    }
    if (query.rideId) {
      values.push(query.rideId);
      where.push(`ride_id = $${values.length}`);
    }
    if (query.statuses?.length) {
      values.push(query.statuses);
      where.push(`status = ANY($${values.length}::text[])`);
    }
    values.push(query.limit ?? 100);
    const { rows } = await this.pool.query(
      `SELECT doc FROM support_tickets ${
        where.length ? `WHERE ${where.join(' AND ')}` : ''
      } ORDER BY updated_at DESC LIMIT $${values.length}`,
      values,
    );
    return rows.map((r) => r.doc as SupportTicket);
  }

  async countByStatus(): Promise<Record<string, number>> {
    const { rows } = await this.pool.query(
      'SELECT status, COUNT(*)::int AS count FROM support_tickets GROUP BY status',
    );
    return Object.fromEntries(rows.map((r) => [r.status as string, r.count as number]));
  }
}

// ------------------------------------------------------------------ mapping

const toUser = (row: Record<string, unknown>): User => ({
  id: row.id as UserId,
  phone: row.phone as string,
  firstName: row.first_name as string,
  lastName: row.last_name as string,
  roles: row.roles as User['roles'],
  locale: row.locale as string,
  currency: row.currency as User['currency'],
  createdAt: Number(row.created_at),
  ...(row.email ? { email: row.email as string } : {}),
  ...(row.avatar_url ? { avatarUrl: row.avatar_url as string } : {}),
  ...(row.disabled_at ? { disabledAt: Number(row.disabled_at) } : {}),
});

const toRider = (row: Record<string, unknown>): RiderProfile => ({
  id: row.id as RiderId,
  userId: row.user_id as UserId,
  rating: Number(row.rating),
  ratingCount: row.rating_count as number,
  totalRides: row.total_rides as number,
  savedPlaces: row.saved_places as SavedPlace[],
  preferences: row.preferences as RiderProfile['preferences'],
  createdAt: Number(row.created_at),
  ...(row.default_payment_method_id
    ? { defaultPaymentMethodId: row.default_payment_method_id as PaymentMethodId }
    : {}),
});

const toDriver = (row: Record<string, unknown>): DriverProfile => ({
  id: row.id as DriverId,
  userId: row.user_id as UserId,
  approvalStatus: row.approval_status as DriverProfile['approvalStatus'],
  availability: row.availability as DriverProfile['availability'],
  rating: Number(row.rating),
  ratingCount: row.rating_count as number,
  totalRides: row.total_rides as number,
  acceptanceRate: Number(row.acceptance_rate),
  completionRate: Number(row.completion_rate),
  documents: row.documents as DriverProfile['documents'],
  preferences: row.preferences as DriverProfile['preferences'],
  memberSince: Number(row.member_since),
  ...(row.active_vehicle_id ? { activeVehicleId: row.active_vehicle_id as VehicleId } : {}),
  ...(row.current_ride_id ? { currentRideId: row.current_ride_id as RideId } : {}),
  ...(row.last_position ? { lastPosition: row.last_position as Position } : {}),
  ...(row.last_online_at ? { lastOnlineAt: Number(row.last_online_at) } : {}),
});

const driverParams = (d: DriverProfile): unknown[] => [
  d.id, d.userId, d.approvalStatus, d.availability, d.activeVehicleId ?? null,
  d.currentRideId ?? null, d.lastPosition?.lat ?? null, d.lastPosition?.lng ?? null,
  d.lastPosition?.timestamp ?? null, d.rating, d.ratingCount, d.totalRides,
  d.acceptanceRate, d.completionRate, JSON.stringify(d.documents),
  JSON.stringify(d.preferences),
  d.lastPosition ? JSON.stringify(d.lastPosition) : null,
  d.memberSince, d.lastOnlineAt ?? null,
];

// ------------------------------------------------------------------ factory

export const createPostgresRepositories = async (
  options: PostgresOptions,
): Promise<Repositories> => {
  const pool = new Pool({
    connectionString: options.connectionString,
    max: options.max ?? 10,
    ...(options.ssl ? { ssl: { rejectUnauthorized: false } } : {}),
  });

  if (options.migrate ?? true) {
    const here = dirname(fileURLToPath(import.meta.url));
    const schema = await readFile(join(here, 'schema.sql'), 'utf8');
    await pool.query(schema);
  }

  const clock = options.clock ?? systemClock;

  return {
    users: new PgUserRepository(pool),
    sessions: new PgSessionRepository(pool, clock),
    verifications: new PgVerificationRepository(pool, clock),
    riders: new PgRiderRepository(pool),
    drivers: new PgDriverRepository(pool),
    vehicles: new PgVehicleRepository(pool),
    shifts: new PgShiftRepository(pool),
    rides: new PgRideRepository(pool),
    offers: new PgOfferRepository(pool, clock),
    paymentMethods: new PgPaymentMethodRepository(pool),
    charges: new PgChargeRepository(pool),
    chat: new PgChatRepository(pool),
    pushTokens: new PgPushTokenRepository(pool),
    payouts: new PgPayoutRepository(pool),
    promos: new PgPromoRepository(pool),
    support: new PgSupportRepository(pool),
    close: () => pool.end(),
  };
};
