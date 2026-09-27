import { defineConfig } from 'vitest/config';

export default defineConfig({
  define: {
    __E2E__: 'false',
    __E2E_API_ORIGIN__: '""',
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
