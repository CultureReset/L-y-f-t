-- L-Y-F-T platform schema (PostgreSQL 14+).
--
-- Design note: aggregates whose shape is owned by the domain layer (rides,
-- offers, driver profiles) are stored as a JSONB `doc` alongside the columns
-- that queries actually filter or sort on. The columns are generated from the
-- document where possible, so there is exactly one source of truth and no way
-- for the two to drift. Simple, flat entities get ordinary columns.
--
-- Every table an index serves is listed with the query it exists for.

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  phone         TEXT NOT NULL UNIQUE,
  email         TEXT,
  first_name    TEXT NOT NULL,
  last_name     TEXT NOT NULL DEFAULT '',
  avatar_url    TEXT,
  roles         TEXT[] NOT NULL,
  locale        TEXT NOT NULL DEFAULT 'en-US',
  currency      TEXT NOT NULL DEFAULT 'USD',
  created_at    BIGINT NOT NULL,
  disabled_at   BIGINT
);

CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,
  token         TEXT NOT NULL UNIQUE,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role          TEXT NOT NULL,
  created_at    BIGINT NOT NULL,
  expires_at    BIGINT NOT NULL,
  last_seen_at  BIGINT NOT NULL
);
-- Revoking every session for a user on sign-out-everywhere.
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);
-- Sweeping expired sessions.
CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS verifications (
  phone         TEXT PRIMARY KEY,
  code          TEXT NOT NULL,
  expires_at    BIGINT NOT NULL,
  attempts      INT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS riders (
  id                        TEXT PRIMARY KEY,
  user_id                   TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  default_payment_method_id TEXT,
  rating                    NUMERIC(4,3) NOT NULL DEFAULT 5,
  rating_count              INT NOT NULL DEFAULT 0,
  total_rides               INT NOT NULL DEFAULT 0,
  saved_places              JSONB NOT NULL DEFAULT '[]'::jsonb,
  preferences               JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at                BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS drivers (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  approval_status   TEXT NOT NULL,
  availability      TEXT NOT NULL,
  active_vehicle_id TEXT,
  current_ride_id   TEXT,
  -- Split out of the document so the radius query can use a plain index.
  lat               DOUBLE PRECISION,
  lng               DOUBLE PRECISION,
  position_at       BIGINT,
  rating            NUMERIC(4,3) NOT NULL DEFAULT 5,
  rating_count      INT NOT NULL DEFAULT 0,
  total_rides       INT NOT NULL DEFAULT 0,
  acceptance_rate   NUMERIC(5,4) NOT NULL DEFAULT 1,
  completion_rate   NUMERIC(5,4) NOT NULL DEFAULT 1,
  documents         JSONB NOT NULL DEFAULT '[]'::jsonb,
  preferences       JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_position     JSONB,
  member_since      BIGINT NOT NULL,
  last_online_at    BIGINT
);
-- The dispatch hot path: available drivers inside a bounding box. The partial
-- index keeps it to the small set of drivers who can actually take a ride.
CREATE INDEX IF NOT EXISTS drivers_dispatch_idx
  ON drivers(lat, lng)
  WHERE availability = 'available' AND approval_status = 'approved';
CREATE INDEX IF NOT EXISTS drivers_availability_idx ON drivers(availability);

CREATE TABLE IF NOT EXISTS vehicles (
  id             TEXT PRIMARY KEY,
  driver_id      TEXT NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
  doc            JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS vehicles_driver_idx ON vehicles(driver_id);

CREATE TABLE IF NOT EXISTS shifts (
  id             TEXT PRIMARY KEY,
  driver_id      TEXT NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
  started_at     BIGINT NOT NULL,
  ended_at       BIGINT,
  doc            JSONB NOT NULL
);
-- Finding a driver's open shift, and summing a period of them for earnings.
CREATE INDEX IF NOT EXISTS shifts_driver_idx ON shifts(driver_id, started_at DESC);
CREATE INDEX IF NOT EXISTS shifts_open_idx ON shifts(driver_id) WHERE ended_at IS NULL;

CREATE TABLE IF NOT EXISTS rides (
  id            TEXT PRIMARY KEY,
  doc           JSONB NOT NULL,
  -- Generated from the document so the two can never disagree.
  rider_id      TEXT GENERATED ALWAYS AS (doc->>'riderId') STORED,
  driver_id     TEXT GENERATED ALWAYS AS (doc#>>'{assignment,driverId}') STORED,
  status        TEXT GENERATED ALWAYS AS (doc->>'status') STORED,
  created_at    BIGINT GENERATED ALWAYS AS ((doc->>'createdAt')::BIGINT) STORED,
  scheduled_for BIGINT GENERATED ALWAYS AS ((doc->>'scheduledFor')::BIGINT) STORED,
  -- The optimistic-concurrency guard.
  updated_at    BIGINT NOT NULL
);
-- Ride history, newest first, for a rider or a driver.
CREATE INDEX IF NOT EXISTS rides_rider_idx ON rides(rider_id, created_at DESC);
CREATE INDEX IF NOT EXISTS rides_driver_idx ON rides(driver_id, created_at DESC);
-- The dispatch loop's "what is still searching?" query.
CREATE INDEX IF NOT EXISTS rides_searching_idx ON rides(status) WHERE status = 'requested';
-- A rider's or driver's single in-flight ride.
CREATE INDEX IF NOT EXISTS rides_active_idx ON rides(status, rider_id)
  WHERE status IN ('requested', 'accepted', 'arrived', 'in_progress');
-- The scheduled-ride release sweep.
CREATE INDEX IF NOT EXISTS rides_scheduled_idx ON rides(scheduled_for)
  WHERE status = 'scheduled';

CREATE TABLE IF NOT EXISTS offers (
  id            TEXT PRIMARY KEY,
  doc           JSONB NOT NULL,
  ride_id       TEXT GENERATED ALWAYS AS (doc->>'rideId') STORED,
  driver_id     TEXT GENERATED ALWAYS AS (doc->>'driverId') STORED,
  status        TEXT GENERATED ALWAYS AS (doc->>'status') STORED,
  expires_at    BIGINT GENERATED ALWAYS AS ((doc->>'expiresAt')::BIGINT) STORED,
  sent_at       BIGINT GENERATED ALWAYS AS ((doc->>'sentAt')::BIGINT) STORED
);
-- The driver app polling for the offer on its screen.
CREATE INDEX IF NOT EXISTS offers_pending_idx ON offers(driver_id, expires_at)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS offers_ride_idx ON offers(ride_id, sent_at);

CREATE TABLE IF NOT EXISTS payment_methods (
  id            TEXT PRIMARY KEY,
  rider_id      TEXT NOT NULL REFERENCES riders(id) ON DELETE CASCADE,
  is_default    BOOLEAN NOT NULL DEFAULT FALSE,
  removed_at    BIGINT,
  created_at    BIGINT NOT NULL,
  doc           JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS payment_methods_rider_idx ON payment_methods(rider_id)
  WHERE removed_at IS NULL;
-- A rider has at most one default method.
CREATE UNIQUE INDEX IF NOT EXISTS payment_methods_one_default_idx
  ON payment_methods(rider_id) WHERE is_default AND removed_at IS NULL;

CREATE TABLE IF NOT EXISTS charges (
  id               TEXT PRIMARY KEY,
  rider_id         TEXT NOT NULL,
  ride_id          TEXT,
  -- Enforces payment idempotency in the database rather than in application code.
  idempotency_key  TEXT UNIQUE,
  status           TEXT NOT NULL,
  created_at       BIGINT NOT NULL,
  doc              JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS charges_ride_idx ON charges(ride_id);
CREATE INDEX IF NOT EXISTS charges_rider_idx ON charges(rider_id, created_at DESC);

CREATE TABLE IF NOT EXISTS chat_messages (
  id            TEXT PRIMARY KEY,
  ride_id       TEXT NOT NULL,
  sender        TEXT NOT NULL,
  text          TEXT NOT NULL,
  sent_at       BIGINT NOT NULL,
  read_at       BIGINT
);
CREATE INDEX IF NOT EXISTS chat_ride_idx ON chat_messages(ride_id, sent_at);
