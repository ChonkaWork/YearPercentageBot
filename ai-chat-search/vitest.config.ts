import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Same compile-time constant the build defines; unit tests run the production code paths.
  define: { __E2E__: 'false' },
  test: {
    include: ['test/**/*.test.ts'],
    environmentOptions: {
      // Fixture pages are parsed, never loaded: no stylesheet or script fetching.
      happyDOM: {
        settings: {
          disableCSSFileLoading: true,
          disableJavaScriptFileLoading: true,
          disableJavaScriptEvaluation: true,
          handleDisabledFileLoadingAsSuccess: true,
        },
      },
    },
  },
});
