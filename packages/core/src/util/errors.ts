/**
 * A single error taxonomy shared by the domain, the API, and both apps. Every
 * failure carries a stable machine-readable `code` so the UI can react without
 * string-matching human-readable text, and an HTTP status so the transport
 * layer never has to guess.
 */

export type ErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'validation_failed'
  | 'conflict'
  | 'invalid_transition'
  | 'no_drivers_available'
  | 'offer_expired'
  | 'offer_already_resolved'
  | 'ride_not_cancellable'
  | 'driver_unavailable'
  | 'driver_already_on_ride'
  | 'payment_declined'
  | 'payment_method_required'
  | 'quote_expired'
  | 'rate_limited'
  | 'provider_unavailable'
  | 'not_implemented'
  | 'internal_error';

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  validation_failed: 422,
  conflict: 409,
  invalid_transition: 409,
  no_drivers_available: 409,
  offer_expired: 410,
  offer_already_resolved: 409,
  ride_not_cancellable: 409,
  driver_unavailable: 409,
  driver_already_on_ride: 409,
  payment_declined: 402,
  payment_method_required: 402,
  quote_expired: 410,
  rate_limited: 429,
  provider_unavailable: 503,
  not_implemented: 501,
  internal_error: 500,
};

export interface AppErrorOptions {
  /** Structured context for logs; never rendered to an end user verbatim. */
  readonly details?: Record<string, unknown>;
  /** A message safe to show in the app UI. */
  readonly userMessage?: string;
  readonly cause?: unknown;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: Record<string, unknown>;
  readonly userMessage: string;

  constructor(code: ErrorCode, message: string, options: AppErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'AppError';
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.details = options.details ?? {};
    this.userMessage = options.userMessage ?? DEFAULT_USER_MESSAGES[code];
  }

  toJSON(): {
    error: { code: ErrorCode; message: string; userMessage: string; details: Record<string, unknown> };
  } {
    return {
      error: {
        code: this.code,
        message: this.message,
        userMessage: this.userMessage,
        details: this.details,
      },
    };
  }
}

const DEFAULT_USER_MESSAGES: Record<ErrorCode, string> = {
  unauthorized: 'Please sign in to continue.',
  forbidden: "You don't have access to this.",
  not_found: "We couldn't find that.",
  validation_failed: 'Some of that information looks wrong.',
  conflict: 'That conflicts with something that already happened.',
  invalid_transition: "This ride can't do that right now.",
  no_drivers_available: 'No drivers are available nearby right now.',
  offer_expired: 'That request timed out.',
  offer_already_resolved: 'Another driver got there first.',
  ride_not_cancellable: 'This ride can no longer be cancelled.',
  driver_unavailable: "You're not available to take rides right now.",
  driver_already_on_ride: "You're already on a ride.",
  payment_declined: 'Your payment method was declined.',
  payment_method_required: 'Add a payment method to request a ride.',
  quote_expired: 'That price expired. Pull a fresh quote.',
  rate_limited: "You're going a little fast. Try again in a moment.",
  provider_unavailable: 'A service we rely on is unavailable. Try again shortly.',
  not_implemented: "That isn't available yet.",
  internal_error: 'Something went wrong on our end.',
};

export const unauthorized = (message = 'Unauthorized', o?: AppErrorOptions) =>
  new AppError('unauthorized', message, o);
export const forbidden = (message = 'Forbidden', o?: AppErrorOptions) =>
  new AppError('forbidden', message, o);
export const notFound = (what: string, o?: AppErrorOptions) =>
  new AppError('not_found', `${what} not found`, o);
export const validationFailed = (message: string, o?: AppErrorOptions) =>
  new AppError('validation_failed', message, o);
export const conflict = (message: string, o?: AppErrorOptions) =>
  new AppError('conflict', message, o);
export const internalError = (message = 'Internal error', o?: AppErrorOptions) =>
  new AppError('internal_error', message, o);

export const isAppError = (e: unknown): e is AppError => e instanceof AppError;

export const toAppError = (e: unknown): AppError => {
  if (isAppError(e)) return e;
  if (e instanceof Error) return internalError(e.message, { cause: e });
  return internalError(String(e));
};
