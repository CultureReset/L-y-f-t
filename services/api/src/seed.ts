/**
 * Demo data.
 *
 * Populates a market with drivers spread around the city, a rider with saved
 * places and a card, and some completed ride history — enough that both apps
 * and the ops console have something real to show the moment they open.
 *
 * Deterministic by default, so screenshots and tests are reproducible.
 */

import {
  defaultDriverPreferences,
  defaultRiderPreferences,
  destination,
  newDriverId,
  newPaymentMethodId,
  newPlaceId,
  newRiderId,
  newUserId,
  newVehicleId,
  seededRandom,
  type DriverProfile,
  type Position,
  type RiderProfile,
  type User,
  type Vehicle,
  type VehicleFeature,
} from '@lift/core';
import { SEED_PLACES } from '@lift/geo';
import type { Container } from './container.js';

export interface SeedOptions {
  readonly driverCount?: number;
  readonly seed?: number;
  /** Metres around the market centre to scatter drivers. */
  readonly spreadMeters?: number;
}

export interface SeedSummary {
  readonly drivers: number;
  readonly riders: number;
  readonly demoRiderPhone: string;
  readonly demoDriverPhone: string;
}

const FIRST_NAMES = [
  'Maya', 'Andre', 'Priya', 'Tomás', 'Grace', 'Wei', 'Fatima', 'Diego',
  'Nadia', 'Elias', 'Rosa', 'Kwame', 'Hana', 'Marcus', 'Leila', 'Sam',
  'Ines', 'Yusuf', 'Clara', 'Dmitri',
];
const LAST_NAMES = [
  'Okonkwo', 'Ramirez', 'Patel', 'Silva', 'Nguyen', 'Chen', 'Haddad', 'Moreau',
  'Kowalski', 'Bennett', 'Santos', 'Mensah', 'Tanaka', 'Whitfield', 'Farouk', 'Novak',
];

const VEHICLES: { make: string; model: string; seats: number; features: VehicleFeature[] }[] = [
  { make: 'Toyota', model: 'Camry', seats: 4, features: [] },
  { make: 'Honda', model: 'Accord', seats: 4, features: [] },
  { make: 'Toyota', model: 'Prius', seats: 4, features: ['hybrid'] },
  { make: 'Tesla', model: 'Model 3', seats: 4, features: ['electric', 'premium_interior'] },
  { make: 'Honda', model: 'Odyssey', seats: 6, features: ['extra_luggage'] },
  { make: 'Chevrolet', model: 'Suburban', seats: 6, features: ['extra_luggage'] },
  { make: 'Mercedes-Benz', model: 'E-Class', seats: 4, features: ['premium_interior'] },
  { make: 'Ford', model: 'Transit', seats: 5, features: ['wheelchair_accessible'] },
  { make: 'Subaru', model: 'Outback', seats: 4, features: ['bike_rack', 'pet_friendly'] },
  { make: 'Kia', model: 'Telluride', seats: 6, features: ['extra_luggage'] },
];

const COLORS = ['black', 'white', 'silver', 'gray', 'blue', 'red'] as const;

export const seedDemoData = async (
  container: Container,
  options: SeedOptions = {},
): Promise<SeedSummary> => {
  const random = seededRandom(options.seed ?? 20240101);
  const now = container.clock.now();
  const center = container.config.market.defaultCenter;
  const spread = options.spreadMeters ?? 6_000;
  const driverCount = options.driverCount ?? 12;

  // Skip seeding a store that already holds data.
  const existing = await container.repositories.users.list(1);
  if (existing.length > 0) {
    return {
      drivers: 0,
      riders: 0,
      demoRiderPhone: DEMO_RIDER_PHONE,
      demoDriverPhone: DEMO_DRIVER_PHONE,
    };
  }

  // ------------------------------------------------------------- the rider
  const riderUser = await container.repositories.users.create({
    id: newUserId(),
    phone: DEMO_RIDER_PHONE,
    firstName: 'Avery',
    lastName: 'Chen',
    email: 'avery@example.com',
    roles: ['rider'],
    locale: container.config.market.locale,
    currency: container.config.market.currency,
    createdAt: now - 120 * 86_400_000,
  });

  const riderProfile: RiderProfile = {
    id: newRiderId(),
    userId: riderUser.id,
    savedPlaces: [
      {
        id: newPlaceId(),
        label: 'Home',
        icon: 'home',
        createdAt: now - 100 * 86_400_000,
        place: {
          id: newPlaceId(),
          name: '1200 Valencia St',
          address: '1200 Valencia St, San Francisco, CA 94110',
          coordinates: { lat: 37.7522, lng: -122.4207 },
          category: 'home',
          source: 'saved',
        },
      },
      {
        id: newPlaceId(),
        label: 'Work',
        icon: 'work',
        createdAt: now - 100 * 86_400_000,
        place: {
          id: newPlaceId(),
          name: 'Salesforce Tower',
          address: '415 Mission St, San Francisco, CA 94105',
          coordinates: { lat: 37.7897, lng: -122.3972 },
          category: 'work',
          source: 'saved',
        },
      },
    ],
    rating: 4.92,
    ratingCount: 47,
    totalRides: 63,
    preferences: defaultRiderPreferences(),
    createdAt: riderUser.createdAt,
  };
  await container.repositories.riders.create(riderProfile);

  const card = await container.repositories.paymentMethods.create({
    id: newPaymentMethodId(),
    riderId: riderProfile.id,
    kind: 'card',
    brand: 'visa',
    last4: '4242',
    expiryMonth: 11,
    expiryYear: new Date(now).getFullYear() + 3,
    isDefault: true,
    createdAt: riderUser.createdAt,
  });
  await container.repositories.riders.update(riderProfile.id, {
    defaultPaymentMethodId: card.id,
  });

  // ------------------------------------------------------------ the fleet
  const drivers: DriverProfile[] = [];

  for (let i = 0; i < driverCount; i++) {
    const isDemoDriver = i === 0;
    const firstName = isDemoDriver ? 'Jordan' : random.pick(FIRST_NAMES);
    const lastName = isDemoDriver ? 'Reyes' : random.pick(LAST_NAMES);

    const user: User = await container.repositories.users.create({
      id: newUserId(),
      phone: isDemoDriver ? DEMO_DRIVER_PHONE : `+1415${String(5550100 + i).slice(-7)}`,
      firstName,
      lastName,
      roles: ['driver'],
      locale: container.config.market.locale,
      currency: container.config.market.currency,
      createdAt: now - random.int(30, 900) * 86_400_000,
    });

    const spec = random.pick(VEHICLES);
    const vehicleId = newVehicleId();
    const driverId = newDriverId();

    const vehicle: Vehicle = {
      id: vehicleId,
      driverId,
      make: spec.make,
      model: spec.model,
      year: new Date(now).getFullYear() - random.int(0, 6),
      color: random.pick(COLORS),
      licensePlate: `${random.int(1, 9)}${randomLetters(random, 3)}${random.int(100, 999)}`,
      seats: spec.seats,
      features: spec.features,
      activatedAt: user.createdAt,
    };
    await container.repositories.vehicles.create(vehicle);

    // Scatter drivers around the centre, all reporting a fresh position so
    // dispatch treats them as live.
    const spot = destination(center, random.float(0, 360), random.float(200, spread));
    const position: Position = {
      lat: spot.lat,
      lng: spot.lng,
      bearing: random.float(0, 360),
      speed: random.float(0, 14),
      accuracy: random.float(3, 12),
      timestamp: now,
    };

    const profile: DriverProfile = {
      id: driverId,
      userId: user.id,
      approvalStatus: 'approved',
      // Leave a couple offline so the ops console shows a realistic mix.
      availability: i < driverCount - 2 ? 'available' : 'offline',
      activeVehicleId: vehicleId,
      lastPosition: position,
      rating: Number(random.float(4.6, 5.0).toFixed(2)),
      ratingCount: random.int(20, 900),
      totalRides: random.int(50, 4_000),
      acceptanceRate: Number(random.float(0.6, 0.98).toFixed(2)),
      completionRate: Number(random.float(0.9, 1).toFixed(2)),
      documents: APPROVED_DOCUMENTS,
      preferences: defaultDriverPreferences(),
      memberSince: user.createdAt,
      lastOnlineAt: now - random.int(0, 45) * 60_000,
    };
    drivers.push(await container.repositories.drivers.create(profile));

    if (profile.availability === 'available') {
      await container.repositories.shifts.open({
        id: `shift_seed_${i}`,
        driverId,
        startedAt: now - random.int(20, 300) * 60_000,
        ridesCompleted: random.int(0, 12),
        ridesDeclined: random.int(0, 4),
        offersReceived: random.int(0, 20),
        grossEarnings: { amount: random.int(0, 24_000), currency: container.config.market.currency },
        tips: { amount: random.int(0, 4_000), currency: container.config.market.currency },
        bonuses: { amount: 0, currency: container.config.market.currency },
        onlineMillis: 0,
        distanceMeters: random.int(0, 90_000),
      });
    }
  }

  return {
    drivers: drivers.length,
    riders: 1,
    demoRiderPhone: DEMO_RIDER_PHONE,
    demoDriverPhone: DEMO_DRIVER_PHONE,
  };
};

export const DEMO_RIDER_PHONE = '+14155550100';
export const DEMO_DRIVER_PHONE = '+14155550199';

const APPROVED_DOCUMENTS: DriverProfile['documents'] = [
  { type: 'drivers_license', status: 'approved' },
  { type: 'vehicle_registration', status: 'approved' },
  { type: 'insurance', status: 'approved' },
  { type: 'background_check', status: 'approved' },
  { type: 'profile_photo', status: 'approved' },
];

const randomLetters = (random: ReturnType<typeof seededRandom>, count: number): string => {
  const alphabet = 'ABCDEFGHJKLMNPRSTUVWXYZ';
  let out = '';
  for (let i = 0; i < count; i++) out += alphabet[random.int(0, alphabet.length)];
  return out;
};

/** Places worth offering as venues in the demo market. */
export const demoVenues = SEED_PLACES.filter(
  (p) => p.category === 'airport' || p.category === 'venue' || p.category === 'transit',
);

// Allow running the seeder on its own: `npm run seed -w @lift/api`.
if (process.argv[1]?.endsWith('seed.ts')) {
  const { loadConfigFromEnv, loadServerConfig } = await import('./config/env.js');
  const { createContainer } = await import('./container.js');
  const container = await createContainer(loadConfigFromEnv(), loadServerConfig());
  const summary = await seedDemoData(container);
  console.log('Seeded:', summary);
  await container.stop();
}
