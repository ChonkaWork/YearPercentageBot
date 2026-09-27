import { defineConfig } from 'vitest/config';

export default defineConfig({
  define: {
    __E2E__: 'false',
    __GAMMA_BASE__: JSON.stringify('https://gamma-api.polymarket.com'),
    __CLOB_BASE__: JSON.stringify('https://clob.polymarket.com'),
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
