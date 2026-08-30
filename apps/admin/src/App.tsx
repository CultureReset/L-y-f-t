/**
 * The operations console.
 *
 * A live view of the platform: every driver on the map, every ride in flight,
 * and — when something goes wrong — the dispatch diagnostics that explain why a
 * ride went the way it did. It reads the same API the apps do, through the same
 * SDK, using an admin session.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  LiftClient,
  RealtimeClient,
  channels,
  type AdminDriverView,
  type AdminOverview,
} from '@lift/sdk';
import { formatDuration, formatMoney, statusLabel, type Ride } from '@lift/core';
import { FleetMap } from './FleetMap.js';
import { RideInspector } from './RideInspector.js';
import { SignIn } from './SignIn.js';

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:4000';
const TOKEN_KEY = 'lift.admin.token';

export const App = (): React.JSX.Element => {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem(TOKEN_KEY));
  const [overview, setOverview] = useState<AdminOverview>();
  const [drivers, setDrivers] = useState<AdminDriverView[]>([]);
  const [rides, setRides] = useState<Ride[]>([]);
  const [selectedRideId, setSelectedRideId] = useState<string>();
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string>();

  const client = useMemo(
    () =>
      new LiftClient({
        baseUrl: API_URL,
        ...(token ? { token } : {}),
        onUnauthorized: () => {
          localStorage.removeItem(TOKEN_KEY);
          setToken(null);
        },
      }),
    [token],
  );

  const realtime = useMemo(
    () => new RealtimeClient({ url: () => client.realtimeUrl() }),
    [client],
  );

  const load = useCallback(async () => {
    if (!token) return;
    try {
      const [nextOverview, nextDrivers, nextRides] = await Promise.all([
        client.adminOverview(),
        client.adminDrivers(),
        client.adminRides({ limit: 40 }),
      ]);
      setOverview(nextOverview);
      setDrivers(nextDrivers.drivers);
      setRides(nextRides.rides);
      setError(undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load ops data');
    }
  }, [client, token]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * The ops feed. Driver positions arrive continuously, so they are applied
   * directly to local state; anything that changes a ride triggers a reload,
   * which is cheap at ops volumes and keeps the list authoritative.
   */
  const reloadTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    if (!token) return;

    realtime.connect();
    const offStatus = realtime.onStatusChange((status) => setConnected(status === 'connected'));

    const offMessage = realtime.subscribe(channels.ops, (message) => {
      if (message.type === 'driver.location_updated') {
        const { driverId, position } = message.payload as {
          driverId: string;
          position: { lat: number; lng: number; bearing?: number; timestamp: number };
        };
        setDrivers((current) =>
          current.map((d) => (d.driverId === driverId ? { ...d, position } : d)),
        );
        return;
      }
      // Coalesce bursts — a busy market emits many ride events per second.
      clearTimeout(reloadTimer.current);
      reloadTimer.current = setTimeout(() => void load(), 400);
    });

    // A slow poll covers anything the socket misses.
    const poll = setInterval(() => void load(), 15_000);

    return () => {
      offMessage();
      offStatus();
      clearInterval(poll);
      clearTimeout(reloadTimer.current);
      realtime.disconnect();
    };
  }, [realtime, token, load]);

  if (!token) {
    return (
      <SignIn
        apiUrl={API_URL}
        onSignedIn={(next) => {
          localStorage.setItem(TOKEN_KEY, next);
          setToken(next);
        }}
      />
    );
  }

  const activeRides = rides.filter((r) =>
    ['requested', 'accepted', 'arrived', 'in_progress'].includes(r.status),
  );
  const recentRides = rides.filter((r) =>
    ['completed', 'cancelled', 'expired'].includes(r.status),
  );

  return (
    <div className="app">
      <header>
        <h1>{overview?.config.market ?? 'Ops'}</h1>
        <span className={`pill ${connected ? 'live' : 'stale'}`}>
          <span
            className="dot"
            style={{ background: connected ? 'var(--success)' : 'var(--warning)' }}
          />
          {connected ? 'Live' : 'Reconnecting'}
        </span>
        {overview ? (
          <>
            <span className="pill">geo · {overview.config.geoProvider}</span>
            <span className="pill">dispatch · {overview.config.dispatchStrategy}</span>
            <span className="pill">surge · {overview.config.surgeProvider}</span>
            <span className="pill">store · {overview.config.store}</span>
          </>
        ) : null}
        <div className="spacer" />
        {error ? <span className="pill stale">{error}</span> : null}
        <button
          className="ghost"
          onClick={() => {
            localStorage.removeItem(TOKEN_KEY);
            setToken(null);
          }}
        >
          Sign out
        </button>
      </header>

      <div className="layout">
        <div className="map-pane">
          <FleetMap
            drivers={drivers}
            rides={activeRides}
            selectedRideId={selectedRideId}
            onSelectRide={setSelectedRideId}
          />
          <div className="legend">
            <span>
              <i className="dot" style={{ background: 'var(--success)' }} /> available
            </span>
            <span>
              <i className="dot" style={{ background: 'var(--warning)' }} /> offered
            </span>
            <span>
              <i className="dot" style={{ background: 'var(--primary)' }} /> on a trip
            </span>
            <span>
              <i className="dot" style={{ background: 'var(--text-muted)' }} /> offline
            </span>
          </div>
        </div>

        <aside className="side">
          {overview ? (
            <div className="stats">
              <Stat label="Searching" value={overview.rides.searching} tone={overview.rides.searching > 0 ? 'warn' : undefined} />
              <Stat label="In progress" value={overview.rides.inProgress} />
              <Stat label="Completed today" value={overview.rides.completedToday} tone="ok" />
              <Stat label="Cancelled today" value={overview.rides.cancelledToday} />
              <Stat label="Available drivers" value={overview.fleet.available ?? 0} tone="ok" />
              <Stat label="On a trip" value={overview.fleet.on_ride ?? 0} />
            </div>
          ) : null}

          {selectedRideId ? (
            <RideInspector
              client={client}
              rideId={selectedRideId}
              onClose={() => setSelectedRideId(undefined)}
            />
          ) : null}

          <section>
            <h2>Rides in flight ({activeRides.length})</h2>
            {activeRides.length === 0 ? (
              <p className="empty">Nothing in flight right now.</p>
            ) : (
              activeRides.map((ride) => (
                <RideRow
                  key={ride.id}
                  ride={ride}
                  selected={ride.id === selectedRideId}
                  onSelect={() => setSelectedRideId(ride.id)}
                />
              ))
            )}
          </section>

          <section>
            <h2>Fleet ({drivers.length})</h2>
            {drivers.map((driver) => (
              <div key={driver.driverId} className="row">
                <span className={`tag ${driver.availability}`}>
                  {driver.availability.replace('_', ' ')}
                </span>
                <div className="grow">
                  <div className="title">{driver.name}</div>
                  <div className="sub">
                    ★ {driver.rating.toFixed(2)} · {driver.totalRides} trips ·{' '}
                    {Math.round(driver.acceptanceRate * 100)}% accept
                  </div>
                </div>
              </div>
            ))}
            {drivers.length === 0 ? <p className="empty">No drivers registered.</p> : null}
          </section>

          <section>
            <h2>Recent rides</h2>
            {recentRides.slice(0, 15).map((ride) => (
              <RideRow
                key={ride.id}
                ride={ride}
                selected={ride.id === selectedRideId}
                onSelect={() => setSelectedRideId(ride.id)}
              />
            ))}
            {recentRides.length === 0 ? <p className="empty">No finished rides yet.</p> : null}
          </section>
        </aside>
      </div>
    </div>
  );
};

const Stat = ({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: 'ok' | 'warn';
}): React.JSX.Element => (
  <div className="stat">
    <div className="label">{label}</div>
    <div className={`value${tone ? ` ${tone}` : ''}`}>{value}</div>
  </div>
);

const RideRow = ({
  ride,
  selected,
  onSelect,
}: {
  ride: Ride;
  selected: boolean;
  onSelect: () => void;
}): React.JSX.Element => {
  const fare = ride.finalFare ?? ride.quotedFare;
  const elapsed = Date.now() - (ride.requestedAt ?? ride.createdAt);

  return (
    <div
      className={`row${selected ? ' selected' : ''}`}
      onClick={onSelect}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onSelect();
      }}
    >
      <span className={`tag ${ride.status}`}>{statusLabel(ride.status)}</span>
      <div className="grow">
        <div className="title">
          {ride.itinerary.pickup.name} → {ride.itinerary.dropoff.name}
        </div>
        <div className="sub">
          {ride.rideTypeId} ·{' '}
          {ride.status === 'requested' ? `searching ${formatDuration(elapsed)}` : ride.id}
        </div>
      </div>
      <span className="amount">{formatMoney(fare.total)}</span>
    </div>
  );
};
