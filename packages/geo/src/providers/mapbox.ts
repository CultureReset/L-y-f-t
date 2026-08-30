/**
 * Mapbox adapter — Search Box / Geocoding v6 for places, Directions v5 for
 * routes, and Matrix v1 for driver ETAs. Vector tiles come back through
 * `tiles()` so the apps can render a real basemap when a token is configured.
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
import { UNREACHABLE } from '../types.js';
import { httpJson, type HttpClient } from '../http.js';

const GEOCODE = 'https://api.mapbox.com/geocoding/v5/mapbox.places';
const DIRECTIONS = 'https://api.mapbox.com/directions/v5/mapbox';
const MATRIX = 'https://api.mapbox.com/directions-matrix/v1/mapbox';

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

export interface MapboxGeoProviderOptions {
  readonly accessToken: string;
  readonly styleUrl?: string;
  readonly http?: HttpClient;
}

export class MapboxGeoProvider implements GeoProvider {
  readonly id = 'mapbox';
  readonly capabilities = CAPABILITIES;

  private readonly http: HttpClient;

  constructor(private readonly options: MapboxGeoProviderOptions) {
    if (!options.accessToken) throw new Error('MapboxGeoProvider requires an accessToken');
    this.http = options.http ?? httpJson;
  }

  async autocomplete(query: AutocompleteQuery): Promise<PlaceSuggestion[]> {
    const params = new URLSearchParams({
      access_token: this.options.accessToken,
      autocomplete: 'true',
      limit: String(query.limit ?? 6),
    });
    if (query.near) params.set('proximity', `${query.near.lng},${query.near.lat}`);
    const url = `${GEOCODE}/${encodeURIComponent(query.text)}.json?${params}`;
    const response = await this.http<MapboxGeocodeResponse>(url);
    return (response.features ?? []).map((f) => ({
      ref: f.id,
      primaryText: f.text ?? f.place_name,
      secondaryText: contextLine(f),
      category: categoryFor(f),
      coordinates: { lat: f.center[1]!, lng: f.center[0]! },
      providerId: this.id,
    }));
  }

  async details(ref: string): Promise<Place> {
    // Mapbox returns full features from search, so a details call re-queries by id.
    const params = new URLSearchParams({ access_token: this.options.accessToken });
    const response = await this.http<MapboxGeocodeResponse>(
      `${GEOCODE}/${encodeURIComponent(ref)}.json?${params}`,
    );
    const feature = response.features?.[0];
    if (!feature) throw new Error(`Mapbox returned no feature for "${ref}"`);
    return this.toPlace(feature, 'autocomplete');
  }

  async geocode(query: GeocodeQuery): Promise<Place[]> {
    const params = new URLSearchParams({
      access_token: this.options.accessToken,
      limit: String(query.limit ?? 5),
    });
    if (query.near) params.set('proximity', `${query.near.lng},${query.near.lat}`);
    const response = await this.http<MapboxGeocodeResponse>(
      `${GEOCODE}/${encodeURIComponent(query.address)}.json?${params}`,
    );
    return (response.features ?? []).map((f) => this.toPlace(f, 'geocoder'));
  }

  async reverseGeocode(coordinates: LatLng): Promise<Place> {
    const params = new URLSearchParams({
      access_token: this.options.accessToken,
      limit: '1',
    });
    const response = await this.http<MapboxGeocodeResponse>(
      `${GEOCODE}/${coordinates.lng},${coordinates.lat}.json?${params}`,
    );
    const feature = response.features?.[0];
    if (!feature) throw new Error('Mapbox returned no reverse-geocode result');
    return this.toPlace(feature, 'geocoder');
  }

  async route(request: RouteRequest): Promise<Route> {
    const profile = request.profile === 'driving' ? 'driving' : 'driving-traffic';
    const coords = request.waypoints.map((w) => `${w.lng},${w.lat}`).join(';');
    const params = new URLSearchParams({
      access_token: this.options.accessToken,
      geometries: 'polyline',
      overview: 'full',
      steps: String(request.steps !== false),
    });
    if (request.alternatives) params.set('alternatives', 'true');
    const exclude = [
      request.avoidTolls ? 'toll' : undefined,
      request.avoidHighways ? 'motorway' : undefined,
    ].filter(Boolean);
    if (exclude.length > 0) params.set('exclude', exclude.join(','));

    const response = await this.http<MapboxDirectionsResponse>(
      `${DIRECTIONS}/${profile}/${coords}?${params}`,
    );
    const route = response.routes?.[0];
    if (!route) throw new Error(`Mapbox returned no route (${response.code ?? 'unknown'})`);

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
      durationInTrafficMs: Math.round((route.duration_typical ?? route.duration ?? 0) * 1000),
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
    const sources = request.origins.map((_, i) => i).join(';');
    const destinations = request.destinations
      .map((_, i) => i + request.origins.length)
      .join(';');
    const params = new URLSearchParams({
      access_token: this.options.accessToken,
      sources,
      destinations,
      annotations: 'duration,distance',
    });
    const response = await this.http<MapboxMatrixResponse>(
      `${MATRIX}/driving-traffic/${coords}?${params}`,
    );
    return (response.durations ?? []).map((row, i) =>
      row.map((duration, j) => {
        // A null duration means no route exists between that pair.
        if (duration === null || duration === undefined) return UNREACHABLE;
        const distance = response.distances?.[i]?.[j];
        return {
          durationMs: Math.round(duration * 1000),
          distanceMeters:
            distance === null || distance === undefined
              ? Number.POSITIVE_INFINITY
              : Math.round(distance),
        };
      }),
    );
  }

  tiles(): TileConfig {
    return {
      kind: 'vector',
      styleUrl: this.options.styleUrl ?? 'mapbox://styles/mapbox/navigation-day-v1',
      attribution: '© Mapbox © OpenStreetMap',
      maxZoom: 22,
      apiKeyParam: 'access_token',
      // A `pk.` token is a public token by design; restrict it by URL in the
      // Mapbox dashboard rather than trying to keep it off the device.
      apiKey: this.options.accessToken,
    };
  }

  private toPlace(feature: MapboxFeature, source: Place['source']): Place {
    return {
      id: newPlaceId(),
      name: feature.text ?? feature.place_name,
      address: feature.place_name,
      subtitle: contextLine(feature),
      coordinates: { lat: feature.center[1]!, lng: feature.center[0]! },
      category: categoryFor(feature),
      source,
      providerId: this.id,
      externalRef: feature.id,
    };
  }
}

const contextLine = (feature: MapboxFeature): string =>
  feature.place_name.split(',').slice(1).join(',').trim();

const CATEGORY_BY_MAPBOX_TYPE: Record<string, PlaceCategory> = {
  address: 'address',
  poi: 'venue',
  place: 'venue',
  neighborhood: 'other',
  postcode: 'other',
};

const categoryFor = (feature: MapboxFeature): PlaceCategory => {
  const categories = feature.properties?.category ?? '';
  if (categories.includes('airport')) return 'airport';
  if (categories.includes('hotel')) return 'hotel';
  if (categories.includes('restaurant') || categories.includes('food')) return 'restaurant';
  if (categories.includes('hospital')) return 'hospital';
  if (categories.includes('transit') || categories.includes('rail')) return 'transit';
  if (categories.includes('shop') || categories.includes('mall')) return 'shopping';
  for (const type of feature.place_type ?? []) {
    const mapped = CATEGORY_BY_MAPBOX_TYPE[type];
    if (mapped) return mapped;
  }
  return 'address';
};

const MANEUVER_MAP: Record<string, RouteManeuver> = {
  depart: 'depart',
  arrive: 'arrive',
  turn: 'continue',
  merge: 'merge',
  fork: 'fork',
  roundabout: 'roundabout',
  rotary: 'roundabout',
  continue: 'continue',
};

const toStep = (step: MapboxStep): RouteStep => {
  const maneuver = step.maneuver;
  let mapped: RouteManeuver = MANEUVER_MAP[maneuver?.type ?? ''] ?? 'continue';
  if (maneuver?.type === 'turn' || maneuver?.type === 'continue') {
    mapped = modifierToManeuver(maneuver.modifier) ?? mapped;
  }
  return {
    instruction: maneuver?.instruction ?? step.name ?? '',
    maneuver: mapped,
    distanceMeters: Math.round(step.distance ?? 0),
    durationMs: Math.round((step.duration ?? 0) * 1000),
    location: {
      lat: maneuver?.location?.[1] ?? 0,
      lng: maneuver?.location?.[0] ?? 0,
    },
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

interface MapboxFeature {
  id: string;
  text?: string;
  place_name: string;
  place_type?: string[];
  center: [number, number];
  properties?: { category?: string };
}
interface MapboxGeocodeResponse {
  features?: MapboxFeature[];
}
interface MapboxStep {
  name?: string;
  distance?: number;
  duration?: number;
  geometry?: string;
  maneuver?: { type?: string; modifier?: string; instruction?: string; location?: [number, number] };
}
interface MapboxDirectionsResponse {
  code?: string;
  routes?: {
    distance?: number;
    duration?: number;
    duration_typical?: number;
    geometry?: string;
    legs?: { distance?: number; duration?: number; steps?: MapboxStep[] }[];
  }[];
}
interface MapboxMatrixResponse {
  durations?: number[][];
  distances?: number[][];
}
