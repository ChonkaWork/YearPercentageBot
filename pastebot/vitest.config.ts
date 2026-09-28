import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Same constant the build replaces; unit tests exercise the production code paths.
  define: { __E2E__: 'false' },
});
