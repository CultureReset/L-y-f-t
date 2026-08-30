/**
 * Wallet: payment methods and charge history.
 *
 * Cards are added through the gateway's tokenizer in a real deployment; the
 * memory gateway accepts a brand and last four so the flow is complete without
 * a processor account.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Badge, Button, Card, Column, Divider, Row, Text, useTheme } from '@lift/ui';
import { formatMoney, type Charge } from '@lift/core';
import { ApiError, type PaymentMethodView } from '@lift/sdk';
import { useApp } from '../src/state/AppProvider.js';

export default function Wallet(): React.JSX.Element {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { client } = useApp();

  const [methods, setMethods] = useState<PaymentMethodView[]>([]);
  const [charges, setCharges] = useState<Charge[]>([]);

  const load = useCallback(async () => {
    try {
      const [wallet, history] = await Promise.all([
        client.paymentMethods(),
        client.charges(20).catch(() => ({ charges: [] as Charge[] })),
      ]);
      setMethods([...wallet.methods]);
      setCharges([...history.charges]);
    } catch {
      setMethods([]);
    }
  }, [client]);

  // Reloads whenever the screen regains focus, so a card added on the form
  // shows up on return without a manual refresh.
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const makeDefault = async (id: string): Promise<void> => {
    const { methods: updated } = await client.setDefaultPaymentMethod(id);
    setMethods([...updated]);
  };

  const remove = async (id: string): Promise<void> => {
    const { methods: updated } = await client.removePaymentMethod(id);
    setMethods([...updated]);
  };

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background, paddingTop: insets.top }}>
      <Row gap="md" style={{ padding: theme.spacing.lg }}>
        <Pressable onPress={() => router.back()} accessibilityRole="button" accessibilityLabel="Back" hitSlop={12}>
          <Text variant="title">←</Text>
        </Pressable>
        <Text variant="title">Wallet</Text>
      </Row>

      <ScrollView
        contentContainerStyle={{
          padding: theme.spacing.lg,
          paddingBottom: insets.bottom + theme.spacing.xxl,
          gap: theme.spacing.lg,
        }}
      >
        <Column gap="sm">
          <Text variant="heading">Payment methods</Text>
          {methods.map((method) => (
            <Card key={method.id} padded="md">
              <Row justify="space-between">
                <Column gap="xxs" style={{ flex: 1 }}>
                  <Row gap="sm">
                    <Text variant="bodyStrong">{method.displayLabel}</Text>
                    {method.isDefault ? <Badge label="Default" tone="primary" /> : null}
                  </Row>
                  {method.expiryMonth ? (
                    <Text variant="caption" color="muted">
                      Expires {String(method.expiryMonth).padStart(2, '0')}/{method.expiryYear}
                    </Text>
                  ) : null}
                </Column>
                <Row gap="md">
                  {method.isDefault ? null : (
                    <Pressable onPress={() => void makeDefault(method.id)} accessibilityRole="button">
                      <Text variant="caption" color="primary">
                        Use
                      </Text>
                    </Pressable>
                  )}
                  <Pressable onPress={() => void remove(method.id)} accessibilityRole="button">
                    <Text variant="caption" color="danger">
                      Remove
                    </Text>
                  </Pressable>
                </Row>
              </Row>
            </Card>
          ))}
          {methods.length === 0 ? (
            <Text variant="caption" color="muted">
              Add a card to start riding.
            </Text>
          ) : null}
          <Button
            label="Add a card"
            variant="secondary"
            onPress={() => router.push('/payment/add')}
          />
        </Column>

        <Divider />

        <Column gap="sm">
          <Text variant="heading">Recent charges</Text>
          {charges.map((charge) => (
            <Row key={charge.id} justify="space-between">
              <Column gap="xxs">
                <Text variant="caption">{describeCharge(charge.kind)}</Text>
                <Text variant="label" color="muted">
                  {new Date(charge.createdAt).toLocaleDateString()} · {charge.status}
                </Text>
              </Column>
              <Text variant="captionStrong">{formatMoney(charge.amount)}</Text>
            </Row>
          ))}
          {charges.length === 0 ? (
            <Text variant="caption" color="muted">
              Nothing charged yet.
            </Text>
          ) : null}
        </Column>
      </ScrollView>
    </View>
  );
}

const describeCharge = (kind: string): string =>
  ({
    ride_fare: 'Ride fare',
    tip: 'Tip',
    cancellation_fee: 'Cancellation fee',
    adjustment: 'Adjustment',
  })[kind] ?? kind;
