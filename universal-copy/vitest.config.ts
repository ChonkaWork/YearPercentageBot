import { defineConfig } from 'vitest/config';

export default defineConfig({
  define: { __E2E__: 'false' },
  test: {
    include: ['test/**/*.test.ts'],
    // DOM-based tests opt in with a `// @vitest-environment jsdom` comment.
    environment: 'node',
  },
});
