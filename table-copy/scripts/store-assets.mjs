// Renders the Chrome Web Store graphics from the real UI screenshots in screenshots/:
//
//   node scripts/store-assets.mjs        (set CHROMIUM_PATH if Chrome/Chromium isn't found)
//
// What goes on each image (captions, which screenshot, crop) lives in store/assets.json; the
// name and icon come from static/manifest.json and static/icons/icon.svg, so a rename is one
// edit plus a re-run. Output in store/assets/ (committed, uploaded as is):
//
//   screenshot-N.png         1280×800, up to 5 (store limit)
//   promo-small-440x280.png  small promo tile (shown in search and category pages)
//   marquee-1400x560.png     marquee tile (only used if the store features the extension)
//
// The screenshots inside are never edited: they are the e2e test's captures of the real UI.

import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'store/assets');

const config = JSON.parse(await readFile(join(root, 'store/assets.json'), 'utf8'));
const manifest = JSON.parse(await readFile(join(root, 'static/manifest.json'), 'utf8'));
const name = config.name ?? manifest.name;
const icon = await readFile(join(root, 'static/icons/icon.svg'), 'utf8');
if (!config.slides?.length || config.slides.length > 5) throw new Error('store/assets.json needs 1-5 slides');

function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const candidates = [
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  ];
  const found = candidates.find((path) => existsSync(path));
  if (!found) throw new Error('Chrome/Chromium not found. Set CHROMIUM_PATH.');
  return found;
}

// --- Inputs -----------------------------------------------------------------------------------

async function dataUri(path, type) {
  return `data:${type};base64,${(await readFile(path)).toString('base64')}`;
}

async function pngSize(path) {
  const png = await readFile(join(root, path));
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

const fontDir = join(root, 'node_modules/@fontsource-variable/manrope/files');
const fonts = await Promise.all(
  ['latin', 'latin-ext'].map(async (subset) => {
    const src = await dataUri(join(fontDir, `manrope-${subset}-wght-normal.woff2`), 'font/woff2');
    return `@font-face{font-family:Manrope;font-weight:200 800;font-display:block;src:url(${src}) format('woff2')}`;
  }),
);

const escape = (text) =>
  String(text).replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]);

// --- Styles -----------------------------------------------------------------------------------

const brand = config.brand;
const tile = config.tileColor ?? brand;
const light = { bg: config.background ?? '#f6f7f9', ink: '#16181d', muted: '#4b5260', frame: '#ffffff' };
const dark = { bg: config.darkBackground ?? '#111317', ink: '#f3f4f6', muted: '#b4bac5', frame: '#1b1e24' };

const css = `
${fonts.join('\n')}
*{box-sizing:border-box;margin:0}
html,body{width:100%;height:100%;overflow:hidden}
body{font-family:Manrope,system-ui,sans-serif;-webkit-font-smoothing:antialiased;position:relative}
.brand{display:flex;align-items:center;gap:12px;font-weight:800;font-size:20px;letter-spacing:-.01em}
.brand svg{width:40px;height:40px;flex:none}
.title{font-weight:800;letter-spacing:-.025em;line-height:1.08;text-wrap:balance}
.text{line-height:1.5;text-wrap:pretty}
.pro{display:inline-flex;align-items:center;gap:8px;font-size:14px;font-weight:700;letter-spacing:.04em}
.pro b{background:${brand};color:#fff;border-radius:6px;padding:3px 8px;font-size:12px;letter-spacing:.06em}
.shot{position:absolute;overflow:hidden;border-radius:14px;box-shadow:0 0 0 1px rgba(0,0,0,.08),0 28px 60px -24px rgba(0,0,0,.35)}
.dark .shot{box-shadow:0 0 0 1px rgba(255,255,255,.1),0 28px 60px -24px rgba(0,0,0,.8)}
.shot img{display:block}
.shot.cut{-webkit-mask-image:linear-gradient(#000 calc(100% - 56px),transparent)}
.bar{height:34px;display:flex;align-items:center;gap:7px;padding:0 14px;background:#e9ebef}
.dark .bar{background:#2a2e36}
.bar i{width:11px;height:11px;border-radius:50%;background:#c3c8d0}
.dark .bar i{background:#4a505b}
`;

/**
 * Places screenshots in a box: scaled to fit (never above `maxScale`), optionally cropped to the
 * source rectangle `crop` ({ left, top, width, height }, in screenshot pixels; a bottom crop fades
 * out unless `fade: false`). Returns HTML for absolutely positioned frames.
 */
async function shots(slide, box, { window = false, bleed = false } = {}) {
  const images = slide.images ?? [slide.image];
  const gap = 28;
  const bar = window ? 34 : 0;
  const sizes = await Promise.all(images.map((path) => pngSize(path)));
  const crop = slide.crop ?? {};
  const visible = sizes.map((size) => ({
    width: Math.min(size.width - (crop.left ?? 0), crop.width ?? Infinity),
    height: Math.min(size.height - (crop.top ?? 0), crop.height ?? Infinity),
  }));
  const totalWidth = visible.reduce((sum, size) => sum + size.width, 0);
  const tallest = Math.max(...visible.map((size) => size.height));
  let scale = Math.min(
    (box.width - gap * (images.length - 1)) / totalWidth,
    bleed ? Infinity : (box.height - bar) / tallest,
    slide.maxScale ?? 1.25,
  );
  if (slide.scale) scale = slide.scale;
  const width = totalWidth * scale + gap * (images.length - 1);
  let x = box.x + (box.width - width) / 2;
  const parts = [];
  for (const [index, path] of images.entries()) {
    const w = Math.round(visible[index].width * scale);
    const h = Math.round(visible[index].height * scale) + bar;
    const y = bleed ? box.y : box.y + (box.height - h) / 2;
    const cut = crop.height !== undefined && crop.fade !== false;
    const src = await dataUri(join(root, path), 'image/png');
    parts.push(
      `<div class="shot${cut ? ' cut' : ''}" style="left:${Math.round(x)}px;top:${Math.round(y)}px;width:${w}px;height:${h}px">` +
        (window ? '<div class="bar"><i></i><i></i><i></i></div>' : '') +
        `<div style="height:${h - bar}px;overflow:hidden"><img src="${src}" style="width:${Math.round(sizes[index].width * scale)}px;max-width:none;margin:${-Math.round((crop.top ?? 0) * scale)}px 0 0 ${-Math.round((crop.left ?? 0) * scale)}px"></div></div>`,
    );
    x += w + gap;
  }
  return parts.join('');
}

function copy(slide, palette, { size, align = 'left', width }) {
  return `
    <div style="width:${width}px;text-align:${align}">
      <div class="brand" style="color:${palette.ink};${align === 'center' ? 'justify-content:center;' : ''}">${icon}<span>${escape(name)}</span></div>
      <h1 class="title" style="margin-top:28px;font-size:${size}px;color:${palette.ink}">${escape(slide.title)}</h1>
      ${slide.text ? `<p class="text" style="margin-top:18px;font-size:20px;color:${palette.muted}">${escape(slide.text)}</p>` : ''}
      ${slide.pro ? `<p class="pro" style="margin-top:22px;color:${palette.muted}"><b>PRO</b>${escape(config.proNote ?? '')}</p>` : ''}
    </div>`;
}

async function slideHtml(slide) {
  const palette = slide.theme === 'dark' ? dark : light;
  const background = slide.background ?? palette.bg;
  let body;
  if (slide.layout === 'wide') {
    // Caption on top, the screenshot in a window frame rising from the bottom edge.
    body = `
      <div style="position:absolute;left:0;right:0;top:44px;display:flex;justify-content:center">
        ${copy({ ...slide, text: slide.text }, palette, { size: 40, align: 'center', width: 980 })}
      </div>
      ${await shots(slide, { x: 90, y: slide.imageTop ?? 250, width: 1100, height: 800 }, { window: true, bleed: true })}`;
  } else {
    // Caption on the left, screenshots on the right.
    body = `
      <div style="position:absolute;left:72px;top:0;bottom:0;display:flex;align-items:center">
        ${copy(slide, palette, { size: 46, width: slide.textWidth ?? 440 })}
      </div>
      ${await shots(slide, { x: slide.imageLeft ?? 580, y: 48, width: 1280 - (slide.imageLeft ?? 580) - 56, height: 704 })}`;
  }
  return page(1280, 800, background, body, slide.theme === 'dark');
}

async function promoHtml() {
  // Small tile: readable at half size, so just the icon, the name and a few words.
  const body = `
    <div style="position:absolute;inset:0;display:flex;align-items:center;gap:26px;padding:0 36px">
      <div style="flex:none;width:104px;height:104px;border-radius:30px;background:#fff;display:grid;place-items:center;box-shadow:0 10px 28px -10px rgba(0,0,0,.45)">
        <div style="width:84px;height:84px">${icon.replace('<svg ', '<svg width="84" height="84" ')}</div>
      </div>
      <div style="color:#fff">
        <div class="title" style="font-size:${config.promoNameSize ?? 38}px">${escape(name)}</div>
        <div class="text" style="margin-top:8px;font-size:18px;font-weight:600;opacity:.92">${escape(config.tagline)}</div>
      </div>
    </div>`;
  return page(440, 280, tile, body, false);
}

async function marqueeHtml() {
  const hero = config.marquee ?? config.slides[0];
  const body = `
    <div style="position:absolute;left:80px;top:0;bottom:0;width:470px;display:flex;flex-direction:column;justify-content:center;color:#fff">
      <div style="width:96px;height:96px;border-radius:28px;background:#fff;display:grid;place-items:center;box-shadow:0 10px 28px -10px rgba(0,0,0,.45)">
        <div style="width:78px;height:78px">${icon.replace('<svg ', '<svg width="78" height="78" ')}</div>
      </div>
      <div class="title" style="margin-top:30px;font-size:54px">${escape(name)}</div>
      <div class="text" style="margin-top:14px;font-size:24px;font-weight:600;opacity:.92">${escape(config.tagline)}</div>
    </div>
    ${await shots({ ...hero, maxScale: hero.marqueeScale ?? 1 }, { x: 620, y: 64, width: 720, height: 560 }, { window: hero.layout === 'wide', bleed: true })}`;
  return page(1400, 560, tile, body, false);
}

function page(width, height, background, body, isDark) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head>
    <body class="${isDark ? 'dark' : ''}" style="width:${width}px;height:${height}px;background:${background}">${body}</body></html>`;
}

// --- Render -----------------------------------------------------------------------------------

const browser = await chromium.launch({ executablePath: findChromium() });
const context = await browser.newContext({ deviceScaleFactor: 1 });
const tab = await context.newPage();

async function render(html, width, height, file) {
  await tab.setViewportSize({ width, height });
  await tab.setContent(html, { waitUntil: 'load' });
  await tab.evaluate(() => document.fonts.ready);
  const ok = await tab.evaluate(() => [...document.fonts].every((font) => font.status !== 'error'));
  if (!ok) throw new Error(`${file}: a font failed to load`);
  // Text must not spill out of the canvas.
  const overflow = await tab.evaluate(() =>
    [...document.querySelectorAll('.title,.text,.brand')].some((el) => {
      const r = el.getBoundingClientRect();
      return r.left < 0 || r.top < 0 || r.right > innerWidth || r.bottom > innerHeight;
    }),
  );
  if (overflow) throw new Error(`${file}: caption text overflows the canvas, shorten it`);
  const path = join(outDir, file);
  await tab.screenshot({ path, omitBackground: false });
  const png = await readFile(path);
  // The store wants 24-bit PNG without alpha at exactly these sizes.
  if (png.readUInt32BE(16) !== width || png.readUInt32BE(20) !== height || png[25] !== 2) {
    throw new Error(`${file}: expected a ${width}×${height} RGB PNG`);
  }
  console.log(`store/assets/${file}`);
}

await mkdir(outDir, { recursive: true });
for (const file of await readdir(outDir)) if (file.endsWith('.png')) await rm(join(outDir, file));
for (const [index, slide] of config.slides.entries()) {
  await render(await slideHtml(slide), 1280, 800, `screenshot-${index + 1}.png`);
}
await render(await promoHtml(), 440, 280, 'promo-small-440x280.png');
await render(await marqueeHtml(), 1400, 560, 'marquee-1400x560.png');

await browser.close();
