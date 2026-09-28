// End-to-end smoke test: loads the e2e build (dist-e2e/) into a real Chromium and drives every
// popup state against a local fixture server that replays recorded-style Binance and Coinbase
// payloads (the real APIs aren't reachable here, so live data is NOT exercised by this suite).
//
//   npm run test:e2e                          (set CHROMIUM_PATH if Chromium isn't auto-detected)
//   UPDATE_SCREENSHOTS=1 npm run test:e2e     also refreshes the curated screenshots/
//
// Native context menus and the toolbar button can't be clicked from automation, so the test
// calls the handler Chrome would call (exposed only in the e2e build) and opens popup.html in a
// tab, passing ?tab=<id> (honoured only in the e2e build) to say which page it was opened on.

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { startFixtureServer } from './fixture-server.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const extensionPath = join(root, 'dist-e2e');
const outputDir = join(root, 'e2e/output');
const screenshotsDir = join(root, 'screenshots');
const headless = process.env.HEADED !== '1';
/** Must match E2E_API_ORIGIN in vite.config.ts. */
const API_PORT = 47831;

function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const candidates = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  const found = candidates.find((path) => existsSync(path));
  if (!found) throw new Error('Chromium not found. Set CHROMIUM_PATH.');
  return found;
}

// --- Setup ------------------------------------------------------------------------------

const api = await startFixtureServer(API_PORT);
await mkdir(outputDir, { recursive: true });
const userDataDir = await mkdtemp(join(tmpdir(), 'crypto-signal-e2e-'));
const context = await chromium.launchPersistentContext(userDataDir, {
  executablePath: findChromium(),
  headless,
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 2,
  args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
});
const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
const extensionId = new URL(worker.url()).host;
for (let i = 0; i < 100 && !(await worker.evaluate(() => Boolean(globalThis.chrome?.storage?.local)).catch(() => false)); i++) {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

const openPages = new Set();
const requests = [];
context.on('request', (request) => requests.push(request.url()));

async function newPage() {
  const page = await context.newPage();
  openPages.add(page);
  return page;
}

/** popup.html in a 380 × 600 tab, like the toolbar popup. */
async function openPopup(params = {}) {
  const page = await newPage();
  await page.setViewportSize({ width: 380, height: 600 });
  const query = new URLSearchParams(params).toString();
  await page.goto(`chrome-extension://${extensionId}/popup.html${query ? `?${query}` : ''}`);
  return page;
}

async function openSite(path) {
  const page = await newPage();
  await page.goto(`${api.origin}${path}`);
  return page;
}

async function tabIdOf(page) {
  return worker.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({});
    return tabs.filter((tab) => tab.url === url).sort((a, b) => b.id - a.id)[0]?.id;
  }, page.url());
}

/** Fresh storage and a healthy fixture API for every test. */
async function resetState() {
  api.reset();
  await worker.evaluate(async () => {
    await chrome.storage.local.clear();
    await chrome.storage.session.clear();
  });
}

async function waitFor(check, message, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out: ${message}`);
}

const result = (page) => page.locator('.result[data-signal]');
const signalOf = async (page) => (await page.locator('#signal-label').innerText()).trim().toUpperCase();
const klineRequests = () => api.log.filter((entry) => entry.includes('/klines'));

/** The popup must never print NaN, Infinity, undefined or null. */
async function assertCleanText(page) {
  const text = await page.evaluate(() => document.body.innerText);
  assert.doesNotMatch(text, /\bNaN\b|\bInfinity\b|\bundefined\b|\bnull\b|\[object/, 'no broken values in the UI');
}

const shots = [];
async function shot(page, name, options = {}) {
  await page.evaluate(() => document.fonts.ready);
  const path = join(outputDir, `${name}.png`);
  await page.screenshot({ path, fullPage: options.fullPage ?? true });
  shots.push(name);
}

// --- Tests ------------------------------------------------------------------------------

const results = [];
async function test(name, fn) {
  const started = Date.now();
  try {
    await resetState();
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

console.log(`Chromium ${context.browser()?.version() ?? ''} · extension ${extensionId} · fixture API ${api.origin}\n`);

await test('production build: exact permissions, API hosts only, no test code, no source maps', async () => {
  const manifest = JSON.parse(await readFile(join(root, 'dist/manifest.json'), 'utf8'));
  assert.deepEqual([...manifest.permissions].sort(), ['activeTab', 'alarms', 'contextMenus', 'notifications', 'scripting', 'storage']);
  assert.deepEqual(manifest.host_permissions, ['https://api.binance.com/*', 'https://api.exchange.coinbase.com/*']);
  assert.equal(manifest.content_scripts, undefined);
  assert.deepEqual(manifest.background, { service_worker: 'background.js', type: 'module' });
  const files = await readdir(join(root, 'dist'), { recursive: true });
  assert.ok(!files.some((file) => file.endsWith('.map')), 'no source maps');
  for (const file of files.filter((file) => file.endsWith('.js') || file.endsWith('.html') || file.endsWith('.css'))) {
    const text = await readFile(join(root, 'dist', file), 'utf8');
    assert.ok(!text.includes('__cryptoSignalTest') && !text.includes('fireAlarm'), `${file}: test hook compiled out`);
    assert.ok(!text.includes('127.0.0.1'), `${file}: no fixture origin`);
    assert.ok(!text.includes('sourceMappingURL'), `${file}: no source map reference`);
  }
  // Popup and service worker share the providers (chunks/shared.js).
  const bundle = async (dir) =>
    (await Promise.all((await readdir(join(root, dir), { recursive: true })).filter((file) => file.endsWith('.js')).map((file) => readFile(join(root, dir, file), 'utf8')))).join('\n');
  const production = await bundle('dist');
  assert.ok(production.includes('https://api.binance.com') && production.includes('https://api.exchange.coinbase.com'));
  const e2e = await bundle('dist-e2e');
  assert.ok(e2e.includes(`http://127.0.0.1:${API_PORT}`), 'e2e build talks to the fixture server');
  assert.ok(e2e.includes('__cryptoSignalTest') && e2e.includes('fireAlarm'), 'e2e build has the test hook');
});

await test('loading: skeleton while market data loads', async () => {
  api.scenario.delayMs = 1500;
  const page = await openPopup();
  await page.locator('.skeleton').waitFor();
  assert.equal(await page.locator('#content').getAttribute('aria-busy'), 'true');
  assert.match(await page.locator('#last-updated').innerText(), /Loading market data/);
  await shot(page, 'loading', { fullPage: false });
  await result(page).waitFor({ timeout: 8000 });
});

await test('bullish: BTC 4h from Binance with price, indicators, analysis and reasons', async () => {
  const page = await openPopup();
  await result(page).waitFor();
  assert.equal(await signalOf(page), 'STRONG BULLISH');
  assert.equal(await page.locator('#price').innerText(), '64,231.50');
  assert.match(await page.locator('#pair').innerText(), /^BTC\/USDT$/);
  assert.match(await page.locator('.change-pill').innerText(), /^\+2\.40% 24h$/);
  assert.match(await page.locator('#strength').innerText(), /^75%$/);
  assert.equal(await page.locator('#data-source').innerText(), 'Binance');
  assert.match(await page.locator('#last-updated').innerText(), /^Last updated: (just now|\d+ sec ago)$/);
  assert.equal(await page.locator('.indicator').count(), 6);
  assert.equal(await page.locator('#reasons li').count(), 6);
  const sentences = (await page.locator('#analysis-text').innerText()).split(/(?<=\.)\s+(?=[A-Z])/);
  assert.ok(sentences.length >= 2 && sentences.length <= 4, `2–4 sentences, got ${sentences.length}`);
  assert.match(await page.locator('.disclaimer').innerText(), /not financial advice and does not guarantee future performance/);
  assert.deepEqual(klineRequests(), ['binance /api/v3/klines?symbol=BTCUSDT&interval=4h&limit=200']);
  await assertCleanText(page);
  await shot(page, 'bullish');
  await shot(page, 'bullish-popup', { fullPage: false });

  // Chart crosshair by keyboard.
  await page.locator('.chart').focus();
  await page.keyboard.press('ArrowLeft');
  await page.locator('.chart-tooltip:not([hidden])').waitFor();
  assert.match(await page.locator('.chart-tooltip').innerText(), /Price[\s\S]*EMA20[\s\S]*EMA50/);
});

await test('bearish: ETH picked from the coin list', async () => {
  const page = await openPopup();
  await result(page).waitFor();
  await page.locator('#asset-button').click();
  await page.locator('#search-results [data-symbol="ETH"]').click();
  await waitFor(async () => (await page.locator('#pair').innerText()).startsWith('ETH'), 'ETH selected');
  await result(page).waitFor();
  await waitFor(async () => (await signalOf(page)) === 'BEARISH', 'bearish signal');
  assert.equal(await page.locator('#price').innerText(), '3,120.55');
  assert.match(await page.locator('.change-pill').innerText(), /^−/);
  await assertCleanText(page);
  await shot(page, 'bearish');
  const ui = await worker.evaluate(async () => (await chrome.storage.local.get('ui')).ui);
  assert.equal(ui.lastSymbol, 'ETH');
});

await test('neutral: SOL shows mixed readings', async () => {
  await worker.evaluate(() => chrome.storage.local.set({ ui: { lastSymbol: 'SOL', lastInterval: '4h' } }));
  const page = await openPopup();
  await result(page).waitFor();
  assert.equal(await signalOf(page), 'NEUTRAL');
  assert.match(await page.locator('#analysis-text').innerText(), /^Solana has no clear direction on the 4-hour chart/);
  assert.equal(await page.locator('#reasons li[data-kind="neutral"]').count(), 6, 'a neutral market lists leanings, not ✓/⚠');
  assert.ok((await page.locator('#reasons li.lean-up').count()) > 0 && (await page.locator('#reasons li.lean-down').count()) > 0);
  await assertCleanText(page);
  await shot(page, 'neutral');
});

await test('cache: reopening within 60 s makes no request; refresh bypasses the cache', async () => {
  const first = await openPopup();
  await result(first).waitFor();
  assert.equal(klineRequests().length, 1);
  await first.close();
  const second = await openPopup();
  await result(second).waitFor();
  assert.equal(klineRequests().length, 1, 'served from chrome.storage.session');
  await second.locator('#btn-refresh').click();
  await waitFor(async () => klineRequests().length === 2, 'refresh fetched again');
  await result(second).waitFor();
  await waitFor(async () => !(await second.locator('#btn-refresh').isDisabled()), 'refresh finished');
});

await test('timeframes: 1h and 1d load their own candles and are remembered', async () => {
  const page = await openPopup();
  await result(page).waitFor();
  await page.locator('label[for="tf-1h"]').click();
  await waitFor(async () => klineRequests().some((entry) => entry.includes('interval=1h')), '1h requested');
  await waitFor(async () => (await signalOf(page).catch(() => '')) === 'BULLISH', '1h signal');
  await page.locator('label[for="tf-1d"]').click();
  await waitFor(async () => (await signalOf(page).catch(() => '')) === 'NEUTRAL', '1d signal');
  assert.match(await page.locator('#analysis-text').innerText(), /daily chart/);
  const ui = await worker.evaluate(async () => (await chrome.storage.local.get('ui')).ui);
  assert.equal(ui.lastInterval, '1d');
});

await test('fallback: Binance geo-blocked (451) → Coinbase, and Binance is skipped afterwards', async () => {
  api.scenario.binance = '451';
  const page = await openPopup();
  await result(page).waitFor();
  assert.equal(await page.locator('#data-source').innerText(), 'Coinbase Exchange');
  assert.equal(await page.locator('#pair').innerText(), 'BTC/USD');
  assert.match(await page.locator('#fallback-notice').innerText(), /Binance: restricted location\. Using Coinbase Exchange \(USD\) instead\./);
  assert.ok(api.log.some((entry) => entry.startsWith('coinbase /products/BTC-USD/candles?granularity=3600')), '4h built from hourly candles');
  await assertCleanText(page);
  await shot(page, 'fallback');
  const binanceCalls = api.log.filter((entry) => entry.startsWith('binance')).length;
  await page.locator('#btn-refresh').click();
  await waitFor(async () => api.log.filter((entry) => entry.startsWith('coinbase') && entry.includes('candles')).length === 2, 'refetched from Coinbase');
  assert.equal(api.log.filter((entry) => entry.startsWith('binance')).length, binanceCalls, 'Binance not asked again');
});

await test('rate limited: both providers answer 429 with Retry-After; the popup waits', async () => {
  api.scenario.binance = '429';
  api.scenario.coinbase = '429';
  api.scenario.retryAfter = '42';
  const page = await openPopup();
  await page.locator('#error-card').waitFor();
  assert.match(await page.locator('#error-card h2').innerText(), /Rate limit reached/);
  assert.match(await page.locator('#retry-countdown').innerText(), /try again in (4[0-2]|3\d) s/);
  assert.ok(await page.locator('#retry').isDisabled(), 'retry disabled during the wait');
  assert.match(await page.locator('#error-card .attempts').innerText(), /Binance\s+Rate limited \(HTTP 429\)[\s\S]*Coinbase Exchange\s+Rate limited \(HTTP 429\)/);
  assert.equal(await page.locator('#price').count(), 0, 'no price without data');
  await assertCleanText(page);
  await shot(page, 'rate-limited');
  const before = api.log.length;
  await page.locator('#btn-refresh').click();
  await page.locator('#error-card').waitFor();
  assert.equal(api.log.length, before, 'no request while Retry-After runs');
});

await test('error: exchanges down (5xx) → clear error, no price or signal', async () => {
  api.scenario.binance = '500';
  api.scenario.coinbase = '500';
  const page = await openPopup();
  await page.locator('#error-card').waitFor();
  assert.equal(await page.locator('#error-card h2').innerText(), 'Market data is unavailable');
  assert.equal(await page.locator('#price').count(), 0);
  assert.equal(await page.locator('#signal-label').count(), 0);
  assert.match(await page.locator('#last-updated').innerText(), /No live data/);
  await assertCleanText(page);
  await shot(page, 'error');
  api.scenario.binance = 'ok';
  await page.locator('#retry').click();
  await result(page).waitFor();
});

await test('network failure and malformed data are reported, never turned into a signal', async () => {
  api.scenario.binance = 'reset';
  api.scenario.coinbase = 'reset';
  const offline = await openPopup();
  await offline.locator('#error-card').waitFor();
  assert.equal(await offline.locator('#error-card h2').innerText(), 'No connection');
  await offline.close();
  await resetState();
  api.scenario.binance = 'malformed';
  api.scenario.coinbase = 'malformed';
  const broken = await openPopup();
  await broken.locator('#error-card').waitFor();
  assert.equal(await broken.locator('#error-card h2').innerText(), 'Unexpected data');
  assert.equal(await broken.locator('#signal-label').count(), 0);
  await assertCleanText(broken);
});

await test('stale: cached data is shown, clearly marked, when a refresh fails', async () => {
  const fresh = await openPopup();
  await result(fresh).waitFor();
  await fresh.close();
  // Age the cached entry by 4 minutes, then take both providers down.
  await worker.evaluate(async () => {
    const key = 'market:v1:BTC:4h';
    const entry = (await chrome.storage.session.get(key))[key];
    entry.fetchedAt -= 4 * 60 * 1000;
    await chrome.storage.session.set({ [key]: entry });
  });
  api.scenario.binance = '500';
  api.scenario.coinbase = '500';
  const page = await openPopup();
  await page.locator('#stale-notice').waitFor();
  assert.match(await page.locator('#stale-notice').innerText(), /Couldn't refresh \(server error\)\. Showing data from 4 min ago\./);
  assert.equal(await page.locator('.badge-stale').innerText(), 'STALE');
  assert.match(await page.locator('#last-updated').innerText(), /Last updated: 4 min ago · stale/);
  assert.equal(await signalOf(page), 'STRONG BULLISH');
  await assertCleanText(page);
  await shot(page, 'stale');
});

await test('invalid symbol from a selection: nothing listed, no fake data', async () => {
  await worker.evaluate(() => chrome.storage.session.set({ pendingAnalysis: { symbol: 'FOOBAR', selection: 'FOOBAR', createdAt: Date.now() } }));
  const page = await openPopup();
  await page.locator('#error-card').waitFor();
  assert.equal(await page.locator('#error-card h2').innerText(), "FOOBAR isn't available");
  assert.match(await page.locator('#origin').innerText(), /From your selection “FOOBAR”/);
  await page.locator('#choose-coin').click();
  await page.locator('#search-input').waitFor();
});

await test('not enough history: a new listing gets an explanation instead of a signal', async () => {
  await worker.evaluate(() => chrome.storage.local.set({ ui: { lastSymbol: 'FRESH', lastInterval: '4h' } }));
  const page = await openPopup();
  await page.locator('.state-card').waitFor();
  assert.match(await page.locator('.state-card').innerText(), /Not enough price history[\s\S]*Binance has 40 4h candles for FRESH; the indicators need at least 60/);
});

await test('search: debounced provider search finds other coins', async () => {
  const page = await openPopup();
  await result(page).waitFor();
  await page.locator('#asset-button').click();
  const input = page.locator('#search-input');
  await input.waitFor();
  assert.equal(await page.locator('#search-results [data-symbol]').count(), 8, 'popular coins first');
  await input.pressSequentially('li', { delay: 60 });
  await waitFor(async () => (await page.locator('#search-results [data-symbol="LINK"]').count()) === 1, 'LINK found');
  assert.equal(api.log.filter((entry) => entry.includes('/ticker/price')).length, 1, 'symbol list fetched once');
  assert.match(await page.locator('#search-note').innerText(), /USDT markets on Binance/);
  await input.fill('');
  await input.pressSequentially('l', { delay: 30 });
  await waitFor(async () => (await page.locator('#search-results [data-symbol]').count()) >= 3, 'several L coins');
  await shot(page, 'search', { fullPage: false });
  await input.fill('zzzz');
  await page.locator('#search-note', { hasText: 'No USDT market on Binance matches “zzzz”.' }).waitFor();
  await input.fill('link');
  await input.press('Enter');
  await waitFor(async () => (await page.locator('#pair').innerText()).startsWith('LINK'), 'LINK analysed');
  await result(page).waitFor();
  await waitFor(async () => (await signalOf(page).catch(() => '')) === 'STRONG BULLISH', 'LINK signal');
  await assertCleanText(page);
});

await test('page detection: exchange URL, heading, and no false positives', async () => {
  const exchange = await openSite('/pages/en/trade/SOL_USDT');
  const onExchange = await openPopup({ tab: await tabIdOf(exchange) });
  await result(onExchange).waitFor();
  assert.equal(await onExchange.locator('#pair').innerText(), 'SOL/USDT');
  assert.match(await onExchange.locator('#origin').innerText(), /Detected on 127\.0\.0\.1/);
  await shot(onExchange, 'detected', { fullPage: false });

  const news = await openSite('/pages/news/markets');
  const onNews = await openPopup({ tab: await tabIdOf(news) });
  await result(onNews).waitFor();
  assert.equal(await onNews.locator('#pair').innerText(), 'DOGE/USDT', 'found in the <h1>');

  const travel = await openSite('/pages/travel/canada');
  const onTravel = await openPopup({ tab: await tabIdOf(travel) });
  await result(onTravel).waitFor();
  assert.equal(await onTravel.locator('#pair').innerText(), 'BTC/USDT', 'Canada / Solutions / ETH Zurich / ADA ignored');
  assert.equal(await onTravel.locator('#origin').count(), 0);

  await worker.evaluate(() => chrome.storage.local.set({ settings: { detectFromPage: false } }));
  const off = await openPopup({ tab: await tabIdOf(exchange) });
  await result(off).waitFor();
  assert.equal(await off.locator('#pair').innerText(), 'BTC/USDT', 'detection can be turned off');
});

await test('context menu: "Analyze selected coin" opens the real popup on that coin', async () => {
  // An extension page to inspect the toolbar popup from, opened first (focusing a new tab closes the popup).
  const probe = await newPage();
  await probe.goto(`chrome-extension://${extensionId}/popup.html?probe`);
  const news = await openSite('/pages/news/markets');
  await news.bringToFront();
  const tabId = await tabIdOf(news);
  const menus = await worker.evaluate(() => chrome.contextMenus && typeof chrome.contextMenus.onClicked === 'object');
  assert.ok(menus);
  await worker.evaluate(
    ({ tabId, url }) =>
      globalThis.__cryptoSignalTest.onContextMenuClick(
        { menuItemId: 'cryptosignal:analyze', selectionText: '  Solana ', pageUrl: url, editable: false, frameId: 0 },
        { id: tabId },
      ),
    { tabId, url: news.url() },
  );
  await waitFor(
    () =>
      probe.evaluate(() => {
        const [popup] = chrome.extension.getViews({ type: 'popup' });
        return popup?.document.querySelector('.result[data-signal]') && popup.document.getElementById('pair')?.textContent === 'SOL/USDT';
      }),
    'popup opened with SOL',
    8000,
  );
  const origin = await probe.evaluate(() => chrome.extension.getViews({ type: 'popup' })[0].document.getElementById('origin')?.textContent.trim());
  assert.equal(origin, 'From your selection “Solana”');
  const pending = await worker.evaluate(async () => (await chrome.storage.session.get('pendingAnalysis')).pendingAnalysis);
  assert.equal(pending, undefined, 'hand-off consumed');
});

await test('context menu: a selection without a coin says so', async () => {
  await worker.evaluate(() => chrome.storage.session.set({ pendingAnalysis: { symbol: null, selection: 'quarterly earnings', createdAt: Date.now() } }));
  const page = await openPopup();
  await result(page).waitFor();
  assert.match(await page.locator('#selection-note').innerText(), /Couldn't find a coin in “quarterly earnings”\. Showing Bitcoin instead\./);
});

await test('history: analyses are saved and reopen as dated snapshots', async () => {
  const page = await openPopup();
  await result(page).waitFor();
  for (const symbol of ['ETH', 'SOL', 'DOGE']) {
    await page.locator('#asset-button').click();
    await page.locator(`#search-results [data-symbol="${symbol}"]`).click();
    await waitFor(async () => (await page.locator('#pair').innerText()).startsWith(symbol), `${symbol} selected`);
    await result(page).waitFor();
  }
  await waitFor(async () => (await worker.evaluate(async () => (await chrome.storage.local.get('history')).history?.length)) === 4, '4 saved');
  await page.locator('#btn-history').click();
  await page.locator('#history-list li').first().waitFor();
  assert.equal(await page.locator('#history-list li').count(), 4);
  assert.match(await page.locator('#history-list li').first().innerText(), /DOGE\/USDT\s*4h\s*Strong bearish · 75%/);
  await assertCleanText(page);
  await shot(page, 'history', { fullPage: false });

  await page.locator('#history-list li').nth(2).locator('.history-open').click();
  await page.locator('#snapshot-notice').waitFor();
  assert.match(await page.locator('#snapshot-notice').innerText(), /Snapshot from \w{3} \d{1,2}, \d{4}, \d{2}:\d{2}\. Saved analysis, not live data\./);
  assert.equal(await page.locator('#pair').innerText(), 'ETH/USDT');
  assert.match(await page.locator('#last-updated').innerText(), /^Snapshot · /);
  await shot(page, 'snapshot');
  const before = klineRequests().length;
  await page.locator('#analyze-now').click();
  await waitFor(async () => (await page.locator('#snapshot-notice').count()) === 0, 'live again');
  assert.equal(klineRequests().length, before, 'fresh cache reused');

  // Delete one, then clear all (two clicks).
  await page.locator('#btn-history').click();
  await page.locator('#history-list li').first().waitFor();
  await page.locator('#history-list li').first().getByRole('button', { name: /^Delete/ }).click();
  await waitFor(async () => (await page.locator('#history-list li').count()) === 3, 'one deleted');
  await page.locator('#history-clear').click();
  await page.locator('#history-clear').click();
  await page.locator('#history-empty:not([hidden])').waitFor();
  assert.equal((await worker.evaluate(async () => (await chrome.storage.local.get('history')).history)) ?? null, null);
});

await test('settings: persist, and the Free plan preview gates coins, timeframes and advanced rows', async () => {
  const page = await openPopup();
  await result(page).waitFor();
  await page.locator('#btn-settings').click();
  await page.locator('#setting-preview').waitFor();
  await assertCleanText(page);
  await shot(page, 'settings');
  await page.locator('#setting-history').selectOption('10');
  await page.locator('#save-status', { hasText: 'Saved' }).waitFor();
  await page.locator('label[for="setting-detect"]').click();
  await page.locator('label[for="setting-preview"]').click();
  await waitFor(
    async () => (await worker.evaluate(async () => (await chrome.storage.local.get('settings')).settings))?.previewFreePlan === true,
    'preview saved',
  );
  const settings = await worker.evaluate(async () => (await chrome.storage.local.get('settings')).settings);
  assert.deepEqual(settings, { detectFromPage: false, historyLimit: 10, previewFreePlan: true });

  await page.locator('#btn-back').click();
  await result(page).waitFor();
  assert.ok(await page.locator('#tf-1h').isDisabled(), '1h locked on Free');
  assert.equal(await page.locator('.indicator.locked').count(), 2, 'momentum and volume locked');
  assert.equal(await page.locator('.chart-legend').innerText().then((text) => text.includes('EMA20')), false, 'no EMA overlays');
  assert.equal(await page.locator('#reasons li').count(), 4, 'locked indicators left out of the reasons');
  assert.doesNotMatch(await page.locator('#analysis-text').innerText(), /volume/i, 'and out of the analysis');
  await shot(page, 'free-preview');
  await page.locator('#asset-button').click();
  assert.ok(await page.locator('#search-results [data-symbol="SOL"]').isDisabled(), 'SOL locked on Free');
  assert.ok(!(await page.locator('#search-results [data-symbol="ETH"]').isDisabled()), 'ETH included');

  await worker.evaluate(() => chrome.storage.local.set({ ui: { lastSymbol: 'SOL', lastInterval: '4h' } }));
  const locked = await openPopup();
  await locked.locator('#locked-card').waitFor();
  assert.match(await locked.locator('#locked-card h2').innerText(), /SOL is part of Pro/);
});

// --- Alerts & watchlist -------------------------------------------------------------------

const ALARM = 'cryptosignal:check';
const getAlarm = () => worker.evaluate((name) => chrome.alarms.get(name).then((alarm) => alarm ?? null), ALARM);
const notifications = () => worker.evaluate(() => chrome.notifications.getAll());
const fireAlarm = () => worker.evaluate((name) => globalThis.__cryptoSignalTest.fireAlarm(name), ALARM);
const stored = (key) => worker.evaluate(async (key) => (await chrome.storage.local.get(key))[key], key);
/** Simulates the time between two scheduled checks: the 60 s market cache is no longer fresh. */
const ageMarketCache = (key = 'market:v1:BTC:4h', ms = 16 * 60 * 1000) =>
  worker.evaluate(
    async ({ key, ms }) => {
      const entry = (await chrome.storage.session.get(key))[key];
      if (entry) {
        entry.fetchedAt -= ms;
        await chrome.storage.session.set({ [key]: entry });
      }
    },
    { key, ms },
  );
async function clearNotifications() {
  await worker.evaluate(async () => {
    for (const id of Object.keys(await chrome.notifications.getAll())) await chrome.notifications.clear(id);
  });
}

await test('alerts: created from the popup, paused and deleted; the alarm exists only while needed', async () => {
  await clearNotifications();
  const page = await openPopup();
  await result(page).waitFor();
  assert.equal(await getAlarm(), null, 'no alarm without alerts');
  await page.locator('#btn-alerts').click();
  await page.locator('#alert-form').waitFor();
  assert.match(await page.locator('.alert-form-market').innerText(), /BTC\/USDT\s*4h/);
  assert.equal(await page.locator('#alert-count').innerText(), '0/10');

  // Default condition: the signal turns bearish.
  assert.equal(await page.locator('#alert-choice').inputValue(), 'turns-bearish');
  assert.ok(await page.locator('#alert-level').isHidden(), 'no level for signal conditions');
  await page.locator('#alert-create').click();
  await page.locator('#alert-list li').first().waitFor();
  assert.match(await page.locator('#alert-list li').first().innerText(), /BTC\s*4h\s*Signal turns bearish[\s\S]*Active/);

  // RSI crosses above 70 (default level), price crosses below a typed price.
  await page.locator('#alert-choice').selectOption('rsi-above');
  assert.equal(await page.locator('#alert-level').inputValue(), '70');
  await page.locator('#alert-create').click();
  await page.locator('#alert-choice').selectOption('price-below');
  assert.equal(await page.locator('#alert-level').inputValue(), '61000', '5% below the current price, rounded');
  await page.locator('#alert-level').fill('0');
  await page.locator('#alert-create').click();
  await page.locator('#alert-status.is-error', { hasText: 'Enter a price above 0.' }).waitFor();
  await page.locator('#alert-level').fill('60000');
  await page.locator('#alert-create').click();
  await page.locator('#alert-choice').selectOption('signal-changed');
  await page.locator('#alert-create').click();
  await waitFor(async () => (await page.locator('#alert-list li').count()) === 4, '4 alerts');
  await page.locator('#alert-create').click();
  await page.locator('#alert-status', { hasText: 'You already have this alert.' }).waitFor();
  assert.equal(await page.locator('#alert-count').innerText(), '4/10');
  assert.deepEqual(
    (await page.locator('#alert-list .alert-text').allInnerTexts()).map((text) => text.trim()),
    ['Signal turns bearish', 'RSI crosses above 70', 'Price crosses below 60,000.00', 'Signal changes'],
  );
  const rules = await stored('alerts');
  assert.deepEqual(rules[2].condition, { type: 'price-crosses', price: 60000, direction: 'below' });

  // Watch the current market: its last signal comes from the analysis just shown.
  await page.locator('#watch-add').click();
  await page.locator('#watch-list li').first().waitFor();
  assert.match(await page.locator('#watch-list li').first().innerText(), /BTC\/USDT\s*4h\s*Strong bullish · 75%[\s\S]*64,231\.50/);
  assert.match(await page.locator('#watch-add').innerText(), /Watching BTC 4h/);
  assert.ok(await page.locator('#watch-add').isDisabled());

  // Scheduling follows storage: every 15 minutes, first run soon.
  await waitFor(async () => (await getAlarm()) !== null, 'alarm scheduled');
  assert.equal((await getAlarm()).periodInMinutes, 15);

  // "Check now" runs the background check (baseline: nothing fires yet).
  await page.locator('#check-now').click();
  await page.locator('#watch-status', { hasText: /Checked 1 market\./ }).waitFor();
  assert.match(await page.locator('#run-note').innerText(), /Last check: (just now|\d+ sec ago)\. Alerts describe indicator events\. They are not trading advice\./);
  assert.deepEqual(await notifications(), {});

  // Pause the last one: kept, marked, and skipped by the checks.
  const last = page.locator('#alert-list li').nth(3);
  await last.locator('.alert-toggle').click();
  await waitFor(async () => (await last.getAttribute('class')).includes('is-paused'), 'paused');
  assert.match(await last.innerText(), /Paused/);
  await waitFor(async () => (await stored('alerts'))[3].enabled === false, 'pause saved');
  await assertCleanText(page);
  await shot(page, 'alerts');

  // Delete everything: the alarm goes away.
  for (let i = 4; i > 0; i--) {
    await page.locator('#alert-list li').first().getByRole('button', { name: /^Delete/ }).click();
    await waitFor(async () => (await page.locator('#alert-list li').count()) === i - 1, `${i - 1} left`);
  }
  assert.equal(await getAlarm() !== null, true, 'the watchlist still needs checks');
  await page.locator('#watch-list li').first().getByRole('button', { name: /^Remove/ }).click();
  await page.locator('#watch-empty:not([hidden])').waitFor();
  await waitFor(async () => (await getAlarm()) === null, 'alarm cleared');
});

await test('alerts: an alarm run notifies on indicator events, once, and a click opens that analysis', async () => {
  await clearNotifications();
  const createdAt = Date.now() - 1000;
  const rule = (id, condition, enabled = true) => ({ id, symbol: 'BTC', interval: '4h', condition, enabled, createdAt });
  await worker.evaluate(
    (alerts) => chrome.storage.local.set({ alerts, watchlist: [{ symbol: 'BTC', interval: '4h', addedAt: Date.now() }] }),
    [
      rule('r1', { type: 'signal-becomes', signals: ['BEARISH', 'STRONG_BEARISH'] }),
      rule('r2', { type: 'rsi-crosses', level: 40, direction: 'below' }),
      rule('r3', { type: 'price-crosses', price: 60000, direction: 'below' }),
      rule('r4', { type: 'rsi-crosses', level: 70, direction: 'above' }),
      rule('r5', { type: 'signal-changed' }, false),
    ],
  );
  // Capture what is shown (chrome.notifications has no API to read a notification back).
  await worker.evaluate(() => {
    globalThis.__shown = [];
    const original = globalThis.__originalCreate ?? chrome.notifications.create.bind(chrome.notifications);
    globalThis.__originalCreate = original;
    chrome.notifications.create = (id, options) => {
      globalThis.__shown.push({ id, ...options });
      return original(id, options);
    };
  });

  // First run: records the baseline, nothing fires.
  let summary = await fireAlarm();
  assert.deepEqual(summary, { status: 'done', checked: 1, notified: 0, problem: null });
  assert.equal(klineRequests().length, 1);
  // Right away again: the 60 s cache answers, no request, nothing new.
  summary = await fireAlarm();
  assert.equal(summary.notified, 0);
  assert.equal(klineRequests().length, 1, 'cache respected');

  // 16 minutes later BTC's indicators turned: bearish, RSI 32.8, price 3,120.55 (fixture swap).
  api.scenario.swap = { BTCUSDT: 'ETHUSDT' };
  await ageMarketCache();
  summary = await fireAlarm();
  assert.equal(summary.notified, 3);
  const ids = Object.keys(await notifications()).sort();
  assert.equal(ids.length, 3);
  assert.deepEqual(ids.map((id) => id.split('|').slice(0, 4).join('|')), ['cs-alert|BTC|4h|r1', 'cs-alert|BTC|4h|r2', 'cs-alert|BTC|4h|r3']);
  const shown = await worker.evaluate(() => globalThis.__shown);
  assert.deepEqual(
    shown.map((item) => item.title).sort(),
    ['BTC/USDT 4h · Price crosses below 60,000.00', 'BTC/USDT 4h · RSI crosses below 40', 'BTC/USDT 4h · Signal turns bearish'],
  );
  assert.deepEqual(
    shown.map((item) => item.message).sort(),
    ['BTC (4h) RSI crossed below 40 (now 32.8).', 'BTC (4h) price crossed below 60,000.00 (now 3,120.55).', 'BTC (4h) signal is now Bearish.'],
  );
  for (const item of shown) {
    assert.equal(item.contextMessage, 'Technical indicator event · not financial advice');
    assert.doesNotMatch(`${item.title} ${item.message}`, /\b(buy|sell|profit|guarantee)/i, 'indicator events only');
    assert.match(item.iconUrl, /^chrome-extension:\/\/.+\/icons\/icon128\.png$/);
  }
  const monitor = await stored('monitor');
  assert.deepEqual(Object.keys(monitor.triggers).sort(), ['r1', 'r2', 'r3']);
  assert.equal((await stored('marketSnapshots'))['BTC:4h'].signal, 'BEARISH', 'watchlist sees the new signal');

  // Edge-triggered: the conditions stay true, nothing fires again.
  await ageMarketCache();
  summary = await fireAlarm();
  assert.equal(summary.notified, 0);
  assert.equal(Object.keys(await notifications()).length, 3);

  // Clicking a notification opens the popup on that market and clears the notification.
  const probe = await newPage();
  await probe.goto(`chrome-extension://${extensionId}/popup.html?probe`);
  const site = await openSite('/pages/travel/canada');
  await site.bringToFront();
  const clicked = ids[0];
  await worker.evaluate((id) => globalThis.__cryptoSignalTest.onNotificationClicked(id), clicked);
  await waitFor(
    () =>
      probe.evaluate(() => {
        const [popup] = chrome.extension.getViews({ type: 'popup' });
        return Boolean(popup?.document.querySelector('.result[data-signal="BEARISH"]') && popup.document.getElementById('pair')?.textContent === 'BTC/USDT');
      }),
    'popup opened on BTC 4h',
    8000,
  );
  const origin = await probe.evaluate(() => chrome.extension.getViews({ type: 'popup' })[0].document.getElementById('origin')?.textContent.trim());
  assert.equal(origin, 'From your alert: BTC (4h) signal is now Bearish.');
  await waitFor(async () => !(clicked in (await notifications())), 'notification cleared');

  // The watchlist shows the last signal the background saw.
  await probe.evaluate(() => chrome.extension.getViews({ type: 'popup' })[0]?.close());
  const page = await openPopup();
  await result(page).waitFor();
  await page.locator('#btn-alerts').click();
  await page.locator('#watch-list li').first().waitFor();
  assert.match(await page.locator('#watch-list li').first().innerText(), /BTC\/USDT\s*4h\s*Bearish · 50%[\s\S]*3,120\.55/);
  assert.match(await page.locator('#alert-list li[data-id="r1"]').innerText(), /Active · last triggered/);
  assert.match(await page.locator('#alert-list li[data-id="r5"]').innerText(), /Paused/);
  await worker.evaluate(() => {
    chrome.notifications.create = globalThis.__originalCreate;
  });
});

await test('alerts: background checks respect rate limits and never compare stale data', async () => {
  await clearNotifications();
  await worker.evaluate(() =>
    chrome.storage.local.set({
      alerts: [{ id: 'r1', symbol: 'BTC', interval: '4h', condition: { type: 'signal-changed' }, enabled: true, createdAt: Date.now() - 1000 }],
    }),
  );
  let summary = await fireAlarm();
  assert.equal(summary.checked, 1);
  // Both providers now rate limit; the cached data ages past the cache window.
  api.scenario.binance = '429';
  api.scenario.coinbase = '429';
  api.scenario.retryAfter = '120';
  api.scenario.swap = { BTCUSDT: 'ETHUSDT' };
  await ageMarketCache();
  summary = await fireAlarm();
  assert.equal(summary.checked, 0);
  assert.equal(summary.notified, 0, 'stale cache is never compared');
  assert.match(summary.problem, /BTC 4h: rate limited/);
  const before = api.log.length;
  api.scenario.binance = 'ok';
  api.scenario.coinbase = 'ok';
  summary = await fireAlarm();
  assert.equal(api.log.length, before, 'no request while Retry-After runs');
  assert.equal(summary.notified, 0);
  assert.match((await stored('monitor')).lastProblem, /rate limited/);
});

await test('Free plan preview: alerts are kept but paused, no alarm, About Pro card', async () => {
  await worker.evaluate(() =>
    chrome.storage.local.set({
      alerts: [{ id: 'r1', symbol: 'BTC', interval: '4h', condition: { type: 'rsi-crosses', level: 70, direction: 'above' }, enabled: true, createdAt: Date.now() }],
    }),
  );
  await waitFor(async () => (await getAlarm()) !== null, 'alarm scheduled');
  await worker.evaluate(() => chrome.storage.local.set({ settings: { previewFreePlan: true } }));
  await waitFor(async () => (await getAlarm()) === null, 'alarm cleared on Free');
  assert.deepEqual(await fireAlarm(), { status: 'skipped', reason: 'plan', checked: 0, notified: 0, problem: null });
  assert.equal(klineRequests().length, 0);

  const page = await openPopup();
  await result(page).waitFor();
  await page.locator('#btn-alerts').click();
  await page.locator('#alerts-locked').waitFor();
  assert.match(await page.locator('#alerts-locked').innerText(), /Background alerts and the watchlist are part of Pro\. Yours are kept and paused/);
  assert.match(await page.locator('#alert-list li').first().innerText(), /RSI crosses above 70[\s\S]*Paused on the Free plan/);
  assert.ok(await page.locator('#alert-create').isDisabled());
  assert.ok(await page.locator('#watch-add').isDisabled());
  assert.equal((await stored('alerts')).length, 1, 'nothing deleted');

  await page.locator('#alerts-about-pro').click();
  await page.locator('#about-pro').waitFor();
  assert.match(await page.locator('#about-pro').innerText(), /CryptoSignal Pro\s*\$2\.99 one-time[\s\S]*Background alerts[\s\S]*Watchlist/);
  assert.ok(await page.locator('#get-pro').isDisabled(), 'Get Pro disabled during early access');
  assert.equal(await page.locator('#pro-note').innerText(), 'Free during early access');
  await assertCleanText(page);
  // Opening About Pro scrolls the card to the top, just under the sticky header.
  await waitFor(async () => (await page.evaluate(() => Math.round(document.getElementById('about-pro').getBoundingClientRect().top))) === 60, 'card scrolled into view');
  await shot(page, 'about-pro', { fullPage: false });
});

await test('requests only go to the (fixture) market-data API', async () => {
  requests.length = 0;
  const page = await openPopup();
  await result(page).waitFor();
  await page.locator('#btn-refresh').click();
  await result(page).waitFor();
  const external = requests.filter((url) => !url.startsWith('chrome-extension://') && !url.startsWith('data:'));
  assert.ok(external.length > 0);
  assert.deepEqual(
    external.filter((url) => !url.startsWith(`${api.origin}/binance/`) && !url.startsWith(`${api.origin}/coinbase/`)),
    [],
  );
});

// --- Summary ----------------------------------------------------------------------------

await context.close();
await api.close();
await rm(userDataDir, { recursive: true, force: true });

const CURATED = ['loading', 'bullish', 'bullish-popup', 'bearish', 'neutral', 'error', 'rate-limited', 'stale', 'fallback', 'search', 'detected', 'history', 'snapshot', 'settings', 'free-preview', 'alerts', 'about-pro'];
if (process.env.UPDATE_SCREENSHOTS === '1') {
  await mkdir(screenshotsDir, { recursive: true });
  for (const name of CURATED.filter((name) => shots.includes(name))) await copyFile(join(outputDir, `${name}.png`), join(screenshotsDir, `${name}.png`));
  console.log(`\nCopied ${CURATED.filter((name) => shots.includes(name)).length} screenshots to ${screenshotsDir}`);
}

const failed = results.filter((entry) => !entry.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed. Screenshots: ${outputDir}`);
process.exit(failed.length ? 1 : 0);
