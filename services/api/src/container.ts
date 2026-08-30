/**
 * The composition root.
 *
 * Every dependency in the platform is chosen here and nowhere else: which store
 * backs the repositories, which geo provider answers routes, which surge model
 * prices demand, which gateway takes payments, which place sources feed the
 * search screen. Everything downstream receives what it needs through its
 * constructor, which is what lets a test build the entire platform in memory
 * with a hand-driven clock.
 */

import {
  RideTypeCatalog,
  TypedEmitter,
  defaultHelpCenter,
  defaultPromos,
  defaultRideTypes,
  defaultTicketCatalog,
  combineSurge,
  demandSurgeProvider,
  flatSurgeProvider,
  scheduledSurgeProvider,
  strategyByName,
  systemClock,
  type Clock,
  type DemandSnapshot,
  type HelpCenter,
  type MatchingStrategy,
  type PaymentGateway,
  type Promo,
  type PlatformConfig,
  type PlatformEvents,
  type RideType,
  type SurgeProvider,
  type TicketCatalog,
} from '@lift/core';
import {
  PlaceSourceRegistry,
  createGeoProvider,
  currentLocationSource,
  geoProviderSource,
  recentPlacesSource,
  savedPlacesSource,
  venueSource,
  type GeoProvider,
  type PlaceSource,
} from '@lift/geo';

import type { Repositories } from './repositories/types.js';
import { createMemoryRepositories } from './repositories/memory/index.js';
import { createPostgresRepositories } from './repositories/postgres/index.js';
import { AuthService, consoleCodeSender, type CodeSender } from './services/authService.js';
import { createStripeGateway } from './integrations/stripeGateway.js';
import { createTwilioSender } from './integrations/twilioSender.js';
import { createExpoPushTransport, createMemoryTokenStore } from './integrations/expoPush.js';
import { PricingService } from './services/pricingService.js';
import { PaymentService, createMemoryGateway } from './services/paymentService.js';
import { DispatchRuntime } from './services/dispatchRuntime.js';
import { RideService } from './services/rideService.js';
import { DriverService } from './services/driverService.js';
import { RiderService } from './services/riderService.js';
import { ChatService } from './services/chatService.js';
import { PromoService } from './services/promoService.js';
import { SupportService } from './services/supportService.js';
import {
  NotificationService,
  consolePushTransport,
  type PushTransport,
} from './services/notificationService.js';
import { RealtimeHub } from './realtime/hub.js';
import type { ServerConfig } from './config/env.js';

export interface ContainerOverrides {
  readonly repositories?: Repositories;
  readonly geo?: GeoProvider;
  readonly surge?: SurgeProvider;
  readonly gateway?: PaymentGateway;
  readonly clock?: Clock;
  readonly codeSender?: CodeSender;
  readonly pushTransport?: PushTransport;
  readonly rideTypes?: readonly RideType[];
  /** Extra place sources — this is where an integration is registered. */
  readonly placeSources?: readonly PlaceSource[];
  readonly matchingStrategy?: MatchingStrategy;
  /** Replace or extend the shipped help articles and ticket categories. */
  readonly helpCenter?: HelpCenter;
  /** Replace the shipped promo codes with an operator's own. */
  readonly promos?: readonly Promo[];
  readonly ticketCatalog?: TicketCatalog;
  readonly logger?: Logger;
}

export interface Logger {
  info(o: unknown, m?: string): void;
  error(o: unknown, m?: string): void;
  warn(o: unknown, m?: string): void;
  debug(o: unknown, m?: string): void;
}

const consoleLogger: Logger = {
  info: (o, m) => console.log(m ?? '', o),
  error: (o, m) => console.error(m ?? '', o),
  warn: (o, m) => console.warn(m ?? '', o),
  debug: () => {},
};

const silentLogger: Logger = {
  info: () => {},
  error: () => {},
  warn: () => {},
  debug: () => {},
};

export interface Container {
  readonly config: PlatformConfig;
  readonly server: ServerConfig;
  readonly clock: Clock;
  readonly events: TypedEmitter<PlatformEvents>;
  readonly repositories: Repositories;
  readonly geo: GeoProvider;
  readonly catalog: RideTypeCatalog;
  readonly surge: SurgeProvider;
  readonly places: PlaceSourceRegistry;
  readonly hub: RealtimeHub;
  readonly auth: AuthService;
  readonly pricing: PricingService;
  readonly payments: PaymentService;
  readonly dispatch: DispatchRuntime;
  readonly rides: RideService;
  readonly drivers: DriverService;
  readonly riders: RiderService;
  readonly chat: ChatService;
  readonly promos: PromoService;
  readonly support: SupportService;
  readonly notifications: NotificationService;
  /** Device tokens for push, so the apps can register on launch. */
  readonly pushTokens: ReturnType<typeof createMemoryTokenStore>;
  readonly logger: Logger;
  /** Start background loops: dispatch, realtime, notifications, scheduler. */
  start(): void;
  stop(): Promise<void>;
}

export const createContainer = async (
  config: PlatformConfig,
  serverConfig: ServerConfig,
  overrides: ContainerOverrides = {},
): Promise<Container> => {
  const clock = overrides.clock ?? systemClock;
  const logger =
    overrides.logger ?? (serverConfig.nodeEnv === 'test' ? silentLogger : consoleLogger);
  const events = new TypedEmitter<PlatformEvents>();
  events.onError = (error, type) =>
    logger.error({ err: error, event: String(type) }, 'event listener failed');

  const repositories =
    overrides.repositories ??
    (serverConfig.store === 'postgres'
      ? await createPostgresRepositories({
          clock,
          connectionString:
            serverConfig.databaseUrl ??
            (() => {
              throw new Error('DATABASE_URL is required when STORE=postgres');
            })(),
        })
      : createMemoryRepositories(clock));

  const geo =
    overrides.geo ??
    createGeoProvider(config.geo, {
      onFallback: (method, error) =>
        logger.warn({ method, err: error }, 'geo provider fell back to the mock'),
    });

  // The stock catalog is priced in the market's currency; a mismatch would make
  // the pricing engine reject the first quote.
  const catalog = new RideTypeCatalog(
    overrides.rideTypes ?? defaultRideTypes(config.market.currency),
  );
  const surge = overrides.surge ?? buildSurgeProvider(config, repositories);

  const places = new PlaceSourceRegistry(
    [
      currentLocationSource(geo, async () => undefined),
      savedPlacesSource(async (riderId) => {
        const rider = await repositories.riders.findById(riderId);
        return rider?.savedPlaces ?? [];
      }),
      recentPlacesSource((riderId, limit) => repositories.riders.recentPlaces(riderId, limit)),
      geoProviderSource(geo),
      venueSource([]),
      ...(overrides.placeSources ?? []),
    ],
    {
      onError: (id, error) => logger.warn({ source: id, err: error }, 'place source failed'),
    },
  );

  // Device tokens live here so both the push transport and the route that
  // registers a device share one store.
  const pushTokens = createMemoryTokenStore();

  const hub = new RealtimeHub(events, {
    heartbeatIntervalMs: config.realtime.heartbeatIntervalMs,
    logger,
  });

  const gateway = overrides.gateway ?? buildGateway(config, logger);

  const payments = new PaymentService({
    gateway,
    methods: repositories.paymentMethods,
    charges: repositories.charges,
    clock,
    events,
  });

  const auth = new AuthService({
    users: repositories.users,
    sessions: repositories.sessions,
    verifications: repositories.verifications,
    riders: repositories.riders,
    drivers: repositories.drivers,
    clock,
    events,
    sender: overrides.codeSender ?? buildCodeSender(config, logger),
    market: config.market,
    options: serverConfig.devAuthCode
      ? { fixedCode: serverConfig.devAuthCode, allowFixedCode: true }
      : {},
  });

  const dispatch = new DispatchRuntime({
    drivers: repositories.drivers,
    vehicles: repositories.vehicles,
    rides: repositories.rides,
    riders: repositories.riders,
    users: repositories.users,
    offers: repositories.offers,
    geo,
    catalog,
    config,
    clock,
    events,
    logger,
    strategyFor: () => overrides.matchingStrategy ?? strategyByName(config.dispatch.strategy),
  });

  const pricing = new PricingService({
    geo,
    catalog,
    surge,
    config,
    clock,
    // Quote ETAs come from the real fleet: the nearest available driver.
    estimatePickupEta: async (rideTypeId, pickup) => {
      const nearby = await repositories.drivers.findAvailableNear(
        pickup,
        config.dispatch.searchRadiusMeters,
        { staleAfterMs: config.realtime.staleLocationMs, now: clock.now() },
      );
      if (nearby.length === 0) return undefined;
      const rideType = catalog.get(rideTypeId);
      const positions = nearby
        .map((d) => d.lastPosition)
        .filter((p): p is NonNullable<typeof p> => p !== undefined);
      if (positions.length === 0 || !geo.matrix) return undefined;
      const matrix = await geo.matrix({ origins: positions, destinations: [pickup] });
      const soonest = matrix
        .map((row) => row[0]?.durationMs ?? Number.POSITIVE_INFINITY)
        .reduce((min, v) => Math.min(min, v), Number.POSITIVE_INFINITY);
      if (!Number.isFinite(soonest)) return undefined;
      // Scarcer tiers wait longer than the raw nearest-driver time suggests.
      return Math.round(soonest * (rideType?.etaMultiplier ?? 1));
    },
  });

  const rides = new RideService({
    rides: repositories.rides,
    riders: repositories.riders,
    drivers: repositories.drivers,
    vehicles: repositories.vehicles,
    shifts: repositories.shifts,
    geo,
    catalog,
    pricing,
    payments,
    dispatch,
    config,
    clock,
    events,
    logger,
  });

  // Dispatch hands assignments back to the ride service; wiring it here keeps
  // the two from importing each other.
  dispatch.setHandlers({
    onAssign: async (input) => {
      await rides.assignDriver(input);
    },
    onNoDrivers: async (rideId, searchedMs) => {
      await rides.expireRide(rideId, searchedMs);
    },
  });

  const drivers = new DriverService({
    drivers: repositories.drivers,
    vehicles: repositories.vehicles,
    shifts: repositories.shifts,
    rides: repositories.rides,
    offers: repositories.offers,
    dispatch,
    catalog,
    config,
    clock,
    events,
  });

  const riders = new RiderService({
    riders: repositories.riders,
    users: repositories.users,
    paymentMethods: repositories.paymentMethods,
    places,
    geo,
    clock,
  });

  const chat = new ChatService({
    chat: repositories.chat,
    rides: repositories.rides,
    clock,
    events,
  });

  const promos = new PromoService({
    promos: repositories.promos,
    rides: repositories.rides,
    catalog: overrides.promos ?? defaultPromos(config.market.currency),
    currency: config.market.currency,
    clock,
  });

  const support = new SupportService({
    support: repositories.support,
    rides: repositories.rides,
    helpCenter: overrides.helpCenter ?? defaultHelpCenter(),
    ticketCatalog: overrides.ticketCatalog ?? defaultTicketCatalog(),
    clock,
    events,
  });

  const notifications = new NotificationService(
    events,
    overrides.pushTransport ?? buildPushTransport(config, pushTokens, logger),
  );

  let scheduler: ReturnType<typeof setInterval> | undefined;

  return {
    config,
    server: serverConfig,
    clock,
    events,
    repositories,
    geo,
    catalog,
    surge,
    places,
    hub,
    auth,
    pricing,
    payments,
    dispatch,
    rides,
    drivers,
    riders,
    chat,
    promos,
    support,
    notifications,
    pushTokens,
    logger,

    start() {
      hub.start();
      notifications.start();
      dispatch.start();
      if (config.features.scheduledRides) {
        // Scheduled rides need checking far less often than dispatch ticks.
        scheduler = setInterval(() => {
          void rides
            .releaseDueScheduledRides()
            .catch((e) => logger.error({ err: e }, 'scheduled ride release failed'));
        }, 30_000);
        scheduler.unref?.();
      }
    },

    async stop() {
      if (scheduler) clearInterval(scheduler);
      dispatch.stop();
      notifications.stop();
      hub.stop();
      await repositories.close();
    },
  };
};

/**
 * Payments. The in-memory gateway is the default and needs no account; naming a
 * real one requires its key, and a missing key is a boot failure rather than a
 * silent fallback that would take payments nowhere.
 */
const buildGateway = (config: PlatformConfig, logger: Logger): PaymentGateway => {
  switch (config.payments.gateway) {
    case 'memory':
      return createMemoryGateway({ declineRate: config.payments.simulatedDeclineRate });
    case 'stripe': {
      if (!config.payments.apiKey) {
        throw new Error('PAYMENT_API_KEY is required when PAYMENT_GATEWAY=stripe');
      }
      logger.info({}, 'payments: using Stripe');
      return createStripeGateway({
        secretKey: config.payments.apiKey,
        statementDescriptor: config.brandName.slice(0, 22),
      });
    }
    default:
      throw new Error(`Unknown payment gateway "${config.payments.gateway}"`);
  }
};

/** Verification codes: logged in development, sent for real in production. */
const buildCodeSender = (config: PlatformConfig, logger: Logger): CodeSender => {
  const sms = config.notifications.smsProvider;
  if (sms === 'console') return consoleCodeSender((m) => logger.info({}, m));

  if (sms === 'twilio') {
    const { twilioAccountSid, twilioAuthToken, twilioFrom } = config.notifications;
    if (!twilioAccountSid || !twilioAuthToken || !twilioFrom) {
      throw new Error(
        'TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_FROM are required when SMS_PROVIDER=twilio',
      );
    }
    logger.info({}, 'sms: using Twilio');
    return createTwilioSender({
      accountSid: twilioAccountSid,
      authToken: twilioAuthToken,
      from: twilioFrom,
      brandName: config.brandName,
      logger,
    });
  }
  throw new Error(`Unknown SMS provider "${sms}"`);
};

/** Push notifications: logged in development, delivered through Expo otherwise. */
const buildPushTransport = (
  config: PlatformConfig,
  tokens: ReturnType<typeof createMemoryTokenStore>,
  logger: Logger,
): PushTransport => {
  switch (config.notifications.pushProvider) {
    case 'console':
      return consolePushTransport((m) => logger.info({}, m));
    case 'expo':
      logger.info({}, 'push: using Expo');
      return createExpoPushTransport({
        tokens,
        logger,
        ...(config.notifications.expoAccessToken
          ? { accessToken: config.notifications.expoAccessToken }
          : {}),
      });
    default:
      throw new Error(`Unknown push provider "${config.notifications.pushProvider}"`);
  }
};

/** Build the configured surge provider. */
const buildSurgeProvider = (
  config: PlatformConfig,
  repositories: Repositories,
): SurgeProvider => {
  switch (config.pricing.surgeProvider) {
    case 'flat':
      return flatSurgeProvider(config.pricing.flatSurgeMultiplier);
    case 'demand':
      return demandSurgeProvider(() => snapshotDemand(repositories));
    case 'scheduled':
      return scheduledSurgeProvider(COMMUTE_WINDOWS, config.market.timeZoneOffsetHours);
    case 'demand+scheduled':
      return combineSurge([
        demandSurgeProvider(() => snapshotDemand(repositories)),
        scheduledSurgeProvider(COMMUTE_WINDOWS, config.market.timeZoneOffsetHours),
      ]);
    default:
      throw new Error(`Unknown surge provider "${config.pricing.surgeProvider}"`);
  }
};

/** Weekday commute peaks and the late-night bar rush. */
const COMMUTE_WINDOWS = [
  { daysOfWeek: [1, 2, 3, 4, 5], startHour: 7, endHour: 9.5, multiplier: 1.3 },
  { daysOfWeek: [1, 2, 3, 4, 5], startHour: 16.5, endHour: 19, multiplier: 1.4 },
  { daysOfWeek: [5, 6], startHour: 22, endHour: 2.5, multiplier: 1.5 },
];

/**
 * The demand snapshot the surge model reads. Kept synchronous by caching the
 * counts the dispatch loop already maintains; a real deployment would compute
 * this in a streaming aggregate rather than per call.
 */
const demandCache = new WeakMap<Repositories, { at: number; snapshot: DemandSnapshot }>();

const snapshotDemand = (repositories: Repositories): DemandSnapshot => {
  const cached = demandCache.get(repositories);
  const now = Date.now();
  if (cached && now - cached.at < 5_000) return cached.snapshot;

  const empty: DemandSnapshot = { openRequests: new Map(), availableDrivers: new Map() };
  demandCache.set(repositories, { at: now, snapshot: cached?.snapshot ?? empty });

  // Refresh in the background so pricing never waits on a store round-trip.
  void Promise.all([repositories.rides.findSearching(), repositories.drivers.list(1000)])
    .then(([searching, drivers]) => {
      const openRequests = new Map<string, number>();
      const availableDrivers = new Map<string, number>();
      const key = (lat: number, lng: number): string =>
        `${Math.floor(lat / 0.01)}:${Math.floor(lng / 0.01)}`;

      for (const ride of searching) {
        const p = ride.itinerary.pickup.coordinates;
        const k = key(p.lat, p.lng);
        openRequests.set(k, (openRequests.get(k) ?? 0) + 1);
      }
      for (const driver of drivers) {
        if (driver.availability !== 'available' || !driver.lastPosition) continue;
        const k = key(driver.lastPosition.lat, driver.lastPosition.lng);
        availableDrivers.set(k, (availableDrivers.get(k) ?? 0) + 1);
      }
      demandCache.set(repositories, { at: Date.now(), snapshot: { openRequests, availableDrivers } });
    })
    .catch(() => {});

  return demandCache.get(repositories)!.snapshot;
};
