/**
 * Driver app state.
 *
 * Beyond the session and config the rider app needs, this owns the two things
 * that define the driver experience: a location pipeline that streams position
 * to the backend while online, and an offer inbox that surfaces a ride the
 * instant dispatch sends it.
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import * as Location from 'expo-location';
import {
  LiftClient,
  RealtimeClient,
  channels,
  type ClientConfig,
  type DriverStatusResponse,
  type MeResponse,
} from '@lift/sdk';
import type { LatLng, Ride, RideOffer } from '@lift/core';

const TOKEN_KEY = 'lift.driver.token';

const resolveApiUrl = (): string => {
  const explicit = process.env.EXPO_PUBLIC_API_URL;
  if (explicit) return explicit;
  const hostUri =
    Constants.expoConfig?.hostUri ??
    (Constants.expoGoConfig as { debuggerHost?: string } | undefined)?.debuggerHost;
  const host = hostUri?.split(':')[0];
  return host ? `http://${host}:4000` : 'http://localhost:4000';
};

export interface DriverState {
  readonly client: LiftClient;
  readonly realtime: RealtimeClient;
  readonly config: ClientConfig | undefined;
  readonly me: MeResponse | undefined;
  readonly status: DriverStatusResponse | undefined;
  readonly driverId: string | undefined;
  readonly position: LatLng | undefined;
  readonly heading: number | undefined;
  /** The offer currently on screen, if any. */
  readonly offer: RideOffer | undefined;
  readonly activeRide: Ride | undefined;
  readonly online: boolean;
  readonly loading: boolean;
  readonly signedIn: boolean;
  readonly apiUrl: string;
  readonly error: string | undefined;
  signIn(token: string): Promise<void>;
  signOut(): Promise<void>;
  refresh(): Promise<void>;
  goOnline(): Promise<void>;
  goOffline(): Promise<void>;
  dismissOffer(): void;
}

const DriverContext = createContext<DriverState | undefined>(undefined);

export const DriverProvider = ({ children }: { children: ReactNode }): React.JSX.Element => {
  const apiUrl = useMemo(resolveApiUrl, []);
  const [config, setConfig] = useState<ClientConfig>();
  const [me, setMe] = useState<MeResponse>();
  const [status, setStatus] = useState<DriverStatusResponse>();
  const [activeRide, setActiveRide] = useState<Ride>();
  const [offer, setOffer] = useState<RideOffer>();
  const [position, setPosition] = useState<LatLng>();
  const [heading, setHeading] = useState<number>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [tokenVersion, setTokenVersion] = useState(0);

  const client = useMemo(
    () =>
      new LiftClient({
        baseUrl: apiUrl,
        onTokenChange: (token) => {
          void (token
            ? AsyncStorage.setItem(TOKEN_KEY, token)
            : AsyncStorage.removeItem(TOKEN_KEY));
        },
        onUnauthorized: () => {
          setMe(undefined);
          setStatus(undefined);
          setTokenVersion((v) => v + 1);
        },
      }),
    [apiUrl],
  );

  const realtime = useMemo(
    () => new RealtimeClient({ url: () => client.realtimeUrl() }),
    [client],
  );

  const refresh = useCallback(async () => {
    try {
      const [meResponse, statusResponse, rideResponse] = await Promise.all([
        client.me(),
        client.driverStatus().catch(() => undefined),
        client.driverActiveRide().catch(() => ({ ride: null })),
      ]);
      setMe(meResponse.user ? meResponse : undefined);
      setStatus(statusResponse);
      setActiveRide(rideResponse.ride ?? undefined);
      // A pending offer may have arrived while the app was backgrounded.
      setOffer(statusResponse?.pendingOffers[0]);
    } catch {
      setMe(undefined);
    }
  }, [client]);

  useEffect(() => {
    let cancelled = false;
    const boot = async (): Promise<void> => {
      try {
        const [stored, remoteConfig] = await Promise.all([
          AsyncStorage.getItem(TOKEN_KEY),
          client.config().catch(() => undefined),
        ]);
        if (cancelled) return;
        if (remoteConfig) setConfig(remoteConfig);
        else setError(`Can't reach the API at ${apiUrl}. Is it running?`);
        if (stored) {
          client.setToken(stored);
          await refresh();
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void boot();
    return () => {
      cancelled = true;
    };
  }, [client, apiUrl, refresh]);

  const signedIn = me?.user !== undefined && me?.user !== null;
  const driverId = me?.driver?.id;
  // Anything but `offline` means the driver is working: available, holding an
  // offer, on a trip, or soft-paused. Treating `offered` as offline made the
  // status read "OFFLINE" while a request was on screen.
  const online = status !== undefined && status.availability !== 'offline';

  useEffect(() => {
    if (!signedIn) {
      realtime.disconnect();
      return;
    }
    realtime.connect();
    return () => realtime.disconnect();
  }, [signedIn, realtime, tokenVersion]);

  /**
   * The offer inbox. An offer arriving over the socket is the single most
   * time-critical event in the driver app — the countdown is already running
   * when it lands — so it goes straight to state with no round trip.
   */
  useEffect(() => {
    if (!driverId) return;
    return realtime.subscribe(channels.driver(driverId), (message) => {
      const payload = message.payload as Record<string, unknown>;
      switch (message.type) {
        case 'offer.sent':
          setOffer(payload.offer as RideOffer);
          break;
        case 'offer.expired':
        case 'offer.declined':
          setOffer(undefined);
          void refresh();
          break;
        case 'ride.matched':
        case 'ride.status_changed':
          setOffer(undefined);
          setActiveRide(payload.ride as Ride);
          void refresh();
          break;
        case 'driver.availability_changed':
          void refresh();
          break;
      }
    });
  }, [driverId, realtime, refresh]);

  /**
   * Location streaming.
   *
   * While the driver is online their position is watched and pushed to the
   * backend — over the socket when it is connected (cheap, low latency) and by
   * HTTP otherwise, so dispatch never loses sight of a driver on a flaky
   * connection. The watcher stops the moment they go offline, because draining
   * a driver's battery while they are not working is unforgivable.
   */
  const watcher = useRef<Location.LocationSubscription>(undefined);

  /**
   * Tearing down a location subscription throws on some platforms, and an
   * exception here would take the whole app down at exactly the moment a
   * driver is going offline. Failing to unsubscribe is survivable; crashing is
   * not.
   */
  const stopWatching = useCallback(() => {
    try {
      watcher.current?.remove();
    } catch {
      // Nothing useful to do; the subscription is going away regardless.
    }
    watcher.current = undefined;
  }, []);

  useEffect(() => {
    if (!online || !signedIn) {
      stopWatching();
      return;
    }

    let cancelled = false;
    const start = async (): Promise<void> => {
      const permission = await Location.requestForegroundPermissionsAsync();
      if (!permission.granted || cancelled) return;

      watcher.current = await Location.watchPositionAsync(
        {
          accuracy: Location.Accuracy.High,
          timeInterval: config?.realtime.driverPingIntervalMs ?? 4_000,
          distanceInterval: 10,
        },
        (fix) => {
          const next = {
            lat: fix.coords.latitude,
            lng: fix.coords.longitude,
            ...(fix.coords.heading !== null && fix.coords.heading >= 0
              ? { bearing: fix.coords.heading }
              : {}),
            ...(fix.coords.speed !== null ? { speed: Math.max(0, fix.coords.speed) } : {}),
            ...(fix.coords.accuracy !== null ? { accuracy: fix.coords.accuracy } : {}),
          };
          setPosition({ lat: next.lat, lng: next.lng });
          if (next.bearing !== undefined) setHeading(next.bearing);

          if (realtime.isConnected) realtime.sendLocation(next);
          else void client.updateLocation(next).catch(() => {});
        },
      );
    };

    void start();
    return () => {
      cancelled = true;
      stopWatching();
    };
  }, [online, signedIn, config, realtime, client, stopWatching]);

  // Seed a position before the first fix so the map is not blank.
  useEffect(() => {
    if (position || !config) return;
    void Location.getLastKnownPositionAsync()
      .then((fix) => {
        setPosition(
          fix
            ? { lat: fix.coords.latitude, lng: fix.coords.longitude }
            : config.market.defaultCenter,
        );
      })
      .catch(() => setPosition(config.market.defaultCenter));
  }, [position, config]);

  const goOnline = useCallback(async () => {
    setError(undefined);
    try {
      await client.goOnline(position);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not go online');
      throw e;
    }
  }, [client, position, refresh]);

  const goOffline = useCallback(async () => {
    try {
      await client.goOffline();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not go offline');
      throw e;
    }
  }, [client, refresh]);

  const signIn = useCallback(
    async (token: string) => {
      client.setToken(token);
      await refresh();
      setTokenVersion((v) => v + 1);
    },
    [client, refresh],
  );

  const signOut = useCallback(async () => {
    try {
      // Never leave a driver online with the app signed out.
      if (online) await client.goOffline().catch(() => {});
      await client.signOut();
    } catch {
      client.setToken(undefined);
    }
    setMe(undefined);
    setStatus(undefined);
    setTokenVersion((v) => v + 1);
  }, [client, online]);

  const value = useMemo<DriverState>(
    () => ({
      client,
      realtime,
      config,
      me,
      status,
      driverId,
      position,
      heading,
      offer,
      activeRide,
      online,
      loading,
      signedIn,
      apiUrl,
      error,
      signIn,
      signOut,
      refresh,
      goOnline,
      goOffline,
      dismissOffer: () => setOffer(undefined),
    }),
    [
      client, realtime, config, me, status, driverId, position, heading, offer,
      activeRide, online, loading, signedIn, apiUrl, error, signIn, signOut,
      refresh, goOnline, goOffline,
    ],
  );

  return <DriverContext.Provider value={value}>{children}</DriverContext.Provider>;
};

export const useDriver = (): DriverState => {
  const value = useContext(DriverContext);
  if (!value) throw new Error('useDriver must be used inside a DriverProvider');
  return value;
};
