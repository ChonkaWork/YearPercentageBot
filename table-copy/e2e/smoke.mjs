// End-to-end smoke test: loads the e2e build (dist-e2e/) into a real Chromium and drives
// every user flow against local fixture pages, checking what lands on the clipboard and in
// downloaded .xlsx files.
//
//   npm run test:e2e        (set CHROMIUM_PATH if Chromium isn't auto-detected)
//   npm run screenshots     same, and refreshes the curated screenshots/ for the README
//
// Native context menus and browser-level shortcuts can't be clicked from automation, so the
// test calls the exact handler Chrome would call (exposed only in the e2e build).

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { strFromU8, unzipSync } from 'fflate';
import { chromium } from 'playwright-core';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const extensionPath = join(root, 'dist-e2e');
const fixtures = join(root, 'e2e/fixtures');
const outputDir = join(root, 'e2e/output');
const screenshotsDir = join(root, 'screenshots');
const curate = process.env.SCREENSHOTS === '1';
const headless = process.env.HEADED !== '1';

function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const candidates = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  const found = candidates.find((path) => existsSync(path));
  if (!found) throw new Error('Chromium not found. Set CHROMIUM_PATH.');
  return found;
}

// --- Fixture server ---------------------------------------------------------------------

function bigTable(rows, columns) {
  const head = `<tr>${Array.from({ length: columns }, (_, c) => `<th>Column ${c + 1}</th>`).join('')}</tr>`;
  const body = Array.from(
    { length: rows },
    (_, r) => `<tr>${Array.from({ length: columns }, (_, c) => `<td>${c === 0 ? r + 1 : `r${r + 1} c${c + 1}, "q"`}</td>`).join('')}</tr>`,
  ).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Big table</title></head><body><h1>Big</h1><table id="big"><thead>${head}</thead><tbody>${body}</tbody></table></body></html>`;
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (url.pathname === '/big-table.html') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(bigTable(5000, 8));
    return;
  }
  // Same tables page, served with a strict CSP: the toast must still render and be styled.
  const strictCsp = url.pathname === '/csp.html';
  const file = strictCsp ? 'tables.html' : url.pathname.slice(1);
  try {
    const body = await readFile(join(fixtures, file));
    const headers = { 'content-type': 'text/html; charset=utf-8' };
    if (strictCsp) headers['content-security-policy'] = "default-src 'none'; style-src 'self'; script-src 'none'; img-src 'none'";
    response.writeHead(200, headers).end(body);
  } catch {
    response.writeHead(404).end('not found');
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

// The pages are opened under realistic hostnames without a port (the curated screenshots are
// also store graphics): Chromium resolves these reserved example hosts to the local server and
// treats them as secure origins, as it did 127.0.0.1, so the clipboard API behaves the same.
const pageHosts = { 'shop-jan.html': 'shop.example.com', 'shop-feb.html': 'store.example.net' };
const defaultHost = 'stats.example.org';
const fixtureHosts = [...new Set([defaultHost, ...Object.values(pageHosts)])];
const fixtureOrigins = fixtureHosts.map((host) => `http://${host}`);
const fixtureUrl = (name) => `http://${pageHosts[name] ?? defaultHost}/${name}`;

// --- Browser ----------------------------------------------------------------------------

await mkdir(outputDir, { recursive: true });
if (curate) await mkdir(screenshotsDir, { recursive: true });
const userDataDir = await mkdtemp(join(tmpdir(), 'table-copy-e2e-'));
const context = await chromium.launchPersistentContext(userDataDir, {
  executablePath: findChromium(),
  headless,
  viewport: { width: 1280, height: 800 },
  locale: 'en-US',
  acceptDownloads: true,
  args: [
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
    `--host-resolver-rules=${fixtureHosts.map((host) => `MAP ${host}:80 127.0.0.1:${port}`).join(',')}`,
    '--no-proxy-server', // a proxy from the environment would otherwise get these requests
    `--unsafely-treat-insecure-origin-as-secure=${fixtureOrigins.join(',')}`,
  ],
});
for (const origin of fixtureOrigins) await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
const extensionId = new URL(worker.url()).host;

const openPages = new Set();

async function newPage() {
  const page = await context.newPage();
  openPages.add(page);
  return page;
}

async function open(name) {
  const page = await newPage();
  await page.goto(name.includes('://') ? name : fixtureUrl(name));
  await page.bringToFront();
  return page;
}

/** Selects the contents of an element. */
async function select(page, selector) {
  await page.evaluate((selector) => {
    const node = document.querySelector(selector);
    if (!node) throw new Error(`Missing ${selector}`);
    const range = document.createRange();
    range.selectNodeContents(node);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }, selector);
}

async function tabOf(page) {
  await page.bringToFront();
  return worker.evaluate(async (url) => {
    const matches = (await chrome.tabs.query({})).filter((tab) => tab.url === url);
    if (matches.length) return matches.sort((a, b) => b.id - a.id)[0];
    const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return active;
  }, page.url());
}

async function waitFor(check, message, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out: ${message}`);
}

/** What chrome.contextMenus.onClicked would deliver. Returns the toast message shown. */
async function menu(page, menuItemId) {
  const tab = await tabOf(page);
  const selectionText = await page.evaluate(() => window.getSelection()?.toString() ?? '').catch(() => '');
  const info = { menuItemId, frameId: 0, pageUrl: page.url(), editable: false, selectionText };
  return worker.evaluate(({ info, tab }) => globalThis.__tableCopyTest.onContextMenuClick(info, tab), { info, tab });
}

async function resetClipboard(page) {
  await page.bringToFront();
  await page.evaluate(() => navigator.clipboard.writeText('<empty>'));
}

async function clipboardText(page) {
  await page.bringToFront();
  return page.evaluate(() => navigator.clipboard.readText());
}

/** text/html as written (unsanitized when Chrome supports it). */
async function clipboardHtml(page) {
  await page.bringToFront();
  return page.evaluate(async () => {
    let items;
    try {
      items = await navigator.clipboard.read({ unsanitized: ['text/html'] });
    } catch {
      items = await navigator.clipboard.read();
    }
    const item = items.find((candidate) => candidate.types.includes('text/html'));
    return item ? (await item.getType('text/html')).text() : null;
  });
}

async function setSettings(patch) {
  await worker.evaluate(async (patch) => {
    const { settings = {} } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...settings, ...patch } });
  }, patch);
}

async function resetStorage() {
  await worker.evaluate(() => chrome.storage.local.clear());
}

async function storedBasket() {
  return worker.evaluate(async () => (await chrome.storage.local.get('basket')).basket ?? []);
}

async function openPopupFor(page, colorScheme = 'light', height = 600) {
  const tab = await tabOf(page);
  const popup = await newPage();
  await popup.emulateMedia({ colorScheme });
  await popup.setViewportSize({ width: 380, height });
  await popup.goto(`chrome-extension://${extensionId}/popup.html?tabId=${tab.id}`);
  return popup;
}

const toast = (page) => page.locator('table-copy-toast .tc-toast');
const item = (popup, index) => popup.locator(`.table-item[data-index="${index}"]`);

async function shot(target, name, { curated = false, ...options } = {}) {
  // No half-finished CSS transitions in screenshots.
  const page = typeof target.page === 'function' ? target.page() : target;
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.mouse.move(0, 0); // no hover state left over from the last click
  await page.waitForTimeout(200);
  await target.screenshot({ path: join(outputDir, `${name}.png`), ...options });
  if (curate && curated) await target.screenshot({ path: join(screenshotsDir, `${name}.png`), ...options });
}

// --- .xlsx reading (a tiny reader, enough to check what Excel would see) ------------------

const decodeXml = (value) =>
  value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');

function readXlsx(bytes) {
  const files = unzipSync(new Uint8Array(bytes));
  const text = (path) => {
    assert.ok(files[path], `xlsx has ${path}`);
    return strFromU8(files[path]);
  };
  for (const part of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml']) text(part);
  const strings = [...text('xl/sharedStrings.xml').matchAll(/<si><t[^>]*>([\s\S]*?)<\/t><\/si>/g)].map((match) => decodeXml(match[1]));
  const names = [...text('xl/workbook.xml').matchAll(/<sheet name="([^"]*)" sheetId="(\d+)"/g)].map((match) => decodeXml(match[1]));
  const sheets = names.map((name, index) => {
    const xml = text(`xl/worksheets/sheet${index + 1}.xml`);
    const rows = [];
    for (const match of xml.matchAll(/<c r="([A-Z]+)(\d+)"( t="s")?(?: s="(\d+)")?><v>([^<]*)<\/v><\/c>/g)) {
      const [, column, row, shared, , value] = match;
      const y = Number(row) - 1;
      const x = [...column].reduce((sum, char) => sum * 26 + char.charCodeAt(0) - 64, 0) - 1;
      rows[y] ??= [];
      rows[y][x] = shared ? strings[Number(value)] : Number(value);
    }
    return { name, xml, rows: rows.map((row) => Array.from(row ?? [], (value) => value ?? '')) };
  });
  return { files, sheets };
}

async function download(page, trigger) {
  const [file] = await Promise.all([page.waitForEvent('download'), trigger()]);
  const path = await file.path();
  return { name: file.suggestedFilename(), bytes: await readFile(path) };
}

// --- Tests ------------------------------------------------------------------------------

const results = [];
async function test(name, fn) {
  const started = Date.now();
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✓ ${name} (${Date.now() - started} ms)`);
  } catch (error) {
    results.push({ name, ok: false, error });
    console.log(`  ✗ ${name}\n      ${String(error?.stack ?? error).split('\n').slice(0, 8).join('\n      ')}`);
  } finally {
    for (const page of openPages) await page.close().catch(() => undefined);
    openPages.clear();
    await resetStorage().catch(() => undefined);
  }
}

console.log(`Chromium ${context.browser()?.version() ?? ''} · extension ${extensionId}\n`);

await test('production build: minimal permissions, no host access, no test code', async () => {
  const manifest = JSON.parse(await readFile(join(root, 'dist/manifest.json'), 'utf8'));
  assert.deepEqual([...manifest.permissions].sort(), ['activeTab', 'clipboardWrite', 'contextMenus', 'offscreen', 'scripting', 'storage']);
  assert.equal(manifest.host_permissions, undefined);
  assert.equal(manifest.optional_host_permissions, undefined);
  assert.equal(manifest.content_scripts, undefined);
  assert.equal(manifest.web_accessible_resources, undefined);
  assert.equal(manifest.commands._execute_action.suggested_key.default, 'Alt+T');
  const background = await readFile(join(root, 'dist/background.js'), 'utf8');
  const popup = await readFile(join(root, 'dist/popup.js'), 'utf8');
  const page = await readFile(join(root, 'dist/page.js'), 'utf8');
  const options = await readFile(join(root, 'dist/options.js'), 'utf8');
  assert.ok(!background.includes('__tableCopyTest'), 'test hook compiled out');
  assert.ok(!popup.includes('URLSearchParams'), 'popup tab override compiled out');
  assert.ok(page.includes('"closed"') && !page.includes('mode: "open"'), 'toast shadow root is closed');
  const namespaces = /https?:\/\/(?:www\.w3\.org|schemas\.openxmlformats\.org)\//g;
  for (const file of [background, popup, page, options]) {
    assert.ok(!/https?:\/\/[a-z]/i.test(file.replace(/\/\/.*$/gm, '').replace(namespaces, '')), 'no remote URLs');
    assert.ok(!/\bfetch\(|XMLHttpRequest|WebSocket|sendBeacon/.test(file), 'no network APIs');
  }
  const notices = await readFile(join(root, 'dist/THIRD_PARTY_NOTICES.txt'), 'utf8');
  for (const name of ['Bootstrap', 'Bootstrap Icons', 'Manrope', 'JetBrains Mono', 'fflate']) assert.ok(notices.includes(name), `notice for ${name}`);
});

await test('keyboard shortcut Alt+T is actually assigned by Chrome to open the popup', async () => {
  const commands = await worker.evaluate(() => chrome.commands.getAll());
  const command = commands.find((entry) => entry.name === '_execute_action');
  assert.equal(command?.shortcut, 'Alt+T', JSON.stringify(commands));
});

await test('context menu: CSV, TSV (+HTML), Markdown and JSON from a selection inside a table', async () => {
  const page = await open('tables.html');
  await resetClipboard(page);
  await select(page, '#tricky td');

  const csv = await menu(page, 'tc:copy:csv');
  assert.equal(csv.title, 'Copied table as CSV');
  assert.equal(csv.detail, '3 rows × 5 columns');
  await toast(page).waitFor();
  assert.match(await toast(page).innerText(), /Copied table as CSV/);
  assert.equal(
    await clipboardText(page),
    'Name,Quote,Notes,Formula,Pipe\n"Smith, John","He said ""hello""","First line\nSecond line",=SUM(A1:A2),a | b\nDoe; Jane,,"one\ntwo",-5,',
  );
  await shot(page, 'toast-csv', { curated: true });

  await select(page, '#tricky td');
  await menu(page, 'tc:copy:tsv');
  assert.equal(
    await clipboardText(page),
    'Name\tQuote\tNotes\tFormula\tPipe\nSmith, John\tHe said "hello"\t"First line\nSecond line"\t\'=SUM(A1:A2)\ta | b\nDoe; Jane\t\t"one\ntwo"\t-5\t',
  );
  const html = await clipboardHtml(page);
  assert.ok(html?.includes('<th>Name</th>') && html.includes('<td>First line<br>Second line</td>') && html.includes("<td>'=SUM(A1:A2)</td>"), html);

  await select(page, '#tricky td');
  await menu(page, 'tc:copy:markdown');
  const md = await clipboardText(page);
  assert.ok(md.startsWith('| Name        | Quote           | Notes'), md);
  assert.ok(md.includes('| First line<br>Second line |') && md.includes('| a \\| b |'), md);

  await select(page, '#tricky td');
  await menu(page, 'tc:copy:json');
  assert.deepEqual(JSON.parse(await clipboardText(page)), [
    { Name: 'Smith, John', Quote: 'He said "hello"', Notes: 'First line\nSecond line', Formula: '=SUM(A1:A2)', Pipe: 'a | b' },
    { Name: 'Doe; Jane', Quote: '', Notes: 'one\ntwo', Formula: '-5', Pipe: '' },
  ]);
});

await test('context menu: spans become a grid, semicolon CSV follows the setting', async () => {
  const page = await open('tables.html');
  await resetClipboard(page);
  await select(page, '#spans td');
  await menu(page, 'tc:copy:csv');
  assert.equal(
    await clipboardText(page),
    'Region,City,Population,Population\nRegion,City,2010,2020\nWest,Lviv,"725,000","721,000"\nWest,Uzhhorod,"116,000","115,000"\nNorth,Kyiv,about 2.9 million,about 2.9 million',
  );
  await select(page, '#spans td');
  await menu(page, 'tc:copy:json');
  assert.deepEqual(Object.keys(JSON.parse(await clipboardText(page))[0]), ['Region', 'City', 'Population / 2010', 'Population / 2020']);

  await setSettings({ csvDelimiter: ';' });
  await select(page, '#pricing td');
  await menu(page, 'tc:copy:csv');
  assert.equal(await clipboardText(page), 'Plan;Price;Seats;Support\nFree;$0;1;\nPro;$12/mo;5;Email\nTeam;$30/mo;25;Priority, 24/7');
});

await test('context menu: a selection outside any table shows a clear error and leaves the clipboard alone', async () => {
  const page = await open('tables.html');
  await resetClipboard(page);
  await select(page, '#intro');
  const message = await menu(page, 'tc:copy:csv');
  assert.equal(message.tone, 'error');
  await toast(page).waitFor();
  assert.match(await toast(page).innerText(), /No table in the selection/);
  assert.equal(await clipboardText(page), '<empty>');
  await shot(page, 'toast-error', { curated: true });
});

await test('popup: lists every table with a preview and size, copies CSV and TSV', async () => {
  const page = await open('tables.html');
  await resetClipboard(page);
  const popup = await openPopupFor(page);
  await popup.locator('.table-item').first().waitFor();
  assert.equal(await popup.locator('.table-item').count(), 5);
  assert.equal(await popup.locator('#tables-count').innerText(), '5');
  const titles = await popup.locator('.table-item .table-title').allInnerTexts();
  assert.deepEqual(titles, ['Pricing', 'Store inventory', 'Population by region', 'Tricky cells', 'No header']);
  const pricing = popup.locator('.table-item').first();
  assert.equal(await pricing.locator('.table-dims').innerText(), '4 × 4');
  assert.deepEqual(await pricing.locator('.table-preview tr.header-row th').allInnerTexts(), ['Plan', 'Price', 'Seats', 'Support']);
  assert.equal(await popup.locator('.table-item').nth(2).locator('.table-dims').innerText(), '5 × 4');
  assert.match(await popup.locator('#shortcut-text').innerText(), /Alt\+T opens Table Copy/);
  assert.match(await popup.locator('#basket').innerText(), /Add tables from this page or others/);
  assert.equal(await popup.locator('.pro-badge').count(), 1 + 5 * 3, 'PRO badges on the basket and on each Pro action');
  await shot(popup.locator('body'), 'popup-light', { curated: true });

  await pricing.locator('[data-format="csv"]').click();
  await pricing.locator('[data-format="csv"].is-done').waitFor();
  assert.match(await popup.locator('#status').innerText(), /Copied Pricing as CSV: 4 rows × 4 columns/);
  assert.equal(await clipboardText(page), 'Plan,Price,Seats,Support\nFree,$0,1,\nPro,$12/mo,5,Email\nTeam,$30/mo,25,"Priority, 24/7"');

  await popup.bringToFront();
  const spans = popup.locator('.table-item').nth(2);
  await spans.locator('[data-format="tsv"]').click();
  await spans.locator('[data-format="tsv"].is-done').waitFor();
  assert.ok((await clipboardHtml(page))?.includes('<th>Population</th><th>Population</th>'));
  assert.ok((await clipboardText(page)).startsWith('Region\tCity\tPopulation\tPopulation\nRegion\tCity\t2010\t2020\n'));

  const dark = await openPopupFor(page, 'dark');
  await dark.locator('.table-item').first().waitFor();
  await shot(dark.locator('body'), 'popup-dark', { curated: true });
});

await test('popup: Download .xlsx saves a real workbook with numbers as numbers', async () => {
  const page = await open('tables.html');
  const popup = await openPopupFor(page);
  const inventory = popup.locator('.table-item').nth(1);
  await inventory.waitFor();
  const file = await download(popup, () => inventory.locator('[data-action="xlsx"]').click());
  assert.equal(file.name, 'store-inventory.xlsx');
  assert.deepEqual([...file.bytes.subarray(0, 4)], [0x50, 0x4b, 0x03, 0x04], 'zip signature');
  const { sheets } = readXlsx(file.bytes);
  assert.equal(sheets.length, 1);
  assert.equal(sheets[0].name, 'Store inventory');
  assert.deepEqual(sheets[0].rows, [
    ['Product', 'SKU', 'Price (USD)', 'Stock', 'Share', 'Updated'],
    ['Green tea', '00731', 3.5, 1250, 0.125, '2026-09-01'],
    ['Black coffee', '00732', 4.2, 980, 0.4, '2026-09-02'],
    ['Oat milk', '01150', 2.1, -15, 0.075, '2026-09-03'],
    ['=HYPERLINK("http://evil.example","gift")', '09999', 0, 0, 0, 'n/a'],
  ]);
  assert.ok(!sheets[0].xml.includes('<f>'), 'no formulas');
  assert.ok(sheets[0].xml.includes('state="frozen"'), 'header frozen');
  await inventory.locator('[data-action="xlsx"].is-done').waitFor();
  assert.match(await popup.locator('#status').innerText(), /Downloaded store-inventory\.xlsx/);

  await setSettings({ xlsxNumbers: false });
  const popup2 = await openPopupFor(page);
  const again = popup2.locator('.table-item').nth(1);
  await again.waitFor();
  const text = await download(popup2, () => again.locator('[data-action="xlsx"]').click());
  assert.deepEqual(readXlsx(text.bytes).sheets[0].rows[1], ['Green tea', '00731', '3.50', '1,250', '12.5%', '2026-09-01']);
});

await test('popup: column picker chooses and reorders columns for copy and .xlsx', async () => {
  const page = await open('tables.html');
  await resetClipboard(page);
  const popup = await openPopupFor(page, 'light', 760);
  const inventory = popup.locator('.table-item').nth(1);
  await inventory.waitFor();
  await inventory.locator('[data-action="columns"]').click();
  const picker = inventory.locator('.column-picker');
  await picker.waitFor();
  assert.deepEqual(await picker.locator('.picker-name').allInnerTexts(), ['Product', 'SKU', 'Price (USD)', 'Stock', 'Share', 'Updated']);
  assert.equal(await picker.locator('.picker-count').innerText(), '6 of 6');
  assert.equal(await inventory.locator('[data-action="columns"]').getAttribute('aria-expanded'), 'true');

  // Drop SKU and Updated, move Price first, then Stock above Product.
  await picker.locator('li[data-column="1"] input').uncheck();
  await picker.locator('li[data-column="5"] input').uncheck();
  await picker.locator('li[data-column="2"] [data-move="up"]').click();
  await picker.locator('li[data-column="2"] [data-move="up"]').click();
  assert.equal(await popup.evaluate(() => document.activeElement?.closest('li')?.dataset.column), '2', 'focus follows the moved column');
  await picker.locator('li[data-column="3"] [data-move="up"]').click();
  await picker.locator('li[data-column="3"] [data-move="up"]').click();
  assert.equal(await picker.locator('.picker-count').innerText(), '4 of 6');
  assert.deepEqual(await inventory.locator('.table-preview tr.header-row th').allInnerTexts(), ['Price (USD)', 'Stock', 'Product', 'Share']);
  await popup.evaluate(() => {
    const target = document.querySelectorAll('.table-item')[1];
    // Instantly: Bootstrap's smooth scrolling could leave the screenshot mid-scroll.
    window.scrollTo({ top: target.getBoundingClientRect().top + window.scrollY - 60, behavior: 'instant' });
  });
  await shot(popup, 'popup-columns', { curated: true });

  await inventory.locator('[data-format="csv"]').click();
  await inventory.locator('[data-format="csv"].is-done').waitFor();
  assert.match(await popup.locator('#status').innerText(), /\(picked columns\): 5 rows × 4 columns/);
  assert.equal(
    await clipboardText(page),
    'Price (USD),Stock,Product,Share\n3.50,"1,250",Green tea,12.5%\n4.20,980,Black coffee,40%\n2.10,−15,Oat milk,7.5%\n0,0,"=HYPERLINK(""http://evil.example"",""gift"")",0%',
  );

  await popup.bringToFront();
  const file = await download(popup, () => inventory.locator('[data-action="xlsx"]').click());
  assert.deepEqual(readXlsx(file.bytes).sheets[0].rows[0], ['Price (USD)', 'Stock', 'Product', 'Share']);
  assert.deepEqual(readXlsx(file.bytes).sheets[0].rows[1], [3.5, 1250, 'Green tea', 0.125]);

  // None selected: nothing to copy, the buttons say so by being disabled.
  await picker.locator('[data-select="none"]').click();
  assert.equal(await picker.locator('.picker-count').innerText(), '0 of 6');
  assert.ok(await inventory.locator('[data-format="csv"]').isDisabled());
  assert.ok(await inventory.locator('[data-action="xlsx"]').isDisabled());
  assert.match(await inventory.locator('.preview-slot').innerText(), /No columns selected/);
  await picker.locator('[data-select="all"]').click();
  assert.ok(await inventory.locator('[data-format="csv"]').isEnabled());

  // Closing the picker keeps the order for the next copy of this table.
  await inventory.locator('[data-action="columns"]').click();
  assert.equal(await inventory.locator('.column-picker').count(), 0);

  const dark = await openPopupFor(page, 'dark', 760);
  const darkInventory = dark.locator('.table-item').nth(1);
  await darkInventory.waitFor();
  await darkInventory.locator('[data-action="columns"]').click();
  await darkInventory.locator('.column-picker').waitFor();
  await dark.locator('.table-item').nth(1).locator('li[data-column="1"] input').uncheck();
  await dark.evaluate(() => {
    const target = document.querySelectorAll('.table-item')[1];
    // Instantly: Bootstrap's smooth scrolling could leave the screenshot mid-scroll.
    window.scrollTo({ top: target.getBoundingClientRect().top + window.scrollY - 60, behavior: 'instant' });
  });
  await shot(dark, 'popup-columns-dark', { curated: true });
});

await test('basket: tables from two pages merge into one export (copy and .xlsx)', async () => {
  const january = await open('shop-jan.html');
  await resetClipboard(january);
  const popup = await openPopupFor(january);
  await popup.locator('.table-item').first().waitFor();
  await popup.locator('.table-item').first().locator('[data-action="basket"]').click();
  await popup.locator('.basket-item').first().waitFor();
  assert.equal(await popup.locator('#basket-count').innerText(), '1');
  assert.match(await popup.locator('.basket-item').first().innerText(), /January sales[\s\S]*3 rows × 3 columns · shop\.example\.com/);
  assert.equal(await popup.locator('.basket-meta').first().innerText(), '3 rows × 3 columns · shop.example.com');

  // Adding the same table again is refused politely.
  await popup.locator('.table-item').first().locator('[data-action="basket"]').click();
  await popup.locator('#notice .alert').waitFor();
  assert.match(await popup.locator('#notice').innerText(), /Already in the basket/);

  // The second page's table comes in through the context menu.
  const february = await open('shop-feb.html');
  await select(february, '#first');
  const added = await menu(february, 'tc:basket');
  assert.equal(added.title, 'Added to the basket');
  assert.match(added.detail, /4 rows × 4 columns · 2 tables in the basket/);
  await toast(february).waitFor();
  await shot(february, 'toast-basket');
  assert.equal((await storedBasket()).length, 2);

  const popup2 = await openPopupFor(february);
  await popup2.locator('.basket-item').nth(1).waitFor();
  assert.deepEqual(await popup2.locator('.basket-title').allInnerTexts(), ['January sales', 'February sales']);
  assert.deepEqual(await popup2.locator('.basket-meta').allInnerTexts(), ['3 rows × 3 columns · shop.example.com', '4 rows × 4 columns · store.example.net']);
  assert.match(await popup2.locator('#basket-summary').innerText(), /6 rows × 6 columns/);
  await shot(popup2, 'popup-basket', { curated: true, fullPage: true });

  await popup2.locator('#basket [data-format="csv"]').click();
  await popup2.locator('#basket [data-format="csv"].is-done').waitFor();
  assert.equal(
    await clipboardText(february),
    [
      'Source,Source URL,Product,Units,Revenue,Returns',
      'January sales,http://shop.example.com/shop-jan.html,Green tea,120,420.00,',
      'January sales,http://shop.example.com/shop-jan.html,Black coffee,95,399.00,',
      'February sales,http://store.example.net/shop-feb.html,Green tea,130,455.00,2',
      'February sales,http://store.example.net/shop-feb.html,Oat milk,88,184.80,0',
      'February sales,http://store.example.net/shop-feb.html,Black coffee,101,424.20,1',
    ].join('\n'),
  );

  // Without source columns, as JSON.
  await popup2.bringToFront();
  await popup2.locator('#merge-source').uncheck();
  await waitFor(async () => (await worker.evaluate(async () => (await chrome.storage.local.get('settings')).settings?.mergeSource)) === false, 'setting saved');
  await popup2.locator('#basket [data-format="json"]').click();
  await popup2.locator('#basket [data-format="json"].is-done').waitFor();
  const json = JSON.parse(await clipboardText(february));
  assert.equal(json.length, 5);
  assert.deepEqual(json[2], { Product: 'Green tea', Units: '130', Revenue: '455.00', Returns: '2' });

  // .xlsx, stacked on one sheet.
  await popup2.bringToFront();
  const stacked = await download(popup2, () => popup2.locator('#basket-xlsx').click());
  assert.equal(stacked.name, 'merged-tables.xlsx');
  const book = readXlsx(stacked.bytes);
  assert.deepEqual(book.sheets.map((sheet) => sheet.name), ['Merged tables']);
  assert.deepEqual(book.sheets[0].rows[0], ['Product', 'Units', 'Revenue', 'Returns']);
  assert.deepEqual(book.sheets[0].rows[5], ['Black coffee', 101, 424.2, 1]);

  // .xlsx, one sheet per table, with source columns.
  await popup2.locator('#merge-source').check();
  await popup2.locator('label[for="layout-sheets"]').click();
  await waitFor(async () => (await worker.evaluate(async () => (await chrome.storage.local.get('settings')).settings?.mergeLayout)) === 'sheets', 'layout saved');
  const perTable = await download(popup2, () => popup2.locator('#basket-xlsx').click());
  const sheets = readXlsx(perTable.bytes).sheets;
  assert.deepEqual(sheets.map((sheet) => sheet.name), ['January sales', 'February sales']);
  assert.deepEqual(sheets[1].rows[0], ['Source', 'Source URL', 'Units', 'Product', 'Revenue', 'Returns']);
  assert.deepEqual(sheets[1].rows[2], ['February sales', 'http://store.example.net/shop-feb.html', 88, 'Oat milk', 184.8, 0]);

  const dark = await openPopupFor(february, 'dark');
  await dark.locator('.basket-item').nth(1).waitFor();
  await shot(dark, 'popup-basket-dark', { curated: true, fullPage: true });

  // Remove one, then clear.
  await popup2.bringToFront();
  await popup2.locator('.basket-item').first().locator('.btn-remove').click();
  await waitFor(async () => (await popup2.locator('.basket-item').count()) === 1, 'one item left');
  assert.deepEqual((await storedBasket()).map((entry) => entry.title), ['February sales']);
  await popup2.locator('#basket-clear').click();
  await popup2.locator('#basket .empty-state').waitFor();
  assert.deepEqual(await storedBasket(), []);
});

await test('basket: the popup still exports the basket on a page it cannot read', async () => {
  const january = await open('shop-jan.html');
  await select(january, '#first');
  await menu(january, 'tc:basket');
  const blocked = await open('chrome://version');
  const popup = await openPopupFor(blocked);
  await popup.locator('#notice .alert-warning').waitFor();
  assert.ok(await popup.locator('#tables-section').isHidden());
  await popup.locator('.basket-item').first().waitFor();
  const file = await download(popup, () => popup.locator('#basket-xlsx').click());
  assert.equal(file.name, 'january-sales.xlsx');
  await shot(popup.locator('body'), 'popup-unreadable');
});

await test('popup: a changed table is reported instead of copying stale data', async () => {
  const page = await open('tables.html');
  const popup = await openPopupFor(page);
  await popup.locator('.table-item').first().waitFor();
  await page.evaluate(() => document.querySelector('#pricing thead th').replaceChildren('Tier'));
  await popup.bringToFront();
  await popup.locator('.table-item').first().locator('[data-format="csv"]').click();
  await popup.locator('#notice .alert-danger').waitFor();
  assert.match(await popup.locator('#notice').innerText(), /This table has changed/);
});

await test('popup: loading skeleton, then the empty state on a page without tables', async () => {
  const busy = await open('tables.html');
  // Keep the page's main thread busy so the popup's read has to wait.
  await busy.evaluate(() =>
    setTimeout(() => {
      const started = Date.now();
      while (Date.now() - started < 2500) {}
    }, 50),
  );
  await busy.waitForTimeout(100);
  const loading = await openPopupFor(busy);
  await loading.locator('#tables .table-skeleton').first().waitFor();
  assert.equal(await loading.locator('#status').innerText(), 'Reading the page…');
  await shot(loading.locator('body'), 'popup-loading');
  await loading.locator('.table-item').first().waitFor({ timeout: 10000 });

  const page = await open('form.html');
  const popup = await openPopupFor(page);
  await popup.locator('#tables .empty-state').waitFor();
  assert.match(await popup.locator('#tables').innerText(), /No tables on this page/);
  await shot(popup.locator('body'), 'popup-empty');
});

await test('the real toolbar popup opens over the page and lists its tables', async () => {
  const probe = await newPage();
  await probe.goto(`chrome-extension://${extensionId}/options.html`);
  const page = await open('tables.html');
  await worker.evaluate(() => chrome.action.openPopup());
  await waitFor(
    () =>
      probe.evaluate(() => {
        const [popup] = chrome.extension.getViews({ type: 'popup' });
        return popup?.document.querySelectorAll('.table-item').length === 5;
      }),
    'popup lists the 5 tables of the active tab',
  );
  await page.close();
});

await test('unscriptable page: the context menu explains with a badge and the popup shows the message', async () => {
  const blocked = await open('chrome://version');
  const tab = await tabOf(blocked);
  const failed = await worker.evaluate(
    (tab) => globalThis.__tableCopyTest.onContextMenuClick({ menuItemId: 'tc:copy:csv', frameId: 0, pageUrl: 'chrome://version', editable: false, selectionText: 'x' }, tab),
    tab,
  );
  assert.equal(failed.title, "Can't read tables on this page");
  assert.equal(await worker.evaluate((id) => chrome.action.getBadgeText({ tabId: id }), tab.id), '!');
  const popup = await openPopupFor(blocked);
  await popup.locator('#notice .alert-danger').waitFor();
  assert.match(await popup.locator('#notice').innerText(), /Can't read tables on this page/);
  assert.equal(await popup.locator('#notice .alert').count(), 1, 'no duplicate warning');
  assert.equal(await worker.evaluate((id) => chrome.action.getBadgeText({ tabId: id }), tab.id), '');
});

await test('options: settings persist, About Pro explains early access, the shortcut is shown', async () => {
  const page = await newPage();
  await page.setViewportSize({ width: 900, height: 700 });
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  // init() fills the page in after load ("Not set" is the markup's placeholder): wait for the
  // shortcut and About Pro, rendered together just before the settings listeners are attached.
  await page.locator('#pro-status').filter({ hasText: /\S/ }).waitFor();
  await page.locator('#shortcut', { hasText: 'Alt+T' }).waitFor({ timeout: 5000 }).catch(() => undefined);
  assert.equal(await page.locator('#shortcut').innerText(), 'Alt+T');
  assert.ok(await page.locator('#csv-comma').isChecked(), 'en-US defaults to a comma');
  assert.ok(await page.locator('#xlsx-numbers').isChecked());
  await page.locator('#csv-semicolon').check();
  await page.locator('#save-status', { hasText: 'Saved' }).waitFor();
  await page.locator('#xlsx-numbers').uncheck();
  await waitFor(async () => (await worker.evaluate(async () => (await chrome.storage.local.get('settings')).settings?.xlsxNumbers)) === false, 'saved');
  const settings = await worker.evaluate(async () => (await chrome.storage.local.get('settings')).settings);
  assert.deepEqual(settings, { csvDelimiter: ';', xlsxNumbers: false, mergeSource: true, mergeLayout: 'stack' });
  await page.reload();
  assert.ok(await page.locator('#csv-semicolon').isChecked());
  assert.ok(!(await page.locator('#xlsx-numbers').isChecked()));
  assert.match(await page.locator('#pro').innerText(), /Download \.xlsx[\s\S]*Column picker[\s\S]*Merge tables/);
  assert.match(await page.locator('#pro-price').innerText(), /\$2\.99 one-time/);
  assert.match(await page.locator('#pro-status').innerText(), /Free during early access/);
  assert.ok(await page.locator('#get-pro').isDisabled());
  assert.match(await page.locator('.card').last().innerText(), /no network requests/);
  await page.locator('#csv-comma').check();
  await page.locator('#xlsx-numbers').check();
  await page.locator('#save-status', { hasText: 'Saved' }).waitFor();
  await shot(page, 'options-light', { curated: true, fullPage: true });
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot(page, 'options-dark', { curated: true, fullPage: true });
});

await test('strict CSP page: the toast still renders with its styles', async () => {
  const page = await open('csp.html');
  await resetClipboard(page);
  await select(page, '#pricing td');
  await menu(page, 'tc:copy:markdown');
  await toast(page).waitFor();
  const style = await toast(page).evaluate((element) => {
    const computed = getComputedStyle(element);
    return { radius: computed.borderRadius, position: computed.position };
  });
  assert.equal(style.position, 'fixed');
  assert.notEqual(style.radius, '0px');
  assert.ok((await clipboardText(page)).startsWith('| Plan | Price  | Seats | Support        |'));
});

await test('large table (5,000 rows × 8 columns) copies and downloads quickly', async () => {
  const page = await open('big-table.html');
  await resetClipboard(page);
  await select(page, '#big td');
  const started = Date.now();
  const message = await menu(page, 'tc:copy:csv');
  const elapsed = Date.now() - started;
  assert.equal(message.detail, '5,001 rows × 8 columns');
  const csv = await clipboardText(page);
  assert.equal(csv.split('\n').length, 5001);
  assert.ok(csv.endsWith('"r5000 c8, ""q"""'), csv.slice(-40));
  assert.ok(elapsed < 3000, `copy took ${elapsed} ms`);

  const popup = await openPopupFor(page);
  await popup.locator('.table-item').first().waitFor({ timeout: 10000 });
  const downloadStarted = Date.now();
  const file = await download(popup, () => popup.locator('.table-item').first().locator('[data-action="xlsx"]').click());
  const downloadElapsed = Date.now() - downloadStarted;
  const { sheets } = readXlsx(file.bytes);
  assert.equal(sheets[0].rows.length, 5001);
  assert.deepEqual(sheets[0].rows[5000].slice(0, 2), [5000, 'r5000 c2, "q"']);
  assert.ok(downloadElapsed < 5000, `xlsx took ${downloadElapsed} ms`);
  console.log(`      (5,000-row table: CSV in ${elapsed} ms, .xlsx in ${downloadElapsed} ms, ${Math.round(file.bytes.length / 1024)} KB)`);
});

await test('no network requests leave the extension', async () => {
  const requests = [];
  const listener = (request) => {
    const url = request.url();
    if (!fixtureOrigins.some((origin) => url.startsWith(`${origin}/`)) && !url.startsWith('chrome-extension://') && !url.startsWith('data:') && !url.startsWith('blob:')) requests.push(url);
  };
  context.on('request', listener);
  const page = await open('tables.html');
  await select(page, '#pricing td');
  await menu(page, 'tc:copy:json');
  await menu(page, 'tc:basket');
  const popup = await openPopupFor(page);
  await popup.locator('.table-item').first().waitFor();
  await download(popup, () => popup.locator('.table-item').first().locator('[data-action="xlsx"]').click());
  await download(popup, () => popup.locator('#basket-xlsx').click());
  context.off('request', listener);
  assert.deepEqual(requests, []);
});

// --- Summary ----------------------------------------------------------------------------

await context.close();
server.close();
await rm(userDataDir, { recursive: true, force: true });

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed. Screenshots: ${outputDir}${curate ? ` and ${screenshotsDir}` : ''}`);
process.exit(failed.length ? 1 : 0);
