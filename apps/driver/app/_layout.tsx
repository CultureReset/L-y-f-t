/**
 * Root layout. The driver app is dark by default: it is used at night, mounted
 * on a windscreen, and a white screen in a dark car is genuinely dangerous.
 */

import React from 'react';
import { ActivityIndicator, View } from 'react-native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { Text, ThemeProvider, useTheme } from '@lift/ui';
import { DriverProvider, useDriver } from '../src/state/DriverProvider.js';

/**
 * Nothing renders until the stored session has been restored.
 *
 * Without this, a screen reached directly — a deep link, a notification tap,
 * a reload — fires its first request before the token is set and gets a 401,
 * then renders as if the trip did not exist. Holding the navigator for the one
 * async read that boot performs removes that race for every screen at once.
 */
const Boot = ({ children }: { children: React.ReactNode }): React.JSX.Element => {
  const theme = useTheme();
  const { loading } = useDriver();

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
        Driver
      </Text>
      <ActivityIndicator color={theme.colors.primary} />
    </View>
  );
};

const Navigator = (): React.JSX.Element => {
  const theme = useTheme();
  return (
    <>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: theme.colors.background },
        }}
      >
        <Stack.Screen name="index" />
        <Stack.Screen name="sign-in" options={{ animation: 'fade' }} />
        <Stack.Screen name="drive" options={{ gestureEnabled: false }} />
        <Stack.Screen name="earnings" />
        <Stack.Screen name="account" />
        <Stack.Screen name="onboarding" />
        <Stack.Screen name="preferences" />
        <Stack.Screen name="vehicles" />
        <Stack.Screen name="payouts" />
        <Stack.Screen name="ratings" />
        <Stack.Screen name="demand" />
        <Stack.Screen name="support" />
        <Stack.Screen name="ticket/[id]" />
        <Stack.Screen name="trip/[id]" />
        <Stack.Screen name="rate/[id]" options={{ gestureEnabled: false }} />
        <Stack.Screen
          name="navigate/[id]"
          options={{ animation: 'fade', gestureEnabled: false }}
        />
      </Stack>
    </>
  );
};

export default function RootLayout(): React.JSX.Element {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ThemeProvider scheme="dark">
          <DriverProvider>
            <Boot>
              <Navigator />
            </Boot>
          </DriverProvider>
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
