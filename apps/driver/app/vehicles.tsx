/**
 * Your vehicles.
 *
 * A driver with two cars needs to say which one they are in tonight, because
 * the rider is told a plate to look for. Switching is one tap; adding one is a
 * short form, because the details are checked before it can be used anyway.
 */

import React, { useCallback, useState } from 'react';
import { Alert, Modal, ScrollView, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  Badge,
  Button,
  Card,
  Column,
  EmptyState,
  Field,
  Row,
  ScreenHeader,
  Section,
  Text,
  useTheme,
} from '@lift/ui';
import {
  VEHICLE_COLORS,
  VEHICLE_FEATURES,
  type Vehicle,
  type VehicleColor,
  type VehicleFeature,
} from '@lift/core';
import { ApiError } from '@lift/sdk';
import { useDriver } from '../src/state/DriverProvider.js';

export default function Vehicles(): React.JSX.Element {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { client, status, refresh } = useDriver();

  const [vehicles, setVehicles] = useState<readonly Vehicle[]>([]);
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    try {
      setVehicles((await client.vehicles()).vehicles);
    } catch {
      setVehicles([]);
    }
  }, [client]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const activeId = status?.vehicle?.id;

  const activate = async (vehicle: Vehicle): Promise<void> => {
    try {
      await client.activateVehicle(vehicle.id);
      await Promise.all([load(), refresh()]);
    } catch (e) {
      Alert.alert('Could not switch', e instanceof ApiError ? e.userMessage : 'Try again.');
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background, paddingTop: insets.top }}>
      <ScreenHeader title="Your vehicles" onBack={() => router.back()} />

      <ScrollView
        contentContainerStyle={{
          padding: theme.spacing.lg,
          paddingBottom: insets.bottom + theme.spacing.xxl,
          gap: theme.spacing.lg,
        }}
      >
        {vehicles.length === 0 ? (
          <EmptyState
            icon="🚗"
            title="No vehicles yet"
            message="Add the car you drive so riders know what to look for."
            action={<Button label="Add a vehicle" onPress={() => setAdding(true)} />}
          />
        ) : (
          <>
            {vehicles.map((vehicle) => (
              <Card key={vehicle.id}>
                <Column gap="md">
                  <Row justify="space-between" align="flex-start">
                    <Column gap="xxs" style={{ flex: 1 }}>
                      <Text variant="heading">
                        {humanize(vehicle.color)} {vehicle.make} {vehicle.model}
                      </Text>
                      <Text variant="caption" color="muted">
                        {vehicle.year} · {vehicle.licensePlate} · {vehicle.seats} seats
                      </Text>
                    </Column>
                    {vehicle.id === activeId ? <Badge label="In use" tone="success" /> : null}
                  </Row>

                  {vehicle.features.length > 0 ? (
                    <Row gap="sm" wrap>
                      {vehicle.features.map((feature) => (
                        <Badge key={feature} label={humanize(feature)} />
                      ))}
                    </Row>
                  ) : null}

                  {vehicle.id !== activeId ? (
                    <Button
                      label="Drive this one"
                      variant="secondary"
                      onPress={() => void activate(vehicle)}
                    />
                  ) : null}
                </Column>
              </Card>
            ))}
            <Button label="Add another vehicle" variant="secondary" onPress={() => setAdding(true)} />
          </>
        )}

        <Section title="Why this matters">
          <Column gap="sm" style={{ paddingVertical: theme.spacing.sm }}>
            <Text variant="caption" color="secondary">
              Riders are shown the plate, colour, make, and model of whichever vehicle is in use.
              Arriving in a different one is the single most common reason a rider refuses to get
              in.
            </Text>
          </Column>
        </Section>
      </ScrollView>

      <AddVehicleSheet
        visible={adding}
        onClose={() => setAdding(false)}
        onAdded={() => {
          setAdding(false);
          void load();
          void refresh();
        }}
      />
    </View>
  );
}

const AddVehicleSheet = ({
  visible,
  onClose,
  onAdded,
}: {
  visible: boolean;
  onClose: () => void;
  onAdded: () => void;
}): React.JSX.Element => {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { client } = useDriver();

  const [make, setMake] = useState('');
  const [model, setModel] = useState('');
  const [year, setYear] = useState('');
  const [color, setColor] = useState<VehicleColor>('silver');
  const [features, setFeatures] = useState<readonly VehicleFeature[]>([]);
  const [plate, setPlate] = useState('');
  const [seats, setSeats] = useState('4');
  const [busy, setBusy] = useState(false);

  const parsedYear = Number.parseInt(year, 10);
  const parsedSeats = Number.parseInt(seats, 10);
  const complete =
    make.trim() &&
    model.trim() &&
    plate.trim() &&
    Number.isFinite(parsedYear) &&
    parsedYear > 1980 &&
    Number.isFinite(parsedSeats) &&
    parsedSeats >= 2;

  const save = async (): Promise<void> => {
    setBusy(true);
    try {
      await client.addVehicle({
        make: make.trim(),
        model: model.trim(),
        year: parsedYear,
        color,
        features: [...features],
        licensePlate: plate.trim().toUpperCase(),
        seats: parsedSeats,
      });
      onAdded();
    } catch (e) {
      Alert.alert('Could not add', e instanceof ApiError ? e.userMessage : 'Check the details.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)' }} />
      <View
        style={{
          backgroundColor: theme.colors.background,
          borderTopLeftRadius: theme.radius.xl,
          borderTopRightRadius: theme.radius.xl,
          paddingBottom: insets.bottom + theme.spacing.lg,
          maxHeight: '85%',
        }}
      >
        <ScreenHeader title="Add a vehicle" onBack={onClose} />
        <ScrollView
          contentContainerStyle={{ padding: theme.spacing.lg, gap: theme.spacing.md }}
          keyboardShouldPersistTaps="handled"
        >
          <Row gap="md">
            <View style={{ flex: 1 }}>
              <Field label="Make" value={make} onChangeText={setMake} placeholder="Toyota" />
            </View>
            <View style={{ flex: 1 }}>
              <Field label="Model" value={model} onChangeText={setModel} placeholder="Camry" />
            </View>
          </Row>
          <Field
            label="Year"
            value={year}
            onChangeText={setYear}
            keyboardType="number-pad"
            placeholder="2021"
          />

          {/* A fixed vocabulary: the rider is told a colour to spot from a kerb. */}
          <Column gap="sm">
            <Text variant="label" color="muted">
              COLOUR
            </Text>
            <Row gap="sm" wrap>
              {VEHICLE_COLORS.map((option) => (
                <Button
                  key={option}
                  label={humanize(option)}
                  variant={color === option ? 'primary' : 'secondary'}
                  size="sm"
                  onPress={() => setColor(option)}
                />
              ))}
            </Row>
          </Column>
          <Field
            label="Licence plate"
            value={plate}
            onChangeText={setPlate}
            autoCapitalize="characters"
            placeholder="7ABC123"
            hint="Riders check this before they get in — it has to be exact."
          />
          <Field
            label="Seats for passengers"
            value={seats}
            onChangeText={setSeats}
            keyboardType="number-pad"
            hint="Not counting you."
          />
          <Button
            label="Add vehicle"
            onPress={() => void save()}
            disabled={!complete || busy}
            loading={busy}
          />
          <Column gap="sm">
            <Text variant="label" color="muted">
              FEATURES
            </Text>
            <Row gap="sm" wrap>
              {VEHICLE_FEATURES.map((feature) => (
                <Button
                  key={feature}
                  label={humanize(feature)}
                  variant={features.includes(feature) ? 'primary' : 'secondary'}
                  size="sm"
                  onPress={() =>
                    setFeatures((current) =>
                      current.includes(feature)
                        ? current.filter((f) => f !== feature)
                        : [...current, feature],
                    )
                  }
                />
              ))}
            </Row>
          </Column>

          <Text variant="caption" color="muted">
            A new vehicle is checked before you can drive with it. Which ride types it qualifies
            for is worked out from its year and seats.
          </Text>
        </ScrollView>
      </View>
    </Modal>
  );
};

/** Machine codes become words: `wheelchair_accessible` → "Wheelchair accessible". */
const humanize = (value: string): string =>
  value.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
