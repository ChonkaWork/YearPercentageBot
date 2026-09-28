// Builds the unpacked extension into dist/ (or dist-e2e/ for the test build).
//
//   node scripts/build.mjs          production build -> dist/
//   node scripts/build.mjs --watch  rebuild on change, with inline source maps
//   node scripts/build.mjs --e2e    test build -> dist-e2e/ (adds a test hook and host access)

import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import * as sass from 'sass';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const watch = process.argv.includes('--watch');
const e2e = process.argv.includes('--e2e');
const outdir = join(root, e2e ? 'dist-e2e' : 'dist');

const entryPoints = [
  { in: 'src/background/index.ts', out: 'background' },
  { in: 'src/content/index.ts', out: 'content' },
  { in: 'src/popup/popup.ts', out: 'popup' },
  { in: 'src/options/options.ts', out: 'options' },
  { in: 'src/styles/popup.scss', out: 'popup' },
  { in: 'src/styles/options.scss', out: 'options' },
];

async function writeManifest() {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(join(root, 'static/manifest.json'), 'utf8'));
  manifest.version = pkg.version;
  if (e2e) {
    // Automation can't click the toolbar button, so activeTab is never granted in tests. The
    // test build gets host access instead, which exposes tab.url exactly like an activeTab
    // grant does. It can't accept Chrome's permission prompt either, so the optional
    // clipboardRead permission is granted up front. Never shipped.
    manifest.name = 'Snippets (e2e)';
    manifest.host_permissions = ['<all_urls>'];
    manifest.permissions = [...manifest.permissions, ...(manifest.optional_permissions ?? [])];
    delete manifest.optional_permissions;
  }
  await writeFile(join(outdir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

// Bundled third-party code and fonts keep their license text next to them (esbuild strips the
// banners with `legalComments: 'none'`).
const NOTICE_PACKAGES = [
  ['Bootstrap', 'bootstrap'],
  ['Bootstrap Icons', 'bootstrap-icons'],
  ['Manrope', '@fontsource-variable/manrope'],
  ['JetBrains Mono', '@fontsource-variable/jetbrains-mono'],
];

async function writeNotices() {
  const sections = [];
  for (const [title, name] of NOTICE_PACKAGES) {
    const { version } = JSON.parse(await readFile(join(root, 'node_modules', name, 'package.json'), 'utf8'));
    const license = await readFile(join(root, 'node_modules', name, 'LICENSE'), 'utf8');
    sections.push(`${title} ${version} (${name})\n${'='.repeat(60)}\n\n${license.trim()}\n`);
  }
  await writeFile(join(outdir, 'THIRD_PARTY_NOTICES.txt'), `${sections.join('\n\n')}`);
}

async function copyStatic() {
  await cp(join(root, 'static'), outdir, {
    recursive: true,
    // The manifest is written separately; the source SVG is only used to render the PNGs.
    filter: (source) => !source.endsWith('manifest.json') && !source.endsWith('.svg'),
  });
  await writeManifest();
  await writeNotices();
}

// Bootstrap 5.3 still uses @import and old color functions; Dart Sass warns about both.
const sassOptions = {
  loadPaths: [join(root, 'node_modules')],
  quietDeps: true,
  silenceDeprecations: ['import', 'global-builtin', 'color-functions', 'if-function'],
};

function compileSass(path, style) {
  const result = sass.compile(path, { ...sassOptions, style });
  return { css: result.css, watchFiles: result.loadedUrls.filter((url) => url.protocol === 'file:').map(fileURLToPath) };
}

/**
 * .scss entry points compile to CSS files (fonts referenced with url() are copied to fonts/).
 * `import css from './x.scss?inline'` compiles to a string for a shadow root: Bootstrap puts its
 * custom properties on :root, which doesn't exist inside a shadow tree, so it becomes :host,
 * and rem sizes become px so the page's root font size can't shrink or grow the UI.
 */
const sassPlugin = {
  name: 'sass',
  setup(build) {
    build.onResolve({ filter: /\.scss\?inline$/ }, (args) => ({
      path: resolve(args.resolveDir, args.path.replace(/\?inline$/, '')),
      namespace: 'scss-inline',
    }));
    build.onLoad({ filter: /.*/, namespace: 'scss-inline' }, (args) => {
      const { css, watchFiles } = compileSass(args.path, 'compressed');
      // In a page, rem follows the page's root font size (62.5% on some sites), so in-page UI
      // is sized in px instead (1rem = 16px, the browser default).
      const px = css.replace(/(\d*\.?\d+)rem\b/g, (_, value) => `${+(Number(value) * 16).toFixed(3)}px`);
      return { contents: px.replaceAll(':root', ':host'), loader: 'text', watchFiles };
    });
    build.onLoad({ filter: /\.scss$/ }, (args) => {
      const { css, watchFiles } = compileSass(args.path, 'expanded');
      return { contents: css, loader: 'css', resolveDir: dirname(args.path), watchFiles };
    });
  },
};

const options = {
  absWorkingDir: root,
  entryPoints,
  outdir,
  bundle: true,
  format: 'iife',
  target: 'chrome116',
  // Drops dead branches (the e2e hook) but keeps code readable for Web Store review.
  minifySyntax: true,
  legalComments: 'none',
  sourcemap: watch ? 'inline' : false,
  define: { __E2E__: JSON.stringify(e2e) },
  loader: { '.svg': 'text', '.woff2': 'file' },
  assetNames: 'fonts/[name]',
  plugins: [sassPlugin],
  logLevel: 'info',
};

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
await copyStatic();

if (watch) {
  const context = await esbuild.context({
    ...options,
    plugins: [...options.plugins, { name: 'static', setup: (build) => build.onEnd(() => copyStatic()) }],
  });
  await context.watch();
  console.log(`Watching… output in ${outdir}`);
} else {
  await esbuild.build(options);
  console.log(`Built ${e2e ? 'e2e' : 'production'} extension in ${outdir}`);
}

