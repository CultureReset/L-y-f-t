/**
 * Time is injected, never read from the ambient clock inside domain code. That
 * is what makes the dispatcher, the offer timeouts, and the surge windows
 * testable — and what lets the simulator run an hour of rides in a second.
 */

export type Millis = number;
export type Seconds = number;

export interface Clock {
  now(): Millis;
}

export const systemClock: Clock = { now: () => Date.now() };

/** A clock you drive by hand. */
export class ManualClock implements Clock {
  private current: Millis;

  constructor(start: Millis = 0) {
    this.current = start;
  }

  now(): Millis {
    return this.current;
  }

  advance(by: Millis): Millis {
    this.current += by;
    return this.current;
  }

  set(to: Millis): void {
    this.current = to;
  }
}

/** A clock that runs faster than real time — the simulator's time machine. */
export class ScaledClock implements Clock {
  private readonly origin: Millis;
  private readonly startedAt: Millis;

  constructor(
    private readonly scale: number,
    private readonly source: Clock = systemClock,
  ) {
    this.startedAt = source.now();
    this.origin = this.startedAt;
  }

  now(): Millis {
    return this.origin + (this.source.now() - this.startedAt) * this.scale;
  }
}

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export const seconds = (n: number): Millis => n * SECOND;
export const minutes = (n: number): Millis => n * MINUTE;
export const hours = (n: number): Millis => n * HOUR;

export const toSeconds = (ms: Millis): Seconds => Math.round(ms / SECOND);
export const toMinutes = (ms: Millis): number => ms / MINUTE;

/** "5 min", "1 hr 12 min", "Now" — the ETA string both apps render. */
export const formatDuration = (ms: Millis): string => {
  if (ms < 30 * SECOND) return 'Now';
  const totalMinutes = Math.max(1, Math.round(ms / MINUTE));
  if (totalMinutes < 60) return `${totalMinutes} min`;
  const hrs = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;
  return mins === 0 ? `${hrs} hr` : `${hrs} hr ${mins} min`;
};

/** "3:45" — the mm:ss countdown on a driver's offer card. */
export const formatCountdown = (ms: Millis): string => {
  const total = Math.max(0, Math.ceil(ms / SECOND));
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${String(secs).padStart(2, '0')}`;
};

export const formatClockTime = (at: Millis, locale = 'en-US'): string =>
  new Date(at).toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });

/**
 * "3 min ago", "yesterday". Takes `now` rather than reading a clock, so it is
 * pure and testable like everything else here.
 */
export const formatRelativeTime = (at: Millis, now: Millis): string => {
  const delta = now - at;
  if (delta < 0) return 'just now';
  if (delta < MINUTE) return 'just now';
  if (delta < HOUR) {
    const mins = Math.floor(delta / MINUTE);
    return `${mins} min ago`;
  }
  if (delta < DAY) {
    const hrs = Math.floor(delta / HOUR);
    return `${hrs} ${hrs === 1 ? 'hour' : 'hours'} ago`;
  }
  const days = Math.floor(delta / DAY);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks} ${weeks === 1 ? 'week' : 'weeks'} ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} ${months === 1 ? 'month' : 'months'} ago`;
  const years = Math.floor(days / 365);
  return `${years} ${years === 1 ? 'year' : 'years'} ago`;
};

export const addMinutes = (at: Millis, mins: number): Millis => at + minutes(mins);

/** Deadline helper used everywhere an offer or quote can expire. */
export const hasElapsed = (clock: Clock, since: Millis, window: Millis): boolean =>
  clock.now() - since >= window;
