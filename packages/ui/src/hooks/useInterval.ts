/**
 * Interval and countdown hooks.
 *
 * Both apps run several ticking things at once — an offer countdown, a driver
 * ping loop, an ETA that ages. These keep the timers correct across re-renders
 * and clean up on unmount, which is where hand-rolled versions usually leak.
 */

import { useEffect, useRef, useState } from 'react';

/** Run a callback on an interval. Pass `null` to pause. */
export const useInterval = (callback: () => void, delayMs: number | null): void => {
  const saved = useRef(callback);

  // Keep the latest callback without resetting the interval.
  useEffect(() => {
    saved.current = callback;
  }, [callback]);

  useEffect(() => {
    if (delayMs === null) return;
    const id = setInterval(() => saved.current(), delayMs);
    return () => clearInterval(id);
  }, [delayMs]);
};

/**
 * Milliseconds remaining until a deadline, ticking down. Used for the driver's
 * offer countdown and the rider's free-cancellation window.
 */
export const useCountdown = (
  deadline: number | undefined,
  tickMs = 250,
): { remainingMs: number; expired: boolean; progress: number } => {
  const [now, setNow] = useState(() => Date.now());
  const startRef = useRef<number | undefined>(undefined);

  // Remember when the countdown began, so progress runs 0→1 across the window.
  useEffect(() => {
    startRef.current = deadline === undefined ? undefined : Date.now();
    setNow(Date.now());
  }, [deadline]);

  useInterval(() => setNow(Date.now()), deadline === undefined ? null : tickMs);

  if (deadline === undefined) return { remainingMs: 0, expired: false, progress: 0 };

  const remainingMs = Math.max(0, deadline - now);
  const total = Math.max(1, deadline - (startRef.current ?? now));
  return {
    remainingMs,
    expired: remainingMs <= 0,
    progress: Math.min(1, Math.max(0, 1 - remainingMs / total)),
  };
};

/** A clock that re-renders on an interval, for "3 min ago" style labels. */
export const useNow = (tickMs = 1_000): number => {
  const [now, setNow] = useState(() => Date.now());
  useInterval(() => setNow(Date.now()), tickMs);
  return now;
};
