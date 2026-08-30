/**
 * What rides you want.
 *
 * Every control here changes what dispatch offers: opting out of a ride type
 * removes it from matching, the pickup radius is a hard filter, and the
 * destination filter is the "last ride home" every driver asks for. Nothing on
 * this screen is cosmetic.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Alert, ScrollView, View } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  Badge,
  Button,
  Card,
  Column,
  Divider,
  Field,
  OptionRow,
  Row,
  ScreenHeader,
  Section,
  Text,
  ToggleRow,
  useTheme,
} from '@lift/ui';
import { formatDuration, metersToMiles, type DriverPreferences } from '@lift/core';
import { ApiError } from '@lift/sdk';
import { useDriver } from '../src/state/DriverProvider.js';

/** Radius options in miles — a slider is unusable with gloves on. */
const RADIUS_OPTIONS = [3, 5, 8, 12, 20, 30];

const NAVIGATION_APPS: readonly { value: DriverPreferences['navigationApp']; label: string }[] = [
  { value: 'internal', label: 'Built-in navigation' },
  { value: 'google_maps', label: 'Google Maps' },
  { value: 'waze', label: 'Waze' },
  { value: 'apple_maps', label: 'Apple Maps' },
];

export default function Preferences(): React.JSX.Element {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { client, status, config, refresh } = useDriver();

  const [preferences, setPreferences] = useState<DriverPreferences>();
  const [destination, setDestination] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (status?.profile) setPreferences(status.profile.preferences);
  }, [status]);

  /**
   * Preferences save as they are changed. A driver flicking a switch at a
   * traffic light will not come back to press Save.
   */
  const patch = useCallback(
    async (next: Partial<DriverPreferences>) => {
      if (!preferences) return;
      const optimistic = { ...preferences, ...next };
      setPreferences(optimistic);
      try {
        await client.updateDriverPreferences(next);
        await refresh();
      } catch {
        setPreferences(preferences);
        Alert.alert('Could not save', 'That preference did not stick. Try again.');
      }
    },
    [client, preferences, refresh],
  );

  const setFilter = async (): Promise<void> => {
    const address = destination.trim();
    if (!address) return;
    setSaving(true);
    try {
      // Geocode through the same place search the rider app uses, so a driver
      // can type an address rather than coordinates.
      const { sections } = await client.searchPlaces({ q: address, field: 'dropoff', limit: 1 });
      const first = sections.flatMap((s) => s.results)[0];
      if (!first) {
        Alert.alert('Not found', 'We could not find that address.');
        return;
      }
      const place = first.place.coordinates.lat
        ? first.place
        : (await client.resolvePlace(first.place.externalRef!)).place;

      await client.setDestinationFilter({
        address: place.address,
        lat: place.coordinates.lat,
        lng: place.coordinates.lng,
      });
      await refresh();
      setDestination('');
    } catch (e) {
      Alert.alert('Could not set', e instanceof ApiError ? e.userMessage : 'Try again.');
    } finally {
      setSaving(false);
    }
  };

  const clearFilter = async (): Promise<void> => {
    try {
      await client.clearDestinationFilter();
      await refresh();
    } catch {
      Alert.alert('Could not clear that filter');
    }
  };

  const filter = preferences?.destinationFilter;

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background, paddingTop: insets.top }}>
      <ScreenHeader title="Ride preferences" onBack={() => router.back()} />

      <ScrollView
        contentContainerStyle={{
          padding: theme.spacing.lg,
          paddingBottom: insets.bottom + theme.spacing.xxl,
          gap: theme.spacing.xl,
        }}
        keyboardShouldPersistTaps="handled"
      >
        {preferences ? (
          <>
            <Section
              title="Ride types"
              footer="Turning one off means you stop being offered it. Leave them all on to see the most work."
            >
              {(status?.eligibleRideTypes ?? config?.rideTypes ?? []).map((rideType) => {
                // An empty list means "everything", which is the default.
                const accepted =
                  preferences.acceptedRideTypeIds.length === 0 ||
                  preferences.acceptedRideTypeIds.includes(rideType.id);
                return (
                  <ToggleRow
                    key={rideType.id}
                    label={`${rideType.icon} ${rideType.name}`}
                    description={rideType.tagline}
                    value={accepted}
                    onValueChange={(value) => {
                      const all = (status?.eligibleRideTypes ?? config?.rideTypes ?? []).map(
                        (t) => t.id,
                      );
                      const current =
                        preferences.acceptedRideTypeIds.length === 0
                          ? all
                          : [...preferences.acceptedRideTypeIds];
                      const next = value
                        ? [...new Set([...current, rideType.id])]
                        : current.filter((id) => id !== rideType.id);
                      if (next.length === 0) {
                        Alert.alert(
                          'Keep at least one',
                          'You would not be offered any rides at all.',
                        );
                        return;
                      }
                      void patch({ acceptedRideTypeIds: next });
                    }}
                  />
                );
              })}
            </Section>

            <Section
              title="How far you will go for a pickup"
              footer={`Currently ${metersToMiles(preferences.maxPickupDistanceMeters).toFixed(0)} miles.`}
            >
              <Row gap="sm" wrap style={{ paddingVertical: theme.spacing.md }}>
                {RADIUS_OPTIONS.map((miles) => {
                  const meters = Math.round(miles * 1609.344);
                  const selected =
                    Math.abs(preferences.maxPickupDistanceMeters - meters) < 200;
                  return (
                    <Button
                      key={miles}
                      label={`${miles} mi`}
                      variant={selected ? 'primary' : 'secondary'}
                      size="sm"
                      onPress={() => void patch({ maxPickupDistanceMeters: meters })}
                    />
                  );
                })}
              </Row>
            </Section>

            <Section
              title="Heading somewhere?"
              footer="Only rides going roughly your way. It expires on its own so you are never stuck with it."
            >
              {filter ? (
                <Card padded="md">
                  <Column gap="sm">
                    <Text variant="caption">{filter.address}</Text>
                    <Row gap="sm" align="center">
                      <Badge label={`${metersToMiles(filter.radiusMeters).toFixed(0)} mi`} />
                      <Text variant="caption" color="muted">
                        expires in {formatDuration(Math.max(0, filter.expiresAt - Date.now()))}
                      </Text>
                    </Row>
                    <Button
                      label="Clear filter"
                      variant="ghost"
                      size="sm"
                      onPress={() => void clearFilter()}
                    />
                  </Column>
                </Card>
              ) : (
                <Column gap="md" style={{ paddingVertical: theme.spacing.sm }}>
                  <Field
                    label="Where are you heading?"
                    value={destination}
                    onChangeText={setDestination}
                    placeholder="Home, or an address"
                  />
                  <Button
                    label="Only rides going this way"
                    onPress={() => void setFilter()}
                    disabled={destination.trim().length === 0 || saving}
                    loading={saving}
                  />
                </Column>
              )}
            </Section>

            <Section
              title="Offers"
              footer="Auto-accept takes every ride that matches these preferences without asking."
            >
              <ToggleRow
                label="Accept offers automatically"
                description="No countdown, no tap. You still see the trip once it is yours."
                value={preferences.autoAcceptOffers}
                onValueChange={(value) => void patch({ autoAcceptOffers: value })}
              />
            </Section>

            <Section title="Navigation">
              {NAVIGATION_APPS.map((option) => (
                <OptionRow
                  key={option.value}
                  label={option.label}
                  selected={preferences.navigationApp === option.value}
                  onSelect={() => void patch({ navigationApp: option.value })}
                />
              ))}
            </Section>

            <Divider />
          </>
        ) : null}
      </ScrollView>
    </View>
  );
}
