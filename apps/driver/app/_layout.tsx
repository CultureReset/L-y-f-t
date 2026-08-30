/**
 * Root layout. The driver app is dark by default: it is used at night, mounted
 * on a windscreen, and a white screen in a dark car is genuinely dangerous.
 */

import React from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ThemeProvider, useTheme } from '@lift/ui';
import { DriverProvider } from '../src/state/DriverProvider.js';

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
            <Navigator />
          </DriverProvider>
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
