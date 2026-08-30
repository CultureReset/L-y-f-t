/**
 * Drivers: onboarding state, availability, live location, and the shift
 * (earnings session) they are currently working.
 */

import { z } from 'zod';
import type { DriverId, RideId, UserId, VehicleId } from '../util/ids.js';
import type { Money } from '../util/money.js';
import type { Position } from '../util/geo.js';

/**
 * Availability is the single field dispatch reads. `offline` means the driver
 * closed the app; `available` means they may be offered a ride; `on_ride`
 * means they are mid-trip. `busy` is a soft pause the driver controls without
 * going fully offline.
 */
export type DriverAvailability = 'offline' | 'available' | 'offered' | 'on_ride' | 'busy';

/** Onboarding gate. A driver only reaches dispatch once `approved`. */
export type DriverApprovalStatus =
  | 'incomplete'
  | 'pending_review'
  | 'approved'
  | 'suspended'
  | 'rejected';

export interface DriverProfile {
  readonly id: DriverId;
  readonly userId: UserId;
  readonly approvalStatus: DriverApprovalStatus;
  readonly availability: DriverAvailability;
  readonly activeVehicleId?: VehicleId;
  readonly currentRideId?: RideId;
  readonly lastPosition?: Position;
  /** Rolling average of rider-submitted ratings, 1–5. */
  readonly rating: number;
  readonly ratingCount: number;
  readonly totalRides: number;
  /** Share of received offers the driver accepted, 0–1. */
  readonly acceptanceRate: number;
  /** Share of accepted rides the driver completed, 0–1. */
  readonly completionRate: number;
  readonly documents: readonly DriverDocument[];
  readonly preferences: DriverPreferences;
  readonly memberSince: number;
  readonly lastOnlineAt?: number;
}

export interface DriverPreferences {
  /** Ride type ids the driver opts into; empty means every type they qualify for. */
  readonly acceptedRideTypeIds: readonly string[];
  /** Refuse pickups further away than this. */
  readonly maxPickupDistanceMeters: number;
  /** Only take rides that end near here, for the last ride of a shift. */
  readonly destinationFilter?: {
    readonly address: string;
    readonly lat: number;
    readonly lng: number;
    readonly radiusMeters: number;
    readonly expiresAt: number;
  };
  readonly autoAcceptOffers: boolean;
  readonly navigationApp: 'internal' | 'google_maps' | 'waze' | 'apple_maps';
}

export const defaultDriverPreferences = (): DriverPreferences => ({
  acceptedRideTypeIds: [],
  maxPickupDistanceMeters: 12_000,
  autoAcceptOffers: false,
  navigationApp: 'internal',
});

export const DRIVER_DOCUMENT_TYPES = [
  'drivers_license',
  'vehicle_registration',
  'insurance',
  'background_check',
  'profile_photo',
  'vehicle_inspection',
] as const;

export type DriverDocumentType = (typeof DRIVER_DOCUMENT_TYPES)[number];

export interface DriverDocument {
  readonly type: DriverDocumentType;
  readonly status: 'missing' | 'pending' | 'approved' | 'rejected' | 'expired';
  readonly fileUrl?: string;
  readonly expiresAt?: number;
  readonly reviewedAt?: number;
  readonly rejectionReason?: string;
}

/** Documents that must be approved before a driver can go online. */
export const REQUIRED_DOCUMENTS: readonly DriverDocumentType[] = [
  'drivers_license',
  'vehicle_registration',
  'insurance',
  'background_check',
  'profile_photo',
];

export const missingDocuments = (
  profile: Pick<DriverProfile, 'documents'>,
  now: number,
): DriverDocumentType[] =>
  REQUIRED_DOCUMENTS.filter((type) => {
    const doc = profile.documents.find((d) => d.type === type);
    if (!doc || doc.status !== 'approved') return true;
    return doc.expiresAt !== undefined && doc.expiresAt <= now;
  });

/** Every condition that must hold for a driver to accept work. */
export const canGoOnline = (
  profile: DriverProfile,
  now: number,
): { allowed: boolean; reason?: string } => {
  if (profile.approvalStatus === 'suspended') {
    return { allowed: false, reason: 'Your account is suspended.' };
  }
  if (profile.approvalStatus === 'rejected') {
    return { allowed: false, reason: 'Your application was not approved.' };
  }
  if (profile.approvalStatus !== 'approved') {
    return { allowed: false, reason: 'Finish onboarding to start driving.' };
  }
  if (!profile.activeVehicleId) {
    return { allowed: false, reason: 'Add a vehicle before going online.' };
  }
  const missing = missingDocuments(profile, now);
  if (missing.length > 0) {
    return {
      allowed: false,
      reason: `${missing.length} document${missing.length > 1 ? 's' : ''} need attention.`,
    };
  }
  return { allowed: true };
};

export const isDispatchable = (profile: DriverProfile): boolean =>
  profile.approvalStatus === 'approved' && profile.availability === 'available';

/**
 * A driving session. Opened when the driver goes online, closed when they go
 * offline — this is the unit the earnings screen sums over.
 */
export interface DriverShift {
  readonly id: string;
  readonly driverId: DriverId;
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly ridesCompleted: number;
  readonly ridesDeclined: number;
  readonly offersReceived: number;
  readonly grossEarnings: Money;
  readonly tips: Money;
  readonly bonuses: Money;
  readonly onlineMillis: number;
  readonly distanceMeters: number;
}

/** Earnings rolled up for a period, as rendered on the driver's earnings tab. */
export interface EarningsSummary {
  readonly periodStart: number;
  readonly periodEnd: number;
  readonly rideEarnings: Money;
  readonly tips: Money;
  readonly bonuses: Money;
  readonly total: Money;
  readonly ridesCompleted: number;
  readonly onlineMillis: number;
  readonly distanceMeters: number;
  /** Total ÷ hours online — the number drivers actually optimise against. */
  readonly perHour: Money;
}

export const driverPreferencesSchema = z.object({
  acceptedRideTypeIds: z.array(z.string()).default([]),
  maxPickupDistanceMeters: z.number().min(500).max(80_000).default(12_000),
  destinationFilter: z
    .object({
      address: z.string(),
      lat: z.number(),
      lng: z.number(),
      radiusMeters: z.number().min(500).max(50_000),
      expiresAt: z.number(),
    })
    .optional(),
  autoAcceptOffers: z.boolean().default(false),
  navigationApp: z
    .enum(['internal', 'google_maps', 'waze', 'apple_maps'])
    .default('internal'),
});

export const positionSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  bearing: z.number().min(0).max(360).optional(),
  speed: z.number().min(0).optional(),
  accuracy: z.number().min(0).optional(),
  timestamp: z.number().optional(),
});
