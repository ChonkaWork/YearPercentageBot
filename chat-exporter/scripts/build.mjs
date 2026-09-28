// Builds the unpacked extension into dist/ (or dist-e2e/ for the test build).
//
//   node scripts/build.mjs          production build -> dist/
//   node scripts/build.mjs --watch  rebuild on change, with inline source maps
//   node scripts/build.mjs --e2e    test build -> dist-e2e/ (also runs on the fixture pages, see below)
//
// Styles are Bootstrap 5.3 compiled from Sass (see docs/design-system.md at the repo root):
//   - src/styles/<page>.scss entry points become dist/<page>.css; bundled fonts land in dist/fonts/.
//   - .scss imported from TypeScript (the in-page UI) becomes a CSS string for a shadow root, with
//     Bootstrap's :root custom properties moved to :host.
// Bootstrap Icons are imported per file and turned into element descriptors at build time, so no
// UI ever parses markup at runtime (pages with Trusted Types can't break the in-page button).

import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import * as sass from 'sass';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const watch = process.argv.includes('--watch');
const e2e = process.argv.includes('--e2e');
const outdir = join(root, e2e ? 'dist-e2e' : 'dist');

const scripts = [
  { in: 'src/background/index.ts', out: 'background' },
  { in: 'src/content/main.ts', out: 'content' },
  { in: 'src/popup/popup.ts', out: 'popup' },
  { in: 'src/print/print.ts', out: 'print' },
  { in: 'src/options/options.ts', out: 'options' },
];

const styles = [
  { in: 'src/styles/popup.scss', out: 'popup' },
  { in: 'src/styles/print.scss', out: 'print' },
  { in: 'src/styles/options.scss', out: 'options' },
];

// --- Sass ---------------------------------------------------------------------------------

const SASS_OPTIONS = {
  loadPaths: [join(root, 'node_modules')],
  quietDeps: true,
  silenceDeprecations: ['import', 'global-builtin', 'color-functions', 'if-function'],
  style: 'expanded',
};

function compileSass(path) {
  const result = sass.compile(path, SASS_OPTIONS);
  const watchFiles = result.loadedUrls.filter((url) => url.protocol === 'file:').map((url) => fileURLToPath(url));
  return { css: result.css, watchFiles };
}

/**
 * Bootstrap declares its custom properties on :root; inside a shadow root that is :host.
 * rem is relative to the page's root font size, which a chat site may change: use px instead.
 */
function toShadowCss(css) {
  return css.replace(/:root\b/g, ':host').replace(/(-?\d*\.?\d+)rem\b/g, (_, value) => `${Number((Number(value) * 16).toFixed(3))}px`);
}

const sassPlugin = {
  name: 'sass',
  setup(build) {
    build.onResolve({ filter: /\.scss$/ }, (args) => ({
      path: join(args.resolveDir, args.path),
      namespace: args.kind === 'entry-point' ? 'sass-file' : 'sass-inline',
    }));
    build.onLoad({ filter: /.*/, namespace: 'sass-file' }, (args) => {
      const { css, watchFiles } = compileSass(args.path);
      return { contents: css, loader: 'css', resolveDir: dirname(args.path), watchFiles };
    });
    build.onLoad({ filter: /.*/, namespace: 'sass-inline' }, (args) => {
      const { css, watchFiles } = compileSass(args.path);
      return { contents: toShadowCss(css), loader: 'text', watchFiles };
    });
  },
};

// --- Bootstrap Icons ------------------------------------------------------------------------

const SHAPES = /<(path|circle|rect|ellipse|line|polyline|polygon)\b([^>]*?)\/?>/g;

/** `<svg …><path d="…"/></svg>` → `{ viewBox, children: [['path', { d }]] }`. */
function parseIcon(svg, file) {
  if (/<(g|defs|clipPath|mask|use|style|script)\b/.test(svg)) {
    throw new Error(`${file}: only plain shapes are supported, pick another icon`);
  }
  const viewBox = /viewBox="([^"]+)"/.exec(svg)?.[1];
  const children = [];
  for (const [, tag, attributes] of svg.matchAll(SHAPES)) {
    const attrs = {};
    for (const [, name, value] of attributes.matchAll(/([\w:-]+)="([^"]*)"/g)) attrs[name] = value;
    children.push([tag, attrs]);
  }
  if (!viewBox || children.length === 0) throw new Error(`${file}: no drawable shapes found`);
  return { viewBox, children };
}

const iconPlugin = {
  name: 'bootstrap-icons',
  setup(build) {
    build.onLoad({ filter: /bootstrap-icons[\\/]icons[\\/][\w-]+\.svg$/ }, async (args) => {
      const icon = parseIcon(await readFile(args.path, 'utf8'), args.path);
      return { contents: `export default ${JSON.stringify(icon)};`, loader: 'js' };
    });
  },
};

// --- Static files and manifest --------------------------------------------------------------

async function writeManifest() {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(join(root, 'static/manifest.json'), 'utf8'));
  manifest.version = pkg.version;
  if (e2e) {
    // chatgpt.com and claude.ai can't be reached from tests: the e2e test maps both names to a
    // local fixture server (Chromium's --host-resolver-rules) that serves copies of their DOM over
    // plain http. The test build also matches those http origins. Never shipped.
    manifest.name = `${manifest.name} (e2e)`;
    for (const script of manifest.content_scripts) script.matches.push('http://chatgpt.com/*', 'http://claude.ai/*');
  }
  await writeFile(join(outdir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

async function copyStatic() {
  await cp(join(root, 'static'), outdir, {
    recursive: true,
    // The manifest is written separately; the source SVG is only used to render the PNGs.
    filter: (source) => !source.endsWith('manifest.json') && !source.endsWith('.svg'),
  });
  await writeManifest();
}

// --- Build ----------------------------------------------------------------------------------

const common = {
  absWorkingDir: root,
  outdir,
  bundle: true,
  legalComments: 'none',
  logLevel: 'info',
};

const scriptOptions = {
  ...common,
  entryPoints: scripts,
  format: 'iife',
  target: 'chrome116',
  // Drops dead branches (the e2e hooks) but keeps code readable for Web Store review.
  minifySyntax: true,
  sourcemap: watch ? 'inline' : false,
  define: { __E2E__: JSON.stringify(e2e) },
  plugins: [sassPlugin, iconPlugin],
};

const styleOptions = {
  ...common,
  entryPoints: styles,
  target: 'chrome116',
  minify: true,
  loader: { '.woff2': 'file' },
  assetNames: 'fonts/[name]',
  plugins: [sassPlugin],
};

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
await copyStatic();

if (watch) {
  const onEnd = { name: 'static', setup: (build) => build.onEnd(() => copyStatic()) };
  const contexts = await Promise.all([
    esbuild.context({ ...scriptOptions, plugins: [...scriptOptions.plugins, onEnd] }),
    esbuild.context(styleOptions),
  ]);
  await Promise.all(contexts.map((context) => context.watch()));
  console.log(`Watching… output in ${outdir}`);
} else {
  await Promise.all([esbuild.build(scriptOptions), esbuild.build(styleOptions)]);
  console.log(`Built ${e2e ? 'e2e' : 'production'} extension in ${outdir}`);
}
