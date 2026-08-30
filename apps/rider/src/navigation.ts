/**
 * Navigation helpers.
 *
 * `router.back()` does nothing when a screen was opened without history — a
 * deep link, a notification tap, or a `replace` that cleared the stack. Every
 * back affordance therefore names where it should land instead, so no screen
 * can become a dead end.
 */

import { router } from 'expo-router';
import type { Href } from 'expo-router';

export const goBack = (fallback: Href): void => {
  if (router.canGoBack()) {
    router.back();
    return;
  }
  router.replace(fallback);
};
