/**
 * A typed, synchronous pub/sub used to wire domain events to side effects
 * (push notifications, realtime broadcast, analytics) without the domain
 * knowing any of those exist.
 */

export type Listener<T> = (payload: T) => void | Promise<void>;
export type Unsubscribe = () => void;

export class TypedEmitter<Events extends Record<string, unknown>> {
  private readonly listeners = new Map<keyof Events, Set<Listener<never>>>();
  private readonly anyListeners = new Set<(type: keyof Events, payload: unknown) => void>();

  on<K extends keyof Events>(type: K, listener: Listener<Events[K]>): Unsubscribe {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener as Listener<never>);
    return () => {
      set!.delete(listener as Listener<never>);
    };
  }

  once<K extends keyof Events>(type: K, listener: Listener<Events[K]>): Unsubscribe {
    const off = this.on(type, (payload) => {
      off();
      return listener(payload);
    });
    return off;
  }

  /** Subscribe to every event — how the realtime hub mirrors the domain. */
  onAny(listener: (type: keyof Events, payload: unknown) => void): Unsubscribe {
    this.anyListeners.add(listener);
    return () => {
      this.anyListeners.delete(listener);
    };
  }

  /**
   * Emit to every listener. A throwing or rejecting listener is reported
   * through `onError` and never prevents the other listeners from running —
   * a failed push notification must not roll back a completed ride.
   */
  emit<K extends keyof Events>(type: K, payload: Events[K]): void {
    for (const listener of this.listeners.get(type) ?? []) {
      try {
        const result = (listener as Listener<Events[K]>)(payload);
        if (result instanceof Promise) result.catch((e) => this.reportError(e, type));
      } catch (e) {
        this.reportError(e, type);
      }
    }
    for (const listener of this.anyListeners) {
      try {
        listener(type, payload);
      } catch (e) {
        this.reportError(e, type);
      }
    }
  }

  /** Wait for the next event of a type, with an optional predicate and timeout. */
  waitFor<K extends keyof Events>(
    type: K,
    options: { predicate?: (payload: Events[K]) => boolean; timeoutMs?: number } = {},
  ): Promise<Events[K]> {
    return new Promise((resolve, reject) => {
      const timer =
        options.timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              off();
              reject(new Error(`Timed out waiting for ${String(type)}`));
            }, options.timeoutMs);
      const off = this.on(type, (payload) => {
        if (options.predicate && !options.predicate(payload)) return;
        if (timer) clearTimeout(timer);
        off();
        resolve(payload);
      });
    });
  }

  onError?: (error: unknown, type: keyof Events) => void;

  private reportError(error: unknown, type: keyof Events): void {
    if (this.onError) this.onError(error, type);
    else console.error(`[emitter] listener for "${String(type)}" failed:`, error);
  }

  removeAllListeners(type?: keyof Events): void {
    if (type === undefined) {
      this.listeners.clear();
      this.anyListeners.clear();
    } else {
      this.listeners.delete(type);
    }
  }

  listenerCount(type: keyof Events): number {
    return this.listeners.get(type)?.size ?? 0;
  }
}
