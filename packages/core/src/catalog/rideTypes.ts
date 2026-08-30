/**
 * The ride type catalog — the classes of service a market offers.
 *
 * Everything that distinguishes "Standard" from "XL" from "Lux" lives in a
 * data record here: the rate card, the vehicle requirements, the dispatch
 * tuning, the way it presents in the picker. Adding a service tier is a
 * `catalog.register({...})` call, not a code change anywhere else.
 */

import type { Vehicle, VehicleFeature } from '../domain/vehicle.js';
import { fromDecimal, type CurrencyCode, type Money } from '../util/money.js';
import type { RateCard } from '../pricing/types.js';

export type RideTypeId = string;

export interface RideType {
  readonly id: RideTypeId;
  readonly name: string;
  /** One-line pitch shown under the name in the picker. */
  readonly tagline: string;
  readonly description: string;
  /** Icon key resolved by the app's icon registry. */
  readonly icon: string;
  /** Sort order in the rider's picker; lower is higher in the list. */
  readonly displayOrder: number;
  /** Max passengers this tier carries. */
  readonly maxPassengers: number;
  readonly rateCard: RateCard;
  readonly vehicleRequirements: VehicleRequirements;
  /** Dispatch tuning overrides for this tier. */
  readonly dispatch: RideTypeDispatchConfig;
  /** Optional badge: "Popular", "Cheapest", "Eco". */
  readonly badge?: string;
  /** Multiplier applied to the raw ETA — premium tiers are typically scarcer. */
  readonly etaMultiplier: number;
  /** Shared rides split the vehicle between unrelated riders. */
  readonly shared: boolean;
  readonly enabled: boolean;
}

export interface VehicleRequirements {
  readonly minSeats: number;
  /** Model year floor, e.g. premium tiers require a recent vehicle. */
  readonly minYear?: number;
  readonly requiredFeatures: readonly VehicleFeature[];
  /** Minimum driver rating to serve this tier. */
  readonly minDriverRating?: number;
}

export interface RideTypeDispatchConfig {
  /** How far dispatch will look for a driver. */
  readonly searchRadiusMeters: number;
  /** How long a driver has to accept an offer. */
  readonly offerTimeoutMs: number;
  /** Give up on the whole search after this long. */
  readonly searchTimeoutMs: number;
  /** How many drivers get an offer at once. 1 = strictly sequential. */
  readonly offerBatchSize: number;
}

/** Build an amount in whichever currency the market runs on. */
const at = (currency: CurrencyCode) => (value: number): Money => fromDecimal(value, currency);

/** A sensible rate card to build tiers from; override the fields that differ. */
export const baseRateCard = (currency: CurrencyCode = 'USD'): RateCard => ({
  currency,
  baseFare: fromDecimal(2.5, currency),
  perMile: fromDecimal(1.15, currency),
  perMinute: fromDecimal(0.28, currency),
  minimumFare: fromDecimal(7.0, currency),
  serviceFee: fromDecimal(3.15, currency),
  commissionRate: 0.25,
  cancellationFee: fromDecimal(5.0, currency),
  freeCancellationWindowMs: 2 * 60 * 1000,
  freeWaitMinutes: 2,
  perMinuteWaiting: fromDecimal(0.45, currency),
  maxSurgeMultiplier: 3.0,
  taxRate: 0.0,
});

const defaultDispatch: RideTypeDispatchConfig = {
  searchRadiusMeters: 8_000,
  offerTimeoutMs: 15_000,
  searchTimeoutMs: 5 * 60 * 1000,
  offerBatchSize: 1,
};

/**
 * The stock catalog, priced in the market's currency.
 *
 * This is data, not structure — replace it wholesale for a different market and
 * nothing downstream changes. The rates below are illustrative; the shape is
 * the point.
 */
export const defaultRideTypes = (currency: CurrencyCode = 'USD'): RideType[] => {
  const money = at(currency);
  return [
  {
    id: 'standard',
    name: 'Standard',
    tagline: 'Affordable rides, all to yourself',
    description: 'An everyday car for up to 4 riders.',
    icon: 'car',
    displayOrder: 10,
    maxPassengers: 4,
    rateCard: baseRateCard(currency),
    vehicleRequirements: { minSeats: 4, requiredFeatures: [] },
    dispatch: defaultDispatch,
    badge: 'Popular',
    etaMultiplier: 1,
    shared: false,
    enabled: true,
  },
  {
    id: 'shared',
    name: 'Shared',
    tagline: 'Share the ride, split the cost',
    description: 'Match with riders heading the same way. Expect a couple of stops.',
    icon: 'users',
    displayOrder: 5,
    maxPassengers: 2,
    rateCard: {
      ...baseRateCard(currency),
      baseFare: money(1.75),
      perMile: money(0.85),
      perMinute: money(0.19),
      minimumFare: money(4.5),
      serviceFee: money(2.4),
    },
    vehicleRequirements: { minSeats: 4, requiredFeatures: [] },
    dispatch: { ...defaultDispatch, searchRadiusMeters: 6_000, searchTimeoutMs: 7 * 60 * 1000 },
    badge: 'Cheapest',
    etaMultiplier: 1.35,
    shared: true,
    enabled: true,
  },
  {
    id: 'xl',
    name: 'XL',
    tagline: 'Extra room for up to 6',
    description: 'An SUV or minivan for bigger groups and bigger bags.',
    icon: 'van',
    displayOrder: 20,
    maxPassengers: 6,
    rateCard: {
      ...baseRateCard(currency),
      baseFare: money(3.75),
      perMile: money(1.95),
      perMinute: money(0.42),
      minimumFare: money(11.5),
      serviceFee: money(3.75),
    },
    vehicleRequirements: { minSeats: 6, requiredFeatures: [] },
    dispatch: { ...defaultDispatch, searchRadiusMeters: 12_000, offerTimeoutMs: 20_000 },
    etaMultiplier: 1.4,
    shared: false,
    enabled: true,
  },
  {
    id: 'lux',
    name: 'Lux',
    tagline: 'High-end cars, top-rated drivers',
    description: 'A premium sedan with a highly rated driver.',
    icon: 'sparkle',
    displayOrder: 30,
    maxPassengers: 4,
    rateCard: {
      ...baseRateCard(currency),
      baseFare: money(6.5),
      perMile: money(3.25),
      perMinute: money(0.65),
      minimumFare: money(19.5),
      serviceFee: money(4.5),
      cancellationFee: money(10),
      commissionRate: 0.28,
    },
    vehicleRequirements: {
      minSeats: 4,
      minYear: new Date().getFullYear() - 5,
      requiredFeatures: ['premium_interior'],
      minDriverRating: 4.8,
    },
    dispatch: { ...defaultDispatch, searchRadiusMeters: 16_000, offerTimeoutMs: 25_000 },
    etaMultiplier: 1.8,
    shared: false,
    enabled: true,
  },
  {
    id: 'access',
    name: 'Access',
    tagline: 'Wheelchair accessible vehicles',
    description: 'A vehicle with a ramp or lift, driven by a trained driver.',
    icon: 'accessible',
    displayOrder: 40,
    maxPassengers: 4,
    rateCard: baseRateCard(currency),
    vehicleRequirements: { minSeats: 3, requiredFeatures: ['wheelchair_accessible'] },
    dispatch: {
      ...defaultDispatch,
      searchRadiusMeters: 25_000,
      offerTimeoutMs: 30_000,
      searchTimeoutMs: 12 * 60 * 1000,
    },
    etaMultiplier: 2.2,
    shared: false,
    enabled: true,
  },
  ];
};

/** The stock catalog in USD. Prefer `defaultRideTypes(currency)`. */
export const DEFAULT_RIDE_TYPES: readonly RideType[] = defaultRideTypes('USD');

/**
 * A mutable registry of ride types. The API holds one instance; tests and the
 * simulator build their own. Registering an id that already exists replaces it,
 * which is how a market-specific override is applied on top of the defaults.
 */
export class RideTypeCatalog {
  private readonly types = new Map<RideTypeId, RideType>();

  constructor(initial: readonly RideType[] = defaultRideTypes()) {
    for (const type of initial) this.register(type);
  }

  register(type: RideType): this {
    this.types.set(type.id, type);
    return this;
  }

  /** Patch one field of an existing type — e.g. raise a market's per-mile rate. */
  override(id: RideTypeId, patch: Partial<Omit<RideType, 'id'>>): this {
    const existing = this.types.get(id);
    if (!existing) throw new Error(`Cannot override unknown ride type "${id}"`);
    this.types.set(id, { ...existing, ...patch });
    return this;
  }

  unregister(id: RideTypeId): this {
    this.types.delete(id);
    return this;
  }

  get(id: RideTypeId): RideType | undefined {
    return this.types.get(id);
  }

  require(id: RideTypeId): RideType {
    const type = this.types.get(id);
    if (!type) throw new Error(`Unknown ride type "${id}"`);
    return type;
  }

  has(id: RideTypeId): boolean {
    return this.types.has(id);
  }

  /** Enabled types in display order — exactly what the picker renders. */
  list(): RideType[] {
    return [...this.types.values()]
      .filter((t) => t.enabled)
      .sort((a, b) => a.displayOrder - b.displayOrder);
  }

  listAll(): RideType[] {
    return [...this.types.values()].sort((a, b) => a.displayOrder - b.displayOrder);
  }

  /** Types a given vehicle and driver rating qualify to serve. */
  eligibleFor(vehicle: Vehicle, driverRating: number): RideType[] {
    return this.list().filter((type) => vehicleQualifies(type, vehicle, driverRating));
  }

  /** Types that can carry this many passengers. */
  forPassengers(count: number): RideType[] {
    return this.list().filter((t) => t.maxPassengers >= count);
  }
}

/** Whether a vehicle + driver rating satisfies a tier's requirements. */
export const vehicleQualifies = (
  type: RideType,
  vehicle: Vehicle,
  driverRating: number,
): boolean => {
  const req = type.vehicleRequirements;
  if (vehicle.seats < req.minSeats) return false;
  if (req.minYear !== undefined && vehicle.year < req.minYear) return false;
  if (req.minDriverRating !== undefined && driverRating < req.minDriverRating) return false;
  return req.requiredFeatures.every((f) => vehicle.features.includes(f));
};

export const defaultCatalog = (currency: CurrencyCode = 'USD'): RideTypeCatalog =>
  new RideTypeCatalog(defaultRideTypes(currency));
