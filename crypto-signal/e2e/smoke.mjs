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
  assert.deepEqual([...manifest.permissions].sort(), ['activeTab', 'contextMenus', 'scripting', 'storage']);
  assert.deepEqual(manifest.host_permissions, ['https://api.binance.com/*', 'https://api.exchange.coinbase.com/*']);
  assert.equal(manifest.content_scripts, undefined);
  assert.deepEqual(manifest.background, { service_worker: 'background.js', type: 'module' });
  const files = await readdir(join(root, 'dist'), { recursive: true });
  assert.ok(!files.some((file) => file.endsWith('.map')), 'no source maps');
  for (const file of files.filter((file) => file.endsWith('.js') || file.endsWith('.html') || file.endsWith('.css'))) {
    const text = await readFile(join(root, 'dist', file), 'utf8');
    assert.ok(!text.includes('__cryptoSignalTest'), `${file}: test hook compiled out`);
    assert.ok(!text.includes('127.0.0.1'), `${file}: no fixture origin`);
    assert.ok(!text.includes('sourceMappingURL'), `${file}: no source map reference`);
  }
  const popup = await readFile(join(root, 'dist/popup.js'), 'utf8');
  assert.ok(popup.includes('https://api.binance.com') && popup.includes('https://api.exchange.coinbase.com'));
  const e2ePopup = await readFile(join(root, 'dist-e2e/popup.js'), 'utf8');
  assert.ok(e2ePopup.includes(`http://127.0.0.1:${API_PORT}`), 'e2e build talks to the fixture server');
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

const CURATED = ['loading', 'bullish', 'bullish-popup', 'bearish', 'neutral', 'error', 'rate-limited', 'stale', 'fallback', 'search', 'detected', 'history', 'snapshot', 'settings', 'free-preview'];
if (process.env.UPDATE_SCREENSHOTS === '1') {
  await mkdir(screenshotsDir, { recursive: true });
  for (const name of CURATED.filter((name) => shots.includes(name))) await copyFile(join(outputDir, `${name}.png`), join(screenshotsDir, `${name}.png`));
  console.log(`\nCopied ${CURATED.filter((name) => shots.includes(name)).length} screenshots to ${screenshotsDir}`);
}

const failed = results.filter((entry) => !entry.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed. Screenshots: ${outputDir}`);
process.exit(failed.length ? 1 : 0);
