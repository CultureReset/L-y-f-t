/**
 * Driver onboarding: add a vehicle, submit documents, get approved.
 *
 * The API is the authority on whether a driver may go online — this screen
 * only reflects what it reports, so the checklist can never claim a driver is
 * ready when dispatch would refuse them.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Badge, Button, Card, Column, Divider, Row, Text, useTheme } from '@lift/ui';
import { DRIVER_DOCUMENT_TYPES, type VehicleColor } from '@lift/core';
import { ApiError } from '@lift/sdk';
import { useDriver } from '../src/state/DriverProvider.js';

const COLORS: VehicleColor[] = ['black', 'white', 'silver', 'gray', 'blue', 'red'];

const DOCUMENT_LABELS: Record<string, string> = {
  drivers_license: "Driver's licence",
  vehicle_registration: 'Vehicle registration',
  insurance: 'Proof of insurance',
  background_check: 'Background check',
  profile_photo: 'Profile photo',
  vehicle_inspection: 'Vehicle inspection',
};

export default function Onboarding(): React.JSX.Element {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { client, status, refresh } = useDriver();

  const [make, setMake] = useState('');
  const [model, setModel] = useState('');
  const [year, setYear] = useState(String(new Date().getFullYear() - 2));
  const [color, setColor] = useState<VehicleColor>('silver');
  const [plate, setPlate] = useState('');
  const [seats, setSeats] = useState('4');
  const [busy, setBusy] = useState(false);

  const hasVehicle = status?.vehicle !== undefined;
  const submitted = new Set(status?.profile.documents.map((d) => d.type) ?? []);

  const addVehicle = async (): Promise<void> => {
    setBusy(true);
    try {
      const result = await client.addVehicle({
        make: make.trim(),
        model: model.trim(),
        year: Number(year),
        color,
        licensePlate: plate.trim().toUpperCase(),
        seats: Number(seats),
        features: [],
      });
      await refresh();
      const tiers = result.qualification.filter((q) => q.qualifies).map((q) => q.name);
      Alert.alert(
        'Vehicle added',
        tiers.length > 0
          ? `You can drive: ${tiers.join(', ')}.`
          : 'This vehicle does not qualify for any tier yet.',
      );
    } catch (e) {
      Alert.alert('Could not add vehicle', e instanceof ApiError ? e.userMessage : 'Check the details.');
    } finally {
      setBusy(false);
    }
  };

  const submitDocument = async (type: string): Promise<void> => {
    setBusy(true);
    try {
      // A real deployment uploads a file here; the reference build records the
      // submission so the approval flow is exercisable end to end.
      await client.submitDocument({ type });
      await refresh();
    } catch (e) {
      Alert.alert('Could not submit', e instanceof ApiError ? e.userMessage : 'Try again.');
    } finally {
      setBusy(false);
    }
  };

  const inputStyle = {
    backgroundColor: theme.colors.surfaceSunken,
    borderRadius: theme.radius.md,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.md,
    color: theme.colors.text,
    fontSize: 16,
  };

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background, paddingTop: insets.top }}>
      <Row gap="md" style={{ padding: theme.spacing.lg }}>
        <Pressable onPress={() => router.back()} accessibilityRole="button" accessibilityLabel="Back" hitSlop={12}>
          <Text variant="title">←</Text>
        </Pressable>
        <Text variant="title">Get set up</Text>
      </Row>

      <ScrollView
        contentContainerStyle={{
          padding: theme.spacing.lg,
          paddingBottom: insets.bottom + theme.spacing.xxl,
          gap: theme.spacing.xl,
        }}
        keyboardShouldPersistTaps="handled"
      >
        <Card>
          <Column gap="sm">
            <Row justify="space-between">
              <Text variant="heading">Status</Text>
              <Badge
                label={status?.profile.approvalStatus ?? 'unknown'}
                tone={status?.canGoOnline ? 'success' : 'warning'}
              />
            </Row>
            <Text variant="caption" color="secondary">
              {status?.canGoOnline
                ? "You're approved and ready to drive."
                : (status?.blockedReason ?? 'Complete the steps below.')}
            </Text>
          </Column>
        </Card>

        <Column gap="md">
          <Text variant="heading">Your vehicle</Text>
          {hasVehicle ? (
            <Card padded="md">
              <Text variant="bodyStrong">
                {status!.vehicle!.year} {status!.vehicle!.make} {status!.vehicle!.model}
              </Text>
              <Text variant="caption" color="secondary">
                {status!.vehicle!.color} · {status!.vehicle!.licensePlate} ·{' '}
                {status!.vehicle!.seats} seats
              </Text>
            </Card>
          ) : (
            <Column gap="sm">
              <Row gap="sm">
                <TextInput
                  style={[inputStyle, { flex: 1 }]}
                  placeholder="Make"
                  placeholderTextColor={theme.colors.textMuted}
                  value={make}
                  onChangeText={setMake}
                  accessibilityLabel="Vehicle make"
                />
                <TextInput
                  style={[inputStyle, { flex: 1 }]}
                  placeholder="Model"
                  placeholderTextColor={theme.colors.textMuted}
                  value={model}
                  onChangeText={setModel}
                  accessibilityLabel="Vehicle model"
                />
              </Row>
              <Row gap="sm">
                <TextInput
                  style={[inputStyle, { flex: 1 }]}
                  placeholder="Year"
                  placeholderTextColor={theme.colors.textMuted}
                  keyboardType="number-pad"
                  value={year}
                  onChangeText={setYear}
                  accessibilityLabel="Vehicle year"
                />
                <TextInput
                  style={[inputStyle, { flex: 1 }]}
                  placeholder="Plate"
                  placeholderTextColor={theme.colors.textMuted}
                  autoCapitalize="characters"
                  value={plate}
                  onChangeText={setPlate}
                  accessibilityLabel="Licence plate"
                />
                <TextInput
                  style={[inputStyle, { width: 70 }]}
                  placeholder="Seats"
                  placeholderTextColor={theme.colors.textMuted}
                  keyboardType="number-pad"
                  value={seats}
                  onChangeText={setSeats}
                  accessibilityLabel="Passenger seats"
                />
              </Row>
              <Row gap="sm" wrap>
                {COLORS.map((option) => (
                  <Pressable
                    key={option}
                    onPress={() => setColor(option)}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: color === option }}
                    accessibilityLabel={option}
                    style={{
                      paddingHorizontal: theme.spacing.md,
                      paddingVertical: theme.spacing.xs,
                      borderRadius: theme.radius.pill,
                      borderWidth: 2,
                      borderColor: color === option ? theme.colors.primary : theme.colors.border,
                    }}
                  >
                    <Text variant="caption">{option}</Text>
                  </Pressable>
                ))}
              </Row>
              <Button
                label="Add vehicle"
                onPress={() => void addVehicle()}
                loading={busy}
                disabled={!make.trim() || !model.trim() || plate.trim().length < 2}
              />
            </Column>
          )}
        </Column>

        <Divider />

        <Column gap="md">
          <Text variant="heading">Documents</Text>
          {DRIVER_DOCUMENT_TYPES.filter((t) => t !== 'vehicle_inspection').map((type) => {
            const doc = status?.profile.documents.find((d) => d.type === type);
            const state = doc?.status ?? 'missing';
            return (
              <Row key={type} justify="space-between">
                <Column gap="xxs" style={{ flex: 1 }}>
                  <Text variant="body">{DOCUMENT_LABELS[type] ?? type}</Text>
                  <Text variant="caption" color="muted">
                    {state === 'approved'
                      ? 'Approved'
                      : state === 'pending'
                        ? 'In review'
                        : state === 'rejected'
                          ? (doc?.rejectionReason ?? 'Rejected — please resubmit')
                          : 'Not submitted'}
                  </Text>
                </Column>
                {state === 'approved' ? (
                  <Badge label="Done" tone="success" />
                ) : (
                  <Pressable
                    onPress={() => void submitDocument(type)}
                    disabled={busy}
                    accessibilityRole="button"
                    accessibilityLabel={`Submit ${DOCUMENT_LABELS[type] ?? type}`}
                  >
                    <Text variant="caption" color="primary">
                      {submitted.has(type) ? 'Resubmit' : 'Submit'}
                    </Text>
                  </Pressable>
                )}
              </Row>
            );
          })}
        </Column>

        {status?.canGoOnline ? (
          <Button label="Start driving" variant="success" onPress={() => router.replace('/drive')} />
        ) : null}
      </ScrollView>
    </View>
  );
}
