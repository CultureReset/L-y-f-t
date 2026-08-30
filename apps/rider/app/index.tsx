/**
 * Launch gate.
 *
 * Waits for the stored session to be checked, then routes to the map or to
 * sign-in. A rider with a ride already in progress goes straight to it.
 */

import React, { useEffect } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { router } from 'expo-router';
import { Text, useTheme } from '@lift/ui';
import { useApp } from '../src/state/AppProvider.js';

export default function Launch(): React.JSX.Element {
  const theme = useTheme();
  const { loading, signedIn, error } = useApp();

  useEffect(() => {
    if (loading) return;
    router.replace(signedIn ? '/home' : '/sign-in');
  }, [loading, signedIn]);

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
        Lyft Clone
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
