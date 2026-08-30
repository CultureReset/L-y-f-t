/**
 * The receipt.
 *
 * Shows the fare as what it actually is: an ordered list of line items that
 * sums to the total. A single number invites a dispute; the breakdown answers
 * it. The sum is checked here too, because a receipt whose lines do not add up
 * is worse than no receipt.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Share, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  Badge,
  Button,
  Card,
  Column,
  Divider,
  ItineraryLines,
  Row,
  ScreenHeader,
  Section,
  Text,
  useTheme,
} from '@lift/ui';
import { formatDuration, formatMoney } from '@lift/core';
import type { ReceiptResponse } from '@lift/sdk';
import { useApp } from '../../src/state/AppProvider.js';
import { goBack } from '../../src/navigation.js';

type Receipt = NonNullable<ReceiptResponse['receipt']>;

export default function ReceiptScreen(): React.JSX.Element {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { client, config } = useApp();
  const { id } = useLocalSearchParams<{ id: string }>();

  const [receipt, setReceipt] = useState<Receipt>();
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const response = await client.receipt(id);
      setReceipt(response.receipt ?? undefined);
    } catch {
      setReceipt(undefined);
    } finally {
      setLoading(false);
    }
  }, [client, id]);

  useEffect(() => {
    void load();
  }, [load]);

  const share = async (): Promise<void> => {
    if (!receipt) return;
    const lines = [
      `${config?.brandName ?? 'Ride'} receipt`,
      receipt.completedAt ? new Date(receipt.completedAt).toLocaleString() : '',
      '',
      `From: ${receipt.pickup.name}`,
      `To: ${receipt.dropoff.name}`,
      '',
      ...receipt.fare.items.map(
        (item) => `${item.label}${item.detail ? ` (${item.detail})` : ''}  ${formatMoney(item.amount)}`,
      ),
      '',
      `Total  ${formatMoney(receipt.fare.total)}`,
    ].filter(Boolean);

    try {
      await Share.share({ message: lines.join('\n'), title: 'Ride receipt' });
    } catch {
      // Dismissing the share sheet is not an error.
    }
  };

  if (loading) {
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: theme.colors.background,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <ActivityIndicator color={theme.colors.primary} />
      </View>
    );
  }

  if (!receipt) {
    return (
      <View style={{ flex: 1, backgroundColor: theme.colors.background, paddingTop: insets.top }}>
        <ScreenHeader title="Receipt" onBack={() => goBack('/activity')} />
        <Column gap="lg" style={{ padding: theme.spacing.xl, alignItems: 'center' }}>
          <Text variant="heading" align="center">
            No receipt for that trip
          </Text>
          <Text variant="caption" color="muted" align="center">
            A receipt is issued once a ride finishes.
          </Text>
        </Column>
      </View>
    );
  }

  // The lines must add up to the total. If they ever do not, say so rather
  // than quietly showing a number nobody can reconcile.
  const summed = receipt.fare.items.reduce((total, item) => total + item.amount.amount, 0);
  const reconciles = summed === receipt.fare.total.amount;

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background, paddingTop: insets.top }}>
      <ScreenHeader
        title="Receipt"
        {...(receipt.completedAt
          ? { subtitle: new Date(receipt.completedAt).toLocaleString() }
          : {})}
        onBack={() => goBack('/activity')}
      />

      <Column
        gap="xl"
        style={{
          padding: theme.spacing.lg,
          paddingBottom: insets.bottom + theme.spacing.xxl,
          flex: 1,
        }}
      >
        <Card>
          <Column gap="md">
            <Row justify="space-between" align="center">
              <Text variant="label" color="muted">
                TOTAL
              </Text>
              <Text variant="display">{formatMoney(receipt.fare.total)}</Text>
            </Row>
            <Divider />
            <ItineraryLines pickup={receipt.pickup.name} dropoff={receipt.dropoff.name} />
            <Row gap="sm" wrap>
              <Badge label={`${(receipt.fare.distanceMeters / 1609.344).toFixed(1)} mi`} />
              {receipt.durations.tripMs !== undefined ? (
                <Badge label={formatDuration(receipt.durations.tripMs)} />
              ) : null}
              {receipt.fare.surgeMultiplier > 1 ? (
                <Badge label={`${receipt.fare.surgeMultiplier.toFixed(1)}× surge`} tone="warning" />
              ) : null}
            </Row>
          </Column>
        </Card>

        <Section title="How this was worked out">
          <Column gap="sm" style={{ paddingVertical: theme.spacing.sm }}>
            {receipt.fare.items.map((item) => (
              <Row key={item.code} justify="space-between" gap="lg">
                <Column gap="xxs" style={{ flex: 1 }}>
                  <Text variant="caption">{item.label}</Text>
                  {item.detail ? (
                    <Text variant="caption" color="muted">
                      {item.detail}
                    </Text>
                  ) : null}
                </Column>
                <Text
                  variant="captionStrong"
                  color={item.amount.amount < 0 ? 'success' : 'default'}
                >
                  {formatMoney(item.amount)}
                </Text>
              </Row>
            ))}
            <Divider />
            <Row justify="space-between">
              <Text variant="bodyStrong">Total</Text>
              <Text variant="bodyStrong">{formatMoney(receipt.fare.total)}</Text>
            </Row>
            {!reconciles ? (
              <Text variant="caption" color="danger">
                These lines do not add up to the total. Please report this trip.
              </Text>
            ) : null}
          </Column>
        </Section>

        {receipt.charges.length > 0 ? (
          <Section title="Payments">
            <Column gap="sm" style={{ paddingVertical: theme.spacing.sm }}>
              {receipt.charges.map((charge) => (
                <Row key={charge.id} justify="space-between">
                  <Text variant="caption" color="secondary">
                    {charge.kind.replace(/_/g, ' ')} · {charge.status}
                  </Text>
                  <Text variant="captionStrong">{formatMoney(charge.amount)}</Text>
                </Row>
              ))}
            </Column>
          </Section>
        ) : null}

        <Column gap="sm">
          <Button label="Share receipt" variant="secondary" onPress={() => void share()} />
          <Button
            label="Something looks wrong"
            variant="ghost"
            onPress={() =>
              router.push({
                pathname: '/support',
                params: { rideId: receipt.rideId, category: 'fare_dispute' },
              })
            }
          />
        </Column>
      </Column>
    </View>
  );
}
