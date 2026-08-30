/**
 * The fleet simulator.
 *
 * Runs a population of virtual drivers and riders against a real API, over the
 * same SDK the apps use and with no privileged access. It is the fastest way
 * to see the whole platform working, and the honest way to load-test dispatch:
 * if these agents can complete rides, so can real people.
 *
 *   npm run sim
 *   npm run sim -- --drivers 12 --riders 6 --api http://localhost:4000
 */

import {
  ManualClock,
  destination,
  formatMoney,
  seededRandom,
  systemClock,
  type LatLng,
} from '@lift/core';
import { LiftClient } from '@lift/sdk';
import { VirtualDriver } from './virtualDriver.js';
import { VirtualRider } from './virtualRider.js';

interface Options {
  readonly apiUrl: string;
  readonly drivers: number;
  readonly riders: number;
  readonly seed: number;
  readonly spreadMeters: number;
  readonly durationMs: number;
  /** Multiplies driving speed, so a run shows completed trips in minutes. */
  readonly speed: number;
  readonly quiet: boolean;
}

const parseArgs = (argv: readonly string[]): Options => {
  const read = (flag: string, fallback: string): string => {
    const index = argv.indexOf(`--${flag}`);
    return index >= 0 && argv[index + 1] ? argv[index + 1]! : fallback;
  };
  return {
    apiUrl: read('api', process.env.API_URL ?? 'http://localhost:4000'),
    drivers: Number(read('drivers', '8')),
    riders: Number(read('riders', '4')),
    seed: Number(read('seed', '1337')),
    spreadMeters: Number(read('spread', '4000')),
    // 0 means run until interrupted.
    durationMs: Number(read('duration', '0')) * 1000,
    // Real driving speed means a 4-mile trip takes ten minutes. The default
    // runs the fleet fast enough to watch rides complete.
    speed: Number(read('speed', '6')),
    quiet: argv.includes('--quiet'),
  };
};

/** Names are assigned by index so every agent in a run is distinguishable. */
const FIRST_NAMES = [
  'Ada', 'Bo', 'Cleo', 'Dev', 'Esme', 'Finn', 'Gia', 'Hal',
  'Ines', 'Jo', 'Kit', 'Lena', 'Milo', 'Nara', 'Otto', 'Pia',
];

const RIDER_NAMES = [
  'Robin', 'Sasha', 'Tess', 'Uri', 'Vik', 'Wren', 'Xan', 'Yuki',
];

const main = async (): Promise<void> => {
  const options = parseArgs(process.argv.slice(2));
  const random = seededRandom(options.seed);
  const log = options.quiet ? () => {} : (message: string) => console.log(`  ${message}`);

  const probe = new LiftClient({ baseUrl: options.apiUrl });
  const [health, config] = await Promise.all([probe.health(), probe.config()]).catch(
    (e: unknown) => {
      console.error(`\nCould not reach the API at ${options.apiUrl}.`);
      console.error('Start it with `npm run api`, then run the simulator again.\n');
      throw e;
    },
  );

  const center: LatLng = config.market.defaultCenter;

  console.log('');
  console.log(`  ${config.brandName} — fleet simulator`);
  console.log(`  ${'─'.repeat(46)}`);
  console.log(`  api        ${options.apiUrl}`);
  console.log(`  market     ${health.market}`);
  console.log(`  geo        ${health.geoProvider}`);
  console.log(`  dispatch   ${health.dispatchStrategy}`);
  console.log(`  fleet      ${options.drivers} drivers · ${options.riders} riders`);
  console.log(`  seed       ${options.seed}`);
  console.log(`  speed      ${options.speed}× real time`);
  console.log('');

  const drivers: VirtualDriver[] = [];
  const riders: VirtualRider[] = [];

  // Phones are derived from the seed so a rerun reuses the same accounts
  // rather than filling the store with new ones.
  for (let i = 0; i < options.drivers; i++) {
    const spot = destination(center, random.float(0, 360), random.float(200, options.spreadMeters));
    drivers.push(
      new VirtualDriver({
        apiUrl: options.apiUrl,
        phone: `+1415${String(9000000 + options.seed * 100 + i).slice(-7)}`,
        name: { first: FIRST_NAMES[i % FIRST_NAMES.length]!, last: `Driver${i + 1}` },
        start: spot,
        random: seededRandom(options.seed + i * 31),
        speedMps: random.float(8, 14) * options.speed,
        declineRate: random.float(0.05, 0.25),
        log,
      }),
    );
  }

  for (let i = 0; i < options.riders; i++) {
    riders.push(
      new VirtualRider({
        apiUrl: options.apiUrl,
        phone: `+1415${String(8000000 + options.seed * 100 + i).slice(-7)}`,
        name: { first: RIDER_NAMES[i % RIDER_NAMES.length]!, last: `Rider${i + 1}` },
        near: center,
        random: seededRandom(options.seed + 1000 + i * 17),
        cancelRate: 0.06,
        log,
      }),
    );
  }

  // Drivers go online first so there is supply when the first request lands.
  console.log('  starting drivers…');
  const driverResults = await Promise.allSettled(drivers.map((d) => d.start()));
  const onlineDrivers = driverResults.filter((r) => r.status === 'fulfilled').length;
  for (const result of driverResults) {
    if (result.status === 'rejected') console.error(`  driver failed: ${String(result.reason)}`);
  }
  console.log(`  ${onlineDrivers}/${drivers.length} drivers online`);

  if (onlineDrivers === 0) {
    console.error('\n  No drivers could go online. Are new drivers auto-approved?\n');
    process.exit(1);
  }

  console.log('  starting riders…\n');
  await Promise.allSettled(riders.map((r) => r.start()));

  const summarize = (): void => {
    const driverTotals = drivers.reduce(
      (acc, d) => ({
        offers: acc.offers + d.stats.offers,
        accepted: acc.accepted + d.stats.accepted,
        declined: acc.declined + d.stats.declined,
        completed: acc.completed + d.stats.completed,
        earnings: acc.earnings + d.stats.earnings,
      }),
      { offers: 0, accepted: 0, declined: 0, completed: 0, earnings: 0 },
    );
    const riderTotals = riders.reduce(
      (acc, r) => ({
        requested: acc.requested + r.stats.requested,
        completed: acc.completed + r.stats.completed,
        cancelled: acc.cancelled + r.stats.cancelled,
        expired: acc.expired + r.stats.expired,
        spent: acc.spent + r.stats.spent,
      }),
      { requested: 0, completed: 0, cancelled: 0, expired: 0, spent: 0 },
    );

    console.log('');
    console.log(`  ${'─'.repeat(46)}`);
    console.log(`  rides requested   ${riderTotals.requested}`);
    console.log(`  rides completed   ${riderTotals.completed}`);
    console.log(`  cancelled         ${riderTotals.cancelled}`);
    console.log(`  no driver found   ${riderTotals.expired}`);
    console.log(`  offers sent       ${driverTotals.offers}`);
    console.log(
      `  offer acceptance  ${
        driverTotals.offers > 0
          ? `${Math.round((driverTotals.accepted / driverTotals.offers) * 100)}%`
          : '—'
      }`,
    );
    console.log(`  rider spend       ${formatMoney({ amount: riderTotals.spent, currency: 'USD' })}`);
    console.log(
      `  driver earnings   ${formatMoney({ amount: driverTotals.earnings, currency: 'USD' })}`,
    );
    console.log('');
  };

  // Periodic progress, so a long run is not silent.
  const reporter = setInterval(summarize, 30_000);
  reporter.unref?.();

  const shutdown = async (): Promise<void> => {
    clearInterval(reporter);
    console.log('\n  stopping…');
    for (const rider of riders) rider.stop();
    await Promise.allSettled(drivers.map((d) => d.stop()));
    summarize();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  if (options.durationMs > 0) {
    setTimeout(() => void shutdown(), options.durationMs);
  }
};

main().catch((error) => {
  console.error('Simulator failed:', error);
  process.exit(1);
});

export { VirtualDriver, VirtualRider, ManualClock, systemClock };
