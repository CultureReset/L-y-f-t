/**
 * Domain components — the pieces both apps assemble their screens from.
 *
 * These know about rides, fares, and drivers, which keeps that knowledge out of
 * the screens themselves and means the rider app and driver app render the same
 * concepts identically.
 */

import React from 'react';
import { Pressable, View } from 'react-native';
import {
  formatCountdown,
  formatDuration,
  formatMoney,
  metersToMiles,
  statusLabel,
  type FareBreakdown,
  type Money,
  type RideStatus,
} from '@lift/core';
import type { RideQuote } from '@lift/sdk';
import { useTheme } from '../theme/ThemeProvider.js';
import { Text } from './Text.js';
import { Badge, Avatar, Rating } from './Avatar.js';
import { Card, Column, Divider, Row } from './Surface.js';

/** A row in the rider's ride-type picker. */
export interface RideTypeOptionProps {
  readonly quote: RideQuote;
  readonly selected: boolean;
  readonly onSelect: () => void;
}

export const RideTypeOption = ({
  quote,
  selected,
  onSelect,
}: RideTypeOptionProps): React.JSX.Element => {
  const theme = useTheme();
  const disabled = !quote.available;

  return (
    <Pressable
      onPress={disabled ? undefined : onSelect}
      accessibilityRole="radio"
      accessibilityState={{ selected, disabled }}
      accessibilityLabel={`${quote.name}, ${formatMoney(quote.fare.total)}, ${formatDuration(
        quote.pickupEtaMs,
      )} away`}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: theme.spacing.md,
        paddingHorizontal: theme.spacing.md,
        borderRadius: theme.radius.lg,
        borderWidth: 2,
        borderColor: selected ? theme.colors.primary : 'transparent',
        backgroundColor: selected ? theme.colors.primaryMuted : 'transparent',
        opacity: disabled ? 0.45 : 1,
        gap: theme.spacing.md,
      }}
    >
      <RideTypeGlyph icon={quote.icon} size={40} />

      <View style={{ flex: 1 }}>
        <Row gap="sm">
          <Text variant="bodyStrong">{quote.name}</Text>
          {quote.badge ? <Badge label={quote.badge} tone="primary" /> : null}
          {quote.surgeMultiplier > 1 ? (
            <Badge label={`${quote.surgeMultiplier.toFixed(1)}×`} tone="warning" />
          ) : null}
        </Row>
        <Text variant="caption" color="secondary" numberOfLines={1}>
          {disabled ? quote.unavailableReason : quote.tagline}
        </Text>
      </View>

      <Column gap="xxs" style={{ alignItems: 'flex-end' }}>
        <Text variant="bodyStrong">{formatMoney(quote.fare.total)}</Text>
        <Text variant="caption" color="muted">
          {formatDuration(quote.pickupEtaMs)} away
        </Text>
      </Column>
    </Pressable>
  );
};

/**
 * A simple glyph per ride type. Deliberately drawn from tokens rather than
 * shipped as image assets, so a new tier needs no artwork to look right.
 */
export const RideTypeGlyph = ({
  icon,
  size = 40,
}: {
  icon: string;
  size?: number;
}): React.JSX.Element => {
  const theme = useTheme();
  const glyphs: Record<string, string> = {
    car: '🚗',
    users: '🚙',
    van: '🚐',
    sparkle: '🚘',
    accessible: '♿',
  };
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: theme.radius.md,
        backgroundColor: theme.colors.surfaceSunken,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Text style={{ fontSize: size * 0.5 }}>{glyphs[icon] ?? '🚗'}</Text>
    </View>
  );
};

/** The receipt: every line item, then the total. */
export const FareSummary = ({
  fare,
  title = 'Fare',
}: {
  fare: FareBreakdown;
  title?: string;
}): React.JSX.Element => {
  const theme = useTheme();
  const visible = fare.items.filter((item) => !item.internal);

  return (
    <Column gap="sm">
      <Text variant="heading">{title}</Text>
      {visible.map((item) => (
        <Row key={`${item.ruleId}:${item.code}`} justify="space-between" align="flex-start">
          <View style={{ flex: 1, paddingRight: theme.spacing.md }}>
            <Text variant="caption">{item.label}</Text>
            {item.detail ? (
              <Text variant="caption" color="muted">
                {item.detail}
              </Text>
            ) : null}
          </View>
          <Text
            variant="caption"
            color={item.amount.amount < 0 ? 'success' : 'default'}
            style={{ fontVariant: ['tabular-nums'] }}
          >
            {formatMoney(item.amount)}
          </Text>
        </Row>
      ))}
      <Divider />
      <Row justify="space-between">
        <Text variant="bodyStrong">Total</Text>
        <Text variant="bodyStrong" style={{ fontVariant: ['tabular-nums'] }}>
          {formatMoney(fare.total)}
        </Text>
      </Row>
      {fare.estimated && fare.estimateRange ? (
        <Text variant="caption" color="muted">
          Estimated {formatMoney(fare.estimateRange.low)}–
          {formatMoney(fare.estimateRange.high)}. The final fare depends on the route taken.
        </Text>
      ) : null}
    </Column>
  );
};

/** The driver + vehicle card a rider sees once matched. */
export interface DriverCardProps {
  readonly name: string;
  readonly avatarUrl?: string;
  readonly rating: number;
  readonly totalRides?: number;
  readonly vehicle?: {
    readonly make: string;
    readonly model: string;
    readonly color: string;
    readonly licensePlate: string;
  };
  readonly right?: React.ReactNode;
}

export const DriverCard = ({
  name,
  avatarUrl,
  rating,
  totalRides,
  vehicle,
  right,
}: DriverCardProps): React.JSX.Element => (
  <Row gap="md">
    <Avatar name={name} url={avatarUrl} size={52} />
    <View style={{ flex: 1 }}>
      <Text variant="bodyStrong">{name}</Text>
      <Rating value={rating} count={totalRides} />
      {vehicle ? (
        <Text variant="caption" color="secondary">
          {titleCase(vehicle.color)} {vehicle.make} {vehicle.model} ·{' '}
          <Text variant="captionStrong">{vehicle.licensePlate}</Text>
        </Text>
      ) : null}
    </View>
    {right}
  </Row>
);

/** The current state of a ride, as a pill. */
export const RideStatusPill = ({ status }: { status: RideStatus }): React.JSX.Element => {
  const tone: Record<string, 'neutral' | 'primary' | 'success' | 'warning' | 'danger'> = {
    requested: 'primary',
    accepted: 'primary',
    arrived: 'success',
    in_progress: 'primary',
    completed: 'success',
    cancelled: 'danger',
    expired: 'warning',
    scheduled: 'neutral',
    draft: 'neutral',
  };
  return <Badge label={statusLabel(status)} tone={tone[status] ?? 'neutral'} />;
};

/**
 * The driver's offer card: payout, pickup distance, the trip, and a countdown.
 * Everything a driver decides on in the few seconds they have.
 */
export interface OfferCardProps {
  readonly payout: Money;
  readonly pickupEtaMs: number;
  readonly pickupDistanceMeters: number;
  readonly pickupAddress: string;
  readonly dropoffAddress: string;
  readonly tripDistanceMeters: number;
  readonly tripDurationMs: number;
  readonly riderName: string;
  readonly riderRating: number;
  readonly surgeMultiplier: number;
  readonly remainingMs: number;
  readonly progress: number;
}

export const OfferCard = ({
  payout,
  pickupEtaMs,
  pickupDistanceMeters,
  pickupAddress,
  dropoffAddress,
  tripDistanceMeters,
  tripDurationMs,
  riderName,
  riderRating,
  surgeMultiplier,
  remainingMs,
  progress,
}: OfferCardProps): React.JSX.Element => {
  const theme = useTheme();

  return (
    <Column gap="lg">
      {/* The countdown drains left to right; it is the most urgent element. */}
      <View
        style={{
          height: 6,
          borderRadius: 3,
          backgroundColor: theme.colors.surfaceSunken,
          overflow: 'hidden',
        }}
      >
        <View
          style={{
            height: '100%',
            width: `${Math.max(0, (1 - progress) * 100)}%`,
            backgroundColor: remainingMs < 5_000 ? theme.colors.danger : theme.colors.primary,
          }}
        />
      </View>

      <Row justify="space-between" align="flex-start">
        <Column gap="xxs">
          <Text variant="display">{formatMoney(payout)}</Text>
          <Row gap="sm">
            <Text variant="caption" color="secondary">
              {formatDuration(tripDurationMs)} · {metersToMiles(tripDistanceMeters).toFixed(1)} mi trip
            </Text>
            {surgeMultiplier > 1 ? (
              <Badge label={`${surgeMultiplier.toFixed(1)}× busy`} tone="warning" />
            ) : null}
          </Row>
        </Column>
        <Column gap="xxs" style={{ alignItems: 'flex-end' }}>
          <Text variant="mono" color={remainingMs < 5_000 ? 'danger' : 'default'}>
            {formatCountdown(remainingMs)}
          </Text>
          <Rating value={riderRating} />
        </Column>
      </Row>

      <Column gap="sm">
        <Row gap="md" align="flex-start">
          <LegDot color={theme.colors.pickupPin} />
          <Column gap="xxs" style={{ flex: 1 }}>
            <Text variant="captionStrong">
              {formatDuration(pickupEtaMs)} · {metersToMiles(pickupDistanceMeters).toFixed(1)} mi away
            </Text>
            <Text variant="caption" color="secondary" numberOfLines={1}>
              {pickupAddress}
            </Text>
          </Column>
        </Row>
        <Row gap="md" align="flex-start">
          <LegDot color={theme.colors.dropoffPin} square />
          <Column gap="xxs" style={{ flex: 1 }}>
            <Text variant="captionStrong">Dropping off</Text>
            <Text variant="caption" color="secondary" numberOfLines={1}>
              {dropoffAddress}
            </Text>
          </Column>
        </Row>
      </Column>

      <Text variant="caption" color="muted">
        {riderName}
      </Text>
    </Column>
  );
};

const LegDot = ({
  color,
  square = false,
}: {
  color: string;
  square?: boolean;
}): React.JSX.Element => (
  <View
    style={{
      width: 12,
      height: 12,
      marginTop: 4,
      borderRadius: square ? 3 : 6,
      backgroundColor: color,
    }}
  />
);

/** The pickup → dropoff pair, as shown on ride cards and history rows. */
export const ItineraryLines = ({
  pickup,
  dropoff,
  stops = [],
}: {
  pickup: string;
  dropoff: string;
  stops?: readonly string[];
}): React.JSX.Element => {
  const theme = useTheme();
  return (
    <Column gap="sm">
      <Row gap="md" align="center">
        <LegDot color={theme.colors.pickupPin} />
        <Text variant="caption" numberOfLines={1} style={{ flex: 1 }}>
          {pickup}
        </Text>
      </Row>
      {stops.map((stop, index) => (
        <Row key={`${stop}-${index}`} gap="md" align="center">
          <LegDot color={theme.colors.textMuted} />
          <Text variant="caption" color="secondary" numberOfLines={1} style={{ flex: 1 }}>
            {stop}
          </Text>
        </Row>
      ))}
      <Row gap="md" align="center">
        <LegDot color={theme.colors.dropoffPin} square />
        <Text variant="caption" numberOfLines={1} style={{ flex: 1 }}>
          {dropoff}
        </Text>
      </Row>
    </Column>
  );
};

/** A stat tile, used across the driver's earnings screen. */
export const StatTile = ({
  label,
  value,
  caption,
}: {
  label: string;
  value: string;
  caption?: string;
}): React.JSX.Element => (
  <Card padded="md" style={{ flex: 1, minWidth: 120 }}>
    <Text variant="label" color="muted">
      {label.toUpperCase()}
    </Text>
    <Text variant="title" style={{ fontVariant: ['tabular-nums'] }}>
      {value}
    </Text>
    {caption ? (
      <Text variant="caption" color="muted">
        {caption}
      </Text>
    ) : null}
  </Card>
);

const titleCase = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
