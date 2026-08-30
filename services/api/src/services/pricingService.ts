/**
 * Quoting and fare finalisation.
 *
 * Sits between the routing provider and the domain pricing engine: it turns an
 * itinerary into a route, the route into a pricing context, and the context
 * into a fare. Quotes are cached by id so the API can verify that the price a
 * rider confirms is the price they were shown.
 */

import {
  PricingEngine,
  applyTip,
  emptyFare,
  itineraryCoordinates,
  meetingPoint,
  type CurrencyCode,
  type FareBreakdown,
  type Itinerary,
  type Money,
  type PlatformConfig,
  type PricingContext,
  type PromoApplication,
  type RideType,
  type RideTypeCatalog,
  type SurgeProvider,
  type Clock,
  AppError,
} from '@lift/core';
import type { GeoProvider, Route } from '@lift/geo';

export interface QuoteRequest {
  readonly itinerary: Itinerary;
  readonly passengerCount?: number;
  readonly promo?: PromoApplication;
  readonly currency?: CurrencyCode;
  readonly scheduledFor?: number;
}

/** One ride type's price, as shown on the rider's picker. */
export interface RideTypeQuote {
  readonly rideType: RideType;
  readonly fare: FareBreakdown;
  /** Time until a driver of this type reaches the pickup. */
  readonly pickupEtaMs: number;
  readonly tripDurationMs: number;
  readonly tripDistanceMeters: number;
  readonly surgeMultiplier: number;
  readonly available: boolean;
  readonly unavailableReason?: string;
}

export interface QuoteBundle {
  readonly quoteId: string;
  readonly route: Route;
  readonly quotes: readonly RideTypeQuote[];
  readonly expiresAt: number;
  readonly computedAt: number;
}

export class PricingService {
  /** Quotes are kept only long enough to validate the booking that follows. */
  private readonly cache = new Map<string, { bundle: QuoteBundle; expiresAt: number }>();

  constructor(
    private readonly deps: {
      geo: GeoProvider;
      catalog: RideTypeCatalog;
      surge: SurgeProvider;
      config: PlatformConfig;
      clock: Clock;
      /** Nearest-driver ETA per ride type; dispatch supplies the real numbers. */
      estimatePickupEta?: (rideTypeId: string, pickup: { lat: number; lng: number }) => Promise<number | undefined>;
    },
  ) {}

  /** Price every enabled ride type for one itinerary. */
  async quote(request: QuoteRequest): Promise<QuoteBundle> {
    const now = this.deps.clock.now();
    const currency = request.currency ?? this.deps.config.market.currency;
    const waypoints = itineraryCoordinates(request.itinerary);

    if (!this.deps.geo.route) {
      throw new AppError('provider_unavailable', 'The configured geo provider cannot route');
    }
    const route = await this.deps.geo.route({
      waypoints,
      steps: false,
      departAt: request.scheduledFor ?? now,
    });

    const pickup = meetingPoint(request.itinerary.pickup);
    const dropoff = meetingPoint(request.itinerary.dropoff);
    const passengerCount = request.passengerCount ?? 1;
    const durationMs = route.durationInTrafficMs ?? route.durationMs;

    const quotes: RideTypeQuote[] = [];
    for (const rideType of this.deps.catalog.list()) {
      const surgeMultiplier = await this.deps.surge.multiplierFor({
        location: pickup,
        rideTypeId: rideType.id,
        at: now,
      });

      const context: PricingContext = {
        rideTypeId: rideType.id,
        currency,
        distanceMeters: route.distanceMeters,
        durationMs,
        surgeMultiplier,
        at: now,
        pickup,
        dropoff,
        stopCount: request.itinerary.stops.length,
        passengerCount,
        isEstimate: true,
        ...(request.promo ? { promo: request.promo } : {}),
        ...(route.tolls ? { tolls: route.tolls } : {}),
      };

      const engine = PricingEngine.forRideType(rideType, {
        quoteTtlMs: this.deps.config.pricing.quoteTtlMs,
        estimateSpread: this.deps.config.pricing.estimateSpread,
      });

      const measuredEta = await this.deps.estimatePickupEta?.(rideType.id, pickup);
      const available = passengerCount <= rideType.maxPassengers;

      quotes.push({
        rideType,
        fare: engine.price(context),
        // Fall back to a scarcity-scaled default when no driver is online yet,
        // so the picker still shows a plausible wait rather than nothing.
        pickupEtaMs: measuredEta ?? Math.round(4 * 60 * 1000 * rideType.etaMultiplier),
        tripDurationMs: durationMs,
        tripDistanceMeters: route.distanceMeters,
        surgeMultiplier,
        available,
        ...(available
          ? {}
          : { unavailableReason: `${rideType.name} seats up to ${rideType.maxPassengers}` }),
      });
    }

    const quoteId = `qt_${now.toString(36)}${Math.random().toString(36).slice(2, 10)}`;
    const expiresAt = now + this.deps.config.pricing.quoteTtlMs;
    const bundle: QuoteBundle = { quoteId, route, quotes, expiresAt, computedAt: now };

    this.cache.set(quoteId, { bundle, expiresAt });
    this.evictExpired(now);
    return bundle;
  }

  /** Retrieve a quote the rider was shown, if it is still valid. */
  getQuote(quoteId: string): QuoteBundle | undefined {
    const entry = this.cache.get(quoteId);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.deps.clock.now()) {
      this.cache.delete(quoteId);
      return undefined;
    }
    return entry.bundle;
  }

  /**
   * Price a completed ride against what actually happened — real distance, real
   * duration, real wait time — rather than what was estimated.
   */
  finalize(input: {
    rideType: RideType;
    itinerary: Itinerary;
    distanceMeters: number;
    durationMs: number;
    surgeMultiplier: number;
    waitMinutes?: number;
    tolls?: Money;
    promo?: PromoApplication;
    currency: CurrencyCode;
    quotedFare?: FareBreakdown;
    at: number;
    passengerCount: number;
  }): FareBreakdown {
    const engine = PricingEngine.forRideType(input.rideType);
    const context: PricingContext = {
      rideTypeId: input.rideType.id,
      currency: input.currency,
      distanceMeters: input.distanceMeters,
      durationMs: input.durationMs,
      surgeMultiplier: input.surgeMultiplier,
      at: input.at,
      pickup: meetingPoint(input.itinerary.pickup),
      dropoff: meetingPoint(input.itinerary.dropoff),
      stopCount: input.itinerary.stops.length,
      passengerCount: input.passengerCount,
      isEstimate: false,
      ...(input.waitMinutes !== undefined ? { waitMinutes: input.waitMinutes } : {}),
      ...(input.tolls ? { tolls: input.tolls } : {}),
      ...(input.promo ? { promo: input.promo } : {}),
    };
    return engine.finalize(context, input.quotedFare);
  }

  /** Compute the fee for a late cancellation. */
  cancellationFare(rideType: RideType, at: number, currency: CurrencyCode): FareBreakdown {
    return PricingEngine.cancellationFor(rideType).price({
      rideTypeId: rideType.id,
      currency,
      distanceMeters: 0,
      durationMs: 0,
      surgeMultiplier: 1,
      at,
      pickup: { lat: 0, lng: 0 },
      dropoff: { lat: 0, lng: 0 },
      stopCount: 0,
      passengerCount: 1,
      isEstimate: false,
    });
  }

  addTip(fare: FareBreakdown, tip: Money): FareBreakdown {
    return applyTip(fare, tip);
  }

  emptyFare(rideTypeId: string, currency: CurrencyCode): FareBreakdown {
    return emptyFare(rideTypeId, currency, this.deps.clock.now());
  }

  private evictExpired(now: number): void {
    for (const [id, entry] of this.cache) {
      if (entry.expiresAt <= now) this.cache.delete(id);
    }
  }
}
