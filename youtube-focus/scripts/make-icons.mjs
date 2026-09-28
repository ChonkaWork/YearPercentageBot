// Renders static/icons/icon.svg to the PNG sizes Chrome needs.
// The PNGs are committed; run this only after changing the SVG:
//
//   node scripts/make-icons.mjs        (set CHROMIUM_PATH if Chromium isn't auto-detected)

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const candidates = [process.env.CHROMIUM_PATH, '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/usr/bin/chromium'];
const executablePath = candidates.find((path) => path && existsSync(path));
const svg = await readFile(join(root, 'static/icons/icon.svg'), 'utf8');
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
