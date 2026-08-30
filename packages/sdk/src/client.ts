/**
 * The platform API client.
 *
 * One typed client for every consumer: both mobile apps, the ops console, and
 * the simulator. It owns the token, shapes errors consistently, and exposes the
 * API as methods rather than URLs, so a route change is a compile error in
 * every caller instead of a 404 at runtime.
 */

import type {
  AdminDriverView,
  AdminOverview,
  ApiErrorBody,
  AuthSession,
  CancellationPreview,
  ChargesResponse,
  ChatMessage,
  ClientConfig,
  DriverRideResponse,
  DriverStatusResponse,
  EarningsResponse,
  HealthResponse,
  MeResponse,
  PaymentMethodView,
  PlaceSearchResponse,
  QuoteResponse,
  ReceiptResponse,
  RideResponse,
  RideTypeSummary,
  SavedPlacesResponse,
} from './types.js';
import type {
  DriverPreferences,
  LatLng,
  Place,
  PaymentMethodInput,
  Ride,
  RideOffer,
  SavedPlace,
  VehicleInput,
  Vehicle,
  DriverProfile,
  RiderProfile,
  Position,
} from '@lift/core';

/** An error carrying the platform's machine-readable code. */
export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly userMessage: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** True when retrying the same request might succeed. */
  get isRetryable(): boolean {
    return this.status >= 500 || this.status === 429;
  }

  /** True when the caller needs to sign in again. */
  get isAuthError(): boolean {
    return this.status === 401;
  }
}

export interface LiftClientOptions {
  readonly baseUrl: string;
  readonly token?: string;
  /** Called whenever the token changes, so an app can persist it. */
  readonly onTokenChange?: (token: string | undefined) => void;
  /** Called on any 401, so an app can route to sign-in. */
  readonly onUnauthorized?: () => void;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

export class LiftClient {
  private token: string | undefined;
  private readonly baseUrl: string;
  private readonly doFetch: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: LiftClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.token = options.token;
    this.doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  // ------------------------------------------------------------ transport

  getToken(): string | undefined {
    return this.token;
  }

  setToken(token: string | undefined): void {
    this.token = token;
    this.options.onTokenChange?.(token);
  }

  get isAuthenticated(): boolean {
    return this.token !== undefined;
  }

  /** The WebSocket URL for this deployment, carrying the current token. */
  realtimeUrl(): string {
    const url = this.baseUrl.replace(/^http/, 'ws');
    return `${url}/v1/realtime${this.token ? `?token=${encodeURIComponent(this.token)}` : ''}`;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string | number | boolean | undefined>,
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.doFetch(url.toString(), {
        method,
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => undefined)) as
          | ApiErrorBody
          | undefined;
        const error = new ApiError(
          payload?.error.code ?? 'internal_error',
          payload?.error.message ?? `HTTP ${response.status}`,
          response.status,
          payload?.error.userMessage ?? 'Something went wrong.',
          payload?.error.details ?? {},
        );
        if (error.isAuthError) this.options.onUnauthorized?.();
        throw error;
      }

      if (response.status === 204) return undefined as T;
      return (await response.json()) as T;
    } catch (e) {
      if (e instanceof ApiError) throw e;
      if (e instanceof Error && e.name === 'AbortError') {
        throw new ApiError('internal_error', 'Request timed out', 504, 'That took too long. Try again.');
      }
      throw new ApiError(
        'internal_error',
        e instanceof Error ? e.message : String(e),
        0,
        "We couldn't reach the network.",
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private get<T>(path: string, query?: Record<string, string | number | boolean | undefined>) {
    return this.request<T>('GET', path, undefined, query);
  }
  private post<T>(path: string, body?: unknown) {
    return this.request<T>('POST', path, body ?? {});
  }
  private patch<T>(path: string, body?: unknown) {
    return this.request<T>('PATCH', path, body ?? {});
  }
  private put<T>(path: string, body?: unknown) {
    return this.request<T>('PUT', path, body ?? {});
  }
  private del<T>(path: string) {
    return this.request<T>('DELETE', path);
  }

  // ------------------------------------------------------------ bootstrap

  health(): Promise<HealthResponse> {
    return this.get('/health');
  }

  config(): Promise<ClientConfig> {
    return this.get('/config');
  }

  // ----------------------------------------------------------------- auth

  /**
   * Send a verification code. Returns `devCode` when the deployment is running
   * with a fixed development code.
   */
  requestCode(phone: string): Promise<{ sent: boolean; devCode?: string }> {
    return this.post('/v1/auth/code', { phone });
  }

  /** Verify a code. Stores the returned token on the client. */
  async verifyCode(input: {
    phone: string;
    code: string;
    role?: 'rider' | 'driver';
    firstName?: string;
    lastName?: string;
    email?: string;
  }): Promise<AuthSession> {
    const session = await this.post<AuthSession>('/v1/auth/verify', input);
    this.setToken(session.token);
    return session;
  }

  me(): Promise<MeResponse> {
    return this.get('/v1/auth/me');
  }

  async switchRole(role: 'rider' | 'driver'): Promise<AuthSession> {
    const session = await this.post<AuthSession>('/v1/auth/role', { role });
    this.setToken(session.token);
    return session;
  }

  async signOut(): Promise<void> {
    await this.post('/v1/auth/signout');
    this.setToken(undefined);
  }

  updateProfile(patch: {
    firstName?: string;
    lastName?: string;
    email?: string;
    avatarUrl?: string;
  }): Promise<{ user: MeResponse['user'] }> {
    return this.patch('/v1/auth/profile', patch);
  }

  // --------------------------------------------------------------- places

  searchPlaces(input: {
    q: string;
    near?: LatLng;
    field?: 'pickup' | 'dropoff';
    limit?: number;
  }): Promise<PlaceSearchResponse> {
    return this.get('/v1/places/search', {
      q: input.q,
      lat: input.near?.lat,
      lng: input.near?.lng,
      field: input.field,
      limit: input.limit,
    });
  }

  resolvePlace(ref: string): Promise<{ place: Place }> {
    return this.get('/v1/places/resolve', { ref });
  }

  reverseGeocode(coordinates: LatLng): Promise<{ place: Place }> {
    return this.get('/v1/places/reverse', {
      lat: coordinates.lat,
      lng: coordinates.lng,
    });
  }

  // ---------------------------------------------------------------- rides

  rideTypes(): Promise<{ rideTypes: readonly RideTypeSummary[] }> {
    return this.get('/v1/ride-types');
  }

  quote(input: {
    pickup: Place;
    dropoff: Place;
    stops?: readonly { place: Place; plannedStopMinutes?: number }[];
    passengerCount?: number;
    scheduledFor?: number;
  }): Promise<QuoteResponse> {
    return this.post('/v1/rides/quote', input);
  }

  requestRide(input: {
    rideTypeId: string;
    pickup: Place;
    dropoff: Place;
    stops?: readonly { place: Place; plannedStopMinutes?: number }[];
    passengerCount?: number;
    paymentMethodId?: string;
    riderNote?: string;
    scheduledFor?: number;
    quoteId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ ride: Ride }> {
    return this.post('/v1/rides', input);
  }

  activeRide(): Promise<RideResponse> {
    return this.get('/v1/rides/active');
  }

  ride(rideId: string): Promise<RideResponse> {
    return this.get(`/v1/rides/${rideId}`);
  }

  rideHistory(options: { limit?: number; offset?: number } = {}): Promise<{ rides: Ride[] }> {
    return this.get('/v1/rides/history', options);
  }

  cancellationPreview(rideId: string): Promise<CancellationPreview> {
    return this.get(`/v1/rides/${rideId}/cancellation-preview`);
  }

  cancelRide(rideId: string, input: { reason?: string; note?: string } = {}): Promise<{ ride: Ride }> {
    return this.post(`/v1/rides/${rideId}/cancel`, input);
  }

  rateRide(
    rideId: string,
    input: { stars: number; comment?: string; tags?: string[]; tipAmount?: number },
  ): Promise<{ ride: Ride }> {
    return this.post(`/v1/rides/${rideId}/rate`, input);
  }

  receipt(rideId: string): Promise<ReceiptResponse> {
    return this.get(`/v1/rides/${rideId}/receipt`);
  }

  // ----------------------------------------------------------------- chat

  messages(rideId: string): Promise<{ messages: ChatMessage[] }> {
    return this.get(`/v1/rides/${rideId}/messages`);
  }

  sendMessage(rideId: string, text: string): Promise<{ message: ChatMessage }> {
    return this.post(`/v1/rides/${rideId}/messages`, { text });
  }

  quickReplies(): Promise<{ replies: string[] }> {
    return this.get('/v1/rides/quick-replies');
  }

  // -------------------------------------------------------------- rider

  riderProfile(): Promise<{ rider: RiderProfile }> {
    return this.get('/v1/rider/profile');
  }

  savedPlaces(): Promise<SavedPlacesResponse> {
    return this.get('/v1/rider/places');
  }

  savePlace(input: {
    label: string;
    icon?: SavedPlace['icon'];
    place: Place;
  }): Promise<SavedPlacesResponse> {
    return this.post('/v1/rider/places', input);
  }

  removeSavedPlace(placeId: string): Promise<SavedPlacesResponse> {
    return this.del(`/v1/rider/places/${placeId}`);
  }

  paymentMethods(): Promise<{ methods: PaymentMethodView[] }> {
    return this.get('/v1/rider/payment-methods');
  }

  addPaymentMethod(input: PaymentMethodInput): Promise<{ method: PaymentMethodView }> {
    return this.post('/v1/rider/payment-methods', input);
  }

  setDefaultPaymentMethod(methodId: string): Promise<{ methods: PaymentMethodView[] }> {
    return this.post(`/v1/rider/payment-methods/${methodId}/default`);
  }

  removePaymentMethod(methodId: string): Promise<{ methods: PaymentMethodView[] }> {
    return this.del(`/v1/rider/payment-methods/${methodId}`);
  }

  charges(limit = 25): Promise<ChargesResponse> {
    return this.get('/v1/rider/charges', { limit });
  }

  // -------------------------------------------------------------- driver

  driverStatus(): Promise<DriverStatusResponse> {
    return this.get('/v1/driver/status');
  }

  goOnline(position?: LatLng): Promise<{ driver: DriverProfile }> {
    return this.post('/v1/driver/online', position ? { position } : {});
  }

  goOffline(): Promise<{ driver: DriverProfile }> {
    return this.post('/v1/driver/offline');
  }

  setBusy(busy: boolean): Promise<{ driver: DriverProfile }> {
    return this.post('/v1/driver/busy', { busy });
  }

  /** Push a location fix. Prefer the realtime socket when one is connected. */
  updateLocation(position: Omit<Position, 'timestamp'> & { timestamp?: number }): Promise<{ ok: boolean }> {
    return this.post('/v1/driver/location', position);
  }

  offers(): Promise<{ offers: RideOffer[] }> {
    return this.get('/v1/driver/offers');
  }

  acceptOffer(offerId: string): Promise<{ ride: Ride }> {
    return this.post(`/v1/driver/offers/${offerId}/accept`);
  }

  declineOffer(offerId: string): Promise<{ ok: boolean }> {
    return this.post(`/v1/driver/offers/${offerId}/decline`);
  }

  driverActiveRide(): Promise<DriverRideResponse> {
    return this.get('/v1/driver/rides/active');
  }

  markArrived(rideId: string): Promise<{ ride: Ride }> {
    return this.post(`/v1/driver/rides/${rideId}/arrived`);
  }

  startTrip(rideId: string): Promise<{ ride: Ride }> {
    return this.post(`/v1/driver/rides/${rideId}/start`);
  }

  completeTrip(
    rideId: string,
    actuals: { distanceMeters?: number; durationMs?: number } = {},
  ): Promise<{ ride: Ride }> {
    return this.post(`/v1/driver/rides/${rideId}/complete`, actuals);
  }

  driverCancelRide(rideId: string, input: { reason?: string; note?: string } = {}): Promise<{ ride: Ride }> {
    return this.post(`/v1/driver/rides/${rideId}/cancel`, input);
  }

  reroute(rideId: string, from: LatLng): Promise<{ ride: Ride }> {
    return this.post(`/v1/driver/rides/${rideId}/reroute`, from);
  }

  rateRider(
    rideId: string,
    input: { stars: number; comment?: string; tags?: string[] },
  ): Promise<{ ride: Ride }> {
    return this.post(`/v1/driver/rides/${rideId}/rate`, input);
  }

  updateDriverPreferences(patch: Partial<DriverPreferences>): Promise<{ driver: DriverProfile }> {
    return this.patch('/v1/driver/preferences', patch);
  }

  setDestinationFilter(input: {
    address: string;
    lat: number;
    lng: number;
    radiusMeters?: number;
    durationMs?: number;
  }): Promise<{ driver: DriverProfile }> {
    return this.put('/v1/driver/destination-filter', input);
  }

  clearDestinationFilter(): Promise<{ driver: DriverProfile }> {
    return this.del('/v1/driver/destination-filter');
  }

  vehicles(): Promise<{ vehicles: Vehicle[] }> {
    return this.get('/v1/driver/vehicles');
  }

  addVehicle(input: VehicleInput): Promise<{
    vehicle: Vehicle;
    qualification: { rideTypeId: string; name: string; qualifies: boolean }[];
  }> {
    return this.post('/v1/driver/vehicles', input);
  }

  activateVehicle(vehicleId: string): Promise<{ driver: DriverProfile }> {
    return this.post(`/v1/driver/vehicles/${vehicleId}/activate`);
  }

  submitDocument(input: {
    type: string;
    fileUrl?: string;
    expiresAt?: number;
  }): Promise<{ driver: DriverProfile }> {
    return this.post('/v1/driver/documents', input);
  }

  earnings(
    period: 'today' | 'week' | 'month' = 'today',
  ): Promise<EarningsResponse> {
    return this.get('/v1/driver/earnings', { period });
  }

  // --------------------------------------------------------------- admin

  adminOverview(): Promise<AdminOverview> {
    return this.get('/v1/admin/overview');
  }

  adminDrivers(): Promise<{ drivers: AdminDriverView[] }> {
    return this.get('/v1/admin/drivers');
  }

  adminRides(options: { status?: string; limit?: number; offset?: number } = {}): Promise<{
    rides: Ride[];
  }> {
    return this.get('/v1/admin/rides', options);
  }

  adminRide(rideId: string): Promise<Record<string, unknown>> {
    return this.get(`/v1/admin/rides/${rideId}`);
  }

  adminCancelRide(rideId: string, note?: string): Promise<{ ride: Ride }> {
    return this.post(`/v1/admin/rides/${rideId}/cancel`, { note });
  }

  adminSetDriverApproval(driverId: string, status: string): Promise<{ driver: DriverProfile }> {
    return this.post(`/v1/admin/drivers/${driverId}/approval`, { status });
  }
}
