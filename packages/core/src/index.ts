/**
 * @lift/core — the platform's domain layer.
 *
 * Pure, dependency-light, and shared verbatim by the backend, both mobile
 * apps, the ops console, and the simulator. Nothing in here performs I/O,
 * reads a clock, or knows what a database is.
 */

// Primitives
export * from './util/ids.js';
export * from './util/money.js';
export * from './util/geo.js';
export * from './util/time.js';
export * from './util/errors.js';
export * from './util/result.js';
export * from './util/emitter.js';
export * from './util/random.js';

// Domain entities
export * from './domain/place.js';
export * from './domain/user.js';
export * from './domain/vehicle.js';
export * from './domain/driver.js';
export * from './domain/ride.js';
export * from './domain/payment.js';
export * from './domain/card.js';
export * from './domain/events.js';

// Ride lifecycle
export * from './ride/stateMachine.js';
export * from './ride/cancellation.js';
export * from './ride/timeline.js';

// Pricing
export * from './pricing/types.js';
export * from './pricing/rules.js';
export * from './pricing/engine.js';
export * from './pricing/surge.js';

// Matching & dispatch
export * from './matching/types.js';
export * from './matching/scoring.js';
export * from './matching/strategies.js';
export * from './matching/dispatcher.js';

// Promotions
export * from './promos/index.js';

// Support
export * from './support/index.js';

// Catalog & configuration
export * from './catalog/rideTypes.js';
export * from './config/platform.js';

// Test factories — used by the API suite, the seed script, and the simulator.
export * from './testing/factories.js';
