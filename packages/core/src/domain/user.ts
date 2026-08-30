/**
 * Accounts. One `User` record backs both roles: a person can hold a rider
 * profile, a driver profile, or both, and the app they open decides which
 * profile is in play. Auth identity lives here; role-specific state lives on
 * the profiles.
 */

import { z } from 'zod';
import type { DriverId, RiderId, UserId } from '../util/ids.js';
import type { CurrencyCode } from '../util/money.js';
import type { PaymentMethodId } from '../util/ids.js';
import type { SavedPlace } from './place.js';

export type UserRole = 'rider' | 'driver' | 'admin';

export interface User {
  readonly id: UserId;
  readonly phone: string;
  readonly email?: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly avatarUrl?: string;
  readonly roles: readonly UserRole[];
  readonly locale: string;
  readonly currency: CurrencyCode;
  readonly createdAt: number;
  readonly disabledAt?: number;
}

export const displayName = (user: Pick<User, 'firstName' | 'lastName'>): string =>
  `${user.firstName} ${user.lastName}`.trim();

/** What the other party sees — never the full name or contact details. */
export const publicName = (user: Pick<User, 'firstName' | 'lastName'>): string =>
  user.lastName ? `${user.firstName} ${user.lastName.charAt(0)}.` : user.firstName;

export const initials = (user: Pick<User, 'firstName' | 'lastName'>): string =>
  `${user.firstName.charAt(0)}${user.lastName.charAt(0)}`.toUpperCase();

export interface RiderProfile {
  readonly id: RiderId;
  readonly userId: UserId;
  readonly defaultPaymentMethodId?: PaymentMethodId;
  readonly savedPlaces: readonly SavedPlace[];
  /** Rolling average of driver-submitted ratings, 1–5. */
  readonly rating: number;
  readonly ratingCount: number;
  readonly totalRides: number;
  readonly preferences: RiderPreferences;
  readonly createdAt: number;
}

export interface RiderPreferences {
  /** Ride type id preselected on the home screen. */
  readonly defaultRideTypeId?: string;
  readonly accessibility: {
    readonly wheelchairAccessible: boolean;
    readonly serviceAnimal: boolean;
    readonly extraPickupTime: boolean;
  };
  readonly communication: {
    readonly quietRide: boolean;
    readonly temperature?: 'cool' | 'warm' | 'no_preference';
  };
  readonly notifications: {
    readonly push: boolean;
    readonly sms: boolean;
    readonly email: boolean;
  };
}

export const defaultRiderPreferences = (): RiderPreferences => ({
  accessibility: {
    wheelchairAccessible: false,
    serviceAnimal: false,
    extraPickupTime: false,
  },
  communication: { quietRide: false, temperature: 'no_preference' },
  notifications: { push: true, sms: true, email: false },
});

/** A safety contact who can be sent a live trip link. */
export interface EmergencyContact {
  readonly name: string;
  readonly phone: string;
  readonly relationship?: string;
  readonly autoShareTrips: boolean;
}

export const userSchema = z.object({
  id: z.string(),
  phone: z.string().min(5),
  email: z.string().email().optional(),
  firstName: z.string().min(1).max(60),
  lastName: z.string().max(60).default(''),
  avatarUrl: z.string().url().optional(),
  roles: z.array(z.enum(['rider', 'driver', 'admin'])).min(1),
  locale: z.string().default('en-US'),
  currency: z.enum(['USD', 'CAD', 'EUR', 'GBP', 'MXN']).default('USD'),
});

export const signupSchema = z.object({
  phone: z.string().min(5).max(20),
  firstName: z.string().min(1).max(60),
  lastName: z.string().max(60).default(''),
  email: z.string().email().optional(),
  role: z.enum(['rider', 'driver']).default('rider'),
});

export type SignupInput = z.infer<typeof signupSchema>;

/** Public projection of a rider, as shown to their driver. */
export interface RiderPublicProfile {
  readonly riderId: RiderId;
  readonly name: string;
  readonly avatarUrl?: string;
  readonly rating: number;
  readonly totalRides: number;
}

/** Public projection of a driver, as shown to their rider. */
export interface DriverPublicProfile {
  readonly driverId: DriverId;
  readonly name: string;
  readonly avatarUrl?: string;
  readonly rating: number;
  readonly totalRides: number;
  readonly memberSince: number;
}
