/**
 * Trip history, with the receipt for each finished ride.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { FlatList, Pressable, RefreshControl, View } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  Card,
  Column,
  ItineraryLines,
  RideStatusPill,
  Row,
  Text,
  useTheme,
} from '@lift/ui';
import { formatMoney, type Ride } from '@lift/core';
import { useApp } from '../src/state/AppProvider.js';

export default function Activity(): React.JSX.Element {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { client } = useApp();

  const [rides, setRides] = useState<Ride[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const { rides: history } = await client.rideHistory({ limit: 30 });
      setRides(history);
    } catch {
      setRides([]);
    } finally {
      setRefreshing(false);
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background, paddingTop: insets.top }}>
      <Row gap="md" style={{ padding: theme.spacing.lg }}>
        <Pressable onPress={() => router.back()} accessibilityRole="button" accessibilityLabel="Back" hitSlop={12}>
          <Text variant="title">←</Text>
        </Pressable>
        <Text variant="title">Your trips</Text>
      </Row>

      <FlatList
        data={rides}
        keyExtractor={(ride) => ride.id}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void load()} />}
        contentContainerStyle={{
          padding: theme.spacing.lg,
          paddingBottom: insets.bottom + theme.spacing.xxl,
          gap: theme.spacing.md,
        }}
        renderItem={({ item }) => (
          <Pressable onPress={() => router.push(`/ride/${item.id}`)} accessibilityRole="button">
            <Card>
              <Column gap="md">
                <Row justify="space-between">
                  <Text variant="caption" color="muted">
                    {new Date(item.completedAt ?? item.createdAt).toLocaleDateString(undefined, {
                      month: 'short',
                      day: 'numeric',
                      hour: 'numeric',
                      minute: '2-digit',
                    })}
                  </Text>
                  <RideStatusPill status={item.status} />
                </Row>

                <ItineraryLines
                  pickup={item.itinerary.pickup.name}
                  dropoff={item.itinerary.dropoff.name}
                />

                <Row justify="space-between">
                  <Text variant="caption" color="secondary">
                    {(item.finalFare ?? item.quotedFare).distanceMeters > 0
                      ? `${((item.finalFare ?? item.quotedFare).distanceMeters / 1609.344).toFixed(1)} mi`
                      : ''}
                  </Text>
                  <Text variant="bodyStrong">
                    {formatMoney((item.finalFare ?? item.quotedFare).total)}
                  </Text>
                </Row>
              </Column>
            </Card>
          </Pressable>
        )}
        ListEmptyComponent={
          <Text variant="body" color="muted" align="center" style={{ paddingVertical: theme.spacing.xxxl }}>
            No trips yet. Your rides will show up here.
          </Text>
        }
      />
    </View>
  );
}
