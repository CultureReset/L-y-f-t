/**
 * One finished trip.
 *
 * A driver's question about a trip is always the same: why did it pay what it
 * paid? So the fare is shown as its line items, and the driver's share is shown
 * beside the platform's, rather than as one number they have to take on trust.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  Badge,
  Button,
  Card,
  Column,
  Divider,
  ItineraryLines,
  Row,
  ScreenHeader,
  Section,
  Text,
  useTheme,
} from '@lift/ui';
import { formatDuration, formatMoney, metersToMiles, subtract, type Ride } from '@lift/core';
import { useDriver } from '../../src/state/DriverProvider.js';

export default function Trip(): React.JSX.Element {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { client } = useDriver();
  const { id } = useLocalSearchParams<{ id: string }>();

  const [ride, setRide] = useState<Ride>();
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      setRide((await client.ride(id)).ride ?? undefined);
    } catch {
      setRide(undefined);
    } finally {
      setLoading(false);
    }
  }, [client, id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: theme.colors.background,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <ActivityIndicator color={theme.colors.primary} />
      </View>
    );
  }

  if (!ride) {
    return (
      <View style={{ flex: 1, backgroundColor: theme.colors.background, paddingTop: insets.top }}>
        <ScreenHeader title="Trip" onBack={() => router.back()} />
        <Text variant="body" color="muted" align="center" style={{ padding: theme.spacing.xl }}>
          That trip is no longer available.
        </Text>
      </View>
    );
  }

  const fare = ride.finalFare ?? ride.quotedFare;
  // What the platform kept: everything the rider paid, minus the driver's cut.
  const platformShare = subtract(fare.total, fare.driverPayout);

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background, paddingTop: insets.top }}>
      <ScreenHeader
        title="Trip"
        {...(ride.completedAt
          ? { subtitle: new Date(ride.completedAt).toLocaleString() }
          : {})}
        onBack={() => router.back()}
      />

      <Column
        gap="xl"
        style={{
          padding: theme.spacing.lg,
          paddingBottom: insets.bottom + theme.spacing.xxl,
          flex: 1,
        }}
      >
        <Card>
          <Column gap="md">
            <Row justify="space-between" align="center">
              <Text variant="label" color="muted">
                YOU EARNED
              </Text>
              <Text variant="display">{formatMoney(fare.driverPayout)}</Text>
            </Row>
            <Divider />
            <ItineraryLines
              pickup={ride.itinerary.pickup.name}
              dropoff={ride.itinerary.dropoff.name}
              stops={ride.itinerary.stops.map((s) => s.place.name)}
            />
            <Row gap="sm" wrap>
              <Badge label={`${metersToMiles(fare.distanceMeters).toFixed(1)} mi`} />
              {ride.startedAt && ride.completedAt ? (
                <Badge label={formatDuration(ride.completedAt - ride.startedAt)} />
              ) : null}
              {fare.surgeMultiplier > 1 ? (
                <Badge label={`${fare.surgeMultiplier.toFixed(1)}× surge`} tone="warning" />
              ) : null}
              {ride.driverRating ? (
                <Badge label={`${'★'.repeat(ride.driverRating.stars)}`} tone="success" />
              ) : null}
            </Row>
          </Column>
        </Card>

        <Section title="What the rider paid">
          <Column gap="sm" style={{ paddingVertical: theme.spacing.sm }}>
            {fare.items.map((item) => (
              <Row key={item.code} justify="space-between" gap="lg">
                <Column gap="xxs" style={{ flex: 1 }}>
                  <Text variant="caption">{item.label}</Text>
                  {item.detail ? (
                    <Text variant="caption" color="muted">
                      {item.detail}
                    </Text>
                  ) : null}
                </Column>
                <Text
                  variant="captionStrong"
                  color={item.amount.amount < 0 ? 'success' : 'default'}
                >
                  {formatMoney(item.amount)}
                </Text>
              </Row>
            ))}
            <Divider />
            <Row justify="space-between">
              <Text variant="bodyStrong">Rider paid</Text>
              <Text variant="bodyStrong">{formatMoney(fare.total)}</Text>
            </Row>
          </Column>
        </Section>

        <Section
          title="How it was split"
          footer="A promo or discount comes out of the platform's share, never yours."
        >
          <Column gap="sm" style={{ paddingVertical: theme.spacing.sm }}>
            <Row justify="space-between">
              <Text variant="caption" color="secondary">
                Your share
              </Text>
              <Text variant="captionStrong">{formatMoney(fare.driverPayout)}</Text>
            </Row>
            <Row justify="space-between">
              <Text variant="caption" color="secondary">
                Platform
              </Text>
              <Text variant="captionStrong">{formatMoney(platformShare)}</Text>
            </Row>
          </Column>
        </Section>

        <Button
          label="Something looks wrong"
          variant="ghost"
          onPress={() =>
            router.push({
              pathname: '/support',
              params: { rideId: ride.id, category: 'earnings' },
            })
          }
        />
      </Column>
    </View>
  );
}
