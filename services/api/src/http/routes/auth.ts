/**
 * Authentication routes: request a code, verify it, inspect or end a session.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { publicName, type UserRole } from '@lift/core';
import type { Container } from '../../container.js';
import { parse, rateLimit, requireActor } from '../plugins.js';

const requestCodeSchema = z.object({
  phone: z.string().min(5).max(24),
});

const verifySchema = z.object({
  phone: z.string().min(5).max(24),
  code: z.string().min(4).max(8),
  role: z.enum(['rider', 'driver']).default('rider'),
  firstName: z.string().min(1).max(60).optional(),
  lastName: z.string().max(60).optional(),
  email: z.string().email().optional(),
});

export const registerAuthRoutes = (app: FastifyInstance, container: Container): void => {
  /** Send a one-time code. Rate limited — this endpoint sends real SMS. */
  app.post(
    '/auth/code',
    { preHandler: rateLimit({ windowMs: 60_000, max: 5 }) },
    async (request) => {
      const { phone } = parse(requestCodeSchema, request.body);
      return container.auth.requestCode(phone);
    },
  );

  /** Verify a code and receive a session token. */
  app.post(
    '/auth/verify',
    { preHandler: rateLimit({ windowMs: 60_000, max: 10 }) },
    async (request) => {
      const input = parse(verifySchema, request.body);
      const result = await container.auth.verifyCode(input);
      return {
        token: result.token,
        expiresAt: result.expiresAt,
        isNewUser: result.isNewUser,
        role: result.role,
        user: presentUser(result.user),
        riderId: result.riderProfile?.id,
        driverId: result.driverProfile?.id,
      };
    },
  );

  /** Who am I? The call both apps make on launch to restore a session. */
  app.get('/auth/me', async (request) => {
    const actor = requireActor(request);
    const user = await container.repositories.users.findById(actor.userId);
    if (!user) return { user: null };

    const [rider, driver] = await Promise.all([
      actor.riderId ? container.repositories.riders.findById(actor.riderId) : undefined,
      actor.driverId ? container.repositories.drivers.findById(actor.driverId) : undefined,
    ]);

    return {
      user: presentUser(user),
      role: actor.role,
      rider: rider ?? null,
      driver: driver ?? null,
    };
  });

  /** Switch between riding and driving on the same account. */
  app.post('/auth/role', async (request) => {
    const actor = requireActor(request);
    const { role } = parse(z.object({ role: z.enum(['rider', 'driver']) }), request.body);
    const result = await container.auth.switchRole(actor.token, role as UserRole);
    return {
      token: result.token,
      expiresAt: result.expiresAt,
      role: result.role,
      user: presentUser(result.user),
      riderId: result.riderProfile?.id,
      driverId: result.driverProfile?.id,
    };
  });

  app.post('/auth/signout', async (request) => {
    const actor = requireActor(request);
    await container.auth.signOut(actor.token);
    return { ok: true };
  });

  app.post('/auth/signout-all', async (request) => {
    const actor = requireActor(request);
    await container.auth.signOutEverywhere(actor.userId);
    return { ok: true };
  });

  /** Update the signed-in user's own details. */
  app.patch('/auth/profile', async (request) => {
    const actor = requireActor(request);
    const patch = parse(
      z.object({
        firstName: z.string().min(1).max(60).optional(),
        lastName: z.string().max(60).optional(),
        email: z.string().email().optional(),
        avatarUrl: z.string().url().optional(),
        locale: z.string().max(10).optional(),
      }),
      request.body,
    );
    const user = await container.repositories.users.update(actor.userId, patch);
    return { user: presentUser(user) };
  });
};

const presentUser = (user: {
  id: string;
  phone: string;
  email?: string;
  firstName: string;
  lastName: string;
  avatarUrl?: string;
  roles: readonly string[];
  locale: string;
  currency: string;
  createdAt: number;
}) => ({
  ...user,
  displayName: `${user.firstName} ${user.lastName}`.trim(),
  publicName: publicName(user),
});
