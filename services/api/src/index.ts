/**
 * Process entry point.
 *
 * Build the config, build the container, start the background loops, serve
 * HTTP, and shut all of it down cleanly on a signal.
 */

import { loadConfigFromEnv, loadServerConfig } from './config/env.js';
import { createContainer } from './container.js';
import { buildServer } from './server.js';
import { seedDemoData } from './seed.js';

const main = async (): Promise<void> => {
  const serverConfig = loadServerConfig();
  const platformConfig = loadConfigFromEnv();

  const container = await createContainer(platformConfig, serverConfig);
  container.start();

  if (serverConfig.seedOnBoot) {
    const summary = await seedDemoData(container);
    container.logger.info(summary, 'seeded demo data');
  }

  const app = await buildServer(container);

  await app.listen({ host: serverConfig.host, port: serverConfig.port });

  const banner = [
    '',
    `  ${platformConfig.brandName} API`,
    `  ${'─'.repeat(46)}`,
    `  http://${serverConfig.host}:${serverConfig.port}`,
    `  market      ${platformConfig.market.name}`,
    `  store       ${serverConfig.store}`,
    `  geo         ${container.geo.id}`,
    `  surge       ${container.surge.id}`,
    `  dispatch    ${platformConfig.dispatch.strategy}`,
    serverConfig.devAuthCode
      ? `  dev sign-in any phone + code ${serverConfig.devAuthCode}`
      : '',
    '',
  ]
    .filter(Boolean)
    .join('\n');
  console.log(banner);

  // Drain in-flight requests before releasing the store.
  const shutdown = async (signal: string): Promise<void> => {
    container.logger.info({ signal }, 'shutting down');
    try {
      await app.close();
      await container.stop();
      process.exit(0);
    } catch (e) {
      container.logger.error({ err: e }, 'shutdown failed');
      process.exit(1);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
};

main().catch((error) => {
  console.error('Failed to start the API:', error);
  process.exit(1);
});
