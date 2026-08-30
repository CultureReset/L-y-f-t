/**
 * The vendor geo adapters.
 *
 * Each takes an injectable HTTP client, so both directions are testable
 * without an account: the request it builds, and the response it maps. That
 * mapping is where an adapter is wrong in ways nothing else catches — a
 * latitude and longitude the wrong way round is a valid coordinate somewhere
 * in the ocean, and no type checks it.
 */

import { describe, expect, it, vi } from 'vitest';
import { encodePolyline } from '@lift/core';
import type { HttpClient } from '../http.js';
import { UNREACHABLE } from '../types.js';
import { GoogleGeoProvider } from './google.js';
import { MapboxGeoProvider } from './mapbox.js';
import { OsrmGeoProvider } from './osrm.js';

/** An HTTP client that returns canned bodies and records the URLs it saw. */
const fakeHttp = (bodies: unknown | unknown[]) => {
  const queue = Array.isArray(bodies) ? [...bodies] : [bodies];
  const urls: string[] = [];
  const inits: (RequestInit | undefined)[] = [];

  const client = vi.fn(async (url: string, init?: RequestInit) => {
    urls.push(url);
    inits.push(init);
    return queue.length > 1 ? queue.shift() : queue[0];
  }) as unknown as HttpClient;

  return Object.assign(client, { urls, inits });
};

/** A short route down Market Street, as a real polyline. */
const GEOMETRY = encodePolyline([
  { lat: 37.7955, lng: -122.3937 },
  { lat: 37.7912, lng: -122.3995 },
  { lat: 37.7873, lng: -122.4048 },
]);

describe('Google', () => {
  it('refuses to be built without a key', () => {
    expect(() => new GoogleGeoProvider({ apiKey: '' })).toThrow(/apiKey/);
  });

  it('sends the key and the bias, and maps predictions to suggestions', async () => {
    const http = fakeHttp({
      status: 'OK',
      predictions: [
        {
          place_id: 'ChIJ_ferry',
          description: 'Ferry Building, San Francisco',
          structured_formatting: {
            main_text: 'Ferry Building',
            secondary_text: '1 Ferry Building, San Francisco',
          },
          types: ['transit_station'],
          distance_meters: 420,
        },
      ],
    });
    const provider = new GoogleGeoProvider({ apiKey: 'k', http });

    const suggestions = await provider.autocomplete({
      text: 'ferry',
      near: { lat: 37.79, lng: -122.4 },
      limit: 5,
    });

    const url = http.urls[0]!;
    expect(url).toContain('/place/autocomplete/json');
    expect(url).toContain('key=k');
    // Google takes lat,lng in that order.
    expect(url).toContain('location=37.79%2C-122.4');
    expect(suggestions).toEqual([
      {
        ref: 'ChIJ_ferry',
        primaryText: 'Ferry Building',
        secondaryText: '1 Ferry Building, San Francisco',
        category: 'transit',
        distanceMeters: 420,
        providerId: 'google',
      },
    ]);
  });

  it('turns a Google error status into a readable failure', async () => {
    const http = fakeHttp({
      status: 'REQUEST_DENIED',
      error_message: 'The provided API key is invalid.',
    });
    const provider = new GoogleGeoProvider({ apiKey: 'k', http });

    await expect(provider.autocomplete({ text: 'x' })).rejects.toThrow(
      /REQUEST_DENIED.*API key is invalid/,
    );
  });

  it('treats no results as an empty list, not an error', async () => {
    const http = fakeHttp({ status: 'ZERO_RESULTS', predictions: [] });
    const provider = new GoogleGeoProvider({ apiKey: 'k', http });

    expect(await provider.autocomplete({ text: 'nowhere' })).toEqual([]);
  });

  it('prefers the traffic-aware duration and sums the legs', async () => {
    const http = fakeHttp({
      status: 'OK',
      routes: [
        {
          overview_polyline: { points: GEOMETRY },
          legs: [
            {
              start_location: { lat: 37.7955, lng: -122.3937 },
              end_location: { lat: 37.7873, lng: -122.4048 },
              distance: { value: 1400 },
              duration: { value: 300 },
              duration_in_traffic: { value: 480 },
              steps: [
                {
                  html_instructions: 'Head <b>southwest</b> on Market St',
                  maneuver: 'turn-right',
                  distance: { value: 700 },
                  duration: { value: 240 },
                  start_location: { lat: 37.7955, lng: -122.3937 },
                  polyline: { points: GEOMETRY },
                },
              ],
            },
          ],
        },
      ],
    });
    const provider = new GoogleGeoProvider({ apiKey: 'k', http });

    const route = await provider.route({
      waypoints: [
        { lat: 37.7955, lng: -122.3937 },
        { lat: 37.7873, lng: -122.4048 },
      ],
      steps: true,
    });

    expect(route.distanceMeters).toBe(1400);
    // Traffic wins over the free-flow estimate when Google supplies it.
    expect(route.durationMs).toBe(480_000);
    expect(route.durationInTrafficMs).toBe(480_000);
    expect(route.providerId).toBe('google');
    expect(route.geometry).toBe(GEOMETRY);
    // HTML markup in the instruction is not something a driver should read.
    expect(route.legs[0]!.steps[0]!.instruction).toBe('Head southwest on Market St');
    expect(route.legs[0]!.steps[0]!.maneuver).toBe('turn_right');
    // The bounds must actually contain the route.
    expect(route.bounds.north).toBeGreaterThan(37.7955);
    expect(route.bounds.south).toBeLessThan(37.7873);
  });

  it('routes through intermediate waypoints rather than dropping them', async () => {
    const http = fakeHttp({ status: 'OK', routes: [{ legs: [] }] });
    const provider = new GoogleGeoProvider({ apiKey: 'k', http });

    await provider.route({
      waypoints: [
        { lat: 1, lng: 2 },
        { lat: 3, lng: 4 },
        { lat: 5, lng: 6 },
      ],
    });

    const url = http.urls[0]!;
    expect(url).toContain('origin=1%2C2');
    expect(url).toContain('destination=5%2C6');
    expect(url).toContain('waypoints=3%2C4');
  });

  it('maps the distance matrix into rows of origins', async () => {
    const http = fakeHttp({
      status: 'OK',
      rows: [
        {
          elements: [
            { status: 'OK', distance: { value: 1000 }, duration: { value: 120 } },
            { status: 'ZERO_RESULTS' },
          ],
        },
      ],
    });
    const provider = new GoogleGeoProvider({ apiKey: 'k', http });

    const matrix = await provider.matrix!({
      origins: [{ lat: 1, lng: 2 }],
      destinations: [
        { lat: 3, lng: 4 },
        { lat: 5, lng: 6 },
      ],
    });

    expect(matrix).toHaveLength(1);
    expect(matrix[0]![0]).toEqual({ distanceMeters: 1000, durationMs: 120_000 });
    // An unreachable pair must not read as "instantly there" — dispatch ranks
    // drivers on this number, so a zero would put the unreachable one first.
    expect(matrix[0]![1]).toEqual(UNREACHABLE);
  });
});

describe('Mapbox', () => {
  const feature = {
    id: 'poi.123',
    text: 'Ferry Building',
    place_name: 'Ferry Building, San Francisco, California',
    // Mapbox is lng,lat — the single most common way to get this wrong.
    center: [-122.3937, 37.7955],
    place_type: ['poi'],
    context: [{ id: 'place.1', text: 'San Francisco' }],
  };

  it('refuses to be built without a token', () => {
    expect(() => new MapboxGeoProvider({ accessToken: '' })).toThrow(/accessToken/);
  });

  it('reads Mapbox’s lng,lat order the right way round', async () => {
    const http = fakeHttp({ features: [feature] });
    const provider = new MapboxGeoProvider({ accessToken: 't', http });

    const [suggestion] = await provider.autocomplete({
      text: 'ferry',
      near: { lat: 37.79, lng: -122.4 },
    });

    expect(suggestion!.coordinates).toEqual({ lat: 37.7955, lng: -122.3937 });
    // The proximity bias goes out in Mapbox's own order.
    expect(http.urls[0]).toContain('proximity=-122.4%2C37.79');
  });

  it('asks for a polyline it can decode, with steps', async () => {
    const http = fakeHttp({
      routes: [
        {
          distance: 1400,
          duration: 300,
          geometry: GEOMETRY,
          legs: [
            {
              distance: 1400,
              duration: 300,
              steps: [
                {
                  maneuver: {
                    instruction: 'Turn left onto Market St',
                    type: 'turn',
                    modifier: 'left',
                    location: [-122.3937, 37.7955],
                  },
                  distance: 700,
                  duration: 150,
                  name: 'Market St',
                  geometry: GEOMETRY,
                },
              ],
            },
          ],
        },
      ],
    });
    const provider = new MapboxGeoProvider({ accessToken: 't', http });

    const route = await provider.route({
      waypoints: [
        { lat: 37.7955, lng: -122.3937 },
        { lat: 37.7873, lng: -122.4048 },
      ],
    });

    expect(http.urls[0]).toContain('geometries=polyline');
    expect(http.urls[0]).toContain('steps=true');
    // Coordinates in the path are lng,lat too.
    expect(http.urls[0]).toContain('-122.3937,37.7955');
    expect(route.distanceMeters).toBe(1400);
    expect(route.durationMs).toBe(300_000);
    expect(route.legs[0]!.steps[0]!.maneuver).toBe('turn_left');
    expect(route.legs[0]!.steps[0]!.location).toEqual({ lat: 37.7955, lng: -122.3937 });
  });

  it('says so when there is no route rather than returning an empty one', async () => {
    const http = fakeHttp({ routes: [] });
    const provider = new MapboxGeoProvider({ accessToken: 't', http });

    await expect(
      provider.route({
        waypoints: [
          { lat: 1, lng: 2 },
          { lat: 3, lng: 4 },
        ],
      }),
    ).rejects.toThrow(/route/i);
  });

  it('offers a tile config the apps can actually render', async () => {
    const provider = new MapboxGeoProvider({ accessToken: 'pk.abc' });
    const tiles = provider.tiles!();

    expect(tiles.kind).not.toBe('none');
    expect(JSON.stringify(tiles)).toContain('pk.abc');
    expect(tiles.attribution).toMatch(/mapbox/i);
  });
});

describe('OSRM and Nominatim', () => {
  const nominatim = {
    place_id: 1,
    osm_type: 'node',
    osm_id: 42,
    // Nominatim returns coordinates as strings.
    lat: '37.7955',
    lon: '-122.3937',
    name: 'Ferry Building',
    display_name: 'Ferry Building, Embarcadero, San Francisco, California',
    type: 'attraction',
    address: { road: 'The Embarcadero', city: 'San Francisco', postcode: '94111' },
  };

  it('needs no key at all — the default deployment', () => {
    expect(() => new OsrmGeoProvider()).not.toThrow();
  });

  it('parses Nominatim’s string coordinates into numbers', async () => {
    const http = fakeHttp([[nominatim]]);
    const provider = new OsrmGeoProvider({ http });

    const [suggestion] = await provider.autocomplete({ text: 'ferry' });

    expect(suggestion!.coordinates).toEqual({ lat: 37.7955, lng: -122.3937 });
    expect(typeof suggestion!.coordinates!.lat).toBe('number');
    expect(suggestion!.ref).toBe('node:42');
  });

  it('identifies itself to Nominatim, which requires it', async () => {
    const http = fakeHttp([[nominatim]]);
    const provider = new OsrmGeoProvider({ http, userAgent: 'lift-test/1.0' });

    await provider.autocomplete({ text: 'ferry' });

    const headers = http.inits[0]?.headers as Record<string, string> | undefined;
    expect(headers?.['User-Agent'] ?? headers?.['user-agent']).toBe('lift-test/1.0');
  });

  it('maps an OSRM route, including its steps', async () => {
    const http = fakeHttp({
      code: 'Ok',
      routes: [
        {
          distance: 1400,
          duration: 300,
          geometry: GEOMETRY,
          legs: [
            {
              distance: 1400,
              duration: 300,
              steps: [
                {
                  maneuver: { type: 'turn', modifier: 'right', location: [-122.3937, 37.7955] },
                  distance: 700,
                  duration: 150,
                  name: 'Market St',
                  geometry: GEOMETRY,
                },
              ],
            },
          ],
        },
      ],
    });
    const provider = new OsrmGeoProvider({ http });

    const route = await provider.route({
      waypoints: [
        { lat: 37.7955, lng: -122.3937 },
        { lat: 37.7873, lng: -122.4048 },
      ],
    });

    expect(route.distanceMeters).toBe(1400);
    expect(route.durationMs).toBe(300_000);
    expect(route.providerId).toBe('osrm');
    expect(route.legs[0]!.steps[0]!.maneuver).toBe('turn_right');
  });

  it('reports an OSRM failure code rather than returning nothing', async () => {
    const http = fakeHttp({ code: 'NoRoute', message: 'Impossible route' });
    const provider = new OsrmGeoProvider({ http });

    await expect(
      provider.route({
        waypoints: [
          { lat: 1, lng: 2 },
          { lat: 3, lng: 4 },
        ],
      }),
    ).rejects.toThrow(/NoRoute|Impossible/);
  });
});

describe('an unreachable pair', () => {
  /**
   * Every vendor has its own way of saying "no route between these two", and
   * every one of them used to become zero. Dispatch ranks candidates on
   * duration, so a zero is not a missing value — it is the best possible
   * value, handed to the one driver who cannot get there.
   */
  it('is Infinity from Mapbox, which returns a null in the row', async () => {
    const http = fakeHttp({
      durations: [[120, null]],
      distances: [[1000, null]],
    });
    const provider = new MapboxGeoProvider({ accessToken: 't', http });

    const matrix = await provider.matrix!({
      origins: [{ lat: 1, lng: 2 }],
      destinations: [
        { lat: 3, lng: 4 },
        { lat: 5, lng: 6 },
      ],
    });

    expect(matrix[0]![0]).toEqual({ durationMs: 120_000, distanceMeters: 1000 });
    expect(matrix[0]![1]).toEqual(UNREACHABLE);
  });

  it('is Infinity from OSRM, which does the same', async () => {
    const http = fakeHttp({ durations: [[null, 90]], distances: [[null, 800]] });
    const provider = new OsrmGeoProvider({ http });

    const matrix = await provider.matrix!({
      origins: [{ lat: 1, lng: 2 }],
      destinations: [
        { lat: 3, lng: 4 },
        { lat: 5, lng: 6 },
      ],
    });

    expect(matrix[0]![0]).toEqual(UNREACHABLE);
    expect(matrix[0]![1]).toEqual({ durationMs: 90_000, distanceMeters: 800 });
  });

  it('never sorts ahead of a reachable one', async () => {
    const http = fakeHttp({ durations: [[null], [600]], distances: [[null], [4000]] });
    const provider = new OsrmGeoProvider({ http });

    const matrix = await provider.matrix!({
      origins: [
        { lat: 1, lng: 2 },
        { lat: 3, lng: 4 },
      ],
      destinations: [{ lat: 5, lng: 6 }],
    });

    const soonest = matrix
      .map((row) => row[0]!.durationMs)
      .reduce((min, v) => Math.min(min, v), Number.POSITIVE_INFINITY);
    // The reachable driver wins, which a zero would have prevented.
    expect(soonest).toBe(600_000);
  });
});
