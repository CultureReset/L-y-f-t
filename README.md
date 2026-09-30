# L-Y-F-T

A modular ridehail platform in one monorepo: rider app, driver app, dispatch backend, ops console and fleet simulator.

## What it is

A generic small "Uber/Lyft" build. Riders request and track trips, drivers accept offers, the backend prices and matches, and an admin console watches the market. It is not tied to the Gulf Coast Radar business. It runs in demo mode with no API keys, database or accounts.

## How it works

- npm workspaces monorepo (`lift-platform`, Node 20+): `packages/*`, `services/*`, `apps/*`, `tools/*`.
- `services/api` (Fastify + zod): entry `src/index.ts`, routes in `src/http/routes/` (`auth`, `rides`, `drivers`, `riders`, `places`, `support`, `admin`, `realtime`), realtime hub in `src/realtime/`. Example routes: `POST /rides/quote`, `POST /rides`.
- `packages/core`: ride state machine, pricing and surge, dispatch scoring, promos, cancellation, support tickets (vitest tests).
- `packages/geo`: pluggable place and routing providers (mock, google, mapbox, osrm). `packages/sdk`: typed HTTP and realtime client. `packages/ui`: shared React Native components.
- Storage is in-memory by default; `STORE=postgres` switches to `repositories/postgres` (needs `DATABASE_URL`).
- `apps/rider` and `apps/driver` are Expo React Native apps; `apps/admin` is a Vite/React ops console; `tools/simulator` drives virtual riders and drivers against the real API.
- Optional adapters in `services/api/src/integrations/`: Stripe-style payments, Twilio SMS, Expo push.
- Also present: `Dockerfile`, `docker-compose.yml`, CI workflow, and docs under `docs/`.

## Run it

```sh
npm install
npm run api          # backend on the seeded demo market
npm run rider        # or: npm run driver / npm run admin
npm run api:clean    # backend with no seeded drivers
npm run sim          # fleet simulator against the backend
npm test             # vitest
```

Demo sign-in: any phone number with the dev code from `DEV_AUTH_CODE` (documented in the original README).

Environment variable names (all optional, see `.env.example`): `PORT`, `NODE_ENV`, `LOG_LEVEL`, `CORS_ORIGINS`, `STORE`, `DATABASE_URL`, `GEO_PROVIDER`, `GEO_API_KEY`, `DISPATCH_STRATEGY`, `SURGE_PROVIDER`, `CANCELLATION_POLICY`, `PAYMENT_GATEWAY`, `DEV_AUTH_CODE`, `AUTO_APPROVE_DRIVERS`, `SEED_ON_BOOT`, `BRAND_NAME`, `MARKET_NAME`, `CURRENCY`. Apps read `EXPO_PUBLIC_API_URL`.

## Status

Stalled: a substantial, tested platform in a single commit with no deployment configured; mobile build config still points at placeholder URLs.

## Where it fits

```mermaid
flowchart LR
  Rider[Rider app] --> SDK[@lift/sdk]
  Driver[Driver app] --> SDK
  Admin[Ops console] --> SDK
  Sim[Simulator] --> SDK
  SDK -->|HTTP + realtime| API[services/api Fastify]
  API --> Core[@lift/core]
  API --> Geo[@lift/geo]
  API -.optional.-> PG[(Postgres)]
  API -.optional.-> Ext[Payments / SMS / Push]
```

## Related repos

None duplicated or fed. It is independent of the Gulf Coast Radar and CyberCheck repos.
