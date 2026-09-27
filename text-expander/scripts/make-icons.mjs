// Renders static/icons/icon.svg to the PNG sizes Chrome needs.
// The PNGs are committed; run this only after changing the SVG:
//
//   CHROMIUM_PATH=/path/to/chrome node scripts/make-icons.mjs
//
// Without CHROMIUM_PATH it uses the Playwright build at /opt/pw-browsers if present.

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const svg = await readFile(join(root, 'static/icons/icon.svg'), 'utf8');
const fallback = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const executablePath = process.env.CHROMIUM_PATH ?? (existsSync(fallback) ? fallback : undefined);
const browser = await chromium.launch({ executablePath });
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
