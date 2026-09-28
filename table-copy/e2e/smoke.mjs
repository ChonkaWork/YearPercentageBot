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
const pageHosts = {
  'shop-jan.html': 'shop.example.com',
  'shop-feb.html': 'store.example.net',
  'grids.html': 'app.example.com',
  'orders.html': 'app.example.com',
  'transactions.html': 'app.example.com',
  'team.html': 'docs.example.org',
};
const defaultHost = 'stats.example.org';
const fixtureHosts = [...new Set([defaultHost, ...Object.values(pageHosts)])];
const fixtureOrigins = fixtureHosts.map((host) => `http://${host}`);
const fixtureUrl = (name) => `http://${pageHosts[name.split('?')[0]] ?? defaultHost}/${name}`;
/** "Open in Google Sheets" opens this; the test answers it locally (the sandbox has no Google). */
const SHEETS = 'https://sheets.new';

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
    // sheets.new goes nowhere (a closed local port): the test checks the tab, no request leaves.
    `--host-resolver-rules=${[...fixtureHosts.map((host) => `MAP ${host}:80 127.0.0.1:${port}`), 'MAP sheets.new 127.0.0.1:9'].join(',')}`,
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
const bar = (page) => page.locator('table-copy-recorder .tc-bar');
const outlineBox = (page) => page.locator('table-copy-outline .tc-outline');

/** The main export button of a card (or the basket / recording card): "Copy CSV", "Download .xlsx"... */
const exportMain = (scope) => scope.locator('.export-control [data-action="copy"]').first();

/** Opens a card's Copy ▾ menu and picks an item. */
async function exportMenu(scope, action) {
  await scope.locator('.export-control [data-action="menu"]').first().click();
  await scope.locator(`.export-menu.show [data-action="${action}"]`).click();
}

async function storedSettings() {
  return worker.evaluate(async () => (await chrome.storage.local.get('settings')).settings ?? {});
}

/** Picks a format in the popup header and waits until it's saved. */
async function setFormat(popup, format) {
  await popup.locator(`label[for="format-${format}"]`).click();
  await waitFor(async () => (await storedSettings()).format === format, `format ${format} saved`);
  await popup.locator(`.export-control [data-action="copy"][data-format="${format}"]`).first().waitFor();
}

async function storedRecording() {
  return worker.evaluate(async () => (await chrome.storage.local.get('recording')).recording ?? null);
}

/** The first number in the bar's counter ("1,284 of 2,400 rows" -> 1284). */
async function barRows(page) {
  const text = await bar(page).locator('.tc-count').innerText().catch(() => '');
  return Number((/^[\d,]+/.exec(text)?.[0] ?? '-1').replace(/,/g, ''));
}

/**
 * Scrolls the virtualized orders grid like a user would: waits until the grid rendered the
 * new position, then until the recorder caught up with every row rendered so far.
 */
async function scrollOrders(page, row) {
  const start = await page.evaluate((top) => {
    const viewport = document.getElementById('viewport');
    viewport.scrollTop = top;
    return window.__startFor(viewport.scrollTop);
  }, row * 34);
  await page.waitForFunction((start) => window.__start === start, start);
  await waitFor(async () => (await barRows(page)) === (await page.evaluate(() => window.__seen.size)), `recorder caught up at row ${row}`);
}

async function shot(target, name, { curated = false, keepFocus = false, ...options } = {}) {
  // No half-finished CSS transitions in screenshots.
  const page = typeof target.page === 'function' ? target.page() : target;
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.mouse.move(0, 0); // no hover state left over from the last click
  // No focus ring left over from the last click either (unless the shot is about the keyboard).
  if (!keepFocus) await page.evaluate(() => document.activeElement?.blur?.());
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
  const recorder = await readFile(join(root, 'dist/recorder.js'), 'utf8');
  const options = await readFile(join(root, 'dist/options.js'), 'utf8');
  assert.ok(!background.includes('__tableCopyTest'), 'test hook compiled out');
  assert.ok(!popup.includes('URLSearchParams'), 'popup tab override compiled out');
  for (const script of [page, recorder]) assert.ok(script.includes('"closed"') && !script.includes('mode: "open"'), 'in-page shadow roots are closed');
  const namespaces = /https?:\/\/(?:www\.w3\.org|schemas\.openxmlformats\.org)\//g;
  for (const file of [background, popup, page, recorder, options]) {
    // The only web address: the tab "Open in Google Sheets" opens (no request is made by the extension).
    const code = file.replace(/\/\/.*$/gm, '').replace(namespaces, '').replace(`"${SHEETS}"`, '');
    assert.ok(!/https?:\/\/[a-z]/i.test(code), 'no remote URLs');
    assert.ok(!/\bfetch\(|XMLHttpRequest|WebSocket|sendBeacon/.test(file), 'no network APIs');
  }
  assert.ok(popup.includes(`"${SHEETS}"`), 'Open in Google Sheets opens sheets.new');
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

await test('context menu without a selection: a right-click picks the table under it (caret or focused grid cell)', async () => {
  // The menu shows on a plain right-click ("page") and on links, not only on selected text.
  assert.deepEqual(await worker.evaluate(() => globalThis.__tableCopyTest.menuContexts), ['selection', 'page', 'link']);

  const page = await open('tables.html');
  await resetClipboard(page);
  const cell = await page.locator('#inventory tbody tr:nth-child(2) td:nth-child(3)').boundingBox();
  await page.mouse.click(cell.x + 8, cell.y + cell.height / 2, { button: 'right' });
  const copied = await menu(page, 'tc:copy:csv');
  assert.equal(copied.title, 'Copied table as CSV');
  assert.equal(copied.detail, 'Store inventory · 5 rows × 6 columns', 'names the table it picked');
  assert.ok((await clipboardText(page)).startsWith('Product,SKU,Price (USD),Stock,Share,Updated\nGreen tea,00731,3.50,"1,250",12.5%,2026-09-01'));

  // Outside every table: a clear error, the clipboard stays as it was.
  await resetClipboard(page);
  const intro = await page.locator('#intro').boundingBox();
  await page.mouse.click(intro.x + 20, intro.y + intro.height / 2, { button: 'right' });
  const none = await menu(page, 'tc:copy:csv');
  assert.equal(none.title, 'No table here');
  assert.equal(await clipboardText(page), '<empty>');

  // AG Grid-like cells can't be selected (user-select: none) but take focus on right-click.
  const grids = await open('grids.html');
  await resetClipboard(grids);
  const usa = await grids.locator('#usa').boundingBox();
  await grids.mouse.click(usa.x + 10, usa.y + usa.height / 2, { button: 'right' });
  assert.equal(await grids.evaluate(() => document.activeElement?.id), 'usa');
  const fromGrid = await menu(grids, 'tc:copy:tsv');
  assert.equal(fromGrid.detail, 'Olympic winners · 5 rows × 4 columns');
  assert.equal(await clipboardText(grids), '\t\tMedals\tMedals\nAthlete\tCountry\tGold\tSilver\nMichael Phelps\tUnited States\t8\t0\nNatalie Coughlin\tUnited States\t3\t2\nAleksey Nemov\tRussia\t2\t1');
});

await test('ARIA grids (AG Grid, MUI DataGrid): listed, previewed and copied like tables', async () => {
  const page = await open('grids.html');
  await resetClipboard(page);
  const popup = await openPopupFor(page);
  await popup.locator('.table-item').nth(1).waitFor();
  assert.deepEqual(await popup.locator('.table-item .table-title').allInnerTexts(), ['Olympic winners', 'Recent orders']);
  assert.deepEqual(await popup.locator('.table-item .table-dims').allInnerTexts(), ['5 × 4', '4 × 3']);
  const ag = popup.locator('.table-item').first();
  assert.deepEqual(await ag.locator('.table-preview thead th').allTextContents(), ['Athlete', 'Country', 'Medals / Gold', 'Medals / Silver']);
  assert.deepEqual(await ag.locator('.table-preview tbody tr').first().locator('td').allTextContents(), ['Michael Phelps', 'United States', '8', '0']);
  assert.deepEqual(await popup.locator('.table-item').nth(1).locator('.table-preview thead th').allTextContents(), ['Order', 'Customer', 'Total']);

  await exportMain(ag).click();
  await ag.locator('.export-main.is-done').waitFor();
  assert.equal(
    await clipboardText(page),
    ',,Medals,Medals\nAthlete,Country,Gold,Silver\nMichael Phelps,United States,8,0\nNatalie Coughlin,United States,3,2\nAleksey Nemov,Russia,2,1',
  );

  // Selected text inside a grid works with the context menu too.
  await select(page, '#order-1001');
  const json = await menu(page, 'tc:copy:json');
  assert.equal(json.detail, '4 rows × 3 columns');
  assert.deepEqual(JSON.parse(await clipboardText(page)), [
    { Order: '#1001', Customer: 'Olena Kovalenko', Total: '$120.00' },
    { Order: '#1002', Customer: 'Marco Rossi', Total: '$89.50' },
    { Order: '#1003', Customer: 'Aiko Tanaka', Total: '$240.10' },
  ]);
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
  assert.deepEqual(await pricing.locator('.table-preview thead th').allInnerTexts(), ['Plan', 'Price', 'Seats', 'Support']);
  assert.equal(await popup.locator('.table-item').nth(2).locator('.table-dims').innerText(), '5 × 4');
  // Grouped headers show as they export, never cut: what doesn't fit is counted.
  const spans = popup.locator('.table-item').nth(2);
  const headers = await spans.locator('.table-preview thead th').evaluateAll((cells) => cells.map((cell) => ({ text: cell.textContent, title: cell.title, hidden: cell.hidden, cut: cell.firstElementChild.scrollWidth > cell.firstElementChild.clientWidth })));
  assert.deepEqual(headers.map((header) => header.text), ['Region', 'City', 'Population / 2010', 'Population / 2020']);
  for (const header of headers) {
    assert.equal(header.title, header.text);
    assert.equal(header.cut, false, `${header.text} is not cut off`);
  }
  const shownColumns = headers.filter((header) => !header.hidden).length;
  if (shownColumns < 4) assert.equal(await spans.locator('.more-columns').innerText(), `+${4 - shownColumns} ${4 - shownColumns === 1 ? 'column' : 'columns'}`);
  else assert.ok(await spans.locator('.more-columns').isHidden());
  assert.match(await popup.locator('#shortcut-text').innerText(), /Alt\+T opens Table Copy/);
  assert.match(await popup.locator('#basket').innerText(), /Add tables from this page or others/);
  // One action row per card: Copy ▾ and three icon tools; PRO shown once (the basket), no locks in early access.
  assert.deepEqual(await pricing.locator('.table-actions > *').evaluateAll((nodes) => nodes.map((node) => node.dataset.action ?? node.className)), ['btn-group export-control', 'columns', 'record', 'basket']);
  assert.equal(await pricing.locator('[data-action="columns"]').getAttribute('aria-label'), 'Choose columns of Pricing');
  assert.equal(await pricing.locator('[data-action="record"]').getAttribute('data-tip'), 'Record rows · Pro');
  assert.equal(await popup.locator('.pro-badge:visible').count(), 1);
  assert.equal(await popup.locator('.lock-mark').count(), 0);
  assert.ok(await popup.locator('#format-csv').isChecked(), 'CSV by default');
  await shot(popup.locator('body'), 'popup-light', { curated: true });

  await exportMain(pricing).click();
  await pricing.locator('.export-main.is-done').waitFor();
  assert.match(await popup.locator('#status').innerText(), /Copied Pricing as CSV: 4 rows × 4 columns/);
  assert.equal(await clipboardText(page), 'Plan,Price,Seats,Support\nFree,$0,1,\nPro,$12/mo,5,Email\nTeam,$30/mo,25,"Priority, 24/7"');

  await popup.bringToFront();
  await setFormat(popup, 'tsv');
  assert.equal(await exportMain(spans).innerText(), 'Copy TSV');
  await exportMain(spans).click();
  await spans.locator('.export-main.is-done').waitFor();
  assert.ok((await clipboardHtml(page))?.includes('<th>Population</th><th>Population</th>'));
  assert.ok((await clipboardText(page)).startsWith('Region\tCity\tPopulation\tPopulation\nRegion\tCity\t2010\t2020\n'));

  await setSettings({ format: 'csv' });
  const dark = await openPopupFor(page, 'dark');
  await dark.locator('.table-item').first().waitFor();
  await shot(dark.locator('body'), 'popup-dark', { curated: true });
});

await test('popup: the format switch is remembered; Copy ▾ downloads CSV, Markdown and JSON files (free)', async () => {
  const page = await open('tables.html');
  await resetClipboard(page);
  const popup = await openPopupFor(page);
  const pricing = popup.locator('.table-item').first();
  await pricing.waitFor();
  await setFormat(popup, 'json');
  assert.equal(await exportMain(pricing).innerText(), 'Copy JSON');
  await exportMain(pricing).click();
  await pricing.locator('.export-main.is-done').waitFor();
  assert.deepEqual(JSON.parse(await clipboardText(page))[0], { Plan: 'Free', Price: '$0', Seats: '1', Support: '' });

  // Remembered the next time the popup opens.
  const again = await openPopupFor(page);
  const pricing2 = again.locator('.table-item').first();
  await pricing2.waitFor();
  assert.ok(await again.locator('#format-json').isChecked());
  assert.equal(await exportMain(pricing2).innerText(), 'Copy JSON');

  // The menu: keyboard opens it on the first item, Escape closes it and returns focus.
  const toggle = pricing2.locator('[data-action="menu"]');
  await toggle.focus();
  await again.keyboard.press('ArrowDown');
  await pricing2.locator('.export-menu.show').waitFor();
  assert.equal(await again.evaluate(() => document.activeElement?.dataset.action), 'download');
  assert.deepEqual(await pricing2.locator('.export-menu .dropdown-item').allInnerTexts(), ['Download .json file', 'Open in Google Sheets', 'Keep links']);
  assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
  await shot(again.locator('body'), 'popup-menu', { curated: true, keepFocus: true });
  await again.keyboard.press('Escape');
  assert.ok(await pricing2.locator('.export-menu').isHidden());
  assert.equal(await again.evaluate(() => document.activeElement?.dataset.action), 'menu');

  const json = await download(again, () => exportMenu(pricing2, 'download'));
  assert.equal(json.name, 'pricing.json');
  assert.equal(JSON.parse(json.bytes.toString('utf8')).length, 3);

  await setFormat(again, 'csv');
  const csv = await download(again, () => exportMenu(pricing2, 'download'));
  assert.equal(csv.name, 'pricing.csv');
  assert.deepEqual([...csv.bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'UTF-8 byte order mark for Excel');
  assert.equal(csv.bytes.toString('utf8'), '﻿Plan,Price,Seats,Support\nFree,$0,1,\nPro,$12/mo,5,Email\nTeam,$30/mo,25,"Priority, 24/7"\n');
  assert.match(await again.locator('#status').innerText(), /Downloaded pricing\.csv: 4 rows × 4 columns/);

  await setFormat(again, 'markdown');
  const inventory = again.locator('.table-item').nth(1);
  const md = await download(again, () => exportMenu(inventory, 'download'));
  assert.equal(md.name, 'store-inventory.md');
  assert.ok(md.bytes.toString('utf8').startsWith('| Product '), md.bytes.toString('utf8'));
});

await test('popup: Download .xlsx saves a real workbook with numbers as numbers', async () => {
  const page = await open('tables.html');
  const popup = await openPopupFor(page);
  const inventory = popup.locator('.table-item').nth(1);
  await inventory.waitFor();
  await setFormat(popup, 'xlsx');
  assert.equal(await exportMain(inventory).innerText(), 'Download .xlsx');
  const file = await download(popup, () => exportMain(inventory).click());
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
  await inventory.locator('.export-main.is-done').waitFor();
  assert.match(await popup.locator('#status').innerText(), /Downloaded store-inventory\.xlsx/);

  await setSettings({ xlsxNumbers: false });
  const popup2 = await openPopupFor(page);
  const again = popup2.locator('.table-item').nth(1);
  await again.waitFor();
  const text = await download(popup2, () => exportMain(again).click());
  assert.deepEqual(readXlsx(text.bytes).sheets[0].rows[1], ['Green tea', '00731', '3.50', '1,250', '12.5%', '2026-09-01']);
});

await test('Keep links: a "<Column> URL" column in CSV and .xlsx, [text](url) in Markdown', async () => {
  const page = await open('team.html');
  await resetClipboard(page);
  await select(page, '#first');
  await menu(page, 'tc:copy:csv');
  assert.equal(await clipboardText(page), 'Name,Area,Repository\nOlena Kovalenko,Parser,parser\nMarco Rossi,"Docs, guides",site\nAiko Tanaka,Releases,releases@example.org');

  await setSettings({ keepLinks: true });
  await select(page, '#first');
  await menu(page, 'tc:copy:csv');
  assert.equal(
    await clipboardText(page),
    [
      'Name,Name URL,Area,Repository,Repository URL',
      // Tracking parameters are removed; a cell with text around its link, and mailto: links, get no URL.
      'Olena Kovalenko,http://docs.example.org/people/olena,Parser,parser,https://code.example.com/parser',
      'Marco Rossi,http://docs.example.org/people/marco,"Docs, guides",site,https://code.example.com/site',
      'Aiko Tanaka,,Releases,releases@example.org,',
    ].join('\n'),
  );
  await select(page, '#first');
  await menu(page, 'tc:copy:markdown');
  assert.ok((await clipboardText(page)).includes('| [Olena Kovalenko](http://docs.example.org/people/olena) | Parser '), await clipboardText(page));

  // The popup's Copy menu shows and toggles the setting; .xlsx gets the URL column too.
  const popup = await openPopupFor(page);
  const team = popup.locator('.table-item').first();
  await team.waitFor();
  await team.locator('[data-action="menu"]').click();
  assert.equal(await team.locator('.export-menu [data-action="links"]').getAttribute('aria-checked'), 'true');
  await popup.keyboard.press('Escape');
  await setFormat(popup, 'xlsx');
  const file = await download(popup, () => exportMain(team).click());
  assert.deepEqual(readXlsx(file.bytes).sheets[0].rows[1], ['Olena Kovalenko', 'http://docs.example.org/people/olena', 'Parser', 'parser', 'https://code.example.com/parser']);
  await exportMenu(team, 'links');
  await waitFor(async () => (await storedSettings()).keepLinks === false, 'Keep links switched off');
  await team.locator('[data-action="menu"]').click();
  assert.equal(await team.locator('.export-menu [data-action="links"]').getAttribute('aria-checked'), 'false');
});

await test('Open in Google Sheets copies the table as TSV and opens sheets.new (Google itself unverified)', async () => {
  const page = await open('tables.html');
  await resetClipboard(page);
  const popup = await openPopupFor(page);
  const pricing = popup.locator('.table-item').first();
  await pricing.waitFor();
  await exportMenu(pricing, 'sheets');
  await popup.locator('#notice [data-key="sheets"]').waitFor();
  assert.match(await popup.locator('#notice').innerText(), /Paste with Ctrl\+V/);
  await waitFor(
    async () => (await worker.evaluate(async () => (await chrome.tabs.query({})).map((tab) => tab.url ?? tab.pendingUrl))).includes(`${SHEETS}/`),
    'a new tab at sheets.new',
  );
  assert.equal(await clipboardText(page), 'Plan\tPrice\tSeats\tSupport\nFree\t$0\t1\t\nPro\t$12/mo\t5\tEmail\nTeam\t$30/mo\t25\tPriority, 24/7');
  assert.ok((await clipboardHtml(page))?.includes('<td>Priority, 24/7</td>'), 'pastes as cells');
  for (const tab of context.pages().filter((candidate) => !openPages.has(candidate) && candidate.url().startsWith('chrome-error'))) await tab.close();
});

await test('popup: hovering or focusing a card outlines its table on the page; closing the popup removes it', async () => {
  const page = await open('tables.html');
  await page.setViewportSize({ width: 1280, height: 520 });
  await page.emulateMedia({ reducedMotion: 'reduce' }); // jump instead of smooth-scrolling
  const popup = await openPopupFor(page);
  await popup.locator('.table-item').nth(4).waitFor();
  const near = (a, b) => Math.abs(a - b) <= 6;
  const matches = async (selector) => {
    const box = await outlineBox(page).boundingBox();
    const rect = await page.locator(selector).boundingBox();
    return Boolean(box && rect && near(box.x, rect.x - 4) && near(box.y, rect.y - 4) && near(box.width, rect.width + 8) && near(box.height, rect.height + 8));
  };
  // The last table is below the fold: hovering its card scrolls it into view.
  await popup.locator('.table-item').nth(4).hover();
  await outlineBox(page).waitFor();
  await waitFor(() => matches('#plain'), 'outline around the last table');
  await waitFor(async () => {
    const plain = await page.locator('#plain').boundingBox();
    return plain.y >= 0 && plain.y + plain.height <= 520;
  }, 'scrolled into view');

  // Keyboard focus moves the outline too.
  await popup.mouse.move(0, 0);
  await popup.locator('.table-item').first().locator('[data-action="copy"]').focus();
  await waitFor(() => matches('#pricing'), 'outline follows the focused card');
  assert.equal(await page.locator('table-copy-outline').count(), 1);
  await shot(page, 'page-outline', { curated: true, keepFocus: true });

  await popup.close();
  openPages.delete(popup);
  await waitFor(async () => (await page.locator('table-copy-outline').count()) === 0, 'outline removed when the popup closes');
});

await test('popup: column picker filters, drags and reorders columns for copy and .xlsx', async () => {
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
  assert.equal(await picker.locator('.drag-handle').count(), 6);

  // Drop SKU and Updated, move Price first, then Stock above Product.
  await picker.locator('li[data-column="1"] input').uncheck();
  await picker.locator('li[data-column="5"] input').uncheck();
  await picker.locator('li[data-column="2"] [data-move="up"]').click();
  await picker.locator('li[data-column="2"] [data-move="up"]').click();
  assert.equal(await popup.evaluate(() => document.activeElement?.closest('li')?.dataset.column), '2', 'focus follows the moved column');
  await picker.locator('li[data-column="3"] [data-move="up"]').click();
  await picker.locator('li[data-column="3"] [data-move="up"]').click();
  assert.equal(await picker.locator('.picker-count').innerText(), '4 of 6');
  assert.deepEqual(await inventory.locator('.table-preview thead th').allTextContents(), ['Price (USD)', 'Stock', 'Product', 'Share']);

  // Filter: only matching columns are listed; "None" applies to them only.
  await picker.locator('.picker-filter').fill('pr');
  assert.deepEqual(await picker.locator('.picker-name').allInnerTexts(), ['Price (USD)', 'Product']);
  await picker.locator('.picker-filter').fill('zzz');
  assert.match(await picker.locator('.picker-empty').innerText(), /No column matches "zzz"/);
  await picker.locator('.picker-filter').fill('');
  assert.equal(await picker.locator('.picker-row').count(), 6);

  // Drag Share (by its handle) above Stock.
  await picker.locator('li[data-column="4"] .drag-handle').dragTo(picker.locator('li[data-column="3"]'), { targetPosition: { x: 40, y: 3 } });
  assert.deepEqual(await inventory.locator('.table-preview thead th').allTextContents(), ['Price (USD)', 'Share', 'Stock', 'Product']);
  await popup.evaluate(() => {
    const target = document.querySelectorAll('.table-item')[1];
    // Instantly: Bootstrap's smooth scrolling could leave the screenshot mid-scroll.
    window.scrollTo({ top: target.getBoundingClientRect().top + window.scrollY - 60, behavior: 'instant' });
  });
  await shot(popup, 'popup-columns', { curated: true });

  await exportMain(inventory).click();
  await inventory.locator('.export-main.is-done').waitFor();
  assert.match(await popup.locator('#status').innerText(), /\(picked columns\): 5 rows × 4 columns/);
  assert.equal(
    await clipboardText(page),
    'Price (USD),Share,Stock,Product\n3.50,12.5%,"1,250",Green tea\n4.20,40%,980,Black coffee\n2.10,7.5%,−15,Oat milk\n0,0%,0,"=HYPERLINK(""http://evil.example"",""gift"")"',
  );

  await popup.bringToFront();
  await setFormat(popup, 'xlsx');
  const file = await download(popup, () => exportMain(inventory).click());
  assert.deepEqual(readXlsx(file.bytes).sheets[0].rows[0], ['Price (USD)', 'Share', 'Stock', 'Product']);
  assert.deepEqual(readXlsx(file.bytes).sheets[0].rows[1], [3.5, 0.125, 1250, 'Green tea']);

  // None selected: nothing to export, the buttons say so by being disabled.
  await picker.locator('[data-select="none"]').click();
  assert.equal(await picker.locator('.picker-count').innerText(), '0 of 6');
  assert.ok(await exportMain(inventory).isDisabled());
  assert.ok(await inventory.locator('[data-action="basket"]').isDisabled());
  assert.match(await inventory.locator('.preview-slot').innerText(), /No columns selected/);
  await picker.locator('[data-select="all"]').click();
  assert.ok(await exportMain(inventory).isEnabled());

  // Closing the picker keeps the order for the next copy of this table.
  await inventory.locator('[data-action="columns"]').click();
  assert.equal(await inventory.locator('.column-picker').count(), 0);

  await setSettings({ format: 'csv' });
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

await test('basket: tables from two pages merge into one export, with a preview of how columns line up', async () => {
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
  // Preview of the merged table, and which columns matched by header vs only some tables have.
  assert.deepEqual(await popup2.locator('.basket-preview thead th').allTextContents(), ['Product', 'Units', 'Revenue', 'Returns']);
  assert.deepEqual(await popup2.locator('.basket-preview tbody tr').first().locator('td').allTextContents(), ['Green tea', '120', '420.00', '']);
  assert.deepEqual(await popup2.locator('.merge-column .merge-name').allTextContents(), ['Product', 'Units', 'Revenue', 'Returns']);
  assert.deepEqual(await popup2.locator('.merge-column .merge-count').allTextContents(), ['2/2', '2/2', '2/2', '1/2']);
  assert.deepEqual(await popup2.locator('.merge-column.is-partial .merge-name').allInnerTexts(), ['Returns']);
  assert.equal(await popup2.locator('.merge-column.is-partial').getAttribute('title'), 'Only in February sales; empty for the others');
  assert.equal(await popup2.locator('.merge-note').innerText(), '3 matched by header, 1 only in some tables (left empty elsewhere). Source and Source URL come first.');
  await shot(popup2, 'popup-basket', { curated: true, fullPage: true });

  await exportMain(popup2.locator('#basket')).click();
  await popup2.locator('#basket .export-main.is-done').waitFor();
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
  await waitFor(async () => (await storedSettings()).mergeSource === false, 'setting saved');
  await setFormat(popup2, 'json');
  await exportMain(popup2.locator('#basket')).click();
  await popup2.locator('#basket .export-main.is-done').waitFor();
  const json = JSON.parse(await clipboardText(february));
  assert.equal(json.length, 5);
  assert.deepEqual(json[2], { Product: 'Green tea', Units: '130', Revenue: '455.00', Returns: '2' });

  // .xlsx, stacked on one sheet (the layout choice appears with the .xlsx format).
  await popup2.bringToFront();
  assert.equal(await popup2.locator('label[for="layout-sheets"]').count(), 0);
  await setFormat(popup2, 'xlsx');
  const stacked = await download(popup2, () => exportMain(popup2.locator('#basket')).click());
  assert.equal(stacked.name, 'merged-tables.xlsx');
  const book = readXlsx(stacked.bytes);
  assert.deepEqual(book.sheets.map((sheet) => sheet.name), ['Merged tables']);
  assert.deepEqual(book.sheets[0].rows[0], ['Product', 'Units', 'Revenue', 'Returns']);
  assert.deepEqual(book.sheets[0].rows[5], ['Black coffee', 101, 424.2, 1]);

  // .xlsx, one sheet per table, with source columns.
  await popup2.locator('#merge-source').check();
  await popup2.locator('label[for="layout-sheets"]').click();
  await waitFor(async () => (await storedSettings()).mergeLayout === 'sheets', 'layout saved');
  const perTable = await download(popup2, () => exportMain(popup2.locator('#basket')).click());
  const sheets = readXlsx(perTable.bytes).sheets;
  assert.deepEqual(sheets.map((sheet) => sheet.name), ['January sales', 'February sales']);
  assert.deepEqual(sheets[1].rows[0], ['Source', 'Source URL', 'Units', 'Product', 'Revenue', 'Returns']);
  assert.deepEqual(sheets[1].rows[2], ['February sales', 'http://store.example.net/shop-feb.html', 88, 'Oat milk', 184.8, 0]);

  await setSettings({ format: 'csv' });
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
  await setSettings({ format: 'xlsx' });
  const blocked = await open('chrome://version');
  const popup = await openPopupFor(blocked);
  await popup.locator('#notice .alert-warning').waitFor();
  assert.ok(await popup.locator('#tables-section').isHidden());
  await popup.locator('.basket-item').first().waitFor();
  const file = await download(popup, () => exportMain(popup.locator('#basket')).click());
  assert.equal(file.name, 'january-sales.xlsx');
  await shot(popup.locator('body'), 'popup-unreadable');
});

await test('Record rows: a virtualized grid (20 of 500 rows in the DOM) is recorded while the user scrolls', async () => {
  const orders = await open('orders.html');
  await resetClipboard(orders);
  const popup = await openPopupFor(orders);
  const card = popup.locator('.table-item').first();
  await card.waitFor();
  assert.equal(await card.locator('.table-title').innerText(), 'All orders');
  assert.match(await card.locator('.rows-hint').innerText(), /Only 20 of 500 rows are loaded\. Record rows collects them as you scroll\./);
  await shot(popup.locator('body'), 'popup-grid', { curated: true });

  await card.locator('[data-action="record"]').click();
  await bar(orders).waitFor();
  assert.match(await bar(orders).innerText(), /Recording\s+20 of 500 rows/);
  assert.equal(await orders.locator('table-copy-outline').count(), 1, 'the recorded table is outlined');
  // The popup (a tab in this test) shows the live recording.
  await popup.locator('#recording-section .recording-card.is-live').waitFor();

  // The user jumps to the end, then scrolls down from the top. The grid appends rows in
  // whatever order it renders them; the recording keeps aria-rowindex order.
  await orders.bringToFront();
  await scrollOrders(orders, 480);
  for (let row = 15; row < 500; row += 15) await scrollOrders(orders, row);
  assert.equal(await bar(orders).locator('.tc-count').innerText(), '500 of 500 rows');

  await bar(orders).locator('[data-action="stop"]').click();
  await bar(orders).locator('[data-action="copy-csv"]').waitFor();
  assert.match(await bar(orders).innerText(), /Recorded 500 rows/);
  assert.equal(await orders.locator('table-copy-outline').count(), 0);

  await bar(orders).locator('[data-action="copy-csv"]').click();
  await bar(orders).locator('[data-action="copy-csv"].tc-done').waitFor();
  const lines = (await clipboardText(orders)).split('\n');
  assert.equal(lines.length, 501);
  assert.equal(lines[0], 'Order,Customer,Country,Status,Total,Date');
  assert.equal(lines[1], '#48210,Olena Kovalenko,Ukraine,Paid,$12.00,2026-09-27');
  const ids = lines.slice(1).map((line) => Number(line.slice(1, 6)));
  assert.deepEqual(ids, Array.from({ length: 500 }, (_, n) => 48210 - n), 'every row once, in order');

  await orders.bringToFront();
  const file = await download(orders, () => bar(orders).locator('[data-action="xlsx"]').click());
  assert.equal(file.name, 'all-orders.xlsx');
  const sheet = readXlsx(file.bytes).sheets[0];
  assert.equal(sheet.name, 'All orders');
  assert.equal(sheet.rows.length, 501);
  const last = await orders.evaluate(() => Object.values(order(499)));
  assert.deepEqual(sheet.rows[500], last);
  assert.equal(sheet.rows[500][0], '#47711');

  await bar(orders).locator('[data-action="basket"]').click();
  await bar(orders).locator('[data-action="basket"].tc-done').waitFor();
  const basket = await storedBasket();
  assert.equal(basket.length, 1);
  assert.equal(basket[0].rows.length, 500);
  assert.equal(basket[0].title, 'All orders');

  // The popup keeps the finished recording with its exports until it's discarded.
  const again = await openPopupFor(orders);
  await again.locator('#recording-section .recording-card').waitFor();
  assert.match(await again.locator('#recording-section').innerText(), /All orders[\s\S]*500 rows × 6 columns[\s\S]*Recorded on app\.example\.com/);
  await bar(orders).locator('[data-action="close"]').click();
  assert.equal(await orders.locator('table-copy-recorder').count(), 0);
});

await test('Record rows: a table paginated with its own Next button, duplicates within a page kept', async () => {
  const ledger = await open('transactions.html');
  await ledger.waitForFunction(() => window.__page === 1);
  await resetClipboard(ledger);
  const popup = await openPopupFor(ledger);
  const card = popup.locator('.table-item').first();
  await card.waitFor();
  await card.locator('[data-action="record"]').click();
  await bar(ledger).waitFor();
  assert.equal(await bar(ledger).locator('.tc-count').innerText(), '10 rows');

  await ledger.bringToFront();
  for (const expected of [20, 30]) {
    await ledger.locator('#next').click();
    await waitFor(async () => (await barRows(ledger)) === expected, `${expected} rows after Next`);
  }
  // Going back to a page seen before adds nothing.
  await ledger.locator('#prev').click();
  await ledger.waitForFunction(() => window.__page === 2);
  await bar(ledger).locator('[data-action="stop"]').click();
  await bar(ledger).locator('[data-action="copy-tsv"]').waitFor();
  assert.match(await bar(ledger).innerText(), /Recorded 30 rows/);

  await bar(ledger).locator('[data-action="copy-tsv"]').click();
  await bar(ledger).locator('[data-action="copy-tsv"].tc-done').waitFor();
  const pages = await ledger.evaluate(() => window.__pages);
  const expected = ['Date\tDescription\tCategory\tAmount', ...pages.flat().map((cells) => cells.join('\t'))];
  assert.deepEqual((await clipboardText(ledger)).split('\n'), expected);
  assert.equal(expected.filter((line) => line === '2026-09-18\tCorner Coffee\tFood\t−3.50').length, 2, 'both identical coffees kept');
});

await test('Record rows: when the page navigates, the recording ends, says so and keeps its rows', async () => {
  const ledger = await open('transactions.html');
  await ledger.waitForFunction(() => window.__page === 1);
  const popup = await openPopupFor(ledger);
  await popup.locator('.table-item').first().waitFor();
  await popup.locator('.table-item').first().locator('[data-action="record"]').click();
  await bar(ledger).waitFor();
  await waitFor(async () => (await storedRecording())?.rowCount === 10, 'recording saved');
  await ledger.goto(fixtureUrl('transactions.html?view=reloaded'));
  await ledger.waitForFunction(() => window.__page === 1);

  const after = await openPopupFor(ledger);
  const section = after.locator('#recording-section');
  await section.locator('.recording-card').waitFor();
  assert.match(await section.innerText(), /Card transactions[\s\S]*10 rows × 4 columns[\s\S]*The page navigated away, so the recording ended\. The 10 rows recorded before are kept\./);
  assert.equal((await storedRecording()).ended, 'navigated');
  await shot(after.locator('body'), 'popup-recording', { curated: true });
  await resetClipboard(ledger);
  await after.bringToFront();
  await exportMain(section).click();
  await section.locator('.export-main.is-done').waitFor();
  assert.equal((await clipboardText(ledger)).split('\n').length, 11);

  await section.locator('#recording-discard').click();
  await waitFor(() => section.isHidden(), 'recording section hidden');
  assert.equal(await storedRecording(), null);
});

await test('Record rows: dashboard screenshot with the live counter', async () => {
  const orders = await open('orders.html?rows=2400');
  const popup = await openPopupFor(orders);
  await popup.locator('.table-item').first().waitFor();
  await popup.locator('.table-item').first().locator('[data-action="record"]').click();
  await bar(orders).waitFor();
  await orders.bringToFront();
  for (let row = 15; row < 1264; row += 15) await scrollOrders(orders, row);
  await scrollOrders(orders, 1264);
  assert.equal(await bar(orders).locator('.tc-count').innerText(), '1,284 of 2,400 rows');
  await shot(orders, 'record-live', { curated: true });
  await bar(orders).locator('[data-action="stop"]').click();
  await bar(orders).locator('[data-action="copy-csv"]').waitFor();
  await shot(orders, 'record-done', { curated: true });
});

await test('popup: a changed table is reported instead of copying stale data', async () => {
  const page = await open('tables.html');
  const popup = await openPopupFor(page);
  await popup.locator('.table-item').first().waitFor();
  await page.evaluate(() => document.querySelector('#pricing thead th').replaceChildren('Tier'));
  await popup.bringToFront();
  await exportMain(popup.locator('.table-item').first()).click();
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
  assert.ok(!(await page.locator('#keep-links').isChecked()), 'Keep links is off by default');
  await page.locator('#csv-semicolon').check();
  await page.locator('#save-status', { hasText: 'Saved' }).waitFor();
  await page.locator('#xlsx-numbers').uncheck();
  await waitFor(async () => (await storedSettings()).xlsxNumbers === false, 'saved');
  await page.locator('#keep-links').check();
  await waitFor(async () => (await storedSettings()).keepLinks === true, 'saved');
  const settings = await storedSettings();
  assert.deepEqual(settings, { csvDelimiter: ';', xlsxNumbers: false, mergeSource: true, mergeLayout: 'stack', format: 'csv', keepLinks: true });
  await page.reload();
  assert.ok(await page.locator('#csv-semicolon').isChecked());
  assert.ok(!(await page.locator('#xlsx-numbers').isChecked()));
  assert.ok(await page.locator('#keep-links').isChecked());
  assert.match(await page.locator('#pro').innerText(), /Record rows[\s\S]*Download \.xlsx[\s\S]*Column picker[\s\S]*Merge tables/);
  assert.match(await page.locator('#pro-price').innerText(), /\$2\.99 one-time/);
  assert.match(await page.locator('#pro-status').innerText(), /Free during early access/);
  assert.ok(await page.locator('#get-pro').isDisabled());
  assert.match(await page.locator('.card').last().innerText(), /no network requests/);
  await page.locator('#csv-comma').check();
  await page.locator('#xlsx-numbers').check();
  await page.locator('#keep-links').uncheck();
  await waitFor(async () => (await storedSettings()).keepLinks === false, 'saved');
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

  await setSettings({ format: 'xlsx' });
  const popup = await openPopupFor(page);
  await popup.locator('.table-item').first().waitFor({ timeout: 10000 });
  const downloadStarted = Date.now();
  const file = await download(popup, () => exportMain(popup.locator('.table-item').first()).click());
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
  await setSettings({ format: 'xlsx' });
  const popup = await openPopupFor(page);
  await popup.locator('.table-item').first().waitFor();
  await download(popup, () => exportMain(popup.locator('.table-item').first()).click());
  await download(popup, () => exportMain(popup.locator('#basket')).click());
  await popup.locator('.table-item').first().hover();
  await outlineBox(page).waitFor();
  const orders = await open('orders.html');
  const popup2 = await openPopupFor(orders);
  await popup2.locator('.table-item').first().locator('[data-action="record"]').click();
  await bar(orders).waitFor();
  await bar(orders).locator('[data-action="stop"]').click();
  await download(orders, () => bar(orders).locator('[data-action="xlsx"]').click());
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
