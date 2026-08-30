/**
 * Destination search.
 *
 * The results come back as sections from the API — saved, recent, nearby
 * venues, geocoder results, and any external integration the deployment has
 * registered. This screen renders whatever sections it is given, so adding a
 * place source changes what riders can search without touching this file.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, SectionList, TextInput, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import * as Location from 'expo-location';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Column, Divider, Row, Text, useTheme } from '@lift/ui';
import type { LatLng, Place } from '@lift/core';
import type { PlaceSearchResult } from '@lift/sdk';
import { useApp } from '../src/state/AppProvider.js';

interface Section {
  readonly title: string;
  readonly icon: string;
  readonly data: readonly PlaceSearchResult[];
}

export default function Search(): React.JSX.Element {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { client } = useApp();
  const params = useLocalSearchParams<{ field?: string; pickup?: string }>();
  const field = params.field === 'pickup' ? 'pickup' : 'dropoff';

  const [query, setQuery] = useState('');
  const [sections, setSections] = useState<Section[]>([]);
  const [loading, setLoading] = useState(false);
  const [near, setNear] = useState<LatLng>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    void Location.getLastKnownPositionAsync()
      .then((fix) => {
        if (fix) setNear({ lat: fix.coords.latitude, lng: fix.coords.longitude });
      })
      .catch(() => {});
  }, []);

  /**
   * Debounce keystrokes. A search box that fires per character burns provider
   * quota and returns results out of order; 220ms is long enough to coalesce a
   * burst of typing and short enough to feel instant.
   */
  const debounce = useRef<ReturnType<typeof setTimeout>>(undefined);
  const requestId = useRef(0);

  const runSearch = useCallback(
    async (text: string) => {
      const id = ++requestId.current;
      setLoading(true);
      try {
        const response = await client.searchPlaces({
          q: text,
          field,
          limit: 8,
          ...(near ? { near } : {}),
        });
        // Ignore a response that a newer keystroke has already superseded.
        if (id !== requestId.current) return;
        setSections(
          response.sections.map((s) => ({ title: s.title, icon: s.icon, data: s.results })),
        );
        setError(undefined);
      } catch (e) {
        if (id === requestId.current) {
          setError(e instanceof Error ? e.message : 'Search failed');
        }
      } finally {
        if (id === requestId.current) setLoading(false);
      }
    },
    [client, field, near],
  );

  useEffect(() => {
    clearTimeout(debounce.current);
    debounce.current = setTimeout(() => void runSearch(query), 220);
    return () => clearTimeout(debounce.current);
  }, [query, runSearch]);

  /**
   * Choosing a result. Suggestions from a provider are refs, not full places,
   * so they are resolved before booking — that is the suggest-then-resolve
   * flow every geocoder expects.
   */
  const choose = useCallback(
    async (result: PlaceSearchResult) => {
      let place: Place = result.place;
      const needsResolving =
        place.externalRef !== undefined &&
        place.source === 'autocomplete' &&
        (place.coordinates.lat === 0 || place.coordinates.lng === 0);

      if (needsResolving) {
        try {
          place = (await client.resolvePlace(place.externalRef!)).place;
        } catch {
          // Fall back to whatever the suggestion carried.
        }
      }

      if (field === 'pickup') {
        router.replace({
          pathname: '/confirm',
          params: { pickup: JSON.stringify(place), dropoff: params.pickup ?? '' },
        });
        return;
      }
      router.replace({
        pathname: '/confirm',
        params: { dropoff: JSON.stringify(place) },
      });
    },
    [client, field, params.pickup],
  );

  const listSections = useMemo(() => sections.filter((s) => s.data.length > 0), [sections]);

  return (
    <View
      style={{
        flex: 1,
        backgroundColor: theme.colors.background,
        paddingTop: insets.top + theme.spacing.sm,
      }}
    >
      <Row gap="md" style={{ paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.md }}>
        <Pressable
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel="Back"
          hitSlop={12}
        >
          <Text variant="title">←</Text>
        </Pressable>
        <TextInput
          autoFocus
          value={query}
          onChangeText={setQuery}
          placeholder={field === 'pickup' ? 'Set your pickup' : 'Where to?'}
          placeholderTextColor={theme.colors.textMuted}
          accessibilityLabel={field === 'pickup' ? 'Pickup location' : 'Destination'}
          style={{
            flex: 1,
            backgroundColor: theme.colors.surfaceSunken,
            borderRadius: theme.radius.md,
            paddingHorizontal: theme.spacing.lg,
            paddingVertical: theme.spacing.md,
            fontSize: 17,
            color: theme.colors.text,
          }}
        />
      </Row>

      {loading && listSections.length === 0 ? (
        <ActivityIndicator style={{ marginTop: theme.spacing.xl }} color={theme.colors.primary} />
      ) : null}

      {error ? (
        <Text variant="caption" color="danger" style={{ padding: theme.spacing.lg }}>
          {error}
        </Text>
      ) : null}

      <SectionList
        sections={listSections}
        keyExtractor={(item, index) => `${item.place.id}-${index}`}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingBottom: insets.bottom + theme.spacing.xxl }}
        renderSectionHeader={({ section }) => (
          <View
            style={{
              paddingHorizontal: theme.spacing.lg,
              paddingTop: theme.spacing.lg,
              paddingBottom: theme.spacing.xs,
              backgroundColor: theme.colors.background,
            }}
          >
            <Text variant="label" color="muted">
              {section.title.toUpperCase()}
            </Text>
          </View>
        )}
        ItemSeparatorComponent={() => <Divider style={{ marginLeft: theme.spacing.xxl }} />}
        renderItem={({ item }) => (
          <Pressable
            onPress={() => void choose(item)}
            accessibilityRole="button"
            accessibilityLabel={`${item.place.name}. ${item.place.address}`}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: theme.spacing.md,
              paddingHorizontal: theme.spacing.lg,
              paddingVertical: theme.spacing.md,
            }}
          >
            <View
              style={{
                width: 36,
                height: 36,
                borderRadius: 18,
                backgroundColor: theme.colors.surfaceSunken,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Text>{iconFor(item)}</Text>
            </View>
            <Column gap="xxs" style={{ flex: 1 }}>
              <Text variant="body" numberOfLines={1}>
                {item.place.name}
              </Text>
              <Text variant="caption" color="secondary" numberOfLines={1}>
                {item.place.subtitle ?? item.place.address}
              </Text>
            </Column>
            {item.badge ? (
              <Text variant="caption" color="muted">
                {item.badge}
              </Text>
            ) : null}
          </Pressable>
        )}
        ListEmptyComponent={
          loading ? null : (
            <Text
              variant="caption"
              color="muted"
              align="center"
              style={{ padding: theme.spacing.xxl }}
            >
              {query.length > 0 ? 'No places matched that.' : 'Start typing to search.'}
            </Text>
          )
        }
      />
    </View>
  );
}

const iconFor = (result: PlaceSearchResult): string => {
  if (result.icon === 'home') return '🏠';
  if (result.icon === 'work') return '💼';
  if (result.icon === 'crosshair') return '🎯';
  switch (result.place.category) {
    case 'airport':
      return '✈️';
    case 'transit':
      return '🚉';
    case 'restaurant':
      return '🍽️';
    case 'hotel':
      return '🏨';
    case 'hospital':
      return '🏥';
    case 'shopping':
      return '🛍️';
    case 'venue':
      return '📍';
    default:
      return '📌';
  }
};
