/**
 * The HTTP server.
 *
 * Assembly only: plugins, routes, and lifecycle. Everything it serves comes
 * from the container, which is what lets a test build an identical server over
 * an in-memory store and a hand-driven clock.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import type { Container } from './container.js';
import { registerAuth, registerErrorHandler } from './http/plugins.js';
import { registerAuthRoutes } from './http/routes/auth.js';
import { registerRideRoutes } from './http/routes/rides.js';
import { registerDriverRoutes } from './http/routes/drivers.js';
import { registerRiderRoutes } from './http/routes/riders.js';
import { registerPlaceRoutes } from './http/routes/places.js';
import { registerAdminRoutes } from './http/routes/admin.js';
import { registerRealtimeRoutes } from './http/routes/realtime.js';

export const buildServer = async (container: Container): Promise<FastifyInstance> => {
  const app = Fastify({
    logger: container.server.logLevel === 'silent' ? false : { level: container.server.logLevel },
    // Trust the proxy so rate limiting sees the real client address.
    trustProxy: true,
    bodyLimit: 1_048_576,
  });

  await app.register(cors, {
    origin: container.server.corsOrigins,
    credentials: true,
  });
  await app.register(websocket, {
    options: { maxPayload: 65_536 },
  });

  registerErrorHandler(app, container);
  registerAuth(app, container);

  /** Liveness and a quick look at what this process is running. */
  app.get('/health', async () => ({
    ok: true,
    at: container.clock.now(),
    brand: container.config.brandName,
    market: container.config.market.name,
    store: container.server.store,
    geoProvider: container.geo.id,
    surgeProvider: container.surge.id,
    dispatchStrategy: container.config.dispatch.strategy,
    activeSearches: container.dispatch.activeSearches(),
    realtimeConnections: container.hub.connectionCount(),
  }));

  /**
   * The client bootstrap: everything an app needs before its first screen —
   * branding, the map centre, ride types, feature flags, and tuning values the
   * UI mirrors (countdown lengths, ping intervals).
   */
  app.get('/config', async () => ({
    brandName: container.config.brandName,
    market: container.config.market,
    features: container.config.features,
    rideTypes: container.catalog.list().map((type) => ({
      id: type.id,
      name: type.name,
      tagline: type.tagline,
      description: type.description,
      icon: type.icon,
      maxPassengers: type.maxPassengers,
      badge: type.badge,
      shared: type.shared,
      displayOrder: type.displayOrder,
    })),
    realtime: container.config.realtime,
    dispatch: {
      offerTimeoutMs: container.config.dispatch.offerTimeoutMs,
      searchTimeoutMs: container.config.dispatch.searchTimeoutMs,
    },
    map: container.geo.tiles?.() ?? { kind: 'none', attribution: '', maxZoom: 20 },
  }));

  await app.register(
    async (api) => {
      registerAuthRoutes(api, container);
      registerRideRoutes(api, container);
      registerDriverRoutes(api, container);
      registerRiderRoutes(api, container);
      registerPlaceRoutes(api, container);
      registerAdminRoutes(api, container);
      registerRealtimeRoutes(api, container);
    },
    { prefix: '/v1' },
  );

  return app;
};
