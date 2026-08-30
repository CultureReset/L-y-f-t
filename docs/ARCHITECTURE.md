# Architecture

How the platform is put together, and why. Read
`packages/core/src/ride/stateMachine.ts` first — it is the shortest path to
understanding what a ride actually is here.

## The shape of it

Four layers, each depending only on the one beneath it.

```
apps + tools        rider · driver · ops console · simulator
      │             (all four speak to the backend through @lift/sdk)
      ▼
services/api        HTTP routes, WebSocket hub, orchestration services
      │             (chooses every implementation in one composition root)
      ▼
packages/geo        places and routing, behind a provider port
      │
      ▼
packages/core       the domain: pure, no I/O, no ambient clock
```

Nothing in `core` imports anything above it. Nothing above `core` reimplements
what is in it — the apps compute fares and read ride status with exactly the
same code the backend uses, which is why a fare shown in the app and a fare
charged by the backend cannot disagree.

## Three rules the codebase follows

**1. Time is injected.** No domain code calls `Date.now()`. A `Clock` is passed
in. That is what makes the dispatcher — with its expiring offers, round delays,
and expanding search radii — testable without waiting, and what lets the API
test suite replay a five-minute search in microseconds.

**2. Effects live at the edges.** The dispatcher and the state machine are pure
functions. The dispatcher consumes candidates and a timestamp and returns
*commands* (`send_offer`, `expire_offer`, `assign_driver`); a runtime turns
those into persistence, pushes, and socket traffic. The state machine consumes a
ride and an action and returns the next ride. Neither has ever seen a database.

**3. Every seam is a port with a working default.** Geo, places, persistence,
payments, push, SMS, surge, matching strategy, and map rendering are all
interfaces. Each has an implementation that works offline with no keys, so the
platform runs the moment you clone it, and each is a configuration change away
from the real thing.

## The ride lifecycle

One transition table, in `core/src/ride/stateMachine.ts`, governs every status
change in the platform:

```
draft ──▶ requested ──▶ accepted ──▶ arrived ──▶ in_progress ──▶ completed
  │           │             │           │             │
  │           ├─▶ expired   │           │             │
  └────────── └─────────────┴───────────┴─────────────┴──▶ cancelled
```

Each row records the statuses an action is legal from and the actors allowed to
trigger it. A rider cannot mark themselves picked up; a driver cannot expire a
search; a ride that has finished cannot do anything at all. Guards add the
conditions a table cannot express — a ride cannot be assigned twice, a
completion cannot precede its start, only the assigned driver may cancel.

`applyTransition` is pure and never mutates its input. `RideService.transition`
is the only place a ride's status is persisted: it loads, applies, saves under
an optimistic guard, and publishes. Because the machine rejects anything
illegal, the service never re-checks what is allowed — it only arranges effects.

## Dispatch

The interesting problem is not "find the nearest driver". It is running a
waterfall of timed offers across a fleet that is moving, while riders cancel and
drivers stop answering.

`DispatchSession` owns one ride's search:

1. Rank eligible drivers with the configured strategy.
2. Offer to the top `offerBatchSize`.
3. On accept, assign and stop. On decline or timeout, exclude that driver and
   continue.
4. When a round finds nobody, widen the radius and try again.
5. Give up at `searchTimeoutMs`.

Hard constraints and soft preferences are deliberately separate.
`filterEligible` applies the rules a driver must satisfy — vehicle class, opt-in,
distance limits, party size, destination filter — and reports *why* each rejected
candidate was dropped, which is what makes "why did nobody get my ride?"
answerable in the ops console. Only survivors reach the strategy, which merely
orders them.

`DispatchRuntime` performs the effects and drives every open session from a
single interval, so the number of timers is proportional to the process rather
than to the number of open rides. In tests and the simulator the interval is off
and `tick()` is called by hand.

## Pricing

A fare is never a number; it is an ordered list of line items that sums exactly
to the total. Rules run in phase order — `base`, `surge`, `surcharge`,
`discount`, `fee`, `tax`, `final` — and each rule sees the running state, which
is what makes percentage-based rules compose correctly without knowing about one
another. Surge multiplies the base charges only; multiplying a fixed service fee
by 2.1× would be wrong.

Money is integer minor units with an explicit currency. Floating point never
touches a running total, and `allocate` splits an amount by weight without
losing or inventing a cent. A rule that emits the wrong currency throws rather
than silently corrupting a fare.

## Realtime

A channel-based hub mirrors domain events onto `ride:`, `driver:`, `rider:`, and
`ops:all`. The hub subscribes to the event emitter rather than being called by
the services, so no service knows realtime exists — adding a new reaction to
"ride completed" never means editing the ride service.

Fan-out policy lives in one function (`routeEvent`): a rider sees their own
ride, a driver sees theirs, ops sees everything. Authorisation is enforced per
subscribe, so a client cannot watch a ride it is not part of.

The client side matters as much: phones lose connections. `RealtimeClient`
reconnects with jittered backoff, replays its subscriptions on reconnect, answers
heartbeats, and **drops** queued location fixes rather than sending stale ones.

## Persistence

Repository ports, two implementations, one conformance suite run against both.
That suite is not ceremony — it caught the in-memory store failing to enforce
payment idempotency while PostgreSQL did, which is exactly the class of drift
that makes a "swappable" store a lie.

Aggregates the domain owns (rides, offers, vehicles, shifts, charges) are stored
as a JSONB document with generated columns for the fields queries filter on. One
source of truth, no mapping layer to drift, real indexes where they matter.
Ride writes are guarded by `updated_at`, so a stale writer is refused rather than
clobbering.

## Places

`GeoProvider` answers "what is at this address?". `PlaceSource` answers "what
should this rider see right now?" — and that second question is the one that
varies by deployment.

A `Place` carries its `source`, an opaque `externalRef`, an optional
`pickupHint` (the curb, not the building centroid), and a metadata bag. All of
it survives quoting, dispatch, and navigation and lands on the completed ride, so
an integration's own identifiers round-trip untouched.

The registry fans a query across every registered source and assembles sections.
A source that fails or exceeds its timeout is dropped — one flaky partner
integration must not take down the ability to book a ride.

## Where to change things

| To change | Go to |
| --- | --- |
| What a ride can do | `core/src/ride/stateMachine.ts` |
| How fares are computed | add a rule in `core/src/pricing/rules.ts` |
| Which driver gets a ride | `core/src/matching/scoring.ts` or `strategies.ts` |
| Classes of service | `core/src/catalog/rideTypes.ts` |
| Where places come from | implement `PlaceSource`, register it in the container |
| Which map vendor | `GEO_PROVIDER`, or a new adapter in `geo/src/providers/` |
| The database | implement `Repositories`, wire it in `container.ts` |
| Which implementations are used | `services/api/src/container.ts` — the only place |
| How a map is drawn in the apps | pass a renderer to `MapRendererProvider` |
