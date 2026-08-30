/**
 * Driver sign-in. Same phone-and-code flow as the rider app, requesting the
 * driver role so the API creates or attaches a driver profile.
 */

import React, { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Button, Column, Row, Text, useTheme } from '@lift/ui';
import { ApiError } from '@lift/sdk';
import { useDriver } from '../src/state/DriverProvider.js';

export default function SignIn(): React.JSX.Element {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { client, signIn, refresh, apiUrl } = useDriver();

  const [step, setStep] = useState<'phone' | 'code' | 'name'>('phone');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [devCode, setDevCode] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const requestCode = async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      const result = await client.requestCode(phone);
      if (result.devCode) {
        setDevCode(result.devCode);
        setCode(result.devCode);
      }
      setStep('code');
    } catch (e) {
      setError(e instanceof ApiError ? e.userMessage : `Could not reach ${apiUrl}`);
    } finally {
      setBusy(false);
    }
  };

  /**
   * Verifying consumes the one-time code and, for an unknown number, creates
   * the account there and then. So the session it returns is the only one that
   * code will ever produce — asking for a name must not throw it away and
   * verify again, which is how the second call used to fail with "that code
   * expired". The token is held, then the name is saved through the profile
   * endpoint the account already has access to.
   */
  const verify = async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      const session = await client.verifyCode({ phone, code, role: 'driver' });
      await signIn(session.token);

      if (session.isNewUser) {
        setStep('name');
        return;
      }
      router.replace('/');
    } catch (e) {
      setError(e instanceof ApiError ? e.userMessage : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  };

  const saveName = async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      await client.updateProfile({
        firstName: firstName.trim(),
        lastName: lastName.trim(),
      });
      await refresh();
      router.replace('/');
    } catch (e) {
      setError(e instanceof ApiError ? e.userMessage : 'Could not save your name');
    } finally {
      setBusy(false);
    }
  };

  const inputStyle = {
    backgroundColor: theme.colors.surfaceSunken,
    borderRadius: theme.radius.md,
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.lg,
    fontSize: 18,
    color: theme.colors.text,
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={{ flex: 1, backgroundColor: theme.colors.background }}
    >
      <ScrollView
        contentContainerStyle={{
          flexGrow: 1,
          justifyContent: 'center',
          padding: theme.spacing.xl,
          paddingBottom: insets.bottom + theme.spacing.xl,
        }}
        keyboardShouldPersistTaps="handled"
      >
        <Column gap="xl">
          <Column gap="xs">
            <Text variant="display" color="primary">
              Drive
            </Text>
            <Text variant="body" color="secondary">
              {step === 'phone'
                ? 'Sign in to start earning.'
                : step === 'code'
                  ? `We sent a code to ${phone}.`
                  : 'What should riders call you?'}
            </Text>
          </Column>

          {step === 'phone' ? (
            <Column gap="md">
              <TextInput
                style={inputStyle}
                placeholder="(415) 555-0199"
                placeholderTextColor={theme.colors.textMuted}
                keyboardType="phone-pad"
                value={phone}
                onChangeText={setPhone}
                onSubmitEditing={() => void requestCode()}
                accessibilityLabel="Phone number"
              />
              <Button
                label="Continue"
                onPress={() => void requestCode()}
                loading={busy}
                disabled={phone.replace(/\D/g, '').length < 10}
              />
            </Column>
          ) : null}

          {step === 'code' ? (
            <Column gap="md">
              <TextInput
                style={[inputStyle, { letterSpacing: 8, textAlign: 'center' }]}
                placeholder="000000"
                placeholderTextColor={theme.colors.textMuted}
                keyboardType="number-pad"
                maxLength={6}
                value={code}
                onChangeText={setCode}
                onSubmitEditing={() => void verify()}
                accessibilityLabel="Verification code"
              />
              {devCode ? (
                <Text variant="caption" color="muted" align="center">
                  Development mode — the code is {devCode}.
                </Text>
              ) : null}
              <Button label="Verify" onPress={() => void verify()} loading={busy} disabled={code.length < 4} />
              <Button label="Use a different number" variant="ghost" onPress={() => setStep('phone')} />
            </Column>
          ) : null}

          {step === 'name' ? (
            <Column gap="md">
              <Row gap="sm">
                <TextInput
                  style={[inputStyle, { flex: 1 }]}
                  placeholder="First name"
                  placeholderTextColor={theme.colors.textMuted}
                  value={firstName}
                  onChangeText={setFirstName}
                  accessibilityLabel="First name"
                />
                <TextInput
                  style={[inputStyle, { flex: 1 }]}
                  placeholder="Last name"
                  placeholderTextColor={theme.colors.textMuted}
                  value={lastName}
                  onChangeText={setLastName}
                  accessibilityLabel="Last name"
                />
              </Row>
              <Button
                label="Continue"
                onPress={() => void saveName()}
                loading={busy}
                disabled={firstName.trim().length === 0}
              />
            </Column>
          ) : null}

          {error ? (
            <View
              style={{
                backgroundColor: theme.colors.surfaceSunken,
                padding: theme.spacing.md,
                borderRadius: theme.radius.md,
              }}
            >
              <Text variant="caption" color="danger">
                {error}
              </Text>
            </View>
          ) : null}
        </Column>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
