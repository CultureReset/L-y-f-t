/**
 * Environment → configuration.
 *
 * The only place in the platform that reads `process.env`. Everything else
 * takes a `PlatformConfig`, which is what makes the whole system runnable in a
 * test, a simulator, or three markets in one process.
 */

import { loadPlatformConfig, type PlatformConfig } from '@lift/core';

export interface ServerConfig {
  readonly host: string;
  readonly port: number;
  readonly logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
  readonly corsOrigins: string[] | boolean;
  /** `memory` or `postgres`. */
  readonly store: string;
  readonly databaseUrl?: string;
  readonly nodeEnv: 'development' | 'test' | 'production';
  /** Seed demo riders, drivers, and vehicles at boot. */
  readonly seedOnBoot: boolean;
  /** A fixed OTP for development sign-in. Refused in production. */
  readonly devAuthCode?: string;
}

const str = (key: string, fallback?: string): string | undefined =>
  process.env[key] ?? fallback;

const num = (key: string, fallback: number): number => {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`Environment variable ${key} must be a number, got "${raw}"`);
  }
  return value;
};

const bool = (key: string, fallback: boolean): boolean => {
  const raw = process.env[key];
  if (raw === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
};

export const loadServerConfig = (): ServerConfig => {
  const nodeEnv = (str('NODE_ENV', 'development') as ServerConfig['nodeEnv']) ?? 'development';
  const devAuthCode = str('DEV_AUTH_CODE');

  // A fixed sign-in code in production would be a total authentication bypass.
  if (nodeEnv === 'production' && devAuthCode) {
    throw new Error('DEV_AUTH_CODE must not be set in production');
  }

  const origins = str('CORS_ORIGINS');
  return {
    host: str('HOST', '0.0.0.0')!,
    port: num('PORT', 4000),
    logLevel: (str('LOG_LEVEL', nodeEnv === 'test' ? 'silent' : 'info') as ServerConfig['logLevel'])!,
    corsOrigins: origins ? origins.split(',').map((o) => o.trim()) : true,
    store: str('STORE', 'memory')!,
    nodeEnv,
    seedOnBoot: bool('SEED_ON_BOOT', nodeEnv !== 'production'),
    ...(str('DATABASE_URL') ? { databaseUrl: str('DATABASE_URL')! } : {}),
    // Default to a fixed code outside production so the apps are usable
    // immediately without an SMS provider.
    ...(nodeEnv === 'production'
      ? {}
      : { devAuthCode: devAuthCode ?? '000000' }),
  };
};

/** Build the domain-level platform config from the environment. */
export const loadConfigFromEnv = (): PlatformConfig => {
  const nodeEnv = str('NODE_ENV', 'development');
  return loadPlatformConfig({
    brandName: str('BRAND_NAME', 'Lyft Clone'),
    market: {
      id: str('MARKET_ID', 'default'),
      name: str('MARKET_NAME', 'San Francisco'),
      currency: str('CURRENCY', 'USD'),
      locale: str('LOCALE', 'en-US'),
      defaultCenter: {
        lat: num('MARKET_CENTER_LAT', 37.7749),
        lng: num('MARKET_CENTER_LNG', -122.4194),
      },
      serviceRadiusMeters: num('SERVICE_RADIUS_METERS', 80_000),
      timeZoneOffsetHours: num('TIMEZONE_OFFSET_HOURS', -8),
    },
    dispatch: {
      strategy: str('DISPATCH_STRATEGY', 'scored'),
      searchRadiusMeters: num('DISPATCH_SEARCH_RADIUS_METERS', 8_000),
      offerTimeoutMs: num('DISPATCH_OFFER_TIMEOUT_MS', 15_000),
      searchTimeoutMs: num('DISPATCH_SEARCH_TIMEOUT_MS', 300_000),
      offerBatchSize: num('DISPATCH_OFFER_BATCH_SIZE', 1),
      roundDelayMs: num('DISPATCH_ROUND_DELAY_MS', 1_000),
      radiusExpansionFactor: num('DISPATCH_RADIUS_EXPANSION', 1.5),
      maxSearchRadiusMeters: num('DISPATCH_MAX_RADIUS_METERS', 30_000),
      tickIntervalMs: num('DISPATCH_TICK_MS', 1_000),
    },
    pricing: {
      surgeProvider: str('SURGE_PROVIDER', 'flat'),
      flatSurgeMultiplier: num('SURGE_FLAT_MULTIPLIER', 1),
      quoteTtlMs: num('QUOTE_TTL_MS', 300_000),
      estimateSpread: num('ESTIMATE_SPREAD', 0.12),
      cancellationPolicy: str('CANCELLATION_POLICY', 'standard'),
    },
    geo: {
      provider: str('GEO_PROVIDER', 'mock'),
      mockAverageSpeedKph: num('GEO_MOCK_SPEED_KPH', 32),
      mockSeed: num('GEO_MOCK_SEED', 42),
      ...(str('GEO_API_KEY') ? { apiKey: str('GEO_API_KEY')! } : {}),
    },
    payments: {
      gateway: str('PAYMENT_GATEWAY', 'memory'),
      simulatedDeclineRate: num('PAYMENT_DECLINE_RATE', 0),
      captureOnComplete: bool('PAYMENT_CAPTURE_ON_COMPLETE', true),
      ...(str('PAYMENT_API_KEY') ? { apiKey: str('PAYMENT_API_KEY')! } : {}),
    },
    notifications: {
      smsProvider: str('SMS_PROVIDER', 'console'),
      pushProvider: str('PUSH_PROVIDER', 'console'),
      ...(str('TWILIO_ACCOUNT_SID') ? { twilioAccountSid: str('TWILIO_ACCOUNT_SID')! } : {}),
      ...(str('TWILIO_AUTH_TOKEN') ? { twilioAuthToken: str('TWILIO_AUTH_TOKEN')! } : {}),
      ...(str('TWILIO_FROM') ? { twilioFrom: str('TWILIO_FROM')! } : {}),
      ...(str('EXPO_ACCESS_TOKEN') ? { expoAccessToken: str('EXPO_ACCESS_TOKEN')! } : {}),
    },
    realtime: {
      driverPingIntervalMs: num('DRIVER_PING_INTERVAL_MS', 4_000),
      staleLocationMs: num('DRIVER_STALE_LOCATION_MS', 60_000),
      heartbeatIntervalMs: num('WS_HEARTBEAT_MS', 25_000),
    },
    features: {
      scheduledRides: bool('FEATURE_SCHEDULED_RIDES', true),
      sharedRides: bool('FEATURE_SHARED_RIDES', true),
      multiStop: bool('FEATURE_MULTI_STOP', true),
      tipping: bool('FEATURE_TIPPING', true),
      inRideChat: bool('FEATURE_IN_RIDE_CHAT', true),
      promoCodes: bool('FEATURE_PROMO_CODES', true),
      driverDestinationFilter: bool('FEATURE_DESTINATION_FILTER', true),
      surgeHeatmap: bool('FEATURE_SURGE_HEATMAP', true),
      safetyToolkit: bool('FEATURE_SAFETY_TOOLKIT', true),
      // On outside production so a fresh clone — and the simulator — can put
      // drivers on the road without an operator in the loop.
      autoApproveDrivers: bool('AUTO_APPROVE_DRIVERS', nodeEnv !== 'production'),
    },
  });
};
