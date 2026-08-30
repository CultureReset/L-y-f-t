/**
 * Settings: profile, notifications, accessibility, and ride preferences.
 *
 * Accessibility here is not decoration — `wheelchairAccessible` narrows which
 * ride types the rider is offered, and `extraPickupTime` tells the driver to
 * wait rather than treating a slow arrival as a no-show.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Alert, ScrollView, View } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  Button,
  Column,
  Field,
  ScreenHeader,
  Section,
  ToggleRow,
  useTheme,
} from '@lift/ui';
import type { RiderPreferences } from '@lift/core';
import { ApiError } from '@lift/sdk';
import { useApp } from '../src/state/AppProvider.js';
import { goBack } from '../src/navigation.js';

export default function Settings(): React.JSX.Element {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { client, me, refresh } = useApp();

  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [preferences, setPreferences] = useState<RiderPreferences>();
  const [savingProfile, setSavingProfile] = useState(false);

  useEffect(() => {
    if (!me?.user) return;
    setFirstName(me.user.firstName);
    setLastName(me.user.lastName);
    setEmail(me.user.email ?? '');
    setPreferences(me.rider?.preferences);
  }, [me]);

  const saveProfile = async (): Promise<void> => {
    setSavingProfile(true);
    try {
      await client.updateProfile({
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        ...(email.trim() ? { email: email.trim() } : {}),
      });
      await refresh();
      Alert.alert('Saved', 'Your details are up to date.');
    } catch (e) {
      Alert.alert('Could not save', e instanceof ApiError ? e.userMessage : 'Try again.');
    } finally {
      setSavingProfile(false);
    }
  };

  /**
   * Preferences save as they are toggled rather than behind a Save button —
   * a switch that does not take effect until you press something else is a
   * switch people mistrust.
   */
  const patchPreferences = useCallback(
    async (patch: Partial<RiderPreferences>) => {
      const next = { ...preferences, ...patch } as RiderPreferences;
      setPreferences(next);
      try {
        await client.updateRiderPreferences(patch);
      } catch {
        // Put the switch back if the server refused it.
        setPreferences(preferences);
        Alert.alert('Could not save', 'That preference did not stick. Try again.');
      }
    },
    [client, preferences],
  );

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background, paddingTop: insets.top }}>
      <ScreenHeader title="Settings" onBack={() => goBack('/account')} />

      <ScrollView
        contentContainerStyle={{
          padding: theme.spacing.lg,
          paddingBottom: insets.bottom + theme.spacing.xxl,
          gap: theme.spacing.xl,
        }}
        keyboardShouldPersistTaps="handled"
      >
        <Section title="Your details" footer="Drivers see your first name and last initial.">
          <Column gap="md" style={{ paddingVertical: theme.spacing.sm }}>
            <Field label="First name" value={firstName} onChangeText={setFirstName} />
            <Field label="Last name" value={lastName} onChangeText={setLastName} />
            <Field
              label="Email"
              value={email}
              onChangeText={setEmail}
              keyboardType="email-address"
              autoCapitalize="none"
              hint="Receipts are sent here."
            />
            <Field
              label="Phone"
              value={me?.user?.phone ?? ''}
              onChangeText={() => {}}
              editable={false}
              hint="Contact support to change your number."
            />
            <Button label="Save" onPress={() => void saveProfile()} loading={savingProfile} />
          </Column>
        </Section>

        {preferences ? (
          <>
            <Section
              title="Accessibility"
              footer="These change which rides you are offered and what your driver is told."
            >
              <ToggleRow
                label="Wheelchair accessible vehicle"
                description="Only match with vehicles that have a ramp or lift."
                value={preferences.accessibility.wheelchairAccessible}
                onValueChange={(value) =>
                  void patchPreferences({
                    accessibility: { ...preferences.accessibility, wheelchairAccessible: value },
                  })
                }
              />
              <ToggleRow
                label="Travelling with a service animal"
                description="Your driver is told before they accept."
                value={preferences.accessibility.serviceAnimal}
                onValueChange={(value) =>
                  void patchPreferences({
                    accessibility: { ...preferences.accessibility, serviceAnimal: value },
                  })
                }
              />
              <ToggleRow
                label="I need extra time at pickup"
                description="Drivers wait longer before marking you as a no-show."
                value={preferences.accessibility.extraPickupTime}
                onValueChange={(value) =>
                  void patchPreferences({
                    accessibility: { ...preferences.accessibility, extraPickupTime: value },
                  })
                }
              />
            </Section>

            <Section title="During your ride">
              <ToggleRow
                label="Quiet ride"
                description="Your driver knows you would rather not chat."
                value={preferences.communication.quietRide}
                onValueChange={(value) =>
                  void patchPreferences({
                    communication: { ...preferences.communication, quietRide: value },
                  })
                }
              />
            </Section>

            <Section title="Notifications">
              <ToggleRow
                label="Push notifications"
                description="Driver arriving, trip updates, receipts."
                value={preferences.notifications.push}
                onValueChange={(value) =>
                  void patchPreferences({
                    notifications: { ...preferences.notifications, push: value },
                  })
                }
              />
              <ToggleRow
                label="Text messages"
                description="A backup when push is unavailable."
                value={preferences.notifications.sms}
                onValueChange={(value) =>
                  void patchPreferences({
                    notifications: { ...preferences.notifications, sms: value },
                  })
                }
              />
              <ToggleRow
                label="Email"
                description="Receipts and occasional product news."
                value={preferences.notifications.email}
                onValueChange={(value) =>
                  void patchPreferences({
                    notifications: { ...preferences.notifications, email: value },
                  })
                }
              />
            </Section>
          </>
        ) : null}
      </ScrollView>
    </View>
  );
}
