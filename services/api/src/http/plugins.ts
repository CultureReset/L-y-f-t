/**
 * Cross-cutting HTTP concerns: error shaping, authentication, and the typed
 * request context the route handlers read.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError, type ZodTypeAny, type output as ZodOutput } from 'zod';
import { AppError, toAppError, type DriverId, type RiderId, type UserId, type UserRole } from '@lift/core';
import type { Container } from '../container.js';

/** Who is making a request, resolved from the bearer token. */
export interface RequestActor {
  readonly userId: UserId;
  readonly role: UserRole;
  readonly token: string;
  readonly riderId?: RiderId;
  readonly driverId?: DriverId;
}

declare module 'fastify' {
  interface FastifyRequest {
    actor?: RequestActor;
  }
}

/**
 * Turn every thrown error into the platform's single error envelope. Unknown
 * errors are logged in full and reported as a generic 500 — an internal message
 * is never leaked to a client.
 */
export const registerErrorHandler = (app: FastifyInstance, container: Container): void => {
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      const appError = new AppError('validation_failed', 'Request failed validation', {
        details: {
          issues: error.issues.map((i) => ({
            path: i.path.join('.'),
            message: i.message,
          })),
        },
      });
      return reply.status(appError.status).send(appError.toJSON());
    }

    const appError = toAppError(error);
    if (appError.status >= 500) {
      container.logger.error(
        { err: error, url: request.url, method: request.method },
        'request failed',
      );
    }
    return reply.status(appError.status).send(appError.toJSON());
  });

  app.setNotFoundHandler((request, reply) => {
    const error = new AppError('not_found', `No route for ${request.method} ${request.url}`);
    return reply.status(404).send(error.toJSON());
  });
};

/**
 * Resolve the bearer token into an actor, including the rider and driver
 * profile ids so handlers never have to look them up.
 */
export const registerAuth = (app: FastifyInstance, container: Container): void => {
  app.decorateRequest('actor', undefined);

  app.addHook('onRequest', async (request) => {
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) return;
    const token = header.slice('Bearer '.length).trim();
    if (!token) return;

    try {
      const session = await container.auth.authenticate(token);
      const [rider, driver] = await Promise.all([
        container.repositories.riders.findByUserId(session.userId),
        container.repositories.drivers.findByUserId(session.userId),
      ]);
      request.actor = {
        userId: session.userId,
        role: session.role,
        token,
        ...(rider ? { riderId: rider.id } : {}),
        ...(driver ? { driverId: driver.id } : {}),
      };
    } catch {
      // An invalid token is simply an anonymous request; the guards below
      // produce the 401 where one is actually required.
    }
  });
};

/** Require any authenticated user. */
export const requireActor = (request: FastifyRequest): RequestActor => {
  if (!request.actor) throw new AppError('unauthorized', 'Authentication required');
  return request.actor;
};

/** Require a signed-in rider, and return their rider id. */
export const requireRider = (request: FastifyRequest): RiderId => {
  const actor = requireActor(request);
  if (!actor.riderId) {
    throw new AppError('forbidden', 'This endpoint requires a rider profile');
  }
  return actor.riderId;
};

/** Require a signed-in driver, and return their driver id. */
export const requireDriver = (request: FastifyRequest): DriverId => {
  const actor = requireActor(request);
  if (!actor.driverId) {
    throw new AppError('forbidden', 'This endpoint requires a driver profile');
  }
  return actor.driverId;
};

export const requireAdmin = (request: FastifyRequest): RequestActor => {
  const actor = requireActor(request);
  if (actor.role !== 'admin') throw new AppError('forbidden', 'Admin access required');
  return actor;
};

/**
 * Parse a body or query against a schema, surfacing a typed validation error.
 * Returns the schema's output type, so fields carrying `.default()` arrive
 * required rather than optional.
 */
export const parse = <S extends ZodTypeAny>(schema: S, value: unknown): ZodOutput<S> => {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new AppError('validation_failed', 'Request failed validation', {
      details: {
        issues: result.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      },
    });
  }
  return result.data;
};

/**
 * A crude fixed-window rate limiter, applied to the endpoints that would
 * otherwise be abusable — sending SMS codes above all. A real deployment
 * should put this in shared storage rather than process memory.
 */
export const rateLimit = (options: { windowMs: number; max: number }) => {
  const hits = new Map<string, { count: number; resetAt: number }>();

  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    const key = `${request.routeOptions?.url ?? request.url}:${request.ip}`;
    const now = Date.now();
    const entry = hits.get(key);

    if (!entry || entry.resetAt <= now) {
      hits.set(key, { count: 1, resetAt: now + options.windowMs });
      return;
    }
    entry.count += 1;
    if (entry.count > options.max) {
      throw new AppError('rate_limited', 'Too many requests', {
        details: { retryAfterMs: entry.resetAt - now },
      });
    }
  };
};
