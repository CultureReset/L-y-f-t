/**
 * Provider construction from configuration.
 *
 * `createGeoProvider` is the only place in the platform that decides which
 * provider is in play. Register a factory here to add a vendor; set
 * `geo.provider` in the platform config to select it.
 */

import type { PlatformConfig } from '@lift/core';
import type { GeoProvider } from './types.js';
import { MockGeoProvider } from './providers/mock.js';
import { GoogleGeoProvider } from './providers/google.js';
import { MapboxGeoProvider } from './providers/mapbox.js';
import { OsrmGeoProvider } from './providers/osrm.js';
import { withCache, withFallback } from './composite.js';

export interface GeoProviderFactoryOptions {
  readonly apiKey?: string;
  readonly config?: PlatformConfig['geo'];
}

export type GeoProviderFactory = (options: GeoProviderFactoryOptions) => GeoProvider;

const factories = new Map<string, GeoProviderFactory>();

export const registerGeoProvider = (id: string, factory: GeoProviderFactory): void => {
  factories.set(id, factory);
};

export const listGeoProviders = (): string[] => [...factories.keys()];

registerGeoProvider('mock', ({ config }) => {
  const options: ConstructorParameters<typeof MockGeoProvider>[0] = {};
  if (config?.mockAverageSpeedKph !== undefined) {
    Object.assign(options, { averageSpeedKph: config.mockAverageSpeedKph });
  }
  if (config?.mockSeed !== undefined) Object.assign(options, { seed: config.mockSeed });
  return new MockGeoProvider(options);
});

registerGeoProvider('google', ({ apiKey }) => {
  if (!apiKey) throw new Error('GEO_API_KEY is required for the Google provider');
  return new GoogleGeoProvider({ apiKey });
});

registerGeoProvider('mapbox', ({ apiKey }) => {
  if (!apiKey) throw new Error('GEO_API_KEY is required for the Mapbox provider');
  return new MapboxGeoProvider({ accessToken: apiKey });
});

registerGeoProvider('osrm', () => new OsrmGeoProvider());

export interface CreateGeoProviderOptions {
  /** Wrap the provider in a short-lived cache. On by default. */
  readonly cache?: boolean;
  /**
   * Fall back to the mock provider when the configured one fails. On by
   * default for every provider except the mock itself, so a vendor outage
   * degrades ETA quality instead of stopping the platform.
   */
  readonly fallbackToMock?: boolean;
  readonly onFallback?: (method: string, error: unknown) => void;
}

export const createGeoProvider = (
  config: PlatformConfig['geo'],
  options: CreateGeoProviderOptions = {},
): GeoProvider => {
  const factory = factories.get(config.provider);
  if (!factory) {
    throw new Error(
      `Unknown geo provider "${config.provider}". Registered: ${listGeoProviders().join(', ')}`,
    );
  }

  let provider = factory({ apiKey: config.apiKey, config });

  if (config.provider !== 'mock' && (options.fallbackToMock ?? true)) {
    provider = withFallback(provider, new MockGeoProvider(), options.onFallback);
  }
  if (options.cache ?? true) {
    provider = withCache(provider);
  }
  return provider;
};
