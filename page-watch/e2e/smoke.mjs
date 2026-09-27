// End-to-end smoke test: loads the e2e build (dist-e2e/) into a real Chromium and drives
// every user flow against a local server whose pages the test changes between checks.
//
//   npm run test:e2e                      (set CHROMIUM_PATH if Chromium isn't auto-detected)
//   SCREENSHOTS=1 npm run test:e2e        also refreshes the curated screenshots/ for the README
//
// Alarms can't be fast-forwarded and notifications can't be clicked from automation, so the
// test calls the handlers Chrome would call through a hook that only exists in the e2e build.
// The e2e build is also granted http://127.0.0.1 up front (permission prompts can't be clicked).

import assert from 'node:assert/strict';
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

const state = {
  docs: ['Page Watch keeps an eye on pages for you.', 'Checks run in the background, a few times an hour at most.', 'Version 1.0 is the current release.'],
  price: '$129.00',
  stock: 'In stock',
  promo: 'Free shipping on orders over $50.',
  showPrice: true,
  flakyStatus: 200,
  slowMs: 400,
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

const docsHtml = () => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Release notes – Example Docs</title>
<style>body { font: 16px/1.6 system-ui, sans-serif; max-width: 680px; margin: 40px auto; padding: 0 20px; }</style></head>
<body><nav>Home · Docs · Blog</nav><main><h1>Release notes</h1>${state.docs.map((text) => `<p>${text}</p>`).join('')}</main>
<footer>© Example Docs</footer><script>console.log('never runs in the parser')</script></body></html>`;

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
  const url = new URL(request.url ?? '/', 'http://localhost');
  requests.push({ path: url.pathname, dest: request.headers['sec-fetch-dest'] ?? '', at: Date.now() });
  const html = (body, status = 200, headers = {}) => response.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers }).end(body);
  switch (url.pathname) {
    case '/shop':
      return html(shopHtml());
    case '/docs':
      return html(docsHtml());
    case '/spa':
      return html(spaHtml);
    case '/flaky':
      return html(`<!doctype html><title>Status</title><h1>Service status</h1><p>All systems normal.</p>`, state.flakyStatus);
    case '/json':
      return response.writeHead(200, { 'content-type': 'application/json' }).end('{"price": 129}');
    case '/redirect':
      return response.writeHead(302, { location: '/docs' }).end();
    case '/cp1251':
      return response
        .writeHead(200, { 'content-type': 'text/html' })
        .end(cp1251('<!doctype html><meta charset="windows-1251"><title>Новости</title><h1>Новости</h1><p>Привет, мир! Цена 250 грн</p>'));
    case '/hang':
      return; // Never answers: exercises the timeout.
    default:
      if (url.pathname.startsWith('/slow/')) {
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
const base = `http://127.0.0.1:${server.address().port}`;
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
  args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
});
const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
const extensionId = new URL(worker.url()).host;
const otherHostRequests = [];
context.on('request', (request) => {
  const url = request.url();
  if (!url.startsWith(base) && !url.startsWith('chrome-extension://') && !url.startsWith('data:') && !url.startsWith('chrome://')) {
    otherHostRequests.push(url);
  }
});
await worker.evaluate(() => globalThis.__pageWatchTest.setFetchTimeout(1500));

const openPages = new Set();
async function newPage() {
  const page = await context.newPage();
  openPages.add(page);
  return page;
}

async function open(path) {
  const page = await newPage();
  await page.goto(`${base}${path}`);
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
const check = (id) => hook('runCheck', id);

/** Adds a whole-page watch the way the popup does after the permission prompt. */
async function addWatch(path, draft = {}) {
  const page = await extensionPage('options.html');
  const url = path.startsWith('http') ? path : `${base}${path}`;
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

async function shot(page, name, { popup = false } = {}) {
  if (popup) {
    const height = await page.evaluate(() => Math.min(600, Math.ceil(document.documentElement.scrollHeight)));
    await page.setViewportSize({ width: 400, height });
  }
  const path = join(outputDir, `${name}.png`);
  await page.screenshot({ path });
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

console.log(`Chromium ${context.browser()?.version() ?? ''} · extension ${extensionId} · ${base}\n`);

await test('production manifest: minimal permissions, optional per-site host access, no test hook', async () => {
  const manifest = JSON.parse(await readFile(join(root, 'dist/manifest.json'), 'utf8'));
  assert.deepEqual([...manifest.permissions].sort(), ['activeTab', 'alarms', 'notifications', 'offscreen', 'scripting', 'storage']);
  assert.deepEqual(manifest.optional_host_permissions, ['https://*/*', 'http://*/*']);
  assert.equal(manifest.host_permissions, undefined);
  assert.equal(manifest.content_scripts, undefined);
  for (const file of ['background.js', 'popup.js', 'picker.js', 'options.js', 'offscreen.js']) {
    const source = await readFile(join(root, 'dist', file), 'utf8');
    assert.ok(!source.includes('__pageWatchTest'), `${file} contains the test hook`);
    assert.ok(!source.includes("has('deny')") && !source.includes('has("deny")'), `${file} contains the simulated denial`);
  }
});

await test('popup: empty state explains how to start', async () => {
  const shop = await open('/shop');
  const popup = await popupFor(shop);
  await popup.getByRole('button', { name: 'Watch this page' }).waitFor();
  assert.match(await popup.locator('.empty-state').innerText(), /Know when a page changes/);
  assert.match(await popup.locator('#current').innerText(), /Aurora Desk Lamp – Lumen Store/);
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
  const docs = await open('/docs');
  const popup = await popupFor(docs, '&deny=1');
  await popup.getByRole('button', { name: 'Watch this page' }).click();
  await popup.getByRole('button', { name: 'Start watching' }).click();
  await popup.locator('.alert-danger', { hasText: 'needs access to 127.0.0.1' }).waitFor();
  assert.match(await popup.locator('.alert-danger').innerText(), /Nothing was saved/);
  assert.equal((await watches()).length, 0);
  await shot(popup, 'popup-denied', { popup: true });
});

await test('whole page: add from the popup, baseline stored, alarm scheduled', async () => {
  const docs = await open('/docs');
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
  const snapshot = await storage(`snapshot:${watch.id}`);
  assert.equal(snapshot.text, `Home · Docs · Blog\nRelease notes\n${state.docs.join('\n')}\n© Example Docs`);
  assert.ok(!snapshot.text.includes('never runs'), 'scripts are not part of the text');
  assert.equal(extensionFetches().length, fetchesBefore + 1, 'exactly one fetch for the baseline');
  const scheduled = await alarm(watch.id);
  const minutes = (scheduled.scheduledTime - Date.now()) / 60_000;
  assert.ok(minutes > 13 && minutes < 16.6, `next check in ${minutes} min`);
  await popup.locator('.watch', { hasText: 'Release notes' }).waitFor();
});

await test('whole page: no change → nothing recorded, no notification', async () => {
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

  const docs = await open('/docs');
  const popup = await popupFor(docs);
  // A single watch with news opens by itself and shows the diff.
  await popup.locator('.diff-add', { hasText: 'New: keyword alerts.' }).waitFor();
  assert.ok(await popup.locator('.diff-remove', { hasText: 'Version 1.0' }).isVisible());
  assert.match(await popup.locator('.diff-summary').innerText(), /\+2 lines/);
  await waitFor(async () => (await badge()) === '', 'badge cleared after viewing');
  assert.equal((await watchById(ids.docs)).unseen, 0);
  await waitFor(async () => (await notifications())[`change:${ids.docs}`] === undefined, 'notification cleared once seen');
  await shots(popup, 'popup-diff', { popup: true });
});

await test('element picker: hover, keyboard wider/narrower, click, number mode', async () => {
  const shop = await open('/shop');
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
  assert.equal(await card.locator('.pw-preview').innerText(), '$129.00');
  // A short numeric region preselects the number mode.
  assert.ok(await card.getByLabel('A number or price changes').isChecked());
  // Wider/narrower buttons from the card, then back.
  await card.getByRole('button', { name: 'Wider' }).click();
  assert.match(await card.locator('.pw-preview').innerText(), /^\$129\.00\s?incl\. VAT$/);
  await card.getByRole('button', { name: 'Narrower' }).click();
  assert.equal(await card.locator('.pw-preview').innerText(), '$129.00');
  await card.getByLabel('Name').fill('Lamp price');
  await shots(shop, 'picker-card');
  await card.getByRole('button', { name: 'Watch this' }).click();
  await card.getByText('Watching “Lamp price”').waitFor();
  await shot(shop, 'picker-done');
  assert.equal(await shop.title(), 'Aurora Desk Lamp – Lumen Store', 'the page never saw the click');

  const watch = (await watches()).find((item) => item.name === 'Lamp price');
  ids.price = watch.id;
  assert.equal(watch.selector, '[data-testid="price"]');
  assert.equal(watch.mode, 'number');
  assert.equal((await storage(`snapshot:${watch.id}`)).text, '$129.00');
  await card.getByRole('button', { name: 'Done' }).click();
  await picker(shop).waitFor({ state: 'detached' });
});

await test('element picker: Escape cancels and the page works again', async () => {
  const shop = await open('/shop');
  const popup = await popupFor(shop);
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
});

await test('keyword mode: only the keyword appearing or disappearing counts', async () => {
  const response = await addWatch('/shop', { name: 'Lamp stock', mode: 'keyword', keyword: 'Sold out' });
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

await test('popup: unseen changes are highlighted in the list', async () => {
  const shop = await open('/shop');
  const popup = await popupFor(shop);
  const unseen = popup.locator('.watch.is-unseen');
  await waitFor(async () => (await unseen.count()) === 2, 'two watches with news');
  assert.match(await unseen.first().innerText(), /new/);
  assert.match(await popup.locator('.watch', { hasText: 'Lamp price' }).innerText(), /Price changed: \$129\.00 → \$99\.00/);
  assert.ok(await popup.getByRole('button', { name: 'Mark all seen' }).isVisible());
  assert.match(await popup.locator('#current').innerText(), /You're watching this page \(2 watches\)/);
  await shots(popup, 'popup-list', { popup: true });
  // History: the latest change is shown, older ones can be picked.
  await popup.locator('.watch', { hasText: 'Lamp stock' }).locator('.watch-toggle').click();
  await popup.locator('.change-list .list-group-item').nth(1).click();
  await popup.locator('.diff-summary', { hasText: 'appeared' }).waitFor();
  await popup.getByRole('button', { name: 'Mark all seen' }).click();
  await waitFor(async () => (await badge()) === '', 'badge cleared');
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
  assert.equal(tab.url(), `${base}/shop`);
  assert.equal((await watchById(ids.price)).unseen, 0);
  assert.equal(await badge(), '');
  assert.equal((await notifications())[`change:${ids.price}`], undefined);
});

await test('errors: HTTP 500 shows in the popup, backs off, recovers', async () => {
  const response = await addWatch('/flaky', { name: 'Status page', intervalMinutes: 5 });
  assert.ok(response.ok);
  ids.flaky = response.watch.id;
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

  const page = await open('/docs');
  const popup = await popupFor(page);
  const row = popup.locator('.watch', { hasText: 'Status page' });
  assert.match(await row.innerText(), /HTTP 500/);
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
  const hang = await addWatch('/hang');
  assert.equal(hang.ok, false);
  assert.equal(hang.code, 'timeout');
  const json = await addWatch('/json');
  assert.equal(json.ok, false);
  assert.equal(json.code, 'not-html');
  assert.match(json.message, /application\/json/);
  const refused = await addWatch('http://127.0.0.1:1/');
  assert.equal(refused.code, 'network');
  assert.match(refused.message, /Couldn't reach the site/);
  const missing = await addWatch('/nope');
  assert.equal(missing.code, 'http');
  assert.match(missing.message, /not found \(HTTP 404\)/i);
  assert.ok(!(await watches()).some((watch) => watch.url.endsWith('/hang') || watch.url.endsWith('/json')), 'nothing saved');
});

await test('JavaScript-rendered pages are refused with a clear message (page and element)', async () => {
  const spa = await open('/spa');
  const popup = await popupFor(spa);
  await popup.getByRole('button', { name: 'Watch this page' }).click();
  // The popup reads the live page text to compare it with the fetched HTML.
  await popup.waitForTimeout(300);
  await popup.getByRole('button', { name: 'Start watching' }).click();
  const alert = popup.locator('.alert-danger', { hasText: 'This page renders with JavaScript' });
  await alert.waitFor();
  await shots(popup, 'popup-js-rendered', { popup: true });
  assert.ok(!(await watches()).some((watch) => watch.url.endsWith('/spa')));

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
  assert.ok(!(await watches()).some((watch) => watch.url.endsWith('/spa')));
});

await test('redirects are followed and legacy encodings decoded', async () => {
  const redirected = await addWatch('/redirect', { name: 'Redirected' });
  assert.ok(redirected.ok);
  assert.match((await storage(`snapshot:${redirected.watch.id}`)).text, /Release notes/);
  const cyrillic = await addWatch('/cp1251');
  assert.ok(cyrillic.ok);
  assert.equal(cyrillic.watch.name, 'Новости');
  assert.equal((await storage(`snapshot:${cyrillic.watch.id}`)).text, 'Новости\nПривет, мир! Цена 250 грн');
  ids.redirect = redirected.watch.id;
  ids.cyrillic = cyrillic.watch.id;
});

await test('site access: a missing permission is shown with a way to grant it again', async () => {
  // A watch on a host this build has no access to (as if access had been revoked).
  const url = base.replace('127.0.0.1', 'localhost') + '/docs';
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
  const page = await open('/docs');
  const popup = await popupFor(page);
  const row = popup.locator('.watch', { hasText: 'Revoked site' });
  assert.match(await row.innerText(), /Needs site access/);
  await row.locator('.watch-toggle').click();
  await row.getByRole('button', { name: /Allow access to localhost/ }).waitFor();
  // Access removed from Chrome's UI is reflected right away.
  await worker.evaluate(() => chrome.storage.local.set({ probe: 1 }));
  await hook('permissionsRemoved', { origins: [`${base}/*`] });
  assert.equal((await watchById(ids.docs)).error, null, 'still granted in this build, so nothing is flagged');
  await hook('permissionsRemoved', { origins: ['http://localhost/*'] });
  assert.equal((await watchById('revoked')).error.code, 'permission');
  const response = await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'pw/delete', id: 'revoked' }));
  assert.ok(response.ok);
});

await test('pause, resume, edit and delete from the popup', async () => {
  const page = await open('/docs');
  const popup = await popupFor(page);
  const row = popup.locator('.watch', { hasText: 'Release notes' });
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
    const response = await addWatch(`/slow/${i}`, { name: `Slow ${i}`, intervalMinutes: 5 });
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
  assert.deepEqual(await storage('settings'), { notifyChanges: false, notifyErrors: true, defaultIntervalMinutes: 30 });
  assert.match(await page.locator('#privacy-statement').innerText(), /only network requests Page Watch makes are to the pages you chose to watch/);
  assert.match(await page.locator('#sites').innerText(), /127\.0\.0\.1/);
  await shots(page, 'options');

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
  const docs = await open('/docs');
  const popup = await popupFor(docs);
  await popup.getByRole('button', { name: 'Watch this page' }).click();
  assert.equal(await popup.getByLabel('Check every').inputValue(), '30');
});

await test('a permission prompt that closed the popup: the add still completes', async () => {
  const page = await extensionPage('options.html');
  const url = `${base}/docs?from=prompt`;
  const pending = {
    id: 'orphaned-add',
    kind: 'page',
    tabId: 1,
    url,
    createdAt: Date.now(),
    draft: { url, name: 'Added after the prompt', selectors: [], intervalMinutes: 60, mode: 'text', keyword: '', liveText: null },
  };
  await page.evaluate((pending) => chrome.storage.session.set({ pendingAdd: pending }), pending);
  await hook('permissionsAdded', { origins: [`${base}/*`] });
  const watch = (await watches()).find((item) => item.url === url);
  assert.equal(watch?.name, 'Added after the prompt');
  assert.ok((await notifications())['added:orphaned-add'], 'the user is told the watch was added');
  assert.equal((await page.evaluate(() => chrome.storage.session.get('pendingAdd'))).pendingAdd, undefined);
  ids.orphaned = watch.id;
});

await test('granting site access again re-checks that site\'s watches', async () => {
  const before = (await watchById(ids.stock)).lastCheckedAt;
  const page = await extensionPage('options.html');
  const response = await page.evaluate((url) => chrome.runtime.sendMessage({ type: 'pw/access-granted', url }), `${base}/shop`);
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

await test('network: only the watched pages were requested, no other hosts', async () => {
  const allowed = new Set(['/docs', '/shop', '/flaky', '/redirect', '/cp1251', '/hang', '/json', '/nope', '/spa']);
  for (let i = 1; i <= 5; i++) allowed.add(`/slow/${i}`);
  const unexpected = extensionFetches().filter((request) => !allowed.has(request.path));
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
