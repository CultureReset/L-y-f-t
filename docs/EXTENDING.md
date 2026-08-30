# Extending the platform

Recipes for the changes people actually make. Each one is self-contained and
touches one seam.

---

## Pull pickup and dropoff from another system

The most common ask. A `PlaceSource` supplies places to the rider's search
screen; the screen renders whatever is registered, so this needs no app change.

```ts
// services/api/src/integrations/hotelDesk.ts
import { externalSource } from '@lift/geo';

export const hotelDesk = externalSource({
  id: 'partner:hotel',
  title: 'Your hotel',
  icon: 'building',
  priority: 12,          // lower sorts higher; saved places are 10
  showWhenEmpty: true,   // appears before the rider types anything

  fetch: async (query) => {
    if (!query.riderId) return [];
    const booking = await hotelApi.currentBooking(query.riderId);
    if (!booking) return [];

    return [
      {
        name: `${booking.hotelName} — Main Entrance`,
        address: booking.address,
        coordinates: booking.coordinates,
        category: 'hotel',
        externalRef: booking.id,
        pickupHint: {
          coordinates: booking.valetStand,
          label: 'Valet stand on Post St',
          instructions: 'Ask the doorman for the rideshare queue',
        },
        badge: 'Checked in',
        metadata: { reservationId: booking.id, guestTier: booking.tier },
      },
    ];
  },
});
```

Register it:

```ts
// services/api/src/index.ts
const container = await createContainer(platformConfig, serverConfig, {
  placeSources: [hotelDesk],
});
```

What you get for free:

- The rider sees a **Your hotel** section in search.
- `pickupHint` is where the car is routed to — the valet stand, not the
  building centroid. The driver app shows the label and instructions on the
  pickup screen.
- `externalRef` and `metadata` ride through quoting, dispatch, and navigation
  and land on the completed ride record, so the booking can be reconciled.
- If `hotelApi` is down or slow, the source is dropped and search still works.

A source is just an object — `savedPlacesSource`, `venueSource`, and
`geoProviderSource` in `packages/geo/src/sources/builtin.ts` are worth reading
as further examples.

---

## Add a class of service

Ride types are data. Everything that distinguishes one from another — rate card,
vehicle requirements, dispatch tuning, presentation — lives in one record.

```ts
import { RideTypeCatalog, baseRateCard, fromDecimal } from '@lift/core';

const catalog = new RideTypeCatalog();

catalog.register({
  id: 'pet',
  name: 'Pet',
  tagline: 'Bring your dog',
  description: 'A driver who welcomes animals, with a covered back seat.',
  icon: 'car',
  displayOrder: 25,
  maxPassengers: 4,
  rateCard: {
    ...baseRateCard(),
    baseFare: fromDecimal(4.0),
    perMile: fromDecimal(1.45),
  },
  vehicleRequirements: { minSeats: 4, requiredFeatures: ['pet_friendly'] },
  dispatch: {
    searchRadiusMeters: 15_000,
    offerTimeoutMs: 20_000,
    searchTimeoutMs: 8 * 60_000,
    offerBatchSize: 1,
  },
  etaMultiplier: 1.6,   // this tier is scarcer than Standard
  shared: false,
  enabled: true,
});
```

Only drivers whose vehicle carries `pet_friendly` are offered these rides, the
tier appears in the rider's picker priced from its own card, and both apps pick
it up from `/config` with no code change.

To adjust an existing tier rather than add one:

```ts
catalog.override('standard', {
  rateCard: { ...catalog.require('standard').rateCard, perMile: fromDecimal(1.35) },
});
```

---

## Add a charge to the fare

Rules run in phase order and each sees the running total, so a new rule composes
with the rest automatically.

```ts
import { fromDecimal, type PricingRule } from '@lift/core';

export const airportFee: PricingRule = {
  id: 'airport_fee',
  phase: 'surcharge',   // after surge, before discounts and fees
  priority: 20,
  description: 'Per-trip fee for airport pickups',

  appliesTo: (ctx) => isInsideAirport(ctx.pickup),

  evaluate: (ctx) => [
    {
      ruleId: 'airport_fee',
      code: 'airport_pickup',
      label: 'Airport pickup fee',
      amount: fromDecimal(5.5, ctx.currency),
      kind: 'surcharge',
      detail: 'Charged by the airport authority',
    },
  ],
};
```

Phases run `base → surge → surcharge → discount → fee → tax → final`. Pick the
one whose position relative to the others you actually want: a surcharge is
discountable and taxable, a `fee` is neither.

The line item shows up on the rider's receipt, in the driver's payout split, and
in the ops console's fare breakdown, with no further work.

---

## Change which driver gets a ride

Retune the scored strategy by supplying different components:

```ts
import {
  acceptanceComponent,
  destinationFitComponent,
  etaComponent,
  idleTimeComponent,
  scoredStrategy,
} from '@lift/core';

// A market that cares more about spreading work than about the fastest pickup.
const fairnessFirst = scoredStrategy([
  etaComponent(0.35),
  idleTimeComponent(0.35),
  acceptanceComponent(0.15),
  destinationFitComponent(0.15),
]);

createContainer(config, serverConfig, { matchingStrategy: fairnessFirst });
```

A component is a function returning 0–1 where 1 is best:

```ts
const vehicleAgeComponent = (weight = 0.1): ScoringComponent => ({
  id: 'vehicle_age',
  weight,
  score: (candidate) => scoreFromFleetData(candidate.vehicleId),
});
```

To change the **rules** rather than the ordering — who is eligible at all — edit
`filterEligible` in `packages/core/src/matching/strategies.ts`. Keep hard
constraints there and soft preferences in scoring; that separation is what makes
the rejection reasons in the ops console meaningful.

---

## Swap the mapping vendor

```bash
GEO_PROVIDER=google GEO_API_KEY=AIza... npm run api
```

To mix vendors — a common way to cut a provider bill roughly in half:

```ts
import { CompositeGeoProvider, MapboxGeoProvider, OsrmGeoProvider } from '@lift/geo';

const geo = new CompositeGeoProvider({
  search: new MapboxGeoProvider({ accessToken: process.env.MAPBOX_TOKEN! }),
  routing: new OsrmGeoProvider({ routerUrl: 'http://osrm.internal:5000' }),
});

createContainer(config, serverConfig, { geo });
```

To add a vendor, implement `GeoProvider` and register a factory:

```ts
import { registerGeoProvider } from '@lift/geo';

registerGeoProvider('here', ({ apiKey }) => new HereGeoProvider({ apiKey }));
```

Then `GEO_PROVIDER=here`. Only implement the capabilities you need — declare the
rest `false` in `capabilities` and compose with another provider for those.

---

## Use a real map in the apps

The built-in renderer needs no key. To use a real basemap, implement the same
props and register it once at the root:

```tsx
import MapLibreGL from '@maplibre/maplibre-react-native';
import { MapRendererProvider, type MapProps } from '@lift/ui';

const MapLibreRenderer = ({ markers, polylines, fitTo, style }: MapProps) => (
  <MapLibreGL.MapView style={style} styleURL={STYLE_URL}>
    {/* map the same props onto the SDK's primitives */}
  </MapLibreGL.MapView>
);

export default function App() {
  return (
    <MapRendererProvider renderer={MapLibreRenderer}>
      <Navigator />
    </MapRendererProvider>
  );
}
```

Every map screen in the app changes at once.

---

## Plug in a real payment processor

```ts
import type { PaymentGateway } from '@lift/core';

export const stripeGateway = (secretKey: string): PaymentGateway => {
  const stripe = new Stripe(secretKey);
  return {
    id: 'stripe',
    async authorize(request) {
      try {
        const intent = await stripe.paymentIntents.create(
          {
            amount: request.amount.amount,
            currency: request.amount.currency.toLowerCase(),
            payment_method: request.paymentMethodId,
            capture_method: 'manual',   // the platform captures at completion
            confirm: true,
          },
          { idempotencyKey: request.idempotencyKey },
        );
        return { ok: true, reference: intent.id };
      } catch (e) {
        return {
          ok: false,
          failureCode: (e as Stripe.errors.StripeError).code,
          failureMessage: (e as Error).message,
        };
      }
    },
    capture: async (reference, amount) => { /* … */ },
    void: async (reference) => { /* … */ },
    refund: async (reference, amount) => { /* … */ },
  };
};
```

Pass it as `{ gateway: stripeGateway(key) }` to `createContainer`. The
authorize-then-capture flow, idempotency keys, and charge bookkeeping are
already handled — the gateway only has to move money.

`PushTransport` (notifications) and `CodeSender` (SMS) work the same way.

---

## Run more than one market in a process

Nothing is global. Build a container per market:

```ts
const markets = await Promise.all(
  [sfConfig, laConfig, nycConfig].map((config) =>
    createContainer(config, serverConfig, {
      rideTypes: rideTypesFor(config.market.id),
      placeSources: placeSourcesFor(config.market.id),
    }),
  ),
);
```

Each has its own catalog, pricing, dispatch tuning, and place sources. They can
share a store or not, depending on the repositories you hand them.

---

## Swap the database

Implement the `Repositories` bundle in
`services/api/src/repositories/types.ts`, then wire it in `container.ts`.

Before trusting it, point the conformance suite at it:

```ts
// services/api/src/repositories/conformance.test.ts
const suites = [
  { name: 'memory', create: createMemoryRepositories, skip: false },
  { name: 'postgres', create: createPostgresRepositories, skip: !process.env.TEST_DATABASE_URL },
  { name: 'mystore', create: createMyStore, skip: false },   // add this
];
```

That suite exists because the differences that matter are the subtle ones —
optimistic concurrency, the radius query, payment idempotency — and it has
already caught real drift between the two shipped stores.
