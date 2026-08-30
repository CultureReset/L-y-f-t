/**
 * The wire contract.
 *
 * Response shapes the API actually returns, expressed once and shared by the
 * rider app, the driver app, the ops console, and the simulator. A change to a
 * route surfaces here as a type error in every client rather than as a runtime
 * surprise in one of them.
 */

import type {
  BoundingBox,
  Charge,
  DriverProfile,
  DriverShift,
  EarningsSummary,
  FareBreakdown,
  LatLng,
  Money,
  PaymentMethod,
  Place,
  Position,
  HelpTopic,
  Ride,
  RideOffer,
  RiderProfile,
  SavedPlace,
  SupportTicket,
  TicketCategory,
  User,
  Vehicle,
} from '@lift/core';

export interface ApiErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly userMessage: string;
    readonly details: Record<string, unknown>;
  };
}

export interface HealthResponse {
  readonly ok: boolean;
  readonly at: number;
  readonly brand: string;
  readonly market: string;
  readonly store: string;
  readonly geoProvider: string;
  readonly surgeProvider: string;
  readonly dispatchStrategy: string;
  readonly activeSearches: number;
  readonly realtimeConnections: number;
}

/** The bootstrap payload both apps fetch before their first screen. */
export interface ClientConfig {
  readonly brandName: string;
  readonly market: {
    readonly id: string;
    readonly name: string;
    readonly currency: string;
    readonly locale: string;
    readonly defaultCenter: LatLng;
    readonly serviceRadiusMeters: number;
  };
  readonly features: Record<string, boolean>;
  readonly rideTypes: readonly RideTypeSummary[];
  readonly realtime: {
    readonly driverPingIntervalMs: number;
    readonly staleLocationMs: number;
    readonly heartbeatIntervalMs: number;
  };
  readonly dispatch: {
    readonly offerTimeoutMs: number;
    readonly searchTimeoutMs: number;
  };
  readonly map: {
    readonly kind: 'raster' | 'vector' | 'none';
    readonly urlTemplate?: string;
    readonly styleUrl?: string;
    readonly attribution: string;
    readonly maxZoom: number;
  };
}

export interface RideTypeSummary {
  readonly id: string;
  readonly name: string;
  readonly tagline: string;
  readonly description: string;
  readonly icon: string;
  readonly maxPassengers: number;
  readonly badge?: string;
  readonly shared: boolean;
  readonly displayOrder: number;
}

// ---------------------------------------------------------------- auth

export interface AuthSession {
  readonly token: string;
  readonly expiresAt: number;
  readonly isNewUser: boolean;
  readonly role: 'rider' | 'driver' | 'admin';
  readonly user: PublicUser;
  readonly riderId?: string;
  readonly driverId?: string;
}

export interface PublicUser extends User {
  readonly displayName: string;
  readonly publicName: string;
}

export interface MeResponse {
  readonly user: PublicUser | null;
  readonly role?: 'rider' | 'driver' | 'admin';
  readonly rider: RiderProfile | null;
  readonly driver: DriverProfile | null;
}

// --------------------------------------------------------------- places

export interface PlaceSearchResult {
  readonly place: Place;
  readonly relevance: number;
  readonly icon?: string;
  readonly badge?: string;
}

export interface PlaceSearchSection {
  readonly sourceId: string;
  readonly title: string;
  readonly icon: string;
  readonly results: readonly PlaceSearchResult[];
}

export interface PlaceSearchResponse {
  readonly sections: readonly PlaceSearchSection[];
}

// ---------------------------------------------------------------- rides

export interface QuoteResponse {
  readonly quoteId: string;
  readonly expiresAt: number;
  readonly route: {
    readonly distanceMeters: number;
    readonly durationMs: number;
    readonly geometry: string;
    readonly bounds: BoundingBox;
  };
  readonly quotes: readonly RideQuote[];
}

export interface RideQuote {
  readonly rideTypeId: string;
  readonly name: string;
  readonly tagline: string;
  readonly icon: string;
  readonly badge?: string;
  readonly maxPassengers: number;
  readonly fare: FareBreakdown;
  readonly pickupEtaMs: number;
  readonly tripDurationMs: number;
  readonly tripDistanceMeters: number;
  readonly surgeMultiplier: number;
  readonly available: boolean;
  readonly unavailableReason?: string;
}

/** The driver and vehicle a rider sees once they are matched. */
export interface AssignedDriver {
  readonly driverId: string;
  readonly name: string;
  readonly avatarUrl?: string;
  readonly rating: number;
  readonly totalRides: number;
  readonly memberSince: number;
  readonly position?: Position;
}

export interface AssignedVehicle {
  readonly make: string;
  readonly model: string;
  readonly color: string;
  readonly licensePlate: string;
  readonly photoUrl?: string;
}

export interface RideResponse {
  readonly ride: Ride | null;
  readonly driver?: AssignedDriver;
  readonly vehicle?: AssignedVehicle;
  readonly timeline?: readonly TimelineEntry[];
  readonly durations?: RideDurations;
}

export interface TimelineEntry {
  readonly at: number;
  readonly time: string;
  readonly title: string;
  readonly detail?: string;
  readonly icon: string;
  readonly milestone: boolean;
}

export interface RideDurations {
  readonly timeToMatchMs?: number;
  readonly pickupMs?: number;
  readonly waitAtPickupMs?: number;
  readonly tripMs?: number;
  readonly totalMs?: number;
}

export interface CancellationPreview {
  readonly fee: Money;
  readonly waived: boolean;
  readonly explanation: string;
  readonly freeWindowRemainingMs?: number;
}

export interface ReceiptResponse {
  readonly receipt: {
    readonly rideId: string;
    readonly status: string;
    readonly completedAt?: number;
    readonly pickup: Place;
    readonly dropoff: Place;
    readonly fare: FareBreakdown;
    readonly durations: RideDurations;
    readonly charges: readonly {
      readonly id: string;
      readonly kind: string;
      readonly status: string;
      readonly amount: Money;
    }[];
  } | null;
}

export interface ChatMessage {
  readonly id: string;
  readonly rideId: string;
  readonly from: 'rider' | 'driver';
  readonly text: string;
  readonly sentAt: number;
  readonly readAt?: number;
}

// -------------------------------------------------------------- drivers

export interface DriverStatusResponse {
  readonly profile: DriverProfile;
  readonly vehicle?: Vehicle;
  readonly availability: DriverProfile['availability'];
  readonly canGoOnline: boolean;
  readonly blockedReason?: string;
  readonly missingDocuments: readonly string[];
  readonly openShift?: DriverShift;
  readonly pendingOffers: readonly RideOffer[];
  readonly activeRideId?: string;
  readonly eligibleRideTypes: readonly RideTypeSummary[];
  readonly todayEarnings: EarningsSummary;
}

export interface DriverRideResponse {
  readonly ride: Ride | null;
  readonly rider?: {
    readonly riderId: string;
    readonly name: string;
    readonly avatarUrl?: string;
    readonly rating: number;
    readonly totalRides: number;
  };
}

export interface EarningsResponse {
  readonly summary: EarningsSummary;
  readonly rides: readonly {
    readonly rideId: string;
    readonly completedAt?: number;
    readonly pickup: string;
    readonly dropoff: string;
    readonly payout?: Money;
    readonly distanceMeters?: number;
    readonly rating?: number;
  }[];
}

// ---------------------------------------------------------------- rider

export interface PaymentMethodView extends Omit<PaymentMethod, 'gatewayToken'> {
  readonly displayLabel: string;
}

export interface SavedPlacesResponse {
  readonly places: readonly SavedPlace[];
}

export interface ChargesResponse {
  readonly charges: readonly Charge[];
}

// ---------------------------------------------------------------- admin

export interface AdminOverview {
  readonly at: number;
  readonly fleet: Record<string, number>;
  readonly rides: {
    readonly searching: number;
    readonly inProgress: number;
    readonly completedToday: number;
    readonly cancelledToday: number;
  };
  readonly dispatch: { readonly activeSearches: number };
  readonly realtime: { readonly connections: number; readonly channels: number };
  readonly config: {
    readonly market: string;
    readonly geoProvider: string;
    readonly surgeProvider: string;
    readonly dispatchStrategy: string;
    readonly store: string;
  };
}

export interface AdminDriverView {
  readonly driverId: string;
  readonly name: string;
  readonly availability: string;
  readonly approvalStatus: string;
  readonly position?: Position;
  readonly rating: number;
  readonly totalRides: number;
  readonly acceptanceRate: number;
  readonly currentRideId?: string;
}

export interface HelpResponse {
  readonly topics: readonly HelpTopic[];
  readonly categories: readonly TicketCategory[];
}
