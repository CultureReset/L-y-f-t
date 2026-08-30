/**
 * Confirm the ride: the route on the map, a price per class of service, and
 * the button that actually books it.
 *
 * The quote is server-computed and carries an id; booking cites that id so the
 * price the rider confirms is provably the price they were shown.
 *
 * The whole itinerary — pickup, stops, dropoff — lives in the route params, so
 * editing any one of them through the search screen round-trips the rest
 * rather than dropping it.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, Modal, Pressable, ScrollView, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import * as Location from 'expo-location';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  Badge,
  Button,
  Card,
  Column,
  Divider,
  Field,
  ItineraryLines,
  MapView,
  RideTypeOption,
  Row,
  ScreenHeader,
  Sheet,
  Text,
  useTheme,
  type MapMarker,
  type MapPolyline,
} from '@lift/ui';
import {
  decodePolyline,
  formatDuration,
  formatMoney,
  meetingPoint,
  type LatLng,
  type Place,
  type Waypoint,
} from '@lift/core';
import { ApiError, type PaymentMethodView, type QuoteResponse } from '@lift/sdk';
import { useApp } from '../src/state/AppProvider.js';

/** A JSON param that may be absent or malformed; never throw over one. */
const parseParam = <T,>(raw: string | undefined, fallback: T): T => {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
};

export default function Confirm(): React.JSX.Element {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { client, config } = useApp();
  const params = useLocalSearchParams<{
    pickup?: string;
    dropoff?: string;
    stops?: string;
  }>();

  const [pickup, setPickup] = useState<Place>();
  const [dropoff, setDropoff] = useState<Place>();
  const [stops, setStops] = useState<readonly Waypoint[]>([]);
  const [quote, setQuote] = useState<QuoteResponse>();
  const [selected, setSelected] = useState<string>();
  const [method, setMethod] = useState<PaymentMethodView>();
  const [passengers, setPassengers] = useState(1);
  const [note, setNote] = useState('');
  const [promoCode, setPromoCode] = useState('');
  const [scheduledFor, setScheduledFor] = useState<number>();
  const [sheet, setSheet] = useState<'none' | 'schedule' | 'promo' | 'note' | 'info'>('none');
  const [infoRideTypeId, setInfoRideTypeId] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [booking, setBooking] = useState(false);
  const [error, setError] = useState<string>();

  // The itinerary arrives from search or home; the pickup defaults to where
  // the rider is.
  useEffect(() => {
    const nextDropoff = parseParam<Place | undefined>(params.dropoff, undefined);
    if (nextDropoff) setDropoff(nextDropoff);
    const nextPickup = parseParam<Place | undefined>(params.pickup, undefined);
    if (nextPickup) setPickup(nextPickup);
    setStops(parseParam<Waypoint[]>(params.stops, []));
  }, [params.pickup, params.dropoff, params.stops]);

  /**
   * Work out the pickup point. A location fix is the best answer, but it can be
   * denied, or simply never resolve — so it is raced against a timeout and
   * falls back to the market centre. The rider always ends up with a pickup
   * they can then correct by hand, rather than a spinner that never stops.
   */
  useEffect(() => {
    if (pickup || params.pickup || !config) return;
    let cancelled = false;

    // The timeout wraps the permission prompt as well as the fix itself: a
    // prompt the user never answers hangs just as effectively as a slow GPS.
    const currentPosition = async (): Promise<LatLng | undefined> => {
      const attempt = async (): Promise<LatLng | undefined> => {
        const permission = await Location.requestForegroundPermissionsAsync();
        if (!permission.granted) return undefined;
        const fix = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.Balanced,
        });
        return { lat: fix.coords.latitude, lng: fix.coords.longitude };
      };

      try {
        return await Promise.race([
          attempt(),
          new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 5_000)),
        ]);
      } catch {
        return undefined;
      }
    };

    const resolvePickup = async (): Promise<void> => {
      const coordinates = (await currentPosition()) ?? config.market.defaultCenter;
      if (cancelled) return;
      try {
        const { place } = await client.reverseGeocode(coordinates);
        if (!cancelled) setPickup(place);
      } catch {
        if (!cancelled) setError('We could not work out your pickup point. Tap to set it.');
      }
    };

    void resolvePickup();
    return () => {
      cancelled = true;
    };
  }, [client, config, pickup, params.pickup]);

  useEffect(() => {
    void client
      .paymentMethods()
      .then((r) => setMethod(r.methods.find((m) => m.isDefault) ?? r.methods[0]))
      .catch(() => {});
  }, [client]);

  const loadQuote = useCallback(async () => {
    if (!pickup || !dropoff) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(undefined);
    try {
      const response = await client.quote({
        pickup,
        dropoff,
        stops,
        passengerCount: passengers,
        ...(promoCode ? { promoCode } : {}),
        ...(scheduledFor ? { scheduledFor } : {}),
      });
      setQuote(response);
      // Keep the rider's choice if it is still offered; otherwise pick the
      // first available tier.
      setSelected((current) => {
        const stillValid = response.quotes.find((q) => q.rideTypeId === current && q.available);
        return stillValid?.rideTypeId ?? response.quotes.find((q) => q.available)?.rideTypeId;
      });
    } catch (e) {
      setError(e instanceof ApiError ? e.userMessage : 'Could not price that trip.');
    } finally {
      setLoading(false);
    }
  }, [client, pickup, dropoff, stops, passengers, promoCode, scheduledFor]);

  useEffect(() => {
    void loadQuote();
  }, [loadQuote]);

  // A quote goes stale; refresh it before it expires rather than failing the
  // booking with an expired-quote error.
  useEffect(() => {
    if (!quote) return;
    const msUntilRefresh = Math.max(5_000, quote.expiresAt - Date.now() - 30_000);
    const timer = setTimeout(() => void loadQuote(), msUntilRefresh);
    return () => clearTimeout(timer);
  }, [quote, loadQuote]);

  const chosen = useMemo(
    () => quote?.quotes.find((q) => q.rideTypeId === selected),
    [quote, selected],
  );

  /** Navigate to search, carrying the whole itinerary so nothing is lost. */
  const editField = useCallback(
    (field: 'pickup' | 'dropoff' | 'stop') => {
      router.push({
        pathname: '/search',
        params: {
          field,
          pickup: pickup ? JSON.stringify(pickup) : '',
          dropoff: dropoff ? JSON.stringify(dropoff) : '',
          stops: JSON.stringify(stops),
        },
      });
    },
    [pickup, dropoff, stops],
  );

  const book = async (): Promise<void> => {
    if (!pickup || !dropoff || !chosen || !quote) return;
    setBooking(true);
    setError(undefined);
    try {
      const { ride } = await client.requestRide({
        rideTypeId: chosen.rideTypeId,
        pickup,
        dropoff,
        stops,
        passengerCount: passengers,
        quoteId: quote.quoteId,
        ...(note.trim() ? { riderNote: note.trim() } : {}),
        ...(promoCode ? { promoCode } : {}),
        ...(scheduledFor ? { scheduledFor } : {}),
        ...(method ? { paymentMethodId: method.id } : {}),
      });
      // A ride booked for later has no live screen to watch yet.
      router.replace(scheduledFor ? '/activity' : `/ride/${ride.id}`);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'quote_expired') {
        // Silently re-price and let the rider confirm the fresh number.
        await loadQuote();
        setError('That price expired, so we refreshed it. Tap again to confirm.');
      } else {
        setError(e instanceof ApiError ? e.userMessage : 'Could not book that ride.');
      }
    } finally {
      setBooking(false);
    }
  };

  const markers = useMemo<MapMarker[]>(() => {
    const out: MapMarker[] = [];
    if (pickup) out.push({ id: 'pickup', kind: 'pickup', coordinate: meetingPoint(pickup) });
    stops.forEach((stop, index) => {
      out.push({ id: `stop-${index}`, kind: 'stop', coordinate: meetingPoint(stop.place) });
    });
    if (dropoff) out.push({ id: 'dropoff', kind: 'dropoff', coordinate: meetingPoint(dropoff) });
    return out;
  }, [pickup, dropoff, stops]);

  const polylines = useMemo<MapPolyline[]>(
    () =>
      quote?.route.geometry
        ? [{ id: 'route', points: decodePolyline(quote.route.geometry), width: 5 }]
        : [],
    [quote],
  );

  const canAddStop = (config?.features.multiStop ?? false) && stops.length < 3;
  const canSchedule = config?.features.scheduledRides ?? false;
  const canPromo = config?.features.promoCodes ?? false;

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <MapView
        markers={markers}
        polylines={polylines}
        fitTo={[...markers.map((m) => m.coordinate), ...(polylines[0]?.points ?? [])]}
        style={{ flex: 1 }}
        testID="confirm-map"
      />

      <Pressable
        onPress={() => router.back()}
        accessibilityRole="button"
        accessibilityLabel="Back"
        style={{
          position: 'absolute',
          top: insets.top + theme.spacing.sm,
          left: theme.spacing.lg,
          width: 44,
          height: 44,
          borderRadius: 22,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: theme.colors.surface,
          ...theme.elevation.medium,
        }}
      >
        <Text variant="title">←</Text>
      </Pressable>

      <Sheet style={{ paddingBottom: insets.bottom + theme.spacing.lg, maxHeight: '78%' }}>
        <ScrollView showsVerticalScrollIndicator={false} style={{ flexShrink: 1 }}>
          <Column gap="md">
            {/* The itinerary. Every line is tappable, including each stop. */}
            <Column gap="xs">
              <Pressable
                onPress={() => editField('pickup')}
                accessibilityRole="button"
                accessibilityLabel="Change pickup"
              >
                <ItineraryLines
                  pickup={pickup?.name ?? 'Tap to set your pickup'}
                  dropoff={dropoff?.name ?? 'Tap to set your destination'}
                  stops={stops.map((s) => s.place.name)}
                />
              </Pressable>

              <Row gap="sm" wrap>
                {canAddStop ? (
                  <Button label="+ Add stop" variant="ghost" size="sm" onPress={() => editField('stop')} />
                ) : null}
                {stops.length > 0 ? (
                  <Button
                    label="Clear stops"
                    variant="ghost"
                    size="sm"
                    onPress={() => setStops([])}
                  />
                ) : null}
                <Button
                  label="Change destination"
                  variant="ghost"
                  size="sm"
                  onPress={() => editField('dropoff')}
                />
              </Row>
            </Column>

            <Divider />

            {!quote ? (
              <Column gap="md" style={{ paddingVertical: theme.spacing.xl }}>
                {loading ? <ActivityIndicator color={theme.colors.primary} /> : null}
                <Text variant="caption" color="muted" align="center">
                  {loading
                    ? 'Pricing your trip…'
                    : pickup
                      ? 'Choose a destination to see prices.'
                      : 'Set your pickup to see prices.'}
                </Text>
              </Column>
            ) : null}

            {quote ? (
              <>
                <Row justify="space-between">
                  <Text variant="caption" color="secondary">
                    {formatDuration(quote.route.durationMs)} ·{' '}
                    {(quote.route.distanceMeters / 1609.344).toFixed(1)} mi
                  </Text>
                  <PassengerStepper value={passengers} onChange={setPassengers} />
                </Row>

                <Column gap="xs">
                  {quote.quotes.map((option) => (
                    <Pressable
                      key={option.rideTypeId}
                      onLongPress={() => {
                        setInfoRideTypeId(option.rideTypeId);
                        setSheet('info');
                      }}
                      delayLongPress={300}
                    >
                      <RideTypeOption
                        quote={option}
                        selected={option.rideTypeId === selected}
                        onSelect={() => setSelected(option.rideTypeId)}
                      />
                    </Pressable>
                  ))}
                  <Text variant="caption" color="muted" align="center">
                    Hold a ride type to see what it includes.
                  </Text>
                </Column>

                <Divider />

                {/* Everything optional lives in one row of chips rather than
                    stacking four more sections above the confirm button. */}
                <Row gap="sm" wrap>
                  <Chip
                    label={
                      scheduledFor ? `🕒 ${formatWhen(scheduledFor)}` : '🕒 Ride now'
                    }
                    active={scheduledFor !== undefined}
                    onPress={() => setSheet('schedule')}
                    disabled={!canSchedule}
                  />
                  <Chip
                    label={quote.promo ? `🏷 ${quote.promo.code}` : '🏷 Promo'}
                    active={Boolean(quote.promo)}
                    onPress={() => setSheet('promo')}
                    disabled={!canPromo}
                  />
                  <Chip
                    label={note.trim() ? '📝 Note added' : '📝 Note'}
                    active={note.trim().length > 0}
                    onPress={() => setSheet('note')}
                  />
                  <Chip
                    label={method ? `💳 ${method.displayLabel}` : '💳 Add card'}
                    active={false}
                    onPress={() => router.push('/wallet')}
                  />
                </Row>

                {quote.promoError ? (
                  <Text variant="caption" color="danger">
                    {quote.promoError}
                  </Text>
                ) : null}
                {quote.promo ? (
                  <Text variant="caption" color="success">
                    {quote.promo.label} applied.
                  </Text>
                ) : null}
              </>
            ) : null}

            {error ? (
              <Text variant="caption" color="danger">
                {error}
              </Text>
            ) : null}

          </Column>
        </ScrollView>

        {/*
          The primary action is pinned below the scroll region. Letting it
          scroll away behind five ride types is how a rider ends up unable to
          find the button that books the trip.
        */}
        <Column gap="sm" style={{ paddingTop: theme.spacing.md }}>
          <Divider />
          <Button
            label={
              chosen
                ? scheduledFor
                  ? `Schedule ${chosen.name}`
                  : `Confirm ${chosen.name}`
                : 'Choose a ride'
            }
            caption={chosen ? formatMoney(chosen.fare.total) : undefined}
            onPress={() => void book()}
            loading={booking}
            disabled={!chosen || loading}
          />
        </Column>
      </Sheet>

      <SchedulePicker
        visible={sheet === 'schedule'}
        value={scheduledFor}
        onClose={() => setSheet('none')}
        onChange={(next) => {
          setScheduledFor(next);
          setSheet('none');
        }}
      />

      <PromoSheet
        visible={sheet === 'promo'}
        applied={quote?.promo?.code}
        onClose={() => setSheet('none')}
        onApply={(code) => {
          setPromoCode(code);
          setSheet('none');
        }}
      />

      <NoteSheet
        visible={sheet === 'note'}
        value={note}
        onClose={() => setSheet('none')}
        onSave={(next) => {
          setNote(next);
          setSheet('none');
        }}
      />

      <RideTypeInfo
        visible={sheet === 'info'}
        rideTypeId={infoRideTypeId}
        onClose={() => setSheet('none')}
      />
    </View>
  );
}

// ------------------------------------------------------------------ pieces

/** "Today, 6:15 PM" — the answer to "when is this ride?". */
const formatWhen = (at: number): string => {
  const when = new Date(at);
  const today = new Date();
  const sameDay = when.toDateString() === today.toDateString();
  const tomorrow = new Date(today.getTime() + 86_400_000);
  const isTomorrow = when.toDateString() === tomorrow.toDateString();
  const time = when.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (sameDay) return `Today ${time}`;
  if (isTomorrow) return `Tomorrow ${time}`;
  return `${when.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' })} ${time}`;
};

const Chip = ({
  label,
  active,
  onPress,
  disabled = false,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
  disabled?: boolean;
}): React.JSX.Element | null => {
  const theme = useTheme();
  // A control for a feature this market has turned off is not shown at all —
  // a greyed-out button that can never work is worse than no button.
  if (disabled) return null;

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={{
        paddingHorizontal: theme.spacing.md,
        paddingVertical: theme.spacing.sm,
        borderRadius: theme.radius.pill,
        borderWidth: 1,
        borderColor: active ? theme.colors.primary : theme.colors.border,
        backgroundColor: active ? theme.colors.primaryMuted : 'transparent',
      }}
    >
      <Text variant="caption" color={active ? 'primary' : 'secondary'}>
        {label}
      </Text>
    </Pressable>
  );
};

/**
 * A modal that sits over the sheet. Used for every optional detail, so they
 * all behave the same way and none of them push the confirm button off screen.
 */
const BottomSheetModal = ({
  visible,
  title,
  onClose,
  children,
}: {
  visible: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}): React.JSX.Element => {
  const theme = useTheme();
  const insets = useSafeAreaInsets();

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable
        onPress={onClose}
        accessibilityLabel="Dismiss"
        style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.4)' }}
      />
      <View
        style={{
          backgroundColor: theme.colors.background,
          borderTopLeftRadius: theme.radius.xl,
          borderTopRightRadius: theme.radius.xl,
          paddingBottom: insets.bottom + theme.spacing.lg,
          maxHeight: '70%',
        }}
      >
        <ScreenHeader title={title} onBack={onClose} />
        <ScrollView
          contentContainerStyle={{ padding: theme.spacing.lg, gap: theme.spacing.md }}
          keyboardShouldPersistTaps="handled"
        >
          {children}
        </ScrollView>
      </View>
    </Modal>
  );
};

/**
 * Scheduling, as discrete slots rather than a free date picker: every ridehail
 * scheduler works this way because a pickup window is what dispatch can
 * actually honour, and it keeps the app free of a native date-picker
 * dependency.
 */
const SchedulePicker = ({
  visible,
  value,
  onClose,
  onChange,
}: {
  visible: boolean;
  value?: number;
  onClose: () => void;
  onChange: (next: number | undefined) => void;
}): React.JSX.Element => {
  const [day, setDay] = useState(0);

  const days = useMemo(() => {
    const today = new Date();
    return Array.from({ length: 7 }, (_, offset) => {
      const date = new Date(today);
      date.setDate(today.getDate() + offset);
      return {
        offset,
        label:
          offset === 0
            ? 'Today'
            : offset === 1
              ? 'Tomorrow'
              // Built from parts rather than one locale pattern: some locales
              // put the day first, which reads as "1 Tue" on a chip.
              : `${date.toLocaleDateString(undefined, { weekday: 'short' })} ${date.getDate()}`,
        date,
      };
    });
  }, [visible]);

  /**
   * Slots start at least 30 minutes out — booking a "scheduled" ride for two
   * minutes from now is a normal ride with extra steps — and run to midnight.
   */
  const slots = useMemo(() => {
    const chosen = days[day]?.date ?? new Date();
    const start = new Date(chosen);
    start.setSeconds(0, 0);

    const earliest = new Date(Date.now() + 30 * 60_000);
    if (day === 0 && start < earliest) {
      start.setTime(earliest.getTime());
      // Round up to the next quarter hour.
      start.setMinutes(Math.ceil(start.getMinutes() / 15) * 15, 0, 0);
    } else if (day > 0) {
      start.setHours(0, 0, 0, 0);
    }

    const out: number[] = [];
    const end = new Date(chosen);
    end.setHours(23, 45, 0, 0);
    for (let t = start.getTime(); t <= end.getTime(); t += 15 * 60_000) out.push(t);
    return out;
  }, [day, days]);

  return (
    <BottomSheetModal visible={visible} title="When?" onClose={onClose}>
      <Row gap="sm" wrap>
        {days.map((option) => (
          <Chip
            key={option.offset}
            label={option.label}
            active={option.offset === day}
            onPress={() => setDay(option.offset)}
          />
        ))}
      </Row>

      <Divider />

      {slots.length === 0 ? (
        <Text variant="caption" color="muted">
          No times left today. Try tomorrow.
        </Text>
      ) : (
        <Row gap="sm" wrap>
          {slots.map((slot) => (
            <Chip
              key={slot}
              label={new Date(slot).toLocaleTimeString(undefined, {
                hour: 'numeric',
                minute: '2-digit',
              })}
              active={value === slot}
              onPress={() => onChange(slot)}
            />
          ))}
        </Row>
      )}

      {value !== undefined ? (
        <Button label="Ride now instead" variant="ghost" onPress={() => onChange(undefined)} />
      ) : null}
    </BottomSheetModal>
  );
};

/** Enter a code, or pick one the rider already has. */
const PromoSheet = ({
  visible,
  applied,
  onClose,
  onApply,
}: {
  visible: boolean;
  applied?: string;
  onClose: () => void;
  onApply: (code: string) => void;
}): React.JSX.Element => {
  const { client } = useApp();
  const [code, setCode] = useState('');
  const [checking, setChecking] = useState(false);
  const [problem, setProblem] = useState<string>();
  const [wallet, setWallet] = useState<
    readonly { promo: { code: string; label: string; description: string }; redemptionsLeft: number }[]
  >([]);

  useEffect(() => {
    if (!visible) return;
    setProblem(undefined);
    void client
      .promos()
      .then((r) => setWallet(r.promos))
      .catch(() => setWallet([]));
  }, [visible, client]);

  /**
   * Checked before it is applied, so the rider hears "you've already used
   * that" here rather than watching the price silently not change.
   */
  const apply = async (next: string): Promise<void> => {
    setChecking(true);
    setProblem(undefined);
    try {
      const { promo } = await client.checkPromo(next);
      onApply(promo.code);
    } catch (e) {
      setProblem(e instanceof ApiError ? e.userMessage : 'That code could not be applied.');
    } finally {
      setChecking(false);
    }
  };

  return (
    <BottomSheetModal visible={visible} title="Promo code" onClose={onClose}>
      <Field
        label="Enter a code"
        value={code}
        onChangeText={(next) => {
          setCode(next);
          setProblem(undefined);
        }}
        autoCapitalize="characters"
        placeholder="WELCOME50"
        {...(problem ? { error: problem } : {})}
      />
      <Button
        label="Apply"
        onPress={() => void apply(code)}
        disabled={code.trim().length === 0 || checking}
        loading={checking}
      />

      {wallet.length > 0 ? (
        <>
          <Divider />
          <Text variant="label" color="muted">
            AVAILABLE TO YOU
          </Text>
          {wallet.map((entry) => (
            <Card key={entry.promo.code} padded="md">
              <Row justify="space-between" align="center" gap="md">
                <Column gap="xxs" style={{ flex: 1 }}>
                  <Row gap="sm" align="center">
                    <Text variant="bodyStrong">{entry.promo.code}</Text>
                    {applied === entry.promo.code ? <Badge label="Applied" tone="success" /> : null}
                  </Row>
                  <Text variant="caption" color="muted">
                    {entry.promo.description}
                  </Text>
                </Column>
                <Button
                  label="Use"
                  variant="secondary"
                  size="sm"
                  onPress={() => void apply(entry.promo.code)}
                />
              </Row>
            </Card>
          ))}
        </>
      ) : null}
    </BottomSheetModal>
  );
};

/** A note the driver sees with the offer — a gate code, a door number. */
const NoteSheet = ({
  visible,
  value,
  onClose,
  onSave,
}: {
  visible: boolean;
  value: string;
  onClose: () => void;
  onSave: (next: string) => void;
}): React.JSX.Element => {
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    if (visible) setDraft(value);
  }, [visible, value]);

  return (
    <BottomSheetModal visible={visible} title="Note for your driver" onClose={onClose}>
      <Field
        label="What should they know?"
        value={draft}
        onChangeText={setDraft}
        multiline
        maxLength={300}
        placeholder="I'm by the side entrance on Market Street."
        hint="Your driver sees this when they get the ride."
      />
      <Button label="Save" onPress={() => onSave(draft)} />
      {value.trim() ? (
        <Button label="Remove note" variant="ghost" onPress={() => onSave('')} />
      ) : null}
    </BottomSheetModal>
  );
};

/** What a class of service actually includes — pulled from the ride catalog. */
const RideTypeInfo = ({
  visible,
  rideTypeId,
  onClose,
}: {
  visible: boolean;
  rideTypeId?: string;
  onClose: () => void;
}): React.JSX.Element => {
  const { config } = useApp();
  const rideType = config?.rideTypes.find((t) => t.id === rideTypeId);

  return (
    <BottomSheetModal visible={visible} title={rideType?.name ?? 'Ride type'} onClose={onClose}>
      {rideType ? (
        <Column gap="md">
          <Row gap="md" align="center">
            <Text style={{ fontSize: 36 }}>{rideType.icon}</Text>
            <Column gap="xxs" style={{ flex: 1 }}>
              <Text variant="heading">{rideType.name}</Text>
              <Text variant="caption" color="secondary">
                {rideType.tagline}
              </Text>
            </Column>
          </Row>
          <Divider />
          <Text variant="body" color="secondary">
            {rideType.description}
          </Text>
          <Row gap="sm" wrap>
            <Badge label={`Up to ${rideType.maxPassengers} riders`} />
            {rideType.shared ? <Badge label="Shared" tone="warning" /> : null}
            {rideType.badge ? <Badge label={rideType.badge} tone="primary" /> : null}
          </Row>
        </Column>
      ) : (
        <Text variant="caption" color="muted">
          That ride type is no longer offered.
        </Text>
      )}
    </BottomSheetModal>
  );
};

const PassengerStepper = ({
  value,
  onChange,
}: {
  value: number;
  onChange: (next: number) => void;
}): React.JSX.Element => {
  const step = (delta: number): void => onChange(Math.max(1, Math.min(6, value + delta)));

  return (
    <Row gap="sm">
      <Pressable
        onPress={() => step(-1)}
        disabled={value <= 1}
        accessibilityRole="button"
        accessibilityLabel="Fewer passengers"
        hitSlop={8}
      >
        <Text variant="bodyStrong" color={value <= 1 ? 'muted' : 'primary'}>
          −
        </Text>
      </Pressable>
      <Text variant="caption">
        {value} {value === 1 ? 'rider' : 'riders'}
      </Text>
      <Pressable
        onPress={() => step(1)}
        disabled={value >= 6}
        accessibilityRole="button"
        accessibilityLabel="More passengers"
        hitSlop={8}
      >
        <Text variant="bodyStrong" color={value >= 6 ? 'muted' : 'primary'}>
          +
        </Text>
      </Pressable>
    </Row>
  );
};
