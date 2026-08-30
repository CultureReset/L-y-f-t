/**
 * The platform event catalog.
 *
 * Everything meaningful that happens is published here. The realtime hub, push
 * notifications, the ops console, and analytics all subscribe rather than
 * being called directly, so adding a new reaction to "ride completed" never
 * means editing the ride service.
 */

import type { DriverId, OfferId, RideId, RiderId, TicketId, UserId } from '../util/ids.js';
import type { Position } from '../util/geo.js';
import type { Ride, RideStatus, Cancellation } from './ride.js';
import type { RideOffer } from '../matching/types.js';
import type { FareBreakdown } from '../pricing/types.js';
import type { Charge } from './payment.js';
import type { DriverAvailability } from './driver.js';
import type { TicketAction, TicketPriority, TicketStatus } from '../support/tickets.js';

export type PlatformEvents = {
  'ride.created': { ride: Ride };
  'ride.requested': { ride: Ride };
  'ride.status_changed': {
    ride: Ride;
    from: RideStatus;
    to: RideStatus;
  };
  'ride.matched': { ride: Ride; driverId: DriverId };
  'ride.driver_arrived': { ride: Ride };
  'ride.started': { ride: Ride };
  'ride.completed': { ride: Ride; fare: FareBreakdown };
  'ride.cancelled': { ride: Ride; cancellation: Cancellation };
  'ride.expired': { ride: Ride };
  'ride.route_updated': { rideId: RideId; ride: Ride };
  'ride.rated': { rideId: RideId; by: 'rider' | 'driver'; stars: number };

  'offer.sent': { offer: RideOffer };
  'offer.accepted': { offer: RideOffer; rideId: RideId };
  'offer.declined': { offerId: OfferId; driverId: DriverId; rideId: RideId };
  'offer.expired': { offerId: OfferId; driverId: DriverId; rideId: RideId };

  'driver.location_updated': { driverId: DriverId; position: Position; rideId?: RideId };
  'driver.availability_changed': {
    driverId: DriverId;
    from: DriverAvailability;
    to: DriverAvailability;
  };
  'driver.online': { driverId: DriverId; at: number };
  'driver.offline': { driverId: DriverId; at: number; shiftMillis: number };

  'payment.authorized': { charge: Charge };
  'payment.captured': { charge: Charge };
  'payment.failed': { charge: Charge; reason: string };
  'payment.refunded': { charge: Charge };

  'chat.message': {
    rideId: RideId;
    from: 'rider' | 'driver';
    riderId: RiderId;
    driverId: DriverId;
    text: string;
    at: number;
  };

  'safety.alert': {
    rideId: RideId;
    raisedBy: 'rider' | 'driver';
    kind: 'sos' | 'route_deviation' | 'long_stop';
    at: number;
  };

  'support.ticket.opened': {
    ticketId: TicketId;
    requesterId: UserId;
    category: string;
    priority: TicketPriority;
    rideId?: RideId;
    at: number;
  };
  'support.ticket.updated': {
    ticketId: TicketId;
    requesterId: UserId;
    status: TicketStatus;
    by: 'requester' | 'support';
    action: TicketAction;
    at: number;
  };

  'rider.registered': { riderId: RiderId };
  'driver.registered': { driverId: DriverId };
};

export type PlatformEventName = keyof PlatformEvents;

/** Envelope used when an event crosses a process boundary. */
export interface EventEnvelope<K extends PlatformEventName = PlatformEventName> {
  readonly id: string;
  readonly name: K;
  readonly payload: PlatformEvents[K];
  readonly at: number;
  /** Correlates every event produced while handling one request. */
  readonly correlationId?: string;
}
