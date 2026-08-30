/**
 * Authentication.
 *
 * Phone number plus a one-time code, which is how every ridehail app actually
 * signs people in. The SMS transport is a port, so development prints the code
 * to the log and production sends it through a real provider without any other
 * part of the platform changing.
 *
 * Sessions are opaque bearer tokens rather than self-contained JWTs, so a
 * session can be revoked the instant a device is reported lost.
 */

import {
  AppError,
  defaultDriverPreferences,
  defaultRiderPreferences,
  newDriverId,
  newRiderId,
  newSessionId,
  newUserId,
  type Clock,
  type DriverProfile,
  type PlatformEvents,
  type RiderProfile,
  type TypedEmitter,
  type User,
  type UserId,
  type UserRole,
} from '@lift/core';
import { randomBytes, randomInt } from 'node:crypto';
import type {
  DriverRepository,
  RiderRepository,
  SessionRecord,
  SessionRepository,
  UserRepository,
  VerificationRepository,
} from '../repositories/types.js';

/** How a verification code reaches the person signing in. */
export interface CodeSender {
  readonly id: string;
  send(phone: string, code: string): Promise<void>;
}

/** Logs the code instead of sending it. The default outside production. */
export const consoleCodeSender = (
  log: (message: string) => void = console.log,
): CodeSender => ({
  id: 'console',
  send: async (phone, code) => {
    log(`[auth] verification code for ${phone}: ${code}`);
  },
});

export interface AuthServiceOptions {
  /**
   * A fixed code that always verifies. Development convenience only — the
   * service refuses to start with one set unless `allowFixedCode` is explicit.
   */
  readonly fixedCode?: string;
  readonly allowFixedCode?: boolean;
  readonly codeTtlMs?: number;
  readonly sessionTtlMs?: number;
  readonly maxAttempts?: number;
}

export interface AuthServiceDeps {
  readonly users: UserRepository;
  readonly sessions: SessionRepository;
  readonly verifications: VerificationRepository;
  readonly riders: RiderRepository;
  readonly drivers: DriverRepository;
  readonly clock: Clock;
  readonly events: TypedEmitter<PlatformEvents>;
  readonly sender: CodeSender;
  readonly options?: AuthServiceOptions;
}

export interface AuthResult {
  readonly token: string;
  readonly user: User;
  readonly role: UserRole;
  readonly riderProfile?: RiderProfile;
  readonly driverProfile?: DriverProfile;
  readonly expiresAt: number;
  /** True when this call created the account. */
  readonly isNewUser: boolean;
}

export class AuthService {
  private readonly codeTtlMs: number;
  private readonly sessionTtlMs: number;
  private readonly maxAttempts: number;

  constructor(private readonly deps: AuthServiceDeps) {
    const options = deps.options ?? {};
    this.codeTtlMs = options.codeTtlMs ?? 10 * 60 * 1000;
    this.sessionTtlMs = options.sessionTtlMs ?? 30 * 24 * 60 * 60 * 1000;
    this.maxAttempts = options.maxAttempts ?? 5;
    if (options.fixedCode && !options.allowFixedCode) {
      throw new Error(
        'A fixed verification code was configured without allowFixedCode. ' +
          'This must never be enabled in production.',
      );
    }
  }

  /** Send a verification code. Returns the code only in fixed-code mode. */
  async requestCode(phone: string): Promise<{ sent: boolean; devCode?: string }> {
    const normalized = normalizePhone(phone);
    const code = this.deps.options?.fixedCode ?? String(randomInt(100_000, 999_999));

    await this.deps.verifications.put({
      phone: normalized,
      code,
      expiresAt: this.deps.clock.now() + this.codeTtlMs,
      attempts: 0,
    });
    await this.deps.sender.send(normalized, code);

    return this.deps.options?.fixedCode ? { sent: true, devCode: code } : { sent: true };
  }

  /**
   * Verify a code and return a session, creating the account and the profile
   * for the requested role on first sign-in.
   */
  async verifyCode(input: {
    phone: string;
    code: string;
    role?: UserRole;
    firstName?: string;
    lastName?: string;
    email?: string;
  }): Promise<AuthResult> {
    const normalized = normalizePhone(input.phone);
    const record = await this.deps.verifications.get(normalized);
    if (!record) {
      throw new AppError('unauthorized', 'No verification is pending for that number', {
        userMessage: 'That code expired. Request a new one.',
      });
    }
    if (record.attempts >= this.maxAttempts) {
      await this.deps.verifications.clear(normalized);
      throw new AppError('rate_limited', 'Too many verification attempts', {
        userMessage: 'Too many tries. Request a new code.',
      });
    }
    if (record.code !== input.code) {
      await this.deps.verifications.incrementAttempts(normalized);
      throw new AppError('unauthorized', 'Incorrect verification code', {
        userMessage: "That code doesn't match. Try again.",
      });
    }
    await this.deps.verifications.clear(normalized);

    const role: UserRole = input.role ?? 'rider';
    const existing = await this.deps.users.findByPhone(normalized);
    const isNewUser = existing === undefined;

    // `ensureRole` guards operator access for an existing account, but account
    // creation would otherwise take the requested role at face value — signing
    // in with an unknown number and role=admin must not mint an operator.
    if (isNewUser && role === 'admin') {
      throw new AppError('forbidden', 'Operator accounts cannot be self-registered', {
        userMessage: 'That account does not have operator access.',
      });
    }

    const user = existing
      ? await this.ensureRole(existing, role)
      : await this.createUser({ ...input, phone: normalized, role });

    const riderProfile =
      role === 'rider' || user.roles.includes('rider')
        ? await this.ensureRiderProfile(user)
        : undefined;
    const driverProfile =
      role === 'driver' || user.roles.includes('driver')
        ? await this.ensureDriverProfile(user)
        : undefined;

    const session = await this.createSession(user.id, role);

    return {
      token: session.token,
      user,
      role,
      expiresAt: session.expiresAt,
      isNewUser,
      ...(riderProfile ? { riderProfile } : {}),
      ...(driverProfile ? { driverProfile } : {}),
    };
  }

  /** Resolve a bearer token into its session, refreshing last-seen. */
  async authenticate(token: string): Promise<SessionRecord> {
    const session = await this.deps.sessions.findByToken(token);
    if (!session) throw new AppError('unauthorized', 'Invalid or expired session');
    await this.deps.sessions.touch(token, this.deps.clock.now());
    return session;
  }

  async signOut(token: string): Promise<void> {
    await this.deps.sessions.revoke(token);
  }

  async signOutEverywhere(userId: UserId): Promise<void> {
    await this.deps.sessions.revokeAllForUser(userId);
  }

  /** Switch the active role on an existing session, e.g. rider → driver. */
  async switchRole(token: string, role: UserRole): Promise<AuthResult> {
    const session = await this.authenticate(token);
    const user = await this.deps.users.findById(session.userId);
    if (!user) throw new AppError('not_found', 'User not found');

    const updated = await this.ensureRole(user, role);
    const riderProfile =
      role === 'rider' ? await this.ensureRiderProfile(updated) : undefined;
    const driverProfile =
      role === 'driver' ? await this.ensureDriverProfile(updated) : undefined;

    await this.deps.sessions.revoke(token);
    const next = await this.createSession(updated.id, role);

    return {
      token: next.token,
      user: updated,
      role,
      expiresAt: next.expiresAt,
      isNewUser: false,
      ...(riderProfile ? { riderProfile } : {}),
      ...(driverProfile ? { driverProfile } : {}),
    };
  }

  // ------------------------------------------------------------- internals

  private async createUser(input: {
    phone: string;
    role: UserRole;
    firstName?: string;
    lastName?: string;
    email?: string;
  }): Promise<User> {
    const user: User = {
      id: newUserId(),
      phone: input.phone,
      firstName: input.firstName?.trim() || 'Rider',
      lastName: input.lastName?.trim() ?? '',
      roles: [input.role],
      locale: 'en-US',
      currency: 'USD',
      createdAt: this.deps.clock.now(),
      ...(input.email ? { email: input.email } : {}),
    };
    return this.deps.users.create(user);
  }

  private async ensureRole(user: User, role: UserRole): Promise<User> {
    if (user.disabledAt) {
      throw new AppError('forbidden', 'This account is disabled');
    }
    if (user.roles.includes(role)) return user;

    // Rider and driver are self-serve; operator access never is. Signing in
    // must not be able to hand anyone the admin role.
    if (role === 'admin') {
      throw new AppError('forbidden', 'This account is not an operator', {
        userMessage: 'That account does not have operator access.',
      });
    }
    return this.deps.users.update(user.id, { roles: [...user.roles, role] });
  }

  private async ensureRiderProfile(user: User): Promise<RiderProfile> {
    const existing = await this.deps.riders.findByUserId(user.id);
    if (existing) return existing;
    const profile: RiderProfile = {
      id: newRiderId(),
      userId: user.id,
      savedPlaces: [],
      rating: 5,
      ratingCount: 0,
      totalRides: 0,
      preferences: defaultRiderPreferences(),
      createdAt: this.deps.clock.now(),
    };
    const created = await this.deps.riders.create(profile);
    this.deps.events.emit('rider.registered', { riderId: created.id });
    return created;
  }

  private async ensureDriverProfile(user: User): Promise<DriverProfile> {
    const existing = await this.deps.drivers.findByUserId(user.id);
    if (existing) return existing;
    const profile: DriverProfile = {
      id: newDriverId(),
      userId: user.id,
      // A new driver starts at the beginning of onboarding, not approved.
      approvalStatus: 'incomplete',
      availability: 'offline',
      rating: 5,
      ratingCount: 0,
      totalRides: 0,
      acceptanceRate: 1,
      completionRate: 1,
      documents: [],
      preferences: defaultDriverPreferences(),
      memberSince: this.deps.clock.now(),
    };
    const created = await this.deps.drivers.create(profile);
    this.deps.events.emit('driver.registered', { driverId: created.id });
    return created;
  }

  private async createSession(
    userId: UserId,
    role: UserRole,
  ): Promise<SessionRecord> {
    const now = this.deps.clock.now();
    const session: SessionRecord = {
      id: newSessionId(),
      token: randomBytes(32).toString('base64url'),
      userId,
      role: role === 'admin' ? 'admin' : role,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: now + this.sessionTtlMs,
    };
    return this.deps.sessions.create(session);
  }
}

/**
 * Reduce a phone number to digits with a leading `+`. Good enough to make
 * lookups stable; a production deployment should use libphonenumber for real
 * regional parsing.
 */
export const normalizePhone = (phone: string): string => {
  const digits = phone.replace(/[^\d]/g, '');
  if (digits.length === 0) throw new AppError('validation_failed', 'A phone number is required');
  // Assume North America when no country code is present.
  const withCountry = digits.length === 10 ? `1${digits}` : digits;
  return `+${withCountry}`;
};
