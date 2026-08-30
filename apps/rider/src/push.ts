/**
 * Push notifications.
 *
 * The backend already knows how to send — what was missing was a device to
 * send to. This registers one after sign-in and routes a tap to the screen the
 * notification is about.
 *
 * Two Android channels, matching what the backend's Expo transport sends:
 * `urgent` for anything with a countdown running, and `default` for
 * everything else. Without them Android files every notification under one
 * channel, and a rider who mutes receipts also mutes "your driver is here".
 */

import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import { router } from 'expo-router';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import type { LiftClient } from '@lift/sdk';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

/** Set up the channels Android needs before the first notification arrives. */
const configureChannels = async (): Promise<void> => {
  if (Platform.OS !== 'android') return;

  await Notifications.setNotificationChannelAsync('default', {
    name: 'Trip updates',
    importance: Notifications.AndroidImportance.DEFAULT,
    vibrationPattern: [0, 200],
    lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
  });

  await Notifications.setNotificationChannelAsync('urgent', {
    name: 'Your driver',
    description: 'Your driver arriving, and anything that needs you now.',
    importance: Notifications.AndroidImportance.MAX,
    vibrationPattern: [0, 250, 250, 250],
    lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
  });
};

/**
 * Ask for permission and hand the token to the backend.
 *
 * Returns nothing rather than throwing: a rider who refuses notifications
 * should still get a working app, and an emulator without Play Services
 * cannot produce a token at all.
 */
export const registerForPush = async (client: LiftClient): Promise<void> => {
  if (!Device.isDevice) return;

  try {
    await configureChannels();

    const existing = await Notifications.getPermissionsAsync();
    const granted =
      existing.granted ||
      (existing.canAskAgain && (await Notifications.requestPermissionsAsync()).granted);
    if (!granted) return;

    const { data } = await Notifications.getExpoPushTokenAsync();
    await client.registerDevice(data);
  } catch {
    // Push is an enhancement. Nothing above should be able to break a launch.
  }
};

/**
 * Route a notification tap. The backend puts a `route` in every message's data
 * — that is the whole contract, so a new notification type needs no change
 * here.
 */
const openFromData = (data: Record<string, unknown> | undefined): void => {
  const route = typeof data?.route === 'string' ? data.route : undefined;
  if (!route) return;
  router.push(`/${route.replace(/^\//, '')}` as never);
};

/** Registers on sign-in and wires up taps. Call once, from the provider. */
export const usePushNotifications = (client: LiftClient, signedIn: boolean): void => {
  const registered = useRef(false);

  useEffect(() => {
    if (!signedIn || registered.current) return;
    registered.current = true;
    void registerForPush(client);
  }, [client, signedIn]);

  useEffect(() => {
    // A tap while the app was closed: act on it once, at launch.
    void Notifications.getLastNotificationResponseAsync().then((response) => {
      if (response) {
        openFromData(
          response.notification.request.content.data as Record<string, unknown> | undefined,
        );
      }
    });

    const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
      openFromData(
        response.notification.request.content.data as Record<string, unknown> | undefined,
      );
    });
    return () => subscription.remove();
  }, []);
};
