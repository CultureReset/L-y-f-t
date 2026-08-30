/**
 * Expo push notifications.
 *
 * Implements the `PushTransport` port against Expo's push service, which fronts
 * both APNs and FCM — so one adapter covers iOS and Android and neither app
 * needs a platform-specific credential in the backend.
 *
 * Two things this has to get right that a naive implementation misses:
 *
 * 1. **Device tokens have to come from somewhere.** The port deals in rider and
 *    driver ids; Expo deals in device tokens. A `TokenStore` bridges the two,
 *    and a person with several devices gets the message on all of them.
 *
 * 2. **Dead tokens have to be pruned.** An uninstalled app returns
 *    `DeviceNotRegistered` forever otherwise, and a stale token list quietly
 *    becomes most of a push bill.
 */

import type { DriverId, RiderId } from '@lift/core';
import type { PushMessage, PushTransport } from '../services/notificationService.js';

const EXPO_PUSH_API = 'https://exp.host/--/api/v2/push/send';

/** Where device tokens live. Back it with whichever store you already have. */
export interface PushTokenStore {
  tokensFor(recipient: { kind: 'rider' | 'driver'; id: RiderId | DriverId }): Promise<string[]>;
  /** Called when a token is rejected as no longer registered. */
  remove(token: string): Promise<void>;
}

/** An in-memory store, so the push path is exercisable without a database. */
export const createMemoryTokenStore = (): PushTokenStore & {
  register(recipient: { kind: 'rider' | 'driver'; id: string }, token: string): void;
  size(): number;
} => {
  const byRecipient = new Map<string, Set<string>>();
  const key = (kind: string, id: string): string => `${kind}:${id}`;

  return {
    register(recipient, token) {
      const k = key(recipient.kind, recipient.id);
      const tokens = byRecipient.get(k) ?? new Set();
      tokens.add(token);
      byRecipient.set(k, tokens);
    },
    async tokensFor(recipient) {
      return [...(byRecipient.get(key(recipient.kind, recipient.id)) ?? [])];
    },
    async remove(token) {
      for (const tokens of byRecipient.values()) tokens.delete(token);
    },
    size() {
      let total = 0;
      for (const tokens of byRecipient.values()) total += tokens.size;
      return total;
    },
  };
};

export interface ExpoPushOptions {
  readonly tokens: PushTokenStore;
  /** Required only for projects with push security enabled. */
  readonly accessToken?: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  readonly logger?: { error: (o: unknown, m?: string) => void; info?: (o: unknown, m?: string) => void };
}

interface ExpoTicket {
  readonly status: 'ok' | 'error';
  readonly id?: string;
  readonly message?: string;
  readonly details?: { error?: string };
}

export const createExpoPushTransport = (options: ExpoPushOptions): PushTransport => {
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = options.timeoutMs ?? 10_000;

  return {
    id: 'expo',

    async send(message: PushMessage): Promise<void> {
      const tokens = await options.tokens.tokensFor(message.to);
      // No device registered yet is normal, not an error.
      if (tokens.length === 0) return;

      const payload = tokens.map((token) => ({
        to: token,
        title: message.title,
        body: message.body,
        // An offer countdown is worthless if it arrives late, so urgent
        // messages bypass the device's batching and quiet hours.
        priority: message.urgent ? 'high' : 'normal',
        sound: message.urgent ? 'default' : null,
        channelId: message.urgent ? 'urgent' : 'default',
        data: { route: message.route, ...message.data },
        // Expo drops a message the service could not deliver in this window
        // rather than delivering a stale one.
        ttl: message.urgent ? 60 : 900,
      }));

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await doFetch(EXPO_PUSH_API, {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'content-type': 'application/json',
            accept: 'application/json',
            ...(options.accessToken
              ? { authorization: `Bearer ${options.accessToken}` }
              : {}),
          },
          body: JSON.stringify(payload),
        });

        if (!response.ok) {
          throw new Error(`Expo push returned HTTP ${response.status}`);
        }

        const body = (await response.json()) as { data?: ExpoTicket[] };
        // Prune tokens the service says are gone; otherwise they are retried
        // on every notification forever.
        await Promise.all(
          (body.data ?? []).map(async (ticket, index) => {
            if (ticket.status !== 'error') return;
            const token = tokens[index];
            if (ticket.details?.error === 'DeviceNotRegistered' && token) {
              await options.tokens.remove(token);
              return;
            }
            options.logger?.error(
              { error: ticket.details?.error, message: ticket.message },
              'push ticket rejected',
            );
          }),
        );
      } finally {
        clearTimeout(timer);
      }
    },
  };
};
