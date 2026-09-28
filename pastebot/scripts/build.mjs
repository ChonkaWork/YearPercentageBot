// Builds the unpacked extension into dist/ (or dist-e2e/ for the test build).
//
//   node scripts/build.mjs          production build -> dist/
//   node scripts/build.mjs --watch  rebuild on change, with inline source maps
//   node scripts/build.mjs --e2e    test build -> dist-e2e/ (adds a test hook and host access)

import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import * as sass from 'sass';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const watch = process.argv.includes('--watch');
const e2e = process.argv.includes('--e2e');
const outdir = join(root, e2e ? 'dist-e2e' : 'dist');

const scriptEntries = [
  { in: 'src/background/index.ts', out: 'background' },
  { in: 'src/content/overlay.ts', out: 'overlay' },
  { in: 'src/popup/popup.ts', out: 'popup' },
  { in: 'src/options/options.ts', out: 'options' },
  { in: 'src/offscreen/offscreen.ts', out: 'offscreen' },
];
const styleEntries = [
  { in: 'src/styles/popup.scss', out: 'styles/popup' },
  { in: 'src/styles/options.scss', out: 'styles/options' },
];

// Bootstrap 5.3 still uses @import; these deprecations are Bootstrap's, not ours.
const SASS_OPTIONS = {
  loadPaths: [join(root, 'node_modules')],
  style: watch ? 'expanded' : 'compressed',
  quietDeps: true,
  silenceDeprecations: ['import', 'global-builtin', 'color-functions', 'if-function'],
};

/**
 * Compiles .scss. Page stylesheets become CSS (esbuild then copies the fonts they reference);
 * `*.shadow.scss` imports become a CSS string for a shadow root, with Bootstrap's `:root`
 * variables moved to `:host`.
 */
const sassPlugin = {
  name: 'sass',
  setup(build) {
    build.onLoad({ filter: /\.scss$/ }, (args) => {
      const result = sass.compile(args.path, SASS_OPTIONS);
      const shadow = args.path.endsWith('.shadow.scss');
      return {
        contents: shadow ? result.css.replace(/:root\b/g, ':host') : result.css,
        loader: shadow ? 'text' : 'css',
        resolveDir: dirname(args.path),
        watchFiles: result.loadedUrls.filter((url) => url.protocol === 'file:').map((url) => fileURLToPath(url)),
      };
    });
  },
};

async function writeManifest() {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(join(root, 'static/manifest.json'), 'utf8'));
  manifest.version = pkg.version;
  if (e2e) {
    // Automation can't click native context menus, so activeTab is never granted in tests.
    // The test build gets host access instead. Never shipped.
    manifest.name = 'Pastebot (e2e)';
    manifest.host_permissions = ['<all_urls>'];
    manifest.permissions = [...manifest.permissions, 'clipboardRead'];
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

const options = {
  absWorkingDir: root,
  entryPoints: scriptEntries,
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
  plugins: [sassPlugin],
  logLevel: 'info',
};

// Stylesheets: minified (Bootstrap is public source, nothing to review there).
const styleOptions = {
  absWorkingDir: root,
  entryPoints: styleEntries,
  outdir,
  bundle: true,
  minify: !watch,
  sourcemap: watch ? 'inline' : false,
  loader: { '.woff2': 'file' },
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
    plugins: [sassPlugin, { name: 'static', setup: (build) => build.onEnd(() => copyStatic()) }],
  });
  const styles = await esbuild.context(styleOptions);
  await Promise.all([context.watch(), styles.watch()]);
  console.log(`Watching… output in ${outdir}`);
} else {
  await Promise.all([esbuild.build(options), esbuild.build(styleOptions)]);
  console.log(`Built ${e2e ? 'e2e' : 'production'} extension in ${outdir}`);
}
