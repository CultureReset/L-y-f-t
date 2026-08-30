/**
 * Places — the pickup and dropoff model.
 *
 * A `Place` is deliberately provider-agnostic. It carries a `source` describing
 * where it came from (a geocoder, the rider's saved list, a partner system, a
 * dispatch integration, a raw map pin) and an opaque `externalRef` so the
 * originating system can round-trip its own key. Nothing downstream — pricing,
 * routing, dispatch, the apps — knows or cares which source produced a place.
 * That is what lets you plug in a hotel booking system or an airport feed
 * without touching the ride flow.
 */

import { z } from 'zod';
import type { LatLng } from '../util/geo.js';
import type { PlaceId } from '../util/ids.js';

/** Where a place came from. Extend this list to add an integration. */
export const PLACE_SOURCES = [
  'geocoder',
  'autocomplete',
  'saved',
  'recent',
  'map_pin',
  'current_location',
  'external',
  'venue',
  'airport',
  'seed',
] as const;

export type PlaceSource = (typeof PLACE_SOURCES)[number];

export const PLACE_CATEGORIES = [
  'address',
  'home',
  'work',
  'airport',
  'transit',
  'venue',
  'restaurant',
  'hotel',
  'hospital',
  'shopping',
  'other',
] as const;

export type PlaceCategory = (typeof PLACE_CATEGORIES)[number];

export interface Place {
  readonly id: PlaceId;
  /** One-line label shown in a list row: "Ferry Building". */
  readonly name: string;
  /** Full postal-style address: "1 Ferry Building, San Francisco, CA 94111". */
  readonly address: string;
  /** Secondary line under the name in search results. */
  readonly subtitle?: string;
  readonly coordinates: LatLng;
  readonly category: PlaceCategory;
  readonly source: PlaceSource;
  /**
   * The originating system's own identifier — a Google place_id, a Mapbox
   * feature id, a partner booking reference. Opaque to this platform.
   */
  readonly externalRef?: string;
  /** Which provider produced it, e.g. "google", "mapbox", "mock", "partner:hilton". */
  readonly providerId?: string;
  /**
   * A more precise spot to actually meet the car when the address centroid is
   * not where a car can stop — a terminal curb, a venue's rideshare lot.
   */
  readonly pickupHint?: {
    readonly coordinates: LatLng;
    readonly label: string;
    readonly instructions?: string;
  };
  /** Free-form data the source wants to carry through the ride. */
  readonly metadata?: Record<string, unknown>;
}

export const latLngSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

export const placeSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  address: z.string(),
  subtitle: z.string().optional(),
  coordinates: latLngSchema,
  category: z.enum(PLACE_CATEGORIES).default('address'),
  source: z.enum(PLACE_SOURCES).default('external'),
  externalRef: z.string().optional(),
  providerId: z.string().optional(),
  pickupHint: z
    .object({
      coordinates: latLngSchema,
      label: z.string(),
      instructions: z.string().optional(),
    })
    .optional(),
  metadata: z.record(z.unknown()).optional(),
});

/**
 * The coordinates a car should actually drive to. Prefer an explicit pickup
 * hint (airport curb, venue lot) over the address centroid.
 */
export const meetingPoint = (place: Place): LatLng =>
  place.pickupHint?.coordinates ?? place.coordinates;

export const placeLabel = (place: Place): string => place.name || place.address;

/** A saved shortcut on a rider's account: Home, Work, or anything they name. */
export interface SavedPlace {
  readonly id: PlaceId;
  readonly label: string;
  readonly icon: 'home' | 'work' | 'star' | 'pin';
  readonly place: Place;
  readonly createdAt: number;
}

/** A stop on a multi-stop itinerary. Index 0 is always the pickup. */
export interface Waypoint {
  readonly place: Place;
  /** Minutes the driver is expected to wait here before continuing. */
  readonly plannedStopMinutes?: number;
  readonly arrivedAt?: number;
  readonly departedAt?: number;
  readonly note?: string;
}

export const waypointSchema = z.object({
  place: placeSchema,
  plannedStopMinutes: z.number().min(0).max(60).optional(),
  note: z.string().max(200).optional(),
});

/**
 * An itinerary is the ordered list of places a ride visits: pickup, optional
 * intermediate stops, dropoff. Modelling it as a list from the start means
 * multi-stop rides are not a retrofit.
 */
export interface Itinerary {
  readonly pickup: Place;
  readonly dropoff: Place;
  readonly stops: readonly Waypoint[];
}

export const itineraryPlaces = (itinerary: Itinerary): Place[] => [
  itinerary.pickup,
  ...itinerary.stops.map((s) => s.place),
  itinerary.dropoff,
];

export const itineraryCoordinates = (itinerary: Itinerary): LatLng[] =>
  itineraryPlaces(itinerary).map(meetingPoint);
