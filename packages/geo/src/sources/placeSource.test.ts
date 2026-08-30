import { describe, expect, it, vi } from 'vitest';
import { PlaceSourceRegistry } from './placeSource.js';
import type { PlaceSource } from './placeSource.js';
import {
  externalSource,
  geoProviderSource,
  recentPlacesSource,
  savedPlacesSource,
  venueSource,
} from './builtin.js';
import { MockGeoProvider } from '../providers/mock.js';
import { newPlaceId, type Place, type RiderId, type SavedPlace } from '@lift/core';

const RIDER = 'rdr_test' as RiderId;
const SF = { lat: 37.7749, lng: -122.4194 };

const place = (name: string, overrides: Partial<Place> = {}): Place => ({
  id: newPlaceId(),
  name,
  address: `${name}, San Francisco, CA`,
  coordinates: SF,
  category: 'address',
  source: 'seed',
  ...overrides,
});

const saved: SavedPlace[] = [
  { id: newPlaceId(), label: 'Home', icon: 'home', place: place('123 Main St'), createdAt: 0 },
  { id: newPlaceId(), label: 'Work', icon: 'work', place: place('1 Market St'), createdAt: 0 },
];

describe('PlaceSourceRegistry', () => {
  it('shows saved and recent places before the rider types anything', async () => {
    const registry = new PlaceSourceRegistry([
      savedPlacesSource(async () => saved),
      recentPlacesSource(async () => [place('Ferry Building')]),
      geoProviderSource(new MockGeoProvider()),
    ]);

    const sections = await registry.search({ text: '', riderId: RIDER });
    expect(sections.map((s) => s.sourceId)).toEqual(['saved', 'recent']);
    // The geocoder has nothing to search for yet, so it stays quiet.
    expect(sections.find((s) => s.sourceId.startsWith('provider:'))).toBeUndefined();
  });

  it('orders sections by source priority', async () => {
    const registry = new PlaceSourceRegistry([
      geoProviderSource(new MockGeoProvider()),
      recentPlacesSource(async () => [place('Ferry Building')]),
      savedPlacesSource(async () => saved),
    ]);
    const sections = await registry.search({ text: 'market', riderId: RIDER, near: SF });
    expect(sections[0]!.sourceId).toBe('saved');
  });

  it('sorts results within a section by relevance, putting Home first', async () => {
    const registry = new PlaceSourceRegistry([savedPlacesSource(async () => saved)]);
    const [section] = await registry.search({ text: '', riderId: RIDER });
    expect(section!.results.map((r) => r.place.name)).toEqual(['Home', 'Work']);
  });

  it('skips rider-scoped sources when there is no rider', async () => {
    const registry = new PlaceSourceRegistry([savedPlacesSource(async () => saved)]);
    expect(await registry.search({ text: '' })).toEqual([]);
  });

  it('drops a failing source instead of breaking search', async () => {
    const onError = vi.fn();
    const broken: PlaceSource = {
      id: 'broken',
      title: 'Broken',
      icon: 'x',
      priority: 1,
      showWhenEmpty: true,
      search: async () => {
        throw new Error('partner API is down');
      },
    };
    const registry = new PlaceSourceRegistry([broken, savedPlacesSource(async () => saved)], {
      onError,
    });

    const sections = await registry.search({ text: '', riderId: RIDER });
    expect(sections.map((s) => s.sourceId)).toEqual(['saved']);
    expect(onError).toHaveBeenCalledWith('broken', expect.any(Error));
  });

  it('drops a hanging source once it exceeds the timeout', async () => {
    const slow: PlaceSource = {
      id: 'slow',
      title: 'Slow',
      icon: 'clock',
      priority: 1,
      showWhenEmpty: true,
      search: () => new Promise(() => {}),
    };
    const registry = new PlaceSourceRegistry([slow, savedPlacesSource(async () => saved)], {
      timeoutMs: 20,
    });
    const sections = await registry.search({ text: '', riderId: RIDER });
    expect(sections.map((s) => s.sourceId)).toEqual(['saved']);
  });

  it('omits sources that return nothing', async () => {
    const registry = new PlaceSourceRegistry([
      savedPlacesSource(async () => []),
      recentPlacesSource(async () => [place('Ferry Building')]),
    ]);
    const sections = await registry.search({ text: '', riderId: RIDER });
    expect(sections.map((s) => s.sourceId)).toEqual(['recent']);
  });

  it('offers current location only for pickup, never for dropoff', async () => {
    const provider = new MockGeoProvider();
    const { currentLocationSource } = await import('./builtin.js');
    const registry = new PlaceSourceRegistry([
      currentLocationSource(provider, async () => SF),
    ]);
    expect(await registry.search({ text: '', field: 'pickup' })).toHaveLength(1);
    expect(await registry.search({ text: '', field: 'dropoff' })).toEqual([]);
  });

  it('de-duplicates the flat list by external ref', async () => {
    const shared = place('Ferry Building', { externalRef: 'seed:Ferry Building' });
    const registry = new PlaceSourceRegistry([
      recentPlacesSource(async () => [shared]),
      venueSource([shared], { id: 'venues' }),
    ]);
    const flat = await registry.searchFlat({ text: '', riderId: RIDER, near: SF });
    expect(flat).toHaveLength(1);
  });

  it('can register and unregister a source at runtime', async () => {
    const registry = new PlaceSourceRegistry();
    expect(registry.list()).toHaveLength(0);
    registry.register(savedPlacesSource(async () => saved));
    expect(registry.list()).toHaveLength(1);
    registry.unregister('saved');
    expect(registry.get('saved')).toBeUndefined();
  });
});

describe('externalSource', () => {
  /**
   * The integration story: a partner system supplies its own places, and they
   * flow through the platform indistinguishably from a geocoded address — with
   * the partner's own key and curb instructions preserved end to end.
   */
  it('maps partner records into places that carry their ref and pickup hint', async () => {
    const hotelDesk = externalSource({
      id: 'partner:hotel',
      title: 'Your hotel',
      fetch: async () => [
        {
          name: 'Hotel Ambassador — Main Entrance',
          address: '400 Post St, San Francisco, CA 94102',
          coordinates: { lat: 37.7885, lng: -122.4094 },
          externalRef: 'booking-88213',
          category: 'hotel' as const,
          pickupHint: {
            coordinates: { lat: 37.7887, lng: -122.4091 },
            label: 'Valet stand on Post St',
            instructions: 'Ask the doorman for the rideshare queue',
          },
          badge: 'Checked in',
          metadata: { reservationId: '88213', guestTier: 'gold' },
        },
      ],
    });

    const registry = new PlaceSourceRegistry([hotelDesk]);
    const [section] = await registry.search({ text: '', riderId: RIDER });

    expect(section!.title).toBe('Your hotel');
    const result = section!.results[0]!;
    expect(result.place.source).toBe('external');
    expect(result.place.externalRef).toBe('booking-88213');
    expect(result.place.providerId).toBe('partner:hotel');
    expect(result.place.pickupHint?.label).toBe('Valet stand on Post St');
    expect(result.place.metadata).toMatchObject({
      reservationId: '88213',
      sourceId: 'partner:hotel',
    });
    expect(result.badge).toBe('Checked in');
  });

  it('passes the live query through to the partner so it can filter', async () => {
    const fetch = vi.fn(async () => []);
    const registry = new PlaceSourceRegistry([
      externalSource({ id: 'partner:x', title: 'Partner', fetch }),
    ]);
    await registry.search({ text: 'terminal 2', riderId: RIDER, near: SF, field: 'dropoff' });
    expect(fetch).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'terminal 2', riderId: RIDER, field: 'dropoff' }),
    );
  });
});

describe('venueSource', () => {
  it('filters by radius when nothing is typed and by name when something is', async () => {
    const venues = [
      place('Close Venue', { coordinates: { lat: 37.7755, lng: -122.4190 } }),
      place('Distant Venue', { coordinates: { lat: 38.5, lng: -121.5 } }),
    ];
    const registry = new PlaceSourceRegistry([venueSource(venues, { radiusMeters: 5_000 })]);

    const nearby = await registry.search({ text: '', near: SF });
    expect(nearby[0]!.results.map((r) => r.place.name)).toEqual(['Close Venue']);

    const byName = await registry.search({ text: 'distant', near: SF });
    expect(byName[0]!.results.map((r) => r.place.name)).toEqual(['Distant Venue']);
  });
});
