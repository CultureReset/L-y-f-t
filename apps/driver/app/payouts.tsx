/**
 * Your money: the balance, cashing out, and where it goes.
 *
 * The balance is stated as two numbers because it genuinely is two — settled
 * money you can take now, and money from trips that have not cleared. Showing
 * one total and then refusing a cash out is how a driver stops trusting the
 * screen.
 */

import React, { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, Modal, RefreshControl, ScrollView, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  Badge,
  Button,
  Card,
  Column,
  Divider,
  EmptyState,
  Field,
  NavRow,
  Row,
  ScreenHeader,
  Section,
  Text,
  useTheme,
} from '@lift/ui';
import { formatMoney, type Money } from '@lift/core';
import { ApiError, type PayoutsResponse } from '@lift/sdk';
import type { CashOutQuote } from '@lift/core';
import { useDriver } from '../src/state/DriverProvider.js';

export default function Payouts(): React.JSX.Element {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { client } = useDriver();

  const [data, setData] = useState<PayoutsResponse>();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [sheet, setSheet] = useState<'none' | 'cashout' | 'destination'>('none');

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      setData(await client.driverPayouts());
    } catch {
      setData(undefined);
    } finally {
      setRefreshing(false);
      setLoading(false);
    }
  }, [client]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const balance = data?.balance;
  const canCashOut =
    balance !== undefined &&
    data !== undefined &&
    balance.available.amount >= data.policy.minimumInstantAmount.amount &&
    data.destinations.length > 0;

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

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background, paddingTop: insets.top }}>
      <ScreenHeader title="Payouts" onBack={() => router.back()} />

      <ScrollView
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void load()} />}
        contentContainerStyle={{
          padding: theme.spacing.lg,
          paddingBottom: insets.bottom + theme.spacing.xxl,
          gap: theme.spacing.xl,
        }}
      >
        {balance ? (
          <Card>
            <Column gap="md">
              <Column gap="xxs">
                <Text variant="label" color="muted">
                  AVAILABLE NOW
                </Text>
                <Text variant="display">{formatMoney(balance.available)}</Text>
              </Column>

              <Divider />

              <Row justify="space-between">
                <Text variant="caption" color="secondary">
                  Still settling
                </Text>
                <Text variant="captionStrong">{formatMoney(balance.pending)}</Text>
              </Row>
              <Row justify="space-between">
                <Text variant="caption" color="secondary">
                  Next scheduled payout
                </Text>
                <Text variant="captionStrong">
                  {new Date(balance.nextScheduledAt).toLocaleDateString(undefined, {
                    weekday: 'short',
                    month: 'short',
                    day: 'numeric',
                  })}
                </Text>
              </Row>

              <Button
                label="Cash out now"
                onPress={() => setSheet('cashout')}
                disabled={!canCashOut}
              />
              {/* Say why the button is off, rather than leaving it inert. */}
              {!canCashOut ? (
                <Text variant="caption" color="muted" align="center">
                  {data && data.destinations.length === 0
                    ? 'Add a bank account to cash out.'
                    : `Cash outs start at ${formatMoney(data!.policy.minimumInstantAmount)}.`}
                </Text>
              ) : null}
            </Column>
          </Card>
        ) : null}

        <Section
          title="Where it goes"
          footer={
            data
              ? `Instant cash outs cost ${formatMoney(data.policy.instantFee)}, taken out of the amount. Scheduled payouts are free.`
              : undefined
          }
        >
          {(data?.destinations ?? []).map((destination) => (
            <NavRow
              key={destination.id}
              icon="🏦"
              label={destination.label}
              {...(destination.isDefault ? { value: 'Default' } : {})}
              onPress={() =>
                Alert.alert(destination.label, 'Remove this account?', [
                  { text: 'Keep', style: 'cancel' },
                  {
                    text: 'Remove',
                    style: 'destructive',
                    onPress: () => {
                      void client
                        .removePayoutDestination(destination.id)
                        .then(() => void load())
                        .catch(() => Alert.alert('Could not remove that account'));
                    },
                  },
                ])
              }
            />
          ))}
          <NavRow
            icon="＋"
            label="Add a bank account"
            onPress={() => setSheet('destination')}
          />
        </Section>

        <Section title="History">
          {(data?.payouts.length ?? 0) === 0 ? (
            <EmptyState
              icon="🧾"
              title="No payouts yet"
              message="Your first payout lands on the next scheduled date."
            />
          ) : (
            <Column gap="md" style={{ paddingVertical: theme.spacing.sm }}>
              {data!.payouts.map((payout) => (
                <Row key={payout.id} justify="space-between" align="flex-start" gap="md">
                  <Column gap="xxs" style={{ flex: 1 }}>
                    <Text variant="caption">
                      {payout.kind === 'instant' ? 'Instant cash out' : 'Scheduled payout'}
                    </Text>
                    <Text variant="label" color="muted">
                      {new Date(payout.requestedAt).toLocaleDateString()}
                      {payout.destinationLabel ? ` · ${payout.destinationLabel}` : ''}
                      {payout.fee.amount > 0 ? ` · ${formatMoney(payout.fee)} fee` : ''}
                    </Text>
                  </Column>
                  <Column gap="xxs" style={{ alignItems: 'flex-end' }}>
                    <Text variant="bodyStrong">{formatMoney(payout.amount)}</Text>
                    <Badge
                      label={payout.status}
                      tone={
                        payout.status === 'paid'
                          ? 'success'
                          : payout.status === 'failed'
                            ? 'danger'
                            : 'neutral'
                      }
                    />
                  </Column>
                </Row>
              ))}
            </Column>
          )}
        </Section>
      </ScrollView>

      {balance && data ? (
        <CashOutSheet
          visible={sheet === 'cashout'}
          available={balance.available}
          minimum={data.policy.minimumInstantAmount}
          onClose={() => setSheet('none')}
          onDone={() => {
            setSheet('none');
            void load();
          }}
        />
      ) : null}

      <DestinationSheet
        visible={sheet === 'destination'}
        onClose={() => setSheet('none')}
        onDone={() => {
          setSheet('none');
          void load();
        }}
      />
    </View>
  );
}

// ------------------------------------------------------------------ sheets

const SheetShell = ({
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
      <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)' }} />
      <View
        style={{
          backgroundColor: theme.colors.background,
          borderTopLeftRadius: theme.radius.xl,
          borderTopRightRadius: theme.radius.xl,
          paddingBottom: insets.bottom + theme.spacing.lg,
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

const CashOutSheet = ({
  visible,
  available,
  minimum,
  onClose,
  onDone,
}: {
  visible: boolean;
  available: Money;
  minimum: Money;
  onClose: () => void;
  onDone: () => void;
}): React.JSX.Element => {
  const { client } = useDriver();
  const [amount, setAmount] = useState('');
  const [quote, setQuote] = useState<CashOutQuote>();
  const [problem, setProblem] = useState<string>();
  const [busy, setBusy] = useState(false);

  const minorUnits = useMemo(() => {
    const parsed = Number.parseFloat(amount.replace(/[^0-9.]/g, ''));
    return Number.isFinite(parsed) ? Math.round(parsed * 100) : 0;
  }, [amount]);

  /**
   * The fee is quoted by the server before anything is taken, so what the
   * driver confirms is what actually happens.
   */
  const check = async (): Promise<void> => {
    setBusy(true);
    setProblem(undefined);
    try {
      setQuote((await client.quoteCashOut(minorUnits)).quote);
    } catch (e) {
      setQuote(undefined);
      setProblem(e instanceof ApiError ? e.userMessage : 'Could not price that cash out.');
    } finally {
      setBusy(false);
    }
  };

  const confirm = async (): Promise<void> => {
    setBusy(true);
    try {
      await client.cashOut(minorUnits);
      onDone();
    } catch (e) {
      setProblem(e instanceof ApiError ? e.userMessage : 'That cash out did not go through.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <SheetShell visible={visible} title="Cash out" onClose={onClose}>
      <Text variant="caption" color="muted">
        {formatMoney(available)} available · {formatMoney(minimum)} minimum
      </Text>

      <Field
        label="Amount"
        value={amount}
        onChangeText={(next) => {
          setAmount(next);
          setQuote(undefined);
          setProblem(undefined);
        }}
        keyboardType="decimal-pad"
        placeholder={(available.amount / 100).toFixed(2)}
        {...(problem ? { error: problem } : {})}
      />

      <Button
        label="Take everything"
        variant="ghost"
        size="sm"
        onPress={() => {
          setAmount((available.amount / 100).toFixed(2));
          setQuote(undefined);
        }}
      />

      {quote ? (
        <Card padded="md">
          <Column gap="sm">
            <Row justify="space-between">
              <Text variant="caption" color="secondary">
                Cash out
              </Text>
              <Text variant="captionStrong">{formatMoney(quote.gross)}</Text>
            </Row>
            <Row justify="space-between">
              <Text variant="caption" color="secondary">
                Fee
              </Text>
              <Text variant="captionStrong">−{formatMoney(quote.fee)}</Text>
            </Row>
            <Divider />
            <Row justify="space-between">
              <Text variant="bodyStrong">You get</Text>
              <Text variant="bodyStrong">{formatMoney(quote.net)}</Text>
            </Row>
          </Column>
        </Card>
      ) : null}

      {quote ? (
        <Button label={`Cash out ${formatMoney(quote.net)}`} onPress={() => void confirm()} loading={busy} />
      ) : (
        <Button
          label="Check the fee"
          onPress={() => void check()}
          disabled={minorUnits <= 0 || busy}
          loading={busy}
        />
      )}
    </SheetShell>
  );
};

const DestinationSheet = ({
  visible,
  onClose,
  onDone,
}: {
  visible: boolean;
  onClose: () => void;
  onDone: () => void;
}): React.JSX.Element => {
  const { client } = useDriver();
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);

  const save = async (): Promise<void> => {
    setBusy(true);
    try {
      await client.addPayoutDestination({ label: label.trim(), makeDefault: true });
      setLabel('');
      onDone();
    } catch (e) {
      Alert.alert('Could not add', e instanceof ApiError ? e.userMessage : 'Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <SheetShell visible={visible} title="Add a bank account" onClose={onClose}>
      {/*
        Account details are collected by the payment processor's own flow in a
        real deployment; the platform stores a token and a label it can show
        back. What is entered here is only the label.
      */}
      <Field
        label="What should we call it?"
        value={label}
        onChangeText={setLabel}
        placeholder="Chase ••••4321"
        hint="Your bank details are entered with our payment provider, never stored here."
      />
      <Button
        label="Add account"
        onPress={() => void save()}
        disabled={label.trim().length === 0 || busy}
        loading={busy}
      />
    </SheetShell>
  );
};
