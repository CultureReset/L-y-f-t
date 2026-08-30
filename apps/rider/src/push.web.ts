/**
 * Push, on the web: nothing.
 *
 * `expo-notifications` has no web implementation worth having, and importing
 * it pulls a transitive dependency Metro cannot resolve for the web target —
 * which takes the whole bundle down, not just this feature. A browser session
 * has the realtime socket for live updates anyway, which is what push exists
 * to substitute for when the app is closed.
 *
 * Metro picks this over `push.ts` for `platform === 'web'`, so nothing else
 * has to know.
 */

import type { LiftClient } from '@lift/sdk';

export const registerForPush = async (_client: LiftClient): Promise<void> => {};

export const usePushNotifications = (_client: LiftClient, _signedIn: boolean): void => {};
