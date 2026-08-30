/**
 * Place search and resolution — what feeds the pickup and dropoff pickers.
 *
 * Results arrive as sections from every registered place source, so a client
 * renders whatever the deployment has configured without knowing the list.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Container } from '../../container.js';
import { parse } from '../plugins.js';

const searchSchema = z.object({
  q: z.string().max(200).default(''),
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional(),
  field: z.enum(['pickup', 'dropoff']).optional(),
  limit: z.coerce.number().int().min(1).max(20).default(6),
});

export const registerPlaceRoutes = (app: FastifyInstance, container: Container): void => {
  /** Sectioned search across saved, recent, venues, geocoder, and integrations. */
  app.get('/places/search', async (request) => {
    const query = parse(searchSchema, request.query);
    const sections = await container.riders.searchPlaces({
      text: query.q,
      limit: query.limit,
      ...(request.actor?.riderId ? { riderId: request.actor.riderId } : {}),
      ...(query.lat !== undefined && query.lng !== undefined
        ? { near: { lat: query.lat, lng: query.lng } }
        : {}),
      ...(query.field ? { field: query.field } : {}),
    });
    return { sections };
  });

  /** Turn a suggestion ref into a bookable place. */
  app.get('/places/resolve', async (request) => {
    const { ref } = parse(z.object({ ref: z.string().min(1) }), request.query);
    return { place: await container.riders.resolvePlace(ref) };
  });

  /** What is at these coordinates? Used for a dropped map pin. */
  app.get('/places/reverse', async (request) => {
    const coords = parse(
      z.object({
        lat: z.coerce.number().min(-90).max(90),
        lng: z.coerce.number().min(-180).max(180),
      }),
      request.query,
    );
    return { place: await container.riders.reverseGeocode(coords) };
  });

  /** Which place sources this deployment has configured. */
  app.get('/places/sources', async () => ({
    sources: container.places.list().map((s) => ({
      id: s.id,
      title: s.title,
      icon: s.icon,
      priority: s.priority,
      showWhenEmpty: s.showWhenEmpty,
    })),
  }));
};
