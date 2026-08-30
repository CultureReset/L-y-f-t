/**
 * Rider account routes: profile, saved places, and payment methods.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  paymentMethodLabel,
  paymentMethodSchema,
  placeSchema,
  type PaymentMethodId,
  type Place,
  type PlaceId,
} from '@lift/core';
import type { Container } from '../../container.js';
import { parse, requireRider } from '../plugins.js';

export const registerRiderRoutes = (app: FastifyInstance, container: Container): void => {
  app.get('/rider/profile', async (request) => {
    const riderId = requireRider(request);
    return { rider: await container.riders.getProfile(riderId) };
  });

  app.patch('/rider/preferences', async (request) => {
    const riderId = requireRider(request);
    const patch = parse(
      z.object({
        defaultRideTypeId: z.string().optional(),
        accessibility: z
          .object({
            wheelchairAccessible: z.boolean(),
            serviceAnimal: z.boolean(),
            extraPickupTime: z.boolean(),
          })
          .partial()
          .optional(),
        communication: z
          .object({
            quietRide: z.boolean(),
            temperature: z.enum(['cool', 'warm', 'no_preference']),
          })
          .partial()
          .optional(),
        notifications: z
          .object({ push: z.boolean(), sms: z.boolean(), email: z.boolean() })
          .partial()
          .optional(),
      }),
      request.body,
    );
    return {
      rider: await container.riders.updatePreferences(riderId, patch as never),
    };
  });

  // ---------------------------------------------------------- saved places

  app.get('/rider/places', async (request) => {
    const riderId = requireRider(request);
    const profile = await container.riders.getProfile(riderId);
    return { places: profile.savedPlaces };
  });

  app.post('/rider/places', async (request) => {
    const riderId = requireRider(request);
    const body = parse(
      z.object({
        label: z.string().min(1).max(40),
        icon: z.enum(['home', 'work', 'star', 'pin']).optional(),
        place: placeSchema,
      }),
      request.body,
    );
    const rider = await container.riders.savePlace(riderId, {
      label: body.label,
      place: body.place as Place,
      ...(body.icon ? { icon: body.icon } : {}),
    });
    return { places: rider.savedPlaces };
  });

  app.delete('/rider/places/:placeId', async (request) => {
    const riderId = requireRider(request);
    const { placeId } = parse(z.object({ placeId: z.string() }), request.params);
    const rider = await container.riders.removeSavedPlace(riderId, placeId as PlaceId);
    return { places: rider.savedPlaces };
  });

  // -------------------------------------------------------- payment methods

  app.get('/rider/payment-methods', async (request) => {
    const riderId = requireRider(request);
    const methods = await container.riders.listPaymentMethods(riderId);
    return { methods: methods.map(present) };
  });

  app.post('/rider/payment-methods', async (request) => {
    const riderId = requireRider(request);
    const input = parse(paymentMethodSchema, request.body);
    const method = await container.riders.addPaymentMethod(riderId, input);
    return { method: present(method) };
  });

  app.post('/rider/payment-methods/:methodId/default', async (request) => {
    const riderId = requireRider(request);
    const { methodId } = parse(z.object({ methodId: z.string() }), request.params);
    const methods = await container.riders.setDefaultPaymentMethod(
      riderId,
      methodId as PaymentMethodId,
    );
    return { methods: methods.map(present) };
  });

  app.delete('/rider/payment-methods/:methodId', async (request) => {
    const riderId = requireRider(request);
    const { methodId } = parse(z.object({ methodId: z.string() }), request.params);
    const methods = await container.riders.removePaymentMethod(
      riderId,
      methodId as PaymentMethodId,
    );
    return { methods: methods.map(present) };
  });

  /** A rider's charge history — the wallet screen. */
  app.get('/rider/charges', async (request) => {
    const riderId = requireRider(request);
    const { limit } = parse(
      z.object({ limit: z.coerce.number().int().min(1).max(100).default(25) }),
      request.query,
    );
    const charges = await container.repositories.charges.listForRider(riderId, limit);
    return { charges };
  });
};

/** Never return a gateway token to a client. */
const present = (method: {
  id: string;
  kind: string;
  brand: string;
  last4?: string;
  isDefault: boolean;
  expiryMonth?: number;
  expiryYear?: number;
  label?: string;
  createdAt: number;
  gatewayToken?: string;
}) => {
  const { gatewayToken: _omitted, ...safe } = method;
  return { ...safe, displayLabel: paymentMethodLabel(method as never) };
};
