/**
 * Vehicles. A vehicle's attributes decide which ride types its driver can
 * serve — that check lives in the ride-type catalog, not here, so adding a new
 * class of service never means editing this file.
 */

import { z } from 'zod';
import type { DriverId, VehicleId } from '../util/ids.js';

export type VehicleColor =
  | 'black'
  | 'white'
  | 'silver'
  | 'gray'
  | 'red'
  | 'blue'
  | 'green'
  | 'brown'
  | 'gold'
  | 'other';

export interface Vehicle {
  readonly id: VehicleId;
  readonly driverId: DriverId;
  readonly make: string;
  readonly model: string;
  readonly year: number;
  readonly color: VehicleColor;
  readonly licensePlate: string;
  /** Passenger seats excluding the driver — gates XL and larger classes. */
  readonly seats: number;
  readonly features: readonly VehicleFeature[];
  readonly photoUrl?: string;
  readonly inspection?: {
    readonly passedAt: number;
    readonly expiresAt: number;
  };
  readonly insurance?: {
    readonly policyNumber: string;
    readonly expiresAt: number;
  };
  readonly activatedAt?: number;
  readonly deactivatedAt?: number;
}

export const VEHICLE_FEATURES = [
  'wheelchair_accessible',
  'child_seat',
  'bike_rack',
  'pet_friendly',
  'premium_interior',
  'electric',
  'hybrid',
  'extra_luggage',
] as const;

export type VehicleFeature = (typeof VEHICLE_FEATURES)[number];

export const vehicleSchema = z.object({
  make: z.string().min(1).max(40),
  model: z.string().min(1).max(40),
  year: z.number().int().min(1990).max(new Date().getFullYear() + 2),
  color: z.enum([
    'black', 'white', 'silver', 'gray', 'red', 'blue', 'green', 'brown', 'gold', 'other',
  ]),
  licensePlate: z.string().min(2).max(12),
  seats: z.number().int().min(1).max(14),
  features: z.array(z.enum(VEHICLE_FEATURES)).default([]),
  photoUrl: z.string().url().optional(),
});

export type VehicleInput = z.infer<typeof vehicleSchema>;

/** "Silver Toyota Camry" — the line a rider reads while looking for their car. */
export const vehicleDescription = (v: Vehicle): string =>
  `${titleCase(v.color)} ${v.make} ${v.model}`;

/** Plates are shown split so the rider can match them at a glance. */
export const formatPlate = (plate: string): string => plate.toUpperCase().trim();

const titleCase = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

export const isVehicleActive = (v: Vehicle, now: number): boolean => {
  if (!v.activatedAt || v.activatedAt > now) return false;
  if (v.deactivatedAt && v.deactivatedAt <= now) return false;
  if (v.inspection && v.inspection.expiresAt <= now) return false;
  if (v.insurance && v.insurance.expiresAt <= now) return false;
  return true;
};

export const hasFeature = (v: Vehicle, feature: VehicleFeature): boolean =>
  v.features.includes(feature);
