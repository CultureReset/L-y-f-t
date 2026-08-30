import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'packages/*/src/**/*.test.ts',
      'services/*/src/**/*.test.ts',
      'tools/*/src/**/*.test.ts',
    ],
    environment: 'node',
    testTimeout: 20000,
  },
  resolve: {
    alias: {
      '@lift/core': new URL('./packages/core/src/index.ts', import.meta.url).pathname,
      '@lift/geo': new URL('./packages/geo/src/index.ts', import.meta.url).pathname,
      '@lift/sdk': new URL('./packages/sdk/src/index.ts', import.meta.url).pathname,
    },
  },
});
