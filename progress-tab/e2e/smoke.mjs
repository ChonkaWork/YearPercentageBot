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
const rowText = async (page, kind, part) => (await row(page, kind).locator(`.period-${part}`).textContent())?.trim();
const countdownItems = (page) => page.locator('.countdown');
const countdownNames = (page) => page.locator('.countdown .countdown-name').allTextContents();
const item = (page, name) => page.locator('.countdown', { has: page.locator('.countdown-name', { hasText: name }) });

async function shot(page, name, { curated = false } = {}) {
  await page.evaluate(() => document.fonts.ready);
  const path = join(outputDir, `${name}.png`);
  await page.screenshot({ path, caret: 'hide', animations: 'disabled' });
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
  assert.ok(js.length < 80_000, `newtab.js is ${js.length} bytes`);
  assert.ok(css.length < 100_000, `newtab.css is ${css.length} bytes`);
  assert.ok(total < 400_000, `dist is ${total} bytes`);
  for (const [name, text] of [['js', js], ['css', css], ['html', html]]) {
    const urls = [...text.matchAll(/https?:\/\/[^\s'")]+/g)].map((match) => match[0]).filter((url) => !url.startsWith('http://www.w3.org/'));
    assert.deepEqual(urls, [], `remote URLs in ${name}`);
  }
  assert.ok(!js.includes('__E2E__') && !js.includes('__progressTabTest'), 'no test hooks in production');
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
        };
      }),
    );
  });
  await page.goto(newtabUrl);
  const atLoad = await page.evaluate(() => globalThis.__atLoad);
  assert.equal(atLoad?.bars, 4, JSON.stringify(atLoad));
  assert.match(atLoad.year, /^\d{1,3}\.\d{2}%$/);
  assert.equal(atLoad.state, 'loading');
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
  assert.equal(await rowText(page, 'year', 'left'), '95 days 12 h left');
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
  assert.equal(await rowText(page, 'week', 'left'), '6 days 12 h left');
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
  assert.equal(await rowText(midnight, 'year', 'left'), '365 days left');

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
  assert.equal((await item(page, 'Flight to Lisbon').locator('.countdown-status').textContent()).trim(), '11 days 19 h left');
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
  assert.equal((await item(page, 'Deadline').locator('.countdown-status').textContent()).trim(), '21 h 30 min left');
  assert.equal((await item(page, 'Project kickoff').locator('.countdown-status').textContent()).trim(), 'passed 26 days ago');
  // Added after its date: nothing to measure, so no bar.
  assert.ok(await item(page, 'Project kickoff').locator('.countdown-progress').isHidden());

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
    { id: before.id, name: 'Flight to Porto', date: '2026-10-30', time: '07:45', createdAt: now.getTime(), showProgress: false },
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
  assert.equal((await item(page, 'New Year').locator('.countdown-status').textContent()).trim(), '95 days 12 h left');
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
    widgets: { clock: true, year: false, month: true, week: true, day: true, countdowns: true },
    theme: 'dark',
    accent: 'blue',
    clock: '12h',
    decimals: 4,
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
  // Settings -> Add -> Edit.
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Edit “Focus me”');
  await shot(page, 'state-keyboard-focus');
  await page.keyboard.press('Enter');
  await page.locator('.countdown-form').waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Edit “Focus me”');
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Shift+Tab');
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
  await broken.locator('#page-alert:not([hidden])', { hasText: 'Couldn’t read your saved settings and countdowns (Simulated read failure)' }).waitFor();
  await broken.locator('#countdowns[data-state="error"] .countdowns-error', { hasText: 'Simulated read failure' }).waitFor();
  assert.equal(await broken.locator('#period-list [role="progressbar"]').count(), 4, 'progress still shows');
  await shot(broken, 'state-load-error');
  await broken.evaluate(() => (globalThis.__failStorage = false));
  await broken.getByRole('button', { name: 'Try again' }).click();
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
    settings: { widgets: { clock: false, year: false, month: false, week: false, day: false, countdowns: false } },
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

// --- Screenshots (curated ones are committed to screenshots/) ----------------------------

const DEMO_NOW = local(2026, 10, 16, 9, 41);
const DEMO_COUNTDOWNS = [
  { id: 'd1', name: 'Flight to Lisbon', date: '2026-10-23', time: '07:45', createdAt: local(2026, 10, 1, 20).getTime(), showProgress: true },
  { id: 'd2', name: 'New Year’s Eve', date: '2026-12-31', time: '20:00', createdAt: local(2026, 9, 1, 9).getTime(), showProgress: true },
  { id: 'd3', name: 'Mom’s birthday', date: '2026-10-16', time: null, createdAt: local(2026, 8, 20).getTime(), showProgress: false },
  { id: 'd4', name: 'Q3 report due', date: '2026-10-09', time: '17:00', createdAt: local(2026, 9, 14).getTime(), showProgress: true },
  { id: 'd5', name: 'Marathon', date: '2027-04-18', time: '08:00', createdAt: local(2026, 6, 1).getTime(), showProgress: true },
];

await test('screenshots: light and dark, 1280×800 and 800×600', async () => {
  for (const [width, height] of [
    [1280, 800],
    [800, 600],
  ]) {
    for (const colorScheme of ['light', 'dark']) {
      const page = await openNewTab({ time: DEMO_NOW, viewport: { width, height }, colorScheme });
      await resetStorage(page, { countdowns: DEMO_COUNTDOWNS });
      await page.reload();
      await item(page, 'Marathon').waitFor();
      const size = `${width}x${height}`;
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
      await shot(page, `countdown-form-${size}-${colorScheme}`, { curated: width === 1280 });
      await page.keyboard.press('Escape');
      await page.close();
      openPages.delete(page);
    }
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
