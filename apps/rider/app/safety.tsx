/**
 * The safety toolkit.
 *
 * Reachable from the live ride screen in one tap, because the moment someone
 * needs this is the moment they should not be hunting through a menu. Three
 * things it has to do well: share the trip, call for help, and show the ride
 * details a dispatcher would ask for.
 */

import React, { useCallback, useMemo, useState } from 'react';
import { Alert, Linking, Platform, ScrollView, Share, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  Button,
  Card,
  Column,
  Divider,
  NavRow,
  Row,
  ScreenHeader,
  Section,
  Text,
  useTheme,
} from '@lift/ui';
import { formatClockTime, statusLabel } from '@lift/core';
import { useApp } from '../src/state/AppProvider.js';
import { goBack } from '../src/navigation.js';
import { useActiveRide } from '../src/state/useActiveRide.js';

/**
 * The emergency number differs by country. Deriving it from the market's locale
 * is better than hardcoding one, and better than guessing from the device.
 */
const EMERGENCY_NUMBERS: Record<string, string> = {
  US: '911',
  CA: '911',
  MX: '911',
  GB: '999',
  IE: '112',
  AU: '000',
  NZ: '111',
};

export default function Safety(): React.JSX.Element {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { config, me } = useApp();
  const { rideId } = useLocalSearchParams<{ rideId?: string }>();
  const { ride, driver, vehicle } = useActiveRide(rideId);
  const [sharing, setSharing] = useState(false);

  const emergencyNumber = useMemo(() => {
    const region = (config?.market.locale ?? 'en-US').split('-')[1] ?? 'US';
    return EMERGENCY_NUMBERS[region] ?? '112';
  }, [config]);

  /**
   * The share text is written to be useful to whoever receives it without
   * opening anything: who the rider is with, in what car, and where they are
   * going. A bare link is much less use in an emergency.
   */
  const shareTrip = useCallback(async () => {
    if (!ride) return;
    setSharing(true);
    try {
      const lines = [
        `${me?.user?.firstName ?? 'I'} is on a ride with ${config?.brandName ?? 'a rideshare'}.`,
        '',
        `From: ${ride.itinerary.pickup.name}`,
        `To: ${ride.itinerary.dropoff.name}`,
        driver ? `Driver: ${driver.name} (rated ${driver.rating.toFixed(2)})` : '',
        vehicle
          ? `Vehicle: ${vehicle.color} ${vehicle.make} ${vehicle.model}, plate ${vehicle.licensePlate}`
          : '',
        `Status: ${statusLabel(ride.status)}`,
        ride.requestedAt ? `Started: ${formatClockTime(ride.requestedAt)}` : '',
      ].filter(Boolean);

      await Share.share({
        message: lines.join('\n'),
        title: 'My trip',
      });
    } catch {
      // The user dismissing the share sheet is not an error.
    } finally {
      setSharing(false);
    }
  }, [ride, driver, vehicle, me, config]);

  const callEmergency = useCallback(() => {
    Alert.alert(
      `Call ${emergencyNumber}?`,
      'This places a real call to emergency services. Only use it if you are in danger.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: `Call ${emergencyNumber}`,
          style: 'destructive',
          onPress: () => {
            // `tel:` opens the dialer with the number ready; on Android it
            // dials directly, which is what you want here.
            void Linking.openURL(`tel:${emergencyNumber}`).catch(() =>
              Alert.alert('Could not open the dialer', `Call ${emergencyNumber} directly.`),
            );
          },
        },
      ],
    );
  }, [emergencyNumber]);

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background, paddingTop: insets.top }}>
      <ScreenHeader
        title="Safety"
        subtitle={ride ? statusLabel(ride.status) : 'No ride in progress'}
        onBack={() => goBack('/home')}
      />

      <ScrollView
        contentContainerStyle={{
          padding: theme.spacing.lg,
          paddingBottom: insets.bottom + theme.spacing.xxl,
          gap: theme.spacing.xl,
        }}
      >
        {/* The two urgent actions come first and are unmissable. */}
        <Column gap="md">
          <Button
            label={`Call ${emergencyNumber}`}
            variant="danger"
            size="lg"
            onPress={callEmergency}
          />
          <Button
            label="Share my trip"
            variant="secondary"
            size="lg"
            onPress={() => void shareTrip()}
            loading={sharing}
            disabled={!ride}
          />
          <Text variant="caption" color="muted" align="center">
            Sharing sends your driver, vehicle, and destination to whoever you choose.
          </Text>
        </Column>

        {ride ? (
          <Card>
            <Column gap="md">
              <Text variant="heading">Your ride right now</Text>
              <Divider />
              <Detail label="Status" value={statusLabel(ride.status)} />
              <Detail label="From" value={ride.itinerary.pickup.name} />
              <Detail label="To" value={ride.itinerary.dropoff.name} />
              {driver ? <Detail label="Driver" value={driver.name} /> : null}
              {vehicle ? (
                <>
                  <Detail
                    label="Vehicle"
                    value={`${vehicle.color} ${vehicle.make} ${vehicle.model}`}
                  />
                  <Detail label="Plate" value={vehicle.licensePlate} />
                </>
              ) : null}
              <Detail label="Ride ID" value={ride.id} />
              <Text variant="caption" color="muted">
                Read these out if you are asked to identify your ride.
              </Text>
            </Column>
          </Card>
        ) : null}

        <Section title="Before you ride" footer="A few seconds of checking prevents most problems.">
          <Column gap="md" style={{ paddingVertical: theme.spacing.sm }}>
            <Checklist text="Match the licence plate before you open the door." />
            <Checklist text="Check the driver's photo and name." />
            <Checklist text="Ask the driver who they are picking up — never say your name first." />
            <Checklist text="Ride in the back seat where you can exit either side." />
          </Column>
        </Section>

        <Section title="More">
          <NavRow
            label="Report a problem with this ride"
            icon="⚠️"
            onPress={() =>
              router.push({ pathname: '/support', params: { rideId: ride?.id ?? '' } })
            }
          />
          <NavRow label="Help and support" icon="💬" onPress={() => router.push('/support')} />
        </Section>
      </ScrollView>
    </View>
  );
}

const Detail = ({ label, value }: { label: string; value: string }): React.JSX.Element => (
  <Row justify="space-between" gap="lg" align="flex-start">
    <Text variant="caption" color="muted">
      {label}
    </Text>
    <Text variant="captionStrong" style={{ flex: 1, textAlign: 'right' }} numberOfLines={2}>
      {value}
    </Text>
  </Row>
);

const Checklist = ({ text }: { text: string }): React.JSX.Element => (
  <Row gap="md" align="flex-start">
    <Text variant="body">✓</Text>
    <Text variant="caption" color="secondary" style={{ flex: 1 }}>
      {text}
    </Text>
  </Row>
);
