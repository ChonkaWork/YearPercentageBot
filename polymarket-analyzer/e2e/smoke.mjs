// End-to-end test: loads the e2e build (dist-e2e/) into a real Chromium and drives every popup
// state against a local server that answers in the Gamma / CLOB API formats with the fixtures
// in fixtures/. polymarket.com pages are routed to tiny local fixture pages by Playwright, so
// the extension sees real polymarket.com URLs. Nothing goes to the internet.
//
//   npm run test:e2e                       (set CHROMIUM_PATH if Chromium isn't auto-detected)
//   UPDATE_SCREENSHOTS=1 npm run test:e2e  (also refreshes the curated screenshots/ folder)
//
// Native context menus, alarms and notification clicks can't be triggered from automation, so
// the test calls the handlers Chrome would call (exposed only in the e2e build). The free plan is
// exercised by switching early access off through an e2e-only storage key. The popup is opened as a page with ?tab=<id>
// (also e2e-only) so it can be sized, inspected and screenshotted.

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const extensionPath = join(root, 'dist-e2e');
const outputDir = join(root, 'e2e/output');
const screenshotsDir = join(root, 'screenshots');
const headless = process.env.HEADED !== '1';
const FIXTURE_NOW = 1_790_000_000;
const e2eConfig = JSON.parse(await readFile(join(extensionPath, 'e2e.json'), 'utf8'));

function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const candidates = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  const found = candidates.find((path) => existsSync(path));
  if (!found) throw new Error('Chromium not found. Set CHROMIUM_PATH.');
  return found;
}

// --- Fixture API server -------------------------------------------------------------------

const events = new Map();
const tokenToSlug = new Map();
for (const name of await readdir(join(root, 'fixtures/gamma/events'))) {
  const payload = JSON.parse(await readFile(join(root, 'fixtures/gamma/events', name), 'utf8'));
  const event = payload[0];
  events.set(event.slug, payload);
  for (const market of event.markets ?? []) {
    try {
      const [yes] = JSON.parse(market.clobTokenIds);
      if (yes) tokenToSlug.set(yes, market.slug);
    } catch {
      // The malformed fixture has no usable token ids.
    }
  }
}

const api = {
  requests: [],
  /** slug -> HTTP status to answer with (or 'drop' to cut the connection). */
  failures: new Map(),
  /** slug -> delay in ms. */
  delays: new Map(),
  /** market slug -> yes price override. */
  prices: new Map(),
  reset() {
    this.failures.clear();
    this.delays.clear();
    this.prices.clear();
  },
};

const BUILT_IN_FAILURES = { 'rate-limited-market': 429, 'server-error-market': 503, 'network-error-market': 'drop' };
const INTERVAL_TO_RANGE = { '1d': '24h', '1w': '7d', '1m': '30d' };

function json(response, status, body, headers = {}) {
  response.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*', ...headers }).end(JSON.stringify(body));
}

function withPrices(payload) {
  if (!api.prices.size) return payload;
  const copy = structuredClone(payload);
  for (const market of copy[0].markets ?? copy) {
    const yes = api.prices.get(market.slug);
    if (yes !== undefined) market.outcomePrices = JSON.stringify([String(yes), String(Math.round((1 - yes) * 1000) / 1000)]);
  }
  return copy;
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  api.requests.push(`${url.pathname}${url.search}`);
  const slug = url.searchParams.get('slug') ?? '';
  const failure = api.failures.get(slug) ?? BUILT_IN_FAILURES[slug];
  const delay = api.delays.get(slug) ?? 0;
  if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
  if (failure === 'drop') return request.socket.destroy();
  if (failure === 429) return json(response, 429, { error: 'Too Many Requests' }, { 'retry-after': '30' });
  if (failure) return json(response, failure, { error: 'Service Unavailable' });

  switch (url.pathname) {
    case '/gamma/events':
      return json(response, 200, events.has(slug) ? withPrices(events.get(slug)) : []);
    case '/gamma/markets': {
      const file = join(root, 'fixtures/gamma/markets', `${slug}.json`);
      return json(response, 200, existsSync(file) ? withPrices(JSON.parse(await readFile(file, 'utf8'))) : []);
    }
    case '/gamma/public-search': {
      const q = (url.searchParams.get('q') ?? '').toLowerCase();
      if (q === 'server error') return json(response, 500, { error: 'boom' });
      // Every word must appear in the event title or one of its market questions.
      const words = q.split(/\s+/).filter(Boolean);
      const matches = [...events.values()]
        .map((payload) => payload[0])
        .filter((event) => {
          const haystack = [event.title, ...event.markets.map((market) => market.question ?? '')].join(' ').toLowerCase();
          return event.slug !== 'malformed-market' && words.every((word) => haystack.includes(word));
        });
      return json(response, 200, { events: matches, tags: [], profiles: [], pagination: { hasMore: false, totalResults: matches.length } });
    }
    case '/clob/prices-history': {
      const marketSlug = tokenToSlug.get(url.searchParams.get('market') ?? '');
      const range = INTERVAL_TO_RANGE[url.searchParams.get('interval') ?? ''];
      if (api.failures.get(`history:${marketSlug}`)) return json(response, api.failures.get(`history:${marketSlug}`), { error: 'nope' });
      const file = marketSlug && range ? join(root, 'fixtures/clob', `${marketSlug}.${range}.json`) : null;
      if (!file || !existsSync(file)) return json(response, 200, { history: [] });
      const { history } = JSON.parse(await readFile(file, 'utf8'));
      // Fixture histories end at FIXTURE_NOW; move them to end now.
      const offset = Math.floor(Date.now() / 1000) - FIXTURE_NOW;
      return json(response, 200, { history: history.map((point) => ({ t: point.t + offset, p: point.p })) });
    }
    default:
      return json(response, 404, { error: 'not found' });
  }
});
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(e2eConfig.port, '127.0.0.1', resolve);
});
const pageServer = createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<!doctype html><title>Some other site</title><p id="text">Will Bitcoin close 2026 above $150,000?</p>');
});
await new Promise((resolve) => pageServer.listen(0, '127.0.0.1', resolve));
const otherSite = `http://127.0.0.1:${pageServer.address().port}/article.html`;

// --- Browser ------------------------------------------------------------------------------

await mkdir(outputDir, { recursive: true });
const userDataDir = await mkdtemp(join(tmpdir(), 'pm-ai-e2e-'));
const context = await chromium.launchPersistentContext(userDataDir, {
  executablePath: findChromium(),
  headless,
  viewport: { width: 1280, height: 800 },
  args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
});

/** polymarket.com pages: minimal local fixtures (a title and, for some, a canonical link). */
await context.route(/^https:\/\/(www\.)?polymarket\.com\//, (route) => {
  const url = new URL(route.request().url());
  const canonical = url.pathname.startsWith('/sports/') ? '<link rel="canonical" href="https://polymarket.com/event/hottest-year-on-record-2026">' : '';
  return route.fulfill({
    status: 200,
    contentType: 'text/html; charset=utf-8',
    body: `<!doctype html><html><head><title>Fixture ${url.pathname}</title>${canonical}</head><body><h1>Fixture page</h1><p id="text">Atlantic named storms</p></body></html>`,
  });
});

const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
const extensionId = new URL(worker.url()).host;
// The worker can be reported before its extension APIs are bound.
for (let attempt = 0; attempt < 100 && !(await worker.evaluate(() => Boolean(globalThis.chrome?.storage?.local)).catch(() => false)); attempt++) {
  await new Promise((resolve) => setTimeout(resolve, 50));
}
const openPages = new Set();

async function newPage() {
  const page = await context.newPage();
  openPages.add(page);
  return page;
}

async function tabIdOf(url) {
  return worker.evaluate(async (url) => {
    const tabs = (await chrome.tabs.query({})).filter((tab) => tab.url === url);
    return tabs.sort((a, b) => b.id - a.id)[0]?.id ?? null;
  }, url);
}

/** Opens `url` in a tab, then the popup "over" it (popup.html?tab=<id>), sized like the real popup. */
async function popupFor(url) {
  const site = await newPage();
  await site.goto(url);
  const tabId = await tabIdOf(site.url());
  assert.ok(tabId, `tab for ${url}`);
  const popup = await newPage();
  await popup.setViewportSize({ width: 400, height: 600 });
  await popup.goto(`chrome-extension://${extensionId}/popup.html?tab=${tabId}`);
  return popup;
}

async function analysisFor(path) {
  const popup = await popupFor(`https://polymarket.com${path}`);
  await popup.locator('[data-view="analysis"]').waitFor();
  await popup.evaluate(() => document.fonts.ready);
  return popup;
}

async function shot(page, name, { full = false } = {}) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: join(outputDir, `${name}.png`) });
  if (full) {
    // Same page, unclipped: the popup body is fixed at 600px and scrolls inside.
    const style = await page.addStyleTag({ content: 'html,body{height:auto!important;overflow:visible!important}.app-main{overflow:visible!important}' });
    await page.screenshot({ path: join(outputDir, `${name}-full.png`), fullPage: true });
    await style.evaluate((element) => element.remove());
  }
}

async function text(page) {
  return page.locator('body').innerText();
}

/** Words and values that must never appear: broken numbers and claims the product must not make. */
function assertHonest(content) {
  assert.ok(!/\bNaN\b|undefined|Infinity|\[object /.test(content), 'no broken values');
  assert.ok(!/\bwinner\b|guarantee|arbitrage|mispric|insider|sure bet|best bet|will win/i.test(content), 'no forbidden claims');
}

async function value(page, name) {
  return (await page.locator(`[data-value="${name}"]`).first().innerText()).trim();
}

async function waitFor(check, message, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out: ${message}`);
}

async function storage(area, key) {
  return worker.evaluate(({ area, key }) => chrome.storage[area].get(key).then((data) => data[key]), { area, key });
}

async function resetStorage() {
  await worker.evaluate(async () => {
    await chrome.storage.local.clear();
    await chrome.storage.session.clear();
    await chrome.alarms.clearAll();
    for (const id of Object.keys(await chrome.notifications.getAll())) await chrome.notifications.clear(id);
  });
}

/** Switches early access off (free plan) or back on. e2e build only. */
async function setEarlyAccess(on) {
  await worker.evaluate((on) => (on ? chrome.storage.local.remove('e2e:earlyAccess') : chrome.storage.local.set({ 'e2e:earlyAccess': false })), on);
}

async function alarm() {
  return worker.evaluate(() => chrome.alarms.get('pm-ai:alerts'));
}

/** Fires the alert alarm the way Chrome would and returns the run result. */
async function fireAlertAlarm() {
  return worker.evaluate(() => globalThis.__pmTest.onAlarm({ name: 'pm-ai:alerts', scheduledTime: Date.now() }));
}

/** "`minutes` later": ages the watchlist checks and the 60 s API cache. */
async function ageWatchlist(minutes) {
  await worker.evaluate(async (minutes) => {
    const { watchlist } = await chrome.storage.local.get('watchlist');
    for (const item of watchlist) if (item.last) item.last.at -= minutes * 60_000;
    await chrome.storage.local.set({ watchlist });
    const cache = await chrome.storage.session.get(null);
    const aged = {};
    for (const [key, entry] of Object.entries(cache)) if (key.startsWith('cache:')) aged[key] = { ...entry, storedAt: entry.storedAt - minutes * 60_000 };
    await chrome.storage.session.set(aged);
  }, minutes);
}

/** Records chrome.notifications.create calls in the worker (the options aren't readable afterwards). */
async function recordNotifications() {
  await worker.evaluate(() => {
    globalThis.__created = [];
    if (globalThis.__createPatched) return;
    globalThis.__createPatched = true;
    const original = chrome.notifications.create.bind(chrome.notifications);
    chrome.notifications.create = (id, options) => {
      globalThis.__created.push({ id, options });
      return original(id, options);
    };
  });
}

// --- Tests --------------------------------------------------------------------------------

const results = [];
async function test(name, fn) {
  const started = Date.now();
  api.reset();
  try {
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

console.log(`Chromium ${context.browser()?.version() ?? ''} · extension ${extensionId} · API ${e2eConfig.gammaBase}\n`);

await test('production build: exact permissions, API-only hosts, no test code, no source maps', async () => {
  const manifest = JSON.parse(await readFile(join(root, 'dist/manifest.json'), 'utf8'));
  assert.deepEqual([...manifest.permissions].sort(), ['activeTab', 'alarms', 'contextMenus', 'notifications', 'scripting', 'storage']);
  assert.deepEqual(manifest.options_ui, { page: 'options.html', open_in_tab: true });
  assert.deepEqual(manifest.host_permissions, ['https://gamma-api.polymarket.com/*', 'https://clob.polymarket.com/*']);
  assert.equal(manifest.content_scripts, undefined);
  assert.equal(manifest.background.type, 'module');
  const files = await readdir(join(root, 'dist'), { recursive: true });
  assert.ok(!files.some((file) => file.endsWith('.map')), 'no source maps');
  assert.ok(!files.includes('e2e.json'));
  for (const file of files.filter((name) => name.endsWith('.js') || name.endsWith('.html'))) {
    const source = await readFile(join(root, 'dist', file), 'utf8');
    assert.ok(!source.includes('__pmTest') && !source.includes('127.0.0.1') && !source.includes('location.search') && !source.includes('e2e:'), `${file} has no e2e code`);
    assert.ok(!source.includes('sourceMappingURL'), `${file} has no source map`);
  }
});

await test('binary market, positive momentum: probability, signal, data rows, chart, explanation', async () => {
  await resetStorage();
  const popup = await analysisFor('/event/ev-sales-20m-2026');
  assert.equal(await popup.locator('h1.market-title').innerText(), 'Will global EV sales exceed 20 million in 2026?');
  assert.equal(await value(popup, 'probability'), '62.4%');
  assert.equal(await value(popup, 'signal'), 'POSITIVE MOMENTUM');
  assert.equal(await value(popup, 'strength'), '60/100');
  const data = await popup.locator('[data-section="data"]').innerText();
  assert.match(data, /24h change\s+\+3\.1 pp/);
  assert.match(data, /7d change\s+\+5\.4 pp/);
  assert.match(data, /Volume 24h\s+1\.2× avg\s+\$245K\s+NORMAL/);
  assert.match(data, /Liquidity\s+\$1\.18M\s+HIGH/);
  assert.match(await popup.locator('[data-section="signal"]').innerText(), /not the probability that the event happens/);
  assert.equal(await popup.locator('[data-section="chart"]').getAttribute('data-chart-state'), 'ready');
  assert.ok((await popup.locator('.chart path.line').getAttribute('d')).split('L').length > 100, 'chart has the 7-day series');
  assert.match(await popup.locator('[data-section="why"]').innerText(), /Up 3\.1 pp in the last 24 hours/);
  const explanation = await popup.locator('.analysis-text').innerText();
  assert.match(explanation, /prices “Yes” at 62\.4%, up 3\.1 points over the last 24 hours/);
  const sentences = explanation.split(/(?<=\.)\s+(?=[A-Z])/);
  assert.ok(sentences.length >= 2 && sentences.length <= 4, `2-4 sentences, got ${sentences.length}`);
  assert.equal(await popup.locator('[data-status="fresh"]').count(), 1);
  assert.equal(await popup.locator('[data-section="unusual"]').count(), 0);
  assertHonest(await text(popup));
  await shot(popup, 'binary-positive', { full: true });
});

await test('neutral momentum', async () => {
  const popup = await analysisFor('/event/hottest-year-on-record-2026');
  assert.equal(await value(popup, 'signal'), 'NEUTRAL');
  assert.equal(await value(popup, 'strength'), '0/100');
  assert.match(await popup.locator('.analysis-text').innerText(), /shows no clear direction/);
  assertHonest(await text(popup));
  await shot(popup, 'neutral', { full: true });
});

await test('strong negative momentum with heavy volume', async () => {
  const popup = await analysisFor('/event/bitcoin-above-150k-end-of-2026');
  assert.equal(await value(popup, 'signal'), 'STRONG NEGATIVE MOMENTUM');
  assert.match(await popup.locator('[data-section="data"]').innerText(), /24h change\s+−7\.5 pp/);
  assert.match(await popup.locator('[data-section="unusual"]').innerText(), /Price move on heavy volume: −7\.5 pp in 24h on 2\.5× the average daily volume/);
  assertHonest(await text(popup));
  await shot(popup, 'negative', { full: true });
});

await test('low liquidity: warning, badge and weaker signal', async () => {
  const popup = await analysisFor('/event/new-element-confirmed-2026');
  assert.equal(await value(popup, 'signal'), 'NEGATIVE MOMENTUM');
  assert.equal(await value(popup, 'strength'), '20/100');
  assert.match(await popup.locator('[data-warning="low-liquidity"]').innerText(), /Low liquidity\. Price may be more sensitive to individual trades\./);
  assert.match(await popup.locator('[data-section="data"]').innerText(), /Liquidity\s+\$3\.12K\s+LOW/);
  assertHonest(await text(popup));
  await shot(popup, 'low-liquidity', { full: true });
});

await test('unusual activity: move + volume spike, reversal, sudden hourly move (numbers only)', async () => {
  const popup = await analysisFor('/event/us-q3-2026-gdp-growth');
  const unusual = await popup.locator('[data-section="unusual"]').innerText();
  assert.match(unusual, /Price move on heavy volume: \+12\.4 pp in 24h on 4\.0× the average daily volume/);
  assert.match(unusual, /Sudden reversal: \+12\.4 pp in 24h after −3\.4 pp over the previous 6 days/);
  assert.match(unusual, /Sudden move: The price moved \+8\.\d pp within a single hour/);
  assert.match(unusual, /causes are not known/);
  assert.equal(await value(popup, 'signal'), 'STRONG POSITIVE MOMENTUM');
  assert.ok((await popup.locator('.chart .marker').count()) >= 1, 'significant move marked on the chart');
  assertHonest(await text(popup));
  await shot(popup, 'unusual-activity', { full: true });
});

await test('multi-outcome event: sorted table, market leader, clicking an outcome analyzes it', async () => {
  const popup = await analysisFor('/event/atlantic-named-storms-2026');
  assert.equal(await popup.locator('[data-view="analysis"]').getAttribute('data-kind'), 'multi');
  const labels = await popup.locator('[data-section="outcomes"] tbody .outcome-name').allInnerTexts();
  assert.deepEqual(labels, ['17–19', '14–16', '20–22', '23 or more', '11–13']);
  assert.equal(await value(popup, 'leader'), '17–19');
  const outcomes = await popup.locator('[data-section="outcomes"]').innerText();
  assert.match(outcomes, /Sum 98\.5%/);
  assert.match(outcomes, /1 closed or unpriced market not shown/);
  assert.match(await popup.locator('[data-section="leader"]').innerText(), /Current market leader[\s\S]*Highest-priced outcome/i);
  assert.equal(await value(popup, 'signal'), 'STRONG POSITIVE MOMENTUM');
  assertHonest(await text(popup));
  await shot(popup, 'multi-outcome', { full: true });

  await popup.locator('[data-outcome="atlantic-named-storms-2026-14-16"]').click();
  await popup.locator('[data-outcome="atlantic-named-storms-2026-14-16"].is-selected').waitFor();
  assert.equal(await value(popup, 'signal'), 'NEGATIVE MOMENTUM');
  assert.match(await popup.locator('.analysis-text').innerText(), /“14–16” is priced at 23\.5%, number 2 of 5 outcomes \(the current market leader, “17–19”, is at 41\.0%\)/);

  // Keyboard: the outcome name is a button.
  await popup.locator('[data-outcome="atlantic-named-storms-2026-20-22"] button').focus();
  await popup.keyboard.press('Enter');
  await popup.locator('[data-outcome="atlantic-named-storms-2026-20-22"].is-selected').waitFor();
  assert.match(await popup.locator('[data-section="signal"]').innerText(), /“20–22” price/);

  // Each analyzed outcome is saved; its snapshot shows that outcome, not a bare Yes/No.
  await waitFor(async () => ((await storage('local', 'analysisHistory')) ?? []).some((item) => item.selectedSlug === 'atlantic-named-storms-2026-20-22'), 'outcome snapshot saved');
  await popup.locator('[data-tab="history"]').click();
  await popup.locator('[data-snapshot] button').first().click();
  await popup.locator('[data-view="analysis"][data-mode="snapshot"]').waitFor();
  assert.match(await popup.locator('[data-section="probability"]').innerText(), /^20–22\s+20\.5%/i);
  assert.doesNotMatch(await popup.locator('[data-section="probability"]').innerText(), /\bNO\b/);
});

await test('market inside an event: related markets, and opening one', async () => {
  const popup = await analysisFor('/event/fed-decision-december-2026/fed-decreases-rates-by-25-bps-december-2026');
  assert.equal(await popup.locator('[data-view="analysis"]').getAttribute('data-kind'), 'binary');
  assert.equal(await value(popup, 'probability'), '58.0%');
  const related = await popup.locator('[data-section="related"] [data-related]').allInnerTexts();
  assert.equal(related.length, 3);
  assert.match(related[0], /No change[\s\S]*29\.0%/);
  await popup.locator('[data-related="fed-no-change-december-2026"]').click();
  await popup.locator('h1.market-title', { hasText: 'keep interest rates unchanged' }).waitFor();
  assert.equal(await value(popup, 'probability'), '29.0%');
});

await test('/market/<slug> URLs and the canonical-link fallback for other Polymarket pages', async () => {
  const direct = await analysisFor('/market/will-global-ev-sales-exceed-20-million-in-2026');
  assert.equal(await value(direct, 'probability'), '62.4%');
  const sports = await analysisFor('/sports/nfl/games/week/4/some-game');
  assert.equal(await sports.locator('h1.market-title').innerText(), 'Will 2026 be the hottest year on record?');
});

await test('chart ranges: 24H and 30D load their own history', async () => {
  const popup = await analysisFor('/event/ev-sales-20m-2026');
  const before = api.requests.length;
  await popup.locator('[data-range="24h"]').click();
  await popup.locator('[data-section="chart"][data-chart-state="ready"] [data-range="24h"][aria-pressed="true"]').waitFor();
  assert.ok(api.requests.slice(before).some((request) => request.includes('interval=1d') && request.includes('fidelity=10')));
  await shot(popup, 'chart-24h');
  await popup.locator('[data-range="30d"]').click();
  await popup.locator('[data-section="chart"][data-chart-state="ready"] [data-range="30d"][aria-pressed="true"]').waitFor();
  assert.ok(api.requests.some((request) => request.includes('interval=1m')));
  assert.match(await popup.locator('.chart').getAttribute('aria-label'), /Price over 30 days: from/);
});

await test('missing price history: analysis from market data, chart explains why it is empty', async () => {
  const popup = await analysisFor('/event/private-lunar-landing-2026');
  assert.equal(await popup.locator('[data-section="chart"]').getAttribute('data-chart-state'), 'unavailable');
  assert.match(await popup.locator('[data-section="chart"]').innerText(), /Polymarket has no price history for this market yet/);
  assert.equal(await value(popup, 'signal'), 'POSITIVE MOMENTUM');
  assert.match(await text(popup), /Price history is unavailable/);
  assertHonest(await text(popup));
  await shot(popup, 'missing-history');
});

const ERROR_CASES = [
  ['/event/no-such-market-anywhere', 'NOT_FOUND', /Market not found/, 'error-not-found'],
  ['/event/malformed-market', 'INVALID_RESPONSE', /Couldn't read the market data/, 'error-invalid'],
  ['/event/rate-limited-market', 'RATE_LIMITED', /Try again in 30 s/, 'error-rate-limit'],
  ['/event/server-error-market', 'UNAVAILABLE', /HTTP 503/, null],
  ['/event/network-error-market', 'NETWORK', /Can't reach Polymarket/, 'error-network'],
  ['/event/winter-olympics-2026-opening-date', 'UNSUPPORTED_MARKET', /This market is closed/, null],
];
await test('errors: not found, malformed, rate limit, server error, network, closed market — no analysis', async () => {
  await resetStorage();
  for (const [path, code, message, screenshot] of ERROR_CASES) {
    const popup = await popupFor(`https://polymarket.com${path}`);
    await popup.locator(`[data-error="${code}"]`).waitFor();
    assert.match(await popup.locator('[data-error]').innerText(), message);
    assert.equal(await popup.locator('[data-section="signal"]').count(), 0, `${code}: no analysis`);
    assertHonest(await text(popup));
    if (screenshot) await shot(popup, screenshot);
    await popup.close();
  }
  // Retry recovers once the API answers again.
  api.failures.set('ev-sales-20m-2026', 503);
  const popup = await popupFor('https://polymarket.com/event/ev-sales-20m-2026');
  await popup.locator('[data-error="UNAVAILABLE"]').waitFor();
  api.failures.delete('ev-sales-20m-2026');
  await popup.getByRole('button', { name: 'Try again' }).click();
  await popup.locator('[data-view="analysis"]').waitFor();
});

await test('loading state is a skeleton', async () => {
  await resetStorage();
  api.delays.set('bitcoin-above-150k-end-of-2026', 2500);
  const site = await newPage();
  await site.goto('https://polymarket.com/event/bitcoin-above-150k-end-of-2026');
  const popup = await newPage();
  await popup.setViewportSize({ width: 400, height: 600 });
  await popup.goto(`chrome-extension://${extensionId}/popup.html?tab=${await tabIdOf(site.url())}`);
  await popup.locator('[data-state="loading"]').waitFor();
  await shot(popup, 'loading');
  await popup.locator('[data-view="analysis"]').waitFor({ timeout: 5000 });
});

await test('cache: reopening within 60 s makes no requests, Refresh forces new ones', async () => {
  await resetStorage();
  await analysisFor('/event/hottest-year-on-record-2026');
  const before = api.requests.length;
  const again = await analysisFor('/event/hottest-year-on-record-2026');
  assert.equal(api.requests.length, before, 'served from cache');
  await again.locator('#refresh-button').click();
  await waitFor(() => api.requests.length >= before + 2, 'refresh requests');
  await again.locator('[data-view="analysis"]').waitFor();
  assert.ok(api.requests.slice(before).some((request) => request.startsWith('/gamma/events?slug=hottest-year-on-record-2026')));
});

await test('stale data: refresh fails, cached data is shown with a stale warning', async () => {
  await resetStorage();
  await analysisFor('/event/ev-sales-20m-2026');
  // Age the cached responses by 10 minutes, then make the API fail.
  await worker.evaluate(async () => {
    const all = await chrome.storage.session.get(null);
    const aged = {};
    for (const [key, entry] of Object.entries(all)) if (key.startsWith('cache:')) aged[key] = { ...entry, storedAt: entry.storedAt - 10 * 60 * 1000 };
    await chrome.storage.session.set(aged);
  });
  api.failures.set('ev-sales-20m-2026', 503);
  const popup = await analysisFor('/event/ev-sales-20m-2026');
  assert.match(await popup.locator('[data-banner="stale"]').innerText(), /Showing data from 10 min ago\. Couldn't refresh: Polymarket data is unavailable/);
  assert.match(await popup.locator('[data-status]').innerText(), /Stale · Updated/);
  assert.equal(await value(popup, 'probability'), '62.4%');
  await shot(popup, 'stale');
});

await test('search: fallback off Polymarket, debounced, results open the market; empty and error states', async () => {
  await resetStorage();
  const popup = await popupFor(otherSite);
  await popup.locator('[data-view="search"]').waitFor();
  assert.match(await popup.locator('[data-notice]').innerText(), /Open a market on polymarket\.com to analyze it, or search below\./);
  const input = popup.getByPlaceholder('Search Polymarket markets…');
  assert.ok(await input.evaluate((element) => element === document.activeElement), 'search box focused');
  const before = api.requests.filter((request) => request.startsWith('/gamma/public-search')).length;
  await input.pressSequentially('storms', { delay: 40 });
  await popup.locator('[data-state="results"]').waitFor();
  const searches = api.requests.filter((request) => request.startsWith('/gamma/public-search')).slice(before);
  assert.equal(searches.length, 1, `debounced: ${searches.join(', ')}`);
  assert.match(searches[0], /q=storms/);
  assert.match(await popup.locator('[data-result="atlantic-named-storms-2026"]').innerText(), /5 outcomes[\s\S]*41\.0%[\s\S]*17–19/);
  await input.fill('');
  await input.fill('fed');
  await popup.locator('[data-result="fed-decision-december-2026"]').waitFor();
  await shot(popup, 'search');

  await input.fill('zzzz no match');
  await popup.getByText('No open markets found').waitFor();
  await input.fill('server error');
  await popup.locator('[data-error="UNAVAILABLE"]').waitFor();

  await input.fill('storms');
  await popup.locator('[data-result="atlantic-named-storms-2026"]').click();
  await popup.locator('[data-view="analysis"][data-kind="multi"]').waitFor();
});

await test('context menu: selection searches, market page analyzes (real popup)', async () => {
  await resetStorage();
  const probe = await newPage();
  await probe.goto(`chrome-extension://${extensionId}/popup.html?tab=0`);
  const site = await newPage();
  await site.goto('https://polymarket.com/event/us-q3-2026-gdp-growth');
  await site.bringToFront();
  const tabId = await tabIdOf(site.url());
  const tab = await worker.evaluate((id) => chrome.tabs.get(id), tabId);

  await worker.evaluate(({ tab }) => globalThis.__pmTest.onContextMenuClick({ menuItemId: 'pm-ai:analyze-selection', selectionText: '  “Atlantic named storms”  ', pageUrl: tab.url, editable: false }, tab), { tab });
  await waitFor(
    () => probe.evaluate(() => chrome.extension.getViews({ type: 'popup' })[0]?.document.getElementById('search-input')?.value === 'Atlantic named storms'),
    'popup opened with the selection as search query',
  );
  await waitFor(() => probe.evaluate(() => Boolean(chrome.extension.getViews({ type: 'popup' })[0]?.document.querySelector('[data-result="atlantic-named-storms-2026"]'))), 'search ran');
  await probe.evaluate(() => chrome.extension.getViews({ type: 'popup' })[0]?.close());

  await site.bringToFront();
  await worker.evaluate(({ tab }) => globalThis.__pmTest.onContextMenuClick({ menuItemId: 'pm-ai:analyze-page', pageUrl: tab.url, editable: false }, tab), { tab });
  await waitFor(
    () => probe.evaluate(() => chrome.extension.getViews({ type: 'popup' })[0]?.document.querySelector('h1.market-title')?.textContent === 'Will US Q3 2026 GDP growth exceed 2.0%?'),
    'popup opened with the page market analyzed',
    8000,
  );
  assert.equal(await storage('session', 'pending'), undefined, 'hand-off consumed');
});

await test('watchlist: add, refresh shows change arrows and alerts, remove', async () => {
  await resetStorage();
  let popup = await analysisFor('/event/ev-sales-20m-2026');
  await popup.locator('[data-action="watch"]').click();
  await popup.locator('[data-action="watch"][aria-pressed="true"]').waitFor();
  await popup.close();
  popup = await analysisFor('/event/atlantic-named-storms-2026');
  await popup.locator('[data-outcome="atlantic-named-storms-2026-14-16"]').click();
  await popup.locator('[data-outcome="atlantic-named-storms-2026-14-16"].is-selected').waitFor();
  await popup.locator('[data-action="watch"]').click();
  await popup.locator('[data-action="watch"][aria-pressed="true"]').waitFor();
  await popup.close();
  popup = await analysisFor('/event/bitcoin-above-150k-end-of-2026');
  await popup.locator('[data-action="watch"]').click();
  await popup.locator('[data-action="watch"][aria-pressed="true"]').waitFor();
  assert.equal((await storage('local', 'watchlist')).length, 3);

  // The EV market moves +7.6 pp; refresh.
  api.prices.set('will-global-ev-sales-exceed-20-million-in-2026', 0.7);
  await popup.locator('[data-tab="watchlist"]').click();
  await popup.locator('[data-view="watchlist"]').waitFor();
  assert.equal(await popup.locator('#watch-count').innerText(), '3');
  await popup.locator('[data-action="refresh-watchlist"]').click();
  const ev = popup.locator('[data-watch="ev-sales-20m-2026/will-global-ev-sales-exceed-20-million-in-2026"]');
  await ev.locator('[data-alerts]').waitFor();
  assert.match(await ev.innerText(), /70\.0%[\s\S]*\+7\.6 pp/);
  assert.match(await ev.locator('[data-alerts]').innerText(), /Moved \+7\.6 pp since last check \(62\.4% → 70\.0%\)/);
  assert.match(await popup.locator('[data-watch="atlantic-named-storms-2026/atlantic-named-storms-2026-14-16"]').innerText(), /How many named storms[\s\S]*14–16/);
  assertHonest(await text(popup));
  await shot(popup, 'watchlist');

  await popup.getByLabel('Remove Will Bitcoin close 2026 above $150,000? from watchlist').click();
  await waitFor(async () => (await popup.locator('[data-watch]').count()) === 2, 'item removed');
  assert.equal((await storage('local', 'watchlist')).length, 2);

  // Opening an item analyzes it.
  await ev.locator('button').first().click();
  await popup.locator('[data-view="analysis"]').waitFor();
  assert.equal(await value(popup, 'probability'), '70.0%');
});

const EV_KEY = 'ev-sales-20m-2026/will-global-ev-sales-exceed-20-million-in-2026';

await test('background alerts: per-market settings, alarm, notification with numbers only, click opens the analysis', async () => {
  await resetStorage();
  await recordNotifications();
  let popup = await analysisFor('/event/ev-sales-20m-2026');
  await popup.locator('[data-action="watch"]').click();
  await popup.locator('[data-action="watch"][aria-pressed="true"]').waitFor();
  await popup.close();
  popup = await analysisFor('/event/hottest-year-on-record-2026');
  await popup.locator('[data-action="watch"]').click();
  await popup.locator('[data-action="watch"][aria-pressed="true"]').waitFor();
  assert.equal(await alarm(), undefined, 'no alarm while no market has alerts on');

  // Settings per market, from the bell on the watchlist item.
  await popup.locator('[data-tab="watchlist"]').click();
  const ev = popup.locator(`[data-watch="${EV_KEY}"]`);
  await ev.locator('[data-action="alert-settings"]').click();
  const editor = popup.locator(`[data-alert-editor="${EV_KEY}"]`);
  await editor.waitFor();
  assert.equal(await ev.locator('[data-action="alert-settings"]').getAttribute('aria-expanded'), 'true');
  assert.ok(await editor.locator('[data-field="move"]').isDisabled(), 'rules disabled until alerts are on');
  await editor.getByLabel('Background alerts').check();
  await waitFor(async () => (await storage('local', 'watchlist')).find((item) => item.key === EV_KEY)?.alertSettings.enabled === true, 'alerts saved');
  await popup.locator(`[data-alert-editor="${EV_KEY}"] [data-field="move"]`).fill('3');
  await popup.locator(`[data-alert-editor="${EV_KEY}"] [data-field="move"]`).press('Tab');
  await popup.locator(`[data-alert-editor="${EV_KEY}"] [data-field="volume-on"]`).uncheck();
  await waitFor(async () => {
    const settings = (await storage('local', 'watchlist')).find((item) => item.key === EV_KEY)?.alertSettings;
    return settings?.movePp === 3 && settings.volumePct === null && settings.momentumFlip === true;
  }, 'thresholds saved');
  await popup.locator(`[data-watch="${EV_KEY}"][data-alerts-on="true"]`).waitFor();
  assert.match(await popup.locator(`[data-watch="${EV_KEY}"] [data-action="alert-settings"]`).getAttribute('title'), /Alerts on: Move > 3 pp · Momentum flip/);
  await waitFor(async () => (await alarm())?.periodInMinutes === 15, 'alarm every 15 minutes');
  await popup.evaluate(() => document.fonts.ready);
  await shot(popup, 'watchlist-alerts');

  // A background check 20 minutes later: EV moved +4.1 pp (over 3 pp); the other market has alerts off.
  await ageWatchlist(20);
  api.prices.set('will-global-ev-sales-exceed-20-million-in-2026', 0.665);
  const before = api.requests.length;
  const result = await fireAlertAlarm();
  assert.deepEqual(result, { status: 'done', checked: 1, notified: 1, failed: 0 });
  const requests = api.requests.slice(before);
  assert.deepEqual(requests, ['/gamma/events?slug=ev-sales-20m-2026'], 'one request, alerts-off market not checked');
  const ids = Object.keys(await worker.evaluate(() => chrome.notifications.getAll()));
  assert.equal(ids.length, 1);
  assert.match(ids[0], new RegExp(`^pm-alert\\|${EV_KEY}\\|\\d+$`));
  const [{ options: created }] = await worker.evaluate(() => globalThis.__created);
  assert.equal(created.title, 'Will global EV sales exceed 20 million in 2026?');
  assert.equal(created.message, 'Moved +4.1 pp since last check (62.4% → 66.5%)');
  assert.equal(created.contextMessage, 'Yes · Watchlist alert');
  assert.ok(!/\b(buy|sell|bets?|betting|wager|profit)\b/i.test(`${created.title} ${created.message} ${created.contextMessage}`), 'numbers only');

  // The open popup picks up the background result.
  await ev.locator('[data-alerts]', { hasText: 'Moved +4.1 pp since last check' }).waitFor();
  assert.match(await ev.innerText(), /66\.5%/);

  // Clicking the notification opens the popup with that market.
  await popup.close();
  const probe = await newPage();
  await probe.goto(`chrome-extension://${extensionId}/popup.html?tab=0`);
  const site = await newPage();
  await site.goto('https://polymarket.com/event/hottest-year-on-record-2026');
  await site.bringToFront();
  await worker.evaluate((id) => globalThis.__pmTest.onNotificationClicked(id), ids[0]);
  await waitFor(
    () => probe.evaluate(() => chrome.extension.getViews({ type: 'popup' })[0]?.document.querySelector('h1.market-title')?.textContent === 'Will global EV sales exceed 20 million in 2026?'),
    'popup opened with the alerted market',
    8000,
  );
  assert.equal(Object.keys(await worker.evaluate(() => chrome.notifications.getAll())).length, 0, 'notification cleared');
  await probe.evaluate(() => chrome.extension.getViews({ type: 'popup' })[0]?.close());

  // Options page: status of background alerts and the About Pro card.
  const options = await newPage();
  await options.setViewportSize({ width: 900, height: 900 });
  await options.goto(`chrome-extension://${extensionId}/options.html`);
  await options.locator('[data-alert-status]').waitFor();
  const status = await options.locator('[data-alert-status]').innerText();
  assert.match(status, /Markets with alerts\s+1 of 2/);
  assert.match(status, /Last check\s+(just now|\d+ s ago) · 1 checked · 1 notification\b/);
  assert.match(status, /Next check\s+\d\d:\d\d:\d\d \(in 1\d min\)/);
  assert.match(await options.locator('[data-alert-markets]').innerText(), /Will global EV sales exceed 20 million in 2026\?\s+Yes · Move > 3 pp · Momentum flip/);
  const pro = options.locator('[data-section="about-pro"]');
  assert.equal(await pro.locator('[data-value="price"]').innerText(), '$2.99');
  assert.ok(await pro.getByRole('button', { name: 'Get Pro' }).isDisabled());
  assert.match(await pro.innerText(), /Free during early access/);
  assert.match(await pro.locator('[data-list="pro"]').innerText(), /Background alerts[\s\S]*Unlimited watchlist[\s\S]*Compare view[\s\S]*30D charts/);
  assert.match(await pro.locator('[data-value="plan"]').innerText(), /Early access/);
  assertHonest(await text(options));
  await options.evaluate(() => document.fonts.ready);
  await options.screenshot({ path: join(outputDir, 'options.png'), fullPage: true });

  // Checked just now: the next alarm skips it (no request).
  const again = api.requests.length;
  assert.deepEqual(await fireAlertAlarm(), { status: 'done', checked: 0, notified: 0, failed: 0 });
  assert.equal(api.requests.length, again);

  // Removing the last market with alerts removes the alarm.
  await worker.evaluate(async (key) => {
    const { watchlist } = await chrome.storage.local.get('watchlist');
    await chrome.storage.local.set({ watchlist: watchlist.filter((item) => item.key !== key) });
  }, EV_KEY);
  await waitFor(async () => (await alarm()) === undefined, 'alarm removed');
});

await test('background alerts: a rate limit pauses the checks (options page says so)', async () => {
  await resetStorage();
  await worker.evaluate(
    (key) =>
      chrome.storage.local.set({
        watchlist: [
          {
            ref: { eventSlug: 'ev-sales-20m-2026', marketSlug: 'will-global-ev-sales-exceed-20-million-in-2026' },
            title: 'Will global EV sales exceed 20 million in 2026?',
            outcome: 'Yes',
            addedAt: Date.now(),
            last: { probability: 0.5, volume24h: 1000, signal: 'POSITIVE', at: Date.now() - 30 * 60_000 },
            alertSettings: { enabled: true, movePp: 5, volumePct: 100, momentumFlip: true },
          },
        ],
      }),
    EV_KEY,
  );
  api.failures.set('ev-sales-20m-2026', 429);
  assert.deepEqual(await fireAlertAlarm(), { status: 'done', checked: 0, notified: 0, failed: 1 });
  const state = await storage('local', 'alertCheck');
  assert.ok(state.backoffUntil >= Date.now() + 29 * 60_000, 'backs off at least 30 min');
  const before = api.requests.length;
  assert.equal((await fireAlertAlarm()).status, 'backing-off');
  assert.equal(api.requests.length, before, 'no request while backing off');
  assert.equal(Object.keys(await worker.evaluate(() => chrome.notifications.getAll())).length, 0);
  const options = await newPage();
  await options.goto(`chrome-extension://${extensionId}/options.html`);
  await options.getByText(/Polymarket is limiting requests, so checks pause until \d\d:\d\d:\d\d\./).waitFor();
});

await test('free plan (early access off): 5-market limit with About Pro link, 30D, compare and alerts are Pro', async () => {
  await resetStorage();
  await setEarlyAccess(false);
  try {
    await worker.evaluate(() =>
      chrome.storage.local.set({
        watchlist: Array.from({ length: 5 }, (_, index) => ({
          ref: { eventSlug: `placeholder-${index}`, marketSlug: null },
          title: `Placeholder market ${index}`,
          outcome: 'Yes',
          addedAt: Date.now() - index,
          last: { probability: 0.4 + index / 20, at: Date.now() },
          alertSettings: { enabled: index === 0, movePp: 5, volumePct: 100, momentumFlip: true },
        })),
      }),
    );
    // Alerts stored from a Pro period are kept but not run on free.
    await worker.evaluate(() => globalThis.__pmTest.syncAlarm());
    assert.equal(await alarm(), undefined, 'no alarm on free');
    const before = api.requests.length;
    assert.equal((await fireAlertAlarm()).status, 'not-allowed');
    assert.equal(api.requests.length, before);

    const popup = await analysisFor('/event/hottest-year-on-record-2026');
    // 30D is shown but disabled.
    assert.ok(await popup.locator('[data-range="30d"]').isDisabled());
    assert.equal(await popup.locator('[data-range="30d"]').getAttribute('title'), '30D charts are part of Pro');
    // Related markets and unusual activity are part of the free analysis.
    assert.equal(await popup.getByText(/is part of Pro/).count(), 0);

    await popup.locator('[data-action="watch"]').click();
    const toast = popup.locator('[data-toast]', { hasText: 'Free keeps 5 markets on the watchlist. Pro removes the limit.' });
    await toast.waitFor();
    assert.equal(await popup.locator('[data-action="watch"]').getAttribute('aria-pressed'), 'false');
    assert.equal((await storage('local', 'watchlist')).length, 5, 'nothing added, nothing deleted');
    const [options] = await Promise.all([context.waitForEvent('page'), toast.getByRole('button', { name: 'About Pro' }).click()]);
    openPages.add(options);
    await options.waitForLoadState();
    assert.match(options.url(), /options\.html#pro$/);
    await options.locator('[data-section="about-pro"]').waitFor();
    assert.equal(await options.locator('[data-value="plan"]').innerText(), 'Free');
    assert.match(await options.locator('#alerts').innerText(), /Background alerts are part of Pro/);

    await popup.locator('[data-tab="watchlist"]').click();
    await popup.locator('[data-view="watchlist"] [data-limit]').waitFor();
    assert.match(await popup.locator('[data-view="watchlist"]').innerText(), /5\/5[\s\S]*Free keeps 5 markets on the watchlist\. Pro removes the limit\.\s*About Pro/);
    await popup.locator('[data-watch="placeholder-0/"] [data-action="alert-settings"]').click();
    assert.match(await popup.locator('[data-alert-editor="placeholder-0/"]').innerText(), /Background alerts are part of Pro/);
    assert.equal(await popup.locator('[data-alert-editor] input').count(), 0);
    assertHonest(await text(popup));
    await popup.evaluate(() => document.querySelectorAll('[data-toast]').forEach((toast) => toast.remove()));
    await shot(popup, 'free-watchlist-limit');

    await popup.locator('[data-tab="compare"]').click();
    await popup.getByText('The compare view is part of Pro').waitFor();
  } finally {
    await setEarlyAccess(true);
  }
});

await test('early access: the watchlist has no plan limit', async () => {
  await resetStorage();
  await worker.evaluate(() =>
    chrome.storage.local.set({
      watchlist: Array.from({ length: 60 }, (_, index) => ({
        ref: { eventSlug: `placeholder-${index}`, marketSlug: null },
        title: `Placeholder market ${index}`,
        outcome: 'Yes',
        addedAt: Date.now() - index,
      })),
    }),
  );
  const popup = await analysisFor('/event/hottest-year-on-record-2026');
  await popup.locator('[data-action="watch"]').click();
  await popup.locator('[data-action="watch"][aria-pressed="true"]').waitFor();
  assert.equal((await storage('local', 'watchlist')).length, 61);
  await popup.locator('[data-tab="watchlist"]').click();
  assert.match(await popup.locator('[data-view="watchlist"] .section-label').first().innerText(), /^WATCHLIST\s*61$/i);
  assert.equal(await popup.locator('[data-limit]').count(), 0);
});

await test('history: analyses saved as dated snapshots, reopen read-only, load live', async () => {
  await resetStorage();
  const paths = ['/event/hottest-year-on-record-2026', '/event/new-element-confirmed-2026', '/event/us-q3-2026-gdp-growth'];
  for (const [index, path] of paths.entries()) {
    const popup = await analysisFor(path);
    await waitFor(async () => ((await storage('local', 'analysisHistory')) ?? []).length === index + 1, 'snapshot saved');
    await popup.close();
  }
  const popup = await popupFor(otherSite);
  await popup.locator('[data-tab="history"]').click();
  await popup.locator('[data-view="history"]').waitFor();
  const titles = await popup.locator('[data-snapshot] .item-title').allInnerTexts();
  assert.deepEqual(titles, ['Will US Q3 2026 GDP growth exceed 2.0%?', 'Will a new chemical element be confirmed in 2026?', 'Will 2026 be the hottest year on record?']);
  await shot(popup, 'history');

  await popup.locator('[data-snapshot] button').first().click();
  await popup.locator('[data-view="analysis"][data-mode="snapshot"]').waitFor();
  assert.match(await popup.locator('[data-banner="snapshot"]').innerText(), /Snapshot from .*Not live data\./);
  assert.equal(await value(popup, 'signal'), 'STRONG POSITIVE MOMENTUM');
  assert.equal(await popup.locator('[data-section="chart"]').getAttribute('data-chart-state'), 'ready');
  assert.equal(await popup.locator('[data-range]').count(), 0, 'static chart');
  assertHonest(await text(popup));
  await shot(popup, 'snapshot');
  await popup.getByRole('button', { name: 'Load live' }).click();
  await popup.locator('[data-view="analysis"][data-mode="live"]').waitFor();

  await popup.locator('[data-tab="history"]').click();
  await popup.locator('[data-action="clear-history"]').click();
  await popup.locator('[data-action="clear-history"]', { hasText: 'Click again' }).click();
  await popup.getByText('No analyses yet').waitFor();
});

await test('compare: side by side, no ranking', async () => {
  await resetStorage();
  const paths = ['/event/ev-sales-20m-2026', '/event/bitcoin-above-150k-end-of-2026', '/event/hottest-year-on-record-2026'];
  for (const [index, path] of paths.entries()) {
    const popup = await analysisFor(path);
    await waitFor(async () => ((await storage('local', 'analysisHistory')) ?? []).length === index + 1, 'snapshot saved');
    await popup.close();
  }
  const popup = await popupFor(otherSite);
  await popup.locator('[data-tab="compare"]').click();
  await popup.locator('[data-view="compare"]').waitFor();
  await popup.locator('[data-compare="ev-sales-20m-2026/will-global-ev-sales-exceed-20-million-in-2026"]').check();
  await popup.locator('[data-compare="bitcoin-above-150k-end-of-2026/will-bitcoin-close-2026-above-150000"]').check();
  await popup.locator('[data-section="comparison"]').waitFor();
  await popup.locator('[data-compare="hottest-year-on-record-2026/will-2026-be-the-hottest-year-on-record"]').check();
  await waitFor(async () => (await popup.locator('[data-section="comparison"] thead th').count()) === 4, 'three columns');
  const table = await popup.locator('[data-section="comparison"]').innerText();
  assert.match(table, /Probability\s+62\.4%\s+18\.0%\s+47\.0%/);
  assert.match(table, /24h change\s+\+3\.1 pp\s+−7\.5 pp\s+\+0\.2 pp/);
  assert.match(table, /Momentum\s+Positive\s+60\/100\s+Strong negative\s+85\/100\s+Neutral\s+0\/100/);
  assert.match(await text(popup), /not a ranking or a recommendation/);
  assertHonest(await text(popup));
  await shot(popup, 'compare', { full: true });
});

await test('corrupted storage is repaired on read', async () => {
  await resetStorage();
  await worker.evaluate(() =>
    chrome.storage.local.set({
      watchlist: [
        null,
        'junk',
        { ref: { eventSlug: 'ev-sales-20m-2026', marketSlug: 'will-global-ev-sales-exceed-20-million-in-2026' }, title: 'Will global EV sales exceed 20 million in 2026?', addedAt: Date.now(), last: { probability: 7, at: 'x' } },
        { ref: { eventSlug: '../../etc', marketSlug: null }, title: 'Bad slug', addedAt: 1 },
      ],
      analysisHistory: { not: 'an array' },
      plan: 'enterprise',
    }),
  );
  const popup = await popupFor(otherSite);
  await popup.locator('[data-tab="watchlist"]').click();
  await popup.locator('[data-view="watchlist"]').waitFor();
  assert.equal(await popup.locator('[data-watch]').count(), 1);
  await popup.locator('[data-watch] [data-value="probability"]', { hasText: '62.4%' }).waitFor();
  assertHonest(await text(popup));
});

await test('the extension only talks to the configured API', async () => {
  await resetStorage();
  const foreign = [];
  const listener = (request) => {
    const url = request.url();
    if (url.startsWith('chrome-extension://') || url.startsWith('data:') || url.startsWith(`http://127.0.0.1:${e2eConfig.port}/`) || url.startsWith('https://polymarket.com/') || url.startsWith(otherSite)) return;
    foreign.push(url);
  };
  context.on('request', listener);
  const popup = await analysisFor('/event/us-q3-2026-gdp-growth');
  await popup.locator('[data-range="30d"]').click();
  await popup.locator('[data-section="chart"][data-chart-state="ready"]').waitFor();
  context.off('request', listener);
  assert.deepEqual(foreign, []);
});

// --- Summary ------------------------------------------------------------------------------

await context.close();
server.close();
pageServer.close();
await rm(userDataDir, { recursive: true, force: true });

/** The screenshots committed to screenshots/ and shown in the README. */
const CURATED = [
  'binary-positive',
  'binary-positive-full',
  'multi-outcome-full',
  'unusual-activity-full',
  'negative-full',
  'neutral-full',
  'low-liquidity-full',
  'missing-history',
  'chart-24h',
  'loading',
  'stale',
  'error-network',
  'error-not-found',
  'error-rate-limit',
  'error-invalid',
  'search',
  'watchlist',
  'history',
  'snapshot',
  'compare-full',
  'watchlist-alerts',
  'free-watchlist-limit',
  'options',
];

const failed = results.filter((result) => !result.ok);
if (!failed.length && process.env.UPDATE_SCREENSHOTS === '1') {
  await rm(screenshotsDir, { recursive: true, force: true });
  await mkdir(screenshotsDir, { recursive: true });
  for (const name of CURATED) await copyFile(join(outputDir, `${name}.png`), join(screenshotsDir, `${name}.png`));
  console.log(`\nCopied ${CURATED.length} screenshots to ${screenshotsDir}`);
}
console.log(`\n${results.length - failed.length}/${results.length} passed. Screenshots: ${outputDir}`);
process.exit(failed.length ? 1 : 0);
