// End-to-end smoke test: loads the e2e build (dist-e2e/) into a real Chromium and drives
// every user flow against a local server whose pages the test changes between checks.
//
//   npm run test:e2e                      (set CHROMIUM_PATH if Chromium isn't auto-detected)
//   SCREENSHOTS=1 npm run test:e2e        also refreshes the curated screenshots/ for the README
//
// Alarms can't be fast-forwarded and notifications can't be clicked from automation, so the
// test calls the handlers Chrome would call through a hook that only exists in the e2e build.
// The e2e build is also granted the test sites up front (permission prompts can't be clicked).
// Fixture pages are served under realistic host names (shop.example.com, docs.example.org...)
// that Chromium maps to a local server.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
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
const updateScreenshots = process.env.SCREENSHOTS === '1';

function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const candidates = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  const found = candidates.find((path) => existsSync(path));
  if (!found) throw new Error('Chromium not found. Set CHROMIUM_PATH.');
  return found;
}

// --- Test server with pages the test can change -------------------------------------------

// Fixture sites under realistic names (no port), so screenshots never show 127.0.0.1,
// localhost or a port. Chromium maps them to the local server (see the launch args).
const SHOP = 'shop.example.com';
const DOCS = 'docs.example.org';
const STATUS = 'status.example.com';
const APP = 'app.example.com';
const NEWS = 'news.example.com';
/** Mapped to a closed port: connections are refused. */
const DOWN = 'down.example.com';
/** Served, but the e2e build has no access to it (like a site whose access was removed). */
const PRIVATE = 'private.example.net';
const SITES = [SHOP, DOCS, STATUS, APP, NEWS, PRIVATE];
const site = (host, path = '/') => `http://${host}${path}`;
const LAMP = site(SHOP, '/aurora-desk-lamp');
const THROW = site(SHOP, '/nordic-wool-throw');
const NOTES = site(DOCS, '/release-notes');
const CHANGELOG = site(DOCS, '/changelog');
const STATUS_PAGE = site(STATUS, '/');
const DASHBOARD = site(APP, '/dashboard');
const NEWS_PAGE = site(NEWS, '/');

const state = {
  docs: ['Page Watch keeps an eye on pages for you.', 'Checks run in the background, a few times an hour at most.', 'Version 1.0 is the current release.'],
  price: '$129.00',
  stock: 'In stock',
  promo: 'Free shipping on orders over $50.',
  showPrice: true,
  flakyStatus: 200,
  slowMs: 400,
  throwPrice: '$89.00',
  throwStock: 'In stock',
  throwRequests: 0,
};
const requests = [];
let slowInFlight = 0;
let slowPeak = 0;

const shopHtml = () => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Aurora Desk Lamp – Lumen Store</title>
<style>
  body { margin: 0; font: 16px/1.5 Georgia, serif; background: #faf7f2; color: #222; }
  header { display: flex; gap: 32px; align-items: center; padding: 14px 40px; background: #1f2937; color: #fff; }
  header nav { opacity: .8; }
  main { display: grid; grid-template-columns: 340px 1fr; gap: 40px; max-width: 920px; margin: 40px auto; padding: 0 24px; }
  .css-1x2y3z { height: 320px; border-radius: 16px; background: linear-gradient(135deg, #f1e3c8, #d9c3a0); }
  h1 { margin: 0 0 8px; font-size: 30px; }
  .price-box { display: inline-flex; gap: 10px; align-items: baseline; margin: 18px 0 6px; padding: 12px 18px; border: 1px solid #ddd; border-radius: 10px; background: #fff; }
  .sc-bdVaJa { font-size: 30px; font-weight: bold; color: #b91c1c; }
  .unit { color: #666; font-size: 14px; }
  #stock { font-weight: bold; color: #15803d; }
  button { padding: 12px 22px; border: 0; border-radius: 8px; background: #1f2937; color: #fff; font-size: 16px; }
</style></head>
<body>
<header><strong>Lumen Store</strong><nav>Lamps · Desks · Sale</nav></header>
<main>
  <div class="css-1x2y3z" aria-hidden="true"></div>
  <section class="product">
    <h1 class="product-title">Aurora Desk Lamp</h1>
    <p class="css-9f8e7d">Warm, dimmable LED lamp with a brushed aluminium arm.</p>
    <div class="price-box">${state.showPrice ? `<span data-testid="price" class="sc-bdVaJa">${state.price}</span>` : '<span class="sc-bdVaJa">See price in cart</span>'}<span class="unit">incl. VAT</span></div>
    <p id="stock" class="stock">${state.stock}</p>
    <p class="promo">${state.promo}</p>
    <button type="button">Add to cart</button>
  </section>
</main>
<script>document.querySelector('button').addEventListener('click', () => { document.title = 'clicked'; });</script>
</body></html>`;

// A product page full of the usual noise: every request changes the viewer count, the
// generation time and request id, the recommendations and the order of the trending list.
const RECOMMENDED = [
  ['Brass Floor Lamp · $59.00', 'Oak Side Table · $129.00'],
  ['Linen Lamp Shade · $39.00', 'Walnut Tray · $25.00'],
  ['Wool Rug · $149.00', 'Ceramic Vase · $32.00'],
];
const TRENDING = ['Aurora Desk Lamp', 'Linen Lamp Shade', 'Oak Side Table', 'Cork Coasters'];
const pad = (value) => String(value).padStart(2, '0');
const throwHtml = () => {
  const n = state.throwRequests++;
  const seconds = 9 * 3600 + 41 * 60 + 5 + n * 13;
  const time = `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}`;
  const id = createHash('sha1').update(`request ${n}`).digest('hex').slice(0, 12);
  const trending = TRENDING.map((_, index) => TRENDING[(index + n) % TRENDING.length]);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Nordic Wool Throw – Lumen Store</title>
<style>
  body { margin: 0; font: 16px/1.5 Georgia, serif; background: #faf7f2; color: #222; }
  header { padding: 14px 40px; background: #1f2937; color: #fff; }
  main { max-width: 760px; margin: 32px auto; padding: 0 24px; }
  .price { font-size: 28px; font-weight: bold; color: #b91c1c; margin: 8px 0; }
  .viewers { color: #9a3412; }
  section { margin-top: 24px; }
  footer { max-width: 760px; margin: 24px auto; padding: 0 24px; color: #666; font-size: 13px; }
</style></head>
<body>
<header><strong>Lumen Store</strong> · Lamps · Textiles · Sale</header>
<main>
  <h1>Nordic Wool Throw</h1>
  <p>Soft merino wool, 130 × 170 cm, woven in Portugal.</p>
  <p class="price" data-testid="price">${state.throwPrice}</p>
  <p class="stock">${state.throwStock}</p>
  <p class="viewers">${12 + ((n * 7) % 19)} people are viewing this right now</p>
  <section><h2>Customers also bought</h2><ul>${RECOMMENDED[n % RECOMMENDED.length].map((item) => `<li>${item}</li>`).join('')}</ul></section>
  <section><h2>Trending now</h2><ol>${trending.map((item) => `<li>${item}</li>`).join('')}</ol></section>
</main>
<footer><p>Page generated at ${time} · Request ID ${id}</p><p>© Lumen Store</p></footer>
</body></html>`;
};

const docsHtml = () => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Release notes – Example Docs</title>
<style>body { font: 16px/1.6 system-ui, sans-serif; max-width: 680px; margin: 40px auto; padding: 0 20px; }</style></head>
<body><nav>Home · Docs · Blog</nav><main><h1>Release notes</h1>${state.docs.map((text) => `<p>${text}</p>`).join('')}</main>
<footer>© Example Docs</footer><script>console.log('never runs in the parser')</script></body></html>`;

const changelogHtml = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Changelog – Example Docs</title></head>
<body><nav>Home · Docs · Blog</nav><main><h1>Changelog</h1><p>Version 1.1: keyword alerts.</p><p>Version 1.0: first release.</p></main></body></html>`;

const spaHtml = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Dashboard – Example App</title></head>
<body><div id="root"></div><noscript>You need to enable JavaScript to run this app.</noscript>
<script>
  document.getElementById('root').innerHTML = '<h1>Dashboard</h1><p id="balance">Balance: $1,234.56</p>' +
    '<p>Recent activity and account details are rendered in the browser by JavaScript.</p>'.repeat(12);
</script></body></html>`;

function cp1251(text) {
  const bytes = [];
  for (const char of text) {
    const code = char.codePointAt(0);
    if (code < 0x80) bytes.push(code);
    else if (code >= 0x410 && code <= 0x44f) bytes.push(code - 0x410 + 0xc0);
    else if (code === 0x401) bytes.push(0xa8);
    else if (code === 0x451) bytes.push(0xb8);
    else bytes.push(0x3f);
  }
  return Buffer.from(bytes);
}

const server = createServer((request, response) => {
  const host = (request.headers.host ?? '').replace(/:\d+$/, '');
  const url = new URL(request.url ?? '/', `http://${host || 'localhost'}`);
  requests.push({ host, path: url.pathname, dest: request.headers['sec-fetch-dest'] ?? '', at: Date.now() });
  const html = (body, status = 200, headers = {}) => response.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers }).end(body);
  switch (`${host}${url.pathname}`) {
    case `${SHOP}/aurora-desk-lamp`:
      return html(shopHtml());
    case `${SHOP}/nordic-wool-throw`:
      return html(throwHtml());
    case `${SHOP}/api/price`:
      return response.writeHead(200, { 'content-type': 'application/json' }).end('{"price": 129}');
    case `${SHOP}/hang`:
      return; // Never answers: exercises the timeout.
    case `${DOCS}/release-notes`:
    case `${PRIVATE}/release-notes`:
      return html(docsHtml());
    case `${DOCS}/changelog`:
      return html(changelogHtml);
    case `${DOCS}/latest`:
      return response.writeHead(302, { location: '/release-notes' }).end();
    case `${STATUS}/`:
      return html(`<!doctype html><title>Status</title><h1>Service status</h1><p>All systems normal.</p>`, state.flakyStatus);
    case `${APP}/dashboard`:
      return html(spaHtml);
    case `${NEWS}/`:
      return response
        .writeHead(200, { 'content-type': 'text/html' })
        .end(cp1251('<!doctype html><meta charset="windows-1251"><title>Новости</title><h1>Новости</h1><p>Привет, мир! Цена 250 грн</p>'));
    default:
      if (host === DOCS && url.pathname.startsWith('/slow/')) {
        slowInFlight++;
        slowPeak = Math.max(slowPeak, slowInFlight);
        setTimeout(() => {
          slowInFlight--;
          html(`<!doctype html><title>Slow ${url.pathname}</title><p>Slow page ${url.pathname} ${Date.now()}</p>`);
        }, state.slowMs);
        return;
      }
      return html('<h1>Not found</h1>', 404);
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
/** Requests made by the extension's service worker (fetch), not by page loads. */
const extensionFetches = () => requests.filter((request) => request.dest === 'empty');

// --- Browser ------------------------------------------------------------------------------

await mkdir(outputDir, { recursive: true });
if (updateScreenshots) await mkdir(screenshotsDir, { recursive: true });
const userDataDir = await mkdtemp(join(tmpdir(), 'page-watch-e2e-'));
const context = await chromium.launchPersistentContext(userDataDir, {
  executablePath: findChromium(),
  headless,
  viewport: { width: 1280, height: 800 },
  locale: 'en-US',
  acceptDownloads: true,
  args: [
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
    // The fixture sites (port 80) resolve to the local server, down.example.com to a closed port...
    `--host-resolver-rules=${SITES.map((host) => `MAP ${host}:80 127.0.0.1:${port}`).join(',')},MAP ${DOWN}:80 127.0.0.1:1`,
    // ...directly, not through a proxy from the environment...
    '--no-proxy-server',
    // ...and count as secure contexts, like 127.0.0.1 would.
    `--unsafely-treat-insecure-origin-as-secure=${SITES.map((host) => site(host, '')).join(',')}`,
  ],
});
const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
const extensionId = new URL(worker.url()).host;
const otherHostRequests = [];
context.on('request', (request) => {
  const url = request.url();
  if (!SITES.some((host) => url.startsWith(site(host, '/'))) && !url.startsWith('chrome-extension://') && !url.startsWith('data:') && !url.startsWith('chrome://') && !url.startsWith('blob:')) {
    otherHostRequests.push(url);
  }
});
// The worker can be reported before its script has run (slow machines): wait for the hook.
await waitFor(() => worker.evaluate(() => Boolean(globalThis.__pageWatchTest)).catch(() => false), 'test hook in the service worker', 30_000);
await worker.evaluate(() => globalThis.__pageWatchTest.setFetchTimeout(1500));
// The noise filter's learning fetch is fired by the tests (one test lets the real alarm do it).
const LEARN_OFF = 60 * 60_000;
await worker.evaluate((ms) => globalThis.__pageWatchTest.setLearnDelay(ms), LEARN_OFF);

const openPages = new Set();
async function newPage() {
  const page = await context.newPage();
  openPages.add(page);
  return page;
}

async function open(url) {
  const page = await newPage();
  await page.goto(url);
  await page.bringToFront();
  return page;
}

async function tabOf(page) {
  await page.bringToFront();
  return worker.evaluate(async (url) => {
    const matches = (await chrome.tabs.query({})).filter((tab) => tab.url === url);
    if (matches.length) return matches.sort((a, b) => b.id - a.id)[0];
    // chrome:// pages don't expose their URL to the extension: use the active tab.
    const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return active;
  }, page.url());
}

/** The toolbar popup, opened as a tab and pointed at `target`'s tab (e2e-only ?tab=). */
async function popupFor(target, query = '') {
  const tab = await tabOf(target);
  const popup = await newPage();
  await popup.setViewportSize({ width: 400, height: 600 });
  await popup.goto(`chrome-extension://${extensionId}/popup.html?tab=${tab.id}${query}`);
  return popup;
}

/** A page already watched shows one line; "Add another" brings back the add buttons. */
async function addButtons(popup) {
  await popup.locator('#current .tab-watched, #current [data-focus="watch-page"], #current .limit-note').first().waitFor();
  const more = popup.getByRole('button', { name: 'Add another' });
  if (await more.count()) await more.click();
}

async function extensionPage(path = 'options.html') {
  const page = await newPage();
  await page.goto(`chrome-extension://${extensionId}/${path}`);
  return page;
}

async function waitFor(check, message, timeout = 8000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await check();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  throw new Error(`Timed out: ${message}`);
}

const hook = (name, ...args) => worker.evaluate(({ name, args }) => globalThis.__pageWatchTest[name](...args), { name, args });
const storage = (key) => worker.evaluate(async (key) => (await chrome.storage.local.get(key))[key], key);
const watches = async () => (await storage('watches')) ?? [];
const watchById = async (id) => (await watches()).find((watch) => watch.id === id);
const notifications = () => worker.evaluate(() => chrome.notifications.getAll());
const badge = () => worker.evaluate(() => chrome.action.getBadgeText({}));
const alarm = (id) => worker.evaluate((id) => chrome.alarms.get(`watch:${id}`), id);
const learnAlarm = (id) => worker.evaluate((id) => chrome.alarms.get(`learn:${id}`), id);
const check = (id) => hook('runCheck', id);
const deleteWatch = async (id) => {
  const helper = await extensionPage('options.html');
  assert.ok((await helper.evaluate((id) => chrome.runtime.sendMessage({ type: 'pw/delete', id }), id)).ok);
  await helper.close();
  openPages.delete(helper);
};

async function markAllSeen() {
  const helper = await extensionPage('options.html');
  await helper.evaluate(() => chrome.runtime.sendMessage({ type: 'pw/mark-seen', id: null }));
  await waitFor(async () => (await badge()) === '', 'all seen');
  await helper.close();
  openPages.delete(helper);
}

/** Adds a whole-page watch the way the popup does after the permission prompt. */
async function addWatch(url, draft = {}) {
  const page = await extensionPage('options.html');
  const response = await page.evaluate(
    ({ url, draft }) =>
      chrome.runtime.sendMessage({
        type: 'pw/complete-add',
        pending: {
          id: crypto.randomUUID(),
          kind: 'page',
          tabId: 1,
          url,
          createdAt: Date.now(),
          draft: { url, name: '', selectors: [], intervalMinutes: 60, mode: 'text', keyword: '', liveText: null, ...draft },
        },
      }),
    { url, draft },
  );
  await page.close();
  openPages.delete(page);
  return response;
}

/** Scrolls the popup so `locator` sits right under the sticky header. */
const scrollTo = (locator) =>
  locator.evaluate((element) => window.scrollTo({ top: element.getBoundingClientRect().top + window.scrollY - 52, behavior: 'instant' }));

async function shot(page, name, { popup = false, fullPage = false, scroll = null, element = null } = {}) {
  const path = join(outputDir, `${name}.png`);
  if (element) {
    await element.screenshot({ path });
    return path;
  }
  if (popup) {
    const height = await page.evaluate(() => Math.min(600, Math.ceil(document.documentElement.scrollHeight)));
    await page.setViewportSize({ width: 400, height });
  }
  if (scroll) await scrollTo(scroll);
  await page.screenshot({ path, fullPage });
  if (popup) await page.setViewportSize({ width: 400, height: 600 });
  return path;
}

/** Light + dark screenshots; the curated ones are copied to screenshots/ when SCREENSHOTS=1. */
async function shots(page, name, options = {}) {
  const light = await shot(page, name, options);
  // Wait out Bootstrap's color transitions so the capture shows the final colors.
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForTimeout(400);
  const dark = await shot(page, `${name}-dark`, options);
  await page.emulateMedia({ colorScheme: 'light' });
  await page.waitForTimeout(400);
  if (updateScreenshots) {
    await copyFile(light, join(screenshotsDir, `${name}.png`));
    await copyFile(dark, join(screenshotsDir, `${name}-dark.png`));
  }
}

const picker = (page) => page.locator('page-watch-picker');
const ids = {};

// --- Tests --------------------------------------------------------------------------------

const results = [];
async function test(name, fn) {
  const started = Date.now();
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

console.log(`Chromium ${context.browser()?.version() ?? ''} · extension ${extensionId} · fixtures on 127.0.0.1:${port} as ${SITES.join(', ')}\n`);

await test('production manifest: minimal permissions, optional per-site host access, no test hook', async () => {
  const manifest = JSON.parse(await readFile(join(root, 'dist/manifest.json'), 'utf8'));
  assert.deepEqual([...manifest.permissions].sort(), ['activeTab', 'alarms', 'notifications', 'offscreen', 'scripting', 'storage']);
  assert.deepEqual(manifest.optional_host_permissions, ['https://*/*', 'http://*/*']);
  assert.equal(manifest.host_permissions, undefined);
  assert.equal(manifest.content_scripts, undefined);
  // 30-second alarms (1-minute checks with jitter, the learning fetch) need Chrome 120.
  assert.equal(manifest.minimum_chrome_version, '120');
  for (const file of ['background.js', 'popup.js', 'picker.js', 'options.js', 'offscreen.js']) {
    const source = await readFile(join(root, 'dist', file), 'utf8');
    assert.ok(!source.includes('__pageWatchTest'), `${file} contains the test hook`);
    assert.ok(!source.includes("has('deny')") && !source.includes('has("deny")'), `${file} contains the simulated denial`);
    assert.ok(!source.includes('e2e:earlyAccess') && !source.includes('setEarlyAccessForTesting'), `${file} contains the early access override`);
    assert.ok(!source.includes('setLearnDelay') && !source.includes('chimeLog.push'), `${file} contains a test-only switch`);
  }
  // One offscreen document for both jobs: parsing pages and the optional chime.
  const background = await readFile(join(root, 'dist/background.js'), 'utf8');
  assert.match(background, /reasons: \["DOM_PARSER", "AUDIO_PLAYBACK"\]/);
  // The chime is synthesized, no audio files are shipped or fetched.
  assert.ok(!/\.(mp3|ogg|wav)\b/.test(await readFile(join(root, 'dist/offscreen.js'), 'utf8')));
  // The plan seam ships in early access.
  const options = await readFile(join(root, 'dist/options.js'), 'utf8');
  assert.match(options, /var earlyAccess = (?:!0|true);/);
  for (const file of ['background.js', 'popup.js', 'options.js']) {
    assert.ok(!/extensionpay|lemonsqueezy|paddle|gumroad|stripe/i.test(await readFile(join(root, 'dist', file), 'utf8')), `${file} has payment code`);
  }
});

await test('popup: empty state explains how to start', async () => {
  const shop = await open(LAMP);
  const popup = await popupFor(shop);
  await popup.getByRole('button', { name: 'Watch this page' }).waitFor();
  assert.match(await popup.locator('.empty-state').innerText(), /Know when a page changes/);
  assert.match(await popup.locator('#current').innerText(), /Aurora Desk Lamp – Lumen Store\s+shop\.example\.com\/aurora-desk-lamp/);
  assert.ok(await popup.getByRole('button', { name: 'Pick an element…' }).isVisible());
  // Bundled fonts are used (no remote font loading).
  assert.ok(await popup.evaluate(async () => (await document.fonts.load('14px "Manrope Variable"')).length > 0));
  await shots(popup, 'popup-empty', { popup: true });
});

await test('popup: pages that cannot be watched say so', async () => {
  const blocked = await newPage();
  await blocked.goto('chrome://version');
  const popup = await popupFor(blocked);
  await popup.getByText("This page can't be watched").waitFor();
  assert.equal(await popup.getByRole('button', { name: 'Watch this page' }).count(), 0);
});

await test('popup: a denied permission explains why and saves nothing', async () => {
  const docs = await open(NOTES);
  const popup = await popupFor(docs, '&deny=1');
  await popup.getByRole('button', { name: 'Watch this page' }).click();
  await popup.getByRole('button', { name: 'Start watching' }).click();
  await popup.locator('.alert-danger', { hasText: 'needs access to docs.example.org' }).waitFor();
  assert.match(await popup.locator('.alert-danger').innerText(), /Nothing was saved/);
  assert.equal((await watches()).length, 0);
  await shot(popup, 'popup-denied', { popup: true });
});

await test('whole page: add from the popup, baseline stored, alarm and learning fetch scheduled', async () => {
  const docs = await open(NOTES);
  const popup = await popupFor(docs);
  await popup.getByRole('button', { name: 'Watch this page' }).click();
  const name = popup.getByLabel('Name');
  assert.equal(await name.inputValue(), 'Release notes – Example Docs');
  await name.fill('Release notes');
  await popup.getByLabel('Check every').selectOption('15');
  await shots(popup, 'popup-add-form', { popup: true });
  const fetchesBefore = extensionFetches().length;
  await popup.getByRole('button', { name: 'Start watching' }).click();
  await popup.locator('.toast', { hasText: 'Watching “Release notes”' }).waitFor();
  const [watch] = await watches();
  ids.docs = watch.id;
  assert.equal(watch.selector, null);
  assert.equal(watch.intervalMinutes, 15);
  assert.equal(watch.status, 'unchanged');
  assert.equal(watch.sound, true);
  const snapshot = await storage(`snapshot:${watch.id}`);
  assert.equal(snapshot.text, `Home · Docs · Blog\nRelease notes\n${state.docs.join('\n')}\n© Example Docs`);
  assert.ok(!snapshot.text.includes('never runs'), 'scripts are not part of the text');
  assert.equal(extensionFetches().length, fetchesBefore + 1, 'exactly one fetch for the baseline, the UI does not wait for the second');
  const scheduled = await alarm(watch.id);
  const minutes = (scheduled.scheduledTime - Date.now()) / 60_000;
  assert.ok(minutes > 13 && minutes < 16.6, `next check in ${minutes} min`);
  // The noise filter's second fetch is scheduled (fired by the tests in this build).
  assert.ok(await learnAlarm(watch.id), 'learning fetch scheduled');
  assert.deepEqual(await storage(`noise:${watch.id}`), { phase: 'pair', checksLeft: 0, rules: [] });
  await popup.locator('.watch', { hasText: 'Release notes' }).waitFor();
  // Now that it's watched, the tab block is one line.
  await popup.locator('#current .tab-watched', { hasText: 'Watching this page' }).waitFor();
  assert.equal(await popup.getByRole('button', { name: 'Watch this page' }).count(), 0);
});

await test('whole page: no change → nothing recorded, no notification', async () => {
  // A page without noise: the learning fetch finds nothing to ignore.
  await hook('fireAlarm', `learn:${ids.docs}`);
  assert.deepEqual(await storage(`noise:${ids.docs}`), { phase: 'confirm', checksLeft: 3, rules: [] });
  assert.equal((await watchById(ids.docs)).noisyLines, 0);
  assert.equal((await watchById(ids.docs)).unseen, 0, 'the learning fetch never notifies');
  const watch = await check(ids.docs);
  assert.equal(watch.status, 'unchanged');
  assert.equal(watch.unseen, 0);
  assert.deepEqual(await storage(`changes:${ids.docs}`), []);
  assert.deepEqual(await notifications(), {});
  assert.equal(await badge(), '');
});

await test('whole page: a change is diffed, notified and counted on the badge', async () => {
  state.docs = ['Page Watch keeps an eye on pages for you.', 'Checks run in the background, a few times an hour at most.', 'Version 1.1 is the current release.', 'New: keyword alerts.'];
  const watch = await check(ids.docs);
  assert.equal(watch.status, 'changed');
  assert.equal(watch.unseen, 1);
  const [change] = await storage(`changes:${ids.docs}`);
  assert.equal(change.summary, '+2 lines, −1 line');
  assert.deepEqual(
    change.lines.filter((line) => line.type !== 'context').map((line) => [line.type, line.text]),
    [
      ['skip', ''],
      ['remove', 'Version 1.0 is the current release.'],
      ['add', 'Version 1.1 is the current release.'],
      ['add', 'New: keyword alerts.'],
    ],
  );
  const shown = await notifications();
  assert.ok(shown[`change:${ids.docs}`], JSON.stringify(shown));
  assert.equal(await badge(), '1');

  const docs = await open(NOTES);
  const popup = await popupFor(docs);
  // A single watch with news opens by itself and shows the diff.
  await popup.locator('.diff-add', { hasText: 'New: keyword alerts.' }).waitFor();
  assert.ok(await popup.locator('.diff-remove', { hasText: 'Version 1.0' }).isVisible());
  assert.match(await popup.locator('.diff-summary').innerText(), /\+2 lines/);
  // A longer region keeps the line diff (the word view is for short ones).
  assert.equal(await popup.locator('.diff-words').count(), 0);
  await waitFor(async () => (await badge()) === '', 'badge cleared after viewing');
  assert.equal((await watchById(ids.docs)).unseen, 0);
  await waitFor(async () => (await notifications())[`change:${ids.docs}`] === undefined, 'notification cleared once seen');
  await shots(popup, 'popup-diff', { popup: true });
});

await test('element picker: hover, keyboard wider/narrower, click, number mode, plain words', async () => {
  const shop = await open(LAMP);
  const popup = await popupFor(shop);
  await popup.getByRole('button', { name: 'Pick an element…' }).click();
  await popup.getByText('Pick the part to watch on the page').waitFor();
  await shop.bringToFront();
  await picker(shop).locator('.pw-bar').waitFor();

  const price = shop.locator('[data-testid="price"]');
  const box = await price.boundingBox();
  await shop.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const highlight = picker(shop).locator('.pw-highlight');
  await highlight.waitFor();
  const lit = await highlight.boundingBox();
  assert.ok(Math.abs(lit.x - (box.x - 2)) < 2 && Math.abs(lit.width - (box.width + 4)) < 2, 'highlight follows the element');
  // Hashed class names are left out of the label.
  assert.match(await picker(shop).locator('.pw-label').innerText(), /^span\s/);
  await shots(shop, 'picker-hover');

  await shop.keyboard.press('ArrowUp');
  assert.match(await picker(shop).locator('.pw-label').innerText(), /^div\.price-box/);
  await shop.keyboard.press('ArrowDown');
  assert.match(await picker(shop).locator('.pw-label').innerText(), /^span/);

  // Clicks don't reach the page while picking.
  await shop.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const card = picker(shop).locator('.pw-card');
  await card.waitFor();
  // What was picked, in plain words; the selector is a detail.
  assert.equal(await card.locator('.pw-picked').innerText(), 'Price: $129.00');
  assert.equal(await card.locator('.pw-preview').count(), 0, 'nothing more to preview for a bare price');
  const details = card.locator('.pw-details');
  assert.equal(await details.evaluate((element) => element.open), false, 'details start closed');
  assert.ok(!(await card.locator('.pw-tag').isVisible()), 'the selector is hidden until asked for');
  // A short numeric region preselects the number mode.
  assert.ok(await card.getByLabel('A number or price changes').isChecked());
  // Wider/narrower buttons from the card, then back.
  await card.getByRole('button', { name: 'Wider' }).click();
  assert.equal(await card.locator('.pw-picked').innerText(), 'Price: $129.00');
  assert.match(await card.locator('.pw-preview').innerText(), /^\$129\.00\s?incl\. VAT$/);
  await card.getByRole('button', { name: 'Narrower' }).click();
  assert.equal(await card.locator('.pw-picked').innerText(), 'Price: $129.00');
  await card.getByLabel('Name').fill('Lamp price');
  await shots(shop, 'picker-card');
  await details.locator('summary').click();
  assert.equal(await card.locator('.pw-tag').innerText(), '[data-testid="price"]');
  assert.match(await details.innerText(), /Element\s+span[\s\S]*Text\s+7 characters · 1 line/);
  await shot(shop, 'picker-card-details');
  await card.getByRole('button', { name: 'Watch this' }).click();
  await card.getByText('Watching “Lamp price”').waitFor();
  await shot(shop, 'picker-done');
  assert.equal(await shop.title(), 'Aurora Desk Lamp – Lumen Store', 'the page never saw the click');

  const watch = (await watches()).find((item) => item.name === 'Lamp price');
  ids.price = watch.id;
  assert.equal(watch.selector, '[data-testid="price"]');
  assert.equal(watch.mode, 'number');
  assert.equal((await storage(`snapshot:${watch.id}`)).text, '$129.00');
  await hook('fireAlarm', `learn:${watch.id}`);
  assert.equal((await storage(`noise:${watch.id}`)).rules.length, 0, 'a stable price is not noise');
  // Number and price watches record their value from the first check on.
  const [first] = await storage(`history:${watch.id}`);
  assert.deepEqual([first.v, first.r], [129, '$129.00']);
  assert.ok(Math.abs(first.t - Date.now()) < 30_000);
  // Weeks of earlier checks, as if the lamp had been watched since late August, so the
  // sparkline and the chart show a realistic history.
  await worker.evaluate(
    ({ id, now }) => {
      const day = 86_400_000;
      const past = [[26, 139], [24, 139], [21, 134], [19, 134], [16, 129], [13, 129], [11, 124], [9, 124], [8, 129], [5, 129], [3, 119], [2, 129]];
      return chrome.storage.local.get(`history:${id}`).then((data) =>
        chrome.storage.local.set({ [`history:${id}`]: [...past.map(([ago, v]) => ({ t: now - ago * day, v, r: `$${v}.00` })), ...data[`history:${id}`]] }),
      );
    },
    { id: watch.id, now: Date.now() },
  );
  await card.getByRole('button', { name: 'Done' }).click();
  await picker(shop).waitFor({ state: 'detached' });
});

await test('element picker: Escape cancels and the page works again', async () => {
  const shop = await open(LAMP);
  const popup = await popupFor(shop);
  await addButtons(popup);
  await popup.getByRole('button', { name: 'Pick an element…' }).click();
  await shop.bringToFront();
  await picker(shop).locator('.pw-bar').waitFor();
  await shop.keyboard.press('ArrowDown'); // keyboard-only start: picks the element in the middle
  await picker(shop).locator('.pw-highlight').waitFor();
  await shop.keyboard.press('Escape');
  await picker(shop).waitFor({ state: 'detached' });
  await shop.getByRole('button', { name: 'Add to cart' }).click();
  assert.equal(await shop.title(), 'clicked');
});

await test('number mode: wording changes are ignored, a price change notifies', async () => {
  state.promo = 'Free shipping this week only!';
  let watch = await check(ids.price);
  assert.equal(watch.status, 'unchanged');
  state.price = '$99.00';
  watch = await check(ids.price);
  assert.equal(watch.status, 'changed');
  assert.equal(watch.lastSummary, 'Price changed: $129.00 → $99.00');
  const shown = await worker.evaluate(() => new Promise((resolve) => chrome.notifications.getAll(resolve)));
  assert.ok(shown[`change:${ids.price}`]);
  assert.equal(await badge(), '1');
  // Every check records the value (the unchanged one only moves the end of its run).
  const history = await storage(`history:${ids.price}`);
  assert.deepEqual(history.slice(-2).map((point) => point.r), ['$129.00', '$99.00']);
});

await test('keyword mode: only the keyword appearing or disappearing counts', async () => {
  const response = await addWatch(LAMP, { name: 'Lamp stock', mode: 'keyword', keyword: 'Sold out' });
  assert.ok(response.ok, JSON.stringify(response));
  ids.stock = response.watch.id;
  state.price = '$89.00';
  let watch = await check(ids.stock);
  assert.equal(watch.status, 'unchanged', 'price change is not a keyword change');
  state.stock = 'Sold out';
  watch = await check(ids.stock);
  assert.equal(watch.status, 'changed');
  assert.equal(watch.lastSummary, '“Sold out” appeared');
  state.stock = 'In stock';
  watch = await check(ids.stock);
  assert.equal(watch.lastSummary, '“Sold out” disappeared');
  assert.equal(watch.unseen, 2);
});

await test('noise filter: what changes on every check is learned and ignored, a real change still notifies', async () => {
  const page = await open(THROW);
  const popup = await popupFor(page);
  await popup.getByRole('button', { name: 'Watch this page' }).click();
  await popup.getByLabel('Name').fill('Nordic throw');
  await popup.getByRole('button', { name: 'Start watching' }).click();
  await popup.locator('.toast', { hasText: 'Watching “Nordic throw”' }).waitFor();
  const watch = (await watches()).find((item) => item.name === 'Nordic throw');
  ids.throw = watch.id;
  assert.equal((await storage(`noise:${watch.id}`)).phase, 'pair');
  assert.ok(await learnAlarm(watch.id), 'second fetch scheduled, the popup did not wait for it');

  // The second fetch: everything that changed in between is noise.
  const fetches = extensionFetches().length;
  await hook('fireAlarm', `learn:${watch.id}`);
  assert.equal(extensionFetches().length, fetches + 1);
  const noise = await storage(`noise:${watch.id}`);
  assert.equal(noise.phase, 'confirm');
  assert.equal(noise.checksLeft, 3);
  assert.deepEqual(noise.rules.map((rule) => rule.kind).sort(), ['block', 'order', 'segment', 'segment', 'segment']);
  let current = await watchById(watch.id);
  // Viewer count, generation time + request id, 2 recommendations, 4 trending items.
  assert.equal(current.noisyLines, 8);
  assert.equal(current.status, 'unchanged');
  assert.equal(current.unseen, 0);
  assert.equal(await learnAlarm(watch.id), undefined, 'learning happens once');

  // Regular checks where only the noise moved: nothing to report.
  for (let i = 0; i < 2; i++) {
    current = await check(watch.id);
    assert.equal(current.status, 'unchanged', `check ${i + 1}: noise only`);
  }
  assert.equal((await notifications())[`change:${watch.id}`], undefined);
  assert.deepEqual(await storage(`changes:${watch.id}`), []);
  const row = popup.locator('.watch', { hasText: 'Nordic throw' });
  await row.locator('.watch-meta', { hasText: 'shop.example.com · Whole page · every 1 h · 8 noisy lines ignored' }).waitFor();

  // A real change gets through, with the noise greyed in the diff.
  state.throwPrice = '$69.00';
  current = await check(watch.id);
  assert.equal(current.status, 'changed');
  assert.equal(current.lastSummary, 'Changed: “$89.00” → “$69.00”');
  assert.ok((await notifications())[`change:${watch.id}`], 'notified');
  const [change] = await storage(`changes:${watch.id}`);
  assert.deepEqual(
    change.lines.filter((line) => (line.type === 'add' || line.type === 'remove') && !line.ignored).map((line) => [line.type, line.text]),
    [
      ['remove', '$89.00'],
      ['add', '$69.00'],
    ],
  );
  assert.ok(change.lines.filter((line) => line.ignored).length >= 6, 'noisy lines kept, marked ignored');
  // Three confirming checks later every rule has fired again: learning is done.
  assert.equal((await storage(`noise:${watch.id}`)).phase, 'done');
  assert.equal((await storage(`noise:${watch.id}`)).rules.length, 5);

  await row.locator('.watch-toggle').click();
  await row.locator('.diff-note', { hasText: 'Ignored: changes on every check' }).first().waitFor();
  assert.ok((await row.locator('.diff-ignored').count()) >= 6);
  assert.match(await row.locator('.diff-remove:not(.diff-ignored)').innerText(), /\$89\.00/);
  const ignoredList = row.locator('.noise-list');
  assert.match(await ignoredList.innerText(), /… people are viewing this right now/);
  assert.match(await ignoredList.innerText(), /Page generated at … · Request ID …/);
  assert.match(await ignoredList.innerText(), /2 lines after “Customers also bought”/);
  assert.match(await ignoredList.innerText(), /Order of 4 items/);
  assert.match(await row.locator('.watch-facts').innerText(), /Noise filter\s+Ignoring 8 lines that change on every check/);
  await popup.locator('.toast').waitFor({ state: 'detached', timeout: 10_000 });
  await shots(popup, 'popup-noise', { popup: true, scroll: row.locator('.section-label', { hasText: 'Ignored' }) });

  // Later, another real change (the list below shows it).
  state.throwStock = 'Only 2 left';
  current = await check(watch.id);
  assert.equal(current.lastSummary, 'Changed: “In stock” → “Only 2 left”');
});

await test('noise filter: the learning fetch really comes a few seconds after adding (real alarm)', async () => {
  await hook('setLearnDelay', 1500);
  try {
    const response = await addWatch(THROW, { name: 'Throw (automatic learning)' });
    assert.ok(response.ok, JSON.stringify(response));
    const id = response.watch.id;
    const alarmSet = await learnAlarm(id);
    const due = alarmSet.scheduledTime - Date.now();
    assert.ok(due > 0 && due < 2000, `learning fetch due in ${due} ms`);
    // Nobody fires it: Chrome does.
    await waitFor(async () => (await storage(`noise:${id}`))?.phase === 'confirm', 'learned by the alarm', 15_000);
    assert.equal((await storage(`noise:${id}`)).rules.length, 5);
    assert.equal((await watchById(id)).noisyLines, 8);
    await deleteWatch(id);
    assert.equal(await storage(`noise:${id}`), undefined, 'deleted with the watch');
  } finally {
    await hook('setLearnDelay', LEARN_OFF);
  }
});

await test('popup: value-first rows, unseen changes highlighted, one line for a watched tab', async () => {
  const shop = await open(LAMP);
  const popup = await popupFor(shop);
  const unseen = popup.locator('.watch.is-unseen');
  const withNews = (await watches()).filter((watch) => watch.unseen > 0).length;
  assert.equal(withNews, 3);
  await waitFor(async () => (await unseen.count()) === withNews, 'watches with news highlighted');
  assert.match(await unseen.first().innerText(), /new/);
  // A price watch leads with its value, where it came from, and a sparkline.
  const lamp = popup.locator('.watch', { hasText: 'Lamp price' });
  assert.equal(await lamp.locator('.watch-value').innerText(), '$99.00');
  assert.equal(await lamp.locator('.watch-delta').innerText(), 'from $129.00');
  assert.equal(await lamp.locator('.watch-delta [aria-label="Down"]').count(), 1);
  assert.ok(await lamp.locator('.watch-delta.is-good').count(), 'a lower price reads as good news');
  assert.equal(await lamp.locator('svg.sparkline path').count(), 1);
  assert.match(await lamp.locator('.watch-meta').innerText(), /^shop\.example\.com · every 1 h · checked /);
  // Other watches lead with what happened; details come second.
  assert.match(await popup.locator('.watch', { hasText: 'Lamp stock' }).locator('.watch-line').innerText(), /“Sold out” disappeared/);
  assert.equal(await popup.locator('.watch', { hasText: 'Lamp stock' }).locator('.watch-meta').innerText(), 'shop.example.com · Whole page · every 1 h');
  assert.ok(await popup.getByRole('button', { name: 'Mark all seen' }).isVisible());
  // This tab is already watched twice: one line, no big buttons.
  assert.match(await popup.locator('#current').innerText(), /^Watching this page · 2 watches\s+Add another$/);
  assert.equal(await popup.getByRole('button', { name: 'Watch this page' }).count(), 0);
  assert.match(await popup.locator('#watches .section-label').first().innerText(), /^Watching · 4$/i, 'no limit shown during early access');
  await shots(popup, 'popup-list', { popup: true });
  // "Add another" brings the two buttons back.
  await popup.getByRole('button', { name: 'Add another' }).click();
  await popup.getByRole('button', { name: 'Watch this page' }).waitFor();
  assert.ok(await popup.getByRole('button', { name: 'Pick an element…' }).isVisible());
  assert.match(await popup.locator('#current').innerText(), /Watching this page · 2 watches/);
  // History: the latest change is shown, older ones can be picked.
  await popup.locator('.watch', { hasText: 'Lamp stock' }).locator('.watch-toggle').click();
  await popup.locator('.change-list .list-group-item').nth(1).click();
  await popup.locator('.diff-summary', { hasText: 'appeared' }).waitFor();
  await popup.getByRole('button', { name: 'Mark all seen' }).click();
  await waitFor(async () => (await badge()) === '', 'badge cleared');
});

await test('noise filter: "Watch this line again" makes a line count again', async () => {
  const page = await open(THROW);
  const popup = await popupFor(page);
  const row = popup.locator('.watch', { hasText: 'Nordic throw' });
  await row.locator('.watch-toggle').click();
  await row.locator('.diff-note', { hasText: 'Ignored: changes on every check' }).first().waitFor();
  // From the diff: the viewer count's note has the button.
  const note = row.locator('.diff-note', { hasText: 'Watch this line again' }).first();
  await note.waitFor();
  // From the list of ignored lines.
  await row.locator('.noise-item', { hasText: 'people are viewing' }).getByRole('button', { name: /Watch again/ }).click();
  await popup.locator('.toast', { hasText: 'Watching it again' }).waitFor();
  await waitFor(async () => (await storage(`noise:${ids.throw}`)).rules.length === 4, 'rule removed');
  assert.equal((await watchById(ids.throw)).noisyLines, 7);
  await row.locator('.noise-item', { hasText: 'people are viewing' }).waitFor({ state: 'detached' });
  // Its note in the stored diff now says it's watched again.
  await row.locator('.diff-note', { hasText: 'Watched again' }).first().waitFor();
  const current = await check(ids.throw);
  assert.equal(current.status, 'changed');
  assert.match(current.lastSummary, /^Changed: “\d+ people are viewing this right now” → “\d+ people are viewing this right now”$/);
  // "Watch these lines again" from a diff note works the same for blocks.
  const blockNote = row.locator('.diff-note', { hasText: 'Watch these lines again' }).first();
  await blockNote.waitFor();
  const before = (await storage(`noise:${ids.throw}`)).rules.length;
  await blockNote.getByRole('button').click();
  await waitFor(async () => (await storage(`noise:${ids.throw}`)).rules.length === before - 1, 'block rule removed from the diff');
  await markAllSeen();
});

await test('notification click opens the page and marks the change seen', async () => {
  state.price = '$79.00';
  await check(ids.price);
  assert.equal((await watchById(ids.price)).unseen, 1);
  const opened = context.waitForEvent('page');
  await hook('clickNotification', `change:${ids.price}`);
  const tab = await opened;
  openPages.add(tab);
  await tab.waitForLoadState();
  assert.equal(tab.url(), LAMP);
  assert.equal((await watchById(ids.price)).unseen, 0);
  assert.equal(await badge(), '');
  assert.equal((await notifications())[`change:${ids.price}`], undefined);
});

await test('price history: large before → after, a chart with high, low and dates, keyboard readout', async () => {
  const shop = await open(LAMP);
  const popup = await popupFor(shop);
  const lamp = popup.locator('.watch', { hasText: 'Lamp price' });
  assert.equal(await lamp.locator('.watch-value').innerText(), '$79.00');
  assert.equal(await lamp.locator('.watch-delta').innerText(), 'from $99.00');
  await lamp.locator('.watch-toggle').click();
  // A short region: the change as words, not a line diff.
  const words = lamp.locator('.diff-words');
  await words.waitFor();
  assert.equal(await words.locator('del').innerText(), '$99.00');
  assert.equal(await words.locator('ins').innerText(), '$79.00');
  assert.equal(await lamp.locator('.diff-lines').count(), 0);
  // The chart: all of it during early access (Pro), direct labels on the extremes.
  const chart = lamp.locator('.history-chart');
  assert.match(await lamp.locator('.history .section-label').innerText(), /^Price history · since /i);
  const labels = await chart.locator('text').allTextContents();
  assert.ok(labels.includes('High $139.00'), labels.join(' | '));
  assert.ok(labels.includes('Low $79.00'), labels.join(' | '));
  assert.ok(labels.includes('Today'), labels.join(' | '));
  assert.equal(await lamp.locator('.pro-hint').count(), 0);
  assert.match(await chart.locator('svg').getAttribute('aria-label'), /lowest \$79\.00, highest \$139\.00, now \$79\.00/);
  // Keyboard: the crosshair steps through the checks and reads them out.
  await chart.locator('svg').focus();
  await popup.keyboard.press('Home');
  await chart.locator('.history-tip', { hasText: '$139.00' }).waitFor();
  await popup.keyboard.press('ArrowRight');
  assert.match(await chart.locator('.history-tip').innerText(), /^\$139\.00/);
  await popup.keyboard.press('End');
  await chart.locator('.history-tip', { hasText: '$79.00' }).waitFor();
  await popup.keyboard.press('Escape');
  await chart.locator('.history-tip').waitFor({ state: 'hidden' });
  await chart.locator('svg').blur();
  // Pointer: the crosshair follows the mouse.
  const box = await chart.locator('svg').boundingBox();
  await popup.mouse.move(box.x + 12, box.y + box.height / 2);
  await chart.locator('.history-tip', { hasText: '$139.00' }).waitFor();
  await popup.mouse.move(box.x + box.width + 50, box.y - 50);
  await chart.locator('.history-tip').waitFor({ state: 'hidden' });
  await shots(popup, 'popup-price', { popup: true, scroll: lamp });
});

await test('price rule: added from the popup, notifies only when the price drops below the target', async () => {
  state.price = '$129.00';
  const shop = await open(LAMP);
  const popup = await popupFor(shop);
  await addButtons(popup);
  await popup.getByRole('button', { name: 'Watch this page' }).click();
  await popup.getByLabel('Name').fill('Lamp under $100');
  const priceRule = popup.getByLabel('The price drops below');
  assert.match(await popup.locator('label', { has: popup.locator('.pro-badge') }).first().innerText(), /PRO/);
  await priceRule.check();
  const target = popup.getByRole('textbox', { name: 'Target price' });
  await target.waitFor();
  await popup.getByRole('button', { name: 'Start watching' }).click();
  await popup.locator('.alert-danger', { hasText: 'Enter the price to watch for' }).waitFor();
  await target.fill('$100');
  await popup.locator('.alert-danger').waitFor({ state: 'detached' });
  await shots(popup, 'popup-add-price', { popup: true });
  await popup.getByRole('button', { name: 'Start watching' }).click();
  await popup.locator('.toast', { hasText: "Now $129.00. You'll be notified when it drops below $100." }).waitFor();
  const watch = (await watches()).find((item) => item.name === 'Lamp under $100');
  ids.below = watch.id;
  assert.equal(watch.mode, 'below');
  assert.equal(watch.target, '$100');
  const row = popup.locator('.watch', { hasText: 'Lamp under $100' });
  await row.locator('.watch-toggle').click();
  await row.getByText('The price drops below $100').waitFor();

  await worker.evaluate((id) => chrome.notifications.clear(`change:${id}`), ids.below);
  state.price = '$109.00';
  assert.equal((await check(ids.below)).status, 'unchanged', 'still above the target');
  state.price = '$95.00';
  let checked = await check(ids.below);
  assert.equal(checked.status, 'changed');
  assert.equal(checked.lastSummary, 'Price dropped below $100: $109.00 → $95.00');
  assert.ok((await notifications())[`change:${ids.below}`], 'notified');
  state.price = '$90.00';
  checked = await check(ids.below);
  assert.equal(checked.status, 'unchanged', 'already below: no second notification');
  assert.equal(checked.unseen, 1);

  // Targets are validated, and currency-aware: this page has no prices in euros.
  const invalid = await addWatch(LAMP, { name: 'Bad target', mode: 'below', target: 'cheap' });
  assert.equal(invalid.ok, false);
  assert.match(invalid.message, /Enter the price to watch for/);
  const euros = await addWatch(LAMP, { name: 'Euro target', mode: 'below', target: '100 €' });
  assert.equal(euros.ok, false);
  assert.match(euros.message, /couldn't find a price in that currency/);
  const already = await addWatch(LAMP, { name: 'Already below', mode: 'below', target: '$1,000', selectors: ['[data-testid="price"]'] });
  assert.ok(already.ok, JSON.stringify(already));
  assert.match(already.note, /already below \$1,000 \(\$90\.00\)/);
  await deleteWatch(already.watch.id);
  const helper = await extensionPage('options.html');
  await helper.evaluate(() => chrome.runtime.sendMessage({ type: 'pw/mark-seen', id: null }));
  await waitFor(async () => (await watchById(ids.below)).unseen === 0, 'marked seen');
  state.price = '$79.00'; // Where the number-mode watch last saw it.
});

await test('lowest in 30 days (Pro): notifies on a new low only', async () => {
  const refused = await addWatch(STATUS_PAGE, { name: 'No numbers here', mode: 'lowest' });
  assert.equal(refused.ok, false);
  assert.match(refused.message, /couldn't find a price or number in this page/);

  const response = await addWatch(LAMP, { name: 'Lamp 30-day low', mode: 'lowest', selectors: ['[data-testid="price"]'] });
  assert.ok(response.ok, JSON.stringify(response));
  assert.equal(response.note, "Now $79.00. You'll be notified when it's the lowest in 30 days.");
  const id = response.watch.id;
  // Watched for five weeks already: the 30-day low so far is $75.00 (older, lower prices don't count).
  await worker.evaluate(
    ({ id, now }) => {
      const day = 86_400_000;
      const past = [[35, 59], [28, 89], [20, 75], [12, 84], [6, 79]];
      return chrome.storage.local.set({ [`history:${id}`]: [...past.map(([ago, v]) => ({ t: now - ago * day, v, r: `$${v}.00` })), { t: now, v: 79, r: '$79.00' }] });
    },
    { id, now: Date.now() },
  );
  state.price = '$77.00';
  let watch = await check(id);
  assert.equal(watch.status, 'unchanged', 'lower than before, but not the lowest in 30 days');
  state.price = '$72.00';
  watch = await check(id);
  assert.equal(watch.status, 'changed');
  assert.equal(watch.lastSummary, 'Lowest in 30 days: $72.00 (was $75.00)');
  assert.ok((await notifications())[`change:${id}`], 'notified');
  state.price = '$74.00';
  assert.equal((await check(id)).status, 'unchanged', 'up again: quiet');
  assert.deepEqual((await storage(`history:${id}`)).slice(-3).map((point) => point.v), [77, 72, 74]);
  await deleteWatch(id);
  await worker.evaluate((id) => chrome.notifications.clear(`change:${id}`), id);
  state.price = '$79.00';
});

await test('sound: off by default; a chime with change notifications when on, per watch', async () => {
  assert.equal((await storage('settings'))?.sound ?? false, false);
  state.price = '$69.00';
  assert.equal((await check(ids.price)).status, 'changed');
  assert.deepEqual(await hook('chimes'), [], 'no sound by default');

  const options = await extensionPage('options.html');
  const soundSwitch = options.getByLabel('Play a sound with change notifications');
  assert.equal(await soundSwitch.isChecked(), false);
  await soundSwitch.check();
  await waitFor(async () => (await storage('settings'))?.sound === true, 'sound on');
  state.price = '$64.00';
  await check(ids.price);
  const chimes = await hook('chimes');
  assert.equal(chimes.length, 1);
  assert.equal(chimes[0].watchId, ids.price);
  // Synthesized in the offscreen document (reason AUDIO_PLAYBACK), which really played it.
  assert.deepEqual(chimes[0].response, { ok: true, state: 'running' });

  // Each watch can be muted from the popup while sounds are on.
  const popup = await popupFor(await open(LAMP));
  const row = popup.locator('.watch', { hasText: 'Lamp price' });
  if ((await row.locator('.watch-toggle').getAttribute('aria-expanded')) !== 'true') await row.locator('.watch-toggle').click();
  const mute = row.getByRole('button', { name: 'Sound on for this watch' });
  assert.equal(await mute.getAttribute('aria-pressed'), 'true');
  await mute.click();
  await popup.locator('.toast', { hasText: 'No sound for “Lamp price”' }).waitFor();
  await waitFor(async () => (await watchById(ids.price)).sound === false, 'muted');
  state.price = '$59.00';
  assert.equal((await check(ids.price)).status, 'changed');
  assert.equal((await hook('chimes')).length, 1, 'muted watch: no chime');
  await row.getByRole('button', { name: 'Sound off for this watch' }).click();
  await waitFor(async () => (await watchById(ids.price)).sound === true, 'unmuted');

  // The settings page can play it too (a user gesture there, so it plays in the page).
  await options.getByRole('button', { name: 'Play a test sound' }).click();
  await options.getByRole('button', { name: 'Play a test sound' }).waitFor();
  assert.equal(await options.locator('#save-status.text-danger').count(), 0);
  await soundSwitch.uncheck();
  await waitFor(async () => (await storage('settings'))?.sound === false, 'sound off again');
  // Sounds off: the popup has no per-watch switch.
  await row.getByRole('button', { name: /Sound (on|off) for this watch/ }).waitFor({ state: 'detached' });
  state.price = '$79.00';
  await check(ids.price);
  assert.equal((await hook('chimes')).length, 1, 'sounds off: no chime');
  await markAllSeen();
});

await test('Pro: checks every minute', async () => {
  const docs = await open(NOTES);
  const popup = await popupFor(docs);
  await addButtons(popup);
  await popup.getByRole('button', { name: 'Watch this page' }).click();
  const interval = popup.getByLabel('Check every');
  assert.equal(await popup.locator('option[value="1"]').innerText(), '1 minute');
  await interval.selectOption('1');
  await popup.getByLabel('Name').fill('Release notes (every minute)');
  await popup.getByRole('button', { name: 'Start watching' }).click();
  await popup.locator('.toast', { hasText: 'Watching “Release notes (every minute)”' }).waitFor();
  const watch = (await watches()).find((item) => item.name === 'Release notes (every minute)');
  assert.equal(watch.intervalMinutes, 1);
  const seconds = ((await alarm(watch.id)).scheduledTime - Date.now()) / 1000;
  assert.ok(seconds > 50 && seconds < 67, `next check in ${seconds} s`);
  // After a check the next one is a minute (±10%) away again.
  const checked = await check(watch.id);
  const next = (checked.nextCheckAt - Date.now()) / 1000;
  assert.ok(next > 50 && next < 67, `then in ${next} s`);
  await popup.locator('.watch', { hasText: 'Release notes (every minute)' }).locator('.watch-meta', { hasText: 'every 1 min' }).waitFor();
  await deleteWatch(watch.id);
});

await test('errors: HTTP 500 shows in the popup, backs off, recovers', async () => {
  const response = await addWatch(STATUS_PAGE, { name: 'Status page', intervalMinutes: 5 });
  assert.ok(response.ok);
  ids.flaky = response.watch.id;
  await hook('fireAlarm', `learn:${ids.flaky}`);
  state.flakyStatus = 500;
  let watch = await check(ids.flaky);
  assert.equal(watch.status, 'error');
  assert.equal(watch.error.code, 'http');
  assert.equal(watch.error.status, 500);
  const first = (watch.nextCheckAt - Date.now()) / 60_000;
  watch = await check(ids.flaky);
  const second = (watch.nextCheckAt - Date.now()) / 60_000;
  assert.ok(first > 4 && first < 6 && second > 8.5 && second < 11.5, `backoff ${first} → ${second} min`);
  assert.equal(watch.errorCount, 2);
  assert.equal((await notifications())[`error:${ids.flaky}`], undefined, 'transient errors are not notified at once');
  watch = await check(ids.flaky);
  assert.ok((await notifications())[`error:${ids.flaky}`], 'notified after three failures in a row');

  const page = await open(NOTES);
  const popup = await popupFor(page);
  const row = popup.locator('.watch', { hasText: 'Status page' });
  assert.match(await row.innerText(), /HTTP 500/);
  assert.equal(await row.locator('.watch-meta').innerText(), 'status.example.com · Whole page · every 5 min');
  await row.locator('.watch-toggle').click();
  await row.locator('.alert-warning', { hasText: 'server error (HTTP 500)' }).waitFor();
  assert.match(await row.locator('.alert-warning').innerText(), /Failed 3 times in a row/);
  await shots(popup, 'popup-error', { popup: true });

  state.flakyStatus = 200;
  watch = await check(ids.flaky);
  assert.equal(watch.status, 'unchanged');
  assert.equal(watch.error, null);
  assert.equal(watch.errorCount, 0);
  await row.locator('.alert').waitFor({ state: 'detached' });
});

await test('errors: the picked element disappearing is reported right away', async () => {
  state.showPrice = false;
  const watch = await check(ids.price);
  assert.equal(watch.error.code, 'selector');
  assert.match(watch.error.message, /isn't there anymore/);
  assert.ok((await notifications())[`error:${ids.price}`], 'persistent errors notify immediately');
  state.showPrice = true;
  assert.equal((await check(ids.price)).status, 'unchanged');
});

await test('errors: timeouts, non-HTML responses and pages that collapse', async () => {
  const hang = await addWatch(site(SHOP, '/hang'));
  assert.equal(hang.ok, false);
  assert.equal(hang.code, 'timeout');
  const json = await addWatch(site(SHOP, '/api/price'));
  assert.equal(json.ok, false);
  assert.equal(json.code, 'not-html');
  assert.match(json.message, /application\/json/);
  const refused = await addWatch(site(DOWN, '/'));
  assert.equal(refused.code, 'network');
  assert.match(refused.message, /Couldn't reach the site/);
  const missing = await addWatch(site(DOCS, '/nope'));
  assert.equal(missing.code, 'http');
  assert.match(missing.message, /not found \(HTTP 404\)/i);
  assert.ok(!(await watches()).some((watch) => watch.url.endsWith('/hang') || watch.url.endsWith('/api/price')), 'nothing saved');
});

await test('JavaScript-rendered pages are refused with a clear message (page and element)', async () => {
  const spa = await open(DASHBOARD);
  const popup = await popupFor(spa);
  await popup.getByRole('button', { name: 'Watch this page' }).click();
  // The popup reads the live page text to compare it with the fetched HTML (e2e builds mark when it's in).
  await popup.locator('html[data-live-text="read"]').waitFor({ state: 'attached' });
  await popup.getByRole('button', { name: 'Start watching' }).click();
  const alert = popup.locator('.alert-danger', { hasText: 'This page renders with JavaScript' });
  await alert.waitFor();
  await shots(popup, 'popup-js-rendered', { popup: true });
  assert.ok(!(await watches()).some((watch) => watch.url === DASHBOARD));

  await popup.getByRole('button', { name: 'Cancel' }).click();
  await popup.getByRole('button', { name: 'Pick an element…' }).click();
  await spa.bringToFront();
  await picker(spa).locator('.pw-bar').waitFor();
  const balance = await spa.locator('#balance').boundingBox();
  await spa.mouse.move(balance.x + 10, balance.y + 5);
  await spa.mouse.click(balance.x + 10, balance.y + 5);
  const card = picker(spa).locator('.pw-card');
  await card.getByRole('button', { name: 'Watch this' }).click();
  await card.locator('.alert-danger', { hasText: "isn't in the page's HTML" }).waitFor();
  await shot(spa, 'picker-js-rendered');
  assert.ok(!(await watches()).some((watch) => watch.url === DASHBOARD));
});

await test('redirects are followed and legacy encodings decoded', async () => {
  const redirected = await addWatch(site(DOCS, '/latest'), { name: 'Redirected' });
  assert.ok(redirected.ok);
  assert.match((await storage(`snapshot:${redirected.watch.id}`)).text, /Release notes/);
  const cyrillic = await addWatch(NEWS_PAGE);
  assert.ok(cyrillic.ok);
  assert.equal(cyrillic.watch.name, 'Новости');
  assert.equal((await storage(`snapshot:${cyrillic.watch.id}`)).text, 'Новости\nПривет, мир! Цена 250 грн');
  ids.redirect = redirected.watch.id;
  ids.cyrillic = cyrillic.watch.id;
});

await test('site access: a missing permission is shown with a way to grant it again', async () => {
  // A watch on a site this build has no access to (as if access had been revoked).
  const url = site(PRIVATE, '/release-notes');
  await worker.evaluate(async ({ url }) => {
    const { watches = [] } = await chrome.storage.local.get('watches');
    const watch = {
      id: 'revoked', url, name: 'Revoked site', selector: null, intervalMinutes: 60, mode: 'text', keyword: '', paused: false,
      createdAt: Date.now(), lastCheckedAt: null, lastChangedAt: null, nextCheckAt: null, status: 'pending', error: null,
      errorCount: 0, errorNotified: false, unseen: 0, lastSummary: null,
    };
    await chrome.storage.local.set({ watches: [watch, ...watches], 'snapshot:revoked': { text: 'x', at: 0, truncated: false } });
  }, { url });
  const before = requests.length;
  const watch = await check('revoked');
  assert.equal(watch.error.code, 'permission');
  assert.equal(requests.length, before, 'no request without access');
  const page = await open(NOTES);
  const popup = await popupFor(page);
  const row = popup.locator('.watch', { hasText: 'Revoked site' });
  assert.match(await row.innerText(), /Needs site access/);
  await row.locator('.watch-toggle').click();
  await row.getByRole('button', { name: /Allow access to private\.example\.net/ }).waitFor();
  // Access removed from Chrome's UI is reflected right away.
  await worker.evaluate(() => chrome.storage.local.set({ probe: 1 }));
  await hook('permissionsRemoved', { origins: [site(DOCS, '/*')] });
  assert.equal((await watchById(ids.docs)).error, null, 'still granted in this build, so nothing is flagged');
  await hook('permissionsRemoved', { origins: [site(PRIVATE, '/*')] });
  assert.equal((await watchById('revoked')).error.code, 'permission');
  const response = await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'pw/delete', id: 'revoked' }));
  assert.ok(response.ok);
});

await test('pause, resume, edit and delete from the popup', async () => {
  const page = await open(NOTES);
  const popup = await popupFor(page);
  const row = popup.locator('.watch', { hasText: /^Release notes/ }).filter({ hasNotText: 'every minute' }).first();
  await row.locator('.watch-toggle').click();

  await row.getByRole('button', { name: 'Pause' }).click();
  await waitFor(async () => (await watchById(ids.docs)).paused, 'paused');
  assert.equal(await alarm(ids.docs), undefined, 'no alarm while paused');
  const fetches = extensionFetches().length;
  await hook('fireAlarm', `watch:${ids.docs}`);
  assert.equal(extensionFetches().length, fetches, 'a stale alarm does not check a paused watch');
  await row.getByText('Paused', { exact: true }).first().waitFor();

  await row.getByRole('button', { name: 'Resume' }).click();
  await waitFor(async () => !(await watchById(ids.docs)).paused && (await alarm(ids.docs)), 'resumed with an alarm');
  await waitFor(() => extensionFetches().length > fetches, 'resuming checks right away');

  await row.getByRole('button', { name: 'Edit' }).click();
  await row.getByLabel('Name').fill('Docs release notes');
  await row.getByLabel('Check every').selectOption('360');
  await row.getByLabel('A keyword appears or disappears').check();
  await row.getByRole('button', { name: 'Save' }).click();
  await row.locator('.alert-danger', { hasText: 'Enter the keyword' }).waitFor();
  await row.getByRole('textbox', { name: 'Keyword' }).fill('Version 2');
  await shot(popup, 'popup-edit', { popup: true });
  await row.getByRole('button', { name: 'Save' }).click();
  await popup.locator('.toast', { hasText: 'Saved' }).waitFor();
  const edited = await watchById(ids.docs);
  assert.equal(edited.name, 'Docs release notes');
  assert.equal(edited.intervalMinutes, 360);
  assert.equal(edited.mode, 'keyword');
  assert.equal(edited.keyword, 'Version 2');
  const minutes = ((await alarm(ids.docs)).scheduledTime - Date.now()) / 60_000;
  assert.ok(minutes > 320 && minutes < 400, `rescheduled to ${minutes} min`);

  const renamed = popup.locator('.watch', { hasText: 'Docs release notes' });
  await renamed.getByRole('button', { name: 'Delete' }).click();
  await renamed.getByRole('button', { name: 'Confirm delete' }).click();
  await popup.locator('.toast', { hasText: 'Deleted' }).waitFor();
  assert.equal(await watchById(ids.docs), undefined);
  assert.equal(await alarm(ids.docs), undefined);
  assert.equal(await storage(`snapshot:${ids.docs}`), undefined);
  assert.equal(await storage(`changes:${ids.docs}`), undefined);
});

await test('scheduling: alarms drive checks, at most two fetches run at once', async () => {
  const created = [];
  for (let i = 1; i <= 5; i++) {
    state.slowMs = 50;
    const response = await addWatch(site(DOCS, `/slow/${i}`), { name: `Slow ${i}`, intervalMinutes: 5 });
    assert.ok(response.ok);
    created.push(response.watch.id);
  }
  state.slowMs = 400;
  slowPeak = 0;
  await Promise.all(created.map((id) => hook('fireAlarm', `watch:${id}`)));
  assert.equal(slowPeak, 2, `peak concurrent fetches: ${slowPeak}`);
  for (const id of created) {
    const watch = await watchById(id);
    assert.ok(Date.now() - watch.lastCheckedAt < 10_000, 'checked by its alarm');
    assert.ok(await alarm(id), 'next alarm set');
  }
  // Checking a watch twice at once runs it once.
  const before = requests.filter((request) => request.path === '/slow/1').length;
  await Promise.all([check(created[0]), check(created[0])]);
  assert.equal(requests.filter((request) => request.path === '/slow/1').length, before + 1);
  // The noise filter's learning fetch has its own queue key: a check in flight doesn't swallow it.
  await worker.evaluate((id) => chrome.storage.local.set({ [`noise:${id}`]: { phase: 'pair', checksLeft: 0, rules: [] } }), created[1]);
  const slowTwo = requests.filter((request) => request.path === '/slow/2').length;
  await Promise.all([check(created[1]), hook('fireAlarm', `learn:${created[1]}`)]);
  assert.equal(requests.filter((request) => request.path === '/slow/2').length, slowTwo + 2);
  assert.equal((await storage(`noise:${created[1]}`)).phase, 'confirm');
  const helper = await extensionPage('options.html');
  for (const id of created) assert.ok((await helper.evaluate((id) => chrome.runtime.sendMessage({ type: 'pw/delete', id }), id)).ok);
  assert.ok(!(await watches()).some((watch) => watch.name.startsWith('Slow')));
});

await test('options: settings persist, site access and privacy are explained', async () => {
  const page = await extensionPage('options.html');
  await page.setViewportSize({ width: 900, height: 1000 });
  await page.getByLabel('Notify me when a watched page changes').uncheck();
  await page.locator('#save-status', { hasText: 'Saved' }).waitFor();
  await waitFor(async () => (await storage('settings'))?.notifyChanges === false, 'notifications turned off');
  await page.getByLabel('Check every').selectOption('30');
  await waitFor(async () => (await storage('settings'))?.defaultIntervalMinutes === 30, 'default interval saved');
  assert.deepEqual(await storage('settings'), {
    notifyChanges: false,
    notifyErrors: true,
    defaultIntervalMinutes: 30,
    quietHours: { enabled: false, start: 22 * 60, end: 7 * 60 },
    sound: false,
  });
  assert.match(await page.locator('#privacy-statement').innerText(), /only network requests Page Watch makes are to the pages you chose to watch/);
  assert.match(await page.locator('#sites').innerText(), /http:\/\/shop\.example\.com\s+\d+ watch/);
  // About Pro: features, price, and a disabled "Get Pro" during early access.
  const about = page.locator('#about-pro');
  assert.match(await about.innerText(), /Early access: every Pro feature is on for you, free\./);
  assert.match(await about.innerText(), /\$3\.99/);
  assert.match(
    await about.innerText(),
    /Unlimited watches[\s\S]*every 1, 5, 15 or 30 minutes[\s\S]*keyword rules[\s\S]*drops below[\s\S]*Lowest in 30 days[\s\S]*Full price history[\s\S]*Quiet hours/,
  );
  assert.ok(await about.getByRole('button', { name: 'Get Pro' }).isDisabled());
  assert.match(await about.innerText(), /Free during early access/);
  assert.equal(await page.locator('#about-pro .pro-badge, #quiet-card .pro-badge').count(), 2);
  assert.ok(await page.getByLabel('Hold notifications during quiet hours').isEnabled());
  assert.ok(await page.locator('#default-interval option[value="5"]').isEnabled());
  assert.ok(await page.locator('#default-interval option[value="1"]').isEnabled());
  await shots(page, 'options', { fullPage: true });

  // Change notifications off: the badge still counts, no notification is shown.
  await worker.evaluate((id) => chrome.notifications.clear(`change:${id}`), ids.price);
  const unseenBefore = Number((await badge()) || 0);
  state.price = '$69.00';
  await check(ids.price);
  assert.equal((await notifications())[`change:${ids.price}`], undefined);
  assert.equal(await badge(), String(unseenBefore + 1));
  await page.getByLabel('Notify me when a watched page changes').check();
  await waitFor(async () => (await storage('settings')).notifyChanges === true, 'notifications re-enabled');

  // The new default interval is preselected in the popup.
  const docs = await open(NOTES);
  const popup = await popupFor(docs);
  await addButtons(popup);
  await popup.getByRole('button', { name: 'Watch this page' }).click();
  assert.equal(await popup.getByLabel('Check every').inputValue(), '30');
});

await test('export and import: a JSON file, validated, with a merge summary', async () => {
  const page = await extensionPage('options.html');
  await page.setViewportSize({ width: 900, height: 1000 });
  const stored = await watches();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export watches' }).click();
  const file = await download;
  assert.match(file.suggestedFilename(), /^page-watch-\d{4}-\d{2}-\d{2}\.json$/);
  const exported = JSON.parse(await readFile(await file.path(), 'utf8'));
  assert.equal(exported.format, 'page-watch');
  assert.equal(exported.version, 1);
  assert.equal(exported.watches.length, stored.length);
  assert.deepEqual(exported.watches.map((watch) => watch.url).sort(), stored.map((watch) => watch.url).sort());
  const lamp = exported.watches.find((watch) => watch.name === 'Lamp price');
  assert.deepEqual(lamp, { url: LAMP, name: 'Lamp price', selector: '[data-testid="price"]', intervalMinutes: 60, mode: 'number', keyword: '', target: '', paused: false, sound: true });
  assert.ok(!JSON.stringify(exported).includes('Aurora Desk Lamp'), 'settings only: no page text');
  await page.locator('#export-status', { hasText: `Exported ${stored.length} watches to ${file.suggestedFilename()}.` }).waitFor();

  // A file that isn't an export is refused with a reason.
  await page.locator('#import-file').setInputFiles({ name: 'notes.json', mimeType: 'application/json', buffer: Buffer.from('{"notes": []}') });
  await page.locator('#import-result .alert-danger', { hasText: "This file isn't a Page Watch export." }).waitFor();

  // One new watch, one already watched, one broken entry.
  const entries = [
    lamp,
    { url: CHANGELOG, name: 'Changelog', selector: null, intervalMinutes: 360, mode: 'keyword', keyword: 'Version 2', target: '', paused: false, sound: true },
    { url: 'ftp://files.example.com/prices.txt', name: 'Old price list' },
  ];
  await page.locator('#import-file').setInputFiles({
    name: 'watches-from-laptop.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ format: 'page-watch', version: 1, exportedAt: new Date().toISOString(), watches: entries })),
  });
  const preview = page.locator('.import-preview');
  await preview.waitFor();
  const text = await preview.innerText();
  assert.match(text, /watches-from-laptop\.json: 3 entries/);
  assert.match(text, /1 new watch on docs\.example\.org/);
  assert.match(text, /1 watch you already have \(left out\)/);
  assert.match(text, /1 entry that isn't a valid watch \(left out\):\s+Entry 3: the address is not a web page \(http or https\)/);
  assert.equal(await watches().then((all) => all.length), stored.length, 'nothing is added before confirming');
  await page.locator('#transfer-card').scrollIntoViewIfNeeded();
  await shots(page, 'options-import', { element: page.locator('#transfer-card') });
  await page.getByRole('button', { name: 'Import 1 watch' }).click();
  await page.locator('#import-result .alert-success', { hasText: "Added 1 watch. 1 was already watched. 1 entry wasn't a valid watch." }).waitFor();
  const imported = (await watches()).find((watch) => watch.url === CHANGELOG);
  assert.ok(imported, 'imported');
  assert.deepEqual([imported.name, imported.mode, imported.keyword, imported.intervalMinutes, imported.selector], ['Changelog', 'keyword', 'Version 2', 360, null]);
  // Its first check takes the starting point, then the noise filter's learning fetch is scheduled.
  await waitFor(async () => (await watchById(imported.id))?.status === 'unchanged', 'first check of the imported watch');
  assert.match((await storage(`snapshot:${imported.id}`)).text, /^Home · Docs · Blog\nChangelog/);
  await waitFor(async () => Boolean(await learnAlarm(imported.id)), 'learning fetch scheduled after the first check');
  assert.ok(await alarm(imported.id), 'scheduled');
  // Importing the same file again adds nothing.
  await page.locator('#import-file').setInputFiles({
    name: 'watches-from-laptop.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ format: 'page-watch', version: 1, watches: entries })),
  });
  await page.locator('.import-preview', { hasText: 'Nothing new to import.' }).waitFor();
  await deleteWatch(imported.id);
});

await test('quiet hours: notifications are held while checks run, then summarized', async () => {
  const pad = (n) => String(n).padStart(2, '0');
  const clock = (date) => `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const page = await extensionPage('options.html');
  await page.setViewportSize({ width: 900, height: 1000 });
  const start = new Date(Date.now() - 60 * 60_000);
  const end = new Date(Date.now() + 60 * 60_000);
  assert.ok(await page.locator('#quiet-start').isDisabled(), 'times are off until quiet hours are on');
  await page.getByLabel('Hold notifications during quiet hours').check();
  await page.locator('#quiet-start').fill(clock(start));
  await page.locator('#quiet-end').fill(clock(end));
  await waitFor(async () => {
    const quiet = (await storage('settings'))?.quietHours;
    return quiet?.enabled && quiet.start === start.getHours() * 60 + start.getMinutes() && quiet.end === end.getHours() * 60 + end.getMinutes();
  }, 'quiet hours saved');
  await shot(page, 'options-quiet');

  await worker.evaluate(() => chrome.notifications.getAll().then((all) => Promise.all(Object.keys(all).map((id) => chrome.notifications.clear(id)))));
  const badgeBefore = Number((await badge()) || 0);
  state.price = '$49.00';
  let watch = await check(ids.price);
  assert.equal(watch.status, 'changed', 'checks keep running');
  assert.equal(await badge(), String(badgeBefore + 1), 'the badge keeps counting');
  assert.deepEqual(await notifications(), {}, 'no notification during quiet hours');
  const held = await storage('heldNotifications');
  assert.equal(held.length, 1);
  assert.equal(held[0].watchId, ids.price);
  const quietAlarm = await worker.evaluate(() => chrome.alarms.get('quiet-end'));
  const minutes = (quietAlarm.scheduledTime - Date.now()) / 60_000;
  assert.ok(minutes > 58 && minutes < 61, `summary due in ${minutes} min`);

  // The alarm firing while it's still quiet delivers nothing.
  state.stock = 'Sold out';
  await check(ids.stock);
  await hook('fireAlarm', 'quiet-end');
  assert.deepEqual(await notifications(), {});
  assert.equal((await storage('heldNotifications')).length, 2);

  // Quiet hours end (here: turned off): one summary.
  await page.getByLabel('Hold notifications during quiet hours').uncheck();
  await waitFor(async () => (await notifications())['quiet-summary'], 'summary notification');
  assert.equal(await storage('heldNotifications'), undefined);
  assert.equal(await worker.evaluate(() => chrome.alarms.get('quiet-end')), undefined);
  assert.equal((await notifications())[`change:${ids.price}`], undefined, 'no separate notification afterwards');
  state.stock = 'In stock';
  await check(ids.stock);
  await hook('clickNotification', 'quiet-summary');
  assert.equal((await notifications())['quiet-summary'], undefined);
});

await test('a permission prompt that closed the popup: the add still completes', async () => {
  const page = await extensionPage('options.html');
  const url = `${NOTES}?from=prompt`;
  const pending = {
    id: 'orphaned-add',
    kind: 'page',
    tabId: 1,
    url,
    createdAt: Date.now(),
    draft: { url, name: 'Added after the prompt', selectors: [], intervalMinutes: 60, mode: 'text', keyword: '', liveText: null },
  };
  await page.evaluate((pending) => chrome.storage.session.set({ pendingAdd: pending }), pending);
  await hook('permissionsAdded', { origins: [site(DOCS, '/*')] });
  const watch = (await watches()).find((item) => item.url === url);
  assert.equal(watch?.name, 'Added after the prompt');
  assert.ok((await notifications())['added:orphaned-add'], 'the user is told the watch was added');
  assert.equal((await page.evaluate(() => chrome.storage.session.get('pendingAdd'))).pendingAdd, undefined);
  ids.orphaned = watch.id;
});

await test('granting site access again re-checks that site\'s watches', async () => {
  const before = (await watchById(ids.stock)).lastCheckedAt;
  const page = await extensionPage('options.html');
  const response = await page.evaluate((url) => chrome.runtime.sendMessage({ type: 'pw/access-granted', url }), LAMP);
  assert.ok(response.ok);
  await waitFor(async () => (await watchById(ids.stock)).lastCheckedAt > before, 're-checked after access was granted');
  await waitFor(async () => {
    const queue = await hook('queue');
    return queue.active === 0 && queue.queued === 0;
  }, 'all re-checks finished');
});

await test('browser start: missing alarms are recreated, overdue checks spread out', async () => {
  await worker.evaluate(async (overdue) => {
    const { watches } = await chrome.storage.local.get('watches');
    const past = Date.now() - 60_000;
    await chrome.storage.local.set({ watches: watches.map((watch) => (overdue.includes(watch.id) ? { ...watch, nextCheckAt: past } : watch)) });
    await chrome.alarms.clearAll();
  }, [ids.price, ids.stock]);
  await hook('startup');
  const alarms = await worker.evaluate(() => chrome.alarms.getAll());
  const active = (await watches()).filter((watch) => !watch.paused);
  assert.equal(alarms.length, active.length);
  const due = [ids.price, ids.stock].map((id) => alarms.find((item) => item.name === `watch:${id}`).scheduledTime - Date.now());
  for (const delay of due) assert.ok(delay > 50_000 && delay < 4 * 60_000, `overdue check in ${delay} ms`);
  assert.notEqual(Math.round(due[0] / 1000), Math.round(due[1] / 1000), 'not at the same moment');
  assert.ok((await watchById(ids.price)).nextCheckAt > Date.now(), 'stored schedule updated');
  assert.equal(await badge(), String((await watches()).reduce((sum, watch) => sum + watch.unseen, 0) || ''));
});

await test('free plan: over the limit, existing watches keep working; Pro choices are locked', async () => {
  await worker.evaluate(() => chrome.storage.local.set({ 'e2e:earlyAccess': false, plan: 'free' }));
  const count = (await watches()).length;
  assert.ok(count > 3, `${count} watches`);
  const docs = await open(NOTES);
  const popup = await popupFor(docs);
  const note = popup.locator('.limit-note');
  await note.waitFor();
  assert.match(await note.innerText(), /Free keeps 3 watches\. Pro removes the limit\./);
  assert.equal(await popup.getByRole('button', { name: 'Watch this page' }).count(), 0);
  assert.match(await popup.locator('#watches .section-label').first().innerText(), new RegExp(`^Watching · ${count}$`, 'i'));
  await shots(popup, 'popup-free-limit', { popup: true });

  // The service worker enforces the same limits.
  const blocked = await addWatch(NOTES, { name: 'Fourth' });
  assert.equal(blocked.code, 'limit');
  assert.equal(blocked.message, 'Free keeps 3 watches. Pro removes the limit.');
  const helper = await extensionPage('options.html');
  const pick = await helper.evaluate(
    (url) => chrome.runtime.sendMessage({ type: 'pw/complete-add', pending: { id: 'p', kind: 'pick', tabId: 1, url, createdAt: Date.now() } }),
    LAMP,
  );
  assert.equal(pick.code, 'limit');
  // Background tabs get no animation frames, which slows every click down: back to the popup.
  await popup.bringToFront();
  // Existing watches, even Pro ones, keep working.
  state.price = '$45.00';
  assert.equal((await check(ids.price)).status, 'changed');
  // The full price history is Pro: free shows the last 7 days in the chart, nothing is deleted.
  const lamp = popup.locator('.watch', { hasText: 'Lamp price' });
  await lamp.locator('.watch-toggle').click();
  await lamp.locator('.history .pro-hint', { hasText: 'Showing the last 7 days. The full history is part of Pro.' }).waitFor();
  assert.ok((await storage(`history:${ids.price}`)).length > 10, 'older points are kept');
  await lamp.locator('.watch-toggle').click();

  // Editing: the watch's own Pro rule stays, other Pro choices are locked.
  const row = popup.locator('.watch', { hasText: 'Lamp stock' });
  await row.locator('.watch-toggle').click();
  await row.getByRole('button', { name: 'Edit' }).click();
  assert.ok(await row.getByLabel('A keyword appears or disappears').isEnabled());
  assert.ok(await row.getByLabel('A number or price changes').isDisabled());
  assert.ok(await row.getByLabel('The price drops below').isDisabled());
  assert.ok(await row.getByLabel('It’s the lowest in 30 days').isDisabled());
  assert.equal(await row.locator('option[value="15"]').innerText(), '15 minutes · PRO');
  assert.equal(await row.locator('option[value="1"]').innerText(), '1 minute · PRO');
  assert.ok(await row.locator('option[value="15"]').isDisabled());
  await row.getByRole('button', { name: 'About Pro' }).first().waitFor();
  await row.locator('fieldset').scrollIntoViewIfNeeded();
  await shots(popup, 'popup-free-edit', { popup: true });
  await row.getByLabel('Name').fill('Lamp stock (free)');
  await row.getByRole('button', { name: 'Save' }).click();
  await popup.locator('.toast', { hasText: 'Saved' }).waitFor();
  assert.equal((await watchById(ids.stock)).mode, 'keyword');
  const update = (patch) => helper.evaluate(({ id, patch }) => chrome.runtime.sendMessage({ type: 'pw/update', id, patch }), { id: ids.stock, patch });
  assert.equal((await update({ mode: 'number' })).code, 'limit');
  assert.equal((await update({ intervalMinutes: 15 })).code, 'limit');

  // "About Pro" leads to the card on the options page, which knows the plan.
  const opened = context.waitForEvent('page');
  await popup.locator('.limit-note').getByRole('button', { name: 'About Pro' }).click();
  const options = await opened;
  openPages.add(options);
  await options.waitForLoadState();
  assert.match(options.url(), /options\.html#about-pro$/);
  await options.locator('#pro-status', { hasText: "You're on the free plan." }).waitFor();
  assert.match(await options.locator('#get-pro-note').innerText(), /Not available yet/);
  assert.ok(await options.getByLabel('Hold notifications during quiet hours').isDisabled());
  assert.ok(await options.locator('#default-interval option[value="5"]').isDisabled());
  assert.match(await options.locator('#quiet-locked').innerText(), /Quiet hours are part of Pro/);

  // Below the limit: only "any change" and hourly or slower intervals can be added.
  const saved = await watches();
  await worker.evaluate((keep) => chrome.storage.local.set({ watches: keep }), saved.slice(0, 2));
  const fresh = await popupFor(docs);
  await fresh.getByRole('button', { name: 'Watch this page' }).click();
  assert.equal(await fresh.getByLabel('Check every').inputValue(), '60', 'the 30-minute default is clamped to the free minimum');
  assert.ok(await fresh.locator('option[value="5"]').isDisabled());
  assert.ok(await fresh.getByLabel('A number or price changes').isDisabled());
  assert.ok(await fresh.getByLabel('Any text change').isChecked());
  await shot(fresh, 'popup-free-add', { popup: true });
  assert.match(await fresh.locator('#watches .section-label').first().innerText(), /^Watching · 2 of 3$/i);
  // The picker gets the plan from the service worker: a short price no longer preselects the Pro rule.
  const shop = await open(LAMP);
  const pickerPopup = await popupFor(shop);
  await addButtons(pickerPopup);
  await pickerPopup.getByRole('button', { name: 'Pick an element…' }).click();
  await shop.bringToFront();
  await picker(shop).locator('.pw-bar').waitFor();
  const priceBox = await shop.locator('[data-testid="price"]').boundingBox();
  await shop.mouse.move(priceBox.x + 5, priceBox.y + 5);
  await shop.mouse.click(priceBox.x + 5, priceBox.y + 5);
  const card = picker(shop).locator('.pw-card');
  await card.waitFor();
  assert.ok(await card.getByLabel('Any text change').isChecked());
  assert.ok(await card.getByLabel('A number or price changes').isDisabled());
  assert.ok(await card.locator('option[value="15"]').isDisabled());
  await shop.keyboard.press('Escape');
  await picker(shop).waitFor({ state: 'detached' });
  assert.equal((await addWatch(NOTES, { mode: 'number' })).code, 'limit');
  assert.equal((await addWatch(NOTES, { intervalMinutes: 15 })).code, 'limit');
  assert.equal((await addWatch(NOTES, { mode: 'lowest', selectors: ['p'] })).code, 'limit');
  assert.equal((await addWatch(NOTES, { intervalMinutes: 1 })).code, 'limit');
  const added = await addWatch(NOTES, { name: 'Third on free' });
  assert.ok(added.ok, JSON.stringify(added));
  assert.equal((await addWatch(NOTES, { name: 'Fourth on free' })).code, 'limit');
  assert.ok((await helper.evaluate((id) => chrome.runtime.sendMessage({ type: 'pw/delete', id }), added.watch.id)).ok);
  await worker.evaluate((all) => chrome.storage.local.set({ watches: all }), saved);

  // Quiet hours are a Pro feature: on free, notifications aren't held.
  await worker.evaluate(() => chrome.storage.local.set({ settings: { notifyChanges: true, notifyErrors: true, defaultIntervalMinutes: 30, quietHours: { enabled: true, start: 0, end: 1439 } } }));
  await worker.evaluate((id) => chrome.notifications.clear(`change:${id}`), ids.price);
  state.price = '$44.00';
  await check(ids.price);
  assert.ok((await notifications())[`change:${ids.price}`], 'notified on free despite quiet hours');
  assert.equal(await storage('heldNotifications'), undefined);

  await worker.evaluate(() =>
    chrome.storage.local.set({ 'e2e:earlyAccess': true, settings: { notifyChanges: true, notifyErrors: true, defaultIntervalMinutes: 30 } }),
  );
  await options.locator('#pro-status', { hasText: 'Early access' }).waitFor();
});

await test('network: only the watched pages were requested, no other hosts', async () => {
  const allowed = new Set([LAMP, THROW, NOTES, CHANGELOG, STATUS_PAGE, DASHBOARD, NEWS_PAGE, site(DOCS, '/latest'), site(SHOP, '/hang'), site(SHOP, '/api/price'), site(DOCS, '/nope')]);
  for (let i = 1; i <= 5; i++) allowed.add(site(DOCS, `/slow/${i}`));
  const unexpected = extensionFetches().filter((request) => !allowed.has(site(request.host, request.path)));
  assert.deepEqual(unexpected, []);
  assert.deepEqual(otherHostRequests, []);
});

await test('service worker restart: watches, alarms and checks survive', async () => {
  const internals = await newPage();
  await internals.goto('chrome://serviceworker-internals/');
  const registration = internals.locator('.serviceworker-registration', { hasText: extensionId });
  await registration.locator('button[data-command="stop"]').first().click();
  await waitFor(
    async () => (await registration.locator('.serviceworker-running-status .value').first().innerText()) === 'STOPPED',
    'worker stopped',
  );

  // From here on, only real extension messages (no test hook): Playwright can't re-attach to
  // a restarted extension worker, which is fine, the popup doesn't need it either.
  const page = await extensionPage('options.html');
  const stored = await page.evaluate(async () => (await chrome.storage.local.get('watches')).watches);
  assert.ok(stored.some((watch) => watch.id === ids.price));
  const alarms = await page.evaluate(async () => (await chrome.alarms.getAll()).map((alarm) => alarm.name));
  assert.ok(alarms.includes(`watch:${ids.price}`) && alarms.includes(`watch:${ids.stock}`), JSON.stringify(alarms));

  const previous = await page.evaluate(async (id) => (await chrome.storage.local.get(`snapshot:${id}`))[`snapshot:${id}`].text, ids.price);
  const badgeBefore = Number((await page.evaluate(() => chrome.action.getBadgeText({}))) || 0);
  state.price = '$59.00';
  const response = await page.evaluate((id) => chrome.runtime.sendMessage({ type: 'pw/check-now', id }), ids.price);
  assert.ok(response.ok);
  await waitFor(
    () =>
      page
        .evaluate(async (id) => (await chrome.storage.local.get('watches')).watches.find((watch) => watch.id === id)?.lastSummary, ids.price)
        .then((summary) => summary === `Price changed: ${previous} → $59.00`),
    'check after restart',
  );
  // The notification and badge follow right after the stored result.
  await waitFor(async () => (await page.evaluate(() => chrome.notifications.getAll()))[`change:${ids.price}`], 'notified after restart');
  await waitFor(async () => (await page.evaluate(() => chrome.action.getBadgeText({}))) === String(badgeBefore + 1), 'badge after restart');
});

// --- Summary --------------------------------------------------------------------------------

await context.close();
server.close();
await rm(userDataDir, { recursive: true, force: true });

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed. Screenshots: ${outputDir}${updateScreenshots ? ` (curated copies in ${screenshotsDir})` : ''}`);
process.exit(failed.length ? 1 : 0);
