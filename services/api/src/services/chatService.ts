/**
 * In-ride messaging between rider and driver.
 *
 * Chat is only open while a ride is live: before a driver is assigned there is
 * nobody to talk to, and after the trip ends the channel closes so a completed
 * ride cannot be used to keep contacting someone.
 */

import {
  AppError,
  ACTIVE_RIDE_STATUSES,
  newMessageId,
  type Clock,
  type PlatformEvents,
  type Ride,
  type RideId,
  type TypedEmitter,
} from '@lift/core';
import type { ChatMessage, ChatRepository, RideRepository } from '../repositories/types.js';

export interface ChatServiceDeps {
  readonly chat: ChatRepository;
  readonly rides: RideRepository;
  readonly clock: Clock;
  readonly events: TypedEmitter<PlatformEvents>;
}

export class ChatService {
  constructor(private readonly deps: ChatServiceDeps) {}

  async send(input: {
    rideId: RideId;
    from: 'rider' | 'driver';
    text: string;
  }): Promise<ChatMessage> {
    const ride = await this.requireOpenRide(input.rideId);
    const text = input.text.trim();
    if (text.length === 0) throw new AppError('validation_failed', 'Message cannot be empty');
    if (text.length > 500) throw new AppError('validation_failed', 'Message is too long');
    if (!ride.assignment) {
      throw new AppError('conflict', 'Chat opens once a driver is assigned', {
        userMessage: "You can message once you're matched with a driver.",
      });
    }

    const now = this.deps.clock.now();
    const message = await this.deps.chat.append({
      id: newMessageId(),
      rideId: input.rideId,
      from: input.from,
      text,
      sentAt: now,
    });

    this.deps.events.emit('chat.message', {
      rideId: input.rideId,
      from: input.from,
      riderId: ride.riderId,
      driverId: ride.assignment.driverId,
      text,
      at: now,
    });
    return message;
  }

  async history(rideId: RideId): Promise<ChatMessage[]> {
    return this.deps.chat.listForRide(rideId);
  }

  async markRead(rideId: RideId, reader: 'rider' | 'driver'): Promise<void> {
    await this.deps.chat.markRead(rideId, reader, this.deps.clock.now());
  }

  /** Canned messages, so most exchanges need no typing while driving. */
  quickReplies(role: 'rider' | 'driver'): string[] {
    return role === 'driver'
      ? [
          "I'm on my way",
          "I'm outside",
          "I'm in the pickup area — where should I meet you?",
          'Running a couple of minutes late',
        ]
      : [
          "I'm coming out now",
          'Give me two minutes',
          "I'm wearing a red jacket",
          'Can you pull up a little further?',
        ];
  }

  private async requireOpenRide(rideId: RideId): Promise<Ride> {
    const ride = await this.deps.rides.findById(rideId);
    if (!ride) throw new AppError('not_found', 'Ride not found');
    if (!ACTIVE_RIDE_STATUSES.includes(ride.status)) {
      throw new AppError('conflict', 'This ride has finished', {
        userMessage: 'This ride has ended, so messaging is closed.',
      });
    }
    return ride;
  }
}
