import { defineConfig } from 'vitest/config';

// Same compile-time constant as scripts/build.mjs; unit tests run the production code paths.
export default defineConfig({
  define: { __E2E__: 'false' },
});
