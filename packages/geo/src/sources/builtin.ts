/**
 * The built-in place sources.
 *
 * Between them these cover the whole of the stock search screen. Each one is
 * ordinary code against a small port, which is the point: an external
 * integration is written exactly the same way.
 */

import {
  haversineMeters,
  newPlaceId,
  type LatLng,
  type Place,
  type RiderId,
  type SavedPlace,
} from '@lift/core';
import type { GeoProvider } from '../types.js';
import type { PlaceQuery, PlaceSource, PlaceSourceResult } from './placeSource.js';

/** Reads the rider's saved shortcuts (Home, Work, anything they named). */
export const savedPlacesSource = (
  load: (riderId: RiderId) => Promise<readonly SavedPlace[]>,
): PlaceSource => ({
  id: 'saved',
  title: 'Saved',
  icon: 'star',
  priority: 10,
  showWhenEmpty: true,
  appliesTo: (query) => query.riderId !== undefined,
  search: async (query) => {
    if (!query.riderId) return [];
    const saved = await load(query.riderId);
    const text = query.text.trim().toLowerCase();
    return saved
      .filter(
        (s) =>
          text.length === 0 ||
          s.label.toLowerCase().includes(text) ||
          s.place.name.toLowerCase().includes(text) ||
          s.place.address.toLowerCase().includes(text),
      )
      .map<PlaceSourceResult>((s) => ({
        place: { ...s.place, name: s.label, source: 'saved' },
        relevance: s.icon === 'home' ? 100 : s.icon === 'work' ? 95 : 90,
        icon: s.icon,
      }));
  },
});

/** The rider's recent dropoffs, most recent first. */
export const recentPlacesSource = (
  load: (riderId: RiderId, limit: number) => Promise<readonly Place[]>,
): PlaceSource => ({
  id: 'recent',
  title: 'Recent',
  icon: 'clock',
  priority: 20,
  showWhenEmpty: true,
  appliesTo: (query) => query.riderId !== undefined,
  search: async (query) => {
    if (!query.riderId) return [];
    const recents = await load(query.riderId, query.limit ?? 5);
    const text = query.text.trim().toLowerCase();
    return recents
      .filter(
        (p) =>
          text.length === 0 ||
          p.name.toLowerCase().includes(text) ||
          p.address.toLowerCase().includes(text),
      )
      .map<PlaceSourceResult>((place, index) => ({
        place: { ...place, source: 'recent' },
        // Preserve recency order.
        relevance: 80 - index,
      }));
  },
});

/** Search results from whichever geo provider is configured. */
export const geoProviderSource = (provider: GeoProvider): PlaceSource => ({
  id: `provider:${provider.id}`,
  title: 'Search results',
  icon: 'search',
  priority: 30,
  showWhenEmpty: false,
  appliesTo: () => provider.capabilities.autocomplete,
  search: async (query) => {
    if (!provider.autocomplete) return [];
    const suggestions = await provider.autocomplete({
      text: query.text,
      near: query.near,
      limit: query.limit ?? 6,
      locale: query.locale,
    });
    return suggestions.map<PlaceSourceResult>((s, index) => ({
      place: {
        id: newPlaceId(),
        name: s.primaryText,
        address: s.secondaryText,
        subtitle: s.secondaryText,
        coordinates: s.coordinates ?? { lat: 0, lng: 0 },
        category: s.category,
        source: 'autocomplete',
        providerId: s.providerId,
        externalRef: s.ref,
      },
      relevance: 70 - index,
      badge: s.distanceMeters ? formatDistance(s.distanceMeters) : undefined,
    }));
  },
});

/** The current GPS fix, offered as a one-tap pickup. */
export const currentLocationSource = (
  provider: GeoProvider,
  getPosition: () => Promise<LatLng | undefined>,
): PlaceSource => ({
  id: 'current_location',
  title: 'Current location',
  icon: 'crosshair',
  priority: 5,
  showWhenEmpty: true,
  // Only ever offered as a pickup — "drop me where I already am" is not a ride.
  appliesTo: (query) => query.field !== 'dropoff',
  search: async () => {
    const position = await getPosition();
    if (!position) return [];
    const place = provider.reverseGeocode
      ? await provider.reverseGeocode(position)
      : undefined;
    return [
      {
        place: {
          id: newPlaceId(),
          name: 'Current location',
          address: place?.address ?? 'Your current position',
          subtitle: place?.name,
          coordinates: position,
          category: 'address',
          source: 'current_location',
          providerId: provider.id,
        },
        relevance: 110,
        icon: 'crosshair',
      },
    ];
  },
});

/**
 * A static list of venues — airports, stadiums, campuses — with curated curb
 * locations. This is the shape most partner integrations take.
 */
export const venueSource = (
  venues: readonly Place[],
  options: { id?: string; title?: string; radiusMeters?: number } = {},
): PlaceSource => ({
  id: options.id ?? 'venues',
  title: options.title ?? 'Nearby',
  icon: 'building',
  priority: 25,
  showWhenEmpty: true,
  search: async (query) => {
    const text = query.text.trim().toLowerCase();
    const radius = options.radiusMeters ?? 20_000;
    return venues
      .filter((v) => {
        if (text.length > 0) {
          return (
            v.name.toLowerCase().includes(text) || v.address.toLowerCase().includes(text)
          );
        }
        return query.near ? haversineMeters(query.near, v.coordinates) <= radius : true;
      })
      .slice(0, query.limit ?? 5)
      .map<PlaceSourceResult>((place) => ({
        place: { ...place, source: 'venue' },
        relevance: query.near
          ? Math.max(0, 60 - haversineMeters(query.near, place.coordinates) / 1000)
          : 50,
        badge: query.near
          ? formatDistance(haversineMeters(query.near, place.coordinates))
          : undefined,
      }));
  },
});

/**
 * An external system's places, fetched over HTTP.
 *
 * This is the adapter to copy when wiring in a booking platform, a corporate
 * travel tool, or a dispatch feed: give it a fetcher that returns whatever that
 * system holds and map it into `Place`. Everything downstream — quoting,
 * dispatch, navigation — treats the result identically to a geocoded address.
 */
export const externalSource = (config: {
  id: string;
  title: string;
  icon?: string;
  priority?: number;
  showWhenEmpty?: boolean;
  fetch: (query: PlaceQuery) => Promise<readonly ExternalPlaceRecord[]>;
}): PlaceSource => ({
  id: config.id,
  title: config.title,
  icon: config.icon ?? 'link',
  priority: config.priority ?? 15,
  showWhenEmpty: config.showWhenEmpty ?? true,
  search: async (query) => {
    const records = await config.fetch(query);
    return records.map<PlaceSourceResult>((record, index) => ({
      place: {
        id: newPlaceId(),
        name: record.name,
        address: record.address,
        subtitle: record.subtitle,
        coordinates: record.coordinates,
        category: record.category ?? 'other',
        source: 'external',
        providerId: config.id,
        externalRef: record.externalRef,
        ...(record.pickupHint ? { pickupHint: record.pickupHint } : {}),
        metadata: { ...record.metadata, sourceId: config.id },
      },
      relevance: record.relevance ?? 65 - index,
      badge: record.badge,
    }));
  },
});

/** What an external system has to supply. Everything else is optional. */
export interface ExternalPlaceRecord {
  readonly name: string;
  readonly address: string;
  readonly coordinates: LatLng;
  readonly subtitle?: string;
  readonly category?: Place['category'];
  /** The external system's own key, preserved end to end on the ride. */
  readonly externalRef?: string;
  readonly pickupHint?: NonNullable<Place['pickupHint']>;
  readonly badge?: string;
  readonly relevance?: number;
  readonly metadata?: Record<string, unknown>;
}

const formatDistance = (meters: number): string => {
  const miles = meters / 1609.344;
  if (miles < 0.1) return `${Math.round(meters * 3.28084)} ft`;
  return `${miles.toFixed(1)} mi`;
};
