/**
 * Account: profile, saved places, and the switch into the driver app.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, View } from 'react-native';
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
  Text,
  useTheme,
} from '@lift/ui';
import type { SavedPlace } from '@lift/core';
import { useApp } from '../src/state/AppProvider.js';

export default function Account(): React.JSX.Element {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { client, me, config, apiUrl, signOut } = useApp();

  const [places, setPlaces] = useState<readonly SavedPlace[]>([]);

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

  const user = me?.user;
  const rider = me?.rider;

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
              <Text variant="caption" color="secondary">
                {user.phone}
              </Text>
              {rider ? <Rating value={rider.rating} count={rider.ratingCount} /> : null}
            </Column>
          </Row>
        ) : null}

        {rider ? (
          <Row gap="sm">
            <Card padded="md" style={{ flex: 1 }}>
              <Text variant="label" color="muted">
                TRIPS
              </Text>
              <Text variant="title">{rider.totalRides}</Text>
            </Card>
            <Card padded="md" style={{ flex: 1 }}>
              <Text variant="label" color="muted">
                RATING
              </Text>
              <Text variant="title">{rider.rating.toFixed(2)}</Text>
            </Card>
          </Row>
        ) : null}

        <Divider />

        <Column gap="sm">
          <Text variant="heading">Saved places</Text>
          {places.map((place) => (
            <Row key={place.id} justify="space-between">
              <Column gap="xxs" style={{ flex: 1 }}>
                <Text variant="body">
                  {place.icon === 'home' ? '🏠' : place.icon === 'work' ? '💼' : '⭐'} {place.label}
                </Text>
                <Text variant="caption" color="muted" numberOfLines={1}>
                  {place.place.address}
                </Text>
              </Column>
              <Pressable
                onPress={() => {
                  void client.removeSavedPlace(place.id).then(() => void load());
                }}
                accessibilityRole="button"
                accessibilityLabel={`Remove ${place.label}`}
              >
                <Text variant="caption" color="danger">
                  Remove
                </Text>
              </Pressable>
            </Row>
          ))}
          {places.length === 0 ? (
            <Text variant="caption" color="muted">
              Save your home and work to book them in one tap.
            </Text>
          ) : null}
        </Column>

        <Divider />

        <Column gap="sm">
          <Button label="Wallet" variant="secondary" onPress={() => router.push('/wallet')} />
          <Button label="Your trips" variant="secondary" onPress={() => router.push('/activity')} />
          <Button
            label="Sign out"
            variant="ghost"
            onPress={() => {
              Alert.alert('Sign out?', 'You will need your phone number to sign back in.', [
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

        <Divider />

        {/* Useful when pointing the app at a different backend. */}
        <Column gap="xxs">
          <Text variant="label" color="muted">
            CONNECTED TO
          </Text>
          <Text variant="caption" color="muted">
            {apiUrl}
          </Text>
          {config ? (
            <Row gap="sm" wrap>
              <Badge label={config.market.name} />
              <Badge label={config.brandName} />
            </Row>
          ) : null}
        </Column>
      </ScrollView>
    </View>
  );
}
