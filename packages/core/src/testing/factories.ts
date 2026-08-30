/**
 * Test factories.
 *
 * Shipped as part of the package (not hidden in a test folder) because the API
 * suite, the simulator, and the seed script all need to conjure a plausible
 * ride or driver. Every factory takes an overrides object so a test states only
 * the fields it actually cares about.
 */

import type { Place, Itinerary } from '../domain/place.js';
import type { Ride, RideLeg } from '../domain/ride.js';
import type { DriverProfile } from '../domain/driver.js';
import { defaultDriverPreferences } from '../domain/driver.js';
import type { Vehicle } from '../domain/vehicle.js';
import type { User, RiderProfile } from '../domain/user.js';
import { defaultRiderPreferences } from '../domain/user.js';
import type { DriverCandidate, MatchRequest } from '../matching/types.js';
import { emptyFare } from '../pricing/engine.js';
import { bearingDegrees, encodePolyline, haversineMeters, interpolate } from '../util/geo.js';
import type { LatLng } from '../util/geo.js';
import { fromDecimal } from '../util/money.js';
import {
  newDriverId,
  newPlaceId,
  newRideId,
  newRiderId,
  newUserId,
  newVehicleId,
  type DriverId,
  type RideId,
  type RiderId,
  type VehicleId,
} from '../util/ids.js';

export const T0 = 1_700_000_000_000;

/** A handful of real San Francisco landmarks, for readable test output. */
export const SF_PLACES = {
  ferryBuilding: { lat: 37.7955, lng: -122.3937 },
  missionDolores: { lat: 37.7644, lng: -122.4269 },
  goldenGatePark: { lat: 37.7694, lng: -122.4862 },
  sfo: { lat: 37.6213, lng: -122.379 },
  castro: { lat: 37.7609, lng: -122.435 },
  chinatown: { lat: 37.7941, lng: -122.4078 },
  oracleParkStadium: { lat: 37.7786, lng: -122.3893 },
  presidio: { lat: 37.7989, lng: -122.4662 },
} as const satisfies Record<string, LatLng>;

export const makePlace = (overrides: Partial<Place> = {}): Place => ({
  id: newPlaceId(),
  name: 'Ferry Building',
  address: '1 Ferry Building, San Francisco, CA 94111',
  coordinates: SF_PLACES.ferryBuilding,
  category: 'address',
  source: 'seed',
  ...overrides,
});

export const makeItinerary = (overrides: Partial<Itinerary> = {}): Itinerary => ({
  pickup: makePlace({ name: 'Ferry Building', coordinates: SF_PLACES.ferryBuilding }),
  dropoff: makePlace({
    name: 'Mission Dolores Park',
    address: 'Dolores St & 19th St, San Francisco, CA 94114',
    coordinates: SF_PLACES.missionDolores,
  }),
  stops: [],
  ...overrides,
});

/** A straight-line leg between two points, at a plausible city speed. */
export const makeLeg = (
  from: LatLng,
  to: LatLng,
  kind: RideLeg['kind'] = 'to_dropoff',
  speedKph = 32,
): RideLeg => {
  const distanceMeters = haversineMeters(from, to);
  const geometry = encodePolyline([
    from,
    interpolate(from, to, 0.33),
    interpolate(from, to, 0.66),
    to,
  ]);
  return {
    kind,
    from,
    to,
    distanceMeters,
    durationMs: Math.round((distanceMeters / ((speedKph * 1000) / 3600)) * 1000),
    geometry,
  };
};

export const makeRide = (overrides: Partial<Ride> = {}): Ride => {
  const itinerary = overrides.itinerary ?? makeItinerary();
  return {
    id: newRideId(),
    riderId: newRiderId(),
    status: 'draft',
    rideTypeId: 'standard',
    itinerary,
    legs: [],
    quotedFare: emptyFare('standard', 'USD', T0),
    timeline: [],
    passengerCount: 1,
    createdAt: T0,
    updatedAt: T0,
    metadata: {},
    ...overrides,
  };
};

export const makeUser = (overrides: Partial<User> = {}): User => ({
  id: newUserId(),
  phone: '+14155550100',
  firstName: 'Avery',
  lastName: 'Chen',
  roles: ['rider'],
  locale: 'en-US',
  currency: 'USD',
  createdAt: T0,
  ...overrides,
});

export const makeRiderProfile = (overrides: Partial<RiderProfile> = {}): RiderProfile => ({
  id: newRiderId(),
  userId: newUserId(),
  savedPlaces: [],
  rating: 4.9,
  ratingCount: 24,
  totalRides: 31,
  preferences: defaultRiderPreferences(),
  createdAt: T0,
  ...overrides,
});

export const makeVehicle = (overrides: Partial<Vehicle> = {}): Vehicle => ({
  id: newVehicleId(),
  driverId: newDriverId(),
  make: 'Toyota',
  model: 'Camry',
  year: new Date().getFullYear() - 2,
  color: 'silver',
  licensePlate: '8ABC123',
  seats: 4,
  features: [],
  activatedAt: T0 - 86_400_000,
  ...overrides,
});

export const makeDriverProfile = (overrides: Partial<DriverProfile> = {}): DriverProfile => ({
  id: newDriverId(),
  userId: newUserId(),
  approvalStatus: 'approved',
  availability: 'available',
  rating: 4.9,
  ratingCount: 412,
  totalRides: 1_203,
  acceptanceRate: 0.82,
  completionRate: 0.97,
  documents: [
    { type: 'drivers_license', status: 'approved' },
    { type: 'vehicle_registration', status: 'approved' },
    { type: 'insurance', status: 'approved' },
    { type: 'background_check', status: 'approved' },
    { type: 'profile_photo', status: 'approved' },
  ],
  preferences: defaultDriverPreferences(),
  memberSince: T0 - 365 * 86_400_000,
  ...overrides,
});

export const makeCandidate = (overrides: Partial<DriverCandidate> = {}): DriverCandidate => {
  const position = overrides.position ?? SF_PLACES.chinatown;
  const distanceMeters =
    overrides.distanceMeters ?? haversineMeters(position, SF_PLACES.ferryBuilding);
  return {
    driverId: newDriverId(),
    vehicleId: newVehicleId(),
    position,
    distanceMeters,
    // ~32 km/h through city streets.
    etaToPickupMs: Math.round((distanceMeters / 8.9) * 1000),
    rating: 4.85,
    acceptanceRate: 0.8,
    completionRate: 0.96,
    eligibleRideTypeIds: ['standard', 'shared'],
    acceptedRideTypeIds: [],
    maxPickupDistanceMeters: 12_000,
    autoAccept: false,
    ...overrides,
  };
};

export const makeMatchRequest = (overrides: Partial<MatchRequest> = {}): MatchRequest => ({
  rideId: newRideId(),
  rideTypeId: 'standard',
  pickup: SF_PLACES.ferryBuilding,
  dropoff: SF_PLACES.missionDolores,
  passengerCount: 1,
  requestedAt: T0,
  estimatedPayout: fromDecimal(11.7),
  estimatedTripDistanceMeters: haversineMeters(
    SF_PLACES.ferryBuilding,
    SF_PLACES.missionDolores,
  ),
  estimatedTripDurationMs: 14 * 60 * 1000,
  excludedDriverIds: [],
  ...overrides,
});

/** Places a driver a set distance from a point, on a given bearing. */
export const candidateAt = (
  distanceMeters: number,
  overrides: Partial<DriverCandidate> = {},
): DriverCandidate =>
  makeCandidate({
    distanceMeters,
    etaToPickupMs: Math.round((distanceMeters / 8.9) * 1000),
    ...overrides,
  });

export type { DriverId, RideId, RiderId, VehicleId };
export { bearingDegrees };
