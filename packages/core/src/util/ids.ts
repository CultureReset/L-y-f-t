/**
 * Branded identifier helpers.
 *
 * Every entity gets a prefixed, roughly sortable, URL-safe id. The prefix makes
 * ids self-describing in logs and lets `isId()` cheaply reject a value that came
 * from the wrong table. Generation is pluggable so tests and the simulator can
 * inject a deterministic sequence instead of randomness.
 */

export type Brand<T, B extends string> = T & { readonly __brand: B };

export type UserId = Brand<string, 'UserId'>;
export type RiderId = Brand<string, 'RiderId'>;
export type DriverId = Brand<string, 'DriverId'>;
export type VehicleId = Brand<string, 'VehicleId'>;
export type RideId = Brand<string, 'RideId'>;
export type OfferId = Brand<string, 'OfferId'>;
export type PlaceId = Brand<string, 'PlaceId'>;
export type PaymentMethodId = Brand<string, 'PaymentMethodId'>;
export type ChargeId = Brand<string, 'ChargeId'>;
export type SessionId = Brand<string, 'SessionId'>;
export type MessageId = Brand<string, 'MessageId'>;
export type TicketId = Brand<string, 'TicketId'>;
export type PayoutId = Brand<string, 'PayoutId'>;

export const ID_PREFIXES = {
  user: 'usr',
  rider: 'rdr',
  driver: 'drv',
  vehicle: 'veh',
  ride: 'rid',
  offer: 'ofr',
  place: 'plc',
  paymentMethod: 'pm',
  charge: 'chg',
  session: 'ses',
  message: 'msg',
  ticket: 'tkt',
  payout: 'po',
  payoutDestination: 'pod',
  promo: 'promo',
} as const;

export type IdKind = keyof typeof ID_PREFIXES;

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/** Swappable randomness so tests can make ids deterministic. */
export type IdGenerator = (kind: IdKind) => string;

const randomSuffix = (len: number): string => {
  let out = '';
  for (let i = 0; i < len; i++) {
    out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return out;
};

/**
 * Default generator: `<prefix>_<base36 millis><random>`. The timestamp prefix
 * keeps ids roughly sortable by creation, which makes reading a ride's
 * lifecycle in logs far easier than opaque UUIDs.
 */
export const defaultIdGenerator: IdGenerator = (kind) =>
  `${ID_PREFIXES[kind]}_${Date.now().toString(36)}${randomSuffix(8)}`;

let generator: IdGenerator = defaultIdGenerator;

export const setIdGenerator = (next: IdGenerator): void => {
  generator = next;
};

export const resetIdGenerator = (): void => {
  generator = defaultIdGenerator;
};

export const newId = <T extends string>(kind: IdKind): T => generator(kind) as T;

export const newUserId = () => newId<UserId>('user');
export const newRiderId = () => newId<RiderId>('rider');
export const newDriverId = () => newId<DriverId>('driver');
export const newVehicleId = () => newId<VehicleId>('vehicle');
export const newRideId = () => newId<RideId>('ride');
export const newOfferId = () => newId<OfferId>('offer');
export const newPlaceId = () => newId<PlaceId>('place');
export const newPaymentMethodId = () => newId<PaymentMethodId>('paymentMethod');
export const newChargeId = () => newId<ChargeId>('charge');
export const newSessionId = () => newId<SessionId>('session');
export const newMessageId = () => newId<MessageId>('message');
export const newTicketId = () => newId<TicketId>('ticket');
export const newPayoutId = () => newId<PayoutId>('payout');

export const isId = (kind: IdKind, value: unknown): boolean =>
  typeof value === 'string' && value.startsWith(`${ID_PREFIXES[kind]}_`);

/** Deterministic generator for tests and reproducible simulator runs. */
export const sequentialIdGenerator = (): IdGenerator => {
  const counters = new Map<IdKind, number>();
  return (kind) => {
    const next = (counters.get(kind) ?? 0) + 1;
    counters.set(kind, next);
    return `${ID_PREFIXES[kind]}_${String(next).padStart(6, '0')}`;
  };
};
