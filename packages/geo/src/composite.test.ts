import { describe, expect, it, vi } from 'vitest';
import { CompositeGeoProvider, withCache, withFallback } from './composite.js';
import { MockGeoProvider } from './providers/mock.js';
import type { GeoProvider } from './types.js';

const FERRY = { lat: 37.7955, lng: -122.3937 };
const DOLORES = { lat: 37.7596, lng: -122.4269 };

describe('withCache', () => {
  /**
   * Regression: a provider is a class instance, so spreading it into the
   * wrapper silently dropped every prototype method — routing vanished and
   * quoting failed with "provider cannot route".
   */
  it('preserves every capability of a class-based provider', async () => {
    const cached = withCache(new MockGeoProvider());
    expect(cached.route).toBeDefined();
    expect(cached.autocomplete).toBeDefined();
    expect(cached.details).toBeDefined();
    expect(cached.matrix).toBeDefined();
    expect(cached.tiles).toBeDefined();

    const route = await cached.route!({ waypoints: [FERRY, DOLORES] });
    expect(route.distanceMeters).toBeGreaterThan(0);
  });

  it('serves a repeated autocomplete from cache', async () => {
    const inner = new MockGeoProvider();
    const spy = vi.spyOn(inner, 'autocomplete');
    const cached = withCache(inner, { ttlMs: 10_000 });

    await cached.autocomplete!({ text: 'ferry' });
    await cached.autocomplete!({ text: 'ferry' });
    expect(spy).toHaveBeenCalledTimes(1);

    await cached.autocomplete!({ text: 'oracle' });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('re-queries once an entry expires', async () => {
    const inner = new MockGeoProvider();
    const spy = vi.spyOn(inner, 'autocomplete');
    const cached = withCache(inner, { ttlMs: -1 });
    await cached.autocomplete!({ text: 'ferry' });
    await cached.autocomplete!({ text: 'ferry' });
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe('withFallback', () => {
  it('falls back to the backup when the primary throws', async () => {
    const onFallback = vi.fn();
    const broken: GeoProvider = {
      id: 'broken',
      capabilities: {
        autocomplete: true, geocode: true, reverseGeocode: true, routing: true,
        matrix: true, turnByTurn: true, tiles: false, tolls: false,
      },
      route: async () => {
        throw new Error('vendor outage');
      },
    };

    const provider = withFallback(broken, new MockGeoProvider(), onFallback);
    const route = await provider.route!({ waypoints: [FERRY, DOLORES] });
    expect(route.providerId).toBe('mock');
    expect(onFallback).toHaveBeenCalledWith('route', expect.any(Error));
  });

  it('uses the primary when it succeeds', async () => {
    const provider = withFallback(new MockGeoProvider(), new MockGeoProvider());
    const route = await provider.route!({ waypoints: [FERRY, DOLORES] });
    expect(route.distanceMeters).toBeGreaterThan(0);
  });
});

describe('CompositeGeoProvider', () => {
  it('routes each capability to its nominated provider', async () => {
    const search = new MockGeoProvider();
    const routing = new MockGeoProvider({ averageSpeedKph: 60 });
    const routeSpy = vi.spyOn(routing, 'route');
    const searchSpy = vi.spyOn(search, 'autocomplete');

    const composite = new CompositeGeoProvider({ search, routing });
    await composite.autocomplete({ text: 'ferry' });
    await composite.route({ waypoints: [FERRY, DOLORES] });

    expect(searchSpy).toHaveBeenCalled();
    expect(routeSpy).toHaveBeenCalled();
    expect(composite.id).toContain('composite');
  });

  it('reports a missing capability rather than failing obscurely', async () => {
    const composite = new CompositeGeoProvider({ search: new MockGeoProvider() });
    expect(composite.capabilities.routing).toBe(false);
    await expect(composite.route({ waypoints: [FERRY, DOLORES] })).rejects.toThrow(
      /no routing provider/,
    );
  });
});
