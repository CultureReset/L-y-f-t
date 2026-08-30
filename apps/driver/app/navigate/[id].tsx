/**
 * Turn-by-turn navigation.
 *
 * Built for a phone on a windscreen mount: the next manoeuvre fills the top of
 * the screen at a size readable at a glance, and nothing else competes with it.
 * Everything secondary — the step list, the ETA — sits below the fold.
 *
 * The route is recomputed from the driver's live position as they move, so a
 * missed turn corrects itself rather than leaving stale instructions on screen.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Linking, Platform, Pressable, ScrollView, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import * as Location from 'expo-location';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  Button,
  Column,
  Divider,
  MapView,
  Row,
  Text,
  useTheme,
  type MapMarker,
  type MapPolyline,
} from '@lift/ui';
import { decodePolyline, formatDuration, haversineMeters, type LatLng } from '@lift/core';
import type { NavigationResponse, RouteStepView } from '@lift/sdk';
import { useDriver } from '../../src/state/DriverProvider.js';

/** A glyph per manoeuvre. Big, unambiguous, and readable in peripheral vision. */
const MANEUVER_ICONS: Record<string, string> = {
  depart: '▲',
  turn_left: '↰',
  turn_right: '↱',
  turn_slight_left: '↖',
  turn_slight_right: '↗',
  turn_sharp_left: '⬉',
  turn_sharp_right: '⬈',
  continue: '↑',
  merge: '⤵',
  roundabout: '↻',
  fork_left: '↖',
  fork_right: '↗',
  arrive: '◉',
};

/** How close counts as "you have done this turn". */
const STEP_REACHED_METERS = 30;

export default function Navigate(): React.JSX.Element {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { client } = useDriver();
  const { id } = useLocalSearchParams<{ id: string }>();

  const [nav, setNav] = useState<NavigationResponse>();
  const [position, setPosition] = useState<LatLng>();
  const [heading, setHeading] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const watcher = useRef<Location.LocationSubscription>(undefined);

  const load = useCallback(
    async (from?: LatLng) => {
      if (!id) return;
      try {
        setNav(await client.navigation(id, from));
        setError(undefined);
      } catch {
        setError('Could not get directions. Check your connection.');
      } finally {
        setLoading(false);
      }
    },
    [client, id],
  );

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Follow the driver. The position feeds the map and the "distance to next
   * turn" readout; a re-route only fires when they have actually strayed, not
   * on every ping.
   */
  useEffect(() => {
    let cancelled = false;

    const start = async (): Promise<void> => {
      const permission = await Location.requestForegroundPermissionsAsync();
      if (!permission.granted || cancelled) return;
      watcher.current = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.BestForNavigation, distanceInterval: 10 },
        (fix) => {
          setPosition({ lat: fix.coords.latitude, lng: fix.coords.longitude });
          if (typeof fix.coords.heading === 'number' && fix.coords.heading >= 0) {
            setHeading(fix.coords.heading);
          }
        },
      );
    };

    void start();
    return () => {
      cancelled = true;
      try {
        watcher.current?.remove();
      } catch {
        // Some platform versions throw on an already-removed subscription.
      }
    };
  }, []);

  const routePoints = useMemo(
    () => (nav?.geometry ? decodePolyline(nav.geometry) : []),
    [nav?.geometry],
  );

  /**
   * Which step the driver is on. Steps are consumed as they are passed, so the
   * banner shows the turn coming up rather than the one just taken.
   */
  const { current, next, metersToTurn } = useMemo(() => {
    const steps = nav?.steps ?? [];
    if (!position || steps.length === 0) {
      return { current: steps[0], next: steps[1], metersToTurn: steps[0]?.distanceMeters };
    }

    let index = 0;
    for (let i = 0; i < steps.length; i++) {
      const distance = haversineMeters(position, steps[i]!.location);
      if (distance > STEP_REACHED_METERS) {
        index = i;
        break;
      }
      index = Math.min(i + 1, steps.length - 1);
    }

    const step = steps[index];
    return {
      current: step,
      next: steps[index + 1],
      metersToTurn: step ? haversineMeters(position, step.location) : undefined,
    };
  }, [nav?.steps, position]);

  /** Re-route once the driver is clearly not on the line any more. */
  useEffect(() => {
    if (!position || routePoints.length === 0) return;
    const nearest = routePoints.reduce(
      (min, point) => Math.min(min, haversineMeters(position, point)),
      Number.POSITIVE_INFINITY,
    );
    // 60m is wide enough to survive GPS noise and a parallel service road.
    if (nearest > 60) void load(position);
  }, [position, routePoints, load]);

  const markers = useMemo<MapMarker[]>(() => {
    const out: MapMarker[] = [];
    if (nav?.leg) out.push({ id: 'destination', kind: 'dropoff', coordinate: nav.leg.to });
    if (position) {
      out.push({ id: 'me', kind: 'car', coordinate: position, bearing: heading, zIndex: 20 });
    }
    return out;
  }, [nav?.leg, position, heading]);

  const polylines = useMemo<MapPolyline[]>(
    () => (routePoints.length > 1 ? [{ id: 'route', points: routePoints, width: 6 }] : []),
    [routePoints],
  );

  /** Hand off to whichever maps app the driver prefers. */
  const openExternal = useCallback(() => {
    if (!nav?.leg) return;
    const { lat, lng } = nav.leg.to;
    const url =
      Platform.OS === 'ios'
        ? `maps://?daddr=${lat},${lng}`
        : `google.navigation:q=${lat},${lng}`;
    void Linking.openURL(url).catch(() =>
      Linking.openURL(`https://maps.google.com/?daddr=${lat},${lng}`),
    );
  }, [nav?.leg]);

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

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
      {/* The manoeuvre banner. Deliberately the largest thing on screen. */}
      <View
        style={{
          paddingTop: insets.top + theme.spacing.sm,
          paddingHorizontal: theme.spacing.lg,
          paddingBottom: theme.spacing.lg,
          backgroundColor: theme.colors.primary,
        }}
      >
        <Row gap="lg" align="center">
          <Text style={{ fontSize: 52, color: theme.colors.onPrimary }}>
            {MANEUVER_ICONS[current?.maneuver ?? 'continue'] ?? '↑'}
          </Text>
          <Column gap="xxs" style={{ flex: 1 }}>
            <Text variant="display" color="inverse" numberOfLines={1}>
              {metersToTurn !== undefined ? formatDistance(metersToTurn) : ''}
            </Text>
            <Text variant="body" color="inverse" numberOfLines={2}>
              {current?.instruction ?? nav?.leg?.destinationName ?? 'Continue'}
            </Text>
          </Column>
          <Pressable
            onPress={() => router.back()}
            accessibilityRole="button"
            accessibilityLabel="Close navigation"
            hitSlop={16}
          >
            <Text variant="title" color="inverse">
              ✕
            </Text>
          </Pressable>
        </Row>

        {next ? (
          <Row gap="sm" align="center" style={{ marginTop: theme.spacing.sm, opacity: 0.85 }}>
            <Text style={{ fontSize: 18, color: theme.colors.onPrimary }}>
              {MANEUVER_ICONS[next.maneuver] ?? '↑'}
            </Text>
            <Text variant="caption" color="inverse" numberOfLines={1} style={{ flex: 1 }}>
              then {next.instruction}
            </Text>
          </Row>
        ) : null}
      </View>

      <MapView
        markers={markers}
        polylines={polylines}
        fitTo={position ? [position, ...(nav?.leg ? [nav.leg.to] : [])] : routePoints}
        style={{ flex: 1 }}
      />

      <View
        style={{
          paddingHorizontal: theme.spacing.lg,
          paddingTop: theme.spacing.md,
          paddingBottom: insets.bottom + theme.spacing.md,
          borderTopWidth: 1,
          borderTopColor: theme.colors.border,
          gap: theme.spacing.sm,
        }}
      >
        {error ? (
          <Text variant="caption" color="danger">
            {error}
          </Text>
        ) : null}

        <Row justify="space-between" align="center">
          <Column gap="xxs">
            <Text variant="bodyStrong">
              {nav?.durationMs !== undefined ? formatDuration(nav.durationMs) : '—'}
            </Text>
            <Text variant="caption" color="muted">
              {nav?.distanceMeters !== undefined ? formatDistance(nav.distanceMeters) : ''} to{' '}
              {nav?.leg?.destinationName ?? 'destination'}
            </Text>
          </Column>
          <Button label="Other app" variant="ghost" size="sm" onPress={openExternal} />
        </Row>

        <Divider />

        {/* The full step list, for a driver who wants to see the whole route. */}
        <ScrollView style={{ maxHeight: 140 }}>
          <Column gap="xs">
            {(nav?.steps ?? []).map((step, index) => (
              <StepRow key={index} step={step} dimmed={step !== current} />
            ))}
          </Column>
        </ScrollView>
      </View>
    </View>
  );
}

const StepRow = ({
  step,
  dimmed,
}: {
  step: RouteStepView;
  dimmed: boolean;
}): React.JSX.Element => (
  <Row gap="md" align="center" style={{ opacity: dimmed ? 0.5 : 1 }}>
    <Text style={{ fontSize: 18 }}>{MANEUVER_ICONS[step.maneuver] ?? '↑'}</Text>
    <Text variant="caption" style={{ flex: 1 }} numberOfLines={1}>
      {step.instruction}
    </Text>
    <Text variant="caption" color="muted">
      {formatDistance(step.distanceMeters)}
    </Text>
  </Row>
);

/**
 * Feet below a tenth of a mile, miles above it — how a driver reads distance,
 * and how every navigation app presents it.
 */
const formatDistance = (meters: number): string => {
  const feet = meters * 3.28084;
  if (feet < 528) return `${Math.round(feet / 10) * 10} ft`;
  return `${(meters / 1609.344).toFixed(1)} mi`;
};
