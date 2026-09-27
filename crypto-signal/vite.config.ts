import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

// Builds the unpacked extension.
//   vite build                    production -> dist/
//   vite build --mode e2e         test build -> dist-e2e/ (test hooks, local fixture API)
//   vite build --watch --mode development   dist/ with inline source maps

const root = dirname(fileURLToPath(import.meta.url));

/** The local fixture server e2e/smoke.mjs starts. Only compiled into the e2e build. */
export const E2E_API_ORIGIN = 'http://127.0.0.1:47831';

/** Writes manifest.json with the package version; the e2e build gets test-only changes. */
function manifest(mode: string): Plugin {
  return {
    name: 'crypto-signal:manifest',
    generateBundle() {
      const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { version: string };
      const data = JSON.parse(readFileSync(resolve(root, 'src/manifest.json'), 'utf8')) as Record<string, unknown>;
      data.version = pkg.version;
      if (mode === 'e2e') {
        // Automation can't click the toolbar button, so activeTab is never granted in tests.
        // The test build gets host access instead (fixture pages + fixture API). Never shipped.
        data.name = 'CryptoSignal AI (e2e)';
        data.host_permissions = ['<all_urls>'];
      }
      this.emitFile({ type: 'asset', fileName: 'manifest.json', source: `${JSON.stringify(data, null, 2)}\n` });
    },
  };
}

export default defineConfig(({ mode }) => {
  const e2e = mode === 'e2e';
  const development = mode === 'development';
  return {
    root: resolve(root, 'src'),
    publicDir: resolve(root, 'public'),
    base: './',
    logLevel: 'warn',
    define: {
      __E2E__: JSON.stringify(e2e),
      __E2E_API_ORIGIN__: JSON.stringify(e2e ? E2E_API_ORIGIN : ''),
    },
    css: {
      preprocessorOptions: {
        scss: {
          quietDeps: true,
          silenceDeprecations: ['import', 'global-builtin', 'color-functions', 'if-function'],
        },
      },
    },
    build: {
      outDir: resolve(root, e2e ? 'dist-e2e' : 'dist'),
      emptyOutDir: true,
      target: 'chrome116',
      // Readable output for Chrome Web Store review; dead branches (the e2e hooks) are still dropped.
      minify: false,
      cssMinify: true,
      sourcemap: development ? 'inline' : false,
      modulePreload: false,
      assetsInlineLimit: 0,
      reportCompressedSize: false,
      rolldownOptions: {
        // Sass compilation dominates the build time; the timing report is noise here.
        checks: { bundlerTimings: false },
        input: {
          popup: resolve(root, 'src/popup.html'),
          background: resolve(root, 'src/background/index.ts'),
        },
        output: {
          entryFileNames: '[name].js',
          chunkFileNames: 'chunks/shared.js',
          assetFileNames: 'assets/[name][extname]',
        },
      },
    },
    plugins: [manifest(mode)],
  };
});
