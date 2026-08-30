/**
 * Support routes: the help centre and the ticket thread.
 *
 * The help centre is a public read — an app should be able to show it before
 * anyone signs in — while everything about a ticket is scoped to the person
 * who opened it. Agent-side actions sit behind the admin guard.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError, type RideId, type TicketId } from '@lift/core';
import type { Container } from '../../container.js';
import { parse, rateLimit, requireActor, requireAdmin } from '../plugins.js';

export const registerSupportRoutes = (app: FastifyInstance, container: Container): void => {
  /**
   * The help centre. `audience` defaults to the caller's role when they are
   * signed in, so the apps do not have to say what they obviously are.
   */
  app.get('/support/help', async (request) => {
    const query = parse(
      z.object({
        audience: z.enum(['rider', 'driver']).optional(),
        rideId: z.string().optional(),
      }),
      request.query,
    );
    const audience =
      query.audience ?? (request.actor?.driverId ? 'driver' : 'rider');
    return container.support.help({
      audience,
      ...(query.rideId ? { rideId: query.rideId as RideId } : {}),
    });
  });

  app.get('/support/tickets', async (request) => {
    const actor = requireActor(request);
    return { tickets: await container.support.listForRequester(actor.userId) };
  });

  app.post(
    '/support/tickets',
    {
      // Opening tickets is cheap for a script and expensive for a queue.
      preHandler: rateLimit({
        windowMs: 60_000,
        max: 5,
        keyBy: (request) => request.actor?.userId ?? request.ip,
      }),
    },
    async (request, reply) => {
      const actor = requireActor(request);
      const body = parse(
        z.object({
          categoryId: z.string().min(1),
          subject: z.string().max(140).optional(),
          body: z.string().min(1).max(4000),
          rideId: z.string().optional(),
        }),
        request.body,
      );

      // A driver opening a driver-category ticket is acting as a driver even
      // though the same person may also be a rider.
      const requesterRole = actor.driverId && !actor.riderId ? 'driver' : actor.role === 'driver' ? 'driver' : 'rider';

      const ticket = await container.support.open({
        requesterId: actor.userId,
        requesterRole,
        categoryId: body.categoryId,
        ...(body.subject ? { subject: body.subject } : {}),
        body: body.body,
        ...(body.rideId ? { rideId: body.rideId as RideId } : {}),
        party: {
          ...(actor.riderId ? { riderId: actor.riderId } : {}),
          ...(actor.driverId ? { driverId: actor.driverId } : {}),
        },
      });
      return reply.code(201).send({ ticket });
    },
  );

  app.get('/support/tickets/:ticketId', async (request) => {
    const actor = requireActor(request);
    const { ticketId } = request.params as { ticketId: string };
    return { ticket: await container.support.get(ticketId as TicketId, actor.userId) };
  });

  app.post('/support/tickets/:ticketId/read', async (request) => {
    const actor = requireActor(request);
    const { ticketId } = request.params as { ticketId: string };
    return { ticket: await container.support.markRead(ticketId as TicketId, actor.userId) };
  });

  app.post('/support/tickets/:ticketId/messages', async (request) => {
    const actor = requireActor(request);
    const { ticketId } = request.params as { ticketId: string };
    const body = parse(z.object({ text: z.string().min(1).max(4000) }), request.body);
    return {
      ticket: await container.support.act({
        ticketId: ticketId as TicketId,
        action: 'requester_reply',
        by: 'requester',
        actorId: actor.userId,
        text: body.text,
      }),
    };
  });

  /** Close or reopen, from the requester's side. */
  app.post('/support/tickets/:ticketId/status', async (request) => {
    const actor = requireActor(request);
    const { ticketId } = request.params as { ticketId: string };
    const body = parse(z.object({ action: z.enum(['close', 'reopen']) }), request.body);
    return {
      ticket: await container.support.act({
        ticketId: ticketId as TicketId,
        action: body.action,
        by: 'requester',
        actorId: actor.userId,
      }),
    };
  });

  // ------------------------------------------------------------ agent side

  app.get('/admin/support/tickets', async (request) => {
    requireAdmin(request);
    const query = parse(
      z.object({
        status: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(100),
      }),
      request.query,
    );
    const statuses = query.status
      ? (query.status.split(',') as ('open' | 'awaiting_reply' | 'resolved' | 'closed')[])
      : undefined;
    return {
      tickets: await container.support.queue({
        ...(statuses ? { statuses } : {}),
        limit: query.limit,
      }),
      counts: await container.support.counts(),
    };
  });

  app.post('/admin/support/tickets/:ticketId/actions', async (request) => {
    const admin = requireAdmin(request);
    const { ticketId } = request.params as { ticketId: string };
    const body = parse(
      z.object({
        action: z.enum(['support_reply', 'resolve', 'reopen', 'close']),
        text: z.string().max(4000).optional(),
      }),
      request.body,
    );
    if (body.action === 'support_reply' && !body.text) {
      throw new AppError('validation_failed', 'A reply needs text');
    }
    return {
      ticket: await container.support.act({
        ticketId: ticketId as TicketId,
        action: body.action,
        by: 'support',
        actorId: admin.userId,
        ...(body.text ? { text: body.text } : {}),
      }),
    };
  });
};
