/**
 * Launch gate: restore the session, then route to driving, onboarding, or
 * sign-in.
 */

import React, { useEffect } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { router } from 'expo-router';
import { Text, useTheme } from '@lift/ui';
import { useDriver } from '../src/state/DriverProvider.js';

export default function Launch(): React.JSX.Element {
  const theme = useTheme();
  const { loading, signedIn, status, error } = useDriver();

  useEffect(() => {
    if (loading) return;
    if (!signedIn) {
      router.replace('/sign-in');
      return;
    }
    // A driver who cannot go online needs onboarding, not the drive screen.
    router.replace(status && !status.canGoOnline ? '/onboarding' : '/drive');
  }, [loading, signedIn, status]);

  return (
    <View
      style={{
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        gap: theme.spacing.lg,
        padding: theme.spacing.xl,
        backgroundColor: theme.colors.background,
      }}
    >
      <Text variant="display" color="primary">
        Driver
      </Text>
      {error ? (
        <Text variant="caption" color="danger" align="center">
          {error}
        </Text>
      ) : (
        <ActivityIndicator color={theme.colors.primary} />
      )}
    </View>
  );
}
