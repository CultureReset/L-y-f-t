/**
 * Surge pricing.
 *
 * `SurgeProvider` is an interface so the multiplier can come from anywhere: a
 * live supply/demand calculation, a pricing service, a schedule, or a fixed
 * value in a test. The built-in provider derives a multiplier from the ratio
 * of open requests to available drivers in a grid cell.
 */

import { cellKey, type LatLng } from '../util/geo.js';
import type { RideTypeId } from '../catalog/rideTypes.js';

export interface SurgeQuery {
  readonly location: LatLng;
  readonly rideTypeId: RideTypeId;
  readonly at: number;
}

export interface SurgeProvider {
  readonly id: string;
  /** Current multiplier at a location, ≥ 1. */
  multiplierFor(query: SurgeQuery): Promise<number> | number;
  /** Heat map for the driver app's "busy areas" overlay. */
  heatmap?(bounds: { south: number; west: number; north: number; east: number }): Promise<SurgeCell[]>;
}

export interface SurgeCell {
  readonly key: string;
  readonly center: LatLng;
  readonly multiplier: number;
  readonly openRequests: number;
  readonly availableDrivers: number;
}

/** Surge is always off. The default in development and tests. */
export const flatSurgeProvider = (multiplier = 1): SurgeProvider => ({
  id: 'flat',
  multiplierFor: () => Math.max(1, multiplier),
});

export interface DemandSnapshot {
  /** Open ride requests keyed by grid cell. */
  readonly openRequests: ReadonlyMap<string, number>;
  /** Available drivers keyed by grid cell. */
  readonly availableDrivers: ReadonlyMap<string, number>;
}

export interface DemandSurgeOptions {
  /** Grid resolution in degrees; ~1.1km at 0.01. */
  readonly precisionDegrees?: number;
  /** Requests per driver at which surge starts. */
  readonly thresholdRatio?: number;
  /** How steeply the multiplier climbs past the threshold. */
  readonly slope?: number;
  readonly maxMultiplier?: number;
  /** Multipliers are rounded to this step so riders see stable numbers. */
  readonly step?: number;
}

/**
 * Demand-based surge. Below `thresholdRatio` requests per driver the
 * multiplier is 1.0; above it, it climbs linearly and is rounded to a clean
 * step so the rider-facing number does not flicker.
 */
export const demandSurgeProvider = (
  snapshot: () => DemandSnapshot,
  options: DemandSurgeOptions = {},
): SurgeProvider => {
  const precision = options.precisionDegrees ?? 0.01;
  const threshold = options.thresholdRatio ?? 1.2;
  const slope = options.slope ?? 0.45;
  const maxMultiplier = options.maxMultiplier ?? 3;
  const step = options.step ?? 0.1;

  const multiplierForCell = (key: string, data: DemandSnapshot): number => {
    const requests = data.openRequests.get(key) ?? 0;
    const drivers = data.availableDrivers.get(key) ?? 0;
    if (requests === 0) return 1;
    // No drivers at all in the cell: treat as maximum pressure rather than
    // dividing by zero.
    const ratio = drivers === 0 ? threshold + requests : requests / drivers;
    if (ratio <= threshold) return 1;
    const raw = 1 + (ratio - threshold) * slope;
    const stepped = Math.round(raw / step) * step;
    return Math.min(maxMultiplier, Math.max(1, Number(stepped.toFixed(2))));
  };

  return {
    id: 'demand',
    multiplierFor: ({ location }) =>
      multiplierForCell(cellKey(location, precision), snapshot()),
    heatmap: async (bounds) => {
      const data = snapshot();
      const cells: SurgeCell[] = [];
      const keys = new Set([...data.openRequests.keys(), ...data.availableDrivers.keys()]);
      for (const key of keys) {
        const [latCell, lngCell] = key.split(':').map(Number);
        if (latCell === undefined || lngCell === undefined) continue;
        const center = {
          lat: (latCell + 0.5) * precision,
          lng: (lngCell + 0.5) * precision,
        };
        if (
          center.lat < bounds.south ||
          center.lat > bounds.north ||
          center.lng < bounds.west ||
          center.lng > bounds.east
        ) {
          continue;
        }
        const multiplier = multiplierForCell(key, data);
        if (multiplier <= 1) continue;
        cells.push({
          key,
          center,
          multiplier,
          openRequests: data.openRequests.get(key) ?? 0,
          availableDrivers: data.availableDrivers.get(key) ?? 0,
        });
      }
      return cells.sort((a, b) => b.multiplier - a.multiplier);
    },
  };
};

/**
 * Time-of-day surge from a schedule — the commute peaks and the bar rush.
 * Composable with any other provider via `combineSurge`.
 */
export interface SurgeWindow {
  /** 0 = Sunday. Empty means every day. */
  readonly daysOfWeek?: readonly number[];
  readonly startHour: number;
  readonly endHour: number;
  readonly multiplier: number;
}

export const scheduledSurgeProvider = (
  windows: readonly SurgeWindow[],
  timeZoneOffsetHours = 0,
): SurgeProvider => ({
  id: 'scheduled',
  multiplierFor: ({ at }) => {
    const local = new Date(at + timeZoneOffsetHours * 3_600_000);
    const day = local.getUTCDay();
    const hour = local.getUTCHours() + local.getUTCMinutes() / 60;
    let best = 1;
    for (const w of windows) {
      if (w.daysOfWeek && w.daysOfWeek.length > 0 && !w.daysOfWeek.includes(day)) continue;
      const inWindow =
        w.startHour <= w.endHour
          ? hour >= w.startHour && hour < w.endHour
          : hour >= w.startHour || hour < w.endHour; // window crosses midnight
      if (inWindow) best = Math.max(best, w.multiplier);
    }
    return best;
  },
});

/** Take the highest multiplier any provider reports. */
export const combineSurge = (
  providers: readonly SurgeProvider[],
  id = 'combined',
): SurgeProvider => ({
  id,
  multiplierFor: async (query) => {
    const values = await Promise.all(providers.map((p) => p.multiplierFor(query)));
    return values.reduce((max, v) => Math.max(max, v), 1);
  },
});
