/**
 * Support: the help centre and the ticket queue.
 *
 * Both catalogs — help topics and ticket categories — are injected rather than
 * imported, so an operator swaps in their own copy through the container
 * without touching this file. The service's job is authorisation, ownership,
 * and turning a domain transition into a persisted ticket and an event.
 */

import {
  AppError,
  applyTicketAction,
  categoriesFor,
  findCategory,
  openTicket,
  resolveTopics,
  type Clock,
  type HelpCenter,
  type HelpTopic,
  type PlatformEvents,
  type DriverId,
  type RideId,
  type RiderId,
  type SupportTicket,
  type TicketAction,
  type TicketCatalog,
  type TicketCategory,
  type TicketId,
  type TicketStatus,
  type TypedEmitter,
  type UserId,
} from '@lift/core';
import type { RideRepository, SupportRepository } from '../repositories/types.js';

export interface SupportServiceDeps {
  readonly support: SupportRepository;
  readonly rides: RideRepository;
  readonly helpCenter: HelpCenter;
  readonly ticketCatalog: TicketCatalog;
  readonly clock: Clock;
  readonly events: TypedEmitter<PlatformEvents>;
}

/** How the requester is identified on a ride — one of these, matching their role. */
export interface RideParty {
  readonly riderId?: RiderId;
  readonly driverId?: DriverId;
}

export interface OpenTicketRequest {
  readonly requesterId: UserId;
  readonly requesterRole: 'rider' | 'driver';
  readonly categoryId: string;
  readonly subject?: string;
  readonly body: string;
  readonly rideId?: RideId;
  /** Required when `rideId` is given: proves the requester was on that trip. */
  readonly party?: RideParty;
}

export class SupportService {
  constructor(private readonly deps: SupportServiceDeps) {}

  /** The help centre, narrowed to who is asking and what they are asking about. */
  async help(input: {
    audience: 'rider' | 'driver';
    rideId?: RideId;
  }): Promise<{ topics: HelpTopic[]; categories: TicketCategory[] }> {
    const ride = input.rideId ? await this.deps.rides.findById(input.rideId) : undefined;
    return {
      topics: resolveTopics(this.deps.helpCenter, {
        audience: input.audience,
        ...(ride ? { rideStatus: ride.status } : {}),
      }),
      categories: categoriesFor(this.deps.ticketCatalog, input.audience),
    };
  }

  async open(request: OpenTicketRequest): Promise<SupportTicket> {
    const category = findCategory(this.deps.ticketCatalog, request.categoryId);
    if (!category) {
      throw new AppError('validation_failed', `Unknown support category ${request.categoryId}`, {
        userMessage: 'Pick what your request is about.',
      });
    }
    if (category.audience !== 'both' && category.audience !== request.requesterRole) {
      throw new AppError('forbidden', 'That category is not open to this role');
    }

    // A ticket that names a ride must name one this person was actually on,
    // otherwise a ride id is a way to read someone else's trip back to them.
    if (request.rideId) await this.requireOwnRide(request.rideId, request.party ?? {});

    const result = openTicket({
      requesterId: request.requesterId,
      requesterRole: request.requesterRole,
      category,
      subject: request.subject ?? '',
      body: request.body,
      ...(request.rideId ? { rideId: request.rideId } : {}),
      now: this.deps.clock.now(),
    });
    if (!result.ok) {
      throw new AppError('validation_failed', result.error, { userMessage: result.error });
    }

    const ticket = await this.deps.support.create(result.value);
    this.deps.events.emit('support.ticket.opened', {
      ticketId: ticket.id,
      requesterId: ticket.requesterId,
      category: ticket.category,
      priority: ticket.priority,
      ...(ticket.rideId ? { rideId: ticket.rideId } : {}),
      at: ticket.createdAt,
    });
    return ticket;
  }

  async listForRequester(requesterId: UserId, limit = 50): Promise<SupportTicket[]> {
    return this.deps.support.query({ requesterId, limit });
  }

  async get(ticketId: TicketId, requesterId: UserId): Promise<SupportTicket> {
    const ticket = await this.deps.support.findById(ticketId);
    if (!ticket || ticket.requesterId !== requesterId) {
      // Same response either way: whether a ticket exists is not something a
      // stranger should be able to probe.
      throw new AppError('not_found', `Ticket ${ticketId} not found`);
    }
    return ticket;
  }

  /** Mark every support reply as read, for the unread badge. */
  async markRead(ticketId: TicketId, requesterId: UserId): Promise<SupportTicket> {
    const ticket = await this.get(ticketId, requesterId);
    const updated = { ...ticket, requesterReadAt: this.deps.clock.now() };
    const saved = await this.deps.support.save(updated, ticket.updatedAt);
    return saved ?? ticket;
  }

  async act(input: {
    ticketId: TicketId;
    action: TicketAction;
    by: 'requester' | 'support';
    actorId: UserId;
    text?: string;
  }): Promise<SupportTicket> {
    const ticket =
      input.by === 'requester'
        ? await this.get(input.ticketId, input.actorId)
        : await this.requireTicket(input.ticketId);

    const result = applyTicketAction(ticket, {
      action: input.action,
      by: input.by,
      authorId: input.actorId,
      ...(input.text ? { text: input.text } : {}),
      now: this.deps.clock.now(),
    });
    if (!result.ok) {
      throw new AppError('conflict', result.error, { userMessage: result.error });
    }

    const saved = await this.deps.support.save(result.value, ticket.updatedAt);
    if (!saved) {
      throw new AppError('conflict', 'This conversation moved on while you were writing', {
        userMessage: 'Someone replied while you were writing. Open it again.',
      });
    }

    this.deps.events.emit('support.ticket.updated', {
      ticketId: saved.id,
      requesterId: saved.requesterId,
      status: saved.status,
      by: input.by,
      action: input.action,
      at: saved.updatedAt,
    });
    return saved;
  }

  // ------------------------------------------------------------------ ops

  async queue(input: { statuses?: readonly TicketStatus[]; limit?: number }): Promise<SupportTicket[]> {
    return this.deps.support.query({
      ...(input.statuses ? { statuses: input.statuses } : {}),
      limit: input.limit ?? 100,
    });
  }

  async counts(): Promise<Record<string, number>> {
    return this.deps.support.countByStatus();
  }

  // -------------------------------------------------------------- helpers

  private async requireTicket(ticketId: TicketId): Promise<SupportTicket> {
    const ticket = await this.deps.support.findById(ticketId);
    if (!ticket) throw new AppError('not_found', `Ticket ${ticketId} not found`);
    return ticket;
  }

  private async requireOwnRide(rideId: RideId, party: RideParty): Promise<void> {
    const ride = await this.deps.rides.findById(rideId);
    if (!ride) throw new AppError('not_found', `Ride ${rideId} not found`);
    // Both sides must be defined before comparing: `undefined === undefined`
    // would otherwise let anyone attach any ride to their ticket.
    const isRider = party.riderId !== undefined && ride.riderId === party.riderId;
    const isDriver =
      party.driverId !== undefined &&
      ride.assignment !== undefined &&
      ride.assignment.driverId === party.driverId;
    if (!isRider && !isDriver) {
      throw new AppError('forbidden', 'That trip is not yours');
    }
  }
}
