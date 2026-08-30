/**
 * Where the demand is.
 *
 * The main decision a driver makes between trips is where to sit, and without
 * this they are guessing. The same heat map the ops console sees, drawn over
 * the map so it can be read at a glance from a parked car.
 */

import React, { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, RefreshControl, ScrollView, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import * as Location from 'expo-location';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  Badge,
  Button,
  Card,
  Column,
  EmptyState,
  MapView,
  Row,
  ScreenHeader,
  Text,
  useTheme,
  type MapMarker,
  type MapPolygon,
} from '@lift/ui';
import { boundsAround, type LatLng } from '@lift/core';
import type { SurgeCell } from '@lift/sdk';
import { useDriver } from '../src/state/DriverProvider.js';

/** How far around the driver to ask for demand. */
const LOOK_AROUND_METERS = 8_000;

export default function Demand(): React.JSX.Element {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { client, config } = useDriver();

  const [cells, setCells] = useState<readonly SurgeCell[]>([]);
  const [provider, setProvider] = useState<string>();
  const [center, setCenter] = useState<LatLng>();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const fix = await Location.getLastKnownPositionAsync().catch(() => null);
      const at: LatLng = fix
        ? { lat: fix.coords.latitude, lng: fix.coords.longitude }
        : (config?.market.defaultCenter ?? { lat: 0, lng: 0 });
      setCenter(at);

      const bounds = boundsAround(at, LOOK_AROUND_METERS);
      const response = await client.driverDemand({
        south: bounds.south,
        west: bounds.west,
        north: bounds.north,
        east: bounds.east,
      });
      setCells(response.cells);
      setProvider(response.provider);
    } catch {
      setCells([]);
    } finally {
      setRefreshing(false);
      setLoading(false);
    }
  }, [client, config]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  /** Hotter cells are drawn more strongly; a 1.0× cell is not drawn at all. */
  const polygons = useMemo<MapPolygon[]>(
    () =>
      cells
        .filter((cell) => cell.multiplier > 1.05)
        .map((cell, index) => ({
          id: `cell-${index}`,
          points: [
            { lat: cell.bounds.north, lng: cell.bounds.west },
            { lat: cell.bounds.north, lng: cell.bounds.east },
            { lat: cell.bounds.south, lng: cell.bounds.east },
            { lat: cell.bounds.south, lng: cell.bounds.west },
          ],
          fill: heatColor(cell.multiplier),
          fillOpacity: Math.min(0.55, 0.15 + (cell.multiplier - 1) * 0.5),
        })),
    [cells],
  );

  const markers = useMemo<MapMarker[]>(
    () => (center ? [{ id: 'me', kind: 'car', coordinate: center, zIndex: 20 }] : []),
    [center],
  );

  const hottest = useMemo(
    () => [...cells].sort((a, b) => b.multiplier - a.multiplier).slice(0, 5),
    [cells],
  );

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background, paddingTop: insets.top }}>
      <ScreenHeader
        title="Demand"
        {...(provider ? { subtitle: `Live from ${provider}` } : {})}
        onBack={() => router.back()}
      />

      {loading ? (
        <Column style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator color={theme.colors.primary} />
        </Column>
      ) : (
        <>
          <MapView
            markers={markers}
            polygons={polygons}
            fitTo={center ? [center] : []}
            style={{ flex: 1 }}
          />

          <ScrollView
            refreshControl={
              <RefreshControl refreshing={refreshing} onRefresh={() => void load()} />
            }
            style={{ maxHeight: '40%' }}
            contentContainerStyle={{
              padding: theme.spacing.lg,
              paddingBottom: insets.bottom + theme.spacing.lg,
              gap: theme.spacing.md,
            }}
          >
            {hottest.length === 0 || hottest[0]!.multiplier <= 1.05 ? (
              <EmptyState
                icon="🌤"
                title="Demand is steady"
                message="Nowhere nearby is paying above the normal rate right now."
              />
            ) : (
              <Column gap="sm">
                <Text variant="label" color="muted">
                  PAYING MORE RIGHT NOW
                </Text>
                {hottest.map((cell, index) => (
                  <Card key={index} padded="md">
                    <Row justify="space-between" align="center">
                      <Column gap="xxs" style={{ flex: 1 }}>
                        <Text variant="captionStrong">{describeCell(cell, center)}</Text>
                        {cell.demand !== undefined && cell.supply !== undefined ? (
                          <Text variant="caption" color="muted">
                            {cell.demand} looking · {cell.supply} driving
                          </Text>
                        ) : null}
                      </Column>
                      <Badge
                        label={`${cell.multiplier.toFixed(1)}×`}
                        tone={cell.multiplier >= 1.5 ? 'danger' : 'warning'}
                      />
                    </Row>
                  </Card>
                ))}
              </Column>
            )}

            <Text variant="caption" color="muted">
              A multiplier is what riders are being charged above the base rate there. It moves as
              riders and drivers move, so it is a hint, not a promise.
            </Text>

            <Button label="Refresh" variant="ghost" onPress={() => void load()} />
          </ScrollView>
        </>
      )}
    </View>
  );
}

/** Warm through red as the multiplier climbs. */
const heatColor = (multiplier: number): string => {
  if (multiplier >= 2) return '#d7263d';
  if (multiplier >= 1.5) return '#f46036';
  if (multiplier >= 1.25) return '#f7b32b';
  return '#f4d35e';
};

/** "1.2 mi northeast" — how a driver thinks about where to go. */
const describeCell = (cell: SurgeCell, from?: LatLng): string => {
  const centre = {
    lat: (cell.bounds.north + cell.bounds.south) / 2,
    lng: (cell.bounds.east + cell.bounds.west) / 2,
  };
  if (!from) return `${centre.lat.toFixed(3)}, ${centre.lng.toFixed(3)}`;

  const dLat = centre.lat - from.lat;
  const dLng = centre.lng - from.lng;
  const vertical = dLat > 0.002 ? 'north' : dLat < -0.002 ? 'south' : '';
  const horizontal = dLng > 0.002 ? 'east' : dLng < -0.002 ? 'west' : '';
  const direction = `${vertical}${horizontal}` || 'right here';

  // Rough miles: a degree of latitude is about 69 miles.
  const miles = Math.sqrt((dLat * 69) ** 2 + (dLng * 69 * Math.cos((from.lat * Math.PI) / 180)) ** 2);
  return miles < 0.2 ? 'Right where you are' : `${miles.toFixed(1)} mi ${direction}`;
};
