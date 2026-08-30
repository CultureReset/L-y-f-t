/**
 * The geo provider port.
 *
 * Everything the platform needs from the outside world about places and routes
 * is expressed here. Swapping Google for Mapbox for a self-hosted OSRM — or for
 * the built-in deterministic mock — is a configuration change, because no code
 * above this interface knows which one is answering.
 */

import type { LatLng, BoundingBox, Place, PlaceCategory } from '@lift/core';
import type { Money } from '@lift/core';

/** What a given provider can actually do. Callers check before relying on one. */
export interface GeoCapabilities {
  readonly autocomplete: boolean;
  readonly geocode: boolean;
  readonly reverseGeocode: boolean;
  readonly routing: boolean;
  /** Many-to-many travel times — used to rank drivers by real ETA. */
  readonly matrix: boolean;
  readonly turnByTurn: boolean;
  readonly tiles: boolean;
  readonly tolls: boolean;
}

export interface AutocompleteQuery {
  readonly text: string;
  /** Bias results toward the rider's current location. */
  readonly near?: LatLng;
  readonly radiusMeters?: number;
  readonly bounds?: BoundingBox;
  readonly limit?: number;
  readonly locale?: string;
  /** Restrict to certain kinds of place, when the provider supports it. */
  readonly categories?: readonly PlaceCategory[];
  readonly sessionToken?: string;
}

/**
 * A search result. Deliberately lighter than a `Place`: many providers charge
 * for the detail lookup, so the flow is suggest-then-resolve.
 */
export interface PlaceSuggestion {
  /** Opaque handle; pass back to `details()` to resolve a full Place. */
  readonly ref: string;
  readonly primaryText: string;
  readonly secondaryText: string;
  readonly category: PlaceCategory;
  /** Present when the provider returns coordinates with the suggestion. */
  readonly coordinates?: LatLng;
  readonly distanceMeters?: number;
  readonly providerId: string;
}

export interface GeocodeQuery {
  readonly address: string;
  readonly near?: LatLng;
  readonly limit?: number;
  readonly locale?: string;
}

export type RouteProfile = 'driving' | 'driving_traffic' | 'walking' | 'cycling';

export interface RouteRequest {
  /** Two or more points: origin, optional waypoints, destination. */
  readonly waypoints: readonly LatLng[];
  readonly profile?: RouteProfile;
  /** Departure time; enables traffic-aware routing where supported. */
  readonly departAt?: number;
  readonly alternatives?: boolean;
  /** Ask for turn-by-turn steps. Skipped for a simple ETA lookup. */
  readonly steps?: boolean;
  readonly avoidTolls?: boolean;
  readonly avoidHighways?: boolean;
}

export interface RouteStep {
  readonly instruction: string;
  readonly maneuver: RouteManeuver;
  readonly distanceMeters: number;
  readonly durationMs: number;
  /** Where the manoeuvre happens. */
  readonly location: LatLng;
  readonly streetName?: string;
  /** Encoded polyline for just this step. */
  readonly geometry: string;
}

export type RouteManeuver =
  | 'depart'
  | 'turn_left'
  | 'turn_right'
  | 'turn_slight_left'
  | 'turn_slight_right'
  | 'turn_sharp_left'
  | 'turn_sharp_right'
  | 'continue'
  | 'merge'
  | 'fork'
  | 'roundabout'
  | 'u_turn'
  | 'arrive';

export interface RouteLeg {
  readonly from: LatLng;
  readonly to: LatLng;
  readonly distanceMeters: number;
  readonly durationMs: number;
  readonly geometry: string;
  readonly steps: readonly RouteStep[];
}

export interface Route {
  readonly distanceMeters: number;
  readonly durationMs: number;
  /** Duration accounting for live traffic, when the provider models it. */
  readonly durationInTrafficMs?: number;
  /** Encoded polyline covering the whole route. */
  readonly geometry: string;
  readonly legs: readonly RouteLeg[];
  readonly tolls?: Money;
  readonly bounds: BoundingBox;
  readonly providerId: string;
  /** How confident the provider is in the duration, 0–1. */
  readonly confidence?: number;
}

/** A single origin→destination travel estimate. */
export interface TravelEstimate {
  readonly distanceMeters: number;
  readonly durationMs: number;
}

/**
 * What an unreachable pair costs.
 *
 * Not zero. A vendor says "no route" with a null or a status code, and mapping
 * that to `0` makes an unreachable driver look like the nearest one — dispatch
 * ranks on this number. Infinity is the honest answer, and every caller
 * already has to handle a missing estimate.
 */
export const UNREACHABLE: TravelEstimate = {
  distanceMeters: Number.POSITIVE_INFINITY,
  durationMs: Number.POSITIVE_INFINITY,
};

export interface MatrixRequest {
  readonly origins: readonly LatLng[];
  readonly destinations: readonly LatLng[];
  readonly profile?: RouteProfile;
  readonly departAt?: number;
}

/** How the apps should render a base map. */
export interface TileConfig {
  readonly kind: 'raster' | 'vector' | 'none';
  readonly urlTemplate?: string;
  readonly styleUrl?: string;
  readonly attribution: string;
  readonly maxZoom: number;
  /** Query parameter the key goes in, when the vendor wants one. */
  readonly apiKeyParam?: string;
  /**
   * The key itself.
   *
   * This reaches every client, and is meant to: a basemap is fetched by the
   * device, so there is no arrangement in which the key stays secret. Both
   * Mapbox and Google issue keys for exactly this and expect them to be
   * restricted by URL or bundle id at the vendor rather than hidden. Naming
   * the parameter without supplying the value was worse than either: no map
   * rendered, and the key looked protected when nothing was protecting it.
   *
   * Use a public, restricted key here — never a secret one.
   */
  readonly apiKey?: string;
}

/**
 * The provider port. Only `id` and `capabilities` are mandatory; every method
 * is optional so a provider can implement just what it is good at (OSRM routes
 * but does not geocode). `CompositeGeoProvider` stitches several together.
 */
export interface GeoProvider {
  readonly id: string;
  readonly capabilities: GeoCapabilities;
  autocomplete?(query: AutocompleteQuery): Promise<PlaceSuggestion[]>;
  /** Resolve a suggestion ref into a full Place. */
  details?(ref: string, providerId?: string): Promise<Place>;
  geocode?(query: GeocodeQuery): Promise<Place[]>;
  reverseGeocode?(coordinates: LatLng): Promise<Place>;
  route?(request: RouteRequest): Promise<Route>;
  matrix?(request: MatrixRequest): Promise<TravelEstimate[][]>;
  tiles?(): TileConfig;
}

/** Thrown when a caller asks a provider for something it cannot do. */
export class UnsupportedCapabilityError extends Error {
  constructor(providerId: string, capability: keyof GeoCapabilities) {
    super(`Provider "${providerId}" does not support ${capability}`);
    this.name = 'UnsupportedCapabilityError';
  }
}

export const requireCapability = (
  provider: GeoProvider,
  capability: keyof GeoCapabilities,
): void => {
  if (!provider.capabilities[capability]) {
    throw new UnsupportedCapabilityError(provider.id, capability);
  }
};
