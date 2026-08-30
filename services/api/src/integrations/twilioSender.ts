/**
 * Twilio SMS sender.
 *
 * Implements the `CodeSender` port so verification codes reach a real phone.
 * The console sender remains the default outside production — this only takes
 * over when `SMS_PROVIDER=twilio` and credentials are present.
 *
 * Written against the REST API with `fetch` rather than the Twilio SDK: it is
 * one endpoint, and the adapter is more useful as a readable example than as a
 * dependency.
 */

import type { CodeSender } from '../services/authService.js';

const TWILIO_API = 'https://api.twilio.com/2010-04-01';

export interface TwilioSenderOptions {
  readonly accountSid: string;
  readonly authToken: string;
  /** The sending number, or a Messaging Service SID starting `MG`. */
  readonly from: string;
  /** Overrides the default message text. `{code}` is substituted. */
  readonly template?: string;
  readonly brandName?: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  readonly logger?: { error: (o: unknown, m?: string) => void };
}

/**
 * A verification code is the one message a rider is actively waiting for, so
 * the copy matters: name the brand, state the purpose, and warn against
 * sharing it — the standard shape SMS filters and users both expect.
 */
const DEFAULT_TEMPLATE = '{code} is your {brand} verification code. Never share it.';

export const createTwilioSender = (options: TwilioSenderOptions): CodeSender => {
  if (!options.accountSid || !options.authToken || !options.from) {
    throw new Error('createTwilioSender requires accountSid, authToken, and from');
  }
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = options.timeoutMs ?? 10_000;
  const template = options.template ?? DEFAULT_TEMPLATE;
  const brand = options.brandName ?? 'your ride';

  return {
    id: 'twilio',

    async send(phone: string, code: string): Promise<void> {
      const body = new URLSearchParams({
        To: phone,
        Body: template.replace('{code}', code).replace('{brand}', brand),
        // A Messaging Service SID goes in a different field from a plain number.
        ...(options.from.startsWith('MG')
          ? { MessagingServiceSid: options.from }
          : { From: options.from }),
      });

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await doFetch(
          `${TWILIO_API}/Accounts/${options.accountSid}/Messages.json`,
          {
            method: 'POST',
            signal: controller.signal,
            headers: {
              authorization: `Basic ${base64(`${options.accountSid}:${options.authToken}`)}`,
              'content-type': 'application/x-www-form-urlencoded',
            },
            body: body.toString(),
          },
        );

        if (!response.ok) {
          const detail = (await response.json().catch(() => ({}))) as {
            message?: string;
            code?: number;
          };
          throw new Error(
            `Twilio rejected the message (${detail.code ?? response.status}): ${
              detail.message ?? 'unknown error'
            }`,
          );
        }
      } finally {
        clearTimeout(timer);
      }
    },
  };
};

const base64 = (value: string): string => Buffer.from(value, 'utf8').toString('base64');
