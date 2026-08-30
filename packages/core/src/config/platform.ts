/**
 * Platform configuration.
 *
 * Every knob that a deployment might want to turn lives here, validated by a
 * schema with sane defaults. Nothing in the codebase reads `process.env`
 * directly except the loader that builds this object — which is what makes the
 * platform portable between a laptop, CI, and a real market.
 */

import { z } from 'zod';

export const platformConfigSchema = z.object({
  /** Display name used across both apps and every notification. */
  brandName: z.string().default('Lyft Clone'),

  market: z
    .object({
      id: z.string().default('default'),
      name: z.string().default('San Francisco'),
      currency: z.enum(['USD', 'CAD', 'EUR', 'GBP', 'MXN']).default('USD'),
      locale: z.string().default('en-US'),
      /** Where a map opens before the device reports a location. */
      defaultCenter: z
        .object({ lat: z.number(), lng: z.number() })
        .default({ lat: 37.7749, lng: -122.4194 }),
      /** Requests outside this radius from the centre are refused. */
      serviceRadiusMeters: z.number().default(80_000),
      timeZoneOffsetHours: z.number().default(-8),
    })
    .default({}),

  dispatch: z
    .object({
      /** One of the ids in `STRATEGIES`, or a custom registered strategy. */
      strategy: z.string().default('scored'),
      searchRadiusMeters: z.number().default(8_000),
      offerTimeoutMs: z.number().default(15_000),
      searchTimeoutMs: z.number().default(5 * 60 * 1000),
      offerBatchSize: z.number().int().min(1).max(10).default(1),
      roundDelayMs: z.number().default(1_000),
      radiusExpansionFactor: z.number().min(1).default(1.5),
      maxSearchRadiusMeters: z.number().default(30_000),
      /** How often the dispatch loop ticks. */
      tickIntervalMs: z.number().default(1_000),
    })
    .default({}),

  pricing: z
    .object({
      /** `flat`, `demand`, `scheduled`, or a registered custom provider. */
      surgeProvider: z.string().default('flat'),
      flatSurgeMultiplier: z.number().min(1).default(1),
      quoteTtlMs: z.number().default(5 * 60 * 1000),
      estimateSpread: z.number().min(0).max(0.5).default(0.12),
      /** `standard` or `free`. */
      cancellationPolicy: z.string().default('standard'),
    })
    .default({}),

  geo: z
    .object({
      /** `mock`, `google`, `mapbox`, or `osrm`. */
      provider: z.string().default('mock'),
      apiKey: z.string().optional(),
      /** Average speed the mock router assumes, in km/h. */
      mockAverageSpeedKph: z.number().default(32),
      /** Deterministic seed for the mock provider's synthetic geometry. */
      mockSeed: z.number().default(42),
    })
    .default({}),

  payments: z
    .object({
      /** `memory` or a registered gateway id such as `stripe`. */
      gateway: z.string().default('memory'),
      /** Fraction of authorizations the memory gateway fails, for testing. */
      simulatedDeclineRate: z.number().min(0).max(1).default(0),
      apiKey: z.string().optional(),
      /** Capture at ride completion rather than holding the authorization. */
      captureOnComplete: z.boolean().default(true),
    })
    .default({}),

  realtime: z
    .object({
      /** How often a driver app pushes its location while on a ride. */
      driverPingIntervalMs: z.number().default(4_000),
      /** Drop a driver from dispatch after this long without a ping. */
      staleLocationMs: z.number().default(60_000),
      heartbeatIntervalMs: z.number().default(25_000),
    })
    .default({}),

  features: z
    .object({
      scheduledRides: z.boolean().default(true),
      sharedRides: z.boolean().default(true),
      multiStop: z.boolean().default(true),
      tipping: z.boolean().default(true),
      inRideChat: z.boolean().default(true),
      promoCodes: z.boolean().default(true),
      driverDestinationFilter: z.boolean().default(true),
      surgeHeatmap: z.boolean().default(true),
      safetyToolkit: z.boolean().default(true),
    })
    .default({}),
});

export type PlatformConfig = z.infer<typeof platformConfigSchema>;

export const defaultPlatformConfig = (): PlatformConfig => platformConfigSchema.parse({});

/**
 * Build a config from a plain object (usually parsed env vars), falling back to
 * defaults for anything absent. Throws with a readable message on bad input so
 * a misconfigured deployment fails at boot rather than mid-ride.
 */
export const loadPlatformConfig = (input: unknown = {}): PlatformConfig => {
  const result = platformConfigSchema.safeParse(input ?? {});
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  • ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid platform configuration:\n${issues}`);
  }
  return result.data;
};

/** Deep-merge an override on top of a config — used for per-market overlays. */
export const withOverrides = (
  base: PlatformConfig,
  overrides: DeepPartial<PlatformConfig>,
): PlatformConfig => loadPlatformConfig(deepMerge(base, overrides));

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const deepMerge = (base: unknown, patch: unknown): unknown => {
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch ?? base;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    out[key] = isPlainObject(value) ? deepMerge(base[key], value) : value;
  }
  return out;
};
