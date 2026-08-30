/**
 * Confirm the ride: the route on the map, a price per class of service, and
 * the button that actually books it.
 *
 * The quote is server-computed and carries an id; booking cites that id so the
 * price the rider confirms is provably the price they were shown.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import * as Location from 'expo-location';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  Button,
  Column,
  Divider,
  ItineraryLines,
  MapView,
  RideTypeOption,
  Row,
  Sheet,
  Text,
  useTheme,
  type MapMarker,
  type MapPolyline,
} from '@lift/ui';
import {
  decodePolyline,
  formatDuration,
  formatMoney,
  meetingPoint,
  type LatLng,
  type Place,
} from '@lift/core';
import { ApiError, type PaymentMethodView, type QuoteResponse } from '@lift/sdk';
import { useApp } from '../src/state/AppProvider.js';

export default function Confirm(): React.JSX.Element {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { client, config } = useApp();
  const params = useLocalSearchParams<{ pickup?: string; dropoff?: string }>();

  const [pickup, setPickup] = useState<Place>();
  const [dropoff, setDropoff] = useState<Place>();
  const [quote, setQuote] = useState<QuoteResponse>();
  const [selected, setSelected] = useState<string>();
  const [method, setMethod] = useState<PaymentMethodView>();
  const [passengers, setPassengers] = useState(1);
  const [loading, setLoading] = useState(true);
  const [booking, setBooking] = useState(false);
  const [error, setError] = useState<string>();

  // The dropoff arrives from search; the pickup defaults to where the rider is.
  useEffect(() => {
    if (params.dropoff) {
      try {
        setDropoff(JSON.parse(params.dropoff) as Place);
      } catch {
        setError('That destination could not be read.');
      }
    }
    if (params.pickup) {
      try {
        setPickup(JSON.parse(params.pickup) as Place);
      } catch {
        /* fall through to the current-location default */
      }
    }
  }, [params.pickup, params.dropoff]);

  /**
   * Work out the pickup point. A location fix is the best answer, but it can be
   * denied, or simply never resolve — so it is raced against a timeout and
   * falls back to the market centre. The rider always ends up with a pickup
   * they can then correct by hand, rather than a spinner that never stops.
   */
  useEffect(() => {
    if (pickup || params.pickup || !config) return;
    let cancelled = false;

    // The timeout wraps the permission prompt as well as the fix itself: a
    // prompt the user never answers hangs just as effectively as a slow GPS.
    const currentPosition = async (): Promise<LatLng | undefined> => {
      const attempt = async (): Promise<LatLng | undefined> => {
        const permission = await Location.requestForegroundPermissionsAsync();
        if (!permission.granted) return undefined;
        const fix = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.Balanced,
        });
        return { lat: fix.coords.latitude, lng: fix.coords.longitude };
      };

      try {
        return await Promise.race([
          attempt(),
          new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 5_000)),
        ]);
      } catch {
        return undefined;
      }
    };

    const resolvePickup = async (): Promise<void> => {
      const coordinates = (await currentPosition()) ?? config.market.defaultCenter;
      if (cancelled) return;
      try {
        const { place } = await client.reverseGeocode(coordinates);
        if (!cancelled) setPickup(place);
      } catch {
        if (!cancelled) setError('We could not work out your pickup point. Tap to set it.');
      }
    };

    void resolvePickup();
    return () => {
      cancelled = true;
    };
  }, [client, config, pickup, params.pickup]);

  useEffect(() => {
    void client
      .paymentMethods()
      .then((r) => setMethod(r.methods.find((m) => m.isDefault) ?? r.methods[0]))
      .catch(() => {});
  }, [client]);

  const loadQuote = useCallback(async () => {
    if (!pickup || !dropoff) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(undefined);
    try {
      const response = await client.quote({ pickup, dropoff, passengerCount: passengers });
      setQuote(response);
      // Keep the rider's choice if it is still offered; otherwise pick the
      // first available tier.
      setSelected((current) => {
        const stillValid = response.quotes.find((q) => q.rideTypeId === current && q.available);
        return stillValid?.rideTypeId ?? response.quotes.find((q) => q.available)?.rideTypeId;
      });
    } catch (e) {
      setError(e instanceof ApiError ? e.userMessage : 'Could not price that trip.');
    } finally {
      setLoading(false);
    }
  }, [client, pickup, dropoff, passengers]);

  useEffect(() => {
    void loadQuote();
  }, [loadQuote]);

  // A quote goes stale; refresh it before it expires rather than failing the
  // booking with an expired-quote error.
  useEffect(() => {
    if (!quote) return;
    const msUntilRefresh = Math.max(5_000, quote.expiresAt - Date.now() - 30_000);
    const timer = setTimeout(() => void loadQuote(), msUntilRefresh);
    return () => clearTimeout(timer);
  }, [quote, loadQuote]);

  const chosen = useMemo(
    () => quote?.quotes.find((q) => q.rideTypeId === selected),
    [quote, selected],
  );

  const book = async (): Promise<void> => {
    if (!pickup || !dropoff || !chosen || !quote) return;
    setBooking(true);
    setError(undefined);
    try {
      const { ride } = await client.requestRide({
        rideTypeId: chosen.rideTypeId,
        pickup,
        dropoff,
        passengerCount: passengers,
        quoteId: quote.quoteId,
        ...(method ? { paymentMethodId: method.id } : {}),
      });
      router.replace(`/ride/${ride.id}`);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'quote_expired') {
        // Silently re-price and let the rider confirm the fresh number.
        await loadQuote();
        setError('That price expired, so we refreshed it. Tap again to confirm.');
      } else {
        setError(e instanceof ApiError ? e.userMessage : 'Could not book that ride.');
      }
    } finally {
      setBooking(false);
    }
  };

  const markers = useMemo<MapMarker[]>(() => {
    const out: MapMarker[] = [];
    if (pickup) out.push({ id: 'pickup', kind: 'pickup', coordinate: meetingPoint(pickup) });
    if (dropoff) out.push({ id: 'dropoff', kind: 'dropoff', coordinate: meetingPoint(dropoff) });
    return out;
  }, [pickup, dropoff]);

  const polylines = useMemo<MapPolyline[]>(
    () =>
      quote?.route.geometry
        ? [{ id: 'route', points: decodePolyline(quote.route.geometry), width: 5 }]
        : [],
    [quote],
  );

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <MapView
        markers={markers}
        polylines={polylines}
        fitTo={[...markers.map((m) => m.coordinate), ...(polylines[0]?.points ?? [])]}
        style={{ flex: 1 }}
        testID="confirm-map"
      />

      <Pressable
        onPress={() => router.back()}
        accessibilityRole="button"
        accessibilityLabel="Back"
        style={{
          position: 'absolute',
          top: insets.top + theme.spacing.sm,
          left: theme.spacing.lg,
          width: 44,
          height: 44,
          borderRadius: 22,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: theme.colors.surface,
          ...theme.elevation.medium,
        }}
      >
        <Text variant="title">←</Text>
      </Pressable>

      <Sheet style={{ paddingBottom: insets.bottom + theme.spacing.lg, maxHeight: '68%' }}>
        <Column gap="md">
          {dropoff ? (
            <Pressable
              onPress={() =>
                router.push({ pathname: '/search', params: { field: 'pickup' } })
              }
              accessibilityRole="button"
              accessibilityLabel="Change pickup"
            >
              <ItineraryLines
                pickup={pickup?.name ?? 'Tap to set your pickup'}
                dropoff={dropoff.name}
              />
            </Pressable>
          ) : null}

          <Divider />

          {!quote ? (
            <Column gap="md" style={{ paddingVertical: theme.spacing.xl }}>
              {loading ? <ActivityIndicator color={theme.colors.primary} /> : null}
              <Text variant="caption" color="muted" align="center">
                {loading
                  ? 'Pricing your trip…'
                  : pickup
                    ? 'Choose a destination to see prices.'
                    : 'Set your pickup to see prices.'}
              </Text>
            </Column>
          ) : null}

          {quote ? (
            <>
              <Row justify="space-between">
                <Text variant="caption" color="secondary">
                  {formatDuration(quote.route.durationMs)} ·{' '}
                  {(quote.route.distanceMeters / 1609.344).toFixed(1)} mi
                </Text>
                <PassengerStepper value={passengers} onChange={setPassengers} />
              </Row>

              <ScrollView style={{ maxHeight: 280 }} showsVerticalScrollIndicator={false}>
                <Column gap="xs">
                  {quote.quotes.map((option) => (
                    <RideTypeOption
                      key={option.rideTypeId}
                      quote={option}
                      selected={option.rideTypeId === selected}
                      onSelect={() => setSelected(option.rideTypeId)}
                    />
                  ))}
                </Column>
              </ScrollView>

              <Divider />

              <Pressable
                onPress={() => router.push('/wallet')}
                accessibilityRole="button"
                accessibilityLabel="Change payment method"
              >
                <Row justify="space-between">
                  <Text variant="caption" color="secondary">
                    {method ? `💳 ${method.displayLabel}` : '💳 Add a payment method'}
                  </Text>
                  <Text variant="caption" color="primary">
                    Change
                  </Text>
                </Row>
              </Pressable>
            </>
          ) : null}

          {error ? (
            <Text variant="caption" color="danger">
              {error}
            </Text>
          ) : null}

          <Button
            label={chosen ? `Confirm ${chosen.name}` : 'Choose a ride'}
            caption={chosen ? formatMoney(chosen.fare.total) : undefined}
            onPress={() => void book()}
            loading={booking}
            disabled={!chosen || loading}
          />
        </Column>
      </Sheet>
    </View>
  );
}

const PassengerStepper = ({
  value,
  onChange,
}: {
  value: number;
  onChange: (next: number) => void;
}): React.JSX.Element => {
  const theme = useTheme();
  const step = (delta: number): void => onChange(Math.max(1, Math.min(6, value + delta)));

  return (
    <Row gap="sm">
      <Pressable
        onPress={() => step(-1)}
        disabled={value <= 1}
        accessibilityRole="button"
        accessibilityLabel="Fewer passengers"
        hitSlop={8}
      >
        <Text variant="bodyStrong" color={value <= 1 ? 'muted' : 'primary'}>
          −
        </Text>
      </Pressable>
      <Text variant="caption">
        {value} {value === 1 ? 'rider' : 'riders'}
      </Text>
      <Pressable
        onPress={() => step(1)}
        disabled={value >= 6}
        accessibilityRole="button"
        accessibilityLabel="More passengers"
        hitSlop={8}
      >
        <Text variant="bodyStrong" color={value >= 6 ? 'muted' : 'primary'}>
          +
        </Text>
      </Pressable>
    </Row>
  );
};
