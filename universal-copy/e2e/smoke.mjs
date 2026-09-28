// End-to-end smoke test: loads the e2e build (dist-e2e/) into a real Chromium and drives
// every user flow against local fixture pages, checking what lands on the clipboard.
//
//   npm run test:e2e        (set CHROMIUM_PATH if Chromium isn't auto-detected)
//   npm run screenshots     same, and refreshes the curated screenshots/ for the README
//
// Native context menus and browser-level shortcuts can't be clicked from automation, so the
// test calls the exact handlers Chrome would call (exposed only in the e2e build).

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
    (_, r) => `<tr>${Array.from({ length: columns }, (_, c) => `<td>r${r + 1} c${c + 1}, "q"</td>`).join('')}</tr>`,
  ).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Big table</title></head><body><h1>Big</h1><table id="big"><thead>${head}</thead><tbody>${body}</tbody></table></body></html>`;
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (url.pathname === '/big-table.html') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(bigTable(5000, 8));
    return;
  }
  if (url.pathname.startsWith('/images/')) {
    response.writeHead(404).end();
    return;
  }
  // Same article, served with a strict CSP: the toast must still render and be styled.
  const strictCsp = url.pathname === '/csp.html';
  const file = strictCsp ? 'article.html' : url.pathname.slice(1);
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
const base = `http://127.0.0.1:${server.address().port}`;

// --- Browser ----------------------------------------------------------------------------

await mkdir(outputDir, { recursive: true });
if (curate) await mkdir(screenshotsDir, { recursive: true });
const userDataDir = await mkdtemp(join(tmpdir(), 'universal-copy-e2e-'));
const context = await chromium.launchPersistentContext(userDataDir, {
  executablePath: findChromium(),
  headless,
  viewport: { width: 1280, height: 800 },
  locale: 'en-US',
  args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
});
await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
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
  await page.goto(name.includes('://') ? name : `${base}/${name}`);
  await page.bringToFront();
  return page;
}

/** Selects the contents of an element (in the page or in a frame). */
async function select(target, selector) {
  await target.evaluate((selector) => {
    const node = document.querySelector(selector);
    if (!node) throw new Error(`Missing ${selector}`);
    const range = document.createRange();
    range.selectNodeContents(node);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }, selector);
}

async function clearSelection(page) {
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
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
async function menu(page, menuItemId, extra = {}) {
  const tab = await tabOf(page);
  const selectionText = await page.evaluate(() => window.getSelection()?.toString() ?? '').catch(() => '');
  const info = { menuItemId, frameId: 0, pageUrl: page.url(), editable: false, selectionText, ...extra };
  return worker.evaluate(({ info, tab }) => globalThis.__universalCopyTest.onContextMenuClick(info, tab), { info, tab });
}

async function shortcut(page) {
  const tab = await tabOf(page);
  return worker.evaluate((tab) => globalThis.__universalCopyTest.onCommand('copy-selection', tab), tab);
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

async function resetSettings() {
  await worker.evaluate(() => chrome.storage.local.remove(['settings', 'plan', 'e2eEarlyAccess']));
}

/** What a user sees once early access ends (e2e build only), on the given plan. */
async function setPlan(plan) {
  await worker.evaluate((plan) => chrome.storage.local.set({ plan, e2eEarlyAccess: false }), plan);
}

/** Clicks a download button in the popup and returns the saved file. */
async function downloadFrom(popup, locator) {
  const [download] = await Promise.all([popup.waitForEvent('download'), locator.click()]);
  const failure = await download.failure();
  assert.equal(failure, null, `download failed: ${failure}`);
  return { name: download.suggestedFilename(), content: await readFile(await download.path(), 'utf8') };
}

async function openPopupFor(page, colorScheme = 'light') {
  const tab = await tabOf(page);
  const popup = await newPage();
  await popup.emulateMedia({ colorScheme });
  await popup.setViewportSize({ width: 380, height: 600 });
  await popup.goto(`chrome-extension://${extensionId}/popup.html?tabId=${tab.id}`);
  return popup;
}

const toast = (page) => page.locator('universal-copy-toast .uc-toast');

async function shot(target, name, { curated = false, ...options } = {}) {
  // No half-finished CSS transitions in screenshots.
  const page = typeof target.page === 'function' ? target.page() : target;
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForTimeout(200);
  await target.screenshot({ path: join(outputDir, `${name}.png`), ...options });
  if (curate && curated) await target.screenshot({ path: join(screenshotsDir, `${name}.png`), ...options });
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
    await resetSettings().catch(() => undefined);
  }
}

console.log(`Chromium ${context.browser()?.version() ?? ''} · extension ${extensionId}\n`);

await test('production build: minimal permissions, no host access, no test code', async () => {
  const manifest = JSON.parse(await readFile(join(root, 'dist/manifest.json'), 'utf8'));
  assert.deepEqual([...manifest.permissions].sort(), ['activeTab', 'clipboardWrite', 'contextMenus', 'offscreen', 'scripting', 'storage']);
  assert.equal(manifest.host_permissions, undefined);
  assert.equal(manifest.content_scripts, undefined);
  assert.equal(manifest.web_accessible_resources, undefined);
  const background = await readFile(join(root, 'dist/background.js'), 'utf8');
  const popup = await readFile(join(root, 'dist/popup.js'), 'utf8');
  const page = await readFile(join(root, 'dist/page.js'), 'utf8');
  assert.ok(!background.includes('__universalCopyTest'), 'test hook compiled out');
  assert.ok(!popup.includes('URLSearchParams'), 'popup tab override compiled out');
  assert.ok(page.includes('"closed"') && !page.includes('mode: "open"'), 'toast shadow root is closed');
  for (const file of [background, popup, page]) assert.ok(!/https?:\/\/(?!www\.w3\.org)[a-z]/i.test(file.replace(/\/\/.*$/gm, '')), 'no remote URLs');
});

await test('keyboard shortcut Alt+C is actually assigned by Chrome', async () => {
  const commands = await worker.evaluate(() => chrome.commands.getAll());
  const command = commands.find((item) => item.name === 'copy-selection');
  assert.equal(command?.shortcut, 'Alt+C', JSON.stringify(commands));
});

await test('article: Copy as Markdown keeps structure, drops hidden content and tracking', async () => {
  const page = await open('article.html');
  await resetClipboard(page);
  await select(page, '#article');
  const started = Date.now();
  const message = await menu(page, 'uc:copy:markdown');
  const elapsed = Date.now() - started;
  await toast(page).waitFor();
  assert.equal(message.title, 'Copied as Markdown');
  const md = await clipboardText(page);
  const expected = [
    '# Shipping a Chrome extension in 2026',
    `By [Anna Kowalski](${base}/authors/anna) · March 3`,
    'Manifest V3 is **the only option** now. It is *stricter*, but the rules are clear.',
    '## What changed',
    'Background pages became service workers. Use `chrome.offscreen` for DOM work.',
    '- No remote code\n- Service workers\n  - They sleep when idle\n  - They wake on events\n- Permissions: [see the list](https://developer.chrome.com/docs/extensions/reference/permissions-list?id=7)',
    '## Getting started',
    '1. Create a `manifest.json`\n2. Load it unpacked',
    "```js\nchrome.runtime.onInstalled.addListener(() => {\n  console.log('installed');\n});\n```",
    '> Ship small, ship often.  \n> Then measure.',
    `![Extension architecture diagram](${base}/images/diagram.png)`,
    'How the parts talk to each other',
    `![Lazy photo](${base}/images/lazy-photo.jpg)`,
    'Reviewer said:  \nLooks good to me.  \n  Ship it!',
    'Contact: <editor@example.com>',
  ];
  assert.equal(md, expected.join('\n\n'));
  for (const junk of ['screen reader', 'Advertisement', 'Subscribe', '★', 'Share', 'Tweet', '__articleLoaded', 'utm_', '​']) {
    assert.ok(!md.includes(junk), `no "${junk}"`);
  }
  assert.match(await toast(page).innerText(), /Copied as Markdown/);
  assert.ok(elapsed < 1500, `took ${elapsed} ms`);
  await shot(page, 'toast-markdown', { curated: true });
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot(page, 'toast-markdown-dark');
});

await test('article: Copy as clean text, with and without link URLs', async () => {
  const page = await open('article.html');
  await resetClipboard(page);
  await select(page, '#article');
  await menu(page, 'uc:copy:text');
  const text = await clipboardText(page);
  assert.ok(text.startsWith('Shipping a Chrome extension in 2026\n\nBy Anna Kowalski · March 3\n\nManifest V3 is the only option now.'), text);
  assert.ok(text.includes('- No remote code\n- Service workers\n  - They sleep when idle\n  - They wake on events\n- Permissions: see the list'), text);
  assert.ok(text.includes('1. Create a manifest.json\n2. Load it unpacked'));
  assert.ok(text.includes("chrome.runtime.onInstalled.addListener(() => {\n  console.log('installed');\n});"));
  assert.ok(text.includes('Ship small, ship often.\nThen measure.'));
  assert.ok(text.includes('Reviewer said:\nLooks good to me.\n  Ship it!'));
  assert.ok(!/\*\*|```|\[|\]\(| |​|Advertisement/.test(text), 'no markup or junk');
  assert.match(await toast(page).innerText(), /Copied as clean text/);

  await setSettings({ includeLinkUrls: true });
  await select(page, '#article');
  await menu(page, 'uc:copy:text');
  const withUrls = await clipboardText(page);
  assert.ok(withUrls.includes(`By Anna Kowalski (${base}/authors/anna) · March 3`), withUrls);
  assert.ok(withUrls.includes('see the list (https://developer.chrome.com/docs/extensions/reference/permissions-list?id=7)'));
  assert.ok(withUrls.endsWith('Contact: editor@example.com'), 'mailto link text already shows the address');
});

await test('article: Copy as HTML puts sanitized HTML and plain text on the clipboard', async () => {
  const page = await open('article.html');
  await resetClipboard(page);
  await select(page, '#article');
  await menu(page, 'uc:copy:html');
  const html = await clipboardHtml(page);
  const text = await clipboardText(page);
  assert.ok(html, 'text/html present');
  for (const part of [
    '<h1>Shipping a Chrome extension in 2026</h1>',
    `<a href="${base}/authors/anna">Anna Kowalski</a>`,
    '<strong>the only option</strong>',
    '<em>stricter</em>',
    '<ul><li>No remote code</li>',
    '<pre><code class="language-js">chrome.runtime.onInstalled',
    '<blockquote><p>Ship small, ship often.<br>Then measure.</p>',
    `<img src="${base}/images/diagram.png" alt="Extension architecture diagram">`,
  ]) {
    assert.ok(html.includes(part), `html has ${part}\n${html}`);
  }
  assert.ok(!/<script|<style|style=|onclick|onerror|class="(?!language-)|Advertisement|<button/i.test(html), html);
  assert.ok(text.startsWith('Shipping a Chrome extension in 2026\n\nBy Anna Kowalski'), 'text/plain is the clean text');
});

await test('tables: CSV, TSV, Markdown and JSON from a selection inside a table', async () => {
  const page = await open('tables.html');
  await resetClipboard(page);
  await select(page, '#tricky td');

  const csv = await menu(page, 'uc:table:csv');
  assert.equal(csv.title, 'Copied table as CSV');
  assert.equal(csv.detail, '3 rows × 5 columns');
  assert.equal(
    await clipboardText(page),
    'Name,Quote,Notes,Formula,Pipe\n"Smith, John","He said ""hello""","First line\nSecond line",=SUM(A1:A2),a | b\nDoe; Jane,,"one\ntwo",-5,',
  );

  await select(page, '#tricky td');
  await menu(page, 'uc:table:tsv');
  assert.equal(
    await clipboardText(page),
    'Name\tQuote\tNotes\tFormula\tPipe\nSmith, John\tHe said "hello"\t"First line\nSecond line"\t\'=SUM(A1:A2)\ta | b\nDoe; Jane\t\t"one\ntwo"\t-5\t',
  );
  const html = await clipboardHtml(page);
  assert.ok(html?.includes('<thead><tr><th>Name</th>') && html.includes('<td>First line<br>Second line</td>'), html);

  await select(page, '#tricky td');
  await menu(page, 'uc:table:markdown');
  const md = await clipboardText(page);
  assert.ok(md.startsWith('| Name '), md);
  assert.ok(md.includes('| First line<br>Second line |') && md.includes('| a \\| b |'), md);

  await select(page, '#tricky td');
  await menu(page, 'uc:table:json');
  assert.deepEqual(JSON.parse(await clipboardText(page)), [
    { Name: 'Smith, John', Quote: 'He said "hello"', Notes: 'First line\nSecond line', Formula: '=SUM(A1:A2)', Pipe: 'a | b' },
    { Name: 'Doe; Jane', Quote: '', Notes: 'one\ntwo', Formula: '-5', Pipe: '' },
  ]);
  await shot(page, 'table-toast');
});

await test('tables: spans expand to a grid, nested tables stay separate, duplicate headers get unique keys', async () => {
  const page = await open('tables.html');
  await resetClipboard(page);
  await page.evaluate(() => {
    const cell = [...document.querySelectorAll('#spans td')].find((td) => td.textContent === 'Kyiv');
    const range = document.createRange();
    range.selectNodeContents(cell);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  });
  await menu(page, 'uc:table:csv');
  assert.equal(
    await clipboardText(page),
    'Region,City,Population,Population\nRegion,City,2010,2020\nWest,Lviv,"725,000","721,000"\nWest,Uzhhorod,"116,000","115,000"\nNorth,Kyiv,about 2.9 million,about 2.9 million',
  );
  await select(page, '#spans td');
  await menu(page, 'uc:table:json');
  assert.deepEqual(Object.keys(JSON.parse(await clipboardText(page))[0]), ['Region', 'City', 'Population / 2010', 'Population / 2020']);

  await select(page, '#inner-cell');
  await menu(page, 'uc:table:csv');
  assert.equal(await clipboardText(page), 'Size,Stock\nM,12\nL,0');
  await select(page, '#outer-cell');
  await menu(page, 'uc:table:csv');
  assert.equal(await clipboardText(page), 'Product,Variants\nShirt,"Size Stock\nM 12\nL 0"');

  await select(page, '#dupes td');
  await menu(page, 'uc:table:json');
  const json = await clipboardText(page);
  assert.deepEqual(
    [...json.matchAll(/^ {4}"([^"]+)"/gm)].map((match) => match[1]),
    ['Name', 'Score', 'Score 2', 'Column 4', '2024'],
    'keys unique and in column order',
  );

  await select(page, '#plain td');
  await menu(page, 'uc:table:markdown');
  assert.equal(await clipboardText(page), '|       |     |\n| ----- | --- |\n| alpha | 1   |\n| beta  | 2   |');

  await setSettings({ csvDelimiter: ';' });
  await select(page, '#pricing td');
  await menu(page, 'uc:table:csv');
  assert.equal(await clipboardText(page), 'Plan;Price;Seats;Support\nFree;$0;1;\nPro;$12/mo;5;Email\nTeam;$30/mo;25;Priority, 24/7');
});

await test('tables: a selection outside any table shows a clear error and leaves the clipboard alone', async () => {
  const page = await open('tables.html');
  await resetClipboard(page);
  await select(page, '#intro');
  const message = await menu(page, 'uc:table:csv');
  assert.equal(message.tone, 'error');
  await toast(page).waitFor();
  assert.match(await toast(page).innerText(), /No table in the selection/);
  assert.equal(await clipboardText(page), '<empty>');
  await shot(page, 'toast-error', { curated: true });
});

await test('wikipedia: Markdown without footnotes and edit links; infobox as TSV', async () => {
  const page = await open('wikipedia.html');
  await resetClipboard(page);
  await select(page, '#content');
  await menu(page, 'uc:copy:markdown');
  const md = await clipboardText(page);
  assert.ok(md.startsWith('# Kyiv\n\nThis article is about the capital of Ukraine. For other uses, see [Kyiv (disambiguation)]'), md);
  assert.ok(md.includes('\n\n| Kyiv<br>Київ | Kyiv<br>Київ '), 'infobox follows in DOM order');
  assert.ok(md.includes('| Area         | 839 km2 '), 'no-break space normalized, superscript kept as text');
  assert.ok(md.includes(`[Kyiv (disambiguation)](${base}/wiki/Kyiv_(disambiguation))`), 'balanced parentheses kept');
  assert.ok(
    md.includes(`**Kyiv** (Київ) is the [capital](${base}/wiki/Capital_city) and most populous city of [Ukraine](${base}/wiki/Ukraine). It is in north-central Ukraine along the [Dnieper](${base}/wiki/Dnieper) river.`),
    md,
  );
  assert.ok(md.includes('\n## History\n') && md.includes('\n## Districts\n'), 'headings without [edit]');
  assert.ok(md.includes(`- [1 History](${base}/wikipedia.html#History)`), 'table of contents');
  assert.ok(md.includes('Districts of Kyiv\n\n| District '), 'caption above the table');
  assert.ok(md.includes(`| [Darnytskyi](${base}/wiki/Darnytskyi_District) | 134        | 314,246    |`), md);
  for (const junk of ['[1]', '\\[1\\]', 'citation needed', 'edit', '0134', '[3]']) assert.ok(!md.includes(junk), `no "${junk}"`);

  await page.evaluate(() => {
    const cell = [...document.querySelectorAll('#infobox td')].at(-1);
    const range = document.createRange();
    range.selectNodeContents(cell);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  });
  await menu(page, 'uc:table:tsv');
  assert.equal(await clipboardText(page), '"Kyiv\nКиїв"\t"Kyiv\nКиїв"\nCountry\tUkraine\nFounded\t482 AD\nArea\t839 km2\nPopulation\t2,952,301');
});

await test('github: README Markdown keeps code language, badges, task list and table; code view skips line numbers', async () => {
  const page = await open('github.html');
  await resetClipboard(page);
  await select(page, '#readme');
  await menu(page, 'uc:copy:markdown');
  const md = await clipboardText(page);
  const expected = [
    '# Universal Copy',
    '[![CI](https://github.com/example/universal-copy/actions/workflows/ci.yml/badge.svg)](https://github.com/example/universal-copy/actions) ' +
      `[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](${base}/example/universal-copy/blob/main/LICENSE)`,
    'Copy anything as **clean text**, *Markdown* or HTML. Press `Alt`+`C`.',
    '## Install',
    '```shell\nnpm install\nnpm run build\n```',
    '## Roadmap',
    '- [x] Tables to CSV\n- [ ] Firefox port',
    'Note\n\nWorks offline.',
    '| Format     | Shortcut |\n| ---------- | -------- |\n| Clean text | `Alt+C`  |\n| Markdown   | menu     |',
  ];
  assert.equal(md, expected.join('\n\n'));

  await select(page, '#blob');
  await menu(page, 'uc:copy:text');
  assert.equal(await clipboardText(page), 'export function limit(text: string): string {\n  return text.slice(0, 10);\n}');
});

await test('keyboard shortcut copies the selection in the configured format', async () => {
  const page = await open('article.html');
  await resetClipboard(page);
  await select(page, 'h2');
  const message = await shortcut(page);
  assert.equal(message.title, 'Copied as clean text');
  assert.equal(await clipboardText(page), 'What changed');

  await setSettings({ shortcutFormat: 'markdown' });
  await select(page, 'h2');
  await shortcut(page);
  assert.equal(await clipboardText(page), '## What changed');

  await clearSelection(page);
  const empty = await shortcut(page);
  assert.equal(empty.title, 'Nothing is selected');
  await toast(page).waitFor();
  assert.match(await toast(page).innerText(), /Select some text on the page first/);
});

await test('keyboard shortcut works in text fields and inside same-origin frames', async () => {
  const form = await open('form.html');
  await resetClipboard(form);
  await form.evaluate(() => {
    const field = document.getElementById('notes');
    field.focus();
    field.setSelectionRange(0, field.value.length);
  });
  await shortcut(form);
  assert.equal(await clipboardText(form), 'First line of notes\nSecond  line with   spaces');

  const frames = await open('frames.html');
  await resetClipboard(frames);
  const frame = frames.frame({ url: /frame-inner/ });
  await frame.waitForLoadState();
  await frame.evaluate(() => document.body.focus());
  await select(frame, '#inner-text');
  await frames.evaluate(() => document.getElementById('frame').focus());
  await shortcut(frames);
  assert.equal(await clipboardText(frames), 'Text selected inside an iframe.');
});

await test('popup: lists tables with previews, copies tables and the selection', async () => {
  const page = await open('tables.html');
  await resetClipboard(page);
  await select(page, '#spans');
  const popup = await openPopupFor(page);
  await popup.locator('.table-item').first().waitFor();
  assert.equal(await popup.locator('.table-item').count(), 7);
  assert.equal(await popup.locator('#tables-count').innerText(), '7');
  const first = popup.locator('.table-item').first();
  assert.equal(await first.locator('.table-title').innerText(), 'Pricing');
  assert.equal(await first.locator('.table-dims').innerText(), '4 × 4');
  const spans = popup.locator('.table-item').nth(1);
  assert.equal(await spans.locator('.table-title').innerText(), 'Population by region');
  assert.equal(await spans.locator('.table-dims').innerText(), '5 × 4');
  assert.match(await popup.locator('.selection-preview').innerText(), /Region\s+City\s+Population/);
  await shot(popup.locator('body'), 'popup-light', { curated: true });

  await first.locator('[data-format="csv"]').click();
  await first.locator('[data-format="csv"].is-copied').waitFor();
  await shot(popup.locator('body'), 'popup-copied', { clip: { x: 0, y: 0, width: 380, height: 420 } });
  assert.match(await popup.locator('#status').innerText(), /Copied Pricing as CSV: 4 rows × 4 columns/);
  assert.equal(await clipboardText(page), 'Plan,Price,Seats,Support\nFree,$0,1,\nPro,$12/mo,5,Email\nTeam,$30/mo,25,"Priority, 24/7"');

  await popup.bringToFront();
  await spans.locator('[data-format="tsv"]').click();
  await spans.locator('[data-format="tsv"].is-copied').waitFor();
  assert.ok((await clipboardHtml(page))?.includes('<th>Population</th><th>Population</th>'));

  await popup.bringToFront();
  await popup.locator('#selection [data-format="markdown"]').click();
  await popup.locator('#selection [data-format="markdown"].is-copied').waitFor();
  assert.ok((await clipboardText(page)).startsWith('| Region | City     | Population / 2010 | Population / 2020 |'));

  const dark = await openPopupFor(page, 'dark');
  await dark.locator('.table-item').first().waitFor();
  await shot(dark.locator('body'), 'popup-dark', { curated: true });
});

await test('Pro: copy page link as Markdown from the page context menu, tracking parameters removed', async () => {
  const page = await open('article.html?id=3&utm_source=newsletter&fbclid=abc#what-changed');
  await resetClipboard(page);
  const message = await menu(page, 'uc:page-link', { selectionText: undefined });
  assert.equal(message.title, 'Copied page link as Markdown');
  const expected = `[Shipping a Chrome extension in 2026 | Example Blog](${base}/article.html?id=3#what-changed)`;
  assert.equal(await clipboardText(page), expected);
  assert.equal(await clipboardHtml(page), `<a href="${base}/article.html?id=3#what-changed">Shipping a Chrome extension in 2026 | Example Blog</a>`);
  await toast(page).waitFor();
  assert.match(await toast(page).innerText(), /Copied page link as Markdown/);
  await shot(page, 'toast-page-link', { curated: true });

  // The same item sits in the selection submenu.
  await resetClipboard(page);
  await select(page, 'h2');
  await menu(page, 'uc:page-link:selection');
  assert.equal(await clipboardText(page), expected);

  // No web address on chrome:// pages: a clear message, and the badge.
  const blocked = await open('chrome://version');
  const tab = await tabOf(blocked);
  const failed = await worker.evaluate(
    (tab) => globalThis.__universalCopyTest.onContextMenuClick({ menuItemId: 'uc:page-link', frameId: 0, pageUrl: 'chrome://version', editable: false }, tab),
    tab,
  );
  assert.equal(failed.title, 'No web address to link to');
  assert.equal(await worker.evaluate((id) => chrome.action.getBadgeText({ tabId: id }), tab.id), '!');
  await worker.evaluate(() => chrome.storage.session.remove('notice'));
});

await test('Pro: popup copies the page link and downloads the selection (.md) and tables (.csv, .json)', async () => {
  const page = await open('tables.html?utm_campaign=spring');
  await resetClipboard(page);
  // A table with no caption or heading of its own: the file is named after the page.
  await page.evaluate(() => {
    const table = document.createElement('table');
    table.id = 'untitled';
    table.innerHTML = '<tr><th>Key</th><th>Value</th></tr><tr><td>a</td><td>1</td></tr>';
    document.body.append(table);
  });
  await select(page, '#spans');
  const popup = await openPopupFor(page);
  await popup.locator('.table-item').first().waitFor();
  assert.equal(await popup.locator('#page-title').innerText(), 'Tables | Fixture');
  assert.equal(await popup.locator('.pro-badge').count(), 1 + 1 + 8, 'badge on the page link, the .md download and each table download');

  await popup.locator('#copy-page-link').click();
  await popup.locator('#copy-page-link.is-copied').waitFor();
  assert.equal(await clipboardText(page), `[Tables | Fixture](${base}/tables.html)`);

  await popup.bringToFront();
  const md = await downloadFrom(popup, popup.locator('#selection [data-download="md"]'));
  assert.equal(md.name, 'Tables Fixture.md');
  assert.ok(md.content.startsWith('| Region | City     | Population / 2010 | Population / 2020 |'), md.content);
  assert.ok(md.content.endsWith('|\n'));
  await popup.locator('#selection [data-download="md"].is-copied').waitFor();
  assert.match(await popup.locator('#status').innerText(), /Downloaded Tables Fixture\.md/);

  const pricing = popup.locator('.table-item').first();
  const csv = await downloadFrom(popup, pricing.locator('[data-download="csv"]'));
  assert.equal(csv.name, 'Pricing.csv');
  assert.equal(csv.content, '﻿Plan,Price,Seats,Support\nFree,$0,1,\nPro,$12/mo,5,Email\nTeam,$30/mo,25,"Priority, 24/7"\n');
  const json = await downloadFrom(popup, pricing.locator('[data-download="json"]'));
  assert.equal(json.name, 'Pricing.json');
  assert.deepEqual(JSON.parse(json.content)[0], { Plan: 'Free', Price: '$0', Seats: '1', Support: '' });

  const untitled = popup.locator('.table-item').last();
  assert.equal(await untitled.locator('.table-title').innerText(), 'Table 8');
  const plain = await downloadFrom(popup, untitled.locator('[data-download="csv"]'));
  assert.equal(plain.name, 'Tables Fixture - table 8.csv');
  assert.equal(plain.content, '\ufeffKey,Value\na,1\n');
  await shot(popup.locator('body'), 'popup-pro');
});

await test('Pro: Free plan after early access shows calm notes instead of Pro features', async () => {
  await setPlan('free');
  const page = await open('tables.html');
  await resetClipboard(page);
  await select(page, '#pricing td');

  const message = await menu(page, 'uc:page-link');
  assert.equal(message.tone, 'info');
  assert.equal(message.title, 'Pro feature');
  assert.match(message.detail, /Copy page link as Markdown is part of Universal Copy Pro \(\$2\.99 once\)/);
  assert.equal(await clipboardText(page), '<empty>', 'nothing copied');

  const popup = await openPopupFor(page);
  await popup.locator('.table-item').first().waitFor();
  // Free features still work.
  await popup.locator('.table-item').first().locator('[data-format="csv"]').click();
  await popup.locator('.table-item').first().locator('[data-format="csv"].is-copied').waitFor();
  let downloads = 0;
  popup.on('download', () => downloads++);
  await popup.locator('.table-item').first().locator('[data-download="json"]').click();
  await popup.locator('#notice [data-key="pro"]').waitFor();
  assert.match(await popup.locator('#notice').innerText(), /Pro feature\s+Download as file is part of Universal Copy Pro \(\$2\.99 once\)\. Everything else stays free\./);
  await popup.locator('#copy-page-link').click();
  assert.equal(await popup.locator('#notice .alert').count(), 1, 'one note, replaced');
  await shot(popup.locator('body'), 'popup-free-note');
  assert.equal(downloads, 0);

  const [options] = await Promise.all([context.waitForEvent('page'), popup.locator('#notice .notice-action').click()]);
  openPages.add(options);
  await options.waitForLoadState();
  assert.equal(new URL(options.url()).hash, '#pro');
  await options.locator('#pro-status', { hasText: 'You are on Free' }).waitFor();
  assert.ok(await options.locator('#get-pro').isDisabled());
  assert.ok(await options.locator('#preset-obsidian').isDisabled(), 'presets are off on Free');
  assert.match(await options.locator('#preset-note').innerText(), /Markdown presets is part of Universal Copy Pro/);

  // A Pro license (set by the future payments adapter) turns them on.
  await setPlan('pro');
  await options.reload();
  await options.locator('#pro-status', { hasText: 'Pro is active' }).waitFor();
  assert.ok(await options.locator('#preset-obsidian').isEnabled());
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

await test('popup: loading skeleton while a busy page is read', async () => {
  const page = await open('tables.html');
  // Keep the page's main thread busy so the popup's read has to wait.
  await page.evaluate(() => setTimeout(() => {
    const started = Date.now();
    while (Date.now() - started < 2500) {}
  }, 50));
  await page.waitForTimeout(100);
  const popup = await openPopupFor(page);
  await popup.locator('#tables .table-skeleton').first().waitFor();
  assert.equal(await popup.locator('#status').innerText(), 'Reading the page…');
  await shot(popup.locator('body'), 'popup-loading');
  await popup.locator('.table-item').first().waitFor({ timeout: 10000 });
});

await test('popup: empty states and pages that cannot be read', async () => {
  const page = await open('form.html');
  const popup = await openPopupFor(page);
  await popup.locator('#tables .empty-state').waitFor();
  assert.match(await popup.locator('#tables').innerText(), /No tables on this page/);
  assert.match(await popup.locator('#selection').innerText(), /Select text on the page/);
  assert.match(await popup.locator('#shortcut-text').innerText(), /Alt\+C copies the selection as clean text/);
  await shot(popup.locator('body'), 'popup-empty');
  const dark = await openPopupFor(page, 'dark');
  await dark.locator('#tables .empty-state').waitFor();
  await shot(dark.locator('body'), 'popup-empty-dark');

  const blocked = await open('chrome://version');
  const unreadable = await openPopupFor(blocked);
  await unreadable.locator('#notice .alert-warning').waitFor();
  assert.match(await unreadable.locator('#notice').innerText(), /can't read this page/);
  assert.ok(await unreadable.locator('#tables-section').isHidden());
  await shot(unreadable.locator('body'), 'popup-unreadable');
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
        return popup?.document.querySelectorAll('.table-item').length === 7;
      }),
    'popup lists the 7 tables of the active tab',
  );
  await page.close();
});

await test('unscriptable page: plain-text fallback, badge, and the message in the popup', async () => {
  const reader = await open('article.html');
  await resetClipboard(reader);
  const blocked = await open('chrome://version');
  const tab = await tabOf(blocked);
  const message = await worker.evaluate(
    (tab) =>
      globalThis.__universalCopyTest.onContextMenuClick(
        { menuItemId: 'uc:copy:markdown', frameId: 0, pageUrl: 'chrome://version', editable: false, selectionText: 'Google Chrome 141' },
        tab,
      ),
    tab,
  );
  assert.equal(message.tone, 'info');
  assert.match(message.detail, /Copied as plain text/);
  assert.equal(await worker.evaluate((id) => chrome.action.getBadgeText({ tabId: id }), tab.id), '✓');
  assert.equal(await clipboardText(reader), 'Google Chrome 141');

  const failed = await worker.evaluate(
    (tab) =>
      globalThis.__universalCopyTest.onContextMenuClick(
        { menuItemId: 'uc:table:csv', frameId: 0, pageUrl: 'chrome://version', editable: false, selectionText: 'x' },
        tab,
      ),
    tab,
  );
  assert.equal(failed.title, "Can't read tables on this page");
  assert.equal(await worker.evaluate((id) => chrome.action.getBadgeText({ tabId: id }), tab.id), '!');
  await blocked.bringToFront();
  const popup = await openPopupFor(blocked);
  await popup.locator('#notice .alert-danger').waitFor();
  assert.match(await popup.locator('#notice').innerText(), /Can't read tables on this page/);
  assert.equal(await popup.locator('#notice .alert').count(), 1, 'the stored message explains the page; no duplicate warning');
  await shot(popup.locator('body'), 'popup-notice');
  assert.equal(await worker.evaluate((id) => chrome.action.getBadgeText({ tabId: id }), tab.id), '');
});

await test('options: settings persist, the Markdown preview follows, the shortcut is shown', async () => {
  const page = await newPage();
  await page.setViewportSize({ width: 900, height: 700 });
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  assert.equal(await page.locator('#shortcut').innerText(), 'Alt+C');
  assert.equal(await page.locator('#markdown-sample').innerText(), '- A list with *italic* text\n- **Bold** and `code`');
  await page.locator('label[for="format-markdown"]').click();
  await page.locator('#save-status', { hasText: 'Saved' }).waitFor();
  await page.locator('label[for="bullet-star"]').click();
  await page.locator('label[for="emphasis-underscore"]').click();
  await page.waitForFunction(() => document.getElementById('markdown-sample').textContent === '* A list with _italic_ text\n* **Bold** and `code`');
  await page.locator('#include-link-urls').check();
  await page.locator('#csv-semicolon').check();
  await page.locator('#save-status', { hasText: 'Saved' }).waitFor();
  const settings = await worker.evaluate(async () => (await chrome.storage.local.get('settings')).settings);
  assert.deepEqual(settings, { shortcutFormat: 'markdown', includeLinkUrls: true, bulletMarker: '*', emphasisMarker: '_', csvDelimiter: ';' });
  await page.reload();
  assert.ok(await page.locator('#csv-semicolon').isChecked());
  assert.match(await page.locator('.card').last().innerText(), /no network requests/);
  await shot(page, 'options-light', { curated: true, fullPage: true });
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot(page, 'options-dark', { curated: true, fullPage: true });
});

await test('options: About Pro card and Markdown presets', async () => {
  const page = await newPage();
  await page.setViewportSize({ width: 900, height: 700 });
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  const card = page.locator('#pro');
  await card.locator('#pro-status', { hasText: 'Free during early access' }).waitFor();
  assert.equal(await card.locator('#pro-price').innerText(), '$2.99 once');
  assert.ok(await card.locator('#get-pro').isDisabled());
  assert.equal(await card.locator('#get-pro').innerText(), 'Get Pro');
  assert.deepEqual(await card.locator('#pro-features li .fw-semibold').allInnerTexts(), ['Download as file', 'Copy page link as Markdown', 'Markdown presets']);

  assert.ok(await page.locator('#preset-github').isChecked(), 'defaults match the GitHub preset');
  await page.locator('label[for="preset-obsidian"]').click();
  await page.waitForFunction(() => document.getElementById('markdown-sample').textContent === '- A list with _italic_ text\n- **Bold** and `code`');
  assert.ok(await page.locator('#emphasis-underscore').isChecked());
  await page.locator('label[for="preset-plain"]').click();
  await page.waitForFunction(() => document.getElementById('markdown-sample').textContent === '* A list with _italic_ text\n* **Bold** and `code`');
  assert.deepEqual(
    await worker.evaluate(async () => {
      const { settings } = await chrome.storage.local.get('settings');
      return [settings.bulletMarker, settings.emphasisMarker];
    }),
    ['*', '_'],
  );
  // Changing an option by hand leaves the presets: none is selected.
  await page.locator('label[for="bullet-plus"]').click();
  await page.waitForFunction(() => document.getElementById('markdown-sample').textContent.startsWith('+ '));
  assert.equal(await page.locator('input[name="preset"]:checked').count(), 0);

  // A Markdown copy follows the preset.
  await page.locator('label[for="preset-obsidian"]').click();
  await page.waitForFunction(() => document.getElementById('markdown-sample').textContent.startsWith('- A list with _italic_'));
  const article = await open('article.html');
  await resetClipboard(article);
  await select(article, '#article');
  await menu(article, 'uc:copy:markdown');
  assert.match(await clipboardText(article), /_stricter_/);
});

await test('strict CSP page: the toast still renders with its styles', async () => {
  const page = await open('csp.html');
  await resetClipboard(page);
  await select(page, 'h1');
  await menu(page, 'uc:copy:markdown');
  await toast(page).waitFor();
  const style = await toast(page).evaluate((element) => {
    const computed = getComputedStyle(element);
    return { radius: computed.borderRadius, position: computed.position };
  });
  assert.equal(style.position, 'fixed');
  assert.notEqual(style.radius, '0px');
  assert.equal(await clipboardText(page), '# Shipping a Chrome extension in 2026');
  await shot(page, 'csp-toast');
});

await test('large table (5,000 rows × 8 columns) copies quickly', async () => {
  const page = await open('big-table.html');
  await resetClipboard(page);
  await select(page, '#big td');
  const started = Date.now();
  const message = await menu(page, 'uc:table:csv');
  const elapsed = Date.now() - started;
  assert.equal(message.detail, '5,001 rows × 8 columns');
  const csv = await clipboardText(page);
  assert.equal(csv.split('\n').length, 5001);
  assert.ok(csv.endsWith('"r5000 c8, ""q"""'), csv.slice(-40));
  assert.ok(elapsed < 2500, `took ${elapsed} ms`);
  console.log(`      (5,000-row table copied as CSV in ${elapsed} ms)`);
});

await test('no network requests leave the extension', async () => {
  const requests = [];
  const listener = (request) => {
    const url = request.url();
    if (!url.startsWith(base) && !url.startsWith('chrome-extension://') && !url.startsWith('data:')) requests.push(url);
  };
  context.on('request', listener);
  const page = await open('tables.html');
  await select(page, '#pricing');
  await menu(page, 'uc:copy:markdown');
  await menu(page, 'uc:table:json');
  const popup = await openPopupFor(page);
  await popup.locator('.table-item').first().waitFor();
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
