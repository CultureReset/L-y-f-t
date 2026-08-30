/**
 * Home — the map, the rider's location, and "Where to?".
 *
 * If a ride is already in flight, this screen hands straight over to tracking;
 * a rider who reopens the app mid-trip should never see a booking prompt.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import * as Location from 'expo-location';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  Badge,
  Button,
  Card,
  Column,
  MapView,
  Row,
  Sheet,
  Text,
  useTheme,
  type MapMarker,
} from '@lift/ui';
import type { LatLng, SavedPlace } from '@lift/core';
import { useApp } from '../src/state/AppProvider.js';
import { useActiveRide } from '../src/state/useActiveRide.js';

export default function Home(): React.JSX.Element {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { client, config, me, signedIn } = useApp();
  const { ride } = useActiveRide();

  const [position, setPosition] = useState<LatLng>();
  const [nearbyDrivers, setNearbyDrivers] = useState<MapMarker[]>([]);
  const [saved, setSaved] = useState<readonly SavedPlace[]>([]);

  const center = position ?? config?.market.defaultCenter ?? { lat: 37.7749, lng: -122.4194 };

  // Ask for location once; the market centre stands in until it arrives.
  useEffect(() => {
    let cancelled = false;
    const locate = async (): Promise<void> => {
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== 'granted' || cancelled) return;
        const fix = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.Balanced,
        });
        if (!cancelled) {
          setPosition({ lat: fix.coords.latitude, lng: fix.coords.longitude });
        }
      } catch {
        // Location is a convenience here, never a blocker.
      }
    };
    void locate();
    return () => {
      cancelled = true;
    };
  }, []);

  // A ride in progress takes over the app.
  useEffect(() => {
    if (ride && ride.status !== 'completed' && ride.status !== 'cancelled') {
      router.replace(`/ride/${ride.id}`);
    }
  }, [ride]);

  useFocusEffect(
    useCallback(() => {
      if (!signedIn) return;
      void client
        .savedPlaces()
        .then((r) => setSaved(r.places))
        .catch(() => {});
    }, [client, signedIn]),
  );

  /**
   * Show a few cars idling nearby. It is cosmetic — the real fleet is whatever
   * dispatch finds — but an empty map reads as "no drivers", which is worse
   * than slightly stale dots.
   */
  useEffect(() => {
    const scatter = (): void => {
      const markers: MapMarker[] = Array.from({ length: 5 }, (_, i) => {
        const angle = (i / 5) * Math.PI * 2 + Date.now() / 40_000;
        const radius = 0.006 + (i % 3) * 0.003;
        return {
          id: `nearby-${i}`,
          kind: 'car' as const,
          bearing: ((angle * 180) / Math.PI + 90) % 360,
          coordinate: {
            lat: center.lat + Math.sin(angle) * radius,
            lng: center.lng + Math.cos(angle) * radius * 1.25,
          },
        };
      });
      setNearbyDrivers(markers);
    };
    scatter();
    const timer = setInterval(scatter, 4_000);
    return () => clearInterval(timer);
  }, [center.lat, center.lng]);

  const markers = useMemo<MapMarker[]>(
    () => [
      ...nearbyDrivers,
      ...(position
        ? [{ id: 'me', kind: 'pickup' as const, coordinate: position, zIndex: 10 }]
        : []),
    ],
    [nearbyDrivers, position],
  );

  const firstName = me?.user?.firstName ?? 'there';

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <MapView
        markers={markers}
        center={center}
        zoom={14}
        interactive
        style={{ flex: 1 }}
        testID="home-map"
      />

      {/* Account and activity float over the map. */}
      <Row
        justify="space-between"
        style={{
          position: 'absolute',
          top: insets.top + theme.spacing.sm,
          left: theme.spacing.lg,
          right: theme.spacing.lg,
        }}
      >
        <FloatingButton label="☰" onPress={() => router.push('/account')} accessibilityLabel="Account" />
        <FloatingButton label="🕘" onPress={() => router.push('/activity')} accessibilityLabel="Your trips" />
      </Row>

      <Sheet style={{ paddingBottom: insets.bottom + theme.spacing.lg }}>
        <Column gap="lg">
          <Text variant="title">Where to, {firstName}?</Text>

          <Pressable
            accessibilityRole="search"
            accessibilityLabel="Choose a destination"
            onPress={() => router.push('/search')}
            style={{
              backgroundColor: theme.colors.surfaceSunken,
              borderRadius: theme.radius.lg,
              paddingHorizontal: theme.spacing.lg,
              paddingVertical: theme.spacing.lg,
              flexDirection: 'row',
              alignItems: 'center',
              gap: theme.spacing.md,
            }}
          >
            <View
              style={{
                width: 10,
                height: 10,
                borderRadius: 2,
                backgroundColor: theme.colors.dropoffPin,
              }}
            />
            <Text variant="body" color="secondary">
              Enter a destination
            </Text>
          </Pressable>

          {saved.length > 0 ? (
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <Row gap="sm">
                {saved.map((place) => (
                  <Pressable
                    key={place.id}
                    accessibilityRole="button"
                    accessibilityLabel={`Ride to ${place.label}`}
                    onPress={() =>
                      router.push({
                        pathname: '/confirm',
                        params: { dropoff: JSON.stringify(place.place) },
                      })
                    }
                  >
                    <Card padded="md" style={{ minWidth: 140 }}>
                      <Text variant="captionStrong">
                        {place.icon === 'home' ? '🏠' : place.icon === 'work' ? '💼' : '⭐'}{' '}
                        {place.label}
                      </Text>
                      <Text variant="caption" color="muted" numberOfLines={1}>
                        {place.place.address}
                      </Text>
                    </Card>
                  </Pressable>
                ))}
              </Row>
            </ScrollView>
          ) : null}

          {config ? (
            <Row gap="sm" wrap>
              <Badge label={config.market.name} tone="neutral" />
              {config.rideTypes.slice(0, 3).map((type) => (
                <Badge key={type.id} label={type.name} tone="neutral" />
              ))}
            </Row>
          ) : null}
        </Column>
      </Sheet>
    </View>
  );
}

const FloatingButton = ({
  label,
  onPress,
  accessibilityLabel,
}: {
  label: string;
  onPress: () => void;
  accessibilityLabel: string;
}): React.JSX.Element => {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      style={{
        width: 44,
        height: 44,
        borderRadius: 22,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.surface,
        ...theme.elevation.medium,
      }}
    >
      <Text variant="body">{label}</Text>
    </Pressable>
  );
};
