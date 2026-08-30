/**
 * Live ride state.
 *
 * Subscribes to the ride's realtime channel and keeps one object up to date as
 * the ride moves through its lifecycle — the driver's position included, so the
 * car on the map animates without polling. Falls back to polling only when the
 * socket is down, which is what makes tracking survive a bad connection.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { channels, type AssignedDriver, type AssignedVehicle } from '@lift/sdk';
import {
  ACTIVE_RIDE_STATUSES,
  decodePolyline,
  isTerminal,
  type LatLng,
  type Position,
  type Ride,
} from '@lift/core';
import { useApp } from './AppProvider.js';

export interface ActiveRideState {
  readonly ride: Ride | undefined;
  readonly driver: AssignedDriver | undefined;
  readonly vehicle: AssignedVehicle | undefined;
  /** The driver's live position, updated from the socket. */
  readonly driverPosition: LatLng | undefined;
  readonly driverBearing: number | undefined;
  /** The polyline for whichever leg is currently being driven. */
  readonly activeRoute: readonly LatLng[];
  readonly loading: boolean;
  readonly error: string | undefined;
  refresh(): Promise<void>;
  /** Forget the ride locally, e.g. after the rider dismisses a finished one. */
  clear(): void;
}

export const useActiveRide = (rideId?: string): ActiveRideState => {
  const { client, realtime, signedIn } = useApp();

  const [ride, setRide] = useState<Ride>();
  const [driver, setDriver] = useState<AssignedDriver>();
  const [vehicle, setVehicle] = useState<AssignedVehicle>();
  const [driverPosition, setDriverPosition] = useState<Position>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [cleared, setCleared] = useState(false);

  const load = useCallback(async () => {
    if (!signedIn) {
      setLoading(false);
      return;
    }
    try {
      const response = rideId ? await client.ride(rideId) : await client.activeRide();
      setRide(response.ride ?? undefined);
      setDriver(response.driver);
      setVehicle(response.vehicle);
      // Seed the marker from the assignment so the car appears immediately.
      if (response.driver?.position) setDriverPosition(response.driver.position);
      setError(undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load your ride');
    } finally {
      setLoading(false);
    }
  }, [client, rideId, signedIn]);

  useEffect(() => {
    setCleared(false);
    void load();
  }, [load]);

  const currentRideId = ride?.id;

  // Follow the ride's channel: status changes, route updates, driver movement.
  useEffect(() => {
    if (!currentRideId || !signedIn) return;

    const unsubscribe = realtime.subscribe(channels.ride(currentRideId), (message) => {
      const payload = message.payload as Record<string, unknown>;

      if (message.type === 'driver.location_updated') {
        const position = payload.position as Position | undefined;
        if (position) setDriverPosition(position);
        return;
      }

      const updated = payload.ride as Ride | undefined;
      if (updated?.id === currentRideId) {
        setRide(updated);
        // A newly assigned driver arrives with the status change, so re-read
        // the ride to pick up their profile and vehicle.
        if (message.type === 'ride.matched') void load();
      }
    });

    return unsubscribe;
  }, [currentRideId, realtime, signedIn, load]);

  // A safety net for a dropped socket: poll slowly while a ride is live.
  const pollRef = useRef<ReturnType<typeof setInterval>>(undefined);
  useEffect(() => {
    const isLive = ride !== undefined && ACTIVE_RIDE_STATUSES.includes(ride.status);
    if (!isLive) {
      if (pollRef.current) clearInterval(pollRef.current);
      return;
    }
    pollRef.current = setInterval(() => {
      if (!realtime.isConnected) void load();
    }, 8_000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [ride, realtime, load]);

  /**
   * The line to draw right now: the leg to pickup while the driver is on their
   * way, then the trip itself once the rider is aboard.
   */
  const activeRoute = useMemo<readonly LatLng[]>(() => {
    if (!ride) return [];
    const leg =
      ride.status === 'accepted' || ride.status === 'arrived'
        ? ride.legs.find((l) => l.kind === 'to_pickup')
        : ride.legs.find((l) => l.kind !== 'to_pickup');
    return leg?.geometry ? decodePolyline(leg.geometry) : [];
  }, [ride]);

  const visibleRide = cleared ? undefined : ride;

  return {
    ride: visibleRide,
    driver,
    vehicle,
    driverPosition: driverPosition ? { lat: driverPosition.lat, lng: driverPosition.lng } : undefined,
    driverBearing: driverPosition?.bearing,
    activeRoute,
    loading,
    error,
    refresh: load,
    clear: () => setCleared(true),
  };
};

/** Whether a ride still needs the rider's attention. */
export const isRideLive = (ride: Ride | undefined): boolean =>
  ride !== undefined && !isTerminal(ride.status);
