import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
  test: {
    include: ['test/**/*.test.ts'],
    poolOptions: {
      workers: {
        main: './src/index.ts',
        wrangler: { configPath: './wrangler.test.jsonc' },
      },
    },
  },
});
