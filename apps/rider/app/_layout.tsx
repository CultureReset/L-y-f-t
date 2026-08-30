/**
 * Root layout: providers, then the navigator.
 */

import React from 'react';
import { ActivityIndicator, View } from 'react-native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { Text, ThemeProvider, useTheme } from '@lift/ui';
import { AppProvider, useApp } from '../src/state/AppProvider.js';

/**
 * Nothing renders until the stored session has been restored.
 *
 * Without this, a screen reached directly — a deep link, a notification tap,
 * a reload — fires its first request before the token is set and gets a 401,
 * then renders as if the data did not exist. Holding the navigator for the one
 * async read that boot performs removes that race for every screen at once.
 */
const Boot = ({ children }: { children: React.ReactNode }): React.JSX.Element => {
  const theme = useTheme();
  const { loading } = useApp();

  if (!loading) return <>{children}</>;

  return (
    <View
      style={{
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        gap: theme.spacing.lg,
        backgroundColor: theme.colors.background,
      }}
    >
      <Text variant="display" color="primary">
        Lyft Clone
      </Text>
      <ActivityIndicator color={theme.colors.primary} />
    </View>
  );
};

const Navigator = (): React.JSX.Element => {
  const theme = useTheme();
  return (
    <>
      <StatusBar style={theme.scheme === 'dark' ? 'light' : 'dark'} />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: theme.colors.background },
          animation: 'slide_from_right',
        }}
      >
        <Stack.Screen name="index" />
        <Stack.Screen name="sign-in" options={{ animation: 'fade' }} />
        <Stack.Screen name="home" />
        <Stack.Screen name="search" options={{ animation: 'slide_from_bottom' }} />
        <Stack.Screen name="confirm" />
        <Stack.Screen name="ride/[id]" options={{ gestureEnabled: false }} />
        <Stack.Screen name="activity" />
        <Stack.Screen name="account" />
        <Stack.Screen name="wallet" />
        <Stack.Screen name="settings" />
        <Stack.Screen name="safety" options={{ animation: 'slide_from_bottom' }} />
        <Stack.Screen name="support" />
        <Stack.Screen name="ticket/[id]" />
        <Stack.Screen name="places" />
        <Stack.Screen name="payment/add" />
        <Stack.Screen name="receipt/[id]" />
      </Stack>
    </>
  );
};

export default function RootLayout(): React.JSX.Element {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ThemeProvider>
          <AppProvider>
            <Boot>
              <Navigator />
            </Boot>
          </AppProvider>
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
