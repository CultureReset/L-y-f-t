/**
 * Your trips: what is booked for later, and what has already happened.
 *
 * Scheduled rides sit above history because they are the ones that still need
 * a decision — they can be cancelled from here, which is otherwise impossible
 * before dispatch wakes them up.
 */

import React, { useCallback, useState } from 'react';
import { Alert, RefreshControl, ScrollView, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  Badge,
  Button,
  Card,
  Column,
  Divider,
  EmptyState,
  ItineraryLines,
  RideStatusPill,
  Row,
  ScreenHeader,
  Text,
  useTheme,
} from '@lift/ui';
import { formatMoney, type Ride } from '@lift/core';
import { ApiError } from '@lift/sdk';
import { useApp } from '../src/state/AppProvider.js';
import { goBack } from '../src/navigation.js';

export default function Activity(): React.JSX.Element {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { client } = useApp();

  const [rides, setRides] = useState<readonly Ride[]>([]);
  const [scheduled, setScheduled] = useState<readonly Ride[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const [history, upcoming] = await Promise.all([
        client.rideHistory({ limit: 30 }),
        client.scheduledRides().catch(() => ({ rides: [] as Ride[] })),
      ]);
      setRides(history.rides);
      setScheduled(upcoming.rides);
    } catch {
      setRides([]);
    } finally {
      setRefreshing(false);
    }
  }, [client]);

  // Booking a ride for later returns here, so refresh on focus rather than
  // only on mount.
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const cancelScheduled = (ride: Ride): void => {
    Alert.alert(
      'Cancel this scheduled ride?',
      `${whenLabel(ride.scheduledFor)} · ${ride.itinerary.dropoff.name}`,
      [
        { text: 'Keep it', style: 'cancel' },
        {
          text: 'Cancel ride',
          style: 'destructive',
          onPress: () => {
            void client
              .cancelRide(ride.id, { reason: 'rider_changed_mind' })
              .then(() => void load())
              .catch((e: unknown) =>
                Alert.alert(
                  'Could not cancel',
                  e instanceof ApiError ? e.userMessage : 'Try again.',
                ),
              );
          },
        },
      ],
    );
  };

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background, paddingTop: insets.top }}>
      <ScreenHeader title="Your trips" onBack={() => goBack('/home')} />

      <ScrollView
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void load()} />}
        contentContainerStyle={{
          padding: theme.spacing.lg,
          paddingBottom: insets.bottom + theme.spacing.xxl,
          gap: theme.spacing.lg,
        }}
      >
        {scheduled.length > 0 ? (
          <Column gap="sm">
            <Text variant="label" color="muted">
              BOOKED FOR LATER
            </Text>
            {scheduled.map((ride) => (
              <Card key={ride.id}>
                <Column gap="md">
                  <Row justify="space-between" align="center">
                    <Badge label={whenLabel(ride.scheduledFor)} tone="primary" />
                    <Text variant="bodyStrong">{formatMoney(ride.quotedFare.total)}</Text>
                  </Row>
                  <ItineraryLines
                    pickup={ride.itinerary.pickup.name}
                    dropoff={ride.itinerary.dropoff.name}
                    stops={ride.itinerary.stops.map((s) => s.place.name)}
                  />
                  <Row gap="sm">
                    <Button
                      label="Cancel"
                      variant="ghost"
                      size="sm"
                      onPress={() => cancelScheduled(ride)}
                    />
                  </Row>
                </Column>
              </Card>
            ))}
            <Divider />
          </Column>
        ) : null}

        {rides.length === 0 && scheduled.length === 0 ? (
          <EmptyState
            icon="🚗"
            title="No trips yet"
            message="Your rides show up here with a receipt for each one."
            action={<Button label="Book a ride" onPress={() => router.replace('/home')} />}
          />
        ) : null}

        {rides.map((ride) => {
          const fare = ride.finalFare ?? ride.quotedFare;
          return (
            <Card key={ride.id}>
              <Column gap="md">
                <Row justify="space-between">
                  <Text variant="caption" color="muted">
                    {new Date(ride.completedAt ?? ride.createdAt).toLocaleDateString(undefined, {
                      month: 'short',
                      day: 'numeric',
                      hour: 'numeric',
                      minute: '2-digit',
                    })}
                  </Text>
                  <RideStatusPill status={ride.status} />
                </Row>

                <ItineraryLines
                  pickup={ride.itinerary.pickup.name}
                  dropoff={ride.itinerary.dropoff.name}
                  stops={ride.itinerary.stops.map((s) => s.place.name)}
                />

                <Row justify="space-between" align="center">
                  <Text variant="caption" color="secondary">
                    {fare.distanceMeters > 0
                      ? `${(fare.distanceMeters / 1609.344).toFixed(1)} mi`
                      : ''}
                  </Text>
                  <Text variant="bodyStrong">{formatMoney(fare.total)}</Text>
                </Row>

                <Divider />

                <Row gap="sm">
                  {/* A receipt only exists once a ride finished. */}
                  {ride.status === 'completed' ? (
                    <Button
                      label="Receipt"
                      variant="secondary"
                      size="sm"
                      onPress={() => router.push(`/receipt/${ride.id}`)}
                    />
                  ) : null}
                  <Button
                    label="Get help"
                    variant="ghost"
                    size="sm"
                    onPress={() =>
                      router.push({ pathname: '/support', params: { rideId: ride.id } })
                    }
                  />
                </Row>
              </Column>
            </Card>
          );
        })}
      </ScrollView>
    </View>
  );
}

/** "Tomorrow 6:15 PM" — what a rider needs to recognise a booking. */
const whenLabel = (at?: number): string => {
  if (at === undefined) return 'Scheduled';
  const when = new Date(at);
  const today = new Date();
  const tomorrow = new Date(today.getTime() + 86_400_000);
  const time = when.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

  if (when.toDateString() === today.toDateString()) return `Today ${time}`;
  if (when.toDateString() === tomorrow.toDateString()) return `Tomorrow ${time}`;
  return `${when.toLocaleDateString(undefined, { weekday: 'short' })} ${when.getDate()} ${time}`;
};
