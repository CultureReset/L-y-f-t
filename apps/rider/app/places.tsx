/**
 * Saved places.
 *
 * Home and work are the two addresses a rider enters most, so they get their
 * own rows with fixed labels; anything else is a free-form favourite. Picking
 * an address reuses the same search screen the booking flow uses, so there is
 * one place-search implementation and one set of place sources.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Alert, ScrollView, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  Button,
  Column,
  EmptyState,
  Field,
  NavRow,
  Row,
  ScreenHeader,
  Section,
  Text,
  useTheme,
} from '@lift/ui';
import type { Place, SavedPlace } from '@lift/core';
import { ApiError } from '@lift/sdk';
import { useApp } from '../src/state/AppProvider.js';
import { goBack } from '../src/navigation.js';

/** The two labels that get a permanent row whether or not they are set. */
const FIXED: readonly { icon: SavedPlace['icon']; label: string; emoji: string }[] = [
  { icon: 'home', label: 'Home', emoji: '🏠' },
  { icon: 'work', label: 'Work', emoji: '💼' },
];

export default function Places(): React.JSX.Element {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { client } = useApp();
  // The search screen hands the chosen place back through the params.
  const params = useLocalSearchParams<{ place?: string; label?: string; icon?: string }>();

  const [places, setPlaces] = useState<readonly SavedPlace[]>([]);
  const [naming, setNaming] = useState<Place>();
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setPlaces((await client.savedPlaces()).places);
    } catch {
      setPlaces([]);
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * A place chosen for Home or Work needs no name and saves immediately; a
   * favourite drops into the naming field instead.
   */
  useEffect(() => {
    if (!params.place) return;
    let place: Place;
    try {
      place = JSON.parse(params.place) as Place;
    } catch {
      return;
    }

    if (params.label && params.icon) {
      void save(place, params.label, params.icon as SavedPlace['icon']);
    } else {
      setNaming(place);
      setLabel('');
    }
    // Clear the param so returning to this screen does not re-save.
    router.setParams({ place: '', label: '', icon: '' });
  }, [params.place, params.label, params.icon]);

  const save = async (
    place: Place,
    nextLabel: string,
    icon: SavedPlace['icon'],
  ): Promise<void> => {
    setBusy(true);
    try {
      // One address per fixed label: saving a new Home replaces the old one.
      const existing = places.find((p) => p.icon === icon && icon !== 'star');
      if (existing) await client.removeSavedPlace(existing.id);

      setPlaces((await client.savePlace({ label: nextLabel, icon, place })).places);
      setNaming(undefined);
    } catch (e) {
      Alert.alert('Could not save', e instanceof ApiError ? e.userMessage : 'Try again.');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (placeId: string): Promise<void> => {
    try {
      setPlaces((await client.removeSavedPlace(placeId)).places);
    } catch {
      Alert.alert('Could not remove that place');
    }
  };

  const pick = (forLabel?: string, icon?: SavedPlace['icon']): void => {
    router.push({
      pathname: '/search',
      params: {
        field: 'saved',
        ...(forLabel && icon ? { savedLabel: forLabel, savedIcon: icon } : {}),
      },
    });
  };

  const favorites = places.filter((p) => p.icon === 'star' || p.icon === 'pin');

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background, paddingTop: insets.top }}>
      <ScreenHeader title="Saved places" onBack={() => goBack('/account')} />

      <ScrollView
        contentContainerStyle={{
          padding: theme.spacing.lg,
          paddingBottom: insets.bottom + theme.spacing.xxl,
          gap: theme.spacing.xl,
        }}
        keyboardShouldPersistTaps="handled"
      >
        {naming ? (
          <Section title="Name this place" footer={naming.address}>
            <Column gap="md" style={{ paddingVertical: theme.spacing.sm }}>
              <Field
                label="Label"
                value={label}
                onChangeText={setLabel}
                placeholder="The gym"
                autoFocus
              />
              <Row gap="sm">
                <Button
                  label="Save"
                  onPress={() => void save(naming, label.trim() || naming.name, 'star')}
                  disabled={busy}
                  loading={busy}
                />
                <Button label="Cancel" variant="ghost" onPress={() => setNaming(undefined)} />
              </Row>
            </Column>
          </Section>
        ) : null}

        <Section title="Shortcuts" footer="Book these in one tap from the home screen.">
          {FIXED.map((fixed) => {
            const saved = places.find((p) => p.icon === fixed.icon);
            return (
              <NavRow
                key={fixed.icon}
                icon={fixed.emoji}
                label={fixed.label}
                {...(saved ? { description: saved.place.address } : {})}
                value={saved ? 'Change' : 'Add'}
                onPress={() => pick(fixed.label, fixed.icon)}
              />
            );
          })}
        </Section>

        <Section title="Favourites">
          {favorites.length === 0 ? (
            <EmptyState
              icon="⭐"
              title="No favourites yet"
              message="Save the places you go often and they show up when you search."
              action={<Button label="Add a place" variant="secondary" onPress={() => pick()} />}
            />
          ) : (
            <>
              {favorites.map((place) => (
                <NavRow
                  key={place.id}
                  icon="⭐"
                  label={place.label}
                  description={place.place.address}
                  value="Remove"
                  destructive
                  onPress={() =>
                    Alert.alert(`Remove ${place.label}?`, place.place.address, [
                      { text: 'Keep', style: 'cancel' },
                      {
                        text: 'Remove',
                        style: 'destructive',
                        onPress: () => void remove(place.id),
                      },
                    ])
                  }
                />
              ))}
            </>
          )}
        </Section>

        {favorites.length > 0 ? (
          <Button label="Add another place" variant="secondary" onPress={() => pick()} />
        ) : null}
      </ScrollView>
    </View>
  );
}
