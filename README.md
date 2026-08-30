# L-Y-F-T

A complete, modular ridehail platform: a rider app, a driver app, a dispatch
backend, an operations console, and a fleet simulator — all sharing one domain
model and one API contract.

It runs end to end with **no API keys, no database, and no accounts**. Clone it,
`npm install`, `npm run api`, and you have a working ridehail market.

```
┌─────────────┐   ┌─────────────┐   ┌─────────────┐
│  Rider app  │   │ Driver app  │   │ Ops console │
│  (Expo RN)  │   │  (Expo RN)  │   │  (Vite/React)│
└──────┬──────┘   └──────┬──────┘   └──────┬──────┘
       │                 │                 │
       └────────── @lift/sdk (typed HTTP + realtime) ──────┐
                                                            │
                                            ┌───────────────▼────────────────┐
                                            │        @lift/api (Fastify)      │
                                            │  auth · quotes · dispatch ·     │
                                            │  rides · payments · realtime    │
                                            └───────┬─────────────────┬───────┘
                                                    │                 │
                                    ┌───────────────▼──┐   ┌──────────▼─────────┐
                                    │   @lift/core     │   │     @lift/geo      │
                                    │ state machine ·  │   │ places · routing · │
                                    │ pricing · match  │   │ pluggable providers│
                                    └──────────────────┘   └────────────────────┘
```

---

## Quick start

```bash
npm install

# Terminal 1 — the backend, seeded with a demo market
npm run api

# Terminal 2 — whichever app you want to look at
npm run rider     # rider app  (press w for web, a for Android)
npm run driver    # driver app
npm run admin     # ops console at http://localhost:5173
```

To watch a whole market run itself instead, start a backend with no seeded
drivers and point the simulator at it:

```bash
npm run api:clean   # terminal 1 — no seeded drivers
npm run sim         # terminal 2 — real drivers and riders, driving the real API
npm run admin       # terminal 3 — watch it happen
```

The seeded market and the simulator do not mix well: a seeded driver looks
available but has no app running, so it absorbs offers until each one times out.
`npm run api:clean` skips the seed so every driver in the market is a live agent.

Sign in to either app with **any phone number** and the code **`000000`**.
Two accounts are seeded with history:

| Who           | Phone            |
| ------------- | ---------------- |
| Demo rider    | `415 555 0100`   |
| Demo driver   | `415 555 0199`   |
| Ops console   | `415 555 0000`   |

The demo driver is parked at the market centre, so booking a ride in the rider
app reliably lands the offer on the driver app.

### See the whole thing work in 60 seconds

1. `npm run api`
2. `npm run driver`, sign in as `415 555 0199`, and go online.
3. `npm run rider` in another terminal, sign in as `415 555 0100`, and book a ride.
4. Watch the offer land on the driver, accept it, and drive the trip through
   arrive → start → complete. The rider app tracks the car the whole way.

---

## What is here

| Package             | What it is                                                              |
| ------------------- | ----------------------------------------------------------------------- |
| `packages/core`     | The domain. Ride state machine, pricing engine, dispatch, money, geo maths. Pure — no I/O, no clock, no database. |
| `packages/geo`      | Places and routing behind a provider port. Mock, Google, Mapbox, OSRM.   |
| `packages/sdk`      | The typed API client and realtime client every consumer shares.          |
| `packages/ui`       | Cross-platform design system, including the map abstraction.             |
| `services/api`      | Fastify backend: auth, quoting, dispatch, rides, payments, realtime.     |
| `apps/rider`        | The rider app (Expo — Android, iOS, web).                                |
| `apps/driver`       | The driver app (Expo — Android, iOS, web).                               |
| `apps/admin`        | The operations console (Vite + React).                                   |
| `tools/simulator`   | Virtual drivers and riders that drive the real API.                      |

### The simulator

```bash
npm run sim -- --drivers 12 --riders 6 --speed 10 --duration 300
```

| Flag | Default | What it does |
| --- | --- | --- |
| `--drivers` | `8` | Virtual drivers to put on the road |
| `--riders` | `4` | Virtual riders booking trips |
| `--speed` | `6` | Driving speed multiplier — real speed means a 4-mile trip takes ten minutes |
| `--seed` | `1337` | Reproducible run; the same seed reuses the same accounts |
| `--duration` | run until interrupted | Seconds to run |
| `--api` | `http://localhost:4000` | Backend to drive |

The agents sign in, onboard, and book through the same SDK the apps use, with no
privileged access. If they can complete rides, so can a person with a phone.
Every 30 seconds the run reports requests, completions, offer acceptance, rider
spend, and driver earnings.

---

## Every screen

Both apps are complete, not a demo path. Every screen below is reachable, does
something real against the API, and has been driven in a browser against a
running backend.

### Rider

| Screen | What it does |
| --- | --- |
| Sign in | Phone, one-time code, and a name for a new account |
| Home | The map, saved places, and where-to |
| Search | Places from every registered source, with a stop or pickup edit |
| Confirm | Route, a price per class of service, stops, scheduling, a promo code, a note for the driver, and what each ride type includes |
| Live ride | Driver approaching, the vehicle to look for, chat, and cancel with a reason |
| Safety | Share the trip, call emergency services, and the ride details a dispatcher would ask for |
| Activity | Rides booked for later, and history |
| Receipt | The fare as the line items that sum to it |
| Wallet | Cards and charges |
| Add a card | Validated on the device; only the brand and last four leave it |
| Saved places | Home, work, and favourites |
| Settings | Profile, accessibility that changes matching, and notifications |
| Help | Topics, articles, and a request that becomes a conversation |

### Driver

| Screen | What it does |
| --- | --- |
| Sign in | As above, for a driver |
| Drive | Online toggle, today's earnings, the offer with its countdown, and the live trip |
| Navigate | Turn-by-turn that re-routes when you stray, or hand off to another maps app |
| Earnings | Per-hour beside the total, and every trip |
| Trip | One trip's fare, and how it was split |
| Payouts | Balance, cash out with the fee quoted first, and where it goes |
| Your rating | The distribution, the tags, and the low ratings with nothing to act on |
| Ride preferences | Ride types, pickup radius, destination filter, auto-accept |
| Vehicles | Add one, and say which you are driving tonight |
| Demand | Where the multiplier is above one |
| Rate the rider | Asks why below four stars |
| Onboarding | Documents and approval |
| Help | The same help centre, narrowed to a driver |

---

## Everything is swappable

The platform is built out of ports. Each one has a working default, and each one
is a configuration change away from something else.

### Where pickup and dropoff come from

This is the seam most people want first. A `PlaceSource` supplies places to the
rider's search screen. Six ship by default — saved, recent, current location,
nearby venues, geocoder results — and the search screen renders whatever is
registered, so adding one changes what riders can search **without touching the
app**.

Pulling pickup/dropoff from another system is one adapter:

```ts
import { externalSource } from '@lift/geo';

const hotelDesk = externalSource({
  id: 'partner:hotel',
  title: 'Your hotel',
  fetch: async (query) => {
    const booking = await hotelApi.lookup(query.riderId);
    return [{
      name: `${booking.hotelName} — Main Entrance`,
      address: booking.address,
      coordinates: booking.coordinates,
      externalRef: booking.id,          // round-trips onto the ride
      pickupHint: {                      // where the car actually stops
        coordinates: booking.valetStand,
        label: 'Valet stand on Post St',
      },
      metadata: { reservationId: booking.id },
    }];
  },
});

createContainer(config, serverConfig, { placeSources: [hotelDesk] });
```

That partner's own key, curb instructions, and metadata ride through quoting,
dispatch, and navigation untouched, and end up on the completed ride record. A
source that fails or hangs is dropped rather than breaking search.

### Maps and routing

`GEO_PROVIDER` selects the implementation. All four satisfy the same interface.

| Value    | What it uses                                        |
| -------- | --------------------------------------------------- |
| `mock`   | **Default.** Deterministic, offline, no key. Routes follow a synthetic street grid, so geometry and turn-by-turn look like real city driving. |
| `google` | Places, Geocoding, Directions, Distance Matrix.     |
| `mapbox` | Geocoding v5, Directions v5, Matrix v1.             |
| `osrm`   | OSRM routing + Nominatim geocoding, both self-hostable. |

```bash
GEO_PROVIDER=mapbox GEO_API_KEY=pk.xxx npm run api
```

Providers compose. Mapbox search with self-hosted OSRM routing is a common,
much cheaper pairing:

```ts
new CompositeGeoProvider({
  search: new MapboxGeoProvider({ accessToken }),
  routing: new OsrmGeoProvider({ routerUrl: 'http://osrm.internal' }),
});
```

Any provider can be wrapped in `withFallback(provider, new MockGeoProvider())`,
so a vendor outage degrades ETA quality instead of stopping the platform, and in
`withCache(...)`, which collapses the per-keystroke and per-dispatch-tick request
storm that otherwise dominates a provider bill.

### The database

Persistence is behind repository ports with two implementations:

```bash
npm run api                                        # in-memory (default)
STORE=postgres DATABASE_URL=postgres://… npm run api  # PostgreSQL
```

One conformance suite runs against **both**, so "swap the store" is verified
rather than asserted. The schema uses JSONB documents with generated columns for
the fields queries filter on, so there is one source of truth and no mapping
layer to drift.

### Pricing

A fare is a phase-ordered pipeline of rules, and every charge is a line item
that sums exactly to the total. Adding a charge means adding a rule; the engine
never changes.

```ts
const congestionCharge: PricingRule = {
  id: 'congestion_zone',
  phase: 'surcharge',
  priority: 50,
  appliesTo: (ctx) => isInsideCongestionZone(ctx.pickup),
  evaluate: (ctx) => [{
    ruleId: 'congestion_zone',
    code: 'congestion',
    label: 'Congestion charge',
    amount: fromDecimal(2.5, ctx.currency),
    kind: 'surcharge',
  }],
};
```

Surge is a provider too: `flat`, `demand` (live supply/demand per grid cell),
`scheduled` (commute peaks), or a combination.

### Dispatch

Matching strategy is `DISPATCH_STRATEGY`: `scored` (the default weighted mix of
ETA, proximity, driver quality, and fleet fairness), `nearest`, `fastest_eta`,
`fairness`, or `round_robin`. Retune the scored strategy by supplying different
components — ETA, proximity, rating, acceptance, idle time, destination fit, trip
value — or write your own.

The dispatcher itself is a **pure** state machine: feed it candidates and a
timestamp, get back commands. That is why a five-minute search with expiring
offers and expanding radii can be replayed in a test in microseconds.

### Classes of service

Standard, Shared, XL, Lux, and Access ship as data — rate card, vehicle
requirements, dispatch tuning, and presentation. Adding a tier is one call:

```ts
catalog.register({
  id: 'pet',
  name: 'Pet',
  tagline: 'Bring your dog',
  rateCard: { ...baseRateCard(), baseFare: fromDecimal(4) },
  vehicleRequirements: { minSeats: 4, requiredFeatures: ['pet_friendly'] },
  /* … */
});
```

### The map in the apps

`MapView` delegates to a registered renderer. The built-in one draws routes,
pins, and heading-aware car markers in `react-native-svg` — no key, no billing,
no native module, and identical on Android, iOS, and web. Swap it at the root:

```tsx
<MapRendererProvider renderer={GoogleMapRenderer}>
  <App />
</MapRendererProvider>
```

### Payments, notifications, SMS

`PaymentGateway`, `PushTransport`, and `CodeSender` are all ports with working
in-memory or console defaults. The memory gateway has a configurable decline
rate, so the failure branches are actually testable.

---

## Configuration

Nothing reads `process.env` except one loader. Everything else takes a
`PlatformConfig`, which is what makes the whole system runnable in a test, in the
simulator, or as several markets in one process.

| Variable | Default | What it does |
| --- | --- | --- |
| `PORT` | `4000` | API port |
| `STORE` | `memory` | `memory` or `postgres` |
| `DATABASE_URL` | — | Required when `STORE=postgres` |
| `GEO_PROVIDER` | `mock` | `mock`, `google`, `mapbox`, `osrm` |
| `GEO_API_KEY` | — | Key for the selected geo provider |
| `DISPATCH_STRATEGY` | `scored` | Matching strategy |
| `DISPATCH_OFFER_TIMEOUT_MS` | `15000` | How long a driver has to accept |
| `DISPATCH_SEARCH_TIMEOUT_MS` | `300000` | When to give up on a ride |
| `SURGE_PROVIDER` | `flat` | `flat`, `demand`, `scheduled`, `demand+scheduled` |
| `PAYMENT_GATEWAY` | `memory` | Payment gateway id |
| `PAYMENT_DECLINE_RATE` | `0` | Fraction of authorizations to decline, for testing |
| `MARKET_CENTER_LAT` / `_LNG` | San Francisco | Where the market is |
| `AUTO_APPROVE_DRIVERS` | on outside production | Approve drivers as soon as documents are submitted |
| `DEV_AUTH_CODE` | `000000` outside production | Fixed sign-in code. Refused in production. |

---

## The ride lifecycle

Every status change in the platform goes through one transition table in
`packages/core/src/ride/stateMachine.ts`. There is no other place a ride's
status can change.

```
draft ──▶ requested ──▶ accepted ──▶ arrived ──▶ in_progress ──▶ completed
  │           │             │           │             │
  │           ├─▶ expired   │           │             │
  └────────── └─────────────┴───────────┴─────────────┴──▶ cancelled
```

The table encodes which statuses each action is legal from and which actors may
trigger it, so an illegal sequence is impossible to express rather than merely
discouraged. Ride writes use optimistic concurrency, so a driver tapping
"arrived" cannot clobber a concurrent dispatch write.

---

## Testing

```bash
npm test          # the whole suite
npm run typecheck # every package, service, and app
```

**308 tests.** They run the real code — the real dispatcher, the real state
machine, the real routes — against an in-memory store and a hand-driven clock.
Nothing below the route handler is mocked.

- **Domain** — fare composition, every legal and illegal ride transition, the
  full dispatch waterfall including offer expiry and radius expansion.
- **Repository conformance** — one suite, both stores. Run it against a real
  database with `TEST_DATABASE_URL=postgres://… npm test`.
- **API** — 54 end-to-end tests covering auth, quoting, dispatch, the trip
  lifecycle, cancellation policy, payments, ratings, and chat.
- **Realtime** — reconnection with backoff, subscription replay, stale-fix
  dropping.
- **Projection** — the Web Mercator maths the map renderer draws through.

---

## Building the Android apps

```bash
cd apps/rider     # or apps/driver
npx expo run:android          # a local debug build
npx eas build -p android      # a distributable build
```

Or, with only the Android SDK and no Expo account:

```bash
cd apps/rider
npx expo prebuild --platform android
cd android && ./gradlew assembleDebug
# app/build/outputs/apk/debug/app-debug.apk
```

The generated `android/` directory is derived from `app.json` and is not
tracked — `expo prebuild` recreates it, and editing it by hand loses the change
on the next run.

Both apps also run on iOS and in a browser from the same source. Point them at a
non-local backend with `EXPO_PUBLIC_API_URL`.

### Icons and store assets

Every icon, adaptive icon, splash, and Play Store graphic is generated from one
definition:

```bash
python3 tools/brand/src/generate.py
```

Change a brand colour or the mark in `tools/brand/src/generate.py` and re-run
it. No PNG in the repo is hand-edited.

### Shipping to Google Play

[`docs/RELEASING.md`](docs/RELEASING.md) covers the release process: signing,
the `versionCode` bump that Play rejects an upload without, the justification
for every permission each app requests, and the Data safety answers that match
what the code actually does. Store copy and screenshot inventories are in
[`docs/store/`](docs/store/).

---

## Repository layout

```
packages/core/src/
  ride/stateMachine.ts     the transition table — read this first
  pricing/                 rules, engine, surge
  matching/                strategies, scoring, the pure dispatcher
  catalog/rideTypes.ts     classes of service, as data
packages/geo/src/
  types.ts                 the GeoProvider port
  providers/               mock, google, mapbox, osrm
  sources/                 PlaceSource — where pickup/dropoff come from
services/api/src/
  container.ts             the composition root: every dependency chosen here
  repositories/            ports, memory store, postgres store, conformance suite
  services/                the orchestration layer
```

## With a real database

```bash
docker compose up          # PostgreSQL + the API on :4000
```

Or point the API at your own:

```bash
STORE=postgres DATABASE_URL=postgres://… npm run api
```

The schema is applied at startup from `services/api/src/repositories/postgres/schema.sql`.

---

## Further reading

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — how it fits together and why.
- [`docs/EXTENDING.md`](docs/EXTENDING.md) — recipes: a new place source, a new
  class of service, a new fare rule, a different mapping vendor, a real payment
  processor, a second market.
- [`docs/RELEASING.md`](docs/RELEASING.md) — building, signing, permissions, and
  the Play Store submission checklist.
- [`docs/PRIVACY.md`](docs/PRIVACY.md) — a privacy policy describing what the
  apps actually collect. A template to adapt, not legal advice.

## Licence

Reference implementation, provided as-is.
