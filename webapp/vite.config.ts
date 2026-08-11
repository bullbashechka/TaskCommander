import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { cloudflare } from '@cloudflare/vite-plugin';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const directory = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
    tailwindcss(),
    ...(mode === 'test'
      ? []
      : [
          cloudflare({
            configPath: resolve(directory, '../backend/wrangler.jsonc'),
            auxiliaryWorkers: [
              { configPath: resolve(directory, '../backend/wrangler.consumer.jsonc') },
            ],
            persistState: { path: resolve(directory, '../.wrangler/state/task-commander-local') },
            remoteBindings: false,
          }),
        ]),
  ],
  resolve: {
    alias: {
      '@': resolve(directory, './src'),
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
  },
}));
