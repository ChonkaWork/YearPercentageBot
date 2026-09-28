import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Replaced at build time by esbuild; unit tests run the production branch.
  define: { __E2E__: 'false' },
});
