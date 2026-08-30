/**
 * Place sources.
 *
 * A `GeoProvider` answers "what is at this address?". A `PlaceSource` answers
 * "what places should this particular rider see right now?" — their saved
 * shortcuts, their recent trips, the venues near them, or a list handed over by
 * an external system (a hotel's front desk, an employer's shuttle schedule, a
 * hospital's discharge desk, a partner booking platform).
 *
 * The rider app renders whatever sources are registered, in priority order. Add
 * an integration by implementing this interface and registering it — the search
 * screen needs no changes.
 */

import type { LatLng, Place, RiderId } from '@lift/core';

export interface PlaceQuery {
  /** Empty when the rider has not typed anything yet. */
  readonly text: string;
  readonly riderId?: RiderId;
  readonly near?: LatLng;
  readonly limit?: number;
  /** Which field the rider is filling in; some sources only make sense for one. */
  readonly field?: 'pickup' | 'dropoff';
  readonly locale?: string;
}

export interface PlaceSourceResult {
  readonly place: Place;
  /** Higher sorts first within a section. */
  readonly relevance: number;
  /** Overrides the source's default icon for this row. */
  readonly icon?: string;
  /** Right-aligned hint: "12 min away", "Booked for 3:00 PM". */
  readonly badge?: string;
}

export interface PlaceSource {
  readonly id: string;
  /** Section heading in the search results: "Saved", "Recent", "Nearby". */
  readonly title: string;
  readonly icon: string;
  /** Lower numbers appear higher in the list. */
  readonly priority: number;
  /** Show this source's results before the rider has typed anything. */
  readonly showWhenEmpty: boolean;
  /** Skip the source entirely for a given query. */
  appliesTo?(query: PlaceQuery): boolean;
  search(query: PlaceQuery): Promise<PlaceSourceResult[]>;
}

/** One section of the rider's search screen. */
export interface PlaceSearchSection {
  readonly sourceId: string;
  readonly title: string;
  readonly icon: string;
  readonly results: readonly PlaceSourceResult[];
}

/**
 * Fans a query out across every registered source and assembles the sections.
 * A source that fails or hangs is dropped rather than breaking search — one
 * flaky partner integration must not take down the ability to book a ride.
 */
export class PlaceSourceRegistry {
  private readonly sources = new Map<string, PlaceSource>();

  constructor(
    initial: readonly PlaceSource[] = [],
    private readonly options: { timeoutMs?: number; onError?: (id: string, e: unknown) => void } = {},
  ) {
    for (const source of initial) this.register(source);
  }

  register(source: PlaceSource): this {
    this.sources.set(source.id, source);
    return this;
  }

  unregister(id: string): this {
    this.sources.delete(id);
    return this;
  }

  get(id: string): PlaceSource | undefined {
    return this.sources.get(id);
  }

  list(): PlaceSource[] {
    return [...this.sources.values()].sort((a, b) => a.priority - b.priority);
  }

  async search(query: PlaceQuery): Promise<PlaceSearchSection[]> {
    const isEmpty = query.text.trim().length === 0;
    const applicable = this.list().filter((source) => {
      if (isEmpty && !source.showWhenEmpty) return false;
      return source.appliesTo ? source.appliesTo(query) : true;
    });

    const settled = await Promise.allSettled(
      applicable.map((source) => this.runSource(source, query)),
    );

    const sections: PlaceSearchSection[] = [];
    settled.forEach((outcome, index) => {
      const source = applicable[index]!;
      if (outcome.status === 'rejected') {
        this.options.onError?.(source.id, outcome.reason);
        return;
      }
      if (outcome.value.length === 0) return;
      sections.push({
        sourceId: source.id,
        title: source.title,
        icon: source.icon,
        results: [...outcome.value].sort((a, b) => b.relevance - a.relevance),
      });
    });
    return sections;
  }

  /** A flat, de-duplicated list — used where sections would be overkill. */
  async searchFlat(query: PlaceQuery): Promise<PlaceSourceResult[]> {
    const sections = await this.search(query);
    const seen = new Set<string>();
    const out: PlaceSourceResult[] = [];
    for (const section of sections) {
      for (const result of section.results) {
        const key = dedupeKey(result.place);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(result);
      }
    }
    return out;
  }

  private async runSource(
    source: PlaceSource,
    query: PlaceQuery,
  ): Promise<PlaceSourceResult[]> {
    const timeoutMs = this.options.timeoutMs ?? 3_000;
    return Promise.race([
      source.search(query),
      new Promise<PlaceSourceResult[]>((_, reject) =>
        setTimeout(() => reject(new Error(`Place source "${source.id}" timed out`)), timeoutMs),
      ),
    ]);
  }
}

/** Two places within ~11 m of each other are the same place for search purposes. */
const dedupeKey = (place: Place): string =>
  place.externalRef ??
  `${place.coordinates.lat.toFixed(4)},${place.coordinates.lng.toFixed(4)}`;
