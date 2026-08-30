/**
 * Add a payment method.
 *
 * The number is validated here — brand, length, Luhn, expiry, security code —
 * and only the brand and last four leave the device. In a deployment with a
 * real processor the number goes to that processor's own tokeniser from this
 * screen and the resulting token is sent alongside; the platform API is never
 * in the path of a full card number, which is what keeps it out of PCI scope.
 */

import React, { useMemo, useState } from 'react';
import { Alert, ScrollView, View } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  Button,
  Card,
  Column,
  Field,
  Row,
  ScreenHeader,
  Section,
  Text,
  ToggleRow,
  useTheme,
} from '@lift/ui';
import {
  cardErrorMessage,
  cvcLengthFor,
  detectCardBrand,
  digitsOnly,
  expandYear,
  formatCardNumber,
  validateCard,
  type CardFieldError,
} from '@lift/core';
import { ApiError } from '@lift/sdk';
import { useApp } from '../../src/state/AppProvider.js';
import { goBack } from '../../src/navigation.js';

const BRAND_ICONS: Record<string, string> = {
  visa: '💳',
  mastercard: '💳',
  amex: '💳',
  discover: '💳',
  diners: '💳',
  jcb: '💳',
  unionpay: '💳',
  unknown: '💳',
};

export default function AddPaymentMethod(): React.JSX.Element {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { client } = useApp();

  const [number, setNumber] = useState('');
  const [expiry, setExpiry] = useState('');
  const [cvc, setCvc] = useState('');
  const [postalCode, setPostalCode] = useState('');
  const [makeDefault, setMakeDefault] = useState(true);
  const [errors, setErrors] = useState<readonly CardFieldError[]>([]);
  const [saving, setSaving] = useState(false);

  const brand = useMemo(() => detectCardBrand(number), [number]);
  const cvcLength = useMemo(() => cvcLengthFor(number), [number]);

  /** MM/YY, formatted as it is typed so the slash never has to be entered. */
  const onExpiryChange = (next: string): void => {
    const digits = digitsOnly(next).slice(0, 4);
    // A leading 2–9 can only be a month if it is padded: "4" means April.
    const padded =
      digits.length === 1 && Number(digits) > 1 ? `0${digits}` : digits;
    setExpiry(padded.length > 2 ? `${padded.slice(0, 2)}/${padded.slice(2)}` : padded);
    setErrors([]);
  };

  const parsedExpiry = useMemo(() => {
    const digits = digitsOnly(expiry);
    if (digits.length < 4) return undefined;
    return {
      month: Number(digits.slice(0, 2)),
      year: expandYear(Number(digits.slice(2, 4)), new Date()),
    };
  }, [expiry]);

  const errorFor = (...kinds: CardFieldError[]): string | undefined => {
    const found = errors.find((e) => kinds.includes(e));
    return found ? cardErrorMessage(found) : undefined;
  };

  const save = async (): Promise<void> => {
    const result = validateCard(
      {
        number,
        expiryMonth: parsedExpiry?.month ?? 0,
        expiryYear: parsedExpiry?.year ?? 0,
        cvc,
        ...(postalCode ? { postalCode } : {}),
      },
      new Date(),
    );

    if (!result.ok) {
      setErrors(result.errors);
      return;
    }

    setErrors([]);
    setSaving(true);
    try {
      // Only the brand and last four go over the wire.
      await client.addPaymentMethod({
        kind: 'card',
        brand: result.card.brand,
        last4: result.card.last4,
        expiryMonth: result.card.expiryMonth,
        expiryYear: result.card.expiryYear,
        makeDefault,
      });
      // Opened from a deep link there is no history to go back to, and a
      // successful save that leaves the form on screen reads as a failure.
      goBack('/wallet');
    } catch (e) {
      Alert.alert(
        'Could not add that card',
        e instanceof ApiError ? e.userMessage : 'Try again in a moment.',
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background, paddingTop: insets.top }}>
      <ScreenHeader title="Add a card" onBack={() => goBack('/wallet')} />

      <ScrollView
        contentContainerStyle={{
          padding: theme.spacing.lg,
          paddingBottom: insets.bottom + theme.spacing.xxl,
          gap: theme.spacing.xl,
        }}
        keyboardShouldPersistTaps="handled"
      >
        <Card>
          <Column gap="md">
            <Field
              label="Card number"
              value={formatCardNumber(number)}
              onChangeText={(next) => {
                setNumber(next);
                setErrors([]);
              }}
              keyboardType="number-pad"
              placeholder="4242 4242 4242 4242"
              {...(errorFor('number_incomplete', 'number_invalid')
                ? { error: errorFor('number_incomplete', 'number_invalid')! }
                : {})}
              {...(brand !== 'unknown' ? { hint: `${BRAND_ICONS[brand]} ${brand}` } : {})}
            />

            <Row gap="md">
              <View style={{ flex: 1 }}>
                <Field
                  label="Expiry"
                  value={expiry}
                  onChangeText={onExpiryChange}
                  keyboardType="number-pad"
                  placeholder="MM/YY"
                  {...(errorFor('expiry_incomplete', 'expiry_past')
                    ? { error: errorFor('expiry_incomplete', 'expiry_past')! }
                    : {})}
                />
              </View>
              <View style={{ flex: 1 }}>
                <Field
                  label={cvcLength === 4 ? 'Security code (4)' : 'Security code'}
                  value={cvc}
                  onChangeText={(next) => {
                    setCvc(digitsOnly(next).slice(0, cvcLength));
                    setErrors([]);
                  }}
                  keyboardType="number-pad"
                  placeholder={cvcLength === 4 ? '1234' : '123'}
                  {...(errorFor('cvc_invalid') ? { error: errorFor('cvc_invalid')! } : {})}
                />
              </View>
            </Row>

            <Field
              label="Postal code"
              value={postalCode}
              onChangeText={setPostalCode}
              autoCapitalize="characters"
              placeholder="94111"
              hint="Used by your bank to verify the card."
            />
          </Column>
        </Card>

        <Section title="Options">
          <ToggleRow
            label="Use this as my default"
            description="New rides are charged to this card."
            value={makeDefault}
            onValueChange={setMakeDefault}
          />
        </Section>

        <Column gap="sm">
          <Button label="Add card" size="lg" onPress={() => void save()} loading={saving} />
          <Text variant="caption" color="muted" align="center">
            Your card number stays on your device. We store only the brand and last four digits.
          </Text>
        </Column>
      </ScrollView>
    </View>
  );
}
