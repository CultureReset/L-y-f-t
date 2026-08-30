/**
 * The mock geo provider.
 *
 * A complete, deterministic implementation of every capability with no API key,
 * no network, and no cost. It is the default so the whole platform runs the
 * moment you clone it — and because a routing provider you can freeze in a test
 * is worth more than a real one you cannot.
 *
 * Routing is grid-based rather than straight-line: paths follow a synthetic
 * street lattice, which produces the L-shaped city geometry a real router
 * returns and lets the driver app render believable turn-by-turn steps.
 */

import {
  bearingDegrees,
  boundsOf,
  destination,
  encodePolyline,
  fromDecimal,
  haversineMeters,
  newPlaceId,
  seededRandom,
  type LatLng,
  type Place,
  type PlaceCategory,
} from '@lift/core';
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
import {
  NEIGHBORHOODS,
  SEED_PLACES,
  STREET_NAMES,
  ZIP_ANCHORS,
  type SeedPlace,
} from './mockData.js';

export interface MockGeoProviderOptions {
  /** Free-flow speed in km/h before traffic is applied. */
  readonly averageSpeedKph?: number;
  /** Seeds the synthetic address generator so runs are reproducible. */
  readonly seed?: number;
  /** Street lattice spacing in degrees; ~110 m at 0.001. */
  readonly gridDegrees?: number;
  /** Apply a time-of-day traffic multiplier to durations. */
  readonly simulateTraffic?: boolean;
  /** Artificial latency, to exercise loading states in the apps. */
  readonly latencyMs?: number;
  readonly places?: readonly SeedPlace[];
}

const CAPABILITIES: GeoCapabilities = {
  autocomplete: true,
  geocode: true,
  reverseGeocode: true,
  routing: true,
  matrix: true,
  turnByTurn: true,
  tiles: false,
  tolls: false,
};

export class MockGeoProvider implements GeoProvider {
  readonly id = 'mock';
  readonly capabilities = CAPABILITIES;

  private readonly speedMps: number;
  private readonly gridDegrees: number;
  private readonly simulateTraffic: boolean;
  private readonly latencyMs: number;
  private readonly places: readonly SeedPlace[];
  private readonly seed: number;

  constructor(private readonly options: MockGeoProviderOptions = {}) {
    this.speedMps = ((options.averageSpeedKph ?? 32) * 1000) / 3600;
    this.gridDegrees = options.gridDegrees ?? 0.0016;
    this.simulateTraffic = options.simulateTraffic ?? true;
    this.latencyMs = options.latencyMs ?? 0;
    this.places = options.places ?? SEED_PLACES;
    this.seed = options.seed ?? 42;
  }

  async autocomplete(query: AutocompleteQuery): Promise<PlaceSuggestion[]> {
    await this.delay();
    const text = query.text.trim().toLowerCase();
    if (text.length === 0) return [];
    const limit = query.limit ?? 6;

    const scored = this.places
      .map((place) => ({ place, score: matchScore(place, text) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        if (!query.near) return a.place.name.localeCompare(b.place.name);
        return (
          haversineMeters(query.near, a.place.coordinates) -
          haversineMeters(query.near, b.place.coordinates)
        );
      });

    const suggestions: PlaceSuggestion[] = scored.slice(0, limit).map(({ place }) => ({
      ref: `seed:${place.name}`,
      primaryText: place.name,
      secondaryText: place.address,
      category: place.category,
      coordinates: place.coordinates,
      distanceMeters: query.near
        ? Math.round(haversineMeters(query.near, place.coordinates))
        : undefined,
      providerId: this.id,
    }));

    // Anything that looks like a street address gets a synthesised result, so
    // typing "500 Valencia" finds something even though it is not a landmark.
    if (suggestions.length < limit) {
      suggestions.push(
        ...this.synthesizeAddressSuggestions(query, limit - suggestions.length),
      );
    }
    return suggestions;
  }

  async details(ref: string): Promise<Place> {
    await this.delay();
    if (ref.startsWith('seed:')) {
      const name = ref.slice('seed:'.length);
      const seed = this.places.find((p) => p.name === name);
      if (seed) return this.toPlace(seed, 'autocomplete');
    }
    if (ref.startsWith('addr:')) {
      const [, lat, lng, ...rest] = ref.split(':');
      const coordinates = { lat: Number(lat), lng: Number(lng) };
      return this.synthesizePlace(coordinates, rest.join(':') || undefined, 'autocomplete');
    }
    throw new Error(`Unknown place ref "${ref}"`);
  }

  async geocode(query: GeocodeQuery): Promise<Place[]> {
    await this.delay();
    const text = query.address.trim().toLowerCase();
    const matches = this.places
      .filter((p) => matchScore(p, text) > 0)
      .slice(0, query.limit ?? 5)
      .map((p) => this.toPlace(p, 'geocoder'));
    if (matches.length > 0) return matches;
    // Fall back to a deterministic synthetic location near the bias point.
    const anchor = query.near ?? NEIGHBORHOODS[0]!.center;
    return [this.synthesizePlace(this.jitterFrom(anchor, text), query.address, 'geocoder')];
  }

  async reverseGeocode(coordinates: LatLng): Promise<Place> {
    await this.delay();
    // A landmark within 120 m wins over a synthesised street address.
    const nearest = this.places
      .map((p) => ({ p, d: haversineMeters(coordinates, p.coordinates) }))
      .sort((a, b) => a.d - b.d)[0];
    if (nearest && nearest.d < 120) return this.toPlace(nearest.p, 'geocoder');
    return this.synthesizePlace(coordinates, undefined, 'geocoder');
  }

  async route(request: RouteRequest): Promise<Route> {
    await this.delay();
    const waypoints = request.waypoints;
    if (waypoints.length < 2) {
      throw new Error('route() requires at least an origin and a destination');
    }

    const legs: RouteLeg[] = [];
    for (let i = 1; i < waypoints.length; i++) {
      legs.push(this.buildLeg(waypoints[i - 1]!, waypoints[i]!, request));
    }

    const allPoints = legs.flatMap((leg) => decode(leg.geometry));
    const distanceMeters = legs.reduce((sum, l) => sum + l.distanceMeters, 0);
    const durationMs = legs.reduce((sum, l) => sum + l.durationMs, 0);
    const trafficFactor = this.trafficFactor(request.departAt);

    return {
      distanceMeters: Math.round(distanceMeters),
      durationMs: Math.round(durationMs),
      durationInTrafficMs: Math.round(durationMs * trafficFactor),
      geometry: encodePolyline(allPoints),
      legs,
      bounds: boundsOf(allPoints, 0.12),
      providerId: this.id,
      confidence: 0.85,
      // A nominal bridge toll on trips that cross the bay.
      ...(this.crossesBay(waypoints) ? { tolls: fromDecimal(8) } : {}),
    };
  }

  async matrix(request: MatrixRequest): Promise<TravelEstimate[][]> {
    await this.delay();
    const factor = this.trafficFactor(request.departAt);
    return request.origins.map((origin) =>
      request.destinations.map((dest) => {
        const distanceMeters = this.gridDistance(origin, dest);
        return {
          distanceMeters: Math.round(distanceMeters),
          durationMs: Math.round((distanceMeters / this.speedMps) * 1000 * factor),
        };
      }),
    );
  }

  tiles(): TileConfig {
    // The apps fall back to their built-in vector canvas renderer.
    return { kind: 'none', attribution: 'Simulated map', maxZoom: 20 };
  }

  // ---------------------------------------------------------------- routing

  /**
   * Build one leg by walking a street lattice: alternate east–west and
   * north–south runs, which is what makes the geometry look like driving
   * through a city rather than flying over it.
   */
  private buildLeg(from: LatLng, to: LatLng, request: RouteRequest): RouteLeg {
    const path = this.gridPath(from, to);
    const distanceMeters = pathLength(path);
    const factor = this.trafficFactor(request.departAt);
    const durationMs = (distanceMeters / this.speedMps) * 1000 * factor;
    return {
      from,
      to,
      distanceMeters: Math.round(distanceMeters),
      durationMs: Math.round(durationMs),
      geometry: encodePolyline(path),
      steps: request.steps === false ? [] : this.buildSteps(path, factor),
    };
  }

  /** Snap a coordinate to the nearest lattice intersection. */
  private snap(point: LatLng): LatLng {
    return {
      lat: Math.round(point.lat / this.gridDegrees) * this.gridDegrees,
      lng: Math.round(point.lng / this.gridDegrees) * this.gridDegrees,
    };
  }

  /**
   * A staircase path along the lattice. Real streets are not a perfect grid, so
   * the number of turns is derived from the trip's shape: short hops get one
   * turn, longer trips get several, which reads as "took a few streets".
   */
  private gridPath(from: LatLng, to: LatLng): LatLng[] {
    const start = this.snap(from);
    const end = this.snap(to);
    const dLat = end.lat - start.lat;
    const dLng = end.lng - start.lng;

    const straightLine = haversineMeters(from, to);
    const turns = Math.max(1, Math.min(6, Math.round(straightLine / 900)));

    const path: LatLng[] = [from];
    // Alternate lng-then-lat runs, splitting the delta across the turn count.
    let cursor = start;
    path.push(cursor);
    for (let i = 0; i < turns; i++) {
      const share = (i + 1) / turns;
      const lngLeg = { lat: cursor.lat, lng: start.lng + dLng * share };
      if (Math.abs(lngLeg.lng - cursor.lng) > 1e-9) path.push(lngLeg);
      const latLeg = { lat: start.lat + dLat * share, lng: lngLeg.lng };
      if (Math.abs(latLeg.lat - lngLeg.lat) > 1e-9) path.push(latLeg);
      cursor = latLeg;
    }
    path.push(to);
    return dedupe(path);
  }

  /** Straight-line distance inflated by the grid's detour factor. */
  private gridDistance(from: LatLng, to: LatLng): number {
    // A Manhattan lattice is ~1.27× the crow-flies distance on average.
    return haversineMeters(from, to) * 1.27;
  }

  /** Turn-by-turn steps derived from the lattice's corners. */
  private buildSteps(path: readonly LatLng[], trafficFactor: number): RouteStep[] {
    if (path.length < 2) return [];
    const steps: RouteStep[] = [];
    const random = seededRandom(this.seed);

    for (let i = 0; i < path.length - 1; i++) {
      const from = path[i]!;
      const to = path[i + 1]!;
      const segmentMeters = haversineMeters(from, to);
      if (segmentMeters < 5 && i !== 0 && i !== path.length - 2) continue;

      const heading = bearingDegrees(from, to);
      const previousHeading = i === 0 ? heading : bearingDegrees(path[i - 1]!, from);
      const maneuver: RouteManeuver =
        i === 0 ? 'depart' : maneuverFor(previousHeading, heading);
      const streetName = STREET_NAMES[random.int(0, STREET_NAMES.length)]!;

      steps.push({
        instruction: instructionFor(maneuver, streetName, segmentMeters),
        maneuver,
        distanceMeters: Math.round(segmentMeters),
        durationMs: Math.round((segmentMeters / this.speedMps) * 1000 * trafficFactor),
        location: from,
        streetName,
        geometry: encodePolyline([from, to]),
      });
    }

    const last = path[path.length - 1]!;
    steps.push({
      instruction: 'Arrive at your destination',
      maneuver: 'arrive',
      distanceMeters: 0,
      durationMs: 0,
      location: last,
      geometry: encodePolyline([last]),
    });
    return steps;
  }

  /**
   * Traffic multiplier by hour of day: the morning and evening peaks slow
   * things down, the small hours speed them up.
   */
  private trafficFactor(departAt?: number): number {
    if (!this.simulateTraffic) return 1;
    const hour = new Date(departAt ?? Date.now()).getHours();
    if (hour >= 7 && hour < 10) return 1.45;
    if (hour >= 16 && hour < 19) return 1.55;
    if (hour >= 11 && hour < 14) return 1.15;
    if (hour >= 0 && hour < 5) return 0.8;
    return 1;
  }

  private crossesBay(waypoints: readonly LatLng[]): boolean {
    // Anything east of this meridian is across the bay from San Francisco.
    const BAY_MERIDIAN = -122.32;
    const sides = waypoints.map((w) => w.lng > BAY_MERIDIAN);
    return sides.some(Boolean) && sides.some((s) => !s);
  }

  // --------------------------------------------------------------- geocoding

  private toPlace(seed: SeedPlace, source: Place['source']): Place {
    return {
      id: newPlaceId(),
      name: seed.name,
      address: seed.address,
      coordinates: seed.coordinates,
      category: seed.category,
      source,
      providerId: this.id,
      externalRef: `seed:${seed.name}`,
      ...(seed.pickupHint
        ? {
            pickupHint: {
              coordinates: seed.pickupHint.coordinates,
              label: seed.pickupHint.label,
            },
          }
        : {}),
    };
  }

  /** Build a plausible street address for an arbitrary coordinate. */
  private synthesizePlace(
    coordinates: LatLng,
    label: string | undefined,
    source: Place['source'],
  ): Place {
    const random = seededRandom(coordinateSeed(coordinates, this.seed));
    const street = STREET_NAMES[random.int(0, STREET_NAMES.length)]!;
    const number = random.int(1, 40) * 25 + random.int(0, 25);
    const neighborhood = nearest(NEIGHBORHOODS, coordinates, (n) => n.center).name;
    const zip = nearest(ZIP_ANCHORS, coordinates, (z) => z.center).zip;
    const streetAddress = `${number} ${street}`;
    return {
      id: newPlaceId(),
      name: label ?? streetAddress,
      address: `${streetAddress}, San Francisco, CA ${zip}`,
      subtitle: neighborhood,
      coordinates,
      category: 'address' as PlaceCategory,
      source,
      providerId: this.id,
      externalRef: `addr:${coordinates.lat.toFixed(6)}:${coordinates.lng.toFixed(6)}`,
      metadata: { neighborhood, zip },
    };
  }

  private synthesizeAddressSuggestions(
    query: AutocompleteQuery,
    count: number,
  ): PlaceSuggestion[] {
    const anchor = query.near ?? NEIGHBORHOODS[0]!.center;
    const text = query.text.trim();
    const out: PlaceSuggestion[] = [];
    for (let i = 0; i < count; i++) {
      const coordinates = this.jitterFrom(anchor, `${text}#${i}`);
      const random = seededRandom(coordinateSeed(coordinates, this.seed));
      const street = STREET_NAMES[random.int(0, STREET_NAMES.length)]!;
      const number = random.int(1, 40) * 25;
      const zip = nearest(ZIP_ANCHORS, coordinates, (z) => z.center).zip;
      // Keep whatever the rider typed as the leading text so results feel live.
      const primary = /^\d/.test(text) ? `${text} ${street}` : `${number} ${street}`;
      out.push({
        ref: `addr:${coordinates.lat.toFixed(6)}:${coordinates.lng.toFixed(6)}:${primary}`,
        primaryText: primary,
        secondaryText: `San Francisco, CA ${zip}`,
        category: 'address',
        coordinates,
        distanceMeters: Math.round(haversineMeters(anchor, coordinates)),
        providerId: this.id,
      });
    }
    return out;
  }

  /** Deterministic offset from an anchor, keyed by an arbitrary string. */
  private jitterFrom(anchor: LatLng, key: string): LatLng {
    const random = seededRandom(hashString(key) ^ this.seed);
    return destination(anchor, random.float(0, 360), random.float(200, 3_500));
  }

  private async delay(): Promise<void> {
    if (this.latencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.latencyMs));
    }
  }
}

// ------------------------------------------------------------------ helpers

const matchScore = (place: SeedPlace, text: string): number => {
  const name = place.name.toLowerCase();
  const address = place.address.toLowerCase();
  if (name.startsWith(text)) return 100;
  if (place.aliases?.some((a) => a.toLowerCase().startsWith(text))) return 90;
  if (name.includes(text)) return 70;
  if (place.aliases?.some((a) => a.toLowerCase().includes(text))) return 60;
  if (address.toLowerCase().includes(text)) return 40;
  return 0;
};

const maneuverFor = (from: number, to: number): RouteManeuver => {
  let delta = ((to - from + 540) % 360) - 180;
  const magnitude = Math.abs(delta);
  if (magnitude < 12) return 'continue';
  if (magnitude > 160) return 'u_turn';
  if (delta > 0) {
    if (magnitude < 40) return 'turn_slight_right';
    return magnitude > 120 ? 'turn_sharp_right' : 'turn_right';
  }
  if (magnitude < 40) return 'turn_slight_left';
  return magnitude > 120 ? 'turn_sharp_left' : 'turn_left';
};

const instructionFor = (
  maneuver: RouteManeuver,
  street: string,
  meters: number,
): string => {
  const distance =
    meters >= 1609
      ? `${(meters / 1609.344).toFixed(1)} mi`
      : `${Math.round(meters / 10) * 10} ft`;
  switch (maneuver) {
    case 'depart':
      return `Head onto ${street} and continue for ${distance}`;
    case 'continue':
      return `Continue on ${street} for ${distance}`;
    case 'arrive':
      return 'Arrive at your destination';
    case 'u_turn':
      return `Make a U-turn onto ${street}`;
    default: {
      const direction = maneuver
        .replace('turn_', '')
        .replace('slight_', 'slight ')
        .replace('sharp_', 'sharp ');
      return `Turn ${direction} onto ${street}`;
    }
  }
};

const pathLength = (path: readonly LatLng[]): number => {
  let total = 0;
  for (let i = 1; i < path.length; i++) total += haversineMeters(path[i - 1]!, path[i]!);
  return total;
};

const dedupe = (path: readonly LatLng[]): LatLng[] => {
  const out: LatLng[] = [];
  for (const point of path) {
    const last = out[out.length - 1];
    if (!last || haversineMeters(last, point) > 1) out.push(point);
  }
  return out.length >= 2 ? out : [...path];
};

const nearest = <T>(items: readonly T[], to: LatLng, coords: (item: T) => LatLng): T => {
  const first = items[0];
  if (first === undefined) throw new Error('nearest() requires a non-empty list');
  let best: T = first;
  let bestDistance = Infinity;
  for (const item of items) {
    const d = haversineMeters(to, coords(item));
    if (d < bestDistance) {
      bestDistance = d;
      best = item;
    }
  }
  return best;
};

const hashString = (s: string): number => {
  let hash = 2166136261;
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
};

const coordinateSeed = (p: LatLng, salt: number): number =>
  hashString(`${p.lat.toFixed(5)},${p.lng.toFixed(5)}`) ^ salt;

/** Local decode so this module does not depend on import order. */
const decode = (encoded: string): LatLng[] => {
  const factor = 1e5;
  const path: LatLng[] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  while (index < encoded.length) {
    let result = 0;
    let shift = 0;
    let byte: number;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;
    result = 0;
    shift = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lng += result & 1 ? ~(result >> 1) : result >> 1;
    path.push({ lat: lat / factor, lng: lng / factor });
  }
  return path;
};
