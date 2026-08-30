/**
 * The ride inspector.
 *
 * The first thing an operator opens when a rider complains: the ride's full
 * timeline, every offer dispatch sent and what happened to it, the charges, and
 * the dispatch diagnostics — including why each candidate driver was skipped.
 * That last part is what turns "why did nobody get my ride?" into an answer.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { buildTimeline, formatDuration, formatMoney, type Ride } from '@lift/core';
import type { LiftClient } from '@lift/sdk';

interface RideDetail {
  ride: Ride;
  timeline: { at: number; time: string; title: string; detail?: string }[];
  durations: Record<string, number | undefined>;
  offers: {
    id: string;
    driverId: string;
    status: string;
    sentAt: number;
    respondedAt?: number;
    round: number;
  }[];
  charges: { id: string; kind: string; status: string; amount: { amount: number; currency: string } }[];
  dispatch: {
    round: number;
    currentRadiusMeters: number;
    candidatesConsidered: number;
    candidatesEligible: number;
    offersSent: number;
    offersDeclined: number;
    offersExpired: number;
    rejectionReasons: Record<string, number>;
  } | null;
}

export interface RideInspectorProps {
  readonly client: LiftClient;
  readonly rideId: string;
  readonly onClose: () => void;
}

export const RideInspector = ({
  client,
  rideId,
  onClose,
}: RideInspectorProps): React.JSX.Element => {
  const [detail, setDetail] = useState<RideDetail>();
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    try {
      setDetail((await client.adminRide(rideId)) as unknown as RideDetail);
      setError(undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load that ride');
    }
  }, [client, rideId]);

  useEffect(() => {
    void load();
    // A ride in flight keeps changing while an operator is looking at it.
    const timer = setInterval(() => void load(), 4_000);
    return () => clearInterval(timer);
  }, [load]);

  if (error) {
    return (
      <section>
        <h2>Ride</h2>
        <p className="error">{error}</p>
        <button className="ghost" onClick={onClose}>
          Close
        </button>
      </section>
    );
  }

  if (!detail) {
    return (
      <section>
        <h2>Ride</h2>
        <p className="empty">Loading…</p>
      </section>
    );
  }

  const { ride, offers, charges, dispatch } = detail;
  const fare = ride.finalFare ?? ride.quotedFare;
  const rejections = Object.entries(dispatch?.rejectionReasons ?? {});

  return (
    <section style={{ borderTop: '2px solid var(--primary)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <h2 style={{ margin: 0, flex: 1 }}>Ride {ride.id}</h2>
        <button className="ghost" onClick={onClose} style={{ padding: '4px 10px' }}>
          Close
        </button>
      </div>

      <div className="row" style={{ cursor: 'default' }}>
        <div className="grow">
          <div className="title">
            {ride.itinerary.pickup.name} → {ride.itinerary.dropoff.name}
          </div>
          <div className="sub">
            {ride.rideTypeId} · {ride.passengerCount} rider
            {ride.passengerCount > 1 ? 's' : ''} ·{' '}
            {(fare.distanceMeters / 1609.344).toFixed(1)} mi
          </div>
        </div>
        <span className="amount">{formatMoney(fare.total)}</span>
      </div>

      {/* Dispatch diagnostics: why this ride went the way it did. */}
      {dispatch ? (
        <div style={{ margin: '12px 0' }}>
          <h2>Dispatch</h2>
          <div className="sub" style={{ padding: '0 10px' }}>
            round {dispatch.round} · radius {(dispatch.currentRadiusMeters / 1000).toFixed(1)} km ·{' '}
            {dispatch.candidatesEligible}/{dispatch.candidatesConsidered} drivers eligible
          </div>
          <div className="sub" style={{ padding: '2px 10px' }}>
            {dispatch.offersSent} sent · {dispatch.offersDeclined} declined ·{' '}
            {dispatch.offersExpired} timed out
          </div>
          {rejections.length > 0 ? (
            <div style={{ padding: '6px 10px', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {rejections.map(([reason, count]) => (
                <span key={reason} className="tag">
                  {reason.replace(/_/g, ' ')} × {count}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      <h2>Timeline</h2>
      {detail.timeline.map((entry, index) => (
        <div key={`${entry.at}-${index}`} className="row" style={{ cursor: 'default' }}>
          <span className="sub" style={{ width: 62 }}>
            {entry.time}
          </span>
          <div className="grow">
            <div className="title">{entry.title}</div>
            {entry.detail ? <div className="sub">{entry.detail}</div> : null}
          </div>
        </div>
      ))}

      {offers.length > 0 ? (
        <>
          <h2 style={{ marginTop: 12 }}>Offers</h2>
          {offers.map((offer) => (
            <div key={offer.id} className="row" style={{ cursor: 'default' }}>
              <span className={`tag ${offer.status === 'accepted' ? 'accepted' : 'offline'}`}>
                {offer.status}
              </span>
              <div className="grow">
                <div className="title">{offer.driverId}</div>
                <div className="sub">
                  round {offer.round}
                  {offer.respondedAt
                    ? ` · answered in ${formatShort(offer.respondedAt - offer.sentAt)}`
                    : ''}
                </div>
              </div>
            </div>
          ))}
        </>
      ) : null}

      {charges.length > 0 ? (
        <>
          <h2 style={{ marginTop: 12 }}>Charges</h2>
          {charges.map((charge) => (
            <div key={charge.id} className="row" style={{ cursor: 'default' }}>
              <span className={`tag ${charge.status === 'captured' ? 'completed' : 'offline'}`}>
                {charge.status}
              </span>
              <div className="grow">
                <div className="title">{charge.kind.replace(/_/g, ' ')}</div>
              </div>
              <span className="amount">{formatMoney(charge.amount as never)}</span>
            </div>
          ))}
        </>
      ) : null}

      <h2 style={{ marginTop: 12 }}>Fare</h2>
      {fare.items.map((item, index) => (
        <div key={`${item.code}-${index}`} className="row" style={{ cursor: 'default' }}>
          <div className="grow">
            <div className="title">{item.label}</div>
            {item.detail ? <div className="sub">{item.detail}</div> : null}
          </div>
          <span className="amount">{formatMoney(item.amount)}</span>
        </div>
      ))}

      {['requested', 'accepted', 'arrived'].includes(ride.status) ? (
        <button
          style={{ marginTop: 12, width: '100%', background: 'var(--danger)' }}
          onClick={() => {
            if (!confirm('Cancel this ride on the rider’s behalf?')) return;
            void client
              .adminCancelRide(ride.id, 'Cancelled from the ops console')
              .then(() => void load());
          }}
        >
          Cancel ride
        </button>
      ) : null}
    </section>
  );
};

/**
 * Offer timings are seconds, not minutes: formatDuration renders anything under
 * half a minute as "Now", which reads as nonsense next to a 15-second timeout.
 */
const formatShort = (ms: number): string =>
  ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : formatDuration(ms);

export { buildTimeline };
