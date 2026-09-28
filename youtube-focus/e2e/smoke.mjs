// End-to-end smoke test: loads the e2e build (dist-e2e/) into a real Chromium and drives every
// user flow against local fixture pages that copy YouTube's element structure.
//
//   npm run test:e2e                      (set CHROMIUM_PATH if Chromium isn't auto-detected)
//
// The fixture server answers on 127.0.0.1 with a www.youtube.com-like SPA (ytd-* elements) and on
// localhost with an m.youtube.com-like one (ytm-*). Only the e2e build's manifest adds those two
// origins to the content script; dist/ matches YouTube only (checked below). Time is controlled
// through the e2e-only `e2e:clockOffset` storage key, the plan through `e2e:earlyAccess`.
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

// --- Fixture server ---------------------------------------------------------------------

const CONTENT_TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  const mobile = (request.headers.host ?? '').startsWith('localhost');
  const file = url.pathname.startsWith('/_fixtures/') ? url.pathname.slice('/_fixtures/'.length) : mobile ? 'mobile.html' : 'desktop.html';
  try {
    const body = await readFile(join(fixtures, file));
    response.writeHead(200, { 'content-type': CONTENT_TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' }).end(body);
  } catch {
    response.writeHead(404).end('not found');
  }
});
await new Promise((resolve) => server.listen(0, resolve));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;
const mobileBase = `http://localhost:${port}`;

// --- Browser ----------------------------------------------------------------------------

await mkdir(outputDir, { recursive: true });
await mkdir(screenshotDir, { recursive: true });
const extensionId = (await readFile(join(extensionPath, 'e2e-extension-id.txt'), 'utf8')).trim();
const userDataDir = await mkdtemp(join(tmpdir(), 'youtube-focus-e2e-'));
const context = await chromium.launchPersistentContext(userDataDir, {
  executablePath: findChromium(),
  headless,
  viewport: { width: 1280, height: 800 },
  args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  // Times shown in the browser's own zone (popup, "This computer") are asserted in UTC.
  env: { ...process.env, TZ: 'UTC' },
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

/** How many times the content script has applied settings on this page (e2e marker). */
const applies = (page) => page.evaluate(() => Number(document.documentElement.getAttribute('data-ytf-e2e') ?? 0));

/** Opens a fixture page and waits until the content script has applied its settings. */
async function open(path, { host = base } = {}) {
  const page = await newPage();
  await page.goto(`${host}${path}`);
  await page.bringToFront();
  await waitFor(async () => (await applies(page)) > 0, `content script applied on ${path}`);
  return page;
}

/**
 * Visible elements per selector: [matched, visible]. Visibility is Chrome's own
 * checkVisibility(), so a hidden ancestor counts too.
 */
async function counts(page, selector) {
  return page.evaluate((selector) => {
    const all = [...document.querySelectorAll(selector)];
    return [all.length, all.filter((element) => element.checkVisibility()).length];
  }, selector);
}

async function expectHidden(page, selector, message = '') {
  await waitFor(async () => {
    const [matched, visible] = await counts(page, selector);
    return matched > 0 && visible === 0;
  }, `${selector} hidden ${message}`);
}

async function expectVisible(page, selector, message = '') {
  await waitFor(async () => {
    const [matched, visible] = await counts(page, selector);
    return matched > 0 && visible === matched;
  }, `${selector} visible ${message}`);
}

const hideAttr = (page) => page.evaluate(() => document.documentElement.getAttribute('data-ytf-hide'));
const routeAttr = (page) => page.evaluate(() => document.documentElement.getAttribute('data-ytf-route'));
const panel = (page) => page.locator('youtube-focus-panel .card');

async function setSettings(patch) {
  await control.evaluate(async (patch) => {
    const { settings = {} } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...settings, ...patch } });
  }, patch);
}

async function setHide(patch) {
  await control.evaluate(async (patch) => {
    const { settings = {} } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...settings, hide: { ...(settings.hide ?? {}), ...patch } } });
  }, patch);
}

async function storedSettings() {
  return control.evaluate(async () => (await chrome.storage.local.get('settings')).settings);
}

/** Moves the extension's clock so that it reads `iso` (e2e build only). */
async function setClock(iso) {
  const target = Date.parse(iso);
  await control.evaluate((offset) => chrome.storage.local.set({ 'e2e:clockOffset': offset }), target - Date.now());
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
  const tabId = page ? await tabIdOf(page) : -1;
  const popup = await newPage();
  await popup.emulateMedia({ colorScheme });
  await popup.setViewportSize({ width: 360, height: 600 });
  await popup.goto(`chrome-extension://${extensionId}/popup.html?tab=${tabId}`);
  await waitFor(async () => (await popup.locator('#status-text').innerText()) !== 'Loading…', 'popup rendered');
  return popup;
}

async function openOptions({ colorScheme = 'light', hash = '' } = {}) {
  const options = await newPage();
  await options.emulateMedia({ colorScheme });
  await options.setViewportSize({ width: 900, height: 900 });
  await options.goto(`chrome-extension://${extensionId}/options.html${hash}`);
  await options.locator('#features input').first().waitFor();
  return options;
}

const popupShot = (popup, file) => popup.locator('body').screenshot({ path: file });

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
    const last = [...openPages].at(-1);
    if (last && !last.isClosed()) await last.screenshot({ path: join(outputDir, `fail-${results.length}.png`) }).catch(() => undefined);
  } finally {
    for (const page of openPages) await page.close().catch(() => undefined);
    openPages.clear();
  }
}

console.log(`Chromium ${context.browser()?.version() ?? ''} · extension ${extensionId}\n`);

await test('manifest: production matches YouTube only, only "storage", no background; test hooks compiled out', async () => {
  const manifest = JSON.parse(await readFile(join(root, 'dist/manifest.json'), 'utf8'));
  assert.deepEqual(manifest.permissions, ['storage']);
  assert.equal(manifest.host_permissions, undefined);
  assert.equal(manifest.optional_permissions, undefined);
  assert.equal(manifest.background, undefined);
  assert.equal(manifest.key, undefined);
  assert.equal(manifest.name, 'YouTube Focus');
  assert.deepEqual(manifest.content_scripts, [
    { matches: ['https://www.youtube.com/*', 'https://m.youtube.com/*'], css: ['content.css'], js: ['content.js'], run_at: 'document_start' },
  ]);
  for (const file of ['content.js', 'popup.js', 'options.js']) {
    const code = await readFile(join(root, 'dist', file), 'utf8');
    for (const hook of ['e2e:', 'data-ytf-e2e', '127.0.0.1', 'localhost', "get('tab')"]) {
      assert.ok(!code.includes(hook), `dist/${file} contains the test hook ${hook}`);
    }
  }
  const panelCode = await readFile(join(root, 'dist/content.js'), 'utf8');
  assert.match(panelCode, /mode: "closed"/, 'production panel uses a closed shadow root');

  const e2eManifest = JSON.parse(await readFile(join(extensionPath, 'manifest.json'), 'utf8'));
  assert.deepEqual(e2eManifest.content_scripts[0].matches, ['https://www.youtube.com/*', 'https://m.youtube.com/*', 'http://127.0.0.1/*', 'http://localhost/*']);
  assert.match(await readFile(join(extensionPath, 'content.js'), 'utf8'), /e2e:clockOffset/);
});

await test('content.css: every generated rule parses in Chromium (no selector silently dropped)', async () => {
  const css = await readFile(join(root, 'dist/content.css'), 'utf8');
  const expected = css.split('\n').filter((line) => line.startsWith('html')).length;
  const page = await open('/feed/history');
  const parsed = await page.evaluate((css) => {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    return sheet.cssRules.length;
  }, css);
  assert.equal(parsed, expected);
  assert.ok(expected > 40, `${expected} rules`);
});

await test('defaults on the home page: feed hidden, calm panel, Shorts entry gone, navigation kept', async () => {
  const page = await open('/');
  assert.equal(await routeAttr(page), 'home');
  assert.equal(await hideAttr(page), 'endscreen home related shorts');
  await expectHidden(page, 'ytd-browse[page-subtype="home"] ytd-rich-grid-renderer');
  await expectHidden(page, 'ytd-guide-entry-renderer:has(a[title="Shorts"])');
  await expectVisible(page, 'ytd-guide-entry-renderer:has(a[title="Subscriptions"])');
  await expectVisible(page, 'ytd-guide-section-renderer#guide-explore');
  await expectVisible(page, '#search input');
  await panel(page).waitFor();
  assert.match(await panel(page).innerText(), /Your home feed is hidden/);
  assert.equal(await panel(page).locator('a.primary').getAttribute('href'), '/feed/subscriptions');
  await page.screenshot({ path: join(screenshotDir, 'home-calm-light.png') });

  // YouTube's own dark theme (html[dark]) switches the panel, not the OS setting.
  await page.evaluate(() => document.documentElement.setAttribute('dark', ''));
  await waitFor(async () => (await page.locator('youtube-focus-panel').getAttribute('data-theme')) === 'dark', 'panel follows dark theme');
  await page.screenshot({ path: join(screenshotDir, 'home-calm-dark.png') });

  // The panel's link is a real link.
  await panel(page).locator('a.primary').click();
  await page.waitForURL(`${base}/feed/subscriptions`);
  await waitFor(async () => (await routeAttr(page)) === 'subscriptions', 'route updated');
  assert.equal(await page.locator('youtube-focus-panel').count(), 0, 'panel gone off the home page');
});

await test('subscriptions and search: Shorts shelves and Shorts results hidden, everything else shown', async () => {
  const page = await open('/feed/subscriptions');
  await expectHidden(page, 'ytd-rich-shelf-renderer[is-shorts]');
  await expectHidden(page, 'ytd-rich-section-renderer');
  await expectHidden(page, 'ytd-rich-item-renderer[data-short]');
  await expectVisible(page, 'ytd-rich-item-renderer[data-video]');
  await expectVisible(page, 'ytd-browse[page-subtype="subscriptions"] ytd-rich-grid-renderer', '(home rule is route-gated)');

  await page.evaluate(() => window.fixtureNavigate('/results?search_query=linear+algebra'));
  await waitFor(async () => (await routeAttr(page)) === 'search', 'search route');
  await expectHidden(page, 'ytd-video-renderer[data-short]');
  await expectHidden(page, 'ytd-reel-shelf-renderer');
  await expectVisible(page, 'ytd-video-renderer[data-video]');
  await expectVisible(page, 'ytd-shelf-renderer', '(only subscriptions-only hides search suggestions)');
});

await test('watch page: Up next and end screens hidden by default, comments shown; every switch applies live', async () => {
  // README "before" picture: the same page with focus mode off.
  await setSettings({ enabled: false });
  const page = await open('/watch?v=noise000001');
  await expectVisible(page, '#related');
  await page.screenshot({ path: join(screenshotDir, 'watch-before.png') });
  await setSettings({ enabled: true });
  await expectHidden(page, '#related');
  await expectHidden(page, '.ytp-ce-element');
  await expectHidden(page, '.ytp-endscreen-content');
  await expectHidden(page, '.ytp-autonav-endscreen-countdown-overlay');
  await expectVisible(page, 'ytd-comments#comments');
  await expectVisible(page, '.video-surface');

  await setHide({ comments: true });
  await expectHidden(page, 'ytd-comments#comments', 'after switching comments on');
  await page.screenshot({ path: join(screenshotDir, 'watch-focused.png') });
  await setHide({ related: false });
  await expectVisible(page, '#related', 'after switching Up next off');
  await setHide({ endscreen: false });
  await expectVisible(page, '.ytp-ce-element', 'after switching end screens off');
  await expectVisible(page, '.ytp-autonav-endscreen-countdown-overlay');
  await setHide({ comments: false, related: true });
  await expectVisible(page, 'ytd-comments#comments');
  await expectHidden(page, '#related');
  assert.equal(page.url(), `${base}/watch?v=noise000001`, 'never reloaded');
});

await test('home and Shorts switches apply live; the popup switches write the same settings', async () => {
  const page = await open('/');
  const popup = await openPopup(page);
  await popup.locator('#hide-home').uncheck();
  await expectVisible(page, 'ytd-browse[page-subtype="home"] ytd-rich-grid-renderer', 'after the popup switch');
  await waitFor(async () => (await page.locator('youtube-focus-panel').count()) === 0, 'panel removed');
  await popup.locator('#hide-shorts').uncheck();
  await expectVisible(page, 'ytd-rich-shelf-renderer[is-shorts]');
  await expectVisible(page, 'ytd-guide-entry-renderer:has(a[title="Shorts"])');
  assert.deepEqual((await storedSettings()).hide, { shorts: false, home: false, related: true, endscreen: true, comments: false });
  await popup.locator('#hide-home').check();
  await popup.locator('#hide-shorts').check();
  await expectHidden(page, 'ytd-browse[page-subtype="home"] ytd-rich-grid-renderer');
  await expectHidden(page, 'ytd-rich-shelf-renderer[is-shorts]');
  await panel(page).waitFor();
});

await test('master switch: off shows YouTube untouched (no attributes, no panel), on hides again', async () => {
  const page = await open('/');
  const popup = await openPopup(page);
  assert.equal(await popup.locator('#enabled').isChecked(), true);
  await popup.locator('#enabled').uncheck();
  await expectVisible(page, 'ytd-rich-grid-renderer');
  await expectVisible(page, 'ytd-guide-entry-renderer');
  await waitFor(async () => (await hideAttr(page)) === null, 'no hide attribute');
  assert.equal(await page.locator('youtube-focus-panel').count(), 0);
  assert.match(await popup.locator('#status-text').innerText(), /^Off/);
  assert.equal(await popup.locator('#pause').isDisabled(), true);
  await popup.locator('#enabled').check();
  await expectHidden(page, 'ytd-rich-grid-renderer');
  await panel(page).waitFor();
});

await test('SPA navigation: yt-navigate-finish, URL changes without it (Navigation API), and back/forward', async () => {
  const page = await open('/watch?v=study000001');
  await expectHidden(page, '#related');
  assert.equal(await page.locator('youtube-focus-panel').count(), 0);
  const before = await applies(page);
  await page.locator('ytd-guide-entry-renderer a[title="Home"]').click(); // client-side, with yt-navigate-finish
  await waitFor(async () => (await routeAttr(page)) === 'home', 'route home');
  await panel(page).waitFor();
  await expectHidden(page, 'ytd-rich-grid-renderer');
  assert.ok((await applies(page)) > before, 'applied again');

  await page.evaluate(() => window.fixtureNavigate('/results?search_query=x', { event: false }));
  await waitFor(async () => (await routeAttr(page)) === 'search', 'route search without yt-navigate-finish');
  await waitFor(async () => (await page.locator('youtube-focus-panel').count()) === 0, 'panel removed');

  await page.goBack();
  await waitFor(async () => (await routeAttr(page)) === 'home', 'back to home (popstate)');
  await panel(page).waitFor();
  await page.goBack();
  await waitFor(async () => (await routeAttr(page)) === 'watch', 'back to the video');
  assert.equal(page.url(), `${base}/watch?v=study000001`);
});

await test('redirects: home → Subscriptions (option), Shorts → normal player; none when switched off', async () => {
  await setSettings({ homeMode: 'subscriptions' });
  let page = await open('/');
  await page.waitForURL(`${base}/feed/subscriptions`);
  await waitFor(async () => (await routeAttr(page)) === 'subscriptions', 'on subscriptions');
  // A client-side navigation to Home is redirected too.
  await page.evaluate(() => window.fixtureNavigate('/'));
  await page.waitForURL(`${base}/feed/subscriptions`);

  page = await open('/shorts/shortAAAA001');
  await page.waitForURL(`${base}/watch?v=shortAAAA001`);

  // The popup's radio buttons choose the mode.
  const popup = await openPopup(page);
  await popup.locator('[data-mode="calm"]').click();
  await waitFor(async () => (await storedSettings()).homeMode === 'calm', 'calm saved');
  assert.equal(await popup.locator('[data-mode="calm"]').getAttribute('aria-checked'), 'true');

  await setHide({ shorts: false });
  page = await open('/shorts/shortAAAA002');
  await sleep(300);
  assert.equal(page.url(), `${base}/shorts/shortAAAA002`, 'no redirect with Shorts shown');
  page = await open('/');
  await panel(page).waitFor();
  assert.equal(page.url(), `${base}/`);
});

await test('pause for 15 minutes: everything comes back, and hides again when the pause ends', async () => {
  const page = await open('/watch?v=noise000001');
  await expectHidden(page, '#related');
  const popup = await openPopup(page);
  assert.equal(await popup.locator('#pause').innerText(), 'Pause 15 min');
  await popup.locator('#pause').click();
  await expectVisible(page, '#related', 'while paused');
  await expectVisible(page, '.ytp-ce-element', 'while paused');
  await waitFor(async () => /^Paused until \d\d:\d\d$/.test(await popup.locator('#status-text').innerText()), 'popup says paused');
  assert.equal(await popup.locator('#pause').innerText(), 'Resume now');
  const { pausedUntil } = await storedSettings();
  assert.ok(Math.abs(pausedUntil - Date.now() - 15 * 60_000) < 5000, 'paused for 15 minutes');
  await popupShot(popup, join(outputDir, 'popup-paused.png'));

  // 14 minutes later: still paused. 16 minutes later: focused again, without a reload.
  await setClock(new Date(Date.now() + 14 * 60_000).toISOString());
  await sleep(300);
  await expectVisible(page, '#related', 'after 14 minutes');
  await setClock(new Date(Date.now() + 16 * 60_000).toISOString());
  await expectHidden(page, '#related', 'after 16 minutes');
  await waitFor(async () => (await popup.locator('#status-text').innerText()) === 'On', 'popup back to On');

  // Back to the real time: the pause is running again. Resume now ends it early.
  await control.evaluate(() => chrome.storage.local.remove('e2e:clockOffset'));
  await expectVisible(page, '#related', 'paused again at the real time');
  await waitFor(async () => (await popup.locator('#pause').innerText()) === 'Resume now', 'resume button');
  await popup.locator('#pause').click();
  await expectHidden(page, '#related', 'after Resume now');
  assert.equal((await storedSettings()).pausedUntil, 0);
});

await test('pause end is timed by the page itself (no storage change, no navigation)', async () => {
  const page = await open('/watch?v=noise000001');
  await setSettings({ pausedUntil: Date.now() + 1500 });
  await expectVisible(page, '#related', 'while paused');
  const started = Date.now();
  await expectHidden(page, '#related', 'when the pause runs out');
  assert.ok(Date.now() - started >= 800, 'not before the pause ended');
});

await test('focus schedule: on inside the hours, off outside, overnight ranges, time zones (controlled clock)', async () => {
  // 2026-09-30 is a Wednesday.
  await setSettings({ schedule: { enabled: true, days: [1, 2, 3, 4, 5], start: 540, end: 1020, timeZone: 'UTC' } });
  await setClock('2026-09-30T10:00:00Z');
  const page = await open('/watch?v=noise000001');
  await expectHidden(page, '#related', 'Wed 10:00 UTC');
  const popup = await openPopup(page);
  await waitFor(async () => (await popup.locator('#status-text').innerText()) === 'On · until 17:00', 'popup shows until');

  await setClock('2026-09-30T18:00:00Z');
  await expectVisible(page, '#related', 'Wed 18:00 UTC');
  await waitFor(async () => (await popup.locator('#status-text').innerText()) === 'Off until tomorrow 09:00', 'popup says off until');
  assert.equal(await popup.locator('#status').getAttribute('title'), 'Outside your focus schedule');
  await setClock('2026-10-03T10:00:00Z');
  await expectVisible(page, '#related', 'Saturday');

  // Same instant, different zone: 18:00 UTC is 11:00 in Los Angeles.
  await setSettings({ schedule: { enabled: true, days: [3], start: 540, end: 1020, timeZone: 'America/Los_Angeles' } });
  await setClock('2026-09-30T18:00:00Z');
  await expectHidden(page, '#related', '11:00 in Los Angeles');

  // Overnight: Friday 22:00 → Saturday 06:00.
  await setSettings({ schedule: { enabled: true, days: [5], start: 1320, end: 360, timeZone: 'UTC' } });
  await setClock('2026-10-03T02:00:00Z');
  await expectHidden(page, '#related', 'Saturday 02:00 (Friday night)');
  await setClock('2026-10-03T07:00:00Z');
  await expectVisible(page, '#related', 'Saturday 07:00');
  await setClock('2026-10-02T21:59:00Z');
  await expectVisible(page, '#related', 'Friday 21:59');
  await setClock('2026-10-02T22:00:00Z');
  await expectHidden(page, '#related', 'Friday 22:00');
});

await test('focus schedule: built in Settings (days, times, time zone) with a live status line', async () => {
  await setClock('2026-09-30T10:00:00Z'); // Wednesday
  const page = await open('/watch?v=noise000001');
  const options = await openOptions({ hash: '#schedule' });
  await options.locator('#schedule-enabled').check();
  await options.locator('#time-zone').selectOption('UTC');
  await waitFor(async () => (await options.locator('#schedule-status-text').innerText()) === 'In focus hours now · until 17:00', 'status: in focus hours');
  await expectHidden(page, '#related');

  // Drop Wednesday: outside the schedule now.
  await options.locator('[data-day="3"]').click();
  await waitFor(async () => (await options.locator('#schedule-status-text').innerText()) === 'Outside focus hours · starts tomorrow 09:00', 'status: outside');
  await expectVisible(page, '#related', 'Wednesday unchecked');
  assert.equal(await options.locator('[data-day="3"]').getAttribute('aria-pressed'), 'false');

  // Overnight 22:00–06:00 on Tuesday and Wednesday, clock Wed 02:00: inside Tuesday's night.
  await options.locator('[data-day="3"]').click();
  await options.locator('#start').fill('22:00');
  await options.locator('#start').dispatchEvent('change');
  await options.locator('#end').fill('06:00');
  await options.locator('#end').dispatchEvent('change');
  await setClock('2026-09-30T02:00:00Z');
  await waitFor(async () => (await options.locator('#schedule-status-text').innerText()) === 'In focus hours now · until 06:00', 'status: overnight');
  await expectHidden(page, '#related', 'overnight window');
  const { schedule } = await storedSettings();
  assert.deepEqual(schedule, { enabled: true, days: [1, 2, 3, 4, 5], start: 1320, end: 360, timeZone: 'UTC' });
  await options.locator('#schedule').screenshot({ path: join(outputDir, 'options-schedule.png') });
});

await test('channel allowlist: comments, Up next and end screens stay on allowed channels’ videos, across SPA navigation', async () => {
  await setHide({ comments: true });
  const options = await openOptions();
  await options.locator('#allow-input').fill('not a channel');
  await options.locator('#allow-add').click();
  assert.match(await options.locator('#allow-error').innerText(), /doesn't look like a channel/);
  await options.locator('#allow-input').fill('https://www.youtube.com/@CalmCoding/videos');
  await options.locator('#allow-add').click();
  await options.locator('#allowlist li[data-channel="@calmcoding"]').waitFor();
  await options.locator('#allow-input').fill('@calmcoding');
  await options.locator('#allow-add').click();
  assert.match(await options.locator('#allow-error').innerText(), /already on the list/);

  const page = await open('/watch?v=focus000001');
  await expectVisible(page, 'ytd-comments#comments', 'allowed channel');
  await expectVisible(page, '#related', 'allowed channel');
  await expectVisible(page, '.ytp-ce-element', 'allowed channel');
  assert.equal(await hideAttr(page), 'home shorts');

  // The fixture keeps the old channel for 300 ms after navigating, like YouTube.
  await page.evaluate(() => window.fixtureNavigate('/watch?v=noise000001'));
  await expectHidden(page, 'ytd-comments#comments', 'other channel');
  await expectHidden(page, '#related', 'other channel');
  await waitFor(async () => (await page.locator('ytd-channel-name a').innerText()) === 'Loud Clips', 'new metadata rendered');
  await sleep(300);
  await expectHidden(page, 'ytd-comments#comments', 'stays hidden once the new channel is known');

  await page.evaluate(() => window.fixtureNavigate('/watch?v=focus000002'));
  await expectVisible(page, 'ytd-comments#comments', 'back to an allowed channel');

  // Removing it in Settings hides them again, live.
  await options.locator('#allowlist li[data-channel="@calmcoding"] button').click();
  await expectHidden(page, 'ytd-comments#comments', 'after removing the channel');
});

await test('popup: "Allow this channel" on a watch page adds and removes the current channel', async () => {
  await setHide({ comments: true });
  const page = await open('/watch?v=noise000001');
  await expectHidden(page, 'ytd-comments#comments');
  const popup = await openPopup(page);
  await popup.locator('#channel-row').waitFor();
  assert.equal(await popup.locator('#channel-name').innerText(), 'Loud Clips · @loudclips');
  await popup.locator('#channel-allow').check();
  await expectVisible(page, 'ytd-comments#comments', 'after allowing');
  assert.deepEqual((await storedSettings()).allowlist, [{ id: null, handle: '@loudclips', name: 'Loud Clips' }]);
  await popup.locator('#channel-allow').uncheck();
  await expectHidden(page, 'ytd-comments#comments', 'after removing');
  assert.deepEqual((await storedSettings()).allowlist, []);
});

await test('subscriptions-only mode: home and Explore go to Subscriptions; suggestions, Explore and Home entries hidden', async () => {
  const popupHost = await open('/feed/history');
  const popup = await openPopup(popupHost);
  await popup.locator('#subs-only').check();
  await waitFor(async () => (await storedSettings())?.subscriptionsOnly === true, 'saved');
  assert.equal(await popup.locator('#hide-comments').isChecked(), true, 'all switches shown on');
  assert.equal(await popup.locator('#hide-comments').isDisabled(), true);

  let page = await open('/');
  await page.waitForURL(`${base}/feed/subscriptions`);
  await waitFor(async () => (await routeAttr(page)) === 'subscriptions', 'subscriptions');
  await expectHidden(page, 'ytd-guide-section-renderer#guide-explore');
  await expectHidden(page, 'ytd-guide-entry-renderer:has(a[title="Home"])');
  await expectVisible(page, 'ytd-guide-entry-renderer:has(a[title="Subscriptions"])');
  await expectVisible(page, 'ytd-rich-item-renderer[data-video]');
  await expectHidden(page, 'ytd-rich-item-renderer[data-short]');

  page = await open('/feed/trending');
  await page.waitForURL(`${base}/feed/subscriptions`);

  await page.evaluate(() => window.fixtureNavigate('/results?search_query=x'));
  await expectHidden(page, 'ytd-shelf-renderer', '(People also watched)');
  await expectHidden(page, 'ytd-horizontal-card-list-renderer');
  await expectVisible(page, 'ytd-section-list-renderer > ytd-video-renderer[data-video]');

  await page.evaluate(() => window.fixtureNavigate('/watch?v=noise000001'));
  await expectHidden(page, 'ytd-comments#comments');
  await expectHidden(page, '#related');
});

await test('free plan (early access off): Pro settings are kept but not applied, with a calm note', async () => {
  await control.evaluate(() => chrome.storage.local.set({ 'e2e:earlyAccess': false }));
  await setHide({ comments: true });
  await setSettings({
    subscriptionsOnly: true,
    schedule: { enabled: true, days: [6], start: 0, end: 60, timeZone: 'UTC' },
    allowlist: [{ id: null, handle: '@calmcoding', name: 'Calm Coding' }],
  });
  await setClock('2026-09-30T10:00:00Z'); // outside the schedule: ignored on free
  let page = await open('/');
  await panel(page).waitFor(); // no subscriptions-only redirect
  assert.equal(page.url(), `${base}/`);
  page = await open('/watch?v=focus000001');
  await expectHidden(page, 'ytd-comments#comments', 'allowlist not applied');
  await expectHidden(page, '#related', 'schedule not applied');

  const popup = await openPopup(page);
  assert.equal(await popup.locator('#subs-only').isDisabled(), true);
  assert.equal(await popup.locator('#channel-allow').isDisabled(), true);
  await waitFor(async () => /is part of YouTube Focus Pro \(\$1\.99 once\)/.test(await popup.locator('#pro-note').innerText()), 'pro note');

  const options = await openOptions();
  await waitFor(async () => (await options.locator('#pro-state').innerText()) === 'Payments aren’t set up yet', 'about pro state');
  assert.equal(await options.locator('#schedule-enabled').isDisabled(), true);
  assert.equal(await options.locator('#allow-input').isDisabled(), true);
  assert.match(await options.locator('#schedule-pro').innerText(), /Focus schedule is part of YouTube Focus Pro/);
  assert.equal(await options.locator('#allowlist li').count(), 1, 'allowlist kept, not deleted');
  assert.equal(await options.locator('#get-pro').isDisabled(), true);

  // Early access back on: everything applies again, live.
  await control.evaluate(() => chrome.storage.local.set({ 'e2e:earlyAccess': true }));
  await expectVisible(page, 'ytd-comments#comments', 'allowlist applies again');
});

await test('m.youtube.com structure: Shorts, home feed, Up next and comments hidden on ytm-* pages', async () => {
  await setHide({ comments: true });
  const page = await newPage();
  await page.setViewportSize({ width: 420, height: 820 });
  await page.goto(`${mobileBase}/`);
  await waitFor(async () => (await applies(page)) > 0, 'applied');
  await expectHidden(page, 'ytm-browse ytm-rich-grid-renderer');
  await expectHidden(page, 'ytm-feed-filter-chip-bar-renderer');
  await expectHidden(page, 'ytm-pivot-bar-item-renderer:has(.pivot-shorts)');
  await expectVisible(page, 'ytm-pivot-bar-item-renderer:has(.pivot-subs)');
  await panel(page).waitFor();
  await page.screenshot({ path: join(outputDir, 'mobile-home.png') });

  await page.locator('ytm-pivot-bar-item-renderer a[href="/feed/subscriptions"]').click();
  await waitFor(async () => (await routeAttr(page)) === 'subscriptions', 'subscriptions');
  await expectVisible(page, 'ytm-rich-grid-renderer');
  await expectHidden(page, 'ytm-rich-item-renderer[data-short]');
  await expectHidden(page, 'ytm-reel-shelf-renderer');
  await expectVisible(page, 'ytm-video-with-context-renderer[data-video]');

  await page.evaluate(() => window.fixtureNavigate('/watch?v=noise000001'));
  await expectHidden(page, 'ytm-item-section-renderer[section-identifier="related-items"]');
  await expectHidden(page, 'ytm-comments-entry-point-header-renderer');
  await expectHidden(page, '.ytp-ce-element');
  await expectVisible(page, 'ytm-slim-owner-renderer');

  // The allowlist reads the channel from ytm-slim-owner-renderer.
  await setSettings({ allowlist: [{ id: null, handle: '@loudclips', name: 'Loud Clips' }] });
  await expectVisible(page, 'ytm-comments-entry-point-header-renderer', 'allowed channel on m.');
});

await test('popup: screenshots (light and dark) and a non-YouTube tab', async () => {
  await setHide({ comments: true });
  await setSettings({
    schedule: { enabled: true, days: [1, 2, 3, 4, 5], start: 540, end: 1020, timeZone: '' },
    allowlist: [{ id: null, handle: '@calmcoding', name: 'Calm Coding' }],
  });
  // Wednesday 10:00 in the browser's own time zone (UTC here), inside the schedule.
  await control.evaluate((offset) => chrome.storage.local.set({ 'e2e:clockOffset': offset }), Date.UTC(2026, 8, 30, 10, 0) - Date.now());
  const page = await open('/watch?v=focus000001');
  const light = await openPopup(page);
  await light.locator('#channel-row').waitFor();
  await waitFor(async () => (await light.locator('#channel-allow').isChecked()) === true, 'channel shown as allowed');
  assert.equal(await light.locator('#status-text').innerText(), 'On · until 17:00');
  await light.evaluate(() => document.fonts.ready);
  await popupShot(light, join(screenshotDir, 'popup-light.png'));
  const dark = await openPopup(page, { colorScheme: 'dark' });
  await dark.locator('#channel-row').waitFor();
  await dark.locator('#pause').click();
  await waitFor(async () => /^Paused until/.test(await dark.locator('#status-text').innerText()), 'paused');
  await dark.evaluate(() => document.fonts.ready);
  await popupShot(dark, join(screenshotDir, 'popup-dark.png'));
  const height = await dark.evaluate(() => document.body.scrollHeight);
  assert.ok(height <= 600, `popup fits Chrome's 600 px limit (${height})`);
  const width = await dark.evaluate(() => document.documentElement.scrollWidth);
  assert.ok(width <= 360, `no horizontal scroll (${width})`);

  // A tab without the content script (here: an extension page): no channel row, no error.
  const other = await openPopup(null);
  await sleep(200);
  assert.equal(await other.locator('#channel-row').isHidden(), true);
  assert.equal(await other.locator('#error').isHidden(), true);
});

await test('options: screenshots (light and dark), settings persist', async () => {
  await setSettings({ allowlist: [{ id: null, handle: '@calmcoding', name: 'Calm Coding' }, { id: 'UC_x5XG1OV2P6uZZ5FSM9Ttw', handle: null, name: 'Open Lectures' }] });
  for (const colorScheme of ['light', 'dark']) {
    const options = await openOptions({ colorScheme });
    await options.locator('#allowlist li').nth(1).waitFor();
    await options.evaluate(() => document.fonts.ready);
    await options.screenshot({ path: join(screenshotDir, `options-${colorScheme}.png`), fullPage: true });
  }
  const options = await openOptions();
  await options.locator('#hide-comments').check();
  await options.locator('#home-subscriptions').check();
  await waitFor(async () => (await storedSettings()).homeMode === 'subscriptions', 'saved');
  await options.reload();
  await options.locator('#features input').first().waitFor();
  await waitFor(async () => (await options.locator('#hide-comments').isChecked()) && (await options.locator('#home-subscriptions').isChecked()), 'persisted');
});

await test('no network requests leave the extension', async () => {
  const requests = [];
  const listener = (request) => {
    const url = request.url();
    if (!url.startsWith(base) && !url.startsWith(mobileBase) && !url.startsWith('chrome-extension://') && !url.startsWith('data:')) requests.push(url);
  };
  context.on('request', listener);
  const page = await open('/');
  await panel(page).waitFor();
  await page.evaluate(() => window.fixtureNavigate('/watch?v=focus000001'));
  const popup = await openPopup(page);
  await popup.locator('#pause').click();
  const options = await openOptions();
  await options.evaluate(() => document.fonts.ready);
  context.off('request', listener);
  assert.deepEqual(requests, []);
});

// Runs last: reloading the extension closes its pages and orphans content scripts.
await test('extension reload: the orphaned content script puts YouTube back as it was', async () => {
  const page = await open('/');
  await panel(page).waitFor();
  await control.evaluate(() => {
    setTimeout(() => chrome.runtime.reload(), 50);
  });
  await sleep(1500);
  await page.evaluate(() => window.fixtureNavigate('/watch?v=noise000001'));
  await waitFor(async () => (await hideAttr(page)) === null && (await routeAttr(page)) === null, 'attributes removed');
  assert.equal(await page.locator('youtube-focus-panel').count(), 0, 'panel removed');
  await expectVisible(page, '#related');
});

// --- Summary ----------------------------------------------------------------------------

await context.close();
server.close();
await rm(userDataDir, { recursive: true, force: true });

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed. Screenshots: ${screenshotDir}, debug: ${outputDir}`);
process.exit(failed.length ? 1 : 0);
