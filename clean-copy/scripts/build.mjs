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

const entryPoints = {
  background: 'src/background/index.ts',
  page: 'src/page/index.ts',
  autoclean: 'src/content/autoclean.ts',
  popup: 'src/popup/popup.ts',
  options: 'src/options/options.ts',
  offscreen: 'src/offscreen/offscreen.ts',
};

// --- Styles ---------------------------------------------------------------------------------

/** Bootstrap 5.3 still uses @import; these warnings come from Bootstrap, not from us. */
function compileScss(file) {
  return sass.compile(join(root, file), {
    loadPaths: [join(root, 'src/styles'), join(root, 'node_modules')],
    style: 'compressed',
    quietDeps: true,
    silenceDeprecations: ['import', 'global-builtin', 'color-functions', 'if-function'],
  }).css.replace(/^\uFEFF/, ''); // compressed output starts with a BOM when it has non-ASCII characters
}

/** Only the Latin, Latin Extended and Cyrillic subsets of the variable fonts are shipped. */
const FONT_PACKAGES = ['@fontsource-variable/manrope', '@fontsource-variable/jetbrains-mono'];
const FONT_SUBSETS = /-(latin|latin-ext|cyrillic)-wght-normal\.woff2$/;

async function buildFonts() {
  const faces = [];
  await mkdir(join(outdir, 'fonts'), { recursive: true });
  for (const name of FONT_PACKAGES) {
    const css = await readFile(join(root, 'node_modules', name, 'index.css'), 'utf8');
    for (const block of css.match(/@font-face\s*{[^}]+}/g) ?? []) {
      const file = /url\(\.\/files\/([^)]+)\)/.exec(block)?.[1];
      if (!file || !FONT_SUBSETS.test(file)) continue;
      await cp(join(root, 'node_modules', name, 'files', file), join(outdir, 'fonts', file));
      faces.push(block.replace(/url\(\.\/files\//, 'url(fonts/').replace(/\s+/g, ' '));
    }
  }
  return faces.join('\n');
}

async function buildStyles() {
  const fonts = await buildFonts();
  await writeFile(join(outdir, 'ui.css'), `@charset "UTF-8";\n${fonts}\n${compileScss('src/styles/ui.scss')}\n`);
}

/** `import css from '*.scss'` in TypeScript: compiled CSS as a string, :root scoped to the shadow host. */
const scssPlugin = {
  name: 'scss-text',
  setup(build) {
    build.onLoad({ filter: /\.scss$/ }, (args) => {
      const css = compileScss(args.path.slice(root.length + 1)).replace(/:root/g, ':host');
      return { contents: css, loader: 'text', watchFiles: [args.path] };
    });
  },
};

/** License texts of the bundled CSS framework, icons and fonts, shipped next to them. */
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

// --- Static files and manifest --------------------------------------------------------------

async function writeManifest() {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(join(root, 'static/manifest.json'), 'utf8'));
  manifest.version = pkg.version;
  if (e2e) {
    // Automation can't click native context menus or accept permission prompts, so activeTab
    // and optional permissions are never granted in tests. The test build gets host access and
    // clipboard reading up front instead (clipboardRead stays listed as optional too, so the
    // popup's request call is exercised and resolves without a prompt). Never shipped.
    manifest.name = 'Clean Copy (e2e)';
    manifest.host_permissions = ['<all_urls>'];
    manifest.permissions = [...manifest.permissions, 'clipboardRead'];
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
  await buildStyles();
  await writeNotices();
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
  plugins: [scssPlugin],
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
