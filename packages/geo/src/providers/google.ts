/**
 * Google Maps Platform adapter.
 *
 * Implements the same `GeoProvider` port as the mock, against Places
 * Autocomplete/Details, Geocoding, Directions, and Distance Matrix. Set
 * `GEO_PROVIDER=google` and `GEO_API_KEY=...` to switch the platform onto it;
 * nothing above this file changes.
 */

import { newPlaceId, type LatLng, type Place, type PlaceCategory } from '@lift/core';
import { fromDecimal, boundsOf, decodePolyline } from '@lift/core';
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
import { UNREACHABLE } from '../types.js';
import { httpJson, type HttpClient } from '../http.js';

const BASE = 'https://maps.googleapis.com/maps/api';

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

export interface GoogleGeoProviderOptions {
  readonly apiKey: string;
  readonly language?: string;
  readonly region?: string;
  readonly http?: HttpClient;
}

export class GoogleGeoProvider implements GeoProvider {
  readonly id = 'google';
  readonly capabilities = CAPABILITIES;

  private readonly http: HttpClient;

  constructor(private readonly options: GoogleGeoProviderOptions) {
    if (!options.apiKey) throw new Error('GoogleGeoProvider requires an apiKey');
    this.http = options.http ?? httpJson;
  }

  async autocomplete(query: AutocompleteQuery): Promise<PlaceSuggestion[]> {
    const params = new URLSearchParams({
      input: query.text,
      key: this.options.apiKey,
      language: query.locale ?? this.options.language ?? 'en',
    });
    if (query.near) {
      params.set('location', `${query.near.lat},${query.near.lng}`);
      params.set('radius', String(query.radiusMeters ?? 30_000));
    }
    if (query.sessionToken) params.set('sessiontoken', query.sessionToken);

    const response = await this.http<GooglePredictionsResponse>(
      `${BASE}/place/autocomplete/json?${params}`,
    );
    assertOk(response.status, response.error_message);
    return (response.predictions ?? []).slice(0, query.limit ?? 6).map((p) => ({
      ref: p.place_id,
      primaryText: p.structured_formatting?.main_text ?? p.description,
      secondaryText: p.structured_formatting?.secondary_text ?? '',
      category: categoryFromTypes(p.types),
      distanceMeters: p.distance_meters,
      providerId: this.id,
    }));
  }

  async details(ref: string): Promise<Place> {
    const params = new URLSearchParams({
      place_id: ref,
      key: this.options.apiKey,
      fields: 'place_id,name,formatted_address,geometry,types,address_components',
    });
    const response = await this.http<{ status: string; result?: GooglePlace; error_message?: string }>(
      `${BASE}/place/details/json?${params}`,
    );
    assertOk(response.status, response.error_message);
    if (!response.result) throw new Error(`Google returned no details for "${ref}"`);
    return this.toPlace(response.result, 'autocomplete');
  }

  async geocode(query: GeocodeQuery): Promise<Place[]> {
    const params = new URLSearchParams({ address: query.address, key: this.options.apiKey });
    if (query.near) params.set('bounds', boundsParam(query.near));
    const response = await this.http<{ status: string; results?: GooglePlace[]; error_message?: string }>(
      `${BASE}/geocode/json?${params}`,
    );
    assertOk(response.status, response.error_message);
    return (response.results ?? [])
      .slice(0, query.limit ?? 5)
      .map((r) => this.toPlace(r, 'geocoder'));
  }

  async reverseGeocode(coordinates: LatLng): Promise<Place> {
    const params = new URLSearchParams({
      latlng: `${coordinates.lat},${coordinates.lng}`,
      key: this.options.apiKey,
    });
    const response = await this.http<{ status: string; results?: GooglePlace[]; error_message?: string }>(
      `${BASE}/geocode/json?${params}`,
    );
    assertOk(response.status, response.error_message);
    const first = response.results?.[0];
    if (!first) throw new Error('Google returned no reverse-geocode result');
    return this.toPlace(first, 'geocoder');
  }

  async route(request: RouteRequest): Promise<Route> {
    const [origin, ...rest] = request.waypoints;
    const destination = rest.pop();
    if (!origin || !destination) {
      throw new Error('route() requires at least an origin and a destination');
    }
    const params = new URLSearchParams({
      origin: `${origin.lat},${origin.lng}`,
      destination: `${destination.lat},${destination.lng}`,
      key: this.options.apiKey,
      mode: 'driving',
    });
    if (rest.length > 0) {
      params.set('waypoints', rest.map((w) => `${w.lat},${w.lng}`).join('|'));
    }
    if (request.departAt) {
      params.set('departure_time', String(Math.floor(request.departAt / 1000)));
    }
    const avoid = [
      request.avoidTolls ? 'tolls' : undefined,
      request.avoidHighways ? 'highways' : undefined,
    ].filter(Boolean);
    if (avoid.length > 0) params.set('avoid', avoid.join('|'));

    const response = await this.http<GoogleDirectionsResponse>(
      `${BASE}/directions/json?${params}`,
    );
    assertOk(response.status, response.error_message);
    const route = response.routes?.[0];
    if (!route) throw new Error('Google returned no route');

    const legs: RouteLeg[] = (route.legs ?? []).map((leg) => ({
      from: { lat: leg.start_location.lat, lng: leg.start_location.lng },
      to: { lat: leg.end_location.lat, lng: leg.end_location.lng },
      distanceMeters: leg.distance?.value ?? 0,
      durationMs: (leg.duration_in_traffic?.value ?? leg.duration?.value ?? 0) * 1000,
      geometry: encodeFromSteps(leg),
      steps: (leg.steps ?? []).map(toStep),
    }));

    const geometry = route.overview_polyline?.points ?? '';
    return {
      distanceMeters: legs.reduce((s, l) => s + l.distanceMeters, 0),
      durationMs: legs.reduce((s, l) => s + l.durationMs, 0),
      durationInTrafficMs: (route.legs ?? []).reduce(
        (s, l) => s + (l.duration_in_traffic?.value ?? l.duration?.value ?? 0) * 1000,
        0,
      ),
      geometry,
      legs,
      bounds: geometry
        ? boundsOf(decodePolyline(geometry), 0.12)
        : boundsOf([origin, destination], 0.12),
      providerId: this.id,
    };
  }

  async matrix(request: MatrixRequest): Promise<TravelEstimate[][]> {
    const params = new URLSearchParams({
      origins: request.origins.map((o) => `${o.lat},${o.lng}`).join('|'),
      destinations: request.destinations.map((d) => `${d.lat},${d.lng}`).join('|'),
      key: this.options.apiKey,
      mode: 'driving',
    });
    if (request.departAt) {
      params.set('departure_time', String(Math.floor(request.departAt / 1000)));
    }
    const response = await this.http<GoogleMatrixResponse>(
      `${BASE}/distancematrix/json?${params}`,
    );
    assertOk(response.status, response.error_message);
    return (response.rows ?? []).map((row) =>
      (row.elements ?? []).map((el) => {
        // Google reports an unroutable pair per element, not for the request.
        const seconds = el.duration_in_traffic?.value ?? el.duration?.value;
        if (el.status !== 'OK' || seconds === undefined) return UNREACHABLE;
        return {
          distanceMeters: el.distance?.value ?? Number.POSITIVE_INFINITY,
          durationMs: seconds * 1000,
        };
      }),
    );
  }

  tiles(): TileConfig {
    return {
      kind: 'raster',
      urlTemplate: `${BASE}/staticmap`,
      attribution: '© Google',
      maxZoom: 21,
      apiKeyParam: 'key',
      // Static Maps keys are fetched by the device. Restrict this one by
      // referrer and bundle id in the Google Cloud console.
      apiKey: this.options.apiKey,
    };
  }

  private toPlace(result: GooglePlace, source: Place['source']): Place {
    const location = result.geometry?.location;
    return {
      id: newPlaceId(),
      name: result.name ?? result.formatted_address ?? 'Unknown place',
      address: result.formatted_address ?? '',
      coordinates: { lat: location?.lat ?? 0, lng: location?.lng ?? 0 },
      category: categoryFromTypes(result.types),
      source,
      providerId: this.id,
      externalRef: result.place_id,
    };
  }
}

// ------------------------------------------------------------------ helpers

const assertOk = (status: string, message?: string): void => {
  if (status === 'OK' || status === 'ZERO_RESULTS') return;
  throw new Error(`Google Maps error: ${status}${message ? ` — ${message}` : ''}`);
};

const boundsParam = (near: LatLng): string =>
  `${near.lat - 0.25},${near.lng - 0.25}|${near.lat + 0.25},${near.lng + 0.25}`;

const CATEGORY_BY_TYPE: Record<string, PlaceCategory> = {
  airport: 'airport',
  transit_station: 'transit',
  subway_station: 'transit',
  train_station: 'transit',
  bus_station: 'transit',
  lodging: 'hotel',
  restaurant: 'restaurant',
  cafe: 'restaurant',
  bar: 'restaurant',
  hospital: 'hospital',
  shopping_mall: 'shopping',
  store: 'shopping',
  stadium: 'venue',
  point_of_interest: 'venue',
  street_address: 'address',
  premise: 'address',
};

const categoryFromTypes = (types?: readonly string[]): PlaceCategory => {
  for (const type of types ?? []) {
    const mapped = CATEGORY_BY_TYPE[type];
    if (mapped) return mapped;
  }
  return 'address';
};

const MANEUVER_MAP: Record<string, RouteManeuver> = {
  'turn-left': 'turn_left',
  'turn-right': 'turn_right',
  'turn-slight-left': 'turn_slight_left',
  'turn-slight-right': 'turn_slight_right',
  'turn-sharp-left': 'turn_sharp_left',
  'turn-sharp-right': 'turn_sharp_right',
  'uturn-left': 'u_turn',
  'uturn-right': 'u_turn',
  merge: 'merge',
  fork_left: 'fork',
  fork_right: 'fork',
  'roundabout-left': 'roundabout',
  'roundabout-right': 'roundabout',
  straight: 'continue',
};

const toStep = (step: GoogleStep): RouteStep => ({
  instruction: stripHtml(step.html_instructions ?? ''),
  maneuver: MANEUVER_MAP[step.maneuver ?? ''] ?? 'continue',
  distanceMeters: step.distance?.value ?? 0,
  durationMs: (step.duration?.value ?? 0) * 1000,
  location: { lat: step.start_location.lat, lng: step.start_location.lng },
  geometry: step.polyline?.points ?? '',
});

const encodeFromSteps = (leg: GoogleLeg): string =>
  (leg.steps ?? []).map((s) => s.polyline?.points ?? '').join('');

const stripHtml = (html: string): string =>
  html
    .replace(/<div[^>]*>/g, '. ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

// -------------------------------------------------------- response shapes

interface GoogleLatLng {
  lat: number;
  lng: number;
}
interface GoogleValue {
  value: number;
  text?: string;
}
interface GooglePlace {
  place_id?: string;
  name?: string;
  formatted_address?: string;
  types?: string[];
  geometry?: { location: GoogleLatLng };
}
interface GooglePrediction {
  place_id: string;
  description: string;
  types?: string[];
  distance_meters?: number;
  structured_formatting?: { main_text: string; secondary_text?: string };
}
interface GooglePredictionsResponse {
  status: string;
  predictions?: GooglePrediction[];
  error_message?: string;
}
interface GoogleStep {
  html_instructions?: string;
  maneuver?: string;
  distance?: GoogleValue;
  duration?: GoogleValue;
  start_location: GoogleLatLng;
  polyline?: { points: string };
}
interface GoogleLeg {
  distance?: GoogleValue;
  duration?: GoogleValue;
  duration_in_traffic?: GoogleValue;
  start_location: GoogleLatLng;
  end_location: GoogleLatLng;
  steps?: GoogleStep[];
}
interface GoogleDirectionsResponse {
  status: string;
  error_message?: string;
  routes?: { legs?: GoogleLeg[]; overview_polyline?: { points: string } }[];
}
interface GoogleMatrixResponse {
  status: string;
  error_message?: string;
  rows?: {
    elements?: {
      // Per-element, so one unroutable pair does not fail the whole request.
      status?: string;
      distance?: GoogleValue;
      duration?: GoogleValue;
      duration_in_traffic?: GoogleValue;
    }[];
  }[];
}
