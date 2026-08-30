import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

/**
 * The console imports the workspace packages from source, so a change in the
 * domain or the SDK shows up here without a build step in between.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@lift/core': fileURLToPath(new URL('../../packages/core/src/index.ts', import.meta.url)),
      '@lift/sdk': fileURLToPath(new URL('../../packages/sdk/src/index.ts', import.meta.url)),
    },
  },
  server: { port: 5173, host: true },
});
