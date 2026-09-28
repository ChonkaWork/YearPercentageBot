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

/** Pretty paths of the article-like fixtures, as a real site would have them. */
const ROUTES = {
  '/travel/night-trains-return': 'news.html',
  '/guide/storage': 'docs.html',
  '/stats/linear-regression': 'math.html',
};
const IMAGES = { '/images/sleeper.svg': 'images/sleeper.svg', '/images/diagram.png': 'images/diagram.svg' };

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (url.pathname === '/big-table.html') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(bigTable(5000, 8));
    return;
  }
  if (url.pathname.startsWith('/images/')) {
    const image = IMAGES[url.pathname];
    if (image) response.writeHead(200, { 'content-type': 'image/svg+xml' }).end(await readFile(join(fixtures, image)));
    else response.writeHead(404).end();
    return;
  }
  // Same article, served with a strict CSP: the toast must still render and be styled.
  const strictCsp = url.pathname === '/csp.html';
  const file = strictCsp ? 'article.html' : (ROUTES[url.pathname] ?? url.pathname.slice(1));
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

// Realistic host names without a port, so screenshots never show 127.0.0.1, localhost or a
// port. Chromium maps every one of them to this server (see the launch arguments).
const HOSTS = {
  blog: 'blog.example.com',
  data: 'data.example.org',
  wiki: 'wiki.example.org',
  code: 'code.example.com',
  app: 'app.example.com',
  news: 'news.example.com',
  docs: 'docs.example.org',
  notes: 'notes.example.edu',
};
const origin = Object.fromEntries(Object.entries(HOSTS).map(([key, host]) => [key, `http://${host}`]));
const ORIGINS = Object.values(origin);
const SITE_OF = {
  'article.html': 'blog',
  'csp.html': 'blog',
  'tables.html': 'data',
  'big-table.html': 'data',
  'wikipedia.html': 'wiki',
  'github.html': 'code',
  'form.html': 'app',
  'frames.html': 'app',
  'travel/night-trains-return': 'news',
  'guide/storage': 'docs',
  'stats/linear-regression': 'notes',
};
const NEWS = 'travel/night-trains-return';
const DOCS = 'guide/storage';
const NOTES = 'stats/linear-regression';
const newsUrl = `${origin.news}/${NEWS}`;
const newsTitle = 'Night trains return to Central Europe | The Daily Courier';

function urlOf(name) {
  if (name.includes('://')) return name;
  const path = name.split(/[?#]/)[0];
  return `${origin[SITE_OF[path] ?? 'blog']}/${name}`;
}

// --- Browser ----------------------------------------------------------------------------

await mkdir(outputDir, { recursive: true });
if (curate) await mkdir(screenshotsDir, { recursive: true });
const userDataDir = await mkdtemp(join(tmpdir(), 'universal-copy-e2e-'));
const context = await chromium.launchPersistentContext(userDataDir, {
  executablePath: findChromium(),
  headless,
  viewport: { width: 1280, height: 800 },
  locale: 'en-US',
  args: [
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
    // The fixture host names (port 80) resolve to the local fixture server...
    `--host-resolver-rules=${Object.values(HOSTS).map((host) => `MAP ${host}:80 127.0.0.1:${port}`).join(',')}`,
    // ...directly, not through a proxy from the environment...
    '--no-proxy-server',
    // ...and are secure contexts like 127.0.0.1 and localhost (the Clipboard API needs one).
    `--unsafely-treat-insecure-origin-as-secure=${ORIGINS.join(',')}`,
  ],
});
for (const site of ORIGINS) await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: site });
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
  await page.goto(urlOf(name));
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

/** Selects the first occurrence of `text` inside an element's first text node that holds it. */
async function selectText(page, selector, text) {
  await page.evaluate(
    ({ selector, text }) => {
      const walker = document.createTreeWalker(document.querySelector(selector), NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const at = node.data.indexOf(text);
        if (at === -1) continue;
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + text.length);
        getSelection().removeAllRanges();
        getSelection().addRange(range);
        return;
      }
      throw new Error(`"${text}" not found in ${selector}`);
    },
    { selector, text },
  );
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

async function shortcut(page, command = 'copy-selection') {
  const tab = await tabOf(page);
  return worker.evaluate(({ command, tab }) => globalThis.__universalCopyTest.onCommand(command, tab), { command, tab });
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
  await worker.evaluate(() => chrome.storage.local.remove(['settings', 'plan', 'e2eEarlyAccess', 'popup']));
}

/** What a user sees once early access ends (e2e build only), on the given plan. */
async function setPlan(plan) {
  await worker.evaluate((plan) => chrome.storage.local.set({ plan, e2eEarlyAccess: false }), plan);
}

/** The news site's cookie banner: accepted (gone) or not yet (shown), then reload. */
async function cookies(page, accepted) {
  await page.evaluate((accepted) => (accepted ? localStorage.setItem('cookies', 'ok') : localStorage.removeItem('cookies')), accepted);
  await page.reload();
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

/** Waits until the popup's preview shows a converted clip. */
async function previewReady(popup) {
  await popup.locator('#clip-content:not([hidden]) #preview:not([disabled])').waitFor();
  return popup.locator('#preview').inputValue();
}

/** Opens the compact row of a table in the popup (preview, every format, downloads). */
async function expandTable(item) {
  await item.locator('.table-more').click();
  await item.locator('.table-panel:not([hidden])').waitFor();
}

const toast = (page) => page.locator('universal-copy-toast .uc-toast');

/** A reader opening a copied deep link in a new tab: it must land on the passage. */
async function openDeepLink(link, targetSelector, notSelector) {
  const reader = await newPage();
  await reader.goto(link);
  await reader.waitForFunction(() => window.scrollY > 0, null, { timeout: 5000 });
  const view = await reader.evaluate(
    ({ targetSelector, notSelector }) => {
      const inView = (selector) => {
        const box = document.querySelector(selector).getBoundingClientRect();
        return box.top >= 0 && box.bottom <= window.innerHeight;
      };
      return { target: inView(targetSelector), other: notSelector ? inView(notSelector) : false, scrollY: window.scrollY };
    },
    { targetSelector, notSelector },
  );
  assert.ok(view.target, `${targetSelector} is in view after opening the link (scrollY ${view.scrollY})`);
  if (notSelector) assert.ok(!view.other, `${notSelector} is not in view`);
  return reader;
}

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
  assert.equal(manifest.optional_host_permissions, undefined);
  assert.equal(manifest.content_scripts, undefined);
  assert.equal(manifest.web_accessible_resources, undefined);
  assert.deepEqual(Object.keys(manifest.commands).sort(), ['copy-quote', 'copy-selection']);
  const background = await readFile(join(root, 'dist/background.js'), 'utf8');
  const popup = await readFile(join(root, 'dist/popup.js'), 'utf8');
  const page = await readFile(join(root, 'dist/page.js'), 'utf8');
  assert.ok(!background.includes('__universalCopyTest'), 'test hook compiled out');
  assert.ok(!popup.includes('URLSearchParams'), 'popup tab override compiled out');
  assert.ok(page.includes('"closed"') && !page.includes('mode: "open"'), 'toast shadow root is closed');
  for (const file of [background, popup, page]) assert.ok(!/https?:\/\/(?!www\.w3\.org)[a-z]/i.test(file.replace(/\/\/.*$/gm, '')), 'no remote URLs');
});

await test('keyboard shortcuts Alt+C and Alt+Q are actually assigned by Chrome', async () => {
  const commands = await worker.evaluate(() => chrome.commands.getAll());
  const copy = commands.find((item) => item.name === 'copy-selection');
  const quote = commands.find((item) => item.name === 'copy-quote');
  assert.equal(copy?.shortcut, 'Alt+C', JSON.stringify(commands));
  assert.equal(quote?.shortcut, 'Alt+Q', JSON.stringify(commands));
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
    `By [Anna Kowalski](${origin.blog}/authors/anna) · March 3`,
    'Manifest V3 is **the only option** now. It is *stricter*, but the rules are clear.',
    '## What changed',
    'Background pages became service workers. Use `chrome.offscreen` for DOM work.',
    '- No remote code\n- Service workers\n  - They sleep when idle\n  - They wake on events\n- Permissions: [see the list](https://developer.chrome.com/docs/extensions/reference/permissions-list?id=7)',
    '## Getting started',
    '1. Create a `manifest.json`\n2. Load it unpacked',
    "```js\nchrome.runtime.onInstalled.addListener(() => {\n  console.log('installed');\n});\n```",
    '> Ship small, ship often.  \n> Then measure.',
    `![Extension architecture diagram](${origin.blog}/images/diagram.png)`,
    'How the parts talk to each other',
    `![Lazy photo](${origin.blog}/images/lazy-photo.jpg)`,
    'Reviewer said:  \nLooks good to me.  \n  Ship it!',
    'Contact: <editor@example.com>',
  ];
  assert.equal(md, expected.join('\n\n'));
  for (const junk of ['screen reader', 'Advertisement', 'Subscribe', '★', 'Share', 'Tweet', '__articleLoaded', 'utm_', '\u200b']) {
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
  assert.ok(!/\*\*|```|\[|\]\(|\u00a0|\u200b|Advertisement/.test(text), 'no markup or junk');
  assert.match(await toast(page).innerText(), /Copied as clean text/);

  await setSettings({ includeLinkUrls: true });
  await select(page, '#article');
  await menu(page, 'uc:copy:text');
  const withUrls = await clipboardText(page);
  assert.ok(withUrls.includes(`By Anna Kowalski (${origin.blog}/authors/anna) · March 3`), withUrls);
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
    `<a href="${origin.blog}/authors/anna">Anna Kowalski</a>`,
    '<strong>the only option</strong>',
    '<em>stricter</em>',
    '<ul><li>No remote code</li>',
    '<pre><code class="language-js">chrome.runtime.onInstalled',
    '<blockquote><p>Ship small, ship often.<br>Then measure.</p>',
    `<img src="${origin.blog}/images/diagram.png" alt="Extension architecture diagram">`,
  ]) {
    assert.ok(html.includes(part), `html has ${part}\n${html}`);
  }
  assert.ok(!/<script|<style|style=|onclick|onerror|class="(?!language-)|Advertisement|<button/i.test(html), html);
  assert.ok(text.startsWith('Shipping a Chrome extension in 2026\n\nBy Anna Kowalski'), 'text/plain is the clean text');
});

// --- Quote with a deep link ------------------------------------------------------------------

await test('quote with link: the Markdown quote links to the exact passage, and the link scrolls there', async () => {
  const page = await open(NEWS);
  await cookies(page, true);
  await resetClipboard(page);
  await page.evaluate(() => document.getElementById('minister').scrollIntoView({ block: 'center' }));
  await select(page, '#minister-quote');
  const message = await menu(page, 'uc:quote');
  assert.equal(message.title, 'Copied quote with link');
  assert.equal(message.tone, 'success');
  assert.equal(message.detail, 'The link opens the page at this passage and highlights it.');
  // The same words open the standfirst at the top of the page: the prefix picks the right copy.
  const link = `${newsUrl}#:~:text=reporters%3A%20%E2%80%9C-,We%20are%20bringing%20the%20night%20train%20back`;
  assert.equal(await clipboardText(page), `> We are bringing the night train back\n\n— [${newsTitle}](${link})`);
  const html = await clipboardHtml(page);
  assert.ok(html?.includes(`<blockquote cite="${link}">`) && html.includes(`<a href="${link}">${newsTitle}</a>`), html);
  await toast(page).waitFor();
  assert.match(await toast(page).innerText(), /Copied quote with link/);
  await shot(page, 'toast-quote', { curated: true });

  const reader = await openDeepLink(link, '#minister-quote', '#standfirst');
  await shot(reader, 'deep-link', { curated: true });

  // A narrow window lays the page out in one column; the link still lands on the passage.
  const narrow = await newPage();
  await narrow.setViewportSize({ width: 520, height: 620 });
  await narrow.goto(link);
  await narrow.waitForFunction(() => {
    const box = document.getElementById('minister-quote').getBoundingClientRect();
    return window.scrollY > 0 && box.top >= 0 && box.bottom <= window.innerHeight;
  });
  await shot(narrow, 'deep-link-narrow', { curated: true });
});

await test('quote with link: Alt+Q on a long passage uses textStart,textEnd; plain-text style', async () => {
  const page = await open(NEWS);
  await cookies(page, true);
  await resetClipboard(page);
  await select(page, '#closing');
  const message = await shortcut(page, 'copy-quote');
  assert.equal(message.title, 'Copied quote with link');
  const link = `${newsUrl}#:~:text=Rail%20fans%20have,service%20in%20December.`;
  const markdown = await clipboardText(page);
  assert.ok(markdown.startsWith('> Rail fans have waited a long time for this. “The train is slower than a plane'), markdown);
  assert.ok(markdown.endsWith(`\n\n— [${newsTitle}](${link})`), markdown);
  await openDeepLink(link, '#closing', '#headline');

  await page.bringToFront();
  await setSettings({ quoteStyle: 'text' });
  await selectText(page, '#timetable', 'Sleepers leave Vienna at 19:40');
  await menu(page, 'uc:quote');
  const plainLink = `${newsUrl}#:~:text=Sleepers%20leave%20Vienna%20at%2019%3A40`;
  assert.equal(await clipboardText(page), `“Sleepers leave Vienna at 19:40” — ${newsTitle}, ${plainLink}`);
  assert.ok((await clipboardHtml(page))?.includes(`<blockquote cite="${plainLink}">`), 'rich editors still get the formatted quote');
  await openDeepLink(plainLink, '#timetable', '#headline');
});

await test('quote with link: passages that repeat word for word, text fields and unreadable pages say what the link does', async () => {
  const page = await open(NEWS);
  await resetClipboard(page);
  // Two comments with the same words around them: nothing tells the second "Reply" apart.
  await page.evaluate(() => {
    document
      .querySelector('.story-body')
      .insertAdjacentHTML('beforeend', '<div class="thread"><p>Great article</p><p>Reply</p><p>Great article</p><p id="reply-2">Reply</p><p>Great article</p></div>');
  });
  await select(page, '#reply-2');
  const repeated = await menu(page, 'uc:quote');
  assert.equal(repeated.tone, 'info');
  assert.match(repeated.detail, /appears more than once on this page, so the link opens the page without jumping to it/);
  assert.equal(await clipboardText(page), `> Reply\n\n— [${newsTitle}](${newsUrl})`);

  const form = await open('form.html');
  await resetClipboard(form);
  await form.evaluate(() => {
    const field = document.getElementById('notes');
    field.focus();
    field.setSelectionRange(0, 19);
  });
  const field = await shortcut(form, 'copy-quote');
  assert.match(field.detail, /can't be linked to directly, so the link opens the page/);
  assert.equal(await clipboardText(form), `> First line of notes\n\n— [Feedback form | Example App](${origin.app}/form.html)`);

  const reader = await open('article.html');
  await resetClipboard(reader);
  const blocked = await open('chrome://version');
  const tab = await tabOf(blocked);
  const unreadable = await worker.evaluate(
    (tab) =>
      globalThis.__universalCopyTest.onContextMenuClick(
        { menuItemId: 'uc:quote', frameId: 0, pageUrl: 'chrome://version', editable: false, selectionText: 'Google Chrome 141' },
        tab,
      ),
    tab,
  );
  assert.equal(unreadable.title, 'Copied quote');
  assert.match(unreadable.detail, /Quoted as plain text/);
  // Without the tabs permission Chrome reports no title or address for chrome:// tabs.
  assert.equal(await clipboardText(reader), '> Google Chrome 141');
  await worker.evaluate(() => chrome.storage.session.remove('notice'));
});

await test('popup: Quote format previews the quote with its link, copies it, and is remembered', async () => {
  const page = await open(NEWS);
  await cookies(page, true);
  await resetClipboard(page);
  await page.evaluate(() => document.getElementById('minister').scrollIntoView({ block: 'center' }));
  await select(page, '#minister-quote');
  const popup = await openPopupFor(page);
  await previewReady(popup);
  await popup.locator('label[for="format-quote"]').click();
  await popup.waitForFunction(() => document.getElementById('preview').value.startsWith('> We are bringing the night train back'));
  const link = `${newsUrl}#:~:text=reporters%3A%20%E2%80%9C-,We%20are%20bringing%20the%20night%20train%20back`;
  assert.equal(await popup.locator('#preview').inputValue(), `> We are bringing the night train back\n\n— [${newsTitle}](${link})`);
  assert.match(await popup.locator('#clip-note').innerText(), /The link opens the page at this passage, highlighted/);
  assert.match(await popup.locator('#clip-note').innerText(), /Tip: Alt\+Q does this right on the page/);
  assert.equal(await popup.locator('#copy-clip').innerText(), 'Copy quote with link');
  assert.ok(await popup.locator('#preview').evaluate((element) => element.classList.contains('is-code')), 'Markdown in monospace');
  const footer = await popup.locator('.popup-footer').boundingBox();
  assert.ok(footer && footer.y + footer.height <= 600, `the Quote view fits in 600px (footer ends at ${footer && footer.y + footer.height}px)`);
  await shot(popup.locator('body'), 'popup-quote', { curated: true });
  await popup.locator('#copy-clip').click();
  await popup.locator('#copy-clip.is-copied').waitFor();
  assert.equal(await clipboardText(page), `> We are bringing the night train back\n\n— [${newsTitle}](${link})`);
  assert.match(await popup.locator('#status').innerText(), /Copied the quote with a link to the passage/);

  // Reopened, the popup starts in the last format used.
  const again = await openPopupFor(page, 'dark');
  await again.waitForFunction(() => document.getElementById('preview').value.startsWith('> We are bringing'));
  assert.ok(await again.locator('#format-quote').isChecked());
  await shot(again.locator('body'), 'popup-quote-dark', { curated: true });
});

// --- Editable preview --------------------------------------------------------------------

await test('popup: the preview shows the chosen format, can be edited, and counts words and tokens', async () => {
  const page = await open(DOCS);
  await resetClipboard(page);
  await select(page, '.docs-content p');
  const popup = await openPopupFor(page);
  const original =
    "The `acme.storage` API saves settings and larger records on the user's device. Data survives restarts, and nothing leaves the device unless you sync it yourself.";
  assert.equal(await previewReady(popup), original);
  assert.ok(await popup.locator('#format-markdown').isChecked(), 'Markdown by default');
  assert.equal(await popup.locator('#copy-clip').innerText(), 'Copy Markdown');
  // Words as the browser segments them (ICU; the same count Chrome's own word tools use).
  const words = await popup.evaluate((text) => [...new Intl.Segmenter(undefined, { granularity: 'word' }).segment(text)].filter((part) => part.isWordLike).length, original);
  assert.ok(words >= 25 && words <= 27, `${words} words`);
  assert.equal(await popup.locator('#clip-stats').innerText(), `${words} words · ~${Math.ceil(original.length / 4)} tokens`);

  // Text: proportional font; HTML: the source.
  await popup.locator('label[for="format-text"]').click();
  await popup.waitForFunction(() => document.getElementById('preview').value.startsWith('The acme.storage API'));
  assert.ok(!(await popup.locator('#preview').evaluate((element) => element.classList.contains('is-code'))));
  await popup.locator('label[for="format-html"]').click();
  await popup.waitForFunction(() => document.getElementById('preview').value.startsWith('The <code>acme.storage</code> API'));

  // Edits are copied as they are, kept per format, and can be undone.
  await popup.locator('label[for="format-markdown"]').click();
  await popup.waitForFunction((original) => document.getElementById('preview').value === original, original);
  await popup.locator('#preview').fill('Edited text for the notes app.');
  await popup.locator('#clip-edited:not([hidden])').waitFor();
  await popup.waitForFunction(() => document.getElementById('clip-stats').textContent === '6 words · ~8 tokens');
  await popup.locator('#copy-clip').click();
  await popup.locator('#copy-clip.is-copied').waitFor();
  assert.equal(await clipboardText(page), 'Edited text for the notes app.');
  await popup.bringToFront();
  await popup.locator('label[for="format-text"]').click();
  await popup.waitForFunction(() => document.getElementById('preview').value.startsWith('The acme.storage API'));
  await popup.locator('label[for="format-markdown"]').click();
  await popup.waitForFunction(() => document.getElementById('preview').value === 'Edited text for the notes app.');
  assert.ok(!(await popup.locator('#copy-clip').evaluate((button) => button.classList.contains('is-copied'))), 'no stale "Copied" state after switching');
  assert.equal(await popup.locator('#copy-clip').innerText(), 'Copy Markdown');
  await shot(popup.locator('body'), 'popup-edited');
  await popup.locator('#reset-edit').click();
  assert.equal(await popup.locator('#preview').inputValue(), original);
  assert.ok(await popup.locator('#clip-edited').isHidden());

  // An edited HTML preview goes on the clipboard as HTML, with its text as text/plain.
  await popup.locator('label[for="format-html"]').click();
  await popup.waitForFunction(() => document.getElementById('preview').value.startsWith('The <code>'));
  await popup.locator('#preview').fill('<p>Short <strong>note</strong></p>');
  await popup.locator('#copy-clip').click();
  await popup.locator('#copy-clip.is-copied').waitFor();
  assert.equal(await clipboardHtml(page), '<p>Short <strong>note</strong></p>');
  assert.equal(await clipboardText(page), 'Short note');
});

// --- Whole article -------------------------------------------------------------------------

const NEWS_JUNK = ['The Daily Courier\n', 'World', 'Share', 'Advertisement', 'newsletter', 'Sign up', 'Related stories', 'Comments (42)', 'Most read', 'We use cookies', '© 2026'];

await test('article: Copy article as Markdown from the page menu drops menus, ads, banners and sidebars', async () => {
  const page = await open(NEWS);
  await cookies(page, false);
  assert.ok(await page.locator('#cookie-banner').isVisible(), 'the cookie banner is on the page');
  await resetClipboard(page);
  await clearSelection(page);
  const message = await menu(page, 'uc:article', { selectionText: undefined });
  assert.equal(message.title, 'Copied article as Markdown');
  assert.match(message.detail, /^\d[\d,]* words · ~[\d,]+ tokens$/);
  const md = await clipboardText(page);
  assert.ok(md.startsWith('Travel\n\n# Night trains return to Central Europe\n\n“We are bringing the night train back,” the transport minister said'), md.slice(0, 200));
  assert.ok(md.includes(`By [Marta Nowak](${origin.news}/authors/marta-nowak) · 14 September 2026`), 'byline, tracking removed');
  assert.ok(md.includes(`![A sleeper train at Vienna Central Station at dusk](${origin.news}/images/sleeper.svg)`));
  assert.ok(md.includes('| Route              | Departs | Arrives | Couchette from |'));
  assert.ok(md.includes('- Book a lower berth if you prefer to sit up in the evening.'));
  for (const junk of NEWS_JUNK) assert.ok(!md.includes(junk), `no "${junk.trim()}"`);
  await toast(page).waitFor();
  await shot(page, 'toast-article');
});

await test('article: the popup shows the article when nothing is selected, and copies it', async () => {
  const page = await open(NEWS);
  await cookies(page, true);
  await resetClipboard(page);
  const popup = await openPopupFor(page);
  const preview = await previewReady(popup);
  assert.equal(await popup.locator('#tab-article').getAttribute('aria-selected'), 'true');
  assert.match(await popup.locator('#clip-note').innerText(), /Nothing is selected, so this is the page’s main article/);
  assert.ok(preview.startsWith('Travel\n\n# Night trains return to Central Europe'), preview.slice(0, 80));
  assert.ok(await popup.locator('#format-quote').isDisabled(), 'quotes need a selection');
  assert.match(await popup.locator('#clip-stats').innerText(), /^[\d,]+ words · ~[\d,]+ tokens$/);

  await popup.locator('#copy-article').click();
  await popup.locator('#copy-article.is-copied').waitFor();
  const md = await clipboardText(page);
  assert.equal(md, preview);
  assert.match(await popup.locator('#status').innerText(), /Copied the article as Markdown: [\d,]+ words/);

  // The Selection tab explains what to do.
  await popup.bringToFront();
  await popup.locator('#tab-selection').click();
  await popup.locator('#clip-state:not([hidden]) .empty-state').waitFor();
  assert.match(await popup.locator('#clip-state').innerText(), /Select text on the page/);
  await shot(popup.locator('body'), 'popup-no-selection');
  await popup.locator('#show-article').click();
  await previewReady(popup);

  // Docs page: the article without the sidebar, table of contents and feedback.
  const docs = await open(DOCS);
  const docsPopup = await openPopupFor(docs);
  const docsPreview = await previewReady(docsPopup);
  assert.ok(docsPreview.startsWith("# Storing data\n\nThe `acme.storage` API saves settings and larger records on the user's device."), docsPreview.slice(0, 120));
  assert.ok(docsPreview.includes("```js\nawait acme.storage.set({ theme: 'dark' });"));
  for (const junk of ['Your first app', 'On this page', 'Was this page helpful', 'Messaging →', 'Search the docs', 'Docs / Guide']) {
    assert.ok(!docsPreview.includes(junk), `no "${junk}"`);
  }
});

await test('Pro: .md downloads start with front matter; the template editor changes it', async () => {
  const page = await open(NEWS);
  await cookies(page, true);
  const today = await page.evaluate(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  });
  const popup = await openPopupFor(page);
  const article = await previewReady(popup);
  await popup.locator('#front-matter summary').click();
  const block = [
    '---',
    `title: "${newsTitle}"`,
    `url: ${newsUrl}`,
    'author: "Marta Nowak"',
    'published: 2026-09-14',
    `clipped: ${today}`,
    'tags: [clippings]',
    '---',
  ].join('\n');
  assert.equal(await popup.locator('#front-matter-preview').innerText(), block);
  await shot(popup.locator('body'), 'popup-article', { curated: true });

  const file = await downloadFrom(popup, popup.locator('#download-md'));
  assert.equal(file.name, 'Night trains return to Central Europe The Daily Courier.md');
  assert.equal(file.content, `${block}\n\n${article}\n`);

  // The template editor: variable chips, checks, live preview, default tags.
  const options = await newPage();
  await options.setViewportSize({ width: 900, height: 900 });
  await options.goto(`chrome-extension://${extensionId}/options.html#front-matter`);
  const template = options.locator('#fm-template');
  await template.waitFor();
  assert.equal(await template.inputValue(), 'title: {{title}}\nurl: {{url}}\nauthor: {{author}}\npublished: {{published}}\nclipped: {{clipped}}\ntags: {{tags}}');
  await template.focus();
  await options.keyboard.press('Control+End');
  await options.keyboard.press('Enter');
  await options.locator('#fm-variables button', { hasText: '{{site}}' }).click();
  await options.keyboard.type('\nnote: {{titel}}');
  await options.locator('#fm-issues', { hasText: 'Line 8: Unknown variable {{titel}}' }).waitFor();
  assert.ok(await template.evaluate((element) => element.classList.contains('is-invalid')));
  await options.keyboard.press('Shift+Home');
  await options.keyboard.press('Backspace');
  await options.keyboard.press('Backspace');
  await options.waitForFunction(() => document.getElementById('fm-issues').childElementCount === 0);
  await options.locator('#fm-tags').fill('travel, rail');
  await options.locator('#fm-preview', { hasText: 'site: "The Daily Courier"' }).waitFor();
  await options.locator('#fm-preview', { hasText: 'tags: [travel, rail]' }).waitFor();
  await options.locator('#save-status', { hasText: 'Saved' }).waitFor();
  await waitFor(
    () => worker.evaluate(async () => (await chrome.storage.local.get('settings')).settings?.defaultTags === 'travel, rail'),
    'tags saved',
  );
  const saved = await worker.evaluate(async () => (await chrome.storage.local.get('settings')).settings);
  assert.equal(saved.frontMatterTemplate, 'title: {{title}}\nurl: {{url}}\nauthor: {{author}}\npublished: {{published}}\nclipped: {{clipped}}\ntags: {{tags}}\nsite: {{site}}');
  await options.evaluate(() => document.activeElement?.blur());
  await shot(options.locator('#front-matter'), 'options-front-matter', { curated: true });

  const after = await openPopupFor(page);
  await previewReady(after);
  const custom = await downloadFrom(after, after.locator('#download-md'));
  assert.ok(custom.content.includes('tags: [travel, rail]\nsite: "The Daily Courier"\n---\n\nTravel\n\n# Night trains'), custom.content.slice(0, 400));

  // Turned off: plain Markdown.
  await setSettings({ frontMatter: false });
  const off = await openPopupFor(page);
  await previewReady(off);
  assert.ok(await off.locator('#front-matter').isHidden());
  const plain = await downloadFrom(off, off.locator('#download-md'));
  assert.ok(plain.content.startsWith('Travel\n\n# Night trains return to Central Europe'), plain.content.slice(0, 80));
});

// --- Math ----------------------------------------------------------------------------------

await test('math: KaTeX and MathJax formulas are copied as LaTeX', async () => {
  const page = await open(NOTES);
  await resetClipboard(page);
  await select(page, '#notes');
  await menu(page, 'uc:copy:markdown');
  const md = await clipboardText(page);
  for (const part of [
    'A simple linear model predicts $\\hat{y} = \\beta_0 + \\beta_1 x$ from a single input $x$.',
    '$$\n\\beta_1 = \\frac{\\sum_{i=1}^{n} (x_i - \\bar{x})(y_i - \\bar{y})}{\\sum_{i=1}^{n} (x_i - \\bar{x})^2}\n$$',
    'Both sums use the sample mean $\\bar{x} = \\frac{1}{n}\\sum_{i=1}^{n} x_i$, and the same for $y$.',
    '$$\nR^2 = 1 - \\frac{\\mathrm{SS}_{\\text{res}}}{\\mathrm{SS}_{\\text{tot}}}\n$$',
    'The errors are assumed to be normal, $\\varepsilon \\sim \\mathcal{N}(0, \\sigma^2)$, with the same variance for every observation.',
  ]) {
    assert.ok(md.includes(part), `has ${part}\n---\n${md}`);
  }
  for (const junk of ['ŷ', 'β₀', 'SSres', 'x̄ =']) assert.ok(!md.includes(junk), `no rendered glyphs "${junk}"`);

  // Plain text keeps the LaTeX too.
  await select(page, '#model');
  await menu(page, 'uc:copy:text');
  assert.equal(await clipboardText(page), 'A simple linear model predicts $\\hat{y} = \\beta_0 + \\beta_1 x$ from a single input $x$.');

  await select(page, '#notes');
  const popup = await openPopupFor(page);
  assert.ok((await previewReady(popup)).includes('$\\hat{y} = \\beta_0 + \\beta_1 x$'));
  await shot(popup.locator('body'), 'popup-math', { curated: true });
});

// --- Tables ----------------------------------------------------------------------------------

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
  const base = origin.wiki;
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
      `[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](${origin.code}/example/universal-copy/blob/main/LICENSE)`,
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

await test('popup: compact table rows copy in the last format used and expand for more', async () => {
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
  // Rows are compact: no previews or format buttons until a row is opened.
  assert.equal(await popup.locator('.table-panel:not([hidden])').count(), 0);
  assert.equal(await first.locator('[data-copy-last]').innerText(), 'Copy CSV');
  assert.ok((await previewReady(popup)).startsWith('| Region | City     | Population / 2010 | Population / 2020 |'));
  await shot(popup.locator('body'), 'popup-tables-page');

  await first.locator('[data-copy-last]').click();
  await first.locator('[data-copy-last].is-copied').waitFor();
  await shot(popup.locator('body'), 'popup-copied', { clip: { x: 0, y: 0, width: 380, height: 420 } });
  assert.match(await popup.locator('#status').innerText(), /Copied Pricing as CSV: 4 rows × 4 columns/);
  assert.equal(await clipboardText(page), 'Plan,Price,Seats,Support\nFree,$0,1,\nPro,$12/mo,5,Email\nTeam,$30/mo,25,"Priority, 24/7"');

  // Opening a row shows its preview and every format; the one used becomes the default.
  await popup.bringToFront();
  await expandTable(spans);
  assert.equal(await spans.locator('.table-more').getAttribute('aria-expanded'), 'true');
  assert.equal(await spans.locator('.table-preview tr').count(), 4);
  await spans.locator('[data-format="tsv"]').click();
  await spans.locator('[data-format="tsv"].is-copied').waitFor();
  assert.ok((await clipboardHtml(page))?.includes('<th>Population</th><th>Population</th>'));
  await popup.bringToFront();
  await popup.waitForFunction(() => [...document.querySelectorAll('[data-copy-last]')].every((button) => button.textContent === 'Copy TSV'));
  assert.equal(await worker.evaluate(async () => (await chrome.storage.local.get('popup')).popup.tableFormat), 'tsv');
  // The table list itself (scrolled into view), with a little of the popup around it.
  const area = await popup.evaluate(() => {
    const section = document.getElementById('tables-section');
    section.scrollIntoView({ block: 'start' });
    const box = section.getBoundingClientRect();
    return { top: box.top, height: box.height };
  });
  const top = Math.max(0, area.top - 12);
  await shot(popup, 'popup-tables', { curated: true, clip: { x: 0, y: top, width: 380, height: Math.min(600 - top, area.height + 24) } });

  // The selection card copies the selection.
  await popup.locator('#copy-clip').click();
  await popup.locator('#copy-clip.is-copied').waitFor();
  assert.ok((await clipboardText(page)).startsWith('| Region | City     | Population / 2010 | Population / 2020 |'));

  const dark = await openPopupFor(page, 'dark');
  await dark.locator('.table-item').first().waitFor();
  assert.equal(await dark.locator('[data-copy-last]').first().innerText(), 'Copy TSV', 'the last format is remembered');
  await shot(dark.locator('body'), 'popup-tables-dark');
});

await test('popup: the main view on a news page (light and dark)', async () => {
  const page = await open(`${NEWS}?utm_source=newsletter&utm_medium=email`);
  await cookies(page, true);
  await page.evaluate(() => document.getElementById('timetable').scrollIntoView({ block: 'center' }));
  await select(page, '#timetable');
  const popup = await openPopupFor(page);
  const preview = await previewReady(popup);
  assert.ok(preview.startsWith('The new timetable starts in December.'), preview);
  // "This page" shows the link that gets copied (long title shortened, address in full): no
  // tracking parameters. The tooltip has the exact string.
  assert.equal(await popup.locator('#page-link').innerText(), `[Night trains return to Central…](${newsUrl})`);
  assert.equal(await popup.locator('#page-link').getAttribute('title'), `[${newsTitle}](${newsUrl})`);
  // With one table, everything (down to the footer) fits in Chrome's 600px popup limit.
  const footer = await popup.locator('.popup-footer').boundingBox();
  assert.ok(footer && footer.y + footer.height <= 600, `footer ends at ${footer && footer.y + footer.height}px`);
  assert.equal(await popup.locator('.table-item').count(), 1);
  assert.equal(await popup.locator('.table-title').innerText(), 'Night train routes from December');
  await shot(popup.locator('body'), 'popup-light', { curated: true });
  const dark = await openPopupFor(page, 'dark');
  await previewReady(dark);
  await shot(dark.locator('body'), 'popup-dark', { curated: true });
});

await test('Pro: copy page link as Markdown from the page context menu, tracking parameters removed', async () => {
  const page = await open('article.html?id=3&utm_source=newsletter&fbclid=abc#what-changed');
  await resetClipboard(page);
  const message = await menu(page, 'uc:page-link', { selectionText: undefined });
  assert.equal(message.title, 'Copied page link as Markdown');
  const expected = `[Shipping a Chrome extension in 2026 | Example Blog](${origin.blog}/article.html?id=3#what-changed)`;
  assert.equal(await clipboardText(page), expected);
  assert.equal(await clipboardHtml(page), `<a href="${origin.blog}/article.html?id=3#what-changed">Shipping a Chrome extension in 2026 | Example Blog</a>`);
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
  const markdown = await previewReady(popup);
  assert.equal(await popup.locator('#page-link').innerText(), `[Plans and data | Example Data](${origin.data}/tables.html)`);
  assert.equal(await popup.locator('.pro-badge').count(), 1 + 1 + 1, 'badge on the page link, the .md download and front matter');

  await popup.locator('#copy-page-link').click();
  await popup.locator('#copy-page-link.is-copied').waitFor();
  assert.equal(await clipboardText(page), `[Plans and data | Example Data](${origin.data}/tables.html)`);

  await popup.bringToFront();
  const today = await popup.evaluate(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  });
  const md = await downloadFrom(popup, popup.locator('#download-md'));
  assert.equal(md.name, 'Plans and data Example Data.md');
  // Lines for the author and date the page doesn't have are left out.
  assert.equal(md.content, `---\ntitle: "Plans and data | Example Data"\nurl: ${origin.data}/tables.html\nclipped: ${today}\ntags: [clippings]\n---\n\n${markdown}\n`);
  assert.ok(markdown.startsWith('| Region | City     | Population / 2010 | Population / 2020 |'), markdown);
  await popup.locator('#download-md.is-copied').waitFor();
  assert.match(await popup.locator('#status').innerText(), /Downloaded Plans and data Example Data\.md/);

  const pricing = popup.locator('.table-item').first();
  await expandTable(pricing);
  assert.equal(await pricing.locator('.pro-badge').count(), 1, 'an opened row shows its download badge');
  const csv = await downloadFrom(popup, pricing.locator('[data-download="csv"]'));
  assert.equal(csv.name, 'Pricing.csv');
  assert.equal(csv.content, '\ufeffPlan,Price,Seats,Support\nFree,$0,1,\nPro,$12/mo,5,Email\nTeam,$30/mo,25,"Priority, 24/7"\n');
  const json = await downloadFrom(popup, pricing.locator('[data-download="json"]'));
  assert.equal(json.name, 'Pricing.json');
  assert.deepEqual(JSON.parse(json.content)[0], { Plan: 'Free', Price: '$0', Seats: '1', Support: '' });

  const untitled = popup.locator('.table-item').last();
  assert.equal(await untitled.locator('.table-title').innerText(), 'Table 8');
  await expandTable(untitled);
  const plain = await downloadFrom(popup, untitled.locator('[data-download="csv"]'));
  assert.equal(plain.name, 'Plans and data Example Data - table 8.csv');
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
  // Free features still work: tables, the selection, quotes.
  await popup.locator('.table-item').first().locator('[data-copy-last]').click();
  await popup.locator('.table-item').first().locator('[data-copy-last].is-copied').waitFor();
  await previewReady(popup);
  await popup.locator('#front-matter summary').click();
  assert.match(await popup.locator('#front-matter-note').innerText(), /Front matter template is part of Universal Copy Pro/);
  assert.ok(await popup.locator('#front-matter-preview').isHidden());
  let downloads = 0;
  popup.on('download', () => downloads++);
  await expandTable(popup.locator('.table-item').first());
  await popup.locator('.table-item').first().locator('[data-download="json"]').click();
  await popup.locator('#notice [data-key="pro"]').waitFor();
  assert.match(await popup.locator('#notice').innerText(), /Pro feature\s+Download as file is part of Universal Copy Pro \(\$2\.99 once\)\. Everything else stays free\./);
  await popup.locator('#download-md').click();
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
  assert.ok(await options.locator('#fm-template').isDisabled(), 'the front matter editor is off on Free');
  assert.match(await options.locator('#fm-note').innerText(), /Front matter template is part of Universal Copy Pro/);

  // A Pro license (set by the future payments adapter) turns them on.
  await setPlan('pro');
  await options.reload();
  await options.locator('#pro-status', { hasText: 'Pro is active' }).waitFor();
  assert.ok(await options.locator('#preset-obsidian').isEnabled());
  assert.ok(await options.locator('#fm-template').isEnabled());
});

await test('popup: a changed table is reported instead of copying stale data', async () => {
  const page = await open('tables.html');
  const popup = await openPopupFor(page);
  await popup.locator('.table-item').first().waitFor();
  await page.evaluate(() => document.querySelector('#pricing thead th').replaceChildren('Tier'));
  await popup.bringToFront();
  await popup.locator('.table-item').first().locator('[data-copy-last]').click();
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
  assert.ok(await popup.locator('#clip-state .placeholder').first().isVisible(), 'the clip card shows a skeleton too');
  await shot(popup.locator('body'), 'popup-loading');
  await popup.locator('.table-item').first().waitFor({ timeout: 10000 });
});

await test('popup: empty states and pages that cannot be read', async () => {
  const page = await open('form.html');
  const popup = await openPopupFor(page);
  await popup.locator('#tables .empty-state').waitFor();
  assert.match(await popup.locator('#tables').innerText(), /No tables on this page/);
  // Nothing selected: the article tab; the selection tab says what to do.
  await previewReady(popup);
  await popup.locator('#tab-selection').click();
  await popup.locator('#clip-state .empty-state').waitFor();
  assert.match(await popup.locator('#clip-state').innerText(), /Select text on the page/);
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
  assert.ok(await unreadable.locator('#clip-section').isHidden());
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

  const article = await worker.evaluate(
    (tab) => globalThis.__universalCopyTest.onContextMenuClick({ menuItemId: 'uc:article', frameId: 0, pageUrl: 'chrome://version', editable: false }, tab),
    tab,
  );
  assert.equal(article.title, "Can't read this page");
  await worker.evaluate(() => chrome.storage.session.remove('notice'));
});

await test('options: settings persist, the Markdown and quote previews follow, the shortcuts are shown', async () => {
  const page = await newPage();
  await page.setViewportSize({ width: 900, height: 700 });
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  assert.equal(await page.locator('#shortcut').innerText(), 'Alt+C');
  assert.equal(await page.locator('#quote-shortcut').innerText(), 'Alt+Q');
  assert.equal(await page.locator('#markdown-sample').innerText(), '- A list with *italic* text\n- **Bold** and `code`');
  assert.equal(
    await page.locator('#quote-sample').innerText(),
    '> Sleepers leave Vienna at 19:40 and reach Rome at 09:55.\n\n— [Night trains return to Central Europe](https://news.example.com/travel/night-trains-return#:~:text=Sleepers%20leave%20Vienna)',
  );
  await page.locator('label[for="format-markdown"]').click();
  await page.locator('#save-status', { hasText: 'Saved' }).waitFor();
  await page.locator('label[for="bullet-star"]').click();
  await page.locator('label[for="emphasis-underscore"]').click();
  await page.waitForFunction(() => document.getElementById('markdown-sample').textContent === '* A list with _italic_ text\n* **Bold** and `code`');
  await page.locator('#include-link-urls').check();
  await page.locator('#csv-semicolon').check();
  await page.locator('#quote-text').check();
  await page.waitForFunction(() => document.getElementById('quote-sample').textContent.startsWith('“Sleepers leave Vienna'));
  await page.locator('#save-status', { hasText: 'Saved' }).waitFor();
  await waitFor(() => worker.evaluate(async () => (await chrome.storage.local.get('settings')).settings?.quoteStyle === 'text'), 'quote style saved');
  const settings = await worker.evaluate(async () => (await chrome.storage.local.get('settings')).settings);
  assert.deepEqual(settings, {
    shortcutFormat: 'markdown',
    includeLinkUrls: true,
    bulletMarker: '*',
    emphasisMarker: '_',
    csvDelimiter: ';',
    quoteStyle: 'text',
    frontMatter: true,
    frontMatterTemplate: 'title: {{title}}\nurl: {{url}}\nauthor: {{author}}\npublished: {{published}}\nclipped: {{clipped}}\ntags: {{tags}}',
    defaultTags: 'clippings',
  });
  await page.reload();
  assert.ok(await page.locator('#csv-semicolon').isChecked());
  assert.ok(await page.locator('#quote-text').isChecked());
  assert.match(await page.locator('.card').last().innerText(), /no network requests/);
  await page.locator('#quote-markdown').check();
  await page.locator('#save-status', { hasText: 'Saved' }).waitFor();
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
  // Clearly off: grey and dashed, not a lighter brand button.
  const look = await card.locator('#get-pro').evaluate((button) => {
    const style = getComputedStyle(button);
    return { border: style.borderTopStyle, opacity: style.opacity, background: style.backgroundColor, cursor: style.cursor };
  });
  assert.equal(look.border, 'dashed');
  assert.equal(look.opacity, '1');
  assert.equal(look.cursor, 'not-allowed');
  assert.notEqual(look.background, 'rgb(11, 114, 133)');
  assert.deepEqual(await card.locator('#pro-features li .fw-semibold').allInnerTexts(), [
    'Download as file',
    'Front matter template',
    'Copy page link as Markdown',
    'Markdown presets',
  ]);
  await card.scrollIntoViewIfNeeded();
  await shot(card, 'options-pro');

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
    if (!ORIGINS.some((site) => url.startsWith(site)) && !url.startsWith('chrome-extension://') && !url.startsWith('data:')) requests.push(url);
  };
  context.on('request', listener);
  const page = await open('tables.html');
  await select(page, '#pricing');
  await menu(page, 'uc:copy:markdown');
  await menu(page, 'uc:table:json');
  await menu(page, 'uc:quote');
  const news = await open(NEWS);
  await menu(news, 'uc:article', { selectionText: undefined });
  const popup = await openPopupFor(page);
  await popup.locator('.table-item').first().waitFor();
  await previewReady(popup);
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
