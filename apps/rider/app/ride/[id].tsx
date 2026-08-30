/**
 * The live ride screen.
 *
 * One screen covers the whole trip because the rider's attention never really
 * leaves the map: searching, matched, driver arriving, on the way, and finally
 * rate-and-tip. The sheet's contents change with the ride's status; the map
 * underneath stays continuous.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  TextInput,
  View,
} from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  Badge,
  Button,
  Card,
  Column,
  Divider,
  DriverCard,
  FareSummary,
  Field,
  ItineraryLines,
  MapView,
  OptionRow,
  Row,
  ScreenHeader,
  Section,
  Sheet,
  Text,
  useCountdown,
  useTheme,
  type MapMarker,
  type MapPolyline,
} from '@lift/ui';
import {
  formatDuration,
  formatMoney,
  meetingPoint,
  statusLabel,
  type Ride,
} from '@lift/core';
import { ApiError, type CancellationPreview } from '@lift/sdk';
import { useApp } from '../../src/state/AppProvider.js';
import { useActiveRide } from '../../src/state/useActiveRide.js';

export default function RideScreen(): React.JSX.Element {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { client } = useApp();
  const { id } = useLocalSearchParams<{ id: string }>();

  const { ride, driver, vehicle, driverPosition, driverBearing, activeRoute, loading, refresh } =
    useActiveRide(id);

  const [preview, setPreview] = useState<CancellationPreview>();
  const [cancelling, setCancelling] = useState(false);
  const [cancelReasonOpen, setCancelReasonOpen] = useState(false);

  // Keep the cancellation cost current — it changes when the grace window ends.
  useEffect(() => {
    if (!ride || !['requested', 'accepted', 'arrived'].includes(ride.status)) return;
    const load = (): void => {
      void client
        .cancellationPreview(ride.id)
        .then(setPreview)
        .catch(() => {});
    };
    load();
    const timer = setInterval(load, 15_000);
    return () => clearInterval(timer);
  }, [client, ride]);

  /**
   * Cancelling asks *why*. The reason decides whether a fee is charged — a
   * driver who never moved is not a change of mind — and it is the only
   * signal the platform gets about a bad match, so guessing on the rider's
   * behalf throws that away.
   */
  const cancel = useCallback(
    async (reason: CancelReason, note?: string): Promise<void> => {
      if (!ride) return;
      setCancelling(true);
      try {
        await client.cancelRide(ride.id, { reason, ...(note ? { note } : {}) });
        setCancelReasonOpen(false);
        router.replace('/home');
      } catch (e) {
        Alert.alert('Could not cancel', e instanceof ApiError ? e.userMessage : 'Try again.');
      } finally {
        setCancelling(false);
      }
    },
    [client, ride],
  );

  const markers = useMemo<MapMarker[]>(() => {
    if (!ride) return [];
    const out: MapMarker[] = [
      {
        id: 'pickup',
        kind: 'pickup',
        coordinate: meetingPoint(ride.itinerary.pickup),
      },
      {
        id: 'dropoff',
        kind: 'dropoff',
        coordinate: meetingPoint(ride.itinerary.dropoff),
      },
    ];
    if (driverPosition) {
      out.push({
        id: 'driver',
        kind: 'car',
        coordinate: driverPosition,
        bearing: driverBearing ?? 0,
        zIndex: 20,
      });
    }
    return out;
  }, [ride, driverPosition, driverBearing]);

  const polylines = useMemo<MapPolyline[]>(
    () => (activeRoute.length > 1 ? [{ id: 'active', points: activeRoute, width: 5 }] : []),
    [activeRoute],
  );

  const fitTo = useMemo(() => {
    if (!ride) return [];
    // While the driver is inbound, frame them and the pickup — not the whole
    // trip, which would zoom too far out to see the car move.
    if (driverPosition && (ride.status === 'accepted' || ride.status === 'arrived')) {
      return [driverPosition, meetingPoint(ride.itinerary.pickup)];
    }
    return [...markers.map((m) => m.coordinate), ...activeRoute];
  }, [ride, driverPosition, markers, activeRoute]);

  if (loading && !ride) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color={theme.colors.primary} />
      </View>
    );
  }

  if (!ride) {
    return (
      <Column
        gap="lg"
        style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: theme.spacing.xl }}
      >
        <Text variant="heading">That ride is no longer available.</Text>
        <Button label="Back home" onPress={() => router.replace('/home')} fullWidth={false} />
      </Column>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <MapView markers={markers} polylines={polylines} fitTo={fitTo} style={{ flex: 1 }} />

      <View
        style={{
          position: 'absolute',
          top: insets.top + theme.spacing.sm,
          left: theme.spacing.lg,
        }}
      >
        <Badge label={statusLabel(ride.status)} tone="primary" />
      </View>

      {/*
        The safety shield is one tap from anywhere on a live ride. Burying it in
        a menu defeats the point of having it.
      */}
      {ride.status === 'accepted' || ride.status === 'arrived' || ride.status === 'in_progress' ? (
        <Pressable
          onPress={() => router.push({ pathname: '/safety', params: { rideId: ride.id } })}
          accessibilityRole="button"
          accessibilityLabel="Safety tools"
          hitSlop={10}
          style={{
            position: 'absolute',
            top: insets.top + theme.spacing.sm,
            right: theme.spacing.lg,
            backgroundColor: theme.colors.surface,
            borderRadius: theme.radius.pill,
            paddingHorizontal: theme.spacing.lg,
            paddingVertical: theme.spacing.sm,
            borderWidth: 1,
            borderColor: theme.colors.border,
            flexDirection: 'row',
            alignItems: 'center',
            gap: theme.spacing.xs,
          }}
        >
          <Text variant="body">🛡</Text>
          <Text variant="captionStrong">Safety</Text>
        </Pressable>
      ) : null}

      <Sheet style={{ paddingBottom: insets.bottom + theme.spacing.lg, maxHeight: '72%' }}>
        <ScrollView showsVerticalScrollIndicator={false}>
          {ride.status === 'requested' ? (
            <SearchingPanel ride={ride} onCancel={() => setCancelReasonOpen(true)} cancelling={cancelling} />
          ) : null}

          {(ride.status === 'accepted' || ride.status === 'arrived') && driver ? (
            <ArrivingPanel
              ride={ride}
              driverName={driver.name}
              driverRating={driver.rating}
              driverAvatar={driver.avatarUrl}
              vehicle={vehicle}
              preview={preview}
              onCancel={() => setCancelReasonOpen(true)}
              cancelling={cancelling}
              onMessage={() => router.push(`/ride/${ride.id}/chat` as never)}
            />
          ) : null}

          {ride.status === 'in_progress' && driver ? (
            <InProgressPanel ride={ride} driverName={driver.name} vehicle={vehicle} />
          ) : null}

          {ride.status === 'completed' ? (
            <CompletedPanel ride={ride} driverName={driver?.name ?? 'your driver'} onDone={refresh} />
          ) : null}

          {(ride.status === 'cancelled' || ride.status === 'expired') ? (
            <Column gap="lg">
              <Text variant="title">
                {ride.status === 'cancelled' ? 'Ride cancelled' : 'No drivers found'}
              </Text>
              <Text variant="body" color="secondary">
                {ride.status === 'cancelled'
                  ? ride.cancellation?.feeWaived === false
                    ? `A ${formatMoney(ride.cancellation.fee!)} cancellation fee was charged.`
                    : 'You were not charged.'
                  : 'Nobody was available nearby. Try again in a few minutes.'}
              </Text>
              <Button label="Back home" onPress={() => router.replace('/home')} />
            </Column>
          ) : null}
        </ScrollView>
      </Sheet>

      <CancelReasonSheet
        visible={cancelReasonOpen}
        preview={preview}
        busy={cancelling}
        onClose={() => setCancelReasonOpen(false)}
        onConfirm={(reason, note) => void cancel(reason, note)}
      />
    </View>
  );
}

/** Waiting for a driver: a live count of how long the search has run. */
const SearchingPanel = ({
  ride,
  onCancel,
  cancelling,
}: {
  ride: Ride;
  onCancel: () => void;
  cancelling: boolean;
}): React.JSX.Element => {
  const theme = useTheme();
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const started = ride.requestedAt ?? Date.now();
    const timer = setInterval(() => setElapsed(Date.now() - started), 1_000);
    return () => clearInterval(timer);
  }, [ride.requestedAt]);

  return (
    <Column gap="lg">
      <Row gap="md">
        <ActivityIndicator color={theme.colors.primary} />
        <Column gap="xxs" style={{ flex: 1 }}>
          <Text variant="heading">Finding your driver</Text>
          <Text variant="caption" color="secondary">
            Searching for {Math.floor(elapsed / 1000)}s · we are contacting drivers nearby
          </Text>
        </Column>
      </Row>

      <Divider />
      <ItineraryLines
        pickup={ride.itinerary.pickup.name}
        dropoff={ride.itinerary.dropoff.name}
        stops={ride.itinerary.stops.map((s) => s.place.name)}
      />
      <Divider />

      <Row justify="space-between">
        <Text variant="caption" color="secondary">
          Estimated fare
        </Text>
        <Text variant="captionStrong">{formatMoney(ride.quotedFare.total)}</Text>
      </Row>

      <Button label="Cancel ride" variant="secondary" onPress={onCancel} loading={cancelling} />
    </Column>
  );
};

/** Matched: who is coming, in what, and how long until they arrive. */
const ArrivingPanel = ({
  ride,
  driverName,
  driverRating,
  driverAvatar,
  vehicle,
  preview,
  onCancel,
  cancelling,
  onMessage,
}: {
  ride: Ride;
  driverName: string;
  driverRating: number;
  driverAvatar?: string;
  vehicle?: { make: string; model: string; color: string; licensePlate: string };
  preview?: CancellationPreview;
  onCancel: () => void;
  cancelling: boolean;
  onMessage: () => void;
}): React.JSX.Element => {
  const arrived = ride.status === 'arrived';
  const etaMs = ride.assignment?.initialPickupEtaMs ?? 0;
  const freeWindow = useCountdown(
    preview?.freeWindowRemainingMs && preview.freeWindowRemainingMs > 0
      ? Date.now() + preview.freeWindowRemainingMs
      : undefined,
  );

  return (
    <Column gap="lg">
      <Column gap="xxs">
        <Text variant="title">
          {arrived ? 'Your driver is here' : `Arriving in ${formatDuration(etaMs)}`}
        </Text>
        <Text variant="caption" color="secondary">
          {arrived
            ? `Look for the ${vehicle ? `${vehicle.color} ${vehicle.make}` : 'car'} at ${ride.itinerary.pickup.name}`
            : `Meet ${driverName.split(' ')[0]} at ${ride.itinerary.pickup.name}`}
        </Text>
      </Column>

      <Card padded="md">
        <DriverCard
          name={driverName}
          avatarUrl={driverAvatar}
          rating={driverRating}
          vehicle={vehicle}
        />
      </Card>

      <Row gap="sm">
        <Button label="Message" variant="secondary" onPress={onMessage} />
      </Row>

      <Divider />
      <ItineraryLines pickup={ride.itinerary.pickup.name} dropoff={ride.itinerary.dropoff.name} />
      <Divider />

      <Column gap="xs">
        <Button label="Cancel ride" variant="ghost" onPress={onCancel} loading={cancelling} />
        {preview ? (
          <Text variant="caption" color="muted" align="center">
            {preview.waived && freeWindow.remainingMs > 0
              ? `Free to cancel for another ${Math.ceil(freeWindow.remainingMs / 1000)}s`
              : preview.explanation}
          </Text>
        ) : null}
      </Column>
    </Column>
  );
};

/** On the trip: destination, ETA, and the safety tools. */
const InProgressPanel = ({
  ride,
  driverName,
  vehicle,
}: {
  ride: Ride;
  driverName: string;
  vehicle?: { make: string; model: string; color: string; licensePlate: string };
}): React.JSX.Element => {
  const tripLeg = ride.legs.find((l) => l.kind === 'to_dropoff');
  const arrivalAt = (ride.startedAt ?? Date.now()) + (tripLeg?.durationMs ?? 0);
  const remainingMs = Math.max(0, arrivalAt - Date.now());

  return (
    <Column gap="lg">
      <Column gap="xxs">
        <Text variant="title">{formatDuration(remainingMs)} to go</Text>
        <Text variant="caption" color="secondary">
          Heading to {ride.itinerary.dropoff.name}
        </Text>
      </Column>

      <Card padded="md">
        <Row justify="space-between">
          <Text variant="caption" color="secondary">
            {driverName}
            {vehicle ? ` · ${vehicle.licensePlate}` : ''}
          </Text>
          <Text variant="captionStrong">{formatMoney(ride.quotedFare.total)}</Text>
        </Row>
      </Card>

      <Divider />
      <ItineraryLines
        pickup={ride.itinerary.pickup.name}
        dropoff={ride.itinerary.dropoff.name}
        stops={ride.itinerary.stops.map((s) => s.place.name)}
      />

      <Row gap="sm">
        <Button
          label="Safety"
          variant="secondary"
          onPress={() => router.push({ pathname: '/safety', params: { rideId: ride.id } })}
        />
        <Button
          label="Get help"
          variant="ghost"
          onPress={() => router.push({ pathname: '/support', params: { rideId: ride.id } })}
        />
      </Row>
    </Column>
  );
};

/** Arrived: the receipt, a rating, and a tip. */
const CompletedPanel = ({
  ride,
  driverName,
  onDone,
}: {
  ride: Ride;
  driverName: string;
  onDone: () => void;
}): React.JSX.Element => {
  const theme = useTheme();
  const { client } = useApp();
  const [stars, setStars] = useState(0);
  const [tip, setTip] = useState(0);
  const [comment, setComment] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const alreadyRated = ride.driverRating !== undefined;
  const fare = ride.finalFare ?? ride.quotedFare;

  /**
   * Tips scale with the fare rather than being fixed amounts: a flat $3 is
   * generous on a short hop and stingy on an airport run, and fixed cents are
   * meaningless in another currency. Rounded to a whole unit so the buttons
   * read cleanly.
   */
  const tipOptions = useMemo(() => {
    const unit = 100;
    const suggestions = [0.15, 0.2, 0.25].map(
      (rate) => Math.max(unit, Math.round((fare.total.amount * rate) / unit) * unit),
    );
    return [0, ...new Set(suggestions)];
  }, [fare.total.amount]);

  const submit = async (): Promise<void> => {
    setSubmitting(true);
    try {
      await client.rateRide(ride.id, {
        stars,
        ...(comment.trim() ? { comment: comment.trim() } : {}),
        ...(tip > 0 ? { tipAmount: tip } : {}),
      });
      onDone();
      router.replace('/home');
    } catch (e) {
      Alert.alert('Could not submit', e instanceof ApiError ? e.userMessage : 'Try again.');
    } finally {
      setSubmitting(false);
    }
  };

  if (alreadyRated) {
    return (
      <Column gap="lg">
        <Text variant="title">Thanks for riding</Text>
        <FareSummary fare={fare} title="Your receipt" />
        <Button label="Done" onPress={() => router.replace('/home')} />
      </Column>
    );
  }

  return (
    <Column gap="lg">
      <Column gap="xxs">
        <Text variant="title">How was your ride?</Text>
        <Text variant="caption" color="secondary">
          Rate {driverName.split(' ')[0]} — it stays anonymous.
        </Text>
      </Column>

      <Row gap="sm" justify="center">
        {[1, 2, 3, 4, 5].map((value) => (
          <Pressable
            key={value}
            onPress={() => setStars(value)}
            accessibilityRole="button"
            accessibilityLabel={`${value} star${value > 1 ? 's' : ''}`}
            hitSlop={6}
          >
            <Text style={{ fontSize: 36, opacity: value <= stars ? 1 : 0.25 }}>★</Text>
          </Pressable>
        ))}
      </Row>

      {stars > 0 ? (
        <>
          <Column gap="sm">
            <Text variant="captionStrong">Add a tip</Text>
            <Row gap="sm">
              {tipOptions.map((amount) => (
                <Pressable
                  key={amount}
                  onPress={() => setTip(amount)}
                  accessibilityRole="button"
                  accessibilityLabel={
                    amount === 0
                      ? 'No tip'
                      : `Tip ${formatMoney({ amount, currency: fare.total.currency })}`
                  }
                  style={{
                    flex: 1,
                    paddingVertical: theme.spacing.md,
                    borderRadius: theme.radius.md,
                    alignItems: 'center',
                    borderWidth: 2,
                    borderColor: tip === amount ? theme.colors.primary : theme.colors.border,
                    backgroundColor:
                      tip === amount ? theme.colors.primaryMuted : 'transparent',
                  }}
                >
                  <Text variant="captionStrong">
                    {amount === 0
                      ? 'None'
                      : formatMoney({ amount, currency: fare.total.currency }, { showCents: false })}
                  </Text>
                </Pressable>
              ))}
            </Row>
          </Column>

          <TextInput
            value={comment}
            onChangeText={setComment}
            placeholder="Add a note (optional)"
            placeholderTextColor={theme.colors.textMuted}
            accessibilityLabel="Comment"
            multiline
            style={{
              backgroundColor: theme.colors.surfaceSunken,
              borderRadius: theme.radius.md,
              padding: theme.spacing.md,
              minHeight: 64,
              color: theme.colors.text,
            }}
          />
        </>
      ) : null}

      <Divider />
      <FareSummary fare={fare} title="Your receipt" />

      <Button
        label={stars > 0 ? 'Submit' : 'Skip'}
        onPress={() => (stars > 0 ? void submit() : router.replace('/home'))}
        loading={submitting}
      />
    </Column>
  );
};

/** The reasons the API accepts. Kept in one place so the copy and the wire
 *  value cannot drift apart. */
type CancelReason =
  | 'rider_changed_mind'
  | 'rider_wait_too_long'
  | 'rider_wrong_address'
  | 'driver_no_show'
  | 'safety_concern'
  | 'other';

const CANCEL_REASONS: readonly { value: CancelReason; label: string; description: string }[] = [
  {
    value: 'rider_changed_mind',
    label: 'I changed my mind',
    description: 'No longer need this trip.',
  },
  {
    value: 'rider_wait_too_long',
    label: 'The wait was too long',
    description: 'The ETA kept growing or the driver was not moving.',
  },
  {
    value: 'rider_wrong_address',
    label: 'I set the wrong address',
    description: 'The pickup or destination was not right.',
  },
  {
    value: 'driver_no_show',
    label: 'The driver never arrived',
    description: "They were marked as here but weren't.",
  },
  {
    value: 'safety_concern',
    label: 'Something felt unsafe',
    description: 'This is reviewed by our safety team.',
  },
  { value: 'other', label: 'Another reason', description: '' },
];

const CancelReasonSheet = ({
  visible,
  preview,
  busy,
  onClose,
  onConfirm,
}: {
  visible: boolean;
  preview?: CancellationPreview;
  busy: boolean;
  onClose: () => void;
  onConfirm: (reason: CancelReason, note?: string) => void;
}): React.JSX.Element => {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const [reason, setReason] = useState<CancelReason>('rider_changed_mind');
  const [note, setNote] = useState('');

  const fee = preview && !preview.waived ? formatMoney(preview.fee as never) : undefined;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable
        onPress={onClose}
        accessibilityLabel="Keep my ride"
        style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.4)' }}
      />
      <View
        style={{
          backgroundColor: theme.colors.background,
          borderTopLeftRadius: theme.radius.xl,
          borderTopRightRadius: theme.radius.xl,
          paddingBottom: insets.bottom + theme.spacing.lg,
          maxHeight: '80%',
        }}
      >
        <ScreenHeader title="Cancel this ride?" onBack={onClose} />
        <ScrollView
          contentContainerStyle={{ padding: theme.spacing.lg, gap: theme.spacing.md }}
          keyboardShouldPersistTaps="handled"
        >
          {/* The fee is stated before the choice, not after it. */}
          <Text variant="caption" color={fee ? 'danger' : 'muted'}>
            {fee
              ? `A ${fee} cancellation fee applies — your driver is already on the way.`
              : (preview?.explanation ?? 'You will not be charged.')}
          </Text>

          <Section title="Why are you cancelling?">
            {CANCEL_REASONS.map((option) => (
              <OptionRow
                key={option.value}
                label={option.label}
                {...(option.description ? { description: option.description } : {})}
                selected={reason === option.value}
                onSelect={() => setReason(option.value)}
              />
            ))}
          </Section>

          {reason === 'other' || reason === 'safety_concern' ? (
            <Field
              label="Tell us more"
              value={note}
              onChangeText={setNote}
              multiline
              maxLength={300}
              placeholder="What happened?"
            />
          ) : null}

          <Button
            label="Cancel my ride"
            variant="danger"
            onPress={() => onConfirm(reason, note.trim() || undefined)}
            loading={busy}
          />
          <Button label="Keep my ride" variant="ghost" onPress={onClose} />
        </ScrollView>
      </View>
    </Modal>
  );
};
