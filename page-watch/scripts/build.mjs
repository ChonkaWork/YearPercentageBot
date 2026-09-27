// Builds the unpacked extension into dist/ (or dist-e2e/ for the test build).
//
//   node scripts/build.mjs          production build -> dist/
//   node scripts/build.mjs --watch  rebuild on change, with inline source maps
//   node scripts/build.mjs --e2e    test build -> dist-e2e/ (adds a test hook and access to 127.0.0.1)

import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import * as sass from 'sass';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const watch = process.argv.includes('--watch');
const e2e = process.argv.includes('--e2e');
const outdir = join(root, e2e ? 'dist-e2e' : 'dist');

const entryPoints = {
  background: 'src/background/index.ts',
  picker: 'src/content/picker.ts',
  popup: 'src/popup/popup.ts',
  options: 'src/options/options.ts',
  offscreen: 'src/offscreen/offscreen.ts',
};

/** Extension-page stylesheets: Bootstrap subset + theme, compiled from Sass. */
const pageStyles = { 'popup.css': 'src/styles/popup.scss', 'options.css': 'src/styles/options.scss' };

// Only these font subsets are shipped.
const FONT_SUBSETS = ['latin', 'latin-ext', 'cyrillic'];
const FONTS = [
  ['@fontsource-variable/manrope', 'manrope'],
  ['@fontsource-variable/jetbrains-mono', 'jetbrains-mono'],
];

function compileScss(file) {
  return sass.compile(join(root, file), {
    loadPaths: [join(root, 'node_modules'), join(root, 'src/styles')],
    style: 'compressed',
    // Bootstrap 5.3 still uses @import and global functions.
    quietDeps: true,
    silenceDeprecations: ['import', 'global-builtin', 'color-functions', 'if-function'],
  }).css;
}

/**
 * The picker lives in a shadow root inside arbitrary pages: Bootstrap's variables move from
 * :root to :host, and rem becomes px so a page's own root font size can't rescale the UI.
 */
function compileShadowScss(file) {
  return compileScss(file)
    .replaceAll(':root', ':host')
    .replace(/(-?\d*\.?\d+)rem\b/g, (_, value) => `${Number((Number(value) * 16).toFixed(3))}px`);
}

const pickerCss = {
  name: 'picker-css',
  setup(build) {
    build.onResolve({ filter: /^virtual:picker-css$/ }, () => ({ path: 'picker-css', namespace: 'virtual' }));
    build.onLoad({ filter: /.*/, namespace: 'virtual' }, () => ({
      contents: compileShadowScss('src/styles/picker.scss'),
      loader: 'text',
      watchDirs: [join(root, 'src/styles')],
    }));
  },
};

async function writeManifest() {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(join(root, 'static/manifest.json'), 'utf8'));
  manifest.version = pkg.version;
  if (e2e) {
    // Permission prompts can't be clicked from automation, so the test build is granted the
    // local test server up front. Production only has optional, per-site host access.
    manifest.name = 'Page Watch (e2e)';
    manifest.host_permissions = ['http://127.0.0.1/*'];
  }
  await writeFile(join(outdir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

async function copyStatic() {
  await cp(join(root, 'static'), outdir, {
    recursive: true,
    // The manifest is written separately; the source SVG is only used to render the PNGs.
    filter: (source) => !source.endsWith('manifest.json') && !source.endsWith('.svg'),
  });
  await mkdir(join(outdir, 'fonts'), { recursive: true });
  for (const [pkg, name] of FONTS) {
    for (const subset of FONT_SUBSETS) {
      const file = `${name}-${subset}-wght-normal.woff2`;
      await cp(join(root, 'node_modules', pkg, 'files', file), join(outdir, 'fonts', file));
    }
  }
  for (const [out, source] of Object.entries(pageStyles)) await writeFile(join(outdir, out), compileScss(source));
  await writeManifest();
}

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
  loader: { '.svg': 'text' },
  plugins: [pickerCss],
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
