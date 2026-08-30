/**
 * App-wide state.
 *
 * Holds the three things every screen needs: the API client, the signed-in
 * session, and the deployment's config. The session is restored from storage on
 * launch so the app opens straight into the map rather than the sign-in screen.
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
import { LiftClient, RealtimeClient, type ClientConfig, type MeResponse } from '@lift/sdk';

const TOKEN_KEY = 'lift.rider.token';

/**
 * Where the API lives.
 *
 * In development on a device, `localhost` is the phone, not the machine running
 * the server — so the host is derived from the Expo dev server's address, which
 * is the one thing that is reliably reachable from the device.
 */
const resolveApiUrl = (): string => {
  const explicit = process.env.EXPO_PUBLIC_API_URL;
  if (explicit) return explicit;

  const hostUri =
    Constants.expoConfig?.hostUri ??
    (Constants.expoGoConfig as { debuggerHost?: string } | undefined)?.debuggerHost;
  const host = hostUri?.split(':')[0];
  return host ? `http://${host}:4000` : 'http://localhost:4000';
};

export interface AppState {
  readonly client: LiftClient;
  readonly realtime: RealtimeClient;
  readonly config: ClientConfig | undefined;
  readonly me: MeResponse | undefined;
  readonly riderId: string | undefined;
  /** True until the stored session has been checked. */
  readonly loading: boolean;
  readonly signedIn: boolean;
  readonly apiUrl: string;
  readonly error: string | undefined;
  signIn(token: string): Promise<void>;
  signOut(): Promise<void>;
  refresh(): Promise<void>;
}

const AppContext = createContext<AppState | undefined>(undefined);

export const AppProvider = ({ children }: { children: ReactNode }): React.JSX.Element => {
  const apiUrl = useMemo(resolveApiUrl, []);
  const [config, setConfig] = useState<ClientConfig>();
  const [me, setMe] = useState<MeResponse>();
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
          // The token is gone or expired; drop back to signed-out cleanly.
          setMe(undefined);
          setTokenVersion((v) => v + 1);
        },
      }),
    [apiUrl],
  );

  const realtime = useMemo(
    () => new RealtimeClient({ url: () => client.realtimeUrl() }),
    [client],
  );

  const loadMe = useCallback(async () => {
    try {
      const response = await client.me();
      setMe(response.user ? response : undefined);
    } catch {
      setMe(undefined);
    }
  }, [client]);

  // Restore a stored session and fetch the deployment config on launch.
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
          await loadMe();
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void boot();
    return () => {
      cancelled = true;
    };
  }, [client, apiUrl, loadMe]);

  const signedIn = me?.user !== undefined && me?.user !== null;

  // The socket follows the session: connected while signed in, closed after.
  useEffect(() => {
    if (!signedIn) {
      realtime.disconnect();
      return;
    }
    realtime.connect();
    return () => realtime.disconnect();
  }, [signedIn, realtime, tokenVersion]);

  const signIn = useCallback(
    async (token: string) => {
      client.setToken(token);
      await loadMe();
      setTokenVersion((v) => v + 1);
    },
    [client, loadMe],
  );

  const signOut = useCallback(async () => {
    try {
      await client.signOut();
    } catch {
      // Signing out locally matters more than the server acknowledging it.
      client.setToken(undefined);
    }
    setMe(undefined);
    setTokenVersion((v) => v + 1);
  }, [client]);

  const value = useMemo<AppState>(
    () => ({
      client,
      realtime,
      config,
      me,
      riderId: me?.rider?.id,
      loading,
      signedIn,
      apiUrl,
      error,
      signIn,
      signOut,
      refresh: loadMe,
    }),
    [client, realtime, config, me, loading, signedIn, apiUrl, error, signIn, signOut, loadMe],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
};

export const useApp = (): AppState => {
  const value = useContext(AppContext);
  if (!value) throw new Error('useApp must be used inside an AppProvider');
  return value;
};

/** The API client on its own, for screens that only make requests. */
export const useClient = (): LiftClient => useApp().client;
