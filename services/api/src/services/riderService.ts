/**
 * Rider-facing operations: profile, saved places, payment methods, and the
 * place search that feeds the pickup/dropoff pickers.
 */

import {
  AppError,
  newPaymentMethodId,
  newPlaceId,
  type Clock,
  type PaymentMethod,
  type PaymentMethodId,
  type PaymentMethodInput,
  type Place,
  type PlaceId,
  type RiderPreferences,
  type RiderProfile,
  type RiderId,
  type SavedPlace,
  type UserId,
} from '@lift/core';
import type { GeoProvider, PlaceSearchSection, PlaceSourceRegistry } from '@lift/geo';
import type {
  PaymentMethodRepository,
  RiderRepository,
  UserRepository,
} from '../repositories/types.js';

export interface RiderServiceDeps {
  readonly riders: RiderRepository;
  readonly users: UserRepository;
  readonly paymentMethods: PaymentMethodRepository;
  readonly places: PlaceSourceRegistry;
  readonly geo: GeoProvider;
  readonly clock: Clock;
}

export class RiderService {
  constructor(private readonly deps: RiderServiceDeps) {}

  async getProfile(riderId: RiderId): Promise<RiderProfile> {
    const profile = await this.deps.riders.findById(riderId);
    if (!profile) throw new AppError('not_found', 'Rider not found');
    return profile;
  }

  async findByUserId(userId: UserId): Promise<RiderProfile | undefined> {
    return this.deps.riders.findByUserId(userId);
  }

  async updatePreferences(
    riderId: RiderId,
    patch: Partial<RiderPreferences>,
  ): Promise<RiderProfile> {
    const profile = await this.getProfile(riderId);
    return this.deps.riders.update(riderId, {
      preferences: { ...profile.preferences, ...patch },
    });
  }

  // --------------------------------------------------------- saved places

  async savePlace(
    riderId: RiderId,
    input: { label: string; icon?: SavedPlace['icon']; place: Place },
  ): Promise<RiderProfile> {
    const saved: SavedPlace = {
      id: newPlaceId(),
      label: input.label.trim(),
      icon: input.icon ?? iconForLabel(input.label),
      place: { ...input.place, source: 'saved' },
      createdAt: this.deps.clock.now(),
    };
    return this.deps.riders.addSavedPlace(riderId, saved);
  }

  async removeSavedPlace(riderId: RiderId, placeId: PlaceId): Promise<RiderProfile> {
    return this.deps.riders.removeSavedPlace(riderId, placeId);
  }

  // ---------------------------------------------------------- place search

  /**
   * The rider's search screen, assembled from every registered place source —
   * saved, recent, current location, venues, the geocoder, and any external
   * integration. Sections come back in priority order, ready to render.
   */
  async searchPlaces(input: {
    text: string;
    riderId?: RiderId;
    near?: { lat: number; lng: number };
    field?: 'pickup' | 'dropoff';
    limit?: number;
  }): Promise<PlaceSearchSection[]> {
    return this.deps.places.search({
      text: input.text,
      ...(input.riderId ? { riderId: input.riderId } : {}),
      ...(input.near ? { near: input.near } : {}),
      ...(input.field ? { field: input.field } : {}),
      ...(input.limit ? { limit: input.limit } : {}),
    });
  }

  /** Resolve a suggestion into the full place a ride can be booked against. */
  async resolvePlace(ref: string): Promise<Place> {
    if (!this.deps.geo.details) {
      throw new AppError('provider_unavailable', 'This provider cannot resolve place refs');
    }
    return this.deps.geo.details(ref);
  }

  async reverseGeocode(coordinates: { lat: number; lng: number }): Promise<Place> {
    if (!this.deps.geo.reverseGeocode) {
      throw new AppError('provider_unavailable', 'This provider cannot reverse geocode');
    }
    return this.deps.geo.reverseGeocode(coordinates);
  }

  // ------------------------------------------------------ payment methods

  async listPaymentMethods(riderId: RiderId): Promise<PaymentMethod[]> {
    return this.deps.paymentMethods.listForRider(riderId);
  }

  async addPaymentMethod(
    riderId: RiderId,
    input: PaymentMethodInput,
  ): Promise<PaymentMethod> {
    const existing = await this.deps.paymentMethods.listForRider(riderId);
    const method: PaymentMethod = {
      id: newPaymentMethodId(),
      riderId,
      kind: input.kind,
      brand: input.brand,
      // The first method a rider adds is their default, whatever they asked.
      isDefault: input.makeDefault || existing.length === 0,
      createdAt: this.deps.clock.now(),
      ...(input.last4 ? { last4: input.last4 } : {}),
      ...(input.expiryMonth ? { expiryMonth: input.expiryMonth } : {}),
      ...(input.expiryYear ? { expiryYear: input.expiryYear } : {}),
      ...(input.gatewayToken ? { gatewayToken: input.gatewayToken } : {}),
      ...(input.label ? { label: input.label } : {}),
    };
    const created = await this.deps.paymentMethods.create(method);
    const profile = await this.deps.riders.findById(riderId);
    if (profile && (created.isDefault || !profile.defaultPaymentMethodId)) {
      await this.deps.riders.update(riderId, { defaultPaymentMethodId: created.id });
    }
    return created;
  }

  async setDefaultPaymentMethod(
    riderId: RiderId,
    methodId: PaymentMethodId,
  ): Promise<PaymentMethod[]> {
    const method = await this.deps.paymentMethods.findById(methodId);
    if (!method || method.riderId !== riderId) {
      throw new AppError('not_found', 'Payment method not found');
    }
    await this.deps.paymentMethods.setDefault(riderId, methodId);
    await this.deps.riders.update(riderId, { defaultPaymentMethodId: methodId });
    return this.deps.paymentMethods.listForRider(riderId);
  }

  async removePaymentMethod(
    riderId: RiderId,
    methodId: PaymentMethodId,
  ): Promise<PaymentMethod[]> {
    const method = await this.deps.paymentMethods.findById(methodId);
    if (!method || method.riderId !== riderId) {
      throw new AppError('not_found', 'Payment method not found');
    }
    await this.deps.paymentMethods.update(methodId, {
      removedAt: this.deps.clock.now(),
      isDefault: false,
    });

    // Promote another method so the rider is never left without a default.
    const remaining = await this.deps.paymentMethods.listForRider(riderId);
    const next = remaining[0];
    if (next && method.isDefault) {
      await this.deps.paymentMethods.setDefault(riderId, next.id);
      await this.deps.riders.update(riderId, { defaultPaymentMethodId: next.id });
    } else if (!next) {
      await this.deps.riders.update(riderId, { defaultPaymentMethodId: undefined });
    }
    return this.deps.paymentMethods.listForRider(riderId);
  }
}

/** Infer a sensible icon so riders rarely have to pick one. */
const iconForLabel = (label: string): SavedPlace['icon'] => {
  const normalized = label.trim().toLowerCase();
  if (normalized === 'home') return 'home';
  if (normalized === 'work' || normalized === 'office') return 'work';
  return 'star';
};
