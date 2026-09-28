// End-to-end smoke test: loads the e2e build (dist-e2e/) into a real Chromium and drives
// every user flow against local fixture pages.
//
//   npm run test:e2e                      (set CHROMIUM_PATH if Chromium isn't auto-detected)
//
// The media file (a WAV tone) and the poster are generated here. The fixture server answers
// on two hostnames (127.0.0.1 and localhost) for the blocklist, per-site memory and
// cross-origin iframe tests. The popup is opened as a tab with ?tab=<id> (e2e build only),
// since a real popup would resolve the active tab to itself.
//
// Curated screenshots go to screenshots/ (committed), debug screenshots to e2e/output/.

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const extensionPath = join(root, 'dist-e2e');
const fixtures = join(root, 'e2e/fixtures');
const outputDir = join(root, 'e2e/output');
const screenshotDir = join(root, 'screenshots');
const headless = process.env.HEADED !== '1';

function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const candidates = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  const found = candidates.find((path) => existsSync(path));
  if (!found) throw new Error('Chromium not found. Set CHROMIUM_PATH.');
  return found;
}

// --- Media ------------------------------------------------------------------------------

/** 60 s mono 16-bit PCM WAV: a quiet 220 Hz tone. A <video> element plays it fine. */
function makeWav(seconds = 60, rate = 8000) {
  const samples = seconds * rate;
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + samples * 2, 4);
  buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(rate, 24);
  buffer.writeUInt32LE(rate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i += 1) {
    buffer.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 220 * i) / rate) * 1200), 44 + i * 2);
  }
  return buffer;
}

const POSTER = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#20304a"/><stop offset="1" stop-color="#46607f"/></linearGradient>
  </defs>
  <rect width="1280" height="720" fill="url(#sky)"/>
  <circle cx="1010" cy="190" r="64" fill="#f3c969" opacity=".9"/>
  <path d="M0 520 230 330l150 120 190-210 230 250 170-130 310 230v130H0Z" fill="#33445c"/>
  <path d="m570 240-38 42 26-8 12 20 20-22 22 12Z" fill="#e8edf3" opacity=".85"/>
  <path d="M0 610 270 460l200 110 240-150 300 200 270-120v220H0Z" fill="#26344a"/>
  <path d="M0 720V660l320-90 260 80 330-100 370 110v60Z" fill="#1b2638"/>
  <text x="84" y="132" font-family="system-ui, sans-serif" font-size="46" font-weight="700" fill="#f1f3f5">Reading mountain weather</text>
  <text x="84" y="182" font-family="system-ui, sans-serif" font-size="26" fill="#c3ccd8">How fronts form, and what the clouds tell you</text>
</svg>`;

// --- Fixture server ---------------------------------------------------------------------

const wav = makeWav();
const CONTENT_TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8' };

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (url.pathname === '/media/tone.wav') {
    // Range support, so seeking works like on a real site.
    const range = /bytes=(\d*)-(\d*)/.exec(request.headers.range ?? '');
    const headers = { 'content-type': 'audio/wav', 'accept-ranges': 'bytes', 'cache-control': 'no-store' };
    if (range) {
      const start = range[1] ? Number(range[1]) : 0;
      const end = range[2] ? Math.min(Number(range[2]), wav.length - 1) : wav.length - 1;
      response.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${wav.length}`, 'content-length': end - start + 1 });
      response.end(wav.subarray(start, end + 1));
    } else {
      response.writeHead(200, { ...headers, 'content-length': wav.length }).end(wav);
    }
    return;
  }
  if (url.pathname === '/media/poster.svg') {
    response.writeHead(200, { 'content-type': 'image/svg+xml' }).end(POSTER);
    return;
  }
  let body;
  try {
    body = await readFile(join(fixtures, url.pathname.slice(1)));
  } catch {
    response.writeHead(404).end('not found');
    return;
  }
  const headers = { 'content-type': CONTENT_TYPES[extname(url.pathname)] ?? 'application/octet-stream' };
  if (url.pathname === '/hostile.html') {
    headers['content-security-policy'] =
      "default-src 'self'; script-src 'none'; style-src 'self'; img-src 'self'; media-src 'self'; require-trusted-types-for 'script'; trusted-types 'none'";
  }
  response.writeHead(200, headers).end(body);
});
await new Promise((resolve) => server.listen(0, resolve));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;
const alt = `http://localhost:${port}`;

// --- Browser ----------------------------------------------------------------------------

await mkdir(outputDir, { recursive: true });
await mkdir(screenshotDir, { recursive: true });
const extensionId = (await readFile(join(extensionPath, 'e2e-extension-id.txt'), 'utf8')).trim();
const userDataDir = await mkdtemp(join(tmpdir(), 'video-speed-e2e-'));
const context = await chromium.launchPersistentContext(userDataDir, {
  executablePath: findChromium(),
  headless,
  viewport: { width: 1280, height: 720 },
  args: [
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
    '--autoplay-policy=no-user-gesture-required',
  ],
});

/** An extension page kept open for storage access and tab lookups. */
const control = context.pages()[0] ?? (await context.newPage());
await control.goto(`chrome-extension://${extensionId}/options.html`);

const openPages = new Set();

async function newPage() {
  const page = await context.newPage();
  openPages.add(page);
  page.on('pageerror', (error) => console.log(`      page error: ${error.message}`));
  return page;
}

async function open(name, { host = base, query = '' } = {}) {
  const page = await newPage();
  await page.goto(`${host}/${name}${query}`);
  await page.bringToFront();
  return page;
}

async function waitFor(check, message, timeout = 5000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await check();
      if (last) return last;
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out: ${message}${last instanceof Error ? ` (${last.message})` : ''}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** playbackRate of a media element in the page (main world). */
const rate = (page, selector = '#v') => page.evaluate((selector) => document.querySelector(selector).playbackRate, selector);

async function waitForRate(page, expected, selector = '#v', message = '') {
  await waitFor(async () => (await rate(page, selector)) === expected, `${selector} playbackRate === ${expected} ${message}`);
}

/** Waits until the content script is tracking the page's video (its controller exists). */
async function ready(page, count = 1) {
  await waitFor(async () => (await page.locator('video-speed-plus .vsp-ctl').count()) >= count, 'controller attached');
}

async function setSettings(patch) {
  await control.evaluate(async (patch) => {
    const { settings = {} } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...settings, ...patch } });
  }, patch);
}

async function storage(key) {
  return control.evaluate(async (key) => (await chrome.storage.local.get(key))[key], key);
}

async function resetStorage() {
  if (control.isClosed()) return;
  await control.evaluate(() => chrome.storage.local.clear());
}

async function tabIdOf(page) {
  await page.bringToFront();
  return control.evaluate(async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id);
}

async function openPopup(page, { colorScheme = 'light' } = {}) {
  const tabId = typeof page === 'number' ? page : await tabIdOf(page);
  const popup = await newPage();
  await popup.emulateMedia({ colorScheme });
  await popup.setViewportSize({ width: 360, height: 600 });
  await popup.goto(`chrome-extension://${extensionId}/popup.html?tab=${tabId}`);
  await popup.locator('#view-loading').waitFor({ state: 'hidden' });
  return popup;
}

const shot = (page, name) => page.screenshot({ path: join(outputDir, `${name}.png`) });
const popupShot = (popup, file) => popup.locator('body').screenshot({ path: file });

/** Center of an element, for mouse moves and clicks. */
async function center(locator) {
  const box = await locator.boundingBox();
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

const controller = (page) => page.locator('video-speed-plus .vsp-ctl').first();
const bezel = (page) => page.locator('video-speed-plus .vsp-bezel');

// --- Tests ------------------------------------------------------------------------------

const results = [];
async function test(name, fn) {
  const started = Date.now();
  try {
    await resetStorage();
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✓ ${name} (${Date.now() - started} ms)`);
  } catch (error) {
    results.push({ name, ok: false, error });
    console.log(`  ✗ ${name}\n      ${String(error?.stack ?? error).split('\n').slice(0, 6).join('\n      ')}`);
  } finally {
    for (const page of openPages) await page.close().catch(() => undefined);
    openPages.clear();
  }
}

console.log(`Chromium ${context.browser()?.version() ?? ''} · extension ${extensionId}\n`);

await test('manifest: only "storage", content script in all frames, no background, no commands (production build)', async () => {
  const manifest = JSON.parse(await readFile(join(root, 'dist/manifest.json'), 'utf8'));
  assert.deepEqual(manifest.permissions, ['storage']);
  assert.equal(manifest.host_permissions, undefined);
  assert.equal(manifest.optional_permissions, undefined);
  assert.equal(manifest.background, undefined);
  assert.equal(manifest.commands, undefined);
  assert.equal(manifest.key, undefined);
  assert.deepEqual(manifest.content_scripts, [
    { matches: ['<all_urls>'], js: ['content.js'], all_frames: true, match_about_blank: true, run_at: 'document_idle' },
  ]);
  // Speed keys are in-page handlers, not chrome.commands (Chrome silently drops conflicting ones).
  assert.equal(await control.evaluate(() => typeof chrome.commands), 'undefined', 'no chrome.commands registered');
  // The test hooks (popup ?tab=, early-access override) are compiled out of the store build.
  for (const file of ['content.js', 'popup.js', 'options.js']) {
    const code = await readFile(join(root, 'dist', file), 'utf8');
    assert.ok(!code.includes('e2e:'), `${file}: no e2e storage keys`);
    assert.ok(!code.includes('URLSearchParams'), `${file}: no ?tab= hook`);
  }
});

await test('keyboard: S/D/R/G/Z/X work, 1.1 + 0.1 is exactly 1.2, handled keys never reach the page', async () => {
  const page = await open('video.html');
  await ready(page);
  await page.keyboard.press('d');
  await waitForRate(page, 1.1);
  assert.match(await bezel(page).innerText(), /^1\.10×$/);
  await page.keyboard.press('d');
  await waitForRate(page, 1.2);
  assert.equal(await rate(page), 1.2, 'no floating-point drift');
  await page.keyboard.press('s');
  await page.keyboard.press('s');
  await page.keyboard.press('s');
  await waitForRate(page, 0.9);
  await page.keyboard.press('g');
  await waitForRate(page, 1.8);
  await page.keyboard.press('g');
  await waitForRate(page, 1);
  await page.keyboard.press('d');
  await page.keyboard.press('r');
  await waitForRate(page, 1);
  assert.equal(await controller(page).locator('.vsp-speed').innerText(), '1.00×');

  // Clamping: 20 presses of S from 1.0 end at Chrome's minimum, not below it.
  for (let i = 0; i < 20; i += 1) await page.keyboard.press('s');
  await waitForRate(page, 0.0625);
  assert.equal(await controller(page).locator('.vsp-speed').innerText(), '0.06×');
  await page.keyboard.press('r');

  // Rewind / advance by 10 s.
  await page.evaluate(() => {
    const video = document.getElementById('v');
    video.currentTime = 30;
  });
  await page.keyboard.press('x');
  await waitFor(async () => Math.abs((await page.evaluate(() => document.getElementById('v').currentTime)) - 40) < 0.5, 'advanced to 40 s');
  assert.match(await bezel(page).innerText(), /\+10 s/);
  await page.keyboard.press('z');
  await page.keyboard.press('z');
  await waitFor(async () => Math.abs((await page.evaluate(() => document.getElementById('v').currentTime)) - 20) < 0.5, 'rewound to 20 s');

  // Handled keys were swallowed; other keys still reach the page.
  await page.keyboard.press('k');
  const keys = await page.evaluate(() => window.stats.keys);
  assert.deepEqual(keys, ['k'], `page saw ${JSON.stringify(keys)}`);
  await waitFor(async () => (await storage('speed:global')) === 1, 'last speed remembered');
});

await test('typing: fields, editors, modifiers and IME composition are ignored', async () => {
  const page = await open('video.html');
  await ready(page);
  await page.locator('#field').click();
  await page.keyboard.type('dsrgd');
  assert.equal(await page.locator('#field').inputValue(), 'dsrgd');
  await page.locator('#notes').click();
  await page.keyboard.type('dd');
  assert.equal(await page.locator('#notes').inputValue(), 'dd');
  await page.locator('#editor').click();
  await page.keyboard.type('dd');
  assert.equal(await page.locator('#editor').innerText(), 'dd');
  await page.locator('#aria').focus();
  await page.keyboard.press('d');
  assert.equal(await rate(page), 1);

  await page.locator('#aria').evaluate((element) => element.blur());
  for (const combo of ['Shift+D', 'Control+D', 'Alt+D']) await page.keyboard.press(combo);
  // IME: a composing key press reports keyCode 229.
  const cdp = await context.newCDPSession(page);
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Process', code: 'KeyD', windowsVirtualKeyCode: 229, nativeVirtualKeyCode: 229 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Process', code: 'KeyD', windowsVirtualKeyCode: 229, nativeVirtualKeyCode: 229 });
  await cdp.detach();
  await sleep(200);
  assert.equal(await rate(page), 1, 'nothing changed the speed');

  // And the key works as soon as focus leaves the field.
  await page.keyboard.press('d');
  await waitForRate(page, 1.1);
});

await test('controller: appears on hover, buttons work, clicks on it never reach the page, fades when idle', async () => {
  const page = await open('video.html');
  await ready(page);
  const video = page.locator('#v');
  const middle = await center(video);
  assert.equal(await controller(page).getAttribute('data-state'), 'idle');
  await page.mouse.move(middle.x, middle.y);
  await waitFor(async () => (await controller(page).getAttribute('data-state')) === 'active', 'controller shown on hover');
  const box = await controller(page).boundingBox();
  const videoBox = await video.boundingBox();
  assert.equal(Math.round(box.x - videoBox.x), 8, 'top-left corner (x)');
  assert.equal(Math.round(box.y - videoBox.y), 8, 'top-left corner (y)');

  const before = await page.evaluate(() => ({ ...window.stats }));
  await controller(page).hover();
  await page.locator('video-speed-plus [data-action="faster"]').click();
  await page.locator('video-speed-plus [data-action="faster"]').click();
  await waitForRate(page, 1.2);
  assert.equal(await controller(page).locator('.vsp-speed').innerText(), '1.20×');
  await shot(page, 'controller-expanded');
  await page.locator('video-speed-plus [data-action="slower"]').click();
  await waitForRate(page, 1.1);
  await page.locator('video-speed-plus [data-action="reset"]').click();
  await waitForRate(page, 1);
  const after = await page.evaluate(() => ({ ...window.stats }));
  assert.equal(after.playerClicks, before.playerClicks, 'player click handler not triggered by our buttons');
  assert.equal(after.docClicks, before.docClicks, 'document click handler not triggered by our buttons');

  // The site's own click handling on the video still works.
  await page.mouse.click(middle.x, middle.y);
  assert.equal(await page.evaluate(() => window.stats.playerClicks), before.playerClicks + 1);

  // Hidden (and not clickable) after ~2 s without activity.
  await page.mouse.move(1200, 700);
  await waitFor(async () => (await controller(page).getAttribute('data-state')) === 'idle', 'controller fades when idle', 4000);
  assert.equal(await controller(page).evaluate((element) => getComputedStyle(element).pointerEvents), 'none');

  // Hide button hides every controller on the page until V.
  await page.mouse.move(middle.x, middle.y);
  await controller(page).hover();
  await page.locator('video-speed-plus [data-action="hide"]').click();
  await waitFor(async () => (await controller(page).getAttribute('data-state')) === 'hidden', 'hidden by its button');
  assert.match(await bezel(page).innerText(), /Controller hidden · press V to show/);
  await sleep(250);
  await shot(page, 'hint-controller-hidden');
  await page.keyboard.press('v');
  await page.mouse.move(middle.x + 5, middle.y + 5);
  await waitFor(async () => (await controller(page).getAttribute('data-state')) === 'active', 'shown again with V');
});

await test('settings: "Show the controller" off starts hidden, V still toggles it, keys still work', async () => {
  await setSettings({ showController: false });
  const page = await open('video.html');
  await waitFor(async () => (await page.locator('video-speed-plus .vsp-ctl').count()) === 1, 'tracked');
  const middle = await center(page.locator('#v'));
  await page.mouse.move(middle.x, middle.y);
  await sleep(300);
  assert.equal(await controller(page).getAttribute('data-state'), 'hidden');
  await page.keyboard.press('d');
  await waitForRate(page, 1.1);
  await page.keyboard.press('v');
  await page.mouse.move(middle.x + 3, middle.y);
  await waitFor(async () => (await controller(page).getAttribute('data-state')) === 'active', 'shown with V');
  // Turning the setting on applies live.
  await page.keyboard.press('v');
  await setSettings({ showController: true });
  await page.mouse.move(middle.x, middle.y + 3);
  await waitFor(async () => (await controller(page).getAttribute('data-state')) === 'active', 'shown after the setting changed');
});

await test('memory: a video added after load starts at the last speed; reload keeps it', async () => {
  const first = await open('video.html');
  await ready(first);
  for (let i = 0; i < 5; i += 1) await first.keyboard.press('d');
  await waitForRate(first, 1.5);
  await waitFor(async () => (await storage('speed:global')) === 1.5, 'saved');

  const dynamic = await open('dynamic.html');
  await waitFor(() => dynamic.evaluate(() => !!document.getElementById('late')), 'late video added');
  await waitForRate(dynamic, 1.5, '#late', '(remembered speed applied to the new video)');
  await ready(dynamic);

  await first.reload();
  await waitForRate(first, 1.5, '#v', 'after reload');
  await first.bringToFront();
  await first.keyboard.press('r');
  await waitFor(async () => (await storage('speed:global')) === 1, 'reset remembered');
});

await test('shadow DOM: nested open roots, late-upgraded custom elements and closed roots are found', async () => {
  const page = await open('shadow.html');
  await ready(page, 3);
  const openVideo = () => page.evaluate(() => document.getElementById('open-host').shadowRoot.querySelector('div').shadowRoot.getElementById('open-video').playbackRate);
  const upgraded = () => page.evaluate(() => document.getElementById('upgrade-host').shadowRoot.getElementById('upgraded-video').playbackRate);
  const closed = () => page.evaluate(() => window.closedVideo.playbackRate);

  // Nothing played or clicked yet: the largest visible video is the target.
  await page.keyboard.press('d');
  await waitFor(async () => (await openVideo()) === 1.1, 'largest (open, nested) video changed');
  assert.equal(await upgraded(), 1);

  const upgradedBox = await page.evaluate(() => {
    const rect = document.getElementById('upgrade-host').shadowRoot.getElementById('upgraded-video').getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  });
  await page.mouse.click(upgradedBox.x, upgradedBox.y);
  await page.keyboard.press('d');
  await waitFor(async () => (await upgraded()) === 1.1, 'clicked (upgraded) video changed');
  assert.equal(await openVideo(), 1.1, 'the other one is untouched');

  const closedBox = await page.evaluate(() => {
    const rect = window.closedVideo.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  });
  await page.mouse.click(closedBox.x, closedBox.y);
  await page.keyboard.press('g');
  await waitFor(async () => (await closed()) === 1.8, 'video in a closed shadow root changed');
  await shot(page, 'shadow');
});

await test('iframe (same origin): controller inside the frame, keys work once the player has focus', async () => {
  const page = await open('iframe.html');
  const frame = page.frameLocator('#frame');
  await waitFor(async () => (await frame.locator('video-speed-plus .vsp-ctl').count()) === 1, 'controller in the frame');
  const frameRate = () => page.frame({ url: /\/frame\.html$/ }).evaluate(() => document.getElementById('fv').playbackRate);

  // Focus on the top page (no video there): the key belongs to the page.
  await page.keyboard.press('d');
  await sleep(150);
  assert.equal(await frameRate(), 1);

  const middle = await center(page.locator('#frame'));
  await page.mouse.click(middle.x, middle.y);
  await page.keyboard.press('d');
  await waitFor(async () => (await frameRate()) === 1.1, 'frame video changed');
  await page.mouse.move(middle.x, middle.y + 10);
  await waitFor(async () => (await frame.locator('video-speed-plus .vsp-ctl').getAttribute('data-state')) === 'active', 'controller shown in the frame');
});

await test('iframe (about:blank, written by the page): found thanks to match_about_blank', async () => {
  const page = await open('blank-frame.html');
  const frame = page.frameLocator('#frame');
  await waitFor(async () => (await frame.locator('video-speed-plus .vsp-ctl').count()) === 1, 'controller in the about:blank frame');
  const middle = await center(page.locator('#frame'));
  await page.mouse.click(middle.x, middle.y);
  await page.keyboard.press('g');
  await waitFor(() => page.evaluate(() => document.getElementById('frame').contentDocument.getElementById('bv').playbackRate === 1.8), 'frame video at 1.8×');
});

await test('iframe (cross origin): the popup finds and controls the embedded player', async () => {
  const page = await open('iframe.html', { query: `?cross=localhost:${port}` });
  await waitFor(async () => (await page.frameLocator('#frame').locator('video-speed-plus .vsp-ctl').count()) === 1, 'controller in the frame');
  const popup = await openPopup(page);
  await popup.locator('#view-control').waitFor();
  assert.match(await popup.locator('#target-info').innerText(), /Paused video · embedded from localhost/);
  await popup.locator('#presets [data-speed="2"]').click();
  await waitFor(() => popup.locator('#speed').innerText().then((text) => text === '2.00×'), 'popup shows 2.00×');
  const frameRate = await page.frame({ url: /\/frame\.html$/ }).evaluate(() => document.getElementById('fv').playbackRate);
  assert.equal(frameRate, 2);
});

await test('YouTube-like resets: speed re-applied on play and on a new video, no ratechange loop', async () => {
  const page = await open('youtube.html');
  await ready(page);
  for (let i = 0; i < 5; i += 1) await page.keyboard.press('d');
  await waitForRate(page, 1.5);
  await sleep(300); // let the queued ratechange events of the key presses fire

  const before = await page.evaluate(() => window.stats.rateChanges);
  await page.locator('#play').click(); // user gesture + play: the site resets to 1 on play
  await sleep(600);
  assert.equal(await rate(page), 1.5, 're-applied after the site reset it on play');
  let stats = await page.evaluate(() => window.stats);
  assert.ok(stats.resets >= 1, 'the site did reset');
  assert.ok(stats.rateChanges - before <= 4, `ratechange events on play: ${stats.rateChanges - before}`);

  // Scripted play (no gesture), then a new source (loadstart/loadedmetadata/play resets).
  await page.evaluate(() => document.getElementById('v').pause());
  await page.evaluate(() => document.getElementById('v').play());
  await sleep(400);
  assert.equal(await rate(page), 1.5, 're-applied after a scripted play');
  await page.locator('#next').click();
  await waitFor(async () => (await page.evaluate(() => window.stats.resets)) >= 3, 'new video loaded and reset');
  await sleep(500);
  assert.equal(await rate(page), 1.5, 're-applied on the new video');
  stats = await page.evaluate(() => window.stats);
  assert.ok(stats.rateChanges < 16, `bounded ratechange events overall: ${stats.rateChanges}`);

  // The user picks a speed in the site's own menu: adopted, not fought.
  await sleep(1600);
  await page.evaluate(() => {
    document.getElementById('site-speed').onclick = () => {
      document.getElementById('v').playbackRate = 1.25;
    };
  });
  await page.locator('#site-speed').click();
  await sleep(500);
  assert.equal(await rate(page), 1.25, "the user's choice in the site menu stays");
  assert.equal(await controller(page).locator('.vsp-speed').innerText(), '1.25×');
  await waitFor(async () => (await storage('speed:global')) === 1.25, 'adopted speed remembered');
});

await test('fighting page: gives up after a few corrections and tells the user', async () => {
  const page = await open('fighter.html');
  await ready(page);
  await page.keyboard.press('d');
  await sleep(1200);
  const { rateChanges } = await page.evaluate(() => window.stats);
  assert.ok(rateChanges > 2 && rateChanges <= 12, `ratechange events: ${rateChanges}`);
  await sleep(500);
  assert.equal((await page.evaluate(() => window.stats)).rateChanges, rateChanges, 'no more events: the loop stopped');
  assert.equal(await rate(page), 1);
  await waitFor(async () => /keeps changing the speed back/.test(await bezel(page).innerText()), 'warning shown on the page');
  const warningBox = await bezel(page).boundingBox();
  assert.ok(warningBox.width > 250 && warningBox.height < 120, `warning is a readable box: ${JSON.stringify(warningBox)}`);
  await shot(page, 'fighter-warning');

  const popup = await openPopup(page);
  await popup.locator('#error', { hasText: 'keeps changing the speed back' }).waitFor();
  await popupShot(popup, join(outputDir, 'popup-page-warning.png'));
});

await test('target rule: a playing video beats a larger paused one; a clicked video beats both', async () => {
  const page = await open('two.html');
  await ready(page, 2);
  await page.evaluate(() => {
    const small = document.getElementById('small');
    small.muted = true;
    return small.play();
  });
  await page.keyboard.press('d');
  await waitForRate(page, 1.1, '#small');
  assert.equal(await rate(page, '#big'), 1);

  const big = await center(page.locator('#big'));
  await page.mouse.click(big.x, big.y);
  await page.keyboard.press('d');
  await waitForRate(page, 1.1, '#big');
  await page.keyboard.press('d');
  await waitForRate(page, 1.2, '#big');
  assert.equal(await rate(page, '#small'), 1.1);
});

await test('audio: ignored by default, controlled once "Control audio players too" is on (live)', async () => {
  const page = await open('audio.html');
  await sleep(500);
  await page.keyboard.press('d');
  await sleep(200);
  assert.equal(await rate(page, '#a'), 1);
  assert.equal(await page.locator('video-speed-plus').count(), 0, 'no UI injected for a page without video');

  await setSettings({ includeAudio: true });
  await sleep(300);
  await page.keyboard.press('d');
  await waitForRate(page, 1.1, '#a');
  assert.equal(await page.locator('video-speed-plus .vsp-ctl').count(), 0, 'no on-video controller for audio');
  assert.match(await bezel(page).innerText(), /1\.10×/);
});

await test('blocklist: inactive on a blocked site, other hosts unaffected, popup turns it back on', async () => {
  await setSettings({ blocklist: ['localhost'] });
  const blocked = await open('video.html', { host: alt });
  await sleep(600);
  await blocked.keyboard.press('d');
  await sleep(200);
  assert.equal(await rate(blocked), 1);
  assert.equal(await blocked.locator('video-speed-plus').count(), 0);
  assert.deepEqual(await blocked.evaluate(() => window.stats.keys), ['d'], 'the key reached the page');

  const allowed = await open('video.html');
  await ready(allowed);
  await allowed.keyboard.press('d');
  await waitForRate(allowed, 1.1);

  const popup = await openPopup(blocked);
  await popup.locator('#view-blocked').waitFor();
  assert.equal(await popup.locator('#blocked-host').innerText(), 'localhost');
  assert.equal(await popup.locator('#site-toggle').isChecked(), false);
  await popupShot(popup, join(screenshotDir, 'popup-blocked.png'));
  await popup.locator('#unblock').click();
  await popup.locator('#view-control').waitFor();
  assert.deepEqual((await storage('settings')).blocklist, []);
  await blocked.bringToFront();
  await ready(blocked);
  await blocked.keyboard.press('d');
  await waitForRate(blocked, 1.2, '#v', '(1.1 remembered from the other tab, then +0.1)');

  // And off again with the footer switch.
  const again = await openPopup(blocked);
  await again.locator('#site-toggle').click();
  await again.locator('#view-blocked').waitFor();
  assert.deepEqual((await storage('settings')).blocklist, ['localhost']);
  await waitFor(async () => (await blocked.locator('video-speed-plus').count()) === 0, 'UI removed live');
});

await test('popup: current speed, presets and −/+ control the video (light and dark)', async () => {
  const page = await open('demo.html');
  await ready(page);
  const popup = await openPopup(page);
  await popup.locator('#view-control').waitFor();
  assert.equal(await popup.locator('#speed').innerText(), '1.00×');
  assert.match(await popup.locator('#target-info').innerText(), /^Paused video$/);
  assert.equal(await popup.locator('#presets [data-speed="1"]').getAttribute('aria-pressed'), 'true');
  await popup.locator('#presets [data-speed="1.5"]').click();
  await waitFor(() => popup.locator('#speed').innerText().then((text) => text === '1.50×'), 'popup shows 1.50×');
  assert.equal(await rate(page), 1.5);
  assert.equal(await popup.locator('#presets [data-speed="1.5"]').getAttribute('aria-pressed'), 'true');
  await popup.locator('#faster').click();
  await waitFor(() => popup.locator('#speed').innerText().then((text) => text === '1.60×'), '+ step');
  await popup.locator('#slower').click();
  await popup.locator('#slower').click();
  await waitFor(() => popup.locator('#speed').innerText().then((text) => text === '1.40×'), '− step');
  assert.equal(await rate(page), 1.4);
  await popup.locator('#presets [data-speed="1.5"]').click();
  await waitFor(async () => (await rate(page)) === 1.5, 'back to 1.5');
  await page.evaluate(() => document.getElementById('v').play());
  const light = await openPopup(page);
  await light.locator('#view-control').waitFor();
  assert.match(await light.locator('#target-info').innerText(), /^Playing video$/);
  assert.equal(await light.locator('#site-label').innerText(), 'On for 127.0.0.1');
  await popupShot(light, join(screenshotDir, 'popup-light.png'));
  const dark = await openPopup(page, { colorScheme: 'dark' });
  await dark.locator('#view-control').waitFor();
  await popupShot(dark, join(screenshotDir, 'popup-dark.png'));
  await page.evaluate(() => document.getElementById('v').pause());
});

await test('popup: clear messages for a page without video and for pages extensions cannot run on', async () => {
  const empty = await open('empty.html');
  // The loading skeleton shows while frames report (at least 200 ms).
  const loading = await newPage();
  await loading.setViewportSize({ width: 360, height: 600 });
  await loading.goto(`chrome-extension://${extensionId}/popup.html?tab=${await tabIdOf(empty)}`, { waitUntil: 'domcontentloaded' });
  if (await loading.locator('#view-loading').isVisible()) await popupShot(loading, join(outputDir, 'popup-loading.png'));
  const popup = await openPopup(empty);
  await popup.locator('#view-empty').waitFor();
  assert.match(await popup.locator('#view-empty').innerText(), /No video on this page/);
  assert.equal(await popup.locator('#footer').isVisible(), true);
  await popupShot(popup, join(outputDir, 'popup-empty.png'));
  const dark = await openPopup(empty, { colorScheme: 'dark' });
  await dark.locator('#view-empty').waitFor();
  await popupShot(dark, join(screenshotDir, 'popup-no-video-dark.png'));

  const chromePage = await newPage();
  await chromePage.goto('chrome://version');
  const restricted = await openPopup(chromePage);
  await restricted.locator('#view-unavailable').waitFor();
  assert.match(await restricted.locator('#view-unavailable').innerText(), /Can't run on this page/);
  assert.match(await restricted.locator('#unavailable-text').innerText(), /chrome:\/\/|Chrome Web Store/);
  assert.equal(await restricted.locator('#footer').isVisible(), false);
  await popupShot(restricted, join(screenshotDir, 'popup-unavailable.png'));
});

await test('options: shortcut editor (capture, duplicates, clear), numbers clamp, settings persist and apply live', async () => {
  const page = await open('video.html');
  await ready(page);
  const options = await newPage();
  await options.goto(`chrome-extension://${extensionId}/options.html`);
  const row = (action) => options.locator(`#shortcuts [data-action="${action}"]`);

  await row('faster').locator('[data-role="change"]').click();
  assert.equal(await row('faster').locator('kbd').innerText(), 'Press a key…');
  await options.locator('.card').first().screenshot({ path: join(outputDir, 'options-capturing.png') });
  await options.keyboard.press('f');
  await options.locator('#save-status', { hasText: 'Saved' }).waitFor();
  assert.equal(await row('faster').locator('kbd').innerText(), 'F');

  await row('slower').locator('[data-role="change"]').click();
  await options.keyboard.press('Shift+A');
  await options.locator('#shortcut-error', { hasText: 'without Ctrl, Alt, Shift' }).waitFor();
  await options.keyboard.press('f');
  await options.locator('#shortcut-error', { hasText: 'F is already used for “Faster”' }).waitFor();
  await options.locator('.card').first().screenshot({ path: join(outputDir, 'options-conflict.png') });
  assert.equal(await row('slower').locator('kbd').innerText(), 'S', 'duplicate not saved');

  await row('rewind').locator('[data-role="clear"]').click();
  await waitFor(async () => (await row('rewind').locator('kbd').innerText()) === 'Not set', 'rewind unbound');

  await options.locator('#step').fill('0.25');
  await options.locator('#step').press('Tab');
  await options.locator('#preferred').fill('99');
  await options.locator('#preferred').press('Tab');
  await waitFor(async () => (await options.locator('#preferred').inputValue()) === '16', 'preferred clamped to 16');
  await options.locator('#seek').fill('5');
  await options.locator('#seek').press('Tab');
  await options.locator('#per-site').check();
  await options.locator('#block-input').fill('not a site!');
  await options.locator('#block-form button').click();
  await options.locator('#block-error', { hasText: "isn't a site name" }).waitFor();
  await options.locator('#block-form').locator('xpath=ancestor::section').screenshot({ path: join(outputDir, 'options-block-error.png') });
  await options.locator('#block-input').fill('https://www.Example.com/watch?v=1');
  await options.locator('#block-form button').click();
  await options.locator('#blocklist li', { hasText: 'example.com' }).waitFor();
  await waitFor(async () => (await storage('settings'))?.seekSeconds === 5, 'saved');

  const settings = await storage('settings');
  assert.equal(settings.keys.faster, 'KeyF');
  assert.equal(settings.keys.slower, 'KeyS');
  assert.equal(settings.keys.rewind, null);
  assert.equal(settings.step, 0.25);
  assert.equal(settings.preferredSpeed, 16);
  assert.equal(settings.rememberPerSite, true);
  assert.deepEqual(settings.blocklist, ['example.com']);

  await options.reload();
  assert.equal(await options.locator('#step').inputValue(), '0.25');
  assert.equal(await row('faster').locator('kbd').innerText(), 'F');
  assert.equal(await options.locator('#per-site').isChecked(), true);
  await options.locator('#blocklist li', { hasText: 'example.com' }).waitFor();

  // Applied live in the open tab: F is "faster" with the new step, D no longer does anything.
  await page.bringToFront();
  await page.keyboard.press('f');
  await waitForRate(page, 1.25);
  await page.keyboard.press('d');
  await sleep(150);
  assert.equal(await rate(page), 1.25);
  assert.ok((await page.evaluate(() => window.stats.keys)).includes('d'), 'unbound D reached the page');

  // Restore defaults with the button.
  await options.bringToFront();
  await options.locator('#reset-keys').click();
  await waitFor(async () => (await row('faster').locator('kbd').innerText()) === 'D', 'defaults restored');
});

await test('options: screenshots (light and dark)', async () => {
  await control.evaluate(() => chrome.storage.local.set({ 'speed:global': 1.5, 'speed:site:youtube.com': { speed: 2, at: 1 } }));
  await setSettings({
    blocklist: ['music.example.com'],
    rememberPerSite: true,
    siteDefaults: [
      { host: 'youtube.com', speed: 1.5 },
      { host: 'coursera.org', speed: 1.75 },
      { host: 'podcasts.example.com', speed: 1.25 },
    ],
  });
  for (const colorScheme of ['light', 'dark']) {
    const options = await newPage();
    await options.emulateMedia({ colorScheme });
    await options.setViewportSize({ width: 900, height: 900 });
    await options.goto(`chrome-extension://${extensionId}/options.html`);
    await options.locator('#memory-summary', { hasText: '1 site with its own speed' }).waitFor();
    await options.locator('#rules li[data-host="coursera.org"]').waitFor();
    assert.equal(await options.locator('#pro-status').innerText(), 'Free during early access');
    assert.match(await options.locator('#pro-price').innerText(), /^\$1\.99$/);
    assert.equal(await options.locator('#get-pro').isDisabled(), true);
    assert.equal(await options.locator('#site-defaults-locked').isVisible(), false);
    await options.evaluate(() => document.fonts.ready);
    await options.screenshot({ path: join(screenshotDir, `options-${colorScheme}.png`), fullPage: true });
    const font = await options.locator('h1').evaluate((element) => getComputedStyle(element).fontFamily);
    assert.match(font, /Manrope Variable/);
    assert.equal(await options.evaluate(() => document.fonts.check('700 16px "Manrope Variable"')), true, 'bundled font loaded');
  }
});

await test('per-site memory: each site keeps its own speed; new sites start at 1×', async () => {
  await setSettings({ rememberPerSite: true });
  // 300 older sites already remembered: saving a new one drops the oldest (bounded storage).
  await control.evaluate(() =>
    chrome.storage.local.set(Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`speed:site:old${i}.example`, { speed: 1.5, at: i + 1 }]))),
  );
  const first = await open('video.html');
  await ready(first);
  await first.keyboard.press('g');
  await waitForRate(first, 1.8);
  await waitFor(async () => (await storage('speed:site:127.0.0.1'))?.speed === 1.8, 'site speed saved');
  const siteKeys = () => control.evaluate(async () => Object.keys(await chrome.storage.local.get(null)).filter((key) => key.startsWith('speed:site:')));
  // Pruning runs right after the new entry is written.
  await waitFor(async () => (await siteKeys()).length === 300, 'bounded to 300 sites');
  assert.ok((await siteKeys()).includes('speed:site:127.0.0.1'));
  assert.ok(!(await siteKeys()).includes('speed:site:old0.example'), 'the oldest entry was dropped');

  const other = await open('video.html', { host: alt });
  await ready(other);
  await sleep(200);
  assert.equal(await rate(other), 1, 'a new site starts at 1×');

  const again = await open('video.html');
  await waitForRate(again, 1.8, '#v', '(same site remembers)');
});

// --- Pro (early access: every Pro feature is on) ------------------------------------------

const siteDefaults = async () => (await storage('settings'))?.siteDefaults ?? [];

await test('Pro: "Set as default for this site" in the popup; new videos there start at it, other sites keep the remembered speed', async () => {
  await control.evaluate(() => chrome.storage.local.set({ 'speed:global': 1.25 }));
  const page = await open('video.html');
  await ready(page);
  await waitForRate(page, 1.25, '#v', '(remembered speed)');
  const popup = await openPopup(page);
  await popup.locator('#view-control').waitFor();
  assert.match(await popup.locator('#default-info').innerText(), /No default speed for 127\.0\.0\.1 yet/);
  assert.equal(await popup.locator('#set-default .badge-pro').innerText(), 'PRO');
  await popup.locator('#presets [data-speed="1.75"]').click();
  await waitFor(() => popup.locator('#speed').innerText().then((text) => text === '1.75×'), 'popup shows 1.75×');
  await popup.locator('#set-default').click();
  await waitFor(async () => (await popup.locator('#set-default').getAttribute('aria-pressed')) === 'true', 'button shows the default is set');
  assert.equal(await popup.locator('#set-default-label').innerText(), 'Default for this site');
  assert.equal(await popup.locator('#set-default').isDisabled(), true);
  assert.match(await popup.locator('#default-info').innerText(), /Videos on 127\.0\.0\.1 start at 1\.75×/);
  assert.deepEqual(await siteDefaults(), [{ host: '127.0.0.1', speed: 1.75 }]);
  await popup.mouse.move(0, 0);
  await popupShot(popup, join(screenshotDir, 'popup-site-default.png'));

  // Another speed is remembered afterwards; the site's default still wins there.
  await control.evaluate(() => chrome.storage.local.set({ 'speed:global': 1.25 }));
  const again = await open('video.html');
  await waitForRate(again, 1.75, '#v', '(site default)');
  await ready(again);
  // Changing the speed on the page still works and is remembered as usual.
  await again.keyboard.press('d');
  await waitForRate(again, 1.85);
  await waitFor(async () => (await storage('speed:global')) === 1.85, 'remembered');
  const other = await open('video.html', { host: alt });
  await ready(other);
  await waitForRate(other, 1.85, '#v', '(no rule for localhost: the remembered speed)');

  // A different speed can replace the default; Remove clears it.
  const popup2 = await openPopup(again);
  await popup2.locator('#view-control').waitFor();
  assert.equal(await popup2.locator('#set-default').getAttribute('aria-pressed'), 'false', '1.85× is not the default');
  await popup2.locator('#set-default').click();
  await waitFor(async () => (await siteDefaults())[0]?.speed === 1.85, 'default replaced');
  assert.equal((await siteDefaults()).length, 1);
  await popup2.locator('#remove-default').click();
  await waitFor(async () => (await siteDefaults()).length === 0, 'default removed');
  await popup2.locator('#default-info', { hasText: 'No default speed for 127.0.0.1 yet' }).waitFor();
});

await test('Pro: options edit per-site defaults (validation, change, remove) and they apply to new videos', async () => {
  const options = await newPage();
  await options.goto(`chrome-extension://${extensionId}/options.html`);
  assert.equal(await options.locator('#site-defaults-locked').isVisible(), false);
  await options.locator('#rules-empty').waitFor();
  await options.locator('#rule-host').fill('not a site!');
  await options.locator('#rule-add').click();
  await options.locator('#rule-error', { hasText: "isn't a site name" }).waitFor();
  await options.locator('#rule-host').fill('http://LOCALHOST:8080/some/page');
  await options.locator('#rule-speed').fill('2');
  await options.locator('#rule-add').click();
  await options.locator('#rules li[data-host="localhost"]').waitFor();
  assert.equal(await options.locator('#rule-host').inputValue(), '', 'form cleared');
  assert.deepEqual(await siteDefaults(), [{ host: 'localhost', speed: 2 }]);

  const page = await open('video.html', { host: alt });
  await waitForRate(page, 2, '#v', '(default for localhost)');

  // Edit the speed in the list (clamped like everywhere else).
  await options.bringToFront();
  const speed = options.locator('#rules li[data-host="localhost"] input');
  await speed.fill('40');
  await speed.press('Enter');
  await waitFor(async () => (await siteDefaults())[0]?.speed === 16, 'clamped to 16');
  await waitFor(async () => (await speed.inputValue()) === '16', 'field shows the saved value');
  await speed.fill('0.8');
  await speed.press('Tab');
  await waitFor(async () => (await siteDefaults())[0]?.speed === 0.8, 'changed to 0.8');
  const edited = await open('video.html', { host: alt });
  await waitForRate(edited, 0.8, '#v', '(edited default)');
  await ready(edited);

  // Same site again from the form updates instead of duplicating.
  await options.bringToFront();
  await options.locator('#rule-host').fill('localhost');
  await options.locator('#rule-speed').fill('1.5');
  await options.locator('#rule-add').click();
  await options.locator('#save-status', { hasText: 'Updated localhost' }).waitFor();
  assert.deepEqual(await siteDefaults(), [{ host: 'localhost', speed: 1.5 }]);

  await options.locator('#rules li[data-host="localhost"] [data-role="remove"]').click();
  await options.locator('#rules-empty').waitFor({ state: 'visible' });
  assert.deepEqual(await siteDefaults(), []);
  const plain = await open('video.html', { host: alt });
  await ready(plain);
  assert.equal(await rate(plain), 1, 'no rule, nothing remembered: 1×');
});

await test('Pro: custom presets edited in options replace the popup buttons', async () => {
  const options = await newPage();
  await options.goto(`chrome-extension://${extensionId}/options.html`);
  const chips = () => options.locator('#preset-list .preset-chip').evaluateAll((items) => items.map((item) => Number(item.dataset.speed)));
  await waitFor(async () => (await chips()).length === 8, 'default presets listed');
  assert.deepEqual(await chips(), [0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3]);
  await options.locator('#preset-input').fill('1.1');
  await options.locator('#preset-add').click();
  await options.locator('#preset-error', { hasText: 'room for 8 presets' }).waitFor();
  for (const speed of [0.75, 2.5, 3]) await options.locator(`#preset-list [data-speed="${speed}"] button`).click();
  await waitFor(async () => (await chips()).length === 5, 'three removed');
  await options.locator('#preset-input').fill('1.1');
  await options.locator('#preset-add').click();
  await waitFor(async () => (await chips()).includes(1.1), '1.1 added');
  await options.locator('#preset-input').fill('1.5');
  await options.locator('#preset-add').click();
  await options.locator('#preset-error', { hasText: '1.5× is already a preset' }).waitFor();
  assert.deepEqual((await storage('settings')).presets, [1, 1.1, 1.25, 1.5, 1.75, 2]);

  const page = await open('demo.html');
  await ready(page);
  const popup = await openPopup(page);
  await popup.locator('#view-control').waitFor();
  const buttons = await popup.locator('#presets button').evaluateAll((items) => items.map((item) => item.textContent));
  assert.deepEqual(buttons, ['1×', '1.1×', '1.25×', '1.5×', '1.75×', '2×']);
  await popup.locator('#presets [data-speed="1.1"]').click();
  await waitForRate(page, 1.1);
  assert.equal(await popup.locator('#presets [data-speed="1.1"]').getAttribute('aria-pressed'), 'true');

  // Removing down to one keeps the last; restoring brings the defaults back.
  await options.bringToFront();
  for (const speed of [1, 1.1, 1.25, 1.5, 1.75]) await options.locator(`#preset-list [data-speed="${speed}"] button`).click();
  await waitFor(async () => (await chips()).length === 1, 'one left');
  assert.equal(await options.locator('#preset-list [data-speed="2"] button').isDisabled(), true, 'the last preset cannot be removed');
  await options.locator('#reset-presets').click();
  await waitFor(async () => (await chips()).length === 8, 'defaults restored');
});

await test('Free plan (early access off): Pro features are marked, not applied, and saved data is kept', async () => {
  await control.evaluate(() =>
    chrome.storage.local.set({
      'e2e:earlyAccess': false,
      'speed:global': 1.25,
      settings: { siteDefaults: [{ host: '127.0.0.1', speed: 2 }], presets: [1.1, 1.3] },
    }),
  );
  const page = await open('video.html');
  await ready(page);
  await waitForRate(page, 1.25, '#v', '(remembered speed, the rule is not applied)');

  const popup = await openPopup(page);
  await popup.locator('#view-control').waitFor();
  assert.equal(await popup.locator('#presets button').count(), 8, 'standard presets');
  assert.equal(await popup.locator('#set-default').isDisabled(), true);
  assert.match(await popup.locator('#default-info').innerText(), /Pro: give each site its own start speed/);
  await popupShot(popup, join(outputDir, 'popup-free-plan.png'));
  const [aboutPro] = await Promise.all([context.waitForEvent('page'), popup.locator('#about-pro').click()]);
  openPages.add(aboutPro);
  await aboutPro.waitForLoadState();
  assert.match(aboutPro.url(), /options\.html#pro$/);

  const options = await newPage();
  await options.goto(`chrome-extension://${extensionId}/options.html`);
  await options.locator('#pro-status', { hasText: 'Free plan' }).waitFor();
  assert.equal(await options.locator('#site-defaults-locked').isVisible(), true);
  assert.equal(await options.locator('#presets-locked').isVisible(), true);
  assert.equal(await options.locator('#rule-add').isDisabled(), true);
  assert.equal(await options.locator('#preset-add').isDisabled(), true);
  assert.equal(await options.locator('#rules li[data-host="127.0.0.1"] input').isDisabled(), true);
  assert.equal(await options.locator('#get-pro').isDisabled(), true);
  await options.locator('#site-defaults-card').screenshot({ path: join(outputDir, 'options-free-locked.png') });
  // Saved data is kept.
  assert.deepEqual((await storage('settings')).siteDefaults, [{ host: '127.0.0.1', speed: 2 }]);
  assert.deepEqual((await storage('settings')).presets, [1.1, 1.3]);

  // The stored plan turns Pro on, live.
  await control.evaluate(() => chrome.storage.local.set({ plan: 'pro' }));
  await options.locator('#pro-status', { hasText: 'Pro is active' }).waitFor();
  assert.equal(await options.locator('#get-pro').isVisible(), false);
  assert.equal(await options.locator('#site-defaults-locked').isVisible(), false);
  const later = await open('video.html');
  await waitForRate(later, 2, '#v', '(rule applied with Pro)');
  const proPopup = await openPopup(later);
  await proPopup.locator('#view-control').waitFor();
  assert.equal(await proPopup.locator('#presets button').count(), 2, 'custom presets with Pro');
});

await test('Skip silence is not shipped: no Web Audio graph is attached to page media', async () => {
  const page = await open('video.html');
  await ready(page);
  await page.evaluate(() => {
    const video = document.getElementById('v');
    video.muted = true;
    return video.play();
  });
  await page.keyboard.press('d');
  await waitForRate(page, 1.1);
  // A MediaElementSource would reroute the element's audio; the page can still create its own.
  const ok = await page.evaluate(() => {
    const context = new AudioContext();
    try {
      context.createMediaElementSource(document.getElementById('v'));
      return true;
    } catch {
      return false;
    } finally {
      context.close();
    }
  });
  assert.equal(ok, true, 'the element is not captured by the extension');
});

await test('fullscreen: the controller moves into the fullscreen player and keeps working', async () => {
  const page = await open('fullscreen.html');
  await ready(page);
  await page.locator('#fs').click();
  await waitFor(() => page.evaluate(() => document.fullscreenElement?.id === 'player'), 'player is fullscreen');
  await waitFor(() => page.evaluate(() => document.querySelector('#player > video-speed-plus') !== null), 'UI moved into the fullscreen element');
  const middle = await center(page.locator('#v'));
  await page.mouse.move(middle.x, middle.y);
  await page.keyboard.press('d');
  await waitForRate(page, 1.1);
  await waitFor(async () => (await controller(page).getAttribute('data-state')) === 'active', 'controller visible in fullscreen');
  assert.ok(await bezel(page).isVisible());
  await shot(page, 'fullscreen');
  await page.keyboard.press('Escape');
  await page.evaluate(() => document.fullscreenElement && document.exitFullscreen());
  await waitFor(() => page.evaluate(() => !document.fullscreenElement), 'left fullscreen');
  await waitFor(() => page.evaluate(() => document.querySelector('html > video-speed-plus') !== null), 'UI back on <html>');
});

await test('hostile page (strict CSP, Trusted Types, aggressive CSS): controller keeps its own look', async () => {
  const page = await open('hostile.html');
  const errors = [];
  page.on('console', (message) => message.type() === 'error' && errors.push(message.text()));
  await ready(page);
  const middle = await center(page.locator('#v'));
  await page.mouse.move(middle.x, middle.y);
  await waitFor(async () => (await controller(page).getAttribute('data-state')) === 'active', 'controller shown');
  const style = await controller(page).evaluate((element) => {
    const css = getComputedStyle(element);
    return { font: css.fontFamily, height: css.height, radius: css.borderRadius };
  });
  assert.ok(!style.font.includes('Comic Sans'), style.font);
  assert.equal(style.height, '30px', 'rem-based sizes not blown up by html { font-size: 40px }');
  assert.equal(style.radius, '8px');
  const host = await page.locator('video-speed-plus').evaluate((element) => {
    const css = getComputedStyle(element);
    return { display: css.display, opacity: css.opacity };
  });
  assert.deepEqual(host, { display: 'block', opacity: '1' }, 'page CSS cannot hide the UI host');
  await page.keyboard.press('d');
  await waitForRate(page, 1.1);
  await sleep(300); // fade-in
  await shot(page, 'hostile');
  assert.deepEqual(errors, [], 'no CSP / Trusted Types errors');
});

await test('README screenshot: controller and indicator on a video page', async () => {
  await control.evaluate(() => chrome.storage.local.set({ 'speed:global': 1.5 }));
  const page = await open('demo.html');
  await ready(page);
  await waitForRate(page, 1.5);
  const middle = await center(page.locator('#v'));
  await page.mouse.move(middle.x, middle.y);
  await waitFor(async () => (await controller(page).getAttribute('data-state')) === 'active', 'controller shown');
  await controller(page).hover();
  await page.keyboard.press('g');
  await waitForRate(page, 1.8);
  await waitFor(() => bezel(page).evaluate((element) => getComputedStyle(element).opacity === '1'), 'indicator faded in');
  await page.screenshot({ path: join(screenshotDir, 'overlay.png'), clip: { x: 0, y: 0, width: 1280, height: 640 } });
});

await test('no network requests leave the extension', async () => {
  const requests = [];
  const listener = (request) => {
    const url = request.url();
    if (!url.startsWith(base) && !url.startsWith(alt) && !url.startsWith('chrome-extension://') && !url.startsWith('data:')) {
      requests.push(url);
    }
  };
  context.on('request', listener);
  const page = await open('video.html');
  await ready(page);
  await page.keyboard.press('d');
  const popup = await openPopup(page);
  await popup.locator('#view-control').waitFor();
  const options = await newPage();
  await options.goto(`chrome-extension://${extensionId}/options.html`);
  await options.evaluate(() => document.fonts.ready);
  context.off('request', listener);
  assert.deepEqual(requests, []);
});

await test('keyboard focus: a focused controller stays visible after the mouse leaves; Enter stays ours', async () => {
  const page = await open('video.html');
  await ready(page);
  const middle = await center(page.locator('#v'));
  await page.mouse.move(middle.x, middle.y);
  await controller(page).hover();
  await page.locator('video-speed-plus [data-action="slower"]').focus();
  await page.mouse.move(1200, 700);
  await sleep(2600);
  assert.equal(await controller(page).getAttribute('data-state'), 'idle');
  assert.equal(await controller(page).evaluate((element) => getComputedStyle(element).opacity), '1', 'focus keeps it visible');
  await page.keyboard.press('Enter');
  await waitForRate(page, 0.9);
  assert.deepEqual(await page.evaluate(() => window.stats.keys), [], 'Enter on our button did not reach the page');
});

// Runs last: reloading the extension closes its pages and orphans content scripts.
await test('extension reload: the orphaned content script removes its UI and stops handling keys', async () => {
  const page = await open('video.html');
  await ready(page);
  await control.evaluate(() => {
    setTimeout(() => chrome.runtime.reload(), 50);
  });
  await sleep(1500);
  await page.bringToFront();
  await page.keyboard.press('d');
  await sleep(200);
  assert.equal(await rate(page), 1, 'orphaned script did not act');
  assert.deepEqual(await page.evaluate(() => window.stats.keys), ['d'], 'the key reached the page');
  assert.equal(await page.locator('video-speed-plus').count(), 0, 'UI removed');
  // (Chrome started with --load-extension doesn't bring an extension back after
  // chrome.runtime.reload(), so the "fresh copy after a page reload" half can't run here.)
});

// --- Summary ----------------------------------------------------------------------------

await context.close();
server.close();
await rm(userDataDir, { recursive: true, force: true });

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed. Screenshots: ${screenshotDir}, debug: ${outputDir}`);
process.exit(failed.length ? 1 : 0);
