/**
 * @lift/sdk — the typed client for the platform API.
 *
 * Shared by the rider app, the driver app, the ops console, and the fleet
 * simulator, so all four speak to the backend through exactly one contract.
 */

export * from './types.js';
export * from './client.js';
export * from './realtime.js';
