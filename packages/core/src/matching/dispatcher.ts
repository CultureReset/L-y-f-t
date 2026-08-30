/**
 * The dispatcher — the offer waterfall.
 *
 * A `DispatchSession` owns one ride's search for a driver. It is a pure state
 * machine: you feed it candidates and the current time, and it hands back
 * commands ("send this offer", "expire that one", "assign this driver").
 * It performs no I/O and starts no timers, so an entire five-minute search can
 * be replayed in a test in microseconds.
 *
 * The waterfall:
 *   1. Rank eligible drivers with the configured strategy.
 *   2. Offer the top `offerBatchSize` of them.
 *   3. On accept, assign and stop. On decline/timeout, exclude and continue.
 *   4. When a round is exhausted, widen the radius and re-rank.
 *   5. Give up at `searchTimeoutMs` and report no drivers found.
 */

import { newOfferId } from '../util/ids.js';
import type { DriverId, OfferId, RideId } from '../util/ids.js';
import type { RideTypeCatalog } from '../catalog/rideTypes.js';
import { filterEligible, scoredStrategy } from './strategies.js';
import type {
  DispatchCommand,
  DispatchSessionStatus,
  DispatchTuning,
  DriverCandidate,
  MatchRequest,
  MatchingStrategy,
  OfferPreview,
  RideOffer,
} from './types.js';
import { defaultDispatchTuning } from './types.js';

export interface DispatchSessionOptions {
  readonly request: MatchRequest;
  readonly tuning?: Partial<DispatchTuning>;
  readonly strategy?: MatchingStrategy;
  readonly catalog?: RideTypeCatalog;
  /** Builds the driver-facing offer card for a candidate. */
  readonly buildPreview: (candidate: DriverCandidate, request: MatchRequest) => OfferPreview;
  readonly startedAt: number;
}

export interface DispatchDiagnostics {
  readonly round: number;
  readonly currentRadiusMeters: number;
  readonly candidatesConsidered: number;
  readonly candidatesEligible: number;
  readonly offersSent: number;
  readonly offersDeclined: number;
  readonly offersExpired: number;
  readonly rejectionReasons: Readonly<Record<string, number>>;
}

export class DispatchSession {
  readonly rideId: RideId;

  private status: DispatchSessionStatus = 'searching';
  private readonly tuning: DispatchTuning;
  private readonly strategy: MatchingStrategy;
  private request: MatchRequest;
  private readonly outstanding = new Map<OfferId, RideOffer>();
  private readonly excluded = new Set<DriverId>();
  private round = 0;
  private radiusMeters: number;
  private nextRoundAt: number;
  private readonly startedAt: number;
  private offersSent = 0;
  private offersDeclined = 0;
  private offersExpired = 0;
  private candidatesConsidered = 0;
  private candidatesEligible = 0;
  private rejectionReasons: Record<string, number> = {};

  constructor(private readonly options: DispatchSessionOptions) {
    this.request = options.request;
    this.rideId = options.request.rideId;
    this.tuning = { ...defaultDispatchTuning(), ...options.tuning };
    this.strategy = options.strategy ?? scoredStrategy();
    this.radiusMeters = this.tuning.searchRadiusMeters;
    this.startedAt = options.startedAt;
    this.nextRoundAt = options.startedAt;
    for (const id of options.request.excludedDriverIds) this.excluded.add(id);
  }

  getStatus(): DispatchSessionStatus {
    return this.status;
  }

  isFinished(): boolean {
    return this.status === 'matched' || this.status === 'failed' || this.status === 'cancelled';
  }

  outstandingOffers(): RideOffer[] {
    return [...this.outstanding.values()];
  }

  diagnostics(): DispatchDiagnostics {
    return {
      round: this.round,
      currentRadiusMeters: this.radiusMeters,
      candidatesConsidered: this.candidatesConsidered,
      candidatesEligible: this.candidatesEligible,
      offersSent: this.offersSent,
      offersDeclined: this.offersDeclined,
      offersExpired: this.offersExpired,
      rejectionReasons: { ...this.rejectionReasons },
    };
  }

  /**
   * Advance the search. Call this whenever the fleet's state changes or on a
   * regular interval; `candidates` is the current set of available drivers.
   */
  tick(now: number, candidates: readonly DriverCandidate[]): DispatchCommand[] {
    if (this.isFinished()) return [];

    const commands: DispatchCommand[] = [];

    // 1. Retire anything that timed out.
    for (const offer of [...this.outstanding.values()]) {
      if (now >= offer.expiresAt) {
        this.outstanding.delete(offer.id);
        this.excluded.add(offer.driverId);
        this.offersExpired++;
        commands.push({ type: 'expire_offer', offerId: offer.id, driverId: offer.driverId });
      }
    }

    // 2. Give up if the overall search window has closed.
    if (now - this.startedAt >= this.tuning.searchTimeoutMs) {
      this.status = 'failed';
      commands.push({
        type: 'no_drivers_found',
        rideId: this.rideId,
        searchedMs: now - this.startedAt,
      });
      return commands;
    }

    // 3. While offers are outstanding, wait for an answer.
    if (this.outstanding.size > 0) {
      this.status = 'awaiting_response';
      return commands;
    }

    // 4. Respect the pause between rounds.
    if (now < this.nextRoundAt) {
      this.status = 'searching';
      return commands;
    }

    // 5. Rank and offer.
    this.status = 'searching';
    const requestWithExclusions: MatchRequest = {
      ...this.request,
      excludedDriverIds: [...this.excluded],
    };
    this.candidatesConsidered = candidates.length;

    const { eligible, rejected } = filterEligible(candidates, requestWithExclusions, {
      searchRadiusMeters: this.radiusMeters,
      catalog: this.options.catalog,
      now,
    });
    this.candidatesEligible = eligible.length;
    this.rejectionReasons = rejected.reduce<Record<string, number>>((acc, r) => {
      acc[r.reason] = (acc[r.reason] ?? 0) + 1;
      return acc;
    }, {});

    if (eligible.length === 0) {
      // Nobody in range: widen and try again after the round delay.
      commands.push({ type: 'search_exhausted_round', rideId: this.rideId, round: this.round });
      this.beginNextRound(now);
      return commands;
    }

    const ranked = this.strategy.rank(eligible, requestWithExclusions);
    const batch = ranked.slice(0, Math.max(1, this.tuning.offerBatchSize));

    for (const { candidate } of batch) {
      const offer: RideOffer = {
        id: newOfferId(),
        rideId: this.rideId,
        driverId: candidate.driverId,
        vehicleId: candidate.vehicleId,
        status: 'pending',
        sentAt: now,
        expiresAt: now + this.tuning.offerTimeoutMs,
        preview: this.options.buildPreview(candidate, requestWithExclusions),
        round: this.round,
      };
      this.outstanding.set(offer.id, offer);
      this.offersSent++;
      commands.push({ type: 'send_offer', offer });

      // A driver with auto-accept on takes the ride immediately.
      if (candidate.autoAccept) {
        commands.push(...this.accept(offer.id, now));
        break;
      }
    }

    if (this.outstanding.size > 0 && !this.isFinished()) this.status = 'awaiting_response';
    return commands;
  }

  /**
   * A driver accepted. Returns the assignment command, or an empty list if the
   * offer is no longer live (it expired, or another driver won the race).
   */
  accept(offerId: OfferId, now: number): DispatchCommand[] {
    if (this.isFinished()) return [];
    const offer = this.outstanding.get(offerId);
    if (!offer) return [];

    this.outstanding.delete(offerId);
    this.status = 'matched';

    // Any other offer still out for this ride is now void.
    const commands: DispatchCommand[] = [];
    for (const other of this.outstanding.values()) {
      commands.push({ type: 'expire_offer', offerId: other.id, driverId: other.driverId });
    }
    this.outstanding.clear();

    commands.push({
      type: 'assign_driver',
      rideId: this.rideId,
      offerId: offer.id,
      driverId: offer.driverId,
      vehicleId: offer.vehicleId,
      pickupEtaMs: offer.preview.pickupEtaMs,
    });
    return commands;
  }

  /** A driver declined. They are excluded from the rest of this ride's search. */
  decline(offerId: OfferId, _now: number): DispatchCommand[] {
    if (this.isFinished()) return [];
    const offer = this.outstanding.get(offerId);
    if (!offer) return [];
    this.outstanding.delete(offerId);
    this.excluded.add(offer.driverId);
    this.offersDeclined++;
    this.status = 'searching';
    return [];
  }

  /** The rider cancelled, or the ride otherwise went away. */
  cancel(): DispatchCommand[] {
    if (this.isFinished()) return [];
    this.status = 'cancelled';
    const commands: DispatchCommand[] = [...this.outstanding.values()].map((offer) => ({
      type: 'expire_offer' as const,
      offerId: offer.id,
      driverId: offer.driverId,
    }));
    this.outstanding.clear();
    return commands;
  }

  /** Update the request mid-search, e.g. the rider changed their dropoff. */
  updateRequest(patch: Partial<MatchRequest>): void {
    this.request = { ...this.request, ...patch };
  }

  private beginNextRound(now: number): void {
    this.round++;
    this.radiusMeters = Math.min(
      this.tuning.maxSearchRadiusMeters,
      this.radiusMeters * this.tuning.radiusExpansionFactor,
    );
    this.nextRoundAt = now + this.tuning.roundDelayMs;
  }
}

/**
 * Owns every in-flight search. The API keeps one of these and drives it from a
 * single interval, which keeps the number of timers proportional to the
 * process rather than to the number of open rides.
 */
export class DispatchRegistry {
  private readonly sessions = new Map<RideId, DispatchSession>();
  private readonly byOffer = new Map<OfferId, RideId>();

  open(session: DispatchSession): DispatchSession {
    this.sessions.set(session.rideId, session);
    return session;
  }

  get(rideId: RideId): DispatchSession | undefined {
    return this.sessions.get(rideId);
  }

  sessionForOffer(offerId: OfferId): DispatchSession | undefined {
    const rideId = this.byOffer.get(offerId);
    return rideId ? this.sessions.get(rideId) : undefined;
  }

  trackOffer(offerId: OfferId, rideId: RideId): void {
    this.byOffer.set(offerId, rideId);
  }

  close(rideId: RideId): void {
    const session = this.sessions.get(rideId);
    if (session) {
      for (const offer of session.outstandingOffers()) this.byOffer.delete(offer.id);
    }
    this.sessions.delete(rideId);
  }

  active(): DispatchSession[] {
    return [...this.sessions.values()].filter((s) => !s.isFinished());
  }

  size(): number {
    return this.sessions.size;
  }
}
