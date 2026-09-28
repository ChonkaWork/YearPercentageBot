// End-to-end smoke test: loads the e2e build (dist-e2e/) into a real Chromium and drives the new
// tab page: progress rows, countdowns, settings, errors, themes and screenshots.
//
//   npm run test:e2e        (set CHROMIUM_PATH if Chromium isn't auto-detected, HEADED=1 to watch)
//
// The browser runs in Europe/Kyiv (override with E2E_TZ) with an en-GB locale. Node uses the same
// zone, so expected values computed here match what the page computes.

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const zone = process.env.E2E_TZ ?? 'Europe/Kyiv';
process.env.TZ = zone;

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const extensionPath = join(root, 'dist-e2e');
const outputDir = join(root, 'e2e/output');
const screenshotsDir = join(root, 'screenshots');
const headless = process.env.HEADED !== '1';

function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const candidates = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  const found = candidates.find((path) => existsSync(path));
  if (!found) throw new Error('Chromium not found. Set CHROMIUM_PATH.');
  return found;
}

// --- Browser ----------------------------------------------------------------------------

await mkdir(outputDir, { recursive: true });
await mkdir(screenshotsDir, { recursive: true });
const userDataDir = await mkdtemp(join(tmpdir(), 'progress-tab-e2e-'));
const context = await chromium.launchPersistentContext(userDataDir, {
  executablePath: findChromium(),
  headless,
  viewport: { width: 1280, height: 800 },
  timezoneId: zone,
  locale: 'en-GB',
  // The format of <input type="date"> follows the browser's UI language (LANG on Linux).
  env: { ...process.env, LANG: 'en_GB.UTF-8', LANGUAGE: 'en_GB' },
  args: ['--lang=en-GB', `--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
});

// chrome://newtab shows the override; its real URL gives us the extension id.
const probe = await context.newPage();
await probe.goto('chrome://newtab');
await probe.waitForURL(/^chrome-extension:\/\//);
const newtabUrl = probe.url();
const extensionId = new URL(newtabUrl).host;
await probe.close();

const openPages = new Set();
/** Console errors and uncaught exceptions per page; any of them fails the test. */
const pageErrors = new Map();

async function newPage() {
  const page = await context.newPage();
  openPages.add(page);
  const errors = [];
  pageErrors.set(page, errors);
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  return page;
}

/**
 * Opens the new tab page. `time` fixes the clock (timers keep running), `install` fakes timers
 * too (advance with page.clock.runFor).
 */
async function openNewTab({ time, install, viewport, colorScheme, waitReady = true } = {}) {
  const page = await newPage();
  if (viewport) await page.setViewportSize(viewport);
  if (colorScheme) await page.emulateMedia({ colorScheme });
  if (install) await page.clock.install({ time: install });
  else if (time) await page.clock.setFixedTime(time);
  await page.goto(newtabUrl);
  if (waitReady) await page.locator('#countdowns[data-state="ready"]').waitFor({ state: 'attached' });
  return page;
}

async function readStorage(page) {
  return page.evaluate(() => chrome.storage.local.get(null));
}

async function resetStorage(page, items = {}) {
  await page.evaluate(async (items) => {
    await chrome.storage.local.clear();
    localStorage.clear();
    if (Object.keys(items).length) await chrome.storage.local.set(items);
  }, items);
}

async function waitFor(check, message, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out: ${message}`);
}

const row = (page, kind) => page.locator(`.period[data-kind="${kind}"]`);
/** A row's text; for 'left' the visible short form ("95 d 12 h left"). */
const rowText = async (page, kind, part) =>
  (await row(page, kind).locator(part === 'left' ? '.period-left .dur' : `.period-${part}`).textContent())?.trim();
/** What screen readers get for the time left ("95 days 12 h left"). */
const rowSpoken = async (page, kind) => (await row(page, kind).locator('.period-left .visually-hidden').textContent())?.trim();
const countdownItems = (page) => page.locator('.countdown');
const countdownNames = (page) => page.locator('.countdown .countdown-name').allTextContents();
const item = (page, name) => page.locator('.countdown', { has: page.locator('.countdown-name', { hasText: name }) });
/** A countdown's status: visible ("11 d 19 h") and spoken ("11 days 19 h left"). */
async function status(page, name) {
  const locator = item(page, name).locator('.countdown-status');
  return {
    shown: (await locator.locator('.dur').textContent())?.trim(),
    spoken: (await locator.locator('.visually-hidden').textContent())?.trim(),
  };
}
const goalItem = (page, name) => page.locator('.goal', { has: page.locator('.goal-name', { hasText: name }) });
const goalNames = (page) => page.locator('.goal .goal-name').allTextContents();
const tile = (page, name) => page.locator('.link-tile', { has: page.locator('.link-name', { hasText: name }) });
const tileNames = (page) => page.locator('.link-tile:not(.link-add-tile) .link-name').allTextContents();

/** The same verdict the page gives, computed here independently: pace = target × share of the period gone. */
function paceVerdict({ target, count, unit }, start, end, now) {
  const expected = (target * (now - start)) / (end - start);
  const gap = count - expected;
  const n = Math.round(Math.abs(gap));
  const amount = (value) => (unit && value !== 1 ? `${value.toLocaleString('en-US')} ${unit}` : value.toLocaleString('en-US'));
  if (count >= target) return count > target ? `goal reached, ${amount(count - target)} over` : 'goal reached';
  if (n === 0) return 'on pace';
  return gap < 0 ? `${amount(n)} behind pace` : `${amount(n)} ahead`;
}

/** Width and height of a PNG from its header. */
const pngSize = (buffer) => ({ width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) });

async function shot(page, name, { curated = false, fullPage = false } = {}) {
  await page.evaluate(() => document.fonts.ready);
  const path = join(outputDir, `${name}.png`);
  // Full-page captures start from the top, so the fixed gear button sits where it belongs.
  if (fullPage) await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path, caret: 'hide', animations: 'disabled', fullPage });
  if (curated) await copyFile(path, join(screenshotsDir, `${name}.png`));
}

/** Local date/time in the test zone; month is 1-based. */
const local = (y, m, d, hh = 0, mm = 0, ss = 0) => new Date(y, m - 1, d, hh, mm, ss);
const DAY = 86_400_000;

/** Percent rounded down, as the page shows it. Independent of the extension code on purpose. */
function percent(start, end, now, decimals) {
  const scale = 10 ** decimals;
  const units = Math.floor(((now - start) / (end - start)) * 100 * scale + 1e-7);
  return `${(units / scale).toFixed(decimals)}%`;
}

// --- Tests ------------------------------------------------------------------------------

const results = [];
async function test(name, fn) {
  const started = Date.now();
  try {
    const allowErrors = await fn();
    for (const [page, errors] of pageErrors) {
      if (errors.length && allowErrors !== true) throw new Error(`Console errors on ${page.url()}:\n${errors.join('\n')}`);
    }
    results.push({ name, ok: true });
    console.log(`  ✓ ${name} (${Date.now() - started} ms)`);
  } catch (error) {
    results.push({ name, ok: false, error });
    console.log(`  ✗ ${name}\n      ${String(error?.stack ?? error).split('\n').slice(0, 8).join('\n      ')}`);
  } finally {
    for (const page of openPages) await page.close().catch(() => undefined);
    openPages.clear();
    pageErrors.clear();
  }
}

console.log(`Chromium ${context.browser()?.version() ?? ''} · extension ${extensionId} · ${zone}\n`);

await test('manifest: only the storage permission, a new tab override and a strict CSP', async () => {
  const manifest = JSON.parse(await readFile(join(root, 'dist/manifest.json'), 'utf8'));
  assert.deepEqual(manifest.permissions, ['storage']);
  assert.equal(manifest.host_permissions, undefined);
  assert.equal(manifest.content_scripts, undefined);
  assert.equal(manifest.background, undefined);
  assert.equal(manifest.action, undefined);
  assert.deepEqual(manifest.chrome_url_overrides, { newtab: 'newtab.html' });
  assert.match(manifest.content_security_policy.extension_pages, /default-src 'none'; script-src 'self'/);
  // The share card needs no CSP change: the preview is the canvas itself, and a blob: download
  // link is a navigation, not an image load.
  assert.equal(
    manifest.content_security_policy.extension_pages,
    "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'",
  );
});

await test('production build: small, no remote URLs, no test-only code', async () => {
  const files = await readdir(join(root, 'dist'), { recursive: true });
  let total = 0;
  for (const file of files) {
    const info = await stat(join(root, 'dist', file));
    if (info.isFile()) total += info.size;
  }
  const js = await readFile(join(root, 'dist/newtab.js'), 'utf8');
  const css = await readFile(join(root, 'dist/newtab.css'), 'utf8');
  const html = await readFile(join(root, 'dist/newtab.html'), 'utf8');
  console.log(`      dist: ${(total / 1024).toFixed(0)} KB total, newtab.js ${(js.length / 1024).toFixed(1)} KB, newtab.css ${(css.length / 1024).toFixed(1)} KB`);
  // Unminified on purpose (readable for Web Store review); goals, quick links and the share card
  // took the script from ~105 KB to ~175 KB.
  assert.ok(js.length < 200_000, `newtab.js is ${js.length} bytes`);
  assert.ok(css.length < 110_000, `newtab.css is ${css.length} bytes`);
  assert.ok(total < 460_000, `dist is ${total} bytes`);
  for (const [name, text] of [['js', js], ['css', css], ['html', html]]) {
    const urls = [...text.matchAll(/https?:\/\/[^\s'")]+/g)].map((match) => match[0]).filter((url) => !url.startsWith('http://www.w3.org/'));
    assert.deepEqual(urls, [], `remote URLs in ${name}`);
  }
  assert.ok(!js.includes('__E2E__') && !js.includes('__progressTabTest') && !js.includes('e2e-early-access'), 'no test hooks in production');
});

await test('chrome://newtab is replaced by Progress Tab', async () => {
  const page = await newPage();
  await page.goto('chrome://newtab');
  await page.locator('#countdowns[data-state="ready"]').waitFor({ state: 'attached' });
  assert.equal(await page.title(), 'New Tab');
  assert.equal(await page.locator('#period-list [role="progressbar"]').count(), 4);
  assert.equal(await page.evaluate(() => chrome.runtime.id), extensionId);
});

await test('rows are in the first paint, before storage answers', async () => {
  const page = await newPage();
  await page.addInitScript(() => {
    // Delay storage reads by 1.5 s; record what the page shows at DOMContentLoaded.
    const area = chrome.storage.local;
    const get = area.get.bind(area);
    area.get = (...args) => new Promise((resolve) => setTimeout(resolve, 1500)).then(() => get(...args));
    document.addEventListener('DOMContentLoaded', () =>
      setTimeout(() => {
        globalThis.__atLoad = {
          bars: document.querySelectorAll('#period-list [role="progressbar"][aria-valuenow]').length,
          year: document.querySelector('.period[data-kind="year"] .period-percent')?.textContent,
          state: document.getElementById('countdowns')?.dataset.state,
          booting: document.documentElement.classList.contains('booting'),
        };
      }),
    );
  });
  await page.goto(newtabUrl);
  const atLoad = await page.evaluate(() => globalThis.__atLoad);
  assert.equal(atLoad?.bars, 4, JSON.stringify(atLoad));
  assert.match(atLoad.year, /^\d{1,3}\.\d{2}%$/);
  assert.equal(atLoad.state, 'loading');
  assert.equal(atLoad.booting, false, 'the page is shown as soon as the rows exist');
  await page.locator('.countdowns-loading:not([hidden])').waitFor();
  await shot(page, 'state-loading');
  await page.locator('#countdowns[data-state="ready"]').waitFor({ state: 'attached' });

  // Normal load: rendered before the first contentful paint, and quickly.
  const normal = await openNewTab();
  const timing = await normal.evaluate(async () => ({
    rendered: performance.getEntriesByName('progress-tab:rendered')[0]?.startTime,
    fcp: await new Promise((resolve) => {
      new PerformanceObserver((list) => {
        const entry = list.getEntriesByName('first-contentful-paint')[0];
        if (entry) resolve(entry.startTime);
      }).observe({ type: 'paint', buffered: true });
      setTimeout(() => resolve(undefined), 3000);
    }),
  }));
  console.log(`      rendered at ${timing.rendered?.toFixed(1)} ms, first contentful paint at ${timing.fcp?.toFixed(1)} ms`);
  assert.ok(timing.rendered !== undefined && timing.fcp !== undefined, JSON.stringify(timing));
  // Paint timestamps are coarsened (4 ms steps here), the mark isn't: allow one step.
  assert.ok(timing.rendered <= timing.fcp + 4, `rows rendered at ${timing.rendered} ms, first paint at ${timing.fcp} ms`);
  assert.ok(timing.rendered < 500, `rendered after ${timing.rendered} ms`);
  const fonts = await normal.evaluate(async () => {
    await document.fonts.ready;
    return document.fonts.check('16px "Manrope Variable"') && document.fonts.check('16px "JetBrains Mono Variable"');
  });
  assert.ok(fonts, 'bundled fonts loaded');
});

await test('real current time: plausible values in every row', async () => {
  const page = await openNewTab();
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  const close = (text, start, end, decimals) => {
    const expected = Number.parseFloat(percent(start, end, Date.now(), decimals));
    const actual = Number.parseFloat(text);
    assert.ok(Math.abs(actual - expected) <= 1.5 / 10 ** decimals, `${text} vs ${expected}`);
  };
  close(await rowText(page, 'year', 'percent'), local(y, 1, 1), local(y + 1, 1, 1), 2);
  close(await rowText(page, 'month', 'percent'), local(y, m + 1, 1), local(y, m + 2, 1), 1);
  close(await rowText(page, 'day', 'percent'), local(y, m + 1, now.getDate()), local(y, m + 1, now.getDate() + 1), 1);
  assert.equal(await rowText(page, 'year', 'label'), String(y));
  assert.equal(await rowText(page, 'month', 'label'), now.toLocaleString('en-US', { month: 'long' }));
  assert.match(await rowText(page, 'day', 'caption'), new RegExp(`^${now.toLocaleString('en-US', { weekday: 'long' })}`));
  for (const kind of ['year', 'month', 'week', 'day']) {
    const bar = row(page, kind).locator('[role="progressbar"]');
    const value = Number(await bar.getAttribute('aria-valuenow'));
    assert.ok(value >= 0 && value < 100, `${kind} aria-valuenow ${value}`);
    assert.equal(await bar.getAttribute('aria-valuemin'), '0');
    assert.equal(await bar.getAttribute('aria-valuemax'), '100');
    assert.match(await bar.getAttribute('aria-valuetext'), /%, .+ left$/);
  }
  assert.match(await page.locator('#clock-time').textContent(), /^\d{2}:\d{2}$/, 'en-GB locale: 24-hour clock');
});

await test('fixed time: exact values; week start Monday vs Sunday persists', async () => {
  const now = local(2026, 9, 27, 12); // Sunday noon
  const page = await openNewTab({ time: now });
  await resetStorage(page);
  await page.reload();
  await page.locator('#countdowns[data-state="ready"]').waitFor({ state: 'attached' });
  assert.equal(await rowText(page, 'year', 'percent'), percent(local(2026, 1, 1), local(2027, 1, 1), now, 2));
  assert.equal(await rowText(page, 'year', 'caption'), 'Day 270 of 365');
  assert.equal(await rowText(page, 'year', 'left'), '95 d 12 h left');
  assert.equal(await rowSpoken(page, 'year'), '95 days 12 h left');
  assert.equal(await rowText(page, 'month', 'percent'), '88.3%');
  assert.equal(await rowText(page, 'week', 'caption'), 'Sep 21 – 27');
  assert.equal(await rowText(page, 'week', 'percent'), '92.8%');
  assert.equal(await rowText(page, 'week', 'left'), '12 h left');
  assert.equal(await rowText(page, 'day', 'percent'), '50.0%');
  assert.equal(await page.locator('#clock-time').textContent(), '12:00');
  assert.equal(await page.locator('#clock-date').textContent(), 'Sunday, September 27');

  await page.locator('#open-settings').click();
  await page.locator('label[for="week-start-sunday"]').click();
  await page.locator('#save-status', { hasText: 'Saved' }).waitFor();
  assert.equal(await rowText(page, 'week', 'caption'), 'Sep 27 – Oct 3');
  assert.equal(await rowText(page, 'week', 'percent'), '7.1%');
  assert.equal(await rowText(page, 'week', 'left'), '6 d 12 h left');
  assert.equal(await rowSpoken(page, 'week'), '6 days 12 h left');
  assert.equal((await readStorage(page)).settings.weekStart, 'sunday');

  await page.reload();
  await page.locator('#countdowns[data-state="ready"]').waitFor({ state: 'attached' });
  assert.equal(await rowText(page, 'week', 'caption'), 'Sep 27 – Oct 3');
  await resetStorage(page);
});

await test('edge moments: last second of the year, exact midnight, a 25-hour DST day', async () => {
  const last = await openNewTab({ time: local(2026, 12, 31, 23, 59, 59) });
  assert.equal(await rowText(last, 'year', 'percent'), '99.99%');
  assert.equal(await rowText(last, 'year', 'left'), '1 s left');
  assert.equal(await rowText(last, 'day', 'left'), '1 s left');

  const midnight = await openNewTab({ time: local(2027, 1, 1) });
  assert.equal(await rowText(midnight, 'year', 'label'), '2027');
  assert.equal(await rowText(midnight, 'year', 'percent'), '0.00%');
  assert.equal(await rowText(midnight, 'year', 'caption'), 'Day 1 of 365');
  assert.equal(await rowText(midnight, 'year', 'left'), '365 d left');
  assert.equal(await rowSpoken(midnight, 'year'), '365 days left');

  if (zone === 'Europe/Kyiv') {
    const dst = await openNewTab({ time: local(2026, 10, 25, 12) });
    assert.equal(await rowText(dst, 'day', 'caption'), 'Sunday · 25-hour day, clocks go back');
    assert.equal(await rowText(dst, 'day', 'percent'), '52.0%');
    assert.equal(await rowText(dst, 'day', 'left'), '12 h left');
  }
});

await test('live updates every second, pause while the tab is hidden, and only touch what changed', async () => {
  const page = await openNewTab({ install: local(2026, 9, 27, 12, 0, 0) });
  await page.clock.runFor(200);
  assert.equal(await page.locator('#clock-time').textContent(), '12:00');
  await page.clock.runFor(60_000);
  assert.equal(await page.locator('#clock-time').textContent(), '12:01');

  // Between two ticks where nothing visible changes (12:01:01 -> 12:01:02), the DOM is not touched.
  await page.clock.runFor(1000);
  await page.evaluate(() => {
    globalThis.__mutations = 0;
    new MutationObserver((records) => (globalThis.__mutations += records.length)).observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    });
  });
  await page.clock.runFor(1000);
  assert.equal(await page.evaluate(() => globalThis.__mutations), 0, 'no DOM writes for an unchanged second');

  const setHidden = (hidden) =>
    page.evaluate((hidden) => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') });
      document.dispatchEvent(new Event('visibilitychange'));
    }, hidden);
  await setHidden(true);
  await page.clock.runFor(5 * 60_000);
  assert.equal(await page.locator('#clock-time').textContent(), '12:01', 'no updates while hidden');
  assert.equal(await page.evaluate(() => globalThis.__mutations), 0, 'no DOM writes while hidden');
  await setHidden(false);
  assert.equal(await page.locator('#clock-time').textContent(), '12:06', 'caught up right away when visible');
  assert.equal(await rowText(page, 'day', 'left'), '11 h 54 min left', 'agrees with the clock');
  assert.equal(await rowSpoken(page, 'day'), '11 h 54 min left');
});

await test('countdowns: add (keyboard too), validate, sort, edit, cancel, delete + undo, persist', async () => {
  const now = local(2026, 9, 27, 12);
  const page = await openNewTab({ time: now });
  await resetStorage(page);
  await page.reload();
  await page.locator('#countdowns[data-state="ready"]').waitFor({ state: 'attached' });

  // Empty state.
  await page.locator('.countdowns-empty:not([hidden])').waitFor();
  assert.ok(await page.locator('#add-countdown').isHidden());
  await shot(page, 'state-empty');

  // Validation: nothing is saved.
  await page.locator('.countdowns-empty button').click();
  const name = page.locator('.countdown-form input[type="text"]');
  assert.ok(await name.evaluate((input) => input === document.activeElement), 'name field focused');
  await page.keyboard.press('Enter');
  await page.locator('.countdown-form .invalid-feedback', { hasText: 'Give the countdown a name.' }).waitFor();
  await page.locator('.countdown-form .invalid-feedback', { hasText: 'Pick a date.' }).waitFor();
  assert.equal(await name.getAttribute('aria-invalid'), 'true');
  await shot(page, 'countdown-form-errors');
  assert.equal((await readStorage(page)).countdowns, undefined);

  // Add with mouse + fill.
  await name.fill('Flight to Lisbon');
  await page.locator('.countdown-form input[type="date"]').fill('2026-10-09');
  await page.locator('.countdown-form input[type="time"]').fill('07:45');
  await page.locator('.countdown-form button[type="submit"]').click();
  await item(page, 'Flight to Lisbon').waitFor();
  assert.deepEqual(await status(page, 'Flight to Lisbon'), { shown: '11 d 19 h', spoken: '11 days 19 h left' });
  assert.equal(await item(page, 'Flight to Lisbon').locator('.countdown-target').textContent(), 'Fri, Oct 9, 2026 · 07:45');
  assert.equal(await item(page, 'Flight to Lisbon').locator('.countdown-progress-text').textContent(), '0.0%');
  assert.ok(await page.locator('#add-countdown').evaluate((button) => button === document.activeElement), 'focus back on Add');

  // Add with the keyboard only (en-GB date input: dd/mm/yyyy; its calendar button is a tab stop).
  await page.keyboard.press('Enter');
  await page.keyboard.type('Deadline <b>report</b>');
  await page.keyboard.press('Tab');
  await page.keyboard.type('28092026');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await page.keyboard.type('0930');
  await page.keyboard.press('Enter');
  await item(page, 'Deadline <b>report</b>').waitFor();
  assert.equal(await page.locator('.countdown-name b').count(), 0, 'names are text, never HTML');

  // A date without a time, and one in the past.
  for (const [title, date] of [
    ['New Year', '2027-01-01'],
    ['Project kickoff', '2026-09-01'],
  ]) {
    await page.locator('#add-countdown').click();
    await name.fill(title);
    await page.locator('.countdown-form input[type="date"]').fill(date);
    await page.keyboard.press('Enter');
    await item(page, title).waitFor();
  }
  assert.deepEqual(await countdownNames(page), ['Deadline <b>report</b>', 'Flight to Lisbon', 'New Year', 'Project kickoff']);
  assert.deepEqual(await status(page, 'Deadline'), { shown: '21 h 30 min', spoken: '21 h 30 min left' });
  assert.deepEqual(await status(page, 'Project kickoff'), { shown: 'passed 26 days ago', spoken: 'passed 26 days ago' });
  // Passed one-off countdowns go under "Past (1)". Adding one opens the group so it doesn't vanish;
  // it can be collapsed and opened again, and a new tab starts with it collapsed.
  const pastToggle = page.locator('.past-toggle');
  assert.equal(await pastToggle.getAttribute('aria-expanded'), 'true', 'opened for the countdown just added');
  assert.equal(await pastToggle.getAttribute('aria-label'), 'Past countdowns (1)');
  assert.equal(await page.locator('#countdowns-past .countdown-name').allTextContents().then((names) => names.join()), 'Project kickoff');
  // Added after its date: nothing to measure, so no bar.
  assert.ok(await item(page, 'Project kickoff').locator('.countdown-progress').isHidden());
  await pastToggle.click();
  assert.equal(await pastToggle.getAttribute('aria-expanded'), 'false');
  await item(page, 'Project kickoff').waitFor({ state: 'hidden' });
  await pastToggle.press('Enter');
  await item(page, 'Project kickoff').waitFor();
  const fresh = await newPage();
  await fresh.clock.setFixedTime(now);
  await fresh.goto(newtabUrl);
  await item(fresh, 'Flight to Lisbon').waitFor();
  assert.equal(await fresh.locator('.past-toggle').getAttribute('aria-expanded'), 'false', 'collapsed by default');
  assert.ok(await item(fresh, 'Project kickoff').isHidden());
  await fresh.close();
  openPages.delete(fresh);

  // Edit, then cancel with Escape: nothing changes, focus returns to Edit.
  const flight = item(page, 'Flight to Lisbon');
  await flight.getByRole('button', { name: 'Edit “Flight to Lisbon”' }).click();
  assert.equal(await page.locator('.countdown-form input[type="text"]').inputValue(), 'Flight to Lisbon');
  assert.equal(await page.locator('.countdown-form input[type="time"]').inputValue(), '07:45');
  await page.locator('.countdown-form input[type="text"]').fill('Changed my mind');
  await shot(page, 'countdown-form-edit', { curated: false });
  await page.keyboard.press('Escape');
  await page.locator('.countdown-form').waitFor({ state: 'detached' });
  assert.ok(await flight.getByRole('button', { name: 'Edit “Flight to Lisbon”' }).evaluate((button) => button === document.activeElement));

  // Edit and save: new name and date, progress turned off; id and creation time are kept.
  const before = (await readStorage(page)).countdowns.find((countdown) => countdown.name === 'Flight to Lisbon');
  await page.keyboard.press('Enter');
  await page.locator('.countdown-form input[type="text"]').fill('Flight to Porto');
  await page.locator('.countdown-form input[type="date"]').fill('2026-10-30');
  await page.locator('.countdown-form input[role="switch"]').uncheck();
  await page.keyboard.press('Enter');
  await item(page, 'Flight to Porto').waitFor();
  assert.ok(await item(page, 'Flight to Porto').locator('.countdown-progress').isHidden());
  assert.deepEqual(await countdownNames(page), ['Deadline <b>report</b>', 'Flight to Porto', 'New Year', 'Project kickoff']);
  const after = (await readStorage(page)).countdowns.find((countdown) => countdown.id === before.id);
  assert.deepEqual(
    { ...after },
    { id: before.id, name: 'Flight to Porto', date: '2026-10-30', time: '07:45', createdAt: now.getTime(), showProgress: false, repeat: 'none' },
  );

  // Delete, undo from the toast (focus is on Undo), delete again.
  await item(page, 'Deadline').getByRole('button', { name: /^Delete/ }).click();
  await page.locator('#toast.show', { hasText: 'Deleted “Deadline <b>report</b>”.' }).waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'toast-action');
  await shot(page, 'countdown-deleted-toast');
  await page.keyboard.press('Enter');
  await item(page, 'Deadline').waitFor();
  assert.equal((await readStorage(page)).countdowns.length, 4);
  await item(page, 'Deadline').getByRole('button', { name: /^Delete/ }).click();
  await page.locator('#toast.show').waitFor();
  await waitFor(async () => (await readStorage(page)).countdowns.length === 3, 'deleted from storage');

  // Everything survives a reload, in the same order.
  await page.reload();
  await page.locator('#countdowns[data-state="ready"]').waitFor({ state: 'attached' });
  assert.deepEqual(await countdownNames(page), ['Flight to Porto', 'New Year', 'Project kickoff']);
  assert.deepEqual(await status(page, 'New Year'), { shown: '95 d 12 h', spoken: '95 days 12 h left' });
  await resetStorage(page);
});

await test('settings: hide rows, theme, accent, time format, decimals; persisted and applied before paint', async () => {
  const page = await openNewTab({ time: local(2026, 9, 27, 12) });
  await resetStorage(page);
  await page.reload();
  await page.locator('#countdowns[data-state="ready"]').waitFor({ state: 'attached' });

  const toggle = page.locator('#open-settings');
  await toggle.click();
  assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
  await page.locator('#settings.show').waitFor();

  await page.locator('label[for="show-year"]').click();
  await page.locator('#save-status', { hasText: 'Saved' }).waitFor();
  assert.ok(await row(page, 'year').isHidden());
  assert.equal((await readStorage(page)).settings.widgets.year, false);

  await page.locator('label[for="theme-dark"]').click();
  assert.equal(await page.evaluate(() => document.documentElement.dataset.bsTheme), 'dark');
  assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(16, 20, 19)');

  await page.locator('label[for="accent-blue"]').click();
  assert.equal(await row(page, 'month').locator('.progress-bar').evaluate((bar) => getComputedStyle(bar).backgroundColor), 'rgb(77, 171, 247)');

  await page.locator('label[for="clock-format-12h"]').click();
  assert.equal(await page.locator('#clock-time').textContent(), '12:00 PM');

  await page.locator('#decimals').selectOption('4');
  assert.match(await rowText(page, 'month', 'percent'), /^\d+\.\d{4}%$/);
  await shot(page, 'settings-changed-dark');

  // Escape closes the drawer and returns focus to the gear button.
  await page.locator('#settings input[name="theme"]:checked').focus();
  await page.keyboard.press('Escape');
  await page.locator('#settings:not(.show)').waitFor({ state: 'attached' });
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
  assert.ok(await toggle.evaluate((button) => button === document.activeElement));
  await waitFor(async () => (await readStorage(page)).settings.decimals === 4, 'last change saved');
  assert.deepEqual((await readStorage(page)).settings, {
    weekStart: 'monday',
    widgets: { clock: true, links: true, year: false, month: true, week: true, day: true, goals: true, countdowns: true, lifeWeeks: false },
    theme: 'dark',
    accent: 'blue',
    clock: '12h',
    decimals: 4,
    life: { birthDate: null, years: 80 },
  });

  // A new tab applies the saved theme and layout before its first paint (no flash of defaults).
  const next = await newPage();
  await next.clock.setFixedTime(local(2026, 9, 27, 12));
  // A window listener runs right after the page's own DOMContentLoaded handler, in the same task.
  await next.addInitScript(() =>
    window.addEventListener('DOMContentLoaded', () => {
      globalThis.__atLoad = {
        theme: document.documentElement.dataset.bsTheme,
        yearHidden: document.querySelector('.period[data-kind="year"]')?.hidden,
        clock: document.getElementById('clock-time')?.textContent,
      };
    }),
  );
  await next.goto(newtabUrl);
  await next.locator('#countdowns[data-state="ready"]').waitFor({ state: 'attached' });
  assert.deepEqual(await next.evaluate(() => globalThis.__atLoad), { theme: 'dark', yearHidden: true, clock: '12:00 PM' });

  // Without the paint-time cache the page still converges to the stored settings.
  await next.evaluate(() => localStorage.clear());
  await next.reload();
  await next.waitForFunction(() => document.documentElement.dataset.bsTheme === 'dark');
  assert.ok(await row(next, 'year').isHidden());
  await resetStorage(next);
});

await test('keyboard: visible focus ring in the accent color, drawer reachable', async () => {
  const page = await openNewTab({ time: local(2026, 9, 27, 12) });
  await resetStorage(page, {
    countdowns: [{ id: 'f', name: 'Focus me', date: '2026-12-01', time: null, createdAt: local(2026, 9, 1).getTime(), showProgress: true }],
  });
  await page.reload();
  await item(page, 'Focus me').waitFor();
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'open-settings', 'settings button comes first');
  const ring = await page.locator('#open-settings').evaluate((button) => {
    const style = getComputedStyle(button);
    return `${style.outlineStyle} ${style.outlineWidth} ${style.outlineColor}`;
  });
  assert.equal(ring, 'solid 2px rgb(12, 166, 120)');
  // Settings -> Add link -> Share -> Add goal -> Add countdown -> Edit (hover-only actions are
  // still in the tab order, and show while focused).
  const order = [];
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press('Tab');
    order.push(await page.evaluate(() => document.activeElement?.getAttribute('aria-label') || document.activeElement?.textContent?.trim()));
  }
  assert.deepEqual(order, ['Add a quick link', 'Share', 'Add goal', 'Add', 'Edit “Focus me”']);
  const actions = item(page, 'Focus me').locator('.countdown-actions');
  await waitFor(async () => (await actions.evaluate((element) => getComputedStyle(element).opacity)) === '1', 'actions show while focused');
  await shot(page, 'state-keyboard-focus');
  await page.keyboard.press('Enter');
  await page.locator('.countdown-form').waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Edit “Focus me”');
  for (let i = 0; i < 5; i++) await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Enter');
  await page.locator('#settings.show').waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'settings');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'show-clock');
  await resetStorage(page);
});

await test('theme: auto follows the OS; light and dark override it', async () => {
  const page = await openNewTab({ colorScheme: 'dark' });
  await resetStorage(page);
  await page.reload();
  const background = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  assert.equal(await background(), 'rgb(16, 20, 19)');
  await page.emulateMedia({ colorScheme: 'light' });
  assert.equal(await background(), 'rgb(244, 247, 246)');
  // The accent follows the scheme too (JS listens for the OS change).
  await page.waitForFunction(() => document.documentElement.style.getPropertyValue('--pt-accent') === '#0ca678');
  await page.evaluate(() => chrome.storage.local.set({ settings: { theme: 'light' } }));
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForFunction(() => document.documentElement.dataset.bsTheme === 'light');
  assert.equal(await background(), 'rgb(244, 247, 246)');
  await resetStorage(page);
});

await test('reduced motion: no transitions', async () => {
  const page = await newPage();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(newtabUrl);
  const durations = await page.evaluate(() =>
    ['.progress-bar', '#settings', '.app'].map((selector) => getComputedStyle(document.querySelector(selector)).transitionDuration),
  );
  assert.deepEqual(durations, ['0s', '0s', '0s']);
  const normal = await openNewTab();
  assert.equal(await normal.evaluate(() => getComputedStyle(document.querySelector('#settings')).transitionDuration), '0.3s, 0s');
});

await test('storage errors are shown, and nothing is silently lost', async () => {
  const page = await openNewTab({ time: local(2026, 9, 27, 12) });
  await resetStorage(page, {
    countdowns: [{ id: 'k', name: 'Keep me', date: '2026-12-01', time: null, createdAt: local(2026, 9, 1).getTime(), showProgress: true }],
  });
  await page.reload();
  await item(page, 'Keep me').waitFor();
  await page.evaluate(() => {
    chrome.storage.local.set = () => Promise.reject(new Error('QUOTA_BYTES quota exceeded'));
  });

  // Settings: error in the drawer, the change is rolled back.
  await page.locator('#open-settings').click();
  await page.locator('label[for="show-week"]').click();
  await page.locator('#settings-error', { hasText: 'Couldn’t save your settings: QUOTA_BYTES quota exceeded.' }).waitFor();
  assert.ok(await page.locator('#show-week').isChecked(), 'switch back on');
  assert.ok(await row(page, 'week').isVisible(), 'row back');
  await shot(page, 'state-settings-save-error');
  await page.keyboard.press('Escape');

  // Countdown: the form stays open with what was typed.
  await page.locator('#add-countdown').click();
  await page.locator('.countdown-form input[type="text"]').fill('Will not save');
  await page.locator('.countdown-form input[type="date"]').fill('2026-11-11');
  await page.keyboard.press('Enter');
  await page.locator('.countdown-form .alert', { hasText: 'Couldn’t save the countdown: QUOTA_BYTES quota exceeded' }).waitFor();
  assert.equal(await page.locator('.countdown-form input[type="text"]').inputValue(), 'Will not save');
  await shot(page, 'state-countdown-save-error');
  await page.keyboard.press('Escape');

  // Delete: an error toast, the countdown stays.
  await item(page, 'Keep me').getByRole('button', { name: /^Delete/ }).click();
  await page.locator('#toast.show.is-error', { hasText: 'Couldn’t delete “Keep me”: QUOTA_BYTES quota exceeded' }).waitFor();
  await shot(page, 'state-delete-error-toast');
  assert.equal(await item(page, 'Keep me').count(), 1);

  // Load failure: a page alert and a retry that works once storage is back.
  const broken = await newPage();
  await broken.addInitScript(() => {
    const area = chrome.storage.local;
    const get = area.get.bind(area);
    globalThis.__failStorage = true;
    area.get = (...args) => (globalThis.__failStorage ? Promise.reject(new Error('Simulated read failure')) : get(...args));
  });
  await broken.clock.setFixedTime(local(2026, 9, 27, 12));
  await broken.goto(newtabUrl);
  await broken.locator('#page-alert:not([hidden])', { hasText: 'Couldn’t read your saved settings, goals, links and countdowns (Simulated read failure)' }).waitFor();
  await broken.locator('#goals[data-state="error"] .goals-error', { hasText: 'Simulated read failure' }).waitFor();
  await broken.locator('#links[data-state="error"] .links-error', { hasText: 'Simulated read failure' }).waitFor();
  await broken.locator('#countdowns[data-state="error"] .countdowns-error', { hasText: 'Simulated read failure' }).waitFor();
  assert.equal(await broken.locator('#period-list [role="progressbar"]').count(), 4, 'progress still shows');
  await shot(broken, 'state-load-error');
  await broken.evaluate(() => (globalThis.__failStorage = false));
  assert.equal(await broken.getByRole('button', { name: 'Try again' }).count(), 3, 'links, goals and countdowns each offer a retry');
  await broken.locator('#countdowns').getByRole('button', { name: 'Try again' }).click();
  await item(broken, 'Keep me').waitFor();
  assert.ok(await broken.locator('#page-alert').isHidden());
  await resetStorage(broken);
});

await test('other open tabs update live', async () => {
  const a = await openNewTab();
  await resetStorage(a);
  const b = await openNewTab();
  await a.locator('.countdowns-empty button').click();
  await a.locator('.countdown-form input[type="text"]').fill('Shared');
  await a.locator('.countdown-form input[type="date"]').fill('2030-01-01');
  await a.keyboard.press('Enter');
  await item(b, 'Shared').waitFor();
  await a.locator('#open-settings').click();
  await a.locator('label[for="show-day"]').click();
  await b.waitForFunction(() => document.querySelector('.period[data-kind="day"]').hidden);
  await resetStorage(a);
  await b.waitForFunction(() => !document.querySelector('.period[data-kind="day"]').hidden);
});

await test('broken storage data falls back per field and per countdown', async () => {
  const page = await openNewTab({ time: local(2026, 9, 27, 12) });
  await resetStorage(page, {
    settings: { weekStart: 'friday', theme: 42, widgets: 'all', accent: 'pink', decimals: '3' },
    countdowns: [
      { id: 'ok', name: '  Valid  ', date: '2026-12-24', time: '18:00', createdAt: 1, showProgress: true },
      { id: 'bad-date', name: 'Feb 30', date: '2026-02-30', time: null, createdAt: 1 },
      { id: 'bad-time', name: 'Late', date: '2026-12-24', time: '25:00', createdAt: 1 },
      { id: 'ok', name: 'Duplicate id', date: '2026-12-24', time: null, createdAt: 1 },
      'nonsense',
      null,
    ],
  });
  await page.reload();
  await page.locator('#countdowns[data-state="ready"]').waitFor({ state: 'attached' });
  assert.deepEqual(await countdownNames(page), ['Valid']);
  assert.equal(await page.evaluate(() => document.documentElement.dataset.accent), 'pink');
  assert.equal(await rowText(page, 'year', 'percent'), percent(local(2026, 1, 1), local(2027, 1, 1), local(2026, 9, 27, 12), 3));
  assert.equal(await rowText(page, 'week', 'caption'), 'Sep 21 – 27');
  await resetStorage(page);
});

await test('everything hidden: a clear way back', async () => {
  const page = await openNewTab();
  await resetStorage(page, {
    settings: { widgets: { clock: false, links: false, year: false, month: false, week: false, day: false, goals: false, countdowns: false } },
  });
  await page.reload();
  await page.locator('#nothing-shown:not([hidden])').waitFor();
  await shot(page, 'state-nothing-shown');
  await page.getByRole('button', { name: 'Choose what to show' }).click();
  await page.locator('#settings.show').waitFor();
  await page.locator('label[for="show-year"]').click();
  await row(page, 'year').waitFor();
  assert.ok(await page.locator('#nothing-shown').isHidden());
  await resetStorage(page);
});

await test('no network requests leave the extension', async () => {
  const requests = [];
  const listener = (request) => {
    const url = request.url();
    if (!url.startsWith('chrome-extension://') && !url.startsWith('data:') && !url.startsWith('chrome://')) requests.push(url);
  };
  context.on('request', listener);
  const page = await openNewTab();
  await page.locator('#open-settings').click();
  await page.waitForTimeout(300);
  context.off('request', listener);
  assert.deepEqual(requests, []);
});

const DEMO_NOW_LIFE = local(2026, 10, 16, 9, 41);

// --- Screenshots (curated ones are committed to screenshots/) ----------------------------

const DEMO_NOW = DEMO_NOW_LIFE;
const DEMO_COUNTDOWNS = [
  { id: 'd1', name: 'Flight to Lisbon', date: '2026-10-23', time: '07:45', createdAt: local(2026, 10, 1, 20).getTime(), showProgress: true },
  { id: 'd2', name: 'New Year’s Eve', date: '2026-12-31', time: '20:00', createdAt: local(2026, 9, 1, 9).getTime(), showProgress: true },
  // Repeats every year from her birth date: on the demo day it reads "Today".
  { id: 'd3', name: 'Mom’s birthday', date: '1962-10-16', time: null, createdAt: local(2026, 8, 20).getTime(), showProgress: false, repeat: 'yearly' },
  { id: 'd4', name: 'Q3 report due', date: '2026-10-09', time: '17:00', createdAt: local(2026, 9, 14).getTime(), showProgress: true },
  { id: 'd5', name: 'Marathon', date: '2027-04-18', time: '08:00', createdAt: local(2026, 6, 1).getTime(), showProgress: true },
  { id: 'd6', name: 'Rent', date: '2026-01-01', time: null, createdAt: local(2026, 1, 1).getTime(), showProgress: true, repeat: 'monthly' },
];
const DEMO_GOALS = [
  { id: 'g1', name: 'Read 24 books', unit: 'books', target: 24, count: 17, period: 'year', start: '2026-01-01', end: '2026-12-31', createdAt: local(2026, 1, 2).getTime() },
  { id: 'g2', name: 'Run 1,000 km', unit: 'km', target: 1000, count: 812, period: 'year', start: '2026-01-01', end: '2026-12-31', createdAt: local(2026, 1, 2).getTime() },
];
const DEMO_LINKS = [
  { id: 'l1', name: 'Mail', url: 'https://mail.example.com/' },
  { id: 'l2', name: 'Calendar', url: 'https://calendar.example.com/' },
  { id: 'l3', name: 'Docs', url: 'https://docs.example.org/' },
  { id: 'l4', name: 'News', url: 'https://news.example.com/' },
  { id: 'l5', name: 'Bank', url: 'https://bank.example.com/login' },
];
const YEAR_2026 = [local(2026, 1, 1), local(2027, 1, 1)];

// --- New tab features: hero, goals, quick links, share card, repeating countdowns -----------

await test('hero year row, compact rows, short durations in Manrope, hover-only row actions', async () => {
  const page = await openNewTab({ time: DEMO_NOW, colorScheme: 'light' });
  await resetStorage(page, { countdowns: DEMO_COUNTDOWNS });
  await page.reload();
  await item(page, 'Marathon').waitFor();
  const year = row(page, 'year');
  assert.ok(await year.evaluate((element) => element.classList.contains('period-hero')));
  assert.equal(await rowText(page, 'year', 'percent'), percent(...YEAR_2026, DEMO_NOW, 2));
  assert.equal(await year.locator('.period-of').textContent(), 'of 2026');
  const size = (locator) => locator.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize));
  const heroSize = await size(year.locator('.period-percent'));
  assert.ok(heroSize >= 3 * (await size(row(page, 'month').locator('.period-percent'))), `hero ${heroSize}px`);
  // Still one progressbar, now cut into 20 segments by a mask.
  const bar = year.locator('[role="progressbar"]');
  assert.equal(Number(await bar.getAttribute('aria-valuenow')), Number.parseFloat(await rowText(page, 'year', 'percent')));
  const mask = await bar.evaluate((element) => getComputedStyle(element).maskImage || getComputedStyle(element).webkitMaskImage);
  assert.match(mask, /repeating-linear-gradient/);
  assert.ok((await bar.boundingBox()).height >= 13, 'thicker bar');
  for (const kind of ['month', 'week', 'day']) {
    assert.ok(await row(page, kind).evaluate((element) => element.classList.contains('period-compact')), kind);
    assert.ok((await row(page, kind).boundingBox()).height < 60, `${kind} row is compact`);
  }
  // Durations: Manrope with tabular digits, smaller muted units; JetBrains Mono only for percentages.
  assert.deepEqual(await status(page, 'Marathon'), { shown: '183 d 22 h', spoken: '183 days 22 h left' });
  const style = await item(page, 'Marathon').locator('.countdown-status').evaluate((element) => {
    const own = getComputedStyle(element);
    const unit = getComputedStyle(element.querySelector('.unit'));
    return { font: own.fontFamily, numeric: own.fontVariantNumeric, unitSize: Number.parseFloat(unit.fontSize), size: Number.parseFloat(own.fontSize), unitColor: unit.color };
  });
  assert.match(style.font, /^"?Manrope Variable/);
  assert.equal(style.numeric, 'tabular-nums');
  assert.ok(style.unitSize < style.size, 'units are smaller');
  assert.equal(style.unitColor, await page.evaluate(() => getComputedStyle(document.querySelector('.period-caption')).color), 'units are muted');
  assert.match(await year.locator('.period-percent').evaluate((element) => getComputedStyle(element).fontFamily), /^"?JetBrains Mono Variable/);
  // Edit and delete appear on hover (and keyboard focus), not on every row at once.
  const opacity = (name) => item(page, name).locator('.countdown-actions').evaluate((element) => getComputedStyle(element).opacity);
  await page.mouse.move(5, 5);
  assert.deepEqual(await Promise.all(['Marathon', 'Flight to Lisbon', 'Rent'].map(opacity)), ['0', '0', '0']);
  await item(page, 'Marathon').hover();
  await waitFor(async () => (await opacity('Marathon')) === '1', 'actions on hover');
  assert.equal(await opacity('Flight to Lisbon'), '0');
  // Passed one-off countdowns wait under "Past", collapsed.
  assert.ok(await item(page, 'Q3 report due').isHidden());
  assert.equal(await page.locator('.past-toggle .past-count').textContent(), '1');
  // At 1280×800 the two columns end together: the left one is no longer short.
  await resetStorage(page, { countdowns: DEMO_COUNTDOWNS, goals: DEMO_GOALS, links: DEMO_LINKS });
  await page.reload();
  await goalItem(page, 'Run 1,000 km').waitFor();
  const bottoms = await page.evaluate(() => ['layout-main', 'countdowns'].map((id) => document.getElementById(id).getBoundingClientRect().bottom));
  assert.ok(bottoms.every((bottom) => bottom <= 800), `fits 1280×800: ${bottoms}`);
  assert.ok(Math.abs(bottoms[0] - bottoms[1]) < 40, `columns end together: ${bottoms}`);
});

await test('goals: add, validate, +1 / −1, pace verdict and marker, custom dates, edit, delete + undo, persist', async () => {
  const now = DEMO_NOW;
  const page = await openNewTab({ time: now, colorScheme: 'light' });
  await resetStorage(page);
  await page.reload();
  await page.locator('#goals[data-state="ready"]').waitFor({ state: 'attached' });

  // Empty state with one clear action.
  await page.locator('.goals-empty:not([hidden])', { hasText: 'Set a goal, like “Read 24 books”' }).waitFor();
  assert.ok(await page.locator('#add-goal').isHidden());
  await page.locator('.goals-empty button', { hasText: 'Add goal' }).click();
  const form = page.locator('.goal-form');
  const field = (name) => form.locator(`input[id$="-${name}"]`);
  assert.ok(await field('name').evaluate((input) => input === document.activeElement), 'name focused');
  assert.ok(await form.locator('input[value="year"]').isChecked(), 'this year by default');
  assert.ok(await field('start').isHidden(), 'dates only for a custom period');

  // Validation: nothing saved, every problem explained.
  await field('target').fill('0');
  await page.keyboard.press('Enter');
  await form.locator('.invalid-feedback', { hasText: 'Give the goal a name.' }).waitFor();
  await form.locator('.invalid-feedback', { hasText: 'Set a target of at least 1.' }).waitFor();
  assert.equal(await field('target').getAttribute('aria-invalid'), 'true');
  await shot(page, 'goal-form-errors');
  assert.equal((await readStorage(page)).goals, undefined);

  await field('name').fill('Read 24 books');
  await field('target').fill('24');
  await field('unit').fill('books');
  await field('count').fill('17');
  await page.keyboard.press('Enter');
  const books = goalItem(page, 'Read 24 books');
  await books.waitFor();
  const expected = paceVerdict({ target: 24, count: 17, unit: 'books' }, ...YEAR_2026, now);
  assert.equal(expected, '2 books behind pace');
  assert.equal(await books.locator('.goal-summary').textContent(), `17 of 24 · ${expected}`);
  assert.equal(await books.locator('.goal-period').textContent(), '2026');
  // The marker sits where the year is.
  const elapsed = (now - YEAR_2026[0]) / (YEAR_2026[1] - YEAR_2026[0]);
  assert.equal(await books.locator('.goal-marker').evaluate((marker) => marker.style.left), `${Math.round(elapsed * 10_000) / 100}%`);
  const track = books.locator('.goal-track');
  const [trackBox, markerBox] = [await track.boundingBox(), await books.locator('.goal-marker').boundingBox()];
  assert.ok(Math.abs(markerBox.x + markerBox.width / 2 - (trackBox.x + trackBox.width * elapsed)) < 2, 'marker at the year position');
  const bar = books.getByRole('progressbar', { name: 'Read 24 books' });
  assert.equal(await bar.getAttribute('aria-valuenow'), '70');
  assert.equal(await bar.getAttribute('aria-valuetext'), '17 of 24 · 2 books behind pace. On pace today: 19.');
  assert.ok(await page.locator('#add-goal').evaluate((button) => button === document.activeElement), 'focus back on Add');

  // +1 / −1, with the mouse and the keyboard; each step is saved and announced.
  await books.getByRole('button', { name: 'One more for “Read 24 books”' }).click();
  await books.locator('.goal-summary', { hasText: '18 of 24 · 1 behind pace' }).waitFor();
  await books.getByRole('button', { name: 'One more for “Read 24 books”' }).press('Enter');
  await books.locator('.goal-summary', { hasText: '19 of 24 · on pace' }).waitFor();
  assert.ok(await books.locator('.goal-verdict').evaluate((element) => element.classList.contains('is-good')));
  await page.locator('#goals [aria-live="polite"]', { hasText: 'Read 24 books: 19 of 24 · on pace.' }).waitFor({ state: 'attached' });
  await waitFor(async () => (await readStorage(page)).goals?.[0]?.count === 19, 'count saved');
  // Fast clicks are never lost.
  for (let i = 0; i < 5; i++) await books.getByRole('button', { name: 'One more for “Read 24 books”' }).click();
  await books.locator('.goal-summary', { hasText: '24 of 24 · goal reached' }).waitFor();
  await books.getByRole('button', { name: 'One more for “Read 24 books”' }).click();
  await books.locator('.goal-summary', { hasText: '25 of 24 · goal reached, 1 over' }).waitFor();
  for (let i = 0; i < 8; i++) await books.getByRole('button', { name: 'One less for “Read 24 books”' }).click();
  await books.locator('.goal-summary', { hasText: '17 of 24 · 2 books behind pace' }).waitFor();
  await waitFor(async () => (await readStorage(page)).goals?.[0]?.count === 17, 'count saved');

  // A custom period: the last day can't be before the first.
  await page.locator('#add-goal').click();
  await field('name').fill('Ship 12 releases');
  await field('target').fill('12');
  await field('unit').fill('releases');
  await form.locator('label', { hasText: 'Dates' }).click();
  await field('start').fill('2026-10-01');
  await field('end').fill('2026-09-30');
  await page.keyboard.press('Enter');
  await form.locator('.invalid-feedback', { hasText: 'The last day can’t be before the first.' }).waitFor();
  await field('end').fill('2026-12-31');
  await field('count').fill('2');
  await page.keyboard.press('Enter');
  const ships = goalItem(page, 'Ship 12 releases');
  await ships.waitFor();
  const q4 = [local(2026, 10, 1), local(2027, 1, 1)];
  assert.equal(await ships.locator('.goal-period').textContent(), 'Oct 1 – Dec 31, 2026');
  assert.equal(await ships.locator('.goal-verdict').textContent(), paceVerdict({ target: 12, count: 2, unit: 'releases' }, ...q4, now));
  assert.deepEqual(await goalNames(page), ['Read 24 books', 'Ship 12 releases']);

  // Edit: this month instead; the id and creation time stay. Escape cancels.
  const before = (await readStorage(page)).goals.find((goal) => goal.name === 'Ship 12 releases');
  await ships.hover();
  await ships.getByRole('button', { name: 'Edit “Ship 12 releases”' }).click();
  assert.equal(await field('start').inputValue(), '2026-10-01');
  await field('name').fill('Changed my mind');
  await page.keyboard.press('Escape');
  await form.waitFor({ state: 'detached' });
  assert.ok(await ships.getByRole('button', { name: 'Edit “Ship 12 releases”' }).evaluate((button) => button === document.activeElement));
  await page.keyboard.press('Enter');
  await form.locator('label', { hasText: 'This month' }).click();
  await page.keyboard.press('Enter');
  await ships.locator('.goal-period', { hasText: 'October 2026' }).waitFor();
  const october = [local(2026, 10, 1), local(2026, 11, 1)];
  assert.equal(await ships.locator('.goal-verdict').textContent(), paceVerdict({ target: 12, count: 2, unit: 'releases' }, ...october, now));
  const after = (await readStorage(page)).goals.find((goal) => goal.id === before.id);
  assert.deepEqual(after, { ...before, period: 'month', start: '2026-10-01', end: '2026-10-31' });

  // Delete with undo: it comes back in the same place.
  await books.hover();
  await books.getByRole('button', { name: 'Delete “Read 24 books”' }).click();
  await page.locator('#toast.show', { hasText: 'Deleted “Read 24 books”.' }).waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'toast-action');
  await page.keyboard.press('Enter');
  await books.waitFor();
  assert.deepEqual(await goalNames(page), ['Read 24 books', 'Ship 12 releases']);

  // Everything survives a reload.
  await page.reload();
  await goalItem(page, 'Ship 12 releases').waitFor();
  assert.deepEqual(await goalNames(page), ['Read 24 books', 'Ship 12 releases']);
  assert.equal(await goalItem(page, 'Read 24 books').locator('.goal-summary').textContent(), '17 of 24 · 2 books behind pace');

  // Last year's goal shows its final verdict; saving it again starts it for this year.
  await page.evaluate(async (goal) => {
    const { goals } = await chrome.storage.local.get('goals');
    await chrome.storage.local.set({ goals: [...goals, goal] });
  }, { id: 'old', name: 'Read 20 books', unit: 'books', target: 20, count: 14, period: 'year', start: '2025-01-01', end: '2025-12-31', createdAt: 1 });
  const old = goalItem(page, 'Read 20 books');
  await old.locator('.goal-summary', { hasText: '14 of 20 · ended 6 books short' }).waitFor();
  assert.equal(await old.locator('.goal-period').textContent(), '2025');
  await old.hover();
  await old.getByRole('button', { name: 'Edit “Read 20 books”' }).click();
  await form.locator('.goal-period-note', { hasText: '2025 is over. Saving starts this goal again for the current year; set “Done so far” to 0 to start from scratch.' }).waitFor();
  await field('count').fill('0');
  await page.keyboard.press('Enter');
  await old.locator('.goal-period', { hasText: '2026' }).waitFor();
  assert.equal(await old.locator('.goal-verdict').textContent(), paceVerdict({ target: 20, count: 0, unit: 'books' }, ...YEAR_2026, now));
  await resetStorage(page);
});

await test('quick links: add, http(s) only, letter tiles, edit, reorder, delete + undo, open without a referrer', async () => {
  const opened = [];
  await context.route('https://news.example.com/**', (route) => {
    opened.push({ url: route.request().url(), referer: route.request().headers().referer });
    return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>News</title><h1>News</h1>' });
  });
  const page = await openNewTab({ time: DEMO_NOW, colorScheme: 'light' });
  await resetStorage(page, { countdowns: DEMO_COUNTDOWNS, goals: DEMO_GOALS });
  await page.reload();
  await page.locator('#links[data-state="ready"]').waitFor({ state: 'attached' });
  await page.locator('.link-hint', { hasText: 'Add the sites you open every day.' }).waitFor();

  const add = page.getByRole('button', { name: 'Add a quick link' });
  await add.click();
  const url = page.locator('#link-url');
  assert.ok(await url.evaluate((input) => input === document.activeElement), 'address focused');
  for (const bad of ['javascript:alert(1)', 'ftp://files.example.com', 'data:text/html,hi']) {
    await url.fill(bad);
    await page.keyboard.press('Enter');
    await page.locator('#link-url-error', { hasText: 'Only web addresses (http:// or https://) can be added.' }).waitFor();
  }
  await url.fill('');
  await page.keyboard.press('Enter');
  await page.locator('#link-url-error', { hasText: 'Enter a web address.' }).waitFor();
  assert.equal((await readStorage(page)).links, undefined);

  // A bare host gets https://; without a name the tile is named after the site.
  await url.fill('mail.example.com');
  await page.keyboard.press('Enter');
  await tile(page, 'mail.example.com').waitFor();
  for (const [name, address] of [
    ['Calendar', 'https://calendar.example.com/'],
    ['News', 'news.example.com/today'],
  ]) {
    await add.click();
    await url.fill(address);
    await page.locator('#link-name').fill(name);
    await page.keyboard.press('Enter');
    await tile(page, name).waitFor();
  }
  assert.deepEqual(await tileNames(page), ['mail.example.com', 'Calendar', 'News']);
  const anchor = tile(page, 'News').locator('a');
  assert.equal(await anchor.getAttribute('href'), 'https://news.example.com/today');
  assert.equal(await anchor.getAttribute('rel'), 'noreferrer');
  assert.deepEqual(await page.locator('.link-tile:not(.link-add-tile) .link-avatar').allTextContents(), ['M', 'C', 'N']);
  const avatar = await tile(page, 'News').locator('.link-avatar').evaluate((element) => [getComputedStyle(element).backgroundColor, getComputedStyle(element).color]);
  assert.deepEqual(avatar, ['rgb(227, 248, 239)', 'rgb(8, 127, 91)'], 'letter avatar in the accent colors');
  assert.equal(await page.locator('.link-tile img, .link-tile [src]').count(), 0, 'no favicons, nothing loaded');

  // Edit (the pencil shows on hover or focus).
  const mail = tile(page, 'mail.example.com');
  await mail.hover();
  await mail.getByRole('button', { name: 'Edit “mail.example.com”' }).click();
  assert.equal(await url.inputValue(), 'https://mail.example.com/');
  await page.locator('#link-name').fill('Mail');
  await page.keyboard.press('Enter');
  await tile(page, 'Mail').waitFor();

  // Reorder with Move left / Move right; they stop at the ends.
  const news = tile(page, 'News');
  await news.locator('.link-edit').focus();
  await page.keyboard.press('Enter');
  const left = page.getByRole('button', { name: 'Move left' });
  await left.click();
  await waitFor(async () => (await tileNames(page)).join() === 'Mail,News,Calendar', 'moved once');
  await left.click();
  await waitFor(async () => (await tileNames(page)).join() === 'News,Mail,Calendar', 'moved twice');
  assert.ok(await left.isDisabled(), 'first place: no further left');
  assert.ok(await page.getByRole('button', { name: 'Move right' }).evaluate((button) => button === document.activeElement), 'focus stays in the form');
  await page.locator('#links [aria-live]', { hasText: 'News: position 1 of 3.' }).waitFor({ state: 'attached' });
  await shot(page, 'links-edit-1280x800-light', { curated: true });
  await page.keyboard.press('Escape');
  await page.locator('.link-form').waitFor({ state: 'detached' });
  assert.ok(await news.locator('.link-edit').evaluate((button) => button === document.activeElement));
  assert.deepEqual((await readStorage(page)).links.map((link) => link.name), ['News', 'Mail', 'Calendar']);

  // Delete from the form, undo puts it back where it was.
  await tile(page, 'Mail').hover();
  await tile(page, 'Mail').locator('.link-edit').click();
  await page.locator('.link-form').getByRole('button', { name: 'Delete' }).click();
  await page.locator('#toast.show', { hasText: 'Deleted “Mail”.' }).waitFor();
  assert.deepEqual(await tileNames(page), ['News', 'Calendar']);
  await page.locator('#toast-action').click();
  await tile(page, 'Mail').waitFor();
  assert.deepEqual(await tileNames(page), ['News', 'Mail', 'Calendar']);

  // Survives a reload; a click opens the site in this tab, without the extension as referrer.
  await page.reload();
  await tile(page, 'Calendar').waitFor();
  assert.deepEqual(await tileNames(page), ['News', 'Mail', 'Calendar']);
  await resetStorage(page);
  await page.evaluate(async (links) => chrome.storage.local.set({ links }), [{ id: 'n', name: 'News', url: 'https://news.example.com/today' }]);
  await tile(page, 'News').locator('a').click();
  await page.waitForURL('https://news.example.com/today');
  assert.equal(await page.title(), 'News');
  assert.deepEqual(opened, [{ url: 'https://news.example.com/today', referer: undefined }]);
  await context.unroute('https://news.example.com/**');
});

await test('repeating countdowns roll over at their exact minute; Feb 29 -> Feb 28; month ends', async () => {
  const page = await openNewTab({ install: local(2026, 10, 31, 8, 59) });
  await resetStorage(page);
  await page.reload();
  await page.locator('#countdowns[data-state="ready"]').waitFor({ state: 'attached' });
  // Stop the clock ten seconds before 09:00 (timers up to then have run).
  await page.clock.pauseAt(local(2026, 10, 31, 8, 59, 50));

  const add = async (fields) => {
    await page.locator('#add-countdown:not([hidden]), .countdowns-empty:not([hidden]) button').first().click();
    await page.locator('.countdown-form input[type="text"]').fill(fields.name);
    await page.locator('.countdown-form input[type="date"]').fill(fields.date);
    if (fields.time) await page.locator('.countdown-form input[type="time"]').fill(fields.time);
    await page.locator('.countdown-form select').selectOption(fields.repeat);
    await page.keyboard.press('Enter');
    await item(page, fields.name).waitFor();
  };
  // Rent on the 31st at 09:00, every month.
  await add({ name: 'Rent', date: '2026-01-31', time: '09:00', repeat: 'monthly' });
  const rent = item(page, 'Rent');
  assert.equal(await rent.locator('.countdown-target > span:first-child').textContent(), 'Sat, Oct 31, 2026 · 09:00');
  assert.equal(await rent.locator('.countdown-repeat').textContent(), 'every month');
  assert.deepEqual(await status(page, 'Rent'), { shown: '10 s', spoken: '10 s left' });
  // At 09:00 it rolls over to November 30 (November has no 31st), and never shows as passed.
  await page.clock.runFor(11_000);
  await rent.locator('.countdown-target', { hasText: 'Mon, Nov 30, 2026 · 09:00' }).waitFor();
  assert.deepEqual(await status(page, 'Rent'), { shown: '30 d', spoken: '30 days left' });
  assert.ok(await page.locator('.countdowns-past').isHidden(), 'nothing in Past');

  // A birthday on Feb 29 falls on Feb 28 next year.
  await add({ name: 'Leap birthday', date: '2000-02-29', repeat: 'yearly' });
  assert.equal(await item(page, 'Leap birthday').locator('.countdown-target > span:first-child').textContent(), 'Sun, Feb 28, 2027');
  assert.equal(await item(page, 'Leap birthday').locator('.countdown-repeat').textContent(), 'every year');
  assert.deepEqual(
    (await readStorage(page)).countdowns.map(({ name, date, repeat }) => ({ name, date, repeat })),
    [
      { name: 'Rent', date: '2026-01-31', repeat: 'monthly' },
      { name: 'Leap birthday', date: '2000-02-29', repeat: 'yearly' },
    ],
  );

  // Turning the repeat off makes it a one-off again: its first date is long gone, so it moves to Past.
  await item(page, 'Leap birthday').hover();
  await item(page, 'Leap birthday').getByRole('button', { name: 'Edit “Leap birthday”' }).click();
  assert.equal(await page.locator('.countdown-form select').inputValue(), 'yearly');
  await page.locator('.countdown-form select').selectOption('none');
  await page.keyboard.press('Enter');
  await page.locator('.past-toggle .past-count', { hasText: '1' }).waitFor();
  await page.locator('#countdowns-past .countdown', { hasText: 'Leap birthday' }).waitFor();
  assert.deepEqual(await status(page, 'Leap birthday'), { shown: 'passed 9,741 days ago', spoken: 'passed 9,741 days ago' });
  await resetStorage(page);
});

await test('share card: year, month, Life in weeks, a countdown; 1200×630 PNG download; copy image without a permission', async () => {
  const page = await openNewTab({ time: DEMO_NOW, colorScheme: 'light' });
  await resetStorage(page, { countdowns: DEMO_COUNTDOWNS, goals: DEMO_GOALS, links: DEMO_LINKS, settings: { life: { birthDate: '1990-05-01', years: 80 } } });
  await page.reload();
  await item(page, 'Marathon').waitFor();
  await goalItem(page, 'Run 1,000 km').waitFor();

  const share = row(page, 'year').getByRole('button', { name: 'Share' });
  await share.click();
  const dialog = page.locator('dialog#share[open]');
  await dialog.waitFor();
  assert.equal(await dialog.getAttribute('aria-labelledby'), 'share-title');
  assert.ok(await page.locator('#share-kind-year').evaluate((input) => input === document.activeElement && input.checked));
  const preview = page.locator('.share-preview[data-state="ready"]');
  await preview.waitFor();
  const canvas = page.locator('canvas.share-canvas');
  const yearText = `2026 is ${percent(...YEAR_2026, DEMO_NOW, 2)} complete`;
  assert.equal(await canvas.getAttribute('aria-label'), `Preview: ${yearText} · ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░ · Day 289 of 365 · 76 days 14 h left`);

  // The pixels: theme background, a white card, 15 of 20 blocks in the accent color.
  const pixels = await canvas.evaluate((element) => {
    const context = element.getContext('2d');
    const at = (x, y) => [...context.getImageData(x, y, 1, 1).data.slice(0, 3)].join(',');
    const blocks = [];
    const block = (960 - 19 * 8) / 20;
    for (let index = 0; index < 20; index++) {
      const x = Math.round(120 + index * (block + 8) + block / 2);
      let color = 'none';
      for (let y = 150; y < 480; y++) {
        const rgb = at(x, y);
        if (rgb === '12,166,120') color = 'accent';
        else if (rgb === '232,238,235' && color === 'none') color = 'track';
      }
      blocks.push(color);
    }
    return { size: [element.width, element.height], page: at(5, 5), card: at(100, 100), blocks };
  });
  assert.deepEqual(pixels.size, [1200, 630]);
  assert.equal(pixels.page, '244,247,246');
  assert.equal(pixels.card, '255,255,255');
  assert.deepEqual(pixels.blocks, [...Array(15).fill('accent'), ...Array(5).fill('track')]);
  await shot(page, 'share-1280x800-light', { curated: true });

  // Download PNG: a plain download link (blob: URL), no permission.
  const link = dialog.getByRole('link', { name: 'Download PNG' });
  assert.match(await link.getAttribute('href'), /^blob:chrome-extension:\/\//);
  const [download] = await Promise.all([page.waitForEvent('download'), link.click()]);
  assert.equal(download.suggestedFilename(), 'progress-tab-2026.png');
  const png = await readFile(await download.path());
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  assert.deepEqual(pngSize(png), { width: 1200, height: 630 });
  await copyFile(await download.path(), join(screenshotsDir, 'share-card-year.png'));

  // Copy image: works from the click on the extension page without the clipboardWrite permission
  // (the manifest test asserts it isn't there). Checked by really pasting it.
  await dialog.getByRole('button', { name: 'Copy image' }).click();
  await dialog.locator('.share-status', { hasText: 'Copied. Paste it into a chat or post.' }).waitFor();
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
  assert.ok(await share.evaluate((button) => button === document.activeElement), 'focus back on Share');
  const pasted = await page.evaluate(async () => {
    const target = document.createElement('textarea');
    document.body.append(target);
    target.focus();
    const result = new Promise((resolve) =>
      document.addEventListener('paste', async (event) => {
        const file = [...event.clipboardData.files][0];
        const buffer = file ? new DataView(await file.arrayBuffer()) : null;
        resolve(file ? { type: file.type, width: buffer.getUint32(16), height: buffer.getUint32(20) } : null);
      }, { once: true }),
    );
    globalThis.__pasted = result;
    return true;
  });
  assert.ok(pasted);
  await page.keyboard.press('Control+V');
  assert.deepEqual(await page.evaluate(() => globalThis.__pasted), { type: 'image/png', width: 1200, height: 630 });
  await page.evaluate(() => {
    document.querySelector('body > textarea')?.remove();
    window.scrollTo(0, 0);
  });

  // The other cards.
  await share.click();
  await preview.waitFor();
  await page.locator('label[for="share-kind-month"]').click();
  await page.locator('canvas.share-canvas[data-kind="month"]').waitFor();
  await preview.waitFor();
  assert.match(await canvas.getAttribute('aria-label'), /^Preview: October 2026 is 49\.6% complete · ▓{9}░{11} · Day 16 of 31 · 15 days 14 h left$/);
  await page.locator('label[for="share-kind-life"]').click();
  await page.locator('canvas.share-canvas[data-kind="life"]').waitFor();
  const life = (DEMO_NOW - local(1990, 5, 1)) / (local(2070, 5, 1) - local(1990, 5, 1));
  assert.match(await canvas.getAttribute('aria-label'), new RegExp(`^Preview: ${percent(local(1990, 5, 1), local(2070, 5, 1), DEMO_NOW, 2).replace('.', '\\.')} of 80 years lived`));
  assert.ok(!(await canvas.getAttribute('aria-label')).includes('1990'), 'no birth date on the card');
  assert.ok(life > 0.45 && life < 0.46);
  await page.locator('label[for="share-kind-countdown"]').click();
  await page.locator('canvas.share-canvas[data-kind="countdown"]').waitFor();
  // Only what is still ahead, nearest first; passed ones aren't offered.
  assert.deepEqual(await page.locator('#share-countdown option').allTextContents(), ['Mom’s birthday', 'Flight to Lisbon', 'Rent', 'New Year’s Eve', 'Marathon']);
  await page.locator('#share-countdown').selectOption({ label: 'Flight to Lisbon' });
  await page.waitForFunction(() => document.querySelector('canvas.share-canvas')?.getAttribute('aria-label')?.includes('Flight to Lisbon'));
  await preview.waitFor();
  assert.equal(
    await canvas.getAttribute('aria-label'),
    'Preview: Flight to Lisbon in 6 days 22 h · ▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░ · Fri, Oct 23, 2026 · 07:45 · 67.8% of the wait is over',
  );
  const [countdownDownload] = await Promise.all([page.waitForEvent('download'), dialog.getByRole('link', { name: 'Download PNG' }).click()]);
  assert.equal(countdownDownload.suggestedFilename(), 'progress-tab-flight-to-lisbon.png');
  await page.keyboard.press('Escape');

  // In the dark theme the card is dark too.
  await page.emulateMedia({ colorScheme: 'dark' });
  await share.click();
  await page.locator('label[for="share-kind-year"]').click();
  await page.locator('canvas.share-canvas[data-kind="year"]').waitFor();
  await preview.waitFor();
  assert.equal(await canvas.evaluate((element) => [...element.getContext('2d').getImageData(5, 5, 1, 1).data.slice(0, 3)].join(',')), '16,20,19');
  await shot(page, 'share-1280x800-dark', { curated: true });
  await page.keyboard.press('Escape');

  // Free plan: Life in weeks is Pro, with a way to learn about it.
  await reloadAsFree(page);
  await share.click();
  await preview.waitFor();
  assert.ok(await page.locator('#share-kind-life').isDisabled());
  await page.locator('.share-note', { hasText: 'Life in weeks is part of Pro.' }).waitFor();
  await page.locator('.share-note').getByRole('button', { name: 'About Pro' }).click();
  await page.locator('#settings.show').waitFor();
  await page.waitForFunction(() => document.activeElement?.id === 'about-pro');
  assert.ok(await page.locator('dialog#share').evaluate((element) => !element.open));
  await resetStorage(page);
});

// --- Free vs Pro ------------------------------------------------------------------------

const PRO_THEMES = {
  paper: { light: 'rgb(248, 244, 237)', dark: 'rgb(21, 18, 14)' },
  slate: { light: 'rgb(241, 244, 248)', dark: 'rgb(14, 19, 26)' },
  sage: { light: 'rgb(241, 245, 238)', dark: 'rgb(16, 21, 15)' },
  clay: { light: 'rgb(248, 242, 238)', dark: 'rgb(24, 17, 15)' },
  contrast: { light: 'rgb(255, 255, 255)', dark: 'rgb(0, 0, 0)' },
};

/** Reloads with early access switched off (e2e build only), so the free plan applies. */
async function reloadAsFree(page) {
  await page.evaluate(() => localStorage.setItem('progress-tab:e2e-early-access', 'off'));
  await page.reload();
  await page.locator('#countdowns[data-state="ready"]').waitFor({ state: 'attached' });
}

await test('early access: About Pro card, PRO badges, every Pro theme applies in light and dark', async () => {
  const page = await openNewTab({ time: local(2026, 9, 27, 12), colorScheme: 'light' });
  await resetStorage(page);
  await page.reload();
  await page.locator('#countdowns[data-state="ready"]').waitFor({ state: 'attached' });
  await page.locator('#open-settings').click();
  await page.locator('#settings.show').waitFor();

  const card = page.locator('#about-pro');
  assert.equal(await card.locator('h3').textContent(), 'About Pro');
  assert.equal(await card.locator('.pro-price').textContent(), '$1.99 once');
  assert.deepEqual(await card.locator('.pro-features strong').allTextContents(), [
    'Unlimited goals',
    'Unlimited countdowns',
    'Unlimited quick links',
    'Theme pack',
    'Life in weeks',
  ]);
  assert.ok(await card.getByRole('button', { name: 'Get Pro' }).isDisabled());
  assert.equal(await card.locator('.pro-status').textContent(), 'Free during early access');

  // 3 free + 5 Pro themes, each Pro one badged; nothing is locked in early access.
  assert.equal(await page.locator('#theme input[name="theme"]').count(), 8);
  assert.deepEqual(await page.locator('#theme .theme-tile:has(.badge-pro) .theme-name').allTextContents(), ['Paper', 'Slate', 'Sage', 'Clay', 'High contrast']);
  assert.equal(await page.locator('#theme input:disabled, #widget-switches input:disabled').count(), 0);
  assert.ok(await page.locator('#themes-locked').isHidden());
  assert.equal(await page.locator('label[for="show-lifeWeeks"] .badge-pro').textContent(), 'Pro');

  const background = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  for (const [id, expected] of Object.entries(PRO_THEMES)) {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.locator(`label[for="theme-${id}"]`).click();
    await waitFor(async () => (await background()) === expected.light, `${id} light background`);
    // Pro themes follow the OS: the dark variant applies when it switches.
    await page.emulateMedia({ colorScheme: 'dark' });
    await waitFor(async () => (await background()) === expected.dark, `${id} dark background`);
    assert.equal(await page.evaluate(() => document.documentElement.dataset.scheme), 'dark');
  }
  await page.locator('#save-status', { hasText: 'Saved' }).waitFor();
  await waitFor(async () => (await readStorage(page)).settings.theme === 'contrast', 'theme saved');

  // Applied before the first paint on the next tab, too.
  const next = await newPage();
  await next.emulateMedia({ colorScheme: 'dark' });
  await next.addInitScript(() =>
    window.addEventListener('DOMContentLoaded', () => {
      globalThis.__bg = getComputedStyle(document.body).backgroundColor;
    }),
  );
  await next.goto(newtabUrl);
  assert.equal(await next.evaluate(() => globalThis.__bg), PRO_THEMES.contrast.dark);
  await resetStorage(next);
});

await test('life in weeks: explained setup, validation, canvas grid, edit, forget', async () => {
  const page = await openNewTab({ time: DEMO_NOW_LIFE, colorScheme: 'light' });
  await resetStorage(page);
  await page.reload();
  await page.locator('#countdowns[data-state="ready"]').waitFor({ state: 'attached' });
  assert.ok(await page.locator('#life').isHidden(), 'off by default');

  await page.locator('#open-settings').click();
  await page.locator('label[for="show-lifeWeeks"]').click();
  await page.keyboard.press('Escape');
  await page.locator('#life:not([hidden])').waitFor();

  // Setup: the privacy note is right there, and nothing is saved until the form is valid.
  await page.locator('#life .life-privacy', { hasText: 'Your birth date is stored only in this browser' }).waitFor();
  assert.equal(await page.locator('#life-years').inputValue(), '80');
  await shot(page, 'life-weeks-setup');
  await page.locator('#life').getByRole('button', { name: 'Show my weeks' }).click();
  await page.locator('#life-birth-error', { hasText: 'Enter your birth date.' }).waitFor();
  assert.ok(await page.locator('#life-birth').evaluate((input) => input === document.activeElement));
  await page.locator('#life-birth').fill('2030-01-01');
  await page.keyboard.press('Enter');
  await page.locator('#life-birth-error', { hasText: 'That date is in the future.' }).waitFor();
  await page.locator('#life-birth').fill('1990-05-01');
  await page.locator('#life-years').fill('200');
  await page.keyboard.press('Enter');
  await page.locator('#life-years-error', { hasText: 'Use a whole number from 20 to 120.' }).waitFor();
  assert.equal((await readStorage(page)).settings.life.birthDate, null);
  await page.locator('#life-years').fill('80');
  await page.keyboard.press('Enter');

  await page.locator('#life .life-display:not([hidden])').waitFor();
  assert.equal(await page.locator('#life .life-caption').textContent(), 'Age 36 · week 25 of 52');
  const fraction = (DEMO_NOW_LIFE - local(1990, 5, 1)) / (local(2070, 5, 1) - local(1990, 5, 1));
  const expectedPercent = percent(local(1990, 5, 1), local(2070, 5, 1), DEMO_NOW_LIFE, 2);
  assert.equal(await page.locator('#life .life-percent').textContent(), expectedPercent);
  const lived = Math.floor(Math.round((Date.UTC(2026, 9, 16) - Date.UTC(1990, 4, 1)) / DAY) / 7);
  const total = Math.floor(Math.round((Date.UTC(2070, 4, 1) - Date.UTC(1990, 4, 1)) / DAY) / 7);
  const summary = `${lived.toLocaleString('en-US')} weeks lived, about ${(total - lived).toLocaleString('en-US')} left of 80 years (${expectedPercent}).`;
  assert.equal(await page.locator('#life .life-summary').textContent(), summary);
  const canvas = page.locator('#life canvas.life-grid');
  assert.equal(await canvas.getAttribute('role'), 'img');
  assert.equal(await canvas.getAttribute('aria-label'), `Life in weeks: ${summary}`);
  assert.ok(await page.locator('#life-edit').evaluate((button) => button === document.activeElement), 'focus on Edit after saving');
  assert.deepEqual((await readStorage(page)).settings.life, { birthDate: '1990-05-01', years: 80 });

  // One canvas, a handful of elements: not thousands of DOM nodes.
  assert.ok((await page.locator('#life *').count()) < 60, 'few DOM nodes');
  // The canvas really shows the weeks: lived squares in the accent, the rest in the track color.
  const pixels = await canvas.evaluate((element) => {
    const { data } = element.getContext('2d').getImageData(0, 0, element.width, element.height);
    const counts = { lived: 0, future: 0, now: 0 };
    for (let i = 0; i < data.length; i += 4) {
      const rgb = `${data[i]},${data[i + 1]},${data[i + 2]}`;
      if (rgb === '12,166,120') counts.lived++;
      else if (rgb === '232,238,235') counts.future++;
      else if (rgb === '8,127,91') counts.now++;
    }
    return { ...counts, width: element.width, height: element.height };
  });
  assert.ok(pixels.height > 150 && pixels.width > 300, JSON.stringify(pixels));
  const livedShare = pixels.lived / (pixels.lived + pixels.future);
  const gridShare = (36 * 52 + 24) / (80 * 52);
  assert.ok(Math.abs(livedShare - gridShare) < 0.01, `lived share ${livedShare} vs ${gridShare} (${fraction})`);
  assert.ok(pixels.now > 0, 'this week is marked');
  await shot(page, 'life-weeks-set-up');

  // Survives a reload (and shows up with the rest of the page).
  await page.reload();
  await page.locator('#life .life-display:not([hidden])').waitFor();
  assert.equal(await page.locator('#life .life-caption').textContent(), 'Age 36 · week 25 of 52');

  // Edit the span; Esc cancels, Enter saves.
  await page.locator('#life-edit').click();
  assert.equal(await page.locator('#life-birth').inputValue(), '1990-05-01');
  await page.locator('#life-years').fill('90');
  await page.keyboard.press('Escape');
  await page.locator('#life .life-display:not([hidden])').waitFor();
  assert.ok(await page.locator('#life-edit').evaluate((button) => button === document.activeElement));
  await page.keyboard.press('Enter');
  await page.locator('#life-years').fill('90');
  await page.keyboard.press('Enter');
  await page.locator('#life .life-summary', { hasText: 'left of 90 years' }).waitFor();
  await waitFor(async () => (await readStorage(page)).settings.life.years === 90, 'span saved');

  // Forget: back to the setup form, the date is gone from storage and from the paint-time cache.
  await page.locator('#life-edit').click();
  await page.getByRole('button', { name: 'Forget birth date' }).click();
  await page.locator('#life .life-form:not([hidden])').waitFor();
  // The form is already open while it saves: wait for the save to clear the field.
  await waitFor(async () => (await page.locator('#life-birth').inputValue()) === '', 'birth date field cleared');
  await waitFor(async () => (await readStorage(page)).settings.life.birthDate === null, 'birth date removed');
  assert.ok(!(await page.evaluate(() => localStorage.getItem('progress-tab:settings'))).includes('1990'));
  await resetStorage(page);
});

await test('free plan (early access off): 3 countdowns, 1 goal, 6 links, Pro locked, nothing existing is lost', async () => {
  const page = await openNewTab({ time: local(2026, 9, 27, 12), colorScheme: 'light' });
  await resetStorage(page, {
    countdowns: DEMO_COUNTDOWNS,
    goals: [
      ...DEMO_GOALS,
      { id: 'g3', name: 'Visit 6 new places', unit: 'places', target: 6, count: 2, period: 'year', start: '2026-01-01', end: '2026-12-31', createdAt: 3 },
    ],
    links: [
      ...DEMO_LINKS,
      { id: 'l6', name: 'Maps', url: 'https://maps.example.com/' },
      { id: 'l7', name: 'Music', url: 'https://music.example.com/' },
      { id: 'l8', name: 'Wiki', url: 'https://wiki.example.org/' },
    ],
    settings: { theme: 'paper', widgets: { lifeWeeks: true }, life: { birthDate: '1990-05-01', years: 80 } },
  });
  await reloadAsFree(page);
  await item(page, 'Marathon').waitFor();

  // Everything the user created stays; Pro choices fall back without being erased.
  assert.equal(await countdownItems(page).count(), 6);
  assert.deepEqual(await goalNames(page), ['Read 24 books', 'Run 1,000 km', 'Visit 6 new places']);
  assert.equal((await tileNames(page)).length, 8);

  // Goals: free tracks one; the ones above the limit keep working (+1 too), only adding is blocked.
  await page.locator('#add-goal').click();
  const goalNote = page.locator('#goals .list-limit:not([hidden])');
  await goalNote.waitFor();
  assert.equal(await goalNote.locator('p').textContent(), 'Free tracks 1 goal. Pro removes the limit. About Pro');
  assert.equal(await page.locator('.goal-form').count(), 0);
  await goalItem(page, 'Visit 6 new places').getByRole('button', { name: 'One more for “Visit 6 new places”' }).click();
  await goalItem(page, 'Visit 6 new places').locator('.goal-summary', { hasText: '3 of 6' }).waitFor();
  await shot(page, 'goals-limit-free-light', { curated: true, fullPage: true });

  // Quick links: free keeps six; all eight stay and open, adding is blocked.
  await page.getByRole('button', { name: 'Add a quick link' }).click();
  const linkNote = page.locator('#links .list-limit:not([hidden])');
  await linkNote.waitFor();
  assert.equal(await linkNote.locator('p').textContent(), 'Free keeps 6 quick links. Pro removes the limit. About Pro');
  assert.equal(await page.locator('.link-form').count(), 0);
  assert.equal(await tile(page, 'Wiki').locator('a').getAttribute('href'), 'https://wiki.example.org/');
  assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(244, 247, 246)');
  assert.ok(await page.locator('#life').isHidden());
  const stored = (await readStorage(page)).settings;
  assert.equal(stored.theme, 'paper');
  assert.equal(stored.widgets.lifeWeeks, true);

  // Adding is blocked with a calm note; edit and delete still work.
  await page.locator('#add-countdown').click();
  const note = page.locator('.countdown-limit:not([hidden])');
  await note.waitFor();
  assert.equal(await note.locator('p').textContent(), 'Free keeps 3 countdowns. Pro removes the limit. About Pro');
  assert.equal(await note.getAttribute('role'), 'status');
  assert.equal(await page.locator('.countdown-form').count(), 0);
  await shot(page, 'countdown-limit-free', { curated: false });
  await item(page, 'Marathon').getByRole('button', { name: 'Edit “Marathon”' }).click();
  await page.locator('.countdown-form input[type="text"]').fill('Marathon (Berlin)');
  await page.keyboard.press('Enter');
  await item(page, 'Marathon (Berlin)').waitFor();

  // The note links to the About Pro card.
  await page.locator('#add-countdown').click();
  await note.getByRole('button', { name: 'About Pro' }).click();
  await page.locator('#settings.show').waitFor();
  await page.waitForFunction(() => document.activeElement?.id === 'about-pro');
  assert.equal(await page.locator('#about-pro .pro-status').textContent(), 'Payments aren’t available yet.');
  assert.ok(await page.locator('#about-pro').getByRole('button', { name: 'Get Pro' }).isDisabled());
  assert.equal(await page.locator('#theme input[data-tier="pro"]:disabled').count(), 5);
  assert.ok(await page.locator('#theme-auto').isChecked(), 'shown theme is the free default');
  assert.ok(await page.locator('#show-lifeWeeks').isDisabled());
  assert.ok(await page.locator('#themes-locked').isVisible());
  assert.ok(await page.locator('#widgets-locked').isVisible());
  await page.waitForTimeout(350);
  await shot(page, 'settings-free-plan');
  await page.keyboard.press('Escape');

  // Below the limit adding works again, up to 3.
  for (const name of ['Flight to Lisbon', 'New Year’s Eve', 'Mom’s birthday', 'Rent']) {
    await item(page, name).getByRole('button', { name: /^Delete/ }).click();
    await item(page, name).waitFor({ state: 'detached' });
  }
  await waitFor(async () => (await readStorage(page)).countdowns.length === 2, 'deleted');
  await page.locator('#add-countdown').click();
  await page.locator('.countdown-form input[type="text"]').fill('Third');
  await page.locator('.countdown-form input[type="date"]').fill('2026-12-01');
  await page.keyboard.press('Enter');
  await item(page, 'Third').waitFor();
  await page.locator('#add-countdown').click();
  await note.waitFor();
  assert.equal((await readStorage(page)).countdowns.length, 3);

  // Undo restores a deleted countdown even at the limit (it's the user's data).
  await item(page, 'Third').getByRole('button', { name: /^Delete/ }).click();
  await page.locator('#toast.show').waitFor();
  await page.locator('#toast-action').click();
  await item(page, 'Third').waitFor();

  // A payments adapter writing plan: 'pro' unlocks everything live, with the saved choices.
  await page.evaluate(() => chrome.storage.local.set({ plan: 'pro' }));
  await page.waitForFunction(() => getComputedStyle(document.body).backgroundColor === 'rgb(248, 244, 237)');
  await page.locator('#life:not([hidden]) .life-display').waitFor();
  assert.ok(await page.locator('.countdown-limit').isHidden());
  assert.ok(await page.locator('#goals .list-limit').isHidden());
  assert.ok(await page.locator('#links .list-limit').isHidden());
  await page.locator('#add-countdown').click();
  await page.locator('.countdown-form').waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#about-pro .pro-status').textContent(), 'You have Pro. Thank you!');
  assert.ok(await page.locator('#about-pro').getByRole('button', { name: 'Get Pro' }).isHidden());
  await resetStorage(page);
});

await test('screenshots: light and dark, 1280×800 and 800×600', async () => {
  for (const [width, height] of [
    [1280, 800],
    [800, 600],
  ]) {
    for (const colorScheme of ['light', 'dark']) {
      const page = await openNewTab({ time: DEMO_NOW, viewport: { width, height }, colorScheme });
      await resetStorage(page, { countdowns: DEMO_COUNTDOWNS, goals: DEMO_GOALS, links: DEMO_LINKS });
      await page.reload();
      await item(page, 'Marathon').waitFor();
      await goalItem(page, 'Run 1,000 km').waitFor();
      await tile(page, 'Bank').waitFor();
      const size = `${width}x${height}`;
      await page.mouse.move(width - 5, height - 5);
      await shot(page, `newtab-${size}-${colorScheme}`, { curated: true });

      // Nothing may overflow horizontally or get clipped.
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.ok(overflow <= 0, `horizontal overflow at ${size}: ${overflow}px`);

      await page.locator('#open-settings').click();
      await page.locator('#settings.show').waitFor();
      await page.waitForTimeout(350);
      await shot(page, `settings-${size}-${colorScheme}`, { curated: true });
      await page.keyboard.press('Escape');

      await page.locator('#add-countdown').click();
      await page.locator('.countdown-form input[type="text"]').fill('Summer vacation');
      await page.locator('.countdown-form input[type="date"]').fill('2027-07-01');
      await page.locator('.countdown-form select').selectOption('yearly');
      // Focus back on the name (no date selection highlighted), page scrolled to the top.
      await page.evaluate(() => {
        document.querySelector('.countdown-form input[type="text"]').focus({ preventScroll: true });
        window.scrollTo(0, 0);
      });
      await shot(page, `countdown-form-${size}-${colorScheme}`, { curated: width === 1280 });
      await page.keyboard.press('Escape');

      if (width === 1280 && colorScheme === 'light') {
        // A goal with its own dates.
        await page.locator('#add-goal').click();
        const form = page.locator('.goal-form');
        await form.locator('input[id$="-name"]').fill('Ship 12 releases');
        await form.locator('input[id$="-target"]').fill('12');
        await form.locator('input[id$="-unit"]').fill('releases');
        await form.locator('input[id$="-count"]').fill('2');
        await form.locator('label', { hasText: 'Dates' }).click();
        await form.locator('input[id$="-start"]').fill('2026-10-01');
        await form.locator('input[id$="-end"]').fill('2026-12-31');
        await form.locator('input[id$="-name"]').focus();
        await shot(page, 'goal-form-light', { curated: true, fullPage: true });
        await page.keyboard.press('Escape');
      }
      if (width === 1280 && colorScheme === 'dark') {
        // Past countdowns opened, and the actions of the row under the pointer.
        await page.locator('.past-toggle').click();
        await item(page, 'Q3 report due').waitFor();
        await item(page, 'New Year’s Eve').hover();
        await shot(page, 'countdowns-past-dark', { curated: true, fullPage: true });
      }
      await page.close();
      openPages.delete(page);
    }
  }
  // Pro: life in weeks and the theme pack, light and dark.
  for (const [colorScheme, theme] of [
    ['light', 'paper'],
    ['dark', 'slate'],
  ]) {
    const page = await openNewTab({ time: DEMO_NOW, colorScheme });
    await resetStorage(page, {
      countdowns: DEMO_COUNTDOWNS.slice(0, 4),
      links: DEMO_LINKS,
      settings: { theme, widgets: { month: false, week: false, day: false, goals: false, lifeWeeks: true }, life: { birthDate: '1990-05-01', years: 80 } },
    });
    await page.reload();
    await page.locator('#life .life-display:not([hidden])').waitFor();
    await item(page, 'Flight to Lisbon').waitFor();
    await tile(page, 'Bank').waitFor();
    await shot(page, `life-weeks-1280x800-${colorScheme}`, { curated: true });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 0, `horizontal overflow: ${overflow}px`);

    await page.locator('#open-settings').click();
    await page.locator('#settings.show').waitFor();
    await page.locator('#about-pro').scrollIntoViewIfNeeded();
    await page.waitForTimeout(350);
    await shot(page, `pro-settings-1280x800-${colorScheme}`, { curated: true });
    await page.close();
    openPages.delete(page);
  }

  // Free plan at its countdown limit (early access switched off in the e2e build).
  {
    const page = await openNewTab({ time: DEMO_NOW, colorScheme: 'light' });
    await resetStorage(page, { countdowns: DEMO_COUNTDOWNS.slice(0, 3) });
    await reloadAsFree(page);
    await item(page, 'New Year’s Eve').waitFor();
    await page.locator('#add-countdown').click();
    await page.locator('.countdown-limit:not([hidden])').waitFor();
    await shot(page, 'countdown-limit-1280x800-light', { curated: true });
    await resetStorage(page);
    await page.close();
    openPages.delete(page);
  }

  // Dark versions of the empty state and of form validation.
  const page = await openNewTab({ time: DEMO_NOW, colorScheme: 'dark' });
  await resetStorage(page);
  await page.reload();
  await page.locator('.countdowns-empty:not([hidden])').waitFor();
  await shot(page, 'state-empty-dark');
  await page.locator('.countdowns-empty button').click();
  await page.locator('.countdown-form input[type="time"]').fill('09:30');
  await page.keyboard.press('Enter');
  await page.locator('.countdown-form .invalid-feedback', { hasText: 'Give the countdown a name.' }).waitFor();
  await shot(page, 'state-form-errors-dark');
});

// --- Summary ----------------------------------------------------------------------------

await context.close();
await rm(userDataDir, { recursive: true, force: true });

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed. Screenshots: ${outputDir} (curated copies in ${screenshotsDir})`);
process.exit(failed.length ? 1 : 0);
