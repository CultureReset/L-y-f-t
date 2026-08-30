/**
 * OSRM + Nominatim adapter — the fully open-source option.
 *
 * OSRM does routing and matrices; Nominatim does geocoding and search. Both can
 * be self-hosted, which makes this the adapter to pick when per-request pricing
 * or data residency rules out a commercial provider.
 *
 * Note the public demo endpoints are rate-limited and unsuitable for
 * production — point `routerUrl`/`geocoderUrl` at your own instances.
 */

import { boundsOf, decodePolyline, newPlaceId, type LatLng, type Place, type PlaceCategory } from '@lift/core';
import type {
  AutocompleteQuery,
  GeoCapabilities,
  GeoProvider,
  GeocodeQuery,
  MatrixRequest,
  PlaceSuggestion,
  Route,
  RouteLeg,
  RouteManeuver,
  RouteRequest,
  RouteStep,
  TileConfig,
  TravelEstimate,
} from '../types.js';
import { httpJson, type HttpClient } from '../http.js';

const CAPABILITIES: GeoCapabilities = {
  autocomplete: true,
  geocode: true,
  reverseGeocode: true,
  routing: true,
  matrix: true,
  turnByTurn: true,
  tiles: true,
  tolls: false,
};

export interface OsrmGeoProviderOptions {
  /** OSRM base URL, e.g. `https://router.project-osrm.org`. */
  readonly routerUrl?: string;
  /** Nominatim base URL, e.g. `https://nominatim.openstreetmap.org`. */
  readonly geocoderUrl?: string;
  /** Nominatim requires a real identifying User-Agent. */
  readonly userAgent?: string;
  readonly tileUrlTemplate?: string;
  readonly http?: HttpClient;
}

export class OsrmGeoProvider implements GeoProvider {
  readonly id = 'osrm';
  readonly capabilities = CAPABILITIES;

  private readonly routerUrl: string;
  private readonly geocoderUrl: string;
  private readonly http: HttpClient;

  constructor(private readonly options: OsrmGeoProviderOptions = {}) {
    this.routerUrl = trimSlash(options.routerUrl ?? 'https://router.project-osrm.org');
    this.geocoderUrl = trimSlash(options.geocoderUrl ?? 'https://nominatim.openstreetmap.org');
    this.http = options.http ?? httpJson;
  }

  async autocomplete(query: AutocompleteQuery): Promise<PlaceSuggestion[]> {
    const results = await this.search(query.text, {
      limit: query.limit ?? 6,
      near: query.near,
    });
    return results.map((r) => ({
      ref: `${r.osm_type ?? 'node'}:${r.osm_id ?? r.place_id}`,
      primaryText: primaryName(r),
      secondaryText: secondaryName(r),
      category: categoryFor(r),
      coordinates: { lat: Number(r.lat), lng: Number(r.lon) },
      providerId: this.id,
    }));
  }

  async details(ref: string): Promise<Place> {
    const [osmType, osmId] = ref.split(':');
    const params = new URLSearchParams({
      format: 'jsonv2',
      osm_ids: `${(osmType ?? 'N').charAt(0).toUpperCase()}${osmId}`,
    });
    const results = await this.http<NominatimResult[]>(
      `${this.geocoderUrl}/lookup?${params}`,
      { headers: this.headers() },
    );
    const first = results[0];
    if (!first) throw new Error(`Nominatim returned no place for "${ref}"`);
    return this.toPlace(first, 'autocomplete');
  }

  async geocode(query: GeocodeQuery): Promise<Place[]> {
    const results = await this.search(query.address, {
      limit: query.limit ?? 5,
      near: query.near,
    });
    return results.map((r) => this.toPlace(r, 'geocoder'));
  }

  async reverseGeocode(coordinates: LatLng): Promise<Place> {
    const params = new URLSearchParams({
      format: 'jsonv2',
      lat: String(coordinates.lat),
      lon: String(coordinates.lng),
    });
    const result = await this.http<NominatimResult>(
      `${this.geocoderUrl}/reverse?${params}`,
      { headers: this.headers() },
    );
    return this.toPlace(result, 'geocoder');
  }

  async route(request: RouteRequest): Promise<Route> {
    const coords = request.waypoints.map((w) => `${w.lng},${w.lat}`).join(';');
    const params = new URLSearchParams({
      overview: 'full',
      geometries: 'polyline',
      steps: String(request.steps !== false),
    });
    const response = await this.http<OsrmRouteResponse>(
      `${this.routerUrl}/route/v1/driving/${coords}?${params}`,
    );
    const route = response.routes?.[0];
    if (!route) throw new Error(`OSRM returned no route (${response.code ?? 'unknown'})`);

    const legs: RouteLeg[] = (route.legs ?? []).map((leg, index) => ({
      from: request.waypoints[index] ?? request.waypoints[0]!,
      to: request.waypoints[index + 1] ?? request.waypoints[request.waypoints.length - 1]!,
      distanceMeters: Math.round(leg.distance ?? 0),
      durationMs: Math.round((leg.duration ?? 0) * 1000),
      geometry: route.geometry ?? '',
      steps: (leg.steps ?? []).map(toStep),
    }));

    return {
      distanceMeters: Math.round(route.distance ?? 0),
      durationMs: Math.round((route.duration ?? 0) * 1000),
      geometry: route.geometry ?? '',
      legs,
      bounds: route.geometry
        ? boundsOf(decodePolyline(route.geometry), 0.12)
        : boundsOf([...request.waypoints], 0.12),
      providerId: this.id,
    };
  }

  async matrix(request: MatrixRequest): Promise<TravelEstimate[][]> {
    const all = [...request.origins, ...request.destinations];
    const coords = all.map((c) => `${c.lng},${c.lat}`).join(';');
    const params = new URLSearchParams({
      sources: request.origins.map((_, i) => i).join(';'),
      destinations: request.destinations.map((_, i) => i + request.origins.length).join(';'),
      annotations: 'duration,distance',
    });
    const response = await this.http<OsrmTableResponse>(
      `${this.routerUrl}/table/v1/driving/${coords}?${params}`,
    );
    return (response.durations ?? []).map((row, i) =>
      row.map((duration, j) => ({
        durationMs: Math.round((duration ?? 0) * 1000),
        distanceMeters: Math.round(response.distances?.[i]?.[j] ?? 0),
      })),
    );
  }

  tiles(): TileConfig {
    return {
      kind: 'raster',
      urlTemplate:
        this.options.tileUrlTemplate ?? 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      attribution: '© OpenStreetMap contributors',
      maxZoom: 19,
    };
  }

  private async search(
    text: string,
    options: { limit: number; near?: LatLng },
  ): Promise<NominatimResult[]> {
    const params = new URLSearchParams({
      q: text,
      format: 'jsonv2',
      addressdetails: '1',
      limit: String(options.limit),
    });
    if (options.near) {
      const d = 0.3;
      params.set(
        'viewbox',
        [
          options.near.lng - d,
          options.near.lat + d,
          options.near.lng + d,
          options.near.lat - d,
        ].join(','),
      );
    }
    return this.http<NominatimResult[]>(`${this.geocoderUrl}/search?${params}`, {
      headers: this.headers(),
    });
  }

  private headers(): Record<string, string> {
    return {
      'user-agent': this.options.userAgent ?? 'lift-platform/1.0 (self-hosted)',
    };
  }

  private toPlace(result: NominatimResult, source: Place['source']): Place {
    return {
      id: newPlaceId(),
      name: primaryName(result),
      address: result.display_name ?? '',
      subtitle: secondaryName(result),
      coordinates: { lat: Number(result.lat), lng: Number(result.lon) },
      category: categoryFor(result),
      source,
      providerId: this.id,
      externalRef: `${result.osm_type ?? 'node'}:${result.osm_id ?? result.place_id}`,
    };
  }
}

const trimSlash = (url: string): string => url.replace(/\/+$/, '');

const primaryName = (r: NominatimResult): string =>
  r.name ||
  [r.address?.house_number, r.address?.road].filter(Boolean).join(' ') ||
  (r.display_name ?? '').split(',')[0] ||
  'Unknown place';

const secondaryName = (r: NominatimResult): string =>
  (r.display_name ?? '').split(',').slice(1, 4).join(',').trim();

const CATEGORY_BY_OSM_CLASS: Record<string, PlaceCategory> = {
  aeroway: 'airport',
  railway: 'transit',
  amenity: 'venue',
  shop: 'shopping',
  tourism: 'hotel',
  building: 'address',
  highway: 'address',
  place: 'other',
};

const categoryFor = (r: NominatimResult): PlaceCategory => {
  if (r.type === 'aerodrome' || r.class === 'aeroway') return 'airport';
  if (r.type === 'restaurant' || r.type === 'cafe' || r.type === 'bar') return 'restaurant';
  if (r.type === 'hospital' || r.type === 'clinic') return 'hospital';
  if (r.type === 'hotel' || r.type === 'motel') return 'hotel';
  if (r.type === 'station' || r.class === 'railway') return 'transit';
  return CATEGORY_BY_OSM_CLASS[r.class ?? ''] ?? 'address';
};

const MANEUVER_MAP: Record<string, RouteManeuver> = {
  depart: 'depart',
  arrive: 'arrive',
  merge: 'merge',
  fork: 'fork',
  roundabout: 'roundabout',
  rotary: 'roundabout',
  'new name': 'continue',
  continue: 'continue',
};

const toStep = (step: OsrmStep): RouteStep => {
  const maneuver = step.maneuver;
  let mapped: RouteManeuver = MANEUVER_MAP[maneuver?.type ?? ''] ?? 'continue';
  if (maneuver?.type === 'turn' || maneuver?.type === 'continue') {
    mapped = modifierToManeuver(maneuver.modifier) ?? mapped;
  }
  const street = step.name || 'the road';
  return {
    instruction: instructionFor(mapped, street),
    maneuver: mapped,
    distanceMeters: Math.round(step.distance ?? 0),
    durationMs: Math.round((step.duration ?? 0) * 1000),
    location: { lat: maneuver?.location?.[1] ?? 0, lng: maneuver?.location?.[0] ?? 0 },
    streetName: step.name,
    geometry: typeof step.geometry === 'string' ? step.geometry : '',
  };
};

const modifierToManeuver = (modifier?: string): RouteManeuver | undefined => {
  switch (modifier) {
    case 'left':
      return 'turn_left';
    case 'right':
      return 'turn_right';
    case 'slight left':
      return 'turn_slight_left';
    case 'slight right':
      return 'turn_slight_right';
    case 'sharp left':
      return 'turn_sharp_left';
    case 'sharp right':
      return 'turn_sharp_right';
    case 'uturn':
      return 'u_turn';
    case 'straight':
      return 'continue';
    default:
      return undefined;
  }
};

/** OSRM ships no prose instructions, so we compose them from the manoeuvre. */
const instructionFor = (maneuver: RouteManeuver, street: string): string => {
  switch (maneuver) {
    case 'depart':
      return `Head onto ${street}`;
    case 'arrive':
      return 'Arrive at your destination';
    case 'continue':
      return `Continue on ${street}`;
    case 'merge':
      return `Merge onto ${street}`;
    case 'fork':
      return `Keep to the fork onto ${street}`;
    case 'roundabout':
      return `At the roundabout, take the exit onto ${street}`;
    case 'u_turn':
      return `Make a U-turn onto ${street}`;
    default:
      return `Turn ${maneuver.replace('turn_', '').replace('_', ' ')} onto ${street}`;
  }
};

interface NominatimResult {
  place_id?: number;
  osm_type?: string;
  osm_id?: number;
  lat: string;
  lon: string;
  name?: string;
  display_name?: string;
  class?: string;
  type?: string;
  address?: { house_number?: string; road?: string };
}
interface OsrmStep {
  name?: string;
  distance?: number;
  duration?: number;
  geometry?: string;
  maneuver?: { type?: string; modifier?: string; location?: [number, number] };
}
interface OsrmRouteResponse {
  code?: string;
  routes?: {
    distance?: number;
    duration?: number;
    geometry?: string;
    legs?: { distance?: number; duration?: number; steps?: OsrmStep[] }[];
  }[];
}
interface OsrmTableResponse {
  durations?: number[][];
  distances?: number[][];
}
