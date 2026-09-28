// Builds the unpacked extension into dist/ (or dist-e2e/ for the test build).
//
//   node scripts/build.mjs          production build -> dist/
//   node scripts/build.mjs --watch  rebuild on change, with inline source maps
//   node scripts/build.mjs --e2e    test build -> dist-e2e/ (same code, "(e2e)" name)

import { watch as watchFiles } from 'node:fs';
import { copyFile, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import * as sass from 'sass';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const watch = process.argv.includes('--watch');
const e2e = process.argv.includes('--e2e');
const outdir = join(root, e2e ? 'dist-e2e' : 'dist');

/** Font files shipped with the page: two variable fonts, three subsets each. */
const FONTS = ['manrope', 'jetbrains-mono'].flatMap((font) =>
  ['latin', 'latin-ext', 'cyrillic'].map((subset) => ({
    from: `node_modules/@fontsource-variable/${font}/files/${font}-${subset}-wght-normal.woff2`,
    to: `fonts/${font}-${subset}-wght-normal.woff2`,
  })),
);

async function writeManifest() {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(join(root, 'static/manifest.json'), 'utf8'));
  manifest.version = pkg.version;
  if (e2e) manifest.name = `${manifest.name} (e2e)`;
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
  await mkdir(join(outdir, 'fonts'), { recursive: true });
  for (const font of FONTS) await copyFile(join(root, font.from), join(outdir, font.to));
  await writeManifest();
  await writeNotices();
}

async function compileStyles() {
  const result = sass.compile(join(root, 'src/styles/newtab.scss'), {
    loadPaths: [join(root, 'node_modules')],
    style: watch ? 'expanded' : 'compressed',
    // Bootstrap 5.3 still uses @import and global functions.
    quietDeps: true,
    silenceDeprecations: ['import', 'global-builtin', 'color-functions', 'if-function'],
  });
  await writeFile(join(outdir, 'newtab.css'), result.css);
}

const options = {
  absWorkingDir: root,
  entryPoints: { newtab: 'src/newtab/main.ts' },
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
  logLevel: 'info',
};

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
await copyStatic();
await compileStyles();

if (watch) {
  const context = await esbuild.context(options);
  await context.watch();
  const rebuild = (what, task) => async () => {
    try {
      await task();
      console.log(`Rebuilt ${what}`);
    } catch (error) {
      console.error(`${what} failed:`, error.message ?? error);
    }
  };
  watchFiles(join(root, 'src/styles'), { recursive: true }, rebuild('styles', compileStyles));
  watchFiles(join(root, 'static'), { recursive: true }, rebuild('static files', copyStatic));
  console.log(`Watching… output in ${outdir}`);
} else {
  await esbuild.build(options);
  console.log(`Built ${e2e ? 'e2e' : 'production'} extension in ${outdir}`);
}
