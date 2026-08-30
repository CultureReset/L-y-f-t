/**
 * Composing providers.
 *
 * Real deployments rarely use one vendor for everything — Mapbox search with
 * self-hosted OSRM routing is a common and much cheaper pairing. `Composite`
 * routes each capability to whichever provider you nominate, and `withFallback`
 * makes a provider degrade to another instead of failing a ride.
 */

import type {
  AutocompleteQuery,
  GeoCapabilities,
  GeoProvider,
  GeocodeQuery,
  MatrixRequest,
  PlaceSuggestion,
  Route,
  RouteRequest,
  TileConfig,
  TravelEstimate,
} from './types.js';
import type { LatLng, Place } from '@lift/core';

export interface CompositeGeoProviderOptions {
  readonly search?: GeoProvider;
  readonly routing?: GeoProvider;
  readonly tiles?: GeoProvider;
  readonly id?: string;
}

/** Delegates each capability to a nominated provider. */
export class CompositeGeoProvider implements GeoProvider {
  readonly id: string;
  readonly capabilities: GeoCapabilities;

  private readonly search: GeoProvider | undefined;
  private readonly routing: GeoProvider | undefined;
  private readonly tileProvider: GeoProvider | undefined;

  constructor(options: CompositeGeoProviderOptions) {
    this.search = options.search;
    this.routing = options.routing;
    this.tileProvider = options.tiles ?? options.routing ?? options.search;
    this.id =
      options.id ??
      `composite(${[this.search?.id, this.routing?.id].filter(Boolean).join('+')})`;
    this.capabilities = {
      autocomplete: this.search?.capabilities.autocomplete ?? false,
      geocode: this.search?.capabilities.geocode ?? false,
      reverseGeocode: this.search?.capabilities.reverseGeocode ?? false,
      routing: this.routing?.capabilities.routing ?? false,
      matrix: this.routing?.capabilities.matrix ?? false,
      turnByTurn: this.routing?.capabilities.turnByTurn ?? false,
      tiles: this.tileProvider?.capabilities.tiles ?? false,
      tolls: this.routing?.capabilities.tolls ?? false,
    };
  }

  async autocomplete(query: AutocompleteQuery): Promise<PlaceSuggestion[]> {
    return this.search?.autocomplete?.(query) ?? [];
  }

  async details(ref: string): Promise<Place> {
    if (!this.search?.details) throw new Error(`${this.id}: no search provider configured`);
    return this.search.details(ref);
  }

  async geocode(query: GeocodeQuery): Promise<Place[]> {
    return this.search?.geocode?.(query) ?? [];
  }

  async reverseGeocode(coordinates: LatLng): Promise<Place> {
    if (!this.search?.reverseGeocode) {
      throw new Error(`${this.id}: no reverse-geocoding provider configured`);
    }
    return this.search.reverseGeocode(coordinates);
  }

  async route(request: RouteRequest): Promise<Route> {
    if (!this.routing?.route) throw new Error(`${this.id}: no routing provider configured`);
    return this.routing.route(request);
  }

  async matrix(request: MatrixRequest): Promise<TravelEstimate[][]> {
    if (!this.routing?.matrix) throw new Error(`${this.id}: no matrix provider configured`);
    return this.routing.matrix(request);
  }

  tiles(): TileConfig {
    return (
      this.tileProvider?.tiles?.() ?? {
        kind: 'none',
        attribution: '',
        maxZoom: 20,
      }
    );
  }
}

/**
 * Wraps a provider so any failure falls through to a backup — in practice, to
 * the mock provider. A rider whose geocoder is down should still get a ride,
 * with a slightly worse ETA, rather than an error screen.
 */
export const withFallback = (
  primary: GeoProvider,
  fallback: GeoProvider,
  onFallback?: (method: string, error: unknown) => void,
): GeoProvider => {
  const attempt = async <T>(
    method: string,
    run: (p: GeoProvider) => Promise<T> | undefined,
  ): Promise<T> => {
    try {
      const result = run(primary);
      if (result !== undefined) return await result;
    } catch (e) {
      onFallback?.(method, e);
    }
    const backup = run(fallback);
    if (backup === undefined) {
      throw new Error(`Neither ${primary.id} nor ${fallback.id} implements ${method}`);
    }
    return backup;
  };

  return {
    id: `${primary.id}→${fallback.id}`,
    capabilities: {
      autocomplete: primary.capabilities.autocomplete || fallback.capabilities.autocomplete,
      geocode: primary.capabilities.geocode || fallback.capabilities.geocode,
      reverseGeocode:
        primary.capabilities.reverseGeocode || fallback.capabilities.reverseGeocode,
      routing: primary.capabilities.routing || fallback.capabilities.routing,
      matrix: primary.capabilities.matrix || fallback.capabilities.matrix,
      turnByTurn: primary.capabilities.turnByTurn || fallback.capabilities.turnByTurn,
      tiles: primary.capabilities.tiles || fallback.capabilities.tiles,
      tolls: primary.capabilities.tolls || fallback.capabilities.tolls,
    },
    autocomplete: (q) => attempt('autocomplete', (p) => p.autocomplete?.(q)),
    details: (ref) => attempt('details', (p) => p.details?.(ref)),
    geocode: (q) => attempt('geocode', (p) => p.geocode?.(q)),
    reverseGeocode: (c) => attempt('reverseGeocode', (p) => p.reverseGeocode?.(c)),
    route: (r) => attempt('route', (p) => p.route?.(r)),
    matrix: (r) => attempt('matrix', (p) => p.matrix?.(r)),
    tiles: () => primary.tiles?.() ?? fallback.tiles?.() ?? {
      kind: 'none' as const,
      attribution: '',
      maxZoom: 20,
    },
  };
};

/**
 * Memoises autocomplete, geocode, and matrix calls for a short window. Search
 * boxes fire a request per keystroke and dispatch re-ranks drivers every tick,
 * so this is where most of a provider bill would otherwise go.
 */
export const withCache = (
  provider: GeoProvider,
  options: { ttlMs?: number; maxEntries?: number } = {},
): GeoProvider => {
  const ttlMs = options.ttlMs ?? 30_000;
  const maxEntries = options.maxEntries ?? 500;
  const cache = new Map<string, { at: number; value: unknown }>();

  const memo = async <T>(key: string, run: () => Promise<T>): Promise<T> => {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return hit.value as T;
    const value = await run();
    if (cache.size >= maxEntries) {
      // Evict the oldest insertion; Map preserves insertion order.
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, { at: Date.now(), value });
    return value;
  };

  return {
    ...provider,
    id: provider.id,
    capabilities: provider.capabilities,
    autocomplete: provider.autocomplete
      ? (q) => memo(`ac:${JSON.stringify(q)}`, () => provider.autocomplete!(q))
      : undefined,
    geocode: provider.geocode
      ? (q) => memo(`gc:${JSON.stringify(q)}`, () => provider.geocode!(q))
      : undefined,
    reverseGeocode: provider.reverseGeocode
      ? (c) => memo(`rg:${c.lat.toFixed(5)},${c.lng.toFixed(5)}`, () => provider.reverseGeocode!(c))
      : undefined,
    matrix: provider.matrix
      ? (r) => memo(`mx:${JSON.stringify(r)}`, () => provider.matrix!(r))
      : undefined,
  };
};
