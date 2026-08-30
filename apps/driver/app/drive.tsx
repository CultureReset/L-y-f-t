/**
 * The drive screen — where a driver spends their entire shift.
 *
 * One screen covers going online, receiving an offer, driving to the pickup,
 * and running the trip, because a driver should never have to navigate an app
 * while they are navigating a road. The sheet swaps contents as the ride
 * progresses; the map underneath never blinks.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Pressable, ScrollView, View } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  Badge,
  Button,
  Card,
  Column,
  Divider,
  ItineraryLines,
  MapView,
  OfferCard,
  Row,
  Sheet,
  StatTile,
  Text,
  useCountdown,
  useTheme,
  type MapMarker,
  type MapPolyline,
} from '@lift/ui';
import {
  decodePolyline,
  formatDuration,
  formatMoney,
  meetingPoint,
  metersToMiles,
  type LatLng,
  type Ride,
} from '@lift/core';
import { ApiError } from '@lift/sdk';
import { useDriver } from '../src/state/DriverProvider.js';

export default function Drive(): React.JSX.Element {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const {
    client,
    status,
    position,
    heading,
    offer,
    activeRide,
    online,
    refresh,
    goOnline,
    goOffline,
    dismissOffer,
  } = useDriver();

  const [busy, setBusy] = useState(false);

  const ride = activeRide;

  /** The leg the driver is navigating right now. */
  const currentLeg = useMemo(() => {
    if (!ride) return undefined;
    return ride.status === 'accepted' || ride.status === 'arrived'
      ? ride.legs.find((l) => l.kind === 'to_pickup')
      : ride.legs.find((l) => l.kind !== 'to_pickup');
  }, [ride]);

  const markers = useMemo<MapMarker[]>(() => {
    const out: MapMarker[] = [];
    if (position) {
      out.push({ id: 'me', kind: 'car', coordinate: position, bearing: heading ?? 0, zIndex: 30 });
    }
    if (ride) {
      out.push({
        id: 'pickup',
        kind: 'pickup',
        coordinate: meetingPoint(ride.itinerary.pickup),
      });
      out.push({
        id: 'dropoff',
        kind: 'dropoff',
        coordinate: meetingPoint(ride.itinerary.dropoff),
      });
    } else if (offer) {
      out.push({ id: 'offer-pickup', kind: 'pickup', coordinate: offer.preview.pickupCoordinates });
      out.push({ id: 'offer-dropoff', kind: 'dropoff', coordinate: offer.preview.dropoffCoordinates });
    }
    return out;
  }, [position, heading, ride, offer]);

  const polylines = useMemo<MapPolyline[]>(() => {
    if (!currentLeg?.geometry) return [];
    return [{ id: 'leg', points: decodePolyline(currentLeg.geometry), width: 6 }];
  }, [currentLeg]);

  const fitTo = useMemo<LatLng[]>(() => {
    const points = [...markers.map((m) => m.coordinate), ...(polylines[0]?.points ?? [])];
    return points;
  }, [markers, polylines]);

  const toggleOnline = async (): Promise<void> => {
    setBusy(true);
    try {
      if (online) await goOffline();
      else await goOnline();
    } catch (e) {
      Alert.alert(
        online ? 'Could not go offline' : 'Could not go online',
        e instanceof ApiError ? e.userMessage : 'Try again in a moment.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <MapView
        markers={markers}
        polylines={polylines}
        fitTo={fitTo.length > 1 ? fitTo : undefined}
        center={fitTo.length <= 1 ? position : undefined}
        zoom={fitTo.length <= 1 ? 15 : undefined}
        style={{ flex: 1 }}
      />

      {/* Status and earnings float over the map, always visible. */}
      <Row
        justify="space-between"
        style={{
          position: 'absolute',
          top: insets.top + theme.spacing.sm,
          left: theme.spacing.lg,
          right: theme.spacing.lg,
        }}
      >
        <Badge
          label={statusLabelFor(status?.availability)}
          tone={
            status?.availability === 'offline'
              ? 'neutral'
              : status?.availability === 'offered'
                ? 'warning'
                : status?.availability === 'available'
                  ? 'success'
                  : 'primary'
          }
        />
        <Pressable
          onPress={() => router.push('/earnings')}
          accessibilityRole="button"
          accessibilityLabel="Earnings"
          style={{
            backgroundColor: theme.colors.surface,
            paddingHorizontal: theme.spacing.md,
            paddingVertical: theme.spacing.xs,
            borderRadius: theme.radius.pill,
            ...theme.elevation.medium,
          }}
        >
          <Text variant="captionStrong">
            {status ? formatMoney(status.todayEarnings.total) : '—'}
          </Text>
        </Pressable>
      </Row>

      <Sheet style={{ paddingBottom: insets.bottom + theme.spacing.lg, maxHeight: '70%' }}>
        <ScrollView showsVerticalScrollIndicator={false}>
          {offer && !ride ? (
            <OfferPanel offer={offer} onResolved={dismissOffer} />
          ) : ride ? (
            <TripPanel ride={ride} onChanged={refresh} />
          ) : (
            <IdlePanel
              online={online}
              busy={busy}
              onToggle={() => void toggleOnline()}
              status={status}
            />
          )}
        </ScrollView>
      </Sheet>
    </View>
  );
}

/** What the badge over the map says, straight from the driver's availability. */
const statusLabelFor = (availability?: string): string => {
  switch (availability) {
    case 'available':
      return 'Online';
    case 'offered':
      return 'New request';
    case 'on_ride':
      return 'On a trip';
    case 'busy':
      return 'Paused';
    default:
      return 'Offline';
  }
};

/** Offline or waiting: the go-online switch and today's numbers. */
const IdlePanel = ({
  online,
  busy,
  onToggle,
  status,
}: {
  online: boolean;
  busy: boolean;
  onToggle: () => void;
  status: ReturnType<typeof useDriver>['status'];
}): React.JSX.Element => {
  const earnings = status?.todayEarnings;

  return (
    <Column gap="lg">
      <Column gap="xxs">
        <Text variant="title">{online ? "You're online" : "You're offline"}</Text>
        <Text variant="caption" color="secondary">
          {online
            ? 'Waiting for a ride request. Keep the app open.'
            : status?.canGoOnline === false
              ? (status.blockedReason ?? 'Finish onboarding to start driving.')
              : 'Go online to start receiving rides.'}
        </Text>
      </Column>

      {earnings ? (
        <Row gap="sm">
          <StatTile label="Today" value={formatMoney(earnings.total)} />
          <StatTile label="Trips" value={String(earnings.ridesCompleted)} />
          <StatTile
            label="Per hour"
            value={earnings.onlineMillis > 0 ? formatMoney(earnings.perHour) : '—'}
          />
        </Row>
      ) : null}

      {status?.eligibleRideTypes.length ? (
        <Column gap="sm">
          <Text variant="label" color="muted">
            YOU CAN DRIVE
          </Text>
          <Row gap="sm" wrap>
            {status.eligibleRideTypes.map((type) => (
              <Badge key={type.id} label={type.name} tone="neutral" />
            ))}
          </Row>
        </Column>
      ) : null}

      <Button
        label={online ? 'Go offline' : 'Go online'}
        variant={online ? 'secondary' : 'success'}
        onPress={onToggle}
        loading={busy}
        disabled={!online && status?.canGoOnline === false}
        size="lg"
      />

      {status?.canGoOnline === false ? (
        <Button
          label="Finish setting up"
          variant="ghost"
          onPress={() => router.push('/onboarding')}
        />
      ) : null}

      {/* What a driver does while waiting: look at demand, tune what they take. */}
      <Row gap="sm">
        <Button
          label="Demand"
          variant="secondary"
          size="sm"
          onPress={() => router.push('/demand')}
        />
        <Button
          label="Preferences"
          variant="secondary"
          size="sm"
          onPress={() => router.push('/preferences')}
        />
        <Button label="Account" variant="ghost" size="sm" onPress={() => router.push('/account')} />
      </Row>
    </Column>
  );
};

/**
 * An offer, with the countdown running. The accept button is huge and the
 * decline is small and out of the way — a mis-tap should cost a driver a ride
 * they wanted, not the other way round.
 */
const OfferPanel = ({
  offer,
  onResolved,
}: {
  offer: NonNullable<ReturnType<typeof useDriver>['offer']>;
  onResolved: () => void;
}): React.JSX.Element => {
  const { client, refresh } = useDriver();
  const [busy, setBusy] = useState(false);
  const countdown = useCountdown(offer.expiresAt);

  // Once the countdown runs out the offer is gone; clear it without waiting
  // for the server to tell us.
  useEffect(() => {
    if (countdown.expired) {
      onResolved();
      void refresh();
    }
  }, [countdown.expired, onResolved, refresh]);

  const accept = async (): Promise<void> => {
    setBusy(true);
    try {
      await client.acceptOffer(offer.id);
      onResolved();
      await refresh();
    } catch (e) {
      onResolved();
      Alert.alert(
        'Offer gone',
        e instanceof ApiError ? e.userMessage : 'Another driver took that ride.',
      );
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const decline = async (): Promise<void> => {
    setBusy(true);
    try {
      await client.declineOffer(offer.id);
    } catch {
      // Declining is best-effort; the offer times out regardless.
    } finally {
      onResolved();
      await refresh();
      setBusy(false);
    }
  };

  return (
    <Column gap="lg">
      <OfferCard
        payout={offer.preview.estimatedPayout}
        pickupEtaMs={offer.preview.pickupEtaMs}
        pickupDistanceMeters={offer.preview.pickupDistanceMeters}
        pickupAddress={offer.preview.pickupAddress}
        dropoffAddress={offer.preview.dropoffAddress}
        tripDistanceMeters={offer.preview.tripDistanceMeters}
        tripDurationMs={offer.preview.tripDurationMs}
        riderName={offer.preview.riderName}
        riderRating={offer.preview.riderRating}
        surgeMultiplier={offer.preview.surgeMultiplier}
        remainingMs={countdown.remainingMs}
        progress={countdown.progress}
      />

      <Button label="Accept" variant="success" size="lg" onPress={() => void accept()} loading={busy} />
      <Button label="Decline" variant="ghost" size="sm" onPress={() => void decline()} disabled={busy} />
    </Column>
  );
};

/**
 * The trip itself. One primary action at a time — arrive, start, complete —
 * so there is never a decision to make at a red light.
 */
const TripPanel = ({
  ride,
  onChanged,
}: {
  ride: Ride;
  onChanged: () => Promise<void>;
}): React.JSX.Element => {
  const theme = useTheme();
  const { client, position } = useDriver();
  const [busy, setBusy] = useState(false);
  const [rider, setRider] = useState<{ name: string; rating: number }>();

  useEffect(() => {
    void client
      .driverActiveRide()
      .then((r) => setRider(r.rider ? { name: r.rider.name, rating: r.rider.rating } : undefined))
      .catch(() => {});
  }, [client, ride.id]);

  const act = useCallback(
    async (action: () => Promise<unknown>, failureTitle: string) => {
      setBusy(true);
      try {
        await action();
        await onChanged();
      } catch (e) {
        Alert.alert(failureTitle, e instanceof ApiError ? e.userMessage : 'Try again.');
      } finally {
        setBusy(false);
      }
    },
    [onChanged],
  );

  const heading = ride.status === 'in_progress' ? ride.itinerary.dropoff : ride.itinerary.pickup;
  const leg =
    ride.status === 'in_progress'
      ? ride.legs.find((l) => l.kind !== 'to_pickup')
      : ride.legs.find((l) => l.kind === 'to_pickup');

  return (
    <Column gap="lg">
      <Column gap="xxs">
        <Text variant="label" color="muted">
          {ride.status === 'accepted'
            ? 'PICKING UP'
            : ride.status === 'arrived'
              ? 'WAITING FOR RIDER'
              : 'DROPPING OFF'}
        </Text>
        <Text variant="title">{heading.name}</Text>
        <Text variant="caption" color="secondary">
          {heading.address}
        </Text>
        {heading.pickupHint && ride.status !== 'in_progress' ? (
          <Text variant="caption" color="primary">
            {heading.pickupHint.label}
            {heading.pickupHint.instructions ? ` — ${heading.pickupHint.instructions}` : ''}
          </Text>
        ) : null}
      </Column>

      {leg ? (
        <Row gap="lg">
          <Column gap="xxs">
            <Text variant="label" color="muted">
              DISTANCE
            </Text>
            <Text variant="bodyStrong">{metersToMiles(leg.distanceMeters).toFixed(1)} mi</Text>
          </Column>
          <Column gap="xxs">
            <Text variant="label" color="muted">
              TIME
            </Text>
            <Text variant="bodyStrong">{formatDuration(leg.durationMs)}</Text>
          </Column>
          <Column gap="xxs">
            <Text variant="label" color="muted">
              FARE
            </Text>
            <Text variant="bodyStrong">{formatMoney(ride.quotedFare.driverPayout)}</Text>
          </Column>
        </Row>
      ) : null}

      {/* Turn-by-turn for the leg being driven, one tap from anywhere. */}
      <Button
        label="Navigate"
        variant="primary"
        size="lg"
        onPress={() => router.push(`/navigate/${ride.id}` as never)}
      />

      {ride.riderNote ? (
        <Card padded="md">
          <Text variant="caption" color="secondary">
            Note from your rider
          </Text>
          <Text variant="body">{ride.riderNote}</Text>
        </Card>
      ) : null}

      <Divider />
      <ItineraryLines
        pickup={ride.itinerary.pickup.name}
        dropoff={ride.itinerary.dropoff.name}
        stops={ride.itinerary.stops.map((s) => s.place.name)}
      />
      <Divider />

      {rider ? (
        <Row justify="space-between">
          <Text variant="caption" color="secondary">
            {rider.name} · ★ {rider.rating.toFixed(2)}
          </Text>
          <Pressable
            onPress={() => router.push(`/chat/${ride.id}` as never)}
            accessibilityRole="button"
            accessibilityLabel="Message rider"
          >
            <Text variant="caption" color="primary">
              Message
            </Text>
          </Pressable>
        </Row>
      ) : null}

      {ride.status === 'accepted' ? (
        <Button
          label="I've arrived"
          size="lg"
          onPress={() => void act(() => client.markArrived(ride.id), 'Could not mark arrived')}
          loading={busy}
        />
      ) : null}

      {ride.status === 'arrived' ? (
        <Button
          label="Start trip"
          variant="success"
          size="lg"
          onPress={() => void act(() => client.startTrip(ride.id), 'Could not start the trip')}
          loading={busy}
        />
      ) : null}

      {ride.status === 'in_progress' ? (
        <Button
          label="Complete trip"
          variant="success"
          size="lg"
          onPress={() =>
            void act(async () => {
              await client.completeTrip(ride.id);
              // Rate while the trip is fresh; the screen allows a skip.
              router.push({
                pathname: '/rate/[id]',
                params: { id: ride.id, ...(rider ? { name: rider.name } : {}) },
              });
            }, 'Could not complete the trip')
          }
          loading={busy}
        />
      ) : null}

      {/* Destructive, so it needs a deliberate hold rather than a tap. */}
      {ride.status !== 'in_progress' ? (
        <Button
          label="Hold to cancel"
          variant="ghost"
          size="sm"
          holdMs={1400}
          onPress={() =>
            void act(
              () => client.driverCancelRide(ride.id, { reason: 'rider_no_show' }),
              'Could not cancel',
            )
          }
        />
      ) : null}

      {position && ride.status !== 'in_progress' ? (
        <Button
          label="Re-route from here"
          variant="ghost"
          size="sm"
          onPress={() => void act(() => client.reroute(ride.id, position), 'Could not re-route')}
        />
      ) : null}
    </Column>
  );
};
