/**
 * Seeded pseudo-randomness. The simulator and the tests both need runs that
 * are varied but reproducible — same seed, same fleet, same traffic.
 */

export interface Random {
  next(): number;
  int(minInclusive: number, maxExclusive: number): number;
  float(min: number, max: number): number;
  bool(probability?: number): boolean;
  pick<T>(items: readonly T[]): T;
  shuffle<T>(items: readonly T[]): T[];
  /** Normal-ish deviate via the central limit trick; good enough for jitter. */
  gaussian(mean: number, stdDev: number): number;
}

/** mulberry32 — small, fast, and good enough for simulation. */
export const seededRandom = (seed: number): Random => {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const api: Random = {
    next,
    int: (minInclusive, maxExclusive) =>
      Math.floor(next() * (maxExclusive - minInclusive)) + minInclusive,
    float: (min, max) => next() * (max - min) + min,
    bool: (probability = 0.5) => next() < probability,
    pick: (items) => {
      if (items.length === 0) throw new Error('pick: empty array');
      return items[Math.floor(next() * items.length)]!;
    },
    shuffle: (items) => {
      const copy = [...items];
      for (let i = copy.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [copy[i], copy[j]] = [copy[j]!, copy[i]!];
      }
      return copy;
    },
    gaussian: (mean, stdDev) => {
      const u = (next() + next() + next() + next() + next() + next() - 3) / 3;
      return mean + u * stdDev;
    },
  };
  return api;
};

export const systemRandom = (): Random => seededRandom(Math.floor(Math.random() * 2 ** 32));
