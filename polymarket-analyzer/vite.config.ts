// Builds the unpacked extension.
//
//   vite build              production build -> dist/
//   vite build --mode e2e   test build -> dist-e2e/ (test hook, APIs pointed at a local fixture server)
//
// Entries: the popup (HTML page, bundles its own CSS and fonts) and the background service
// worker (an ES module worker, see manifest "type": "module"). There are no content scripts:
// the popup reads the active tab's URL through activeTab and, only as a fallback, runs one
// small injected function (chrome.scripting) to read the page's canonical link.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

const root = import.meta.dirname;

/** The only two origins the production extension talks to. */
const PRODUCTION_API = {
  gammaBase: 'https://gamma-api.polymarket.com',
  clobBase: 'https://clob.polymarket.com',
};

/** Port of the e2e fixture server (e2e/smoke.mjs reads it back from dist-e2e/e2e.json). */
const E2E_API_PORT = Number(process.env.E2E_API_PORT ?? 47931);

export default defineConfig(({ mode }) => {
  const e2e = mode === 'e2e';
  const api = e2e
    ? { gammaBase: `http://127.0.0.1:${E2E_API_PORT}/gamma`, clobBase: `http://127.0.0.1:${E2E_API_PORT}/clob` }
    : PRODUCTION_API;

  return {
    root: resolve(root, 'src'),
    publicDir: resolve(root, 'public'),
    base: './',
    define: {
      __E2E__: JSON.stringify(e2e),
      __GAMMA_BASE__: JSON.stringify(api.gammaBase),
      __CLOB_BASE__: JSON.stringify(api.clobBase),
    },
    css: {
      preprocessorOptions: {
        scss: {
          // Bootstrap 5.3 still uses @import and global functions; the deprecations are Bootstrap's.
          quietDeps: true,
          silenceDeprecations: ['import', 'global-builtin', 'color-functions', 'if-function'],
        },
      },
    },
    build: {
      outDir: resolve(root, e2e ? 'dist-e2e' : 'dist'),
      emptyOutDir: true,
      target: 'chrome120',
      // Source maps only in the local watch build (npm run dev), never in dist for the store.
      sourcemap: mode === 'development' ? 'inline' : false,
      // Unminified so Chrome Web Store review can read the code; dead branches (the e2e hook)
      // are still removed by tree-shaking because __E2E__ is a compile-time constant.
      minify: false,
      cssMinify: true,
      reportCompressedSize: false,
      // Fonts stay separate files (no data: URIs in CSS).
      assetsInlineLimit: 0,
      // The polyfill is only needed for browsers without <link rel=modulepreload>; Chrome has it.
      modulePreload: { polyfill: false },
      rolldownOptions: {
        // The Sass compile of Bootstrap dominates build time; that's expected, not worth a warning.
        checks: { bundlerTimings: false },
        input: {
          popup: resolve(root, 'src/popup.html'),
          background: resolve(root, 'src/background/index.ts'),
        },
        output: {
          entryFileNames: (chunk) => (chunk.name === 'background' ? 'background.js' : 'assets/[name].js'),
          chunkFileNames: 'assets/[name].js',
          assetFileNames: 'assets/[name][extname]',
        },
      },
    },
    plugins: [manifest(e2e, api)],
  };
});

/** Writes manifest.json from src/manifest.json with the package version and the API origins. */
function manifest(e2e: boolean, api: typeof PRODUCTION_API): Plugin {
  return {
    name: 'extension-manifest',
    generateBundle() {
      const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { version: string };
      const template = JSON.parse(readFileSync(resolve(root, 'src/manifest.json'), 'utf8')) as Record<string, unknown>;
      const hostPermissions = [`${new URL(PRODUCTION_API.gammaBase).origin}/*`, `${new URL(PRODUCTION_API.clobBase).origin}/*`];
      if (JSON.stringify(template.host_permissions) !== JSON.stringify(hostPermissions)) {
        this.error(`src/manifest.json host_permissions must be exactly ${JSON.stringify(hostPermissions)}`);
      }
      const output: Record<string, unknown> = { ...template, version: pkg.version };
      if (e2e) {
        // Test build only, never shipped: automation can't click the toolbar button, so activeTab
        // is never granted. Grant the fixture pages (polymarket.com is routed to local fixtures by
        // Playwright) and the local API server instead.
        output.name = `${String(template.name)} (e2e)`;
        output.host_permissions = [...hostPermissions, 'http://127.0.0.1/*', 'https://polymarket.com/*'];
        this.emitFile({
          type: 'asset',
          fileName: 'e2e.json',
          source: `${JSON.stringify({ port: E2E_API_PORT, ...api }, null, 2)}\n`,
        });
      }
      this.emitFile({ type: 'asset', fileName: 'manifest.json', source: `${JSON.stringify(output, null, 2)}\n` });
    },
  };
}
