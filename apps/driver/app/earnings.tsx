/**
 * Earnings. The number a driver actually optimises against is per-hour, so it
 * gets equal billing with the total.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, View } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Card, Column, Divider, Row, StatTile, Text, useTheme } from '@lift/ui';
import { formatDuration, formatMoney, metersToMiles } from '@lift/core';
import type { EarningsResponse } from '@lift/sdk';
import { useDriver } from '../src/state/DriverProvider.js';

type Period = 'today' | 'week' | 'month';

export default function Earnings(): React.JSX.Element {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { client } = useDriver();

  const [period, setPeriod] = useState<Period>('today');
  const [data, setData] = useState<EarningsResponse>();
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      setData(await client.earnings(period));
    } catch {
      setData(undefined);
    } finally {
      setRefreshing(false);
    }
  }, [client, period]);

  useEffect(() => {
    void load();
  }, [load]);

  const summary = data?.summary;

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background, paddingTop: insets.top }}>
      <Row gap="md" style={{ padding: theme.spacing.lg }}>
        <Pressable onPress={() => router.back()} accessibilityRole="button" accessibilityLabel="Back" hitSlop={12}>
          <Text variant="title">←</Text>
        </Pressable>
        <Text variant="title">Earnings</Text>
      </Row>

      <Row gap="sm" style={{ paddingHorizontal: theme.spacing.lg }}>
        {(['today', 'week', 'month'] as const).map((value) => (
          <Pressable
            key={value}
            onPress={() => setPeriod(value)}
            accessibilityRole="tab"
            accessibilityState={{ selected: period === value }}
            style={{
              flex: 1,
              paddingVertical: theme.spacing.sm,
              alignItems: 'center',
              borderRadius: theme.radius.md,
              backgroundColor: period === value ? theme.colors.primaryMuted : 'transparent',
            }}
          >
            <Text variant="captionStrong" color={period === value ? 'primary' : 'secondary'}>
              {value === 'today' ? 'Today' : value === 'week' ? '7 days' : '30 days'}
            </Text>
          </Pressable>
        ))}
      </Row>

      <ScrollView
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void load()} />}
        contentContainerStyle={{
          padding: theme.spacing.lg,
          paddingBottom: insets.bottom + theme.spacing.xxl,
          gap: theme.spacing.lg,
        }}
      >
        {summary ? (
          <>
            <Column gap="xs">
              <Text variant="label" color="muted">
                TOTAL EARNED
              </Text>
              <Text variant="display">{formatMoney(summary.total)}</Text>
            </Column>

            <Row gap="sm" wrap>
              <StatTile
                label="Per hour"
                value={summary.onlineMillis > 0 ? formatMoney(summary.perHour) : '—'}
                caption={`${formatDuration(summary.onlineMillis)} online`}
              />
              <StatTile label="Trips" value={String(summary.ridesCompleted)} />
              <StatTile
                label="Driven"
                value={`${metersToMiles(summary.distanceMeters).toFixed(0)} mi`}
              />
            </Row>

            <Card>
              <Column gap="sm">
                <Row justify="space-between">
                  <Text variant="caption" color="secondary">
                    Ride earnings
                  </Text>
                  <Text variant="captionStrong">{formatMoney(summary.rideEarnings)}</Text>
                </Row>
                <Row justify="space-between">
                  <Text variant="caption" color="secondary">
                    Tips
                  </Text>
                  <Text variant="captionStrong">{formatMoney(summary.tips)}</Text>
                </Row>
                <Row justify="space-between">
                  <Text variant="caption" color="secondary">
                    Bonuses
                  </Text>
                  <Text variant="captionStrong">{formatMoney(summary.bonuses)}</Text>
                </Row>
                <Divider />
                <Row justify="space-between">
                  <Text variant="bodyStrong">Total</Text>
                  <Text variant="bodyStrong">{formatMoney(summary.total)}</Text>
                </Row>
              </Column>
            </Card>
          </>
        ) : null}

        <Column gap="sm">
          <Text variant="heading">Trips</Text>
          {(data?.rides ?? []).map((trip) => (
            <Pressable
              key={trip.rideId}
              onPress={() => router.push(`/trip/${trip.rideId}` as never)}
              accessibilityRole="button"
              accessibilityLabel={`Trip to ${trip.dropoff}`}
            >
              <Card padded="md">
              <Row justify="space-between">
                <Column gap="xxs" style={{ flex: 1 }}>
                  <Text variant="caption" numberOfLines={1}>
                    {trip.pickup} → {trip.dropoff}
                  </Text>
                  <Text variant="label" color="muted">
                    {trip.completedAt
                      ? new Date(trip.completedAt).toLocaleTimeString(undefined, {
                          hour: 'numeric',
                          minute: '2-digit',
                        })
                      : ''}
                    {trip.distanceMeters
                      ? ` · ${metersToMiles(trip.distanceMeters).toFixed(1)} mi`
                      : ''}
                    {trip.rating ? ` · ★ ${trip.rating}` : ''}
                  </Text>
                </Column>
                <Text variant="bodyStrong">{trip.payout ? formatMoney(trip.payout) : '—'}</Text>
              </Row>
              </Card>
            </Pressable>
          ))}
          {(data?.rides ?? []).length === 0 ? (
            <Text variant="caption" color="muted">
              No trips in this period yet.
            </Text>
          ) : null}
        </Column>
      </ScrollView>
    </View>
  );
}
