import { describe, expect, it } from 'vitest';
import { MockGeoProvider } from './mock.js';
import { decodePolyline, haversineMeters, pathLengthMeters } from '@lift/core';

const SF = { lat: 37.7749, lng: -122.4194 };
const FERRY = { lat: 37.7955, lng: -122.3937 };
const DOLORES = { lat: 37.7596, lng: -122.4269 };

const provider = new MockGeoProvider({ simulateTraffic: false });

describe('MockGeoProvider', () => {
  describe('autocomplete', () => {
    it('matches a landmark by name prefix', async () => {
      const results = await provider.autocomplete({ text: 'ferry' });
      expect(results[0]!.primaryText).toBe('Ferry Building');
      expect(results[0]!.ref).toBe('seed:Ferry Building');
    });

    it('matches by alias', async () => {
      const results = await provider.autocomplete({ text: 'sfo' });
      expect(results[0]!.primaryText).toContain('International Airport');
      expect(results[0]!.category).toBe('airport');
    });

    it('returns nothing for empty input', async () => {
      expect(await provider.autocomplete({ text: '   ' })).toEqual([]);
    });

    it('reports distance when a bias point is supplied', async () => {
      const results = await provider.autocomplete({ text: 'ferry', near: SF });
      expect(results[0]!.distanceMeters).toBeGreaterThan(0);
    });

    it('synthesises street addresses so a house number always finds something', async () => {
      const results = await provider.autocomplete({ text: '500 Valencia', near: SF });
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]!.primaryText).toContain('500 Valencia');
      expect(results[0]!.ref.startsWith('addr:')).toBe(true);
    });

    it('honours the result limit', async () => {
      const results = await provider.autocomplete({ text: 'san', limit: 3 });
      expect(results.length).toBeLessThanOrEqual(3);
    });

    it('is deterministic across calls', async () => {
      const a = await provider.autocomplete({ text: '100 Market', near: SF });
      const b = await provider.autocomplete({ text: '100 Market', near: SF });
      expect(a.map((r) => r.ref)).toEqual(b.map((r) => r.ref));
    });
  });

  describe('details', () => {
    it('resolves a seed ref into a full place', async () => {
      const place = await provider.details('seed:Oracle Park');
      expect(place.name).toBe('Oracle Park');
      expect(place.category).toBe('venue');
      // Ballparks have a dedicated rideshare curb, not the stadium centroid.
      expect(place.pickupHint).toBeDefined();
      expect(place.pickupHint!.coordinates).not.toEqual(place.coordinates);
    });

    it('resolves a synthesised address ref', async () => {
      const [suggestion] = await provider.autocomplete({ text: '742 Evergreen', near: SF });
      const place = await provider.details(suggestion!.ref);
      expect(place.address).toContain('San Francisco, CA');
      expect(place.source).toBe('autocomplete');
    });

    it('rejects an unknown ref', async () => {
      await expect(provider.details('nonsense:xyz')).rejects.toThrow(/Unknown place ref/);
    });
  });

  describe('reverseGeocode', () => {
    it('snaps to a landmark when standing on one', async () => {
      const place = await provider.reverseGeocode(FERRY);
      expect(place.name).toBe('Ferry Building');
    });

    it('synthesises a plausible address in the middle of nowhere', async () => {
      const place = await provider.reverseGeocode({ lat: 37.7412, lng: -122.4501 });
      expect(place.address).toMatch(/^\d+ .+, San Francisco, CA \d{5}$/);
      expect(place.subtitle).toBeTruthy();
    });

    it('returns the same address for the same coordinates every time', async () => {
      const point = { lat: 37.7412, lng: -122.4501 };
      const a = await provider.reverseGeocode(point);
      const b = await provider.reverseGeocode(point);
      expect(a.address).toBe(b.address);
    });
  });

  describe('route', () => {
    it('returns a route longer than the crow-flies distance', async () => {
      const route = await provider.route({ waypoints: [FERRY, DOLORES] });
      const straight = haversineMeters(FERRY, DOLORES);
      expect(route.distanceMeters).toBeGreaterThan(straight);
      // Grid detours should be plausible, not absurd.
      expect(route.distanceMeters).toBeLessThan(straight * 2);
    });

    it('produces geometry that actually connects the endpoints', async () => {
      const route = await provider.route({ waypoints: [FERRY, DOLORES] });
      const points = decodePolyline(route.geometry);
      expect(haversineMeters(points[0]!, FERRY)).toBeLessThan(50);
      expect(haversineMeters(points[points.length - 1]!, DOLORES)).toBeLessThan(50);
      expect(pathLengthMeters(points)).toBeCloseTo(route.distanceMeters, -2);
    });

    it('derives duration from distance at the configured speed', async () => {
      const slow = new MockGeoProvider({ averageSpeedKph: 20, simulateTraffic: false });
      const fast = new MockGeoProvider({ averageSpeedKph: 60, simulateTraffic: false });
      const a = await slow.route({ waypoints: [FERRY, DOLORES] });
      const b = await fast.route({ waypoints: [FERRY, DOLORES] });
      expect(a.durationMs).toBeGreaterThan(b.durationMs * 2);
    });

    it('emits turn-by-turn steps that start with depart and end with arrive', async () => {
      const route = await provider.route({ waypoints: [FERRY, DOLORES], steps: true });
      const steps = route.legs[0]!.steps;
      expect(steps.length).toBeGreaterThan(2);
      expect(steps[0]!.maneuver).toBe('depart');
      expect(steps[steps.length - 1]!.maneuver).toBe('arrive');
      expect(steps[0]!.instruction).toMatch(/^Head onto/);
      for (const step of steps) expect(step.instruction.length).toBeGreaterThan(0);
    });

    it('omits steps when they are not requested', async () => {
      const route = await provider.route({ waypoints: [FERRY, DOLORES], steps: false });
      expect(route.legs[0]!.steps).toEqual([]);
    });

    it('builds one leg per waypoint pair for a multi-stop trip', async () => {
      const route = await provider.route({ waypoints: [FERRY, SF, DOLORES] });
      expect(route.legs).toHaveLength(2);
      expect(route.distanceMeters).toBe(
        route.legs.reduce((sum, l) => sum + l.distanceMeters, 0),
      );
    });

    it('rejects a request with fewer than two waypoints', async () => {
      await expect(provider.route({ waypoints: [FERRY] })).rejects.toThrow(
        /origin and a destination/,
      );
    });

    it('applies a toll when the trip crosses the bay', async () => {
      const crossing = await provider.route({
        waypoints: [FERRY, { lat: 37.8044, lng: -122.2712 }],
      });
      expect(crossing.tolls?.amount).toBe(800);
      const withinCity = await provider.route({ waypoints: [FERRY, DOLORES] });
      expect(withinCity.tolls).toBeUndefined();
    });

    it('slows down during rush hour when traffic is simulated', async () => {
      const trafficked = new MockGeoProvider({ simulateTraffic: true });
      const rushHour = new Date('2024-06-03T17:30:00').getTime();
      const midnight = new Date('2024-06-03T02:30:00').getTime();
      const busy = await trafficked.route({ waypoints: [FERRY, DOLORES], departAt: rushHour });
      const quiet = await trafficked.route({ waypoints: [FERRY, DOLORES], departAt: midnight });
      expect(busy.durationMs).toBeGreaterThan(quiet.durationMs);
    });

    it('frames bounds that contain the whole route', async () => {
      const route = await provider.route({ waypoints: [FERRY, DOLORES] });
      for (const point of decodePolyline(route.geometry)) {
        expect(point.lat).toBeGreaterThanOrEqual(route.bounds.south);
        expect(point.lat).toBeLessThanOrEqual(route.bounds.north);
        expect(point.lng).toBeGreaterThanOrEqual(route.bounds.west);
        expect(point.lng).toBeLessThanOrEqual(route.bounds.east);
      }
    });
  });

  describe('matrix', () => {
    it('returns a row per origin and a column per destination', async () => {
      const matrix = await provider.matrix({
        origins: [FERRY, SF],
        destinations: [DOLORES, FERRY, SF],
      });
      expect(matrix).toHaveLength(2);
      expect(matrix[0]).toHaveLength(3);
    });

    it('ranks a nearer driver as faster', async () => {
      const [row] = await provider.matrix({
        origins: [FERRY],
        destinations: [{ lat: 37.7960, lng: -122.3940 }, DOLORES],
      });
      expect(row![0]!.durationMs).toBeLessThan(row![1]!.durationMs);
    });

    it('reports zero distance from a point to itself', async () => {
      const [row] = await provider.matrix({ origins: [FERRY], destinations: [FERRY] });
      expect(row![0]!.distanceMeters).toBe(0);
    });
  });

  it('advertises the capabilities it actually implements', () => {
    expect(provider.capabilities).toMatchObject({
      autocomplete: true,
      routing: true,
      matrix: true,
      turnByTurn: true,
      tiles: false,
    });
    expect(provider.tiles().kind).toBe('none');
  });
});
