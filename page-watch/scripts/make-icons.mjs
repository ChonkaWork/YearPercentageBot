// Renders static/icons/icon.svg to the PNG sizes Chrome needs.
// The PNGs are committed; run this only after changing the SVG:
//
//   CHROMIUM_PATH=/path/to/chrome node scripts/make-icons.mjs

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const svg = await readFile(join(root, 'static/icons/icon.svg'), 'utf8');
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
const page = await browser.newPage();

for (const size of [16, 32, 48, 128]) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<html><body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`,
  );
  await page.screenshot({ path: join(root, `static/icons/icon${size}.png`), omitBackground: true });
  console.log(`icon${size}.png`);
}

await browser.close();
