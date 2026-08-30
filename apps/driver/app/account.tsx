/**
 * Driver account: profile, ratings, preferences, and the destination filter.
 */

import React, { useState } from 'react';
import { Alert, Pressable, ScrollView, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  Avatar,
  Badge,
  Button,
  Card,
  Column,
  Divider,
  Rating,
  Row,
  StatTile,
  Text,
  useTheme,
} from '@lift/ui';
import { formatMoney } from '@lift/core';
import { useDriver } from '../src/state/DriverProvider.js';

export default function Account(): React.JSX.Element {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { client, me, status, config, apiUrl, signOut, refresh } = useDriver();

  const [destination, setDestination] = useState('');
  const [busy, setBusy] = useState(false);

  const user = me?.user;
  const profile = status?.profile;
  const filter = profile?.preferences.destinationFilter;

  const setFilter = async (): Promise<void> => {
    if (!config) return;
    setBusy(true);
    try {
      // Resolve the typed address, then filter for rides that end near it.
      const { sections } = await client.searchPlaces({
        q: destination,
        near: config.market.defaultCenter,
        field: 'dropoff',
        limit: 1,
      });
      const place = sections.flatMap((s) => s.results)[0]?.place;
      if (!place) {
        Alert.alert('Not found', 'We could not find that address.');
        return;
      }
      await client.setDestinationFilter({
        address: place.name,
        lat: place.coordinates.lat,
        lng: place.coordinates.lng,
        radiusMeters: 3_000,
        durationMs: 2 * 60 * 60 * 1000,
      });
      setDestination('');
      await refresh();
    } catch {
      Alert.alert('Could not set filter', 'Try again in a moment.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background, paddingTop: insets.top }}>
      <Row gap="md" style={{ padding: theme.spacing.lg }}>
        <Pressable onPress={() => router.back()} accessibilityRole="button" accessibilityLabel="Back" hitSlop={12}>
          <Text variant="title">←</Text>
        </Pressable>
        <Text variant="title">Account</Text>
      </Row>

      <ScrollView
        contentContainerStyle={{
          padding: theme.spacing.lg,
          paddingBottom: insets.bottom + theme.spacing.xxl,
          gap: theme.spacing.lg,
        }}
      >
        {user ? (
          <Row gap="lg">
            <Avatar name={user.displayName} url={user.avatarUrl} size={64} />
            <Column gap="xxs" style={{ flex: 1 }}>
              <Text variant="heading">{user.displayName}</Text>
              {profile ? <Rating value={profile.rating} count={profile.ratingCount} size="md" /> : null}
              <Text variant="caption" color="secondary">
                Driving since{' '}
                {profile ? new Date(profile.memberSince).getFullYear() : '—'}
              </Text>
            </Column>
          </Row>
        ) : null}

        {profile ? (
          <Row gap="sm" wrap>
            <StatTile label="Trips" value={String(profile.totalRides)} />
            <StatTile
              label="Acceptance"
              value={`${Math.round(profile.acceptanceRate * 100)}%`}
            />
            <StatTile
              label="Completion"
              value={`${Math.round(profile.completionRate * 100)}%`}
            />
          </Row>
        ) : null}

        {status?.vehicle ? (
          <Card>
            <Column gap="xxs">
              <Text variant="label" color="muted">
                YOUR VEHICLE
              </Text>
              <Text variant="bodyStrong">
                {status.vehicle.year} {status.vehicle.make} {status.vehicle.model}
              </Text>
              <Text variant="caption" color="secondary">
                {status.vehicle.color} · {status.vehicle.licensePlate}
              </Text>
              <Row gap="sm" wrap style={{ marginTop: theme.spacing.sm }}>
                {status.eligibleRideTypes.map((type) => (
                  <Badge key={type.id} label={type.name} tone="neutral" />
                ))}
              </Row>
            </Column>
          </Card>
        ) : null}

        <Divider />

        <Column gap="sm">
          <Text variant="heading">Destination filter</Text>
          <Text variant="caption" color="secondary">
            Only get rides heading your way — useful for the last trip of a shift.
          </Text>
          {filter ? (
            <Card padded="md">
              <Row justify="space-between">
                <Column gap="xxs" style={{ flex: 1 }}>
                  <Text variant="bodyStrong">{filter.address}</Text>
                  <Text variant="caption" color="muted">
                    Until {new Date(filter.expiresAt).toLocaleTimeString(undefined, {
                      hour: 'numeric',
                      minute: '2-digit',
                    })}
                  </Text>
                </Column>
                <Pressable
                  onPress={() => {
                    void client.clearDestinationFilter().then(() => void refresh());
                  }}
                  accessibilityRole="button"
                  accessibilityLabel="Clear destination filter"
                >
                  <Text variant="caption" color="danger">
                    Clear
                  </Text>
                </Pressable>
              </Row>
            </Card>
          ) : (
            <Row gap="sm">
              <TextInput
                style={{
                  flex: 1,
                  backgroundColor: theme.colors.surfaceSunken,
                  borderRadius: theme.radius.md,
                  paddingHorizontal: theme.spacing.md,
                  paddingVertical: theme.spacing.md,
                  color: theme.colors.text,
                }}
                placeholder="Where are you heading?"
                placeholderTextColor={theme.colors.textMuted}
                value={destination}
                onChangeText={setDestination}
                onSubmitEditing={() => void setFilter()}
                accessibilityLabel="Destination filter address"
              />
              <Button
                label="Set"
                fullWidth={false}
                size="sm"
                onPress={() => void setFilter()}
                loading={busy}
                disabled={destination.trim().length < 3}
              />
            </Row>
          )}
        </Column>

        <Divider />

        <Column gap="sm">
          <Button label="Earnings" variant="secondary" onPress={() => router.push('/earnings')} />
          <Button label="Vehicle & documents" variant="secondary" onPress={() => router.push('/onboarding')} />
          <Button
            label="Sign out"
            variant="ghost"
            onPress={() => {
              Alert.alert('Sign out?', 'You will go offline and stop receiving rides.', [
                { text: 'Stay', style: 'cancel' },
                {
                  text: 'Sign out',
                  style: 'destructive',
                  onPress: () => {
                    void signOut().then(() => router.replace('/sign-in'));
                  },
                },
              ]);
            }}
          />
        </Column>

        <Column gap="xxs">
          <Text variant="label" color="muted">
            CONNECTED TO
          </Text>
          <Text variant="caption" color="muted">
            {apiUrl}
          </Text>
        </Column>
      </ScrollView>
    </View>
  );
}
