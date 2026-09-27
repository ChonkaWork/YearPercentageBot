// Builds the unpacked extension into dist/ (or dist-e2e/ for the test build).
//
//   node scripts/build.mjs          production build -> dist/
//   node scripts/build.mjs --watch  rebuild on change, with inline source maps
//   node scripts/build.mjs --e2e    test build -> dist-e2e/ (open shadow roots, popup ?tab=, fixed id)

import { createHash, generateKeyPairSync } from 'node:crypto';
import { watch as watchFs } from 'node:fs';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import * as sass from 'sass';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const watch = process.argv.includes('--watch');
const e2e = process.argv.includes('--e2e');
const outdir = join(root, e2e ? 'dist-e2e' : 'dist');
const nodeModules = join(root, 'node_modules');

const entryPoints = {
  content: 'src/content/index.ts',
  popup: 'src/popup/popup.ts',
  options: 'src/options/options.ts',
};

const FONT_FILES = ['manrope', 'jetbrains-mono'].flatMap((family) =>
  ['latin', 'latin-ext', 'cyrillic'].map((subset) => ({
    from: join(nodeModules, `@fontsource-variable/${family}/files/${family}-${subset}-wght-normal.woff2`),
    to: `fonts/${family}-${subset}-wght-normal.woff2`,
  })),
);

// Bootstrap still uses @import and global functions; these are its deprecations, not ours.
const sassOptions = {
  loadPaths: [nodeModules, join(root, 'src/styles')],
  quietDeps: true,
  silenceDeprecations: ['import', 'global-builtin', 'color-functions', 'if-function'],
  style: 'compressed',
};

function compileSass(file) {
  return sass.compile(join(root, file), sassOptions);
}

/**
 * In-page CSS lives in a shadow root: Bootstrap's :root variables must be on :host, and rem
 * must become px because rem follows the page's own root font size.
 */
function toShadowCss(css) {
  return css.replace(/:root/g, ':host').replace(/(-?\d*\.?\d+)rem\b/g, (_, value) => `${+(Number(value) * 16).toFixed(3)}px`);
}

/** `import css from './x.scss'` → compiled, shadow-ready CSS as a string. */
const sassTextPlugin = {
  name: 'sass-text',
  setup(build) {
    build.onLoad({ filter: /\.scss$/ }, (args) => {
      const result = sass.compile(args.path, sassOptions);
      return {
        contents: toShadowCss(result.css),
        loader: 'text',
        watchFiles: result.loadedUrls.filter((url) => url.protocol === 'file:').map((url) => fileURLToPath(url)),
      };
    });
  },
};

/** A fixed public key gives the test build a known extension id (no service worker to ask). */
function e2eKey() {
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const der = publicKey.export({ type: 'spki', format: 'der' });
  const id = [...createHash('sha256').update(der).digest('hex').slice(0, 32)]
    .map((char) => String.fromCharCode(97 + parseInt(char, 16)))
    .join('');
  return { key: der.toString('base64'), id };
}

async function writeManifest() {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(join(root, 'static/manifest.json'), 'utf8'));
  manifest.version = pkg.version;
  if (e2e) {
    const { key, id } = e2eKey();
    manifest.name = 'Video Speed+ (e2e)';
    manifest.key = key;
    await writeFile(join(outdir, 'e2e-extension-id.txt'), `${id}\n`);
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
  for (const font of FONT_FILES) await cp(font.from, join(outdir, font.to));
  await writeFile(join(outdir, 'ui.css'), compileSass('src/styles/ui.scss').css);
  await writeManifest();
}

const options = {
  absWorkingDir: root,
  entryPoints,
  outdir,
  bundle: true,
  format: 'iife',
  target: 'chrome116',
  // Drops dead branches (the e2e hooks) but keeps code readable for Web Store review.
  minifySyntax: true,
  legalComments: 'none',
  sourcemap: watch ? 'inline' : false,
  define: { __E2E__: JSON.stringify(e2e) },
  loader: { '.svg': 'text' },
  plugins: [sassTextPlugin],
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
  // Page styles and static files aren't part of the esbuild graph: copy them again on change.
  let pending = null;
  for (const dir of ['static', 'src/styles']) {
    watchFs(join(root, dir), { recursive: true }, () => {
      clearTimeout(pending);
      pending = setTimeout(() => copyStatic().catch((error) => console.error(error.message)), 100);
    });
  }
  console.log(`Watching… output in ${outdir}`);
} else {
  await esbuild.build(options);
  console.log(`Built ${e2e ? 'e2e' : 'production'} extension in ${outdir}`);
}
