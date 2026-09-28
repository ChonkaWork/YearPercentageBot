// End-to-end smoke test: loads the e2e build (dist-e2e/) into a real Chromium and drives
// every user flow against local fixture pages, checking what lands on the clipboard.
//
//   npm run test:e2e        (set CHROMIUM_PATH if Chromium isn't auto-detected)
//   npm run screenshots     same, and refreshes the curated screenshots/ for the README
//
// Native context menus and browser-level shortcuts can't be clicked from automation, so the
// test calls the exact handlers Chrome would call (exposed only in the e2e build). Auto-clean
// is tested with real Ctrl+C key presses in the page.

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

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  // Same article, served with a strict CSP: the toast must still render and be styled.
  const strictCsp = url.pathname === '/csp.html';
  const file = strictCsp ? 'article.html' : url.pathname.slice(1);
  try {
    const body = await readFile(join(fixtures, file));
    const headers = { 'content-type': 'text/html; charset=utf-8' };
    if (strictCsp) headers['content-security-policy'] = "default-src 'none'; style-src 'self' 'unsafe-inline'; script-src 'none'";
    response.writeHead(200, headers).end(body);
  } catch {
    response.writeHead(404).end('not found');
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
// Two different sites under realistic host names (no port), so screenshots never show
// 127.0.0.1, localhost or a port. Chromium maps both names to this server (see the launch args).
const SITE = 'wiki.example.com';
const OTHER_SITE = 'blog.example.org';
const DOCS_SITE = 'docs.example.org';
const base = `http://${SITE}`;
const otherBase = `http://${OTHER_SITE}`;
const docsBase = `http://${DOCS_SITE}`;

// --- Browser ----------------------------------------------------------------------------

await mkdir(outputDir, { recursive: true });
if (curate) await mkdir(screenshotsDir, { recursive: true });
const userDataDir = await mkdtemp(join(tmpdir(), 'clean-copy-e2e-'));
const context = await chromium.launchPersistentContext(userDataDir, {
  executablePath: findChromium(),
  headless,
  viewport: { width: 1280, height: 800 },
  locale: 'en-US',
  args: [
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
    // wiki.example.com, blog.example.org and docs.example.org (port 80) resolve to the local fixture server...
    `--host-resolver-rules=MAP ${SITE}:80 127.0.0.1:${port},MAP ${OTHER_SITE}:80 127.0.0.1:${port},MAP ${DOCS_SITE}:80 127.0.0.1:${port}`,
    // ...directly, not through a proxy from the environment...
    '--no-proxy-server',
    // ...and are secure contexts like 127.0.0.1 and localhost (the Clipboard API needs one).
    `--unsafely-treat-insecure-origin-as-secure=${base},${otherBase},${docsBase}`,
  ],
});
for (const origin of [base, otherBase, docsBase]) await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
const extensionId = new URL(worker.url()).host;

const openPages = new Set();

async function newPage() {
  const page = await context.newPage();
  openPages.add(page);
  return page;
}

async function open(name, origin = base) {
  const page = await newPage();
  await page.goto(name.includes('://') ? name : `${origin}/${name}`);
  await page.bringToFront();
  return page;
}

/** Selects the contents of an element. */
/** Selects from the start of one element to the end of another. */
async function selectBetween(page, from, to) {
  await page.bringToFront();
  await page.evaluate(({ from, to }) => {
    const range = document.createRange();
    range.setStartBefore(document.querySelector(from));
    range.setEndAfter(document.querySelector(to));
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }, { from, to });
}

async function select(page, selector) {
  await page.bringToFront();
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
  let last;
  while (Date.now() < deadline) {
    last = await check();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out: ${message}`);
}

/** What chrome.contextMenus.onClicked would deliver. Returns the toast message shown. */
async function menu(page, extra = {}) {
  const tab = await tabOf(page);
  const selectionText = await page.evaluate(() => window.getSelection()?.toString() ?? '').catch(() => '');
  const info = { menuItemId: 'cc:copy', frameId: 0, pageUrl: page.url(), editable: false, selectionText, ...extra };
  return worker.evaluate(({ info, tab }) => globalThis.__cleanCopyTest.onContextMenuClick(info, tab), { info, tab });
}

async function shortcut(page) {
  const tab = await tabOf(page);
  return worker.evaluate((tab) => globalThis.__cleanCopyTest.onCommand('copy-clean', tab), tab);
}

async function resetClipboard(page) {
  await page.bringToFront();
  await page.evaluate(() => navigator.clipboard.writeText('<empty>'));
}

async function clipboardText(page) {
  await page.bringToFront();
  return page.evaluate(() => navigator.clipboard.readText());
}

async function clipboardTypes(page) {
  await page.bringToFront();
  return page.evaluate(async () => (await navigator.clipboard.read()).flatMap((item) => item.types).sort());
}

async function clipboardHtml(page) {
  await page.bringToFront();
  return page.evaluate(async () => {
    const [item] = await navigator.clipboard.read();
    return item?.types.includes('text/html') ? (await item.getType('text/html')).text() : null;
  });
}

async function writeClipboard(page, text) {
  await page.bringToFront();
  await page.evaluate((text) => navigator.clipboard.writeText(text), text);
}

/** The clean text of a "Show changes" view: everything but the removed runs and markers. */
async function cleanTextOf(locator) {
  return locator.evaluate((element) => {
    const copy = element.cloneNode(true);
    for (const removed of copy.querySelectorAll('.chg-del, .chg-more')) removed.remove();
    return copy.textContent;
  });
}

/** The last clean copy kept in session memory (for Undo and Show changes). */
async function lastCopy() {
  return worker.evaluate(async () => (await chrome.storage.session.get('lastCopy')).lastCopy ?? null);
}

async function badgeText(page) {
  const tab = await tabOf(page);
  return worker.evaluate((tabId) => chrome.action.getBadgeText({ tabId }), tab.id);
}

/** A real Ctrl+C in the page, then what the clipboard holds. */
async function pressCopy(page) {
  await resetClipboard(page);
  await page.keyboard.press('Control+c');
  return waitFor(async () => {
    const text = await clipboardText(page);
    return text !== '<empty>' ? text : null;
  }, 'the copy reached the clipboard');
}

async function setStorage(key, patch) {
  await worker.evaluate(
    async ({ key, patch }) => {
      const current = (await chrome.storage.local.get(key))[key];
      await chrome.storage.local.set({ [key]: Array.isArray(patch) ? patch : { ...(current ?? {}), ...patch } });
    },
    { key, patch },
  );
}

async function resetStorage() {
  await worker.evaluate(() => Promise.all([chrome.storage.local.clear(), chrome.storage.session.clear()]));
  await worker.evaluate(() => globalThis.__cleanCopyTest.syncAutoClean());
}

async function registered() {
  return worker.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts()).map((script) => ({ id: script.id, matches: script.matches })));
}

/** The auto-clean content script's state in a tab (null when the script isn't there). */
async function autoState(page) {
  const tab = await tabOf(page);
  return worker.evaluate(async (tabId) => {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => (typeof globalThis.__cleanCopyAutoState === 'function' ? globalThis.__cleanCopyAutoState() : null),
    });
    return injection?.result ?? null;
  }, tab.id);
}

async function waitForAutoState(page, check, message) {
  return waitFor(async () => {
    const state = await autoState(page);
    return state && check(state) ? state : null;
  }, message);
}

async function openPopupFor(page, colorScheme = 'light') {
  const tab = await tabOf(page);
  const popup = await newPage();
  await popup.emulateMedia({ colorScheme });
  await popup.setViewportSize({ width: 380, height: 600 });
  await popup.goto(`chrome-extension://${extensionId}/popup.html?tabId=${tab.id}`);
  return popup;
}

async function openOptions(colorScheme = 'light') {
  const page = await newPage();
  await page.emulateMedia({ colorScheme });
  await page.setViewportSize({ width: 960, height: 900 });
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  return page;
}

const toast = (page) => page.locator('clean-copy-toast .cc-toast');
const toastTitle = (page) => page.locator('clean-copy-toast .cc-title');
const undoButton = (page) => page.locator('clean-copy-toast .cc-action');

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
// ONLY=<part of a test name> runs matching tests only (while developing).
const only = process.env.ONLY;
async function test(name, fn) {
  if (only && !name.includes(only)) return;
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

const ARTICLE_CLEAN = [
  'Company news',
  'Quarterly update: faster exports',
  'Our new pricing page is live. Read the full announcement for details.',
  'Direct link: https://example.com/pricing?plan=pro',
  '- Faster exports\n- Shared workspaces\n  - For teams of any size',
  'We rebuilt the editor from\nscratch, so long documents\nopen twice as fast.',
  'Questions? Write to us.',
].join('\n\n');

console.log(`Chromium ${context.browser()?.version() ?? ''} · extension ${extensionId}\n`);

await test('production build: minimal permissions, optional host access only, no test code', async () => {
  const manifest = JSON.parse(await readFile(join(root, 'dist/manifest.json'), 'utf8'));
  assert.deepEqual([...manifest.permissions].sort(), ['activeTab', 'clipboardWrite', 'contextMenus', 'offscreen', 'scripting', 'storage']);
  assert.deepEqual(manifest.optional_permissions, ['clipboardRead'], 'clipboard reading is optional, asked on first use');
  assert.deepEqual(manifest.optional_host_permissions, ['*://*/*']);
  assert.deepEqual(manifest.commands['clean-clipboard'], { description: 'Clean the text that is on the clipboard' }, 'no suggested key');
  assert.equal(manifest.host_permissions, undefined);
  assert.equal(manifest.content_scripts, undefined, 'auto-clean is registered at runtime, per granted site');
  assert.equal(manifest.web_accessible_resources, undefined);
  const files = {};
  for (const name of ['background', 'popup', 'page', 'autoclean', 'options', 'offscreen']) files[name] = await readFile(join(root, `dist/${name}.js`), 'utf8');
  assert.ok(!files.background.includes('__cleanCopyTest'), 'test hook compiled out');
  assert.ok(!files.autoclean.includes('__cleanCopyAutoState'), 'content-script test hook compiled out');
  assert.ok(!files.popup.includes('URLSearchParams'), 'popup tab override compiled out');
  assert.ok(!files.popup.includes('askClipboard'), 'popup clipboard-permission override compiled out');
  for (const name of ['page', 'autoclean']) assert.ok(files[name].includes('"closed"') && !files[name].includes('mode: "open"'), `${name}: toast shadow root is closed`);
  for (const [name, source] of Object.entries(files)) {
    assert.ok(!/https?:\/\/(?!www\.w3\.org|example\.com|news\.example\.com)[a-z]/i.test(source.replace(/\/\/.*$/gm, '')), `${name}: no remote URLs`);
    assert.ok(!/\bfetch\(|XMLHttpRequest|WebSocket|sendBeacon/.test(source), `${name}: no network code`);
  }
});

await test('keyboard shortcut Alt+Shift+V is actually assigned by Chrome; Clean clipboard has none until you set one', async () => {
  const commands = await worker.evaluate(() => chrome.commands.getAll());
  const command = commands.find((item) => item.name === 'copy-clean');
  assert.equal(command?.shortcut, 'Alt+Shift+V', JSON.stringify(commands));
  const clipboard = commands.find((item) => item.name === 'clean-clipboard');
  assert.equal(clipboard?.shortcut, '', JSON.stringify(commands));
  assert.equal(clipboard?.description, 'Clean the text that is on the clipboard');
});

await test('context menu "Copy clean": plain text only, no fonts, colors, links, hidden text or tracking', async () => {
  const page = await open('article.html');
  await resetClipboard(page);
  await select(page, '#article');
  const started = Date.now();
  const message = await menu(page);
  const elapsed = Date.now() - started;
  assert.equal(message.title, 'Copied clean text');
  assert.equal(message.detail, `${ARTICLE_CLEAN.length} characters · removed 2 tracking parameters and 1 invisible character`);
  assert.equal(await clipboardText(page), ARTICLE_CLEAN);
  assert.deepEqual(await clipboardTypes(page), ['text/plain'], 'no text/html: pastes without formatting');
  await toast(page).waitFor();
  assert.match(await toast(page).innerText(), /Copied clean text/);
  assert.ok(elapsed < 1500, `took ${elapsed} ms`);

  // The original is kept in session memory, with its HTML and the list of changes.
  const kept = await lastCopy();
  assert.equal(kept.via, 'menu');
  assert.equal(kept.host, SITE);
  assert.equal(kept.cleaned, ARTICLE_CLEAN);
  assert.match(kept.original.text, /Our new pricing\u200B page is live/);
  assert.match(kept.original.html, /<a href="https:\/\/example\.com\/blog\/pricing\?utm_source=newsletter&amp;utm_medium=email"[^>]*>full announcement<\/a>/);
  assert.ok(!kept.original.html.includes('Advertisement'), 'hidden elements are not part of the original');
  assert.deepEqual(
    kept.changes.filter((segment) => segment.op === 'del').map((segment) => [segment.kind, segment.text]),
    [
      ['invisible', '\u200B'],
      ['tracking', '&utm_source=newsletter&fbclid=IwAR0abc'],
    ],
  );
  assert.equal(await undoButton(page).innerText(), 'Undo');
  await shot(page, 'toast-light', { curated: true });
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot(page, 'toast-dark');

  // Undo: the original goes back on the clipboard, formatting included.
  await page.emulateMedia({ colorScheme: 'light' });
  await undoButton(page).click();
  await toastTitle(page).filter({ hasText: 'Original restored' }).waitFor();
  assert.equal(await undoButton(page).count(), 0, 'Undo is done');
  assert.deepEqual(await clipboardTypes(page), ['text/html', 'text/plain']);
  const restored = await clipboardText(page);
  assert.match(restored, /Our new pricing\u200B page is live/);
  assert.match(restored, /utm_source=newsletter&fbclid=IwAR0abc/);
  assert.match(await clipboardHtml(page), /href="https:\/\/example\.com\/blog\/pricing\?utm_source=newsletter/);
  assert.ok((await lastCopy()).restoredAt > 0);
  await shot(page, 'toast-undo', { curated: true });
});

await test('cleanup options change the result: merge lines, bullets, tracking, spaces', async () => {
  const page = await open('article.html');
  await setStorage('settings', { lineBreaks: 'merge', keepBullets: false, stripTracking: false });
  await select(page, '#article');
  await menu(page);
  const text = await clipboardText(page);
  assert.ok(text.includes('We rebuilt the editor from scratch, so long documents open twice as fast.'), text);
  assert.ok(text.includes('Faster exports\nShared workspaces\nFor teams of any size'), text);
  assert.ok(text.includes('https://example.com/pricing?plan=pro&utm_source=newsletter&fbclid=IwAR0abc'), text);
  assert.ok(!text.includes('​'), 'invisible characters always go');
});

await test('keyboard shortcut copies clean; works in text fields; empty selection explains itself', async () => {
  const page = await open('article.html');
  await resetClipboard(page);
  await select(page, '#title');
  const message = await shortcut(page);
  assert.equal(message.title, 'Copied clean text');
  assert.equal(await clipboardText(page), 'Quarterly update: faster exports');

  const form = await open('form.html');
  await form.evaluate(() => {
    const field = document.getElementById('notes');
    field.focus();
    field.setSelectionRange(0, field.value.length);
  });
  await shortcut(form);
  assert.equal(await clipboardText(form), 'First line of notes\nSecond line with spaces');

  await form.evaluate(() => {
    document.activeElement.blur();
    getSelection().removeAllRanges();
  });
  const empty = await shortcut(form);
  assert.equal(empty.title, 'Nothing is selected');
  await toast(form).waitFor();
  await shot(form, 'toast-error');
});

await test('unscriptable page: cleans the text Chrome gives, confirms with a badge', async () => {
  const reader = await open('article.html');
  await resetClipboard(reader);
  const blocked = await open('chrome://version');
  const tab = await tabOf(blocked);
  const message = await worker.evaluate(
    (tab) =>
      globalThis.__cleanCopyTest.onContextMenuClick(
        { menuItemId: 'cc:copy', frameId: 0, pageUrl: 'chrome://version', editable: false, selectionText: 'Google   Chrome https://example.com/?utm_source=x' },
        tab,
      ),
    tab,
  );
  assert.equal(message.tone, 'info');
  assert.match(message.detail, /Chrome doesn't let extensions read this page/);
  assert.equal(await worker.evaluate((id) => chrome.action.getBadgeText({ tabId: id }), tab.id), '✓');
  assert.equal(await clipboardText(reader), 'Google Chrome https://example.com/');
  const popup = await openPopupFor(blocked);
  await popup.locator('#notice .alert').first().waitFor();
  assert.match(await popup.locator('#notice').innerText(), /Copied clean text/);
  assert.match(await popup.locator('#auto').innerText(), /regular web pages/);
  await shot(popup.locator('body'), 'popup-unreadable');
});

await test('popup: live preview of the cleaned selection, quick options, Copy clean', async () => {
  const page = await open('article.html');
  await resetClipboard(page);
  await select(page, '#article');
  const popup = await openPopupFor(page);
  const preview = popup.locator('#preview');
  await preview.waitFor();
  assert.equal(await cleanTextOf(preview), ARTICLE_CLEAN);
  // Removals are highlighted inline: the tracking parameters struck through, the invisible character as a marker.
  assert.equal(await preview.locator('del.chg-tracking').innerText(), '&utm_source=newsletter&fbclid=IwAR0abc');
  assert.equal(await preview.locator('del.chg-invisible .chg-marker').innerText(), 'ZWSP');
  assert.match(await popup.locator('.clean-stats').innerText(), /removed 2 tracking parameters and 1 invisible character/);
  for (const [id, label] of [['quick-merge', 'Merge lines'], ['quick-bullets', 'Keep bullets'], ['quick-tracking', 'Strip tracking'], ['quick-spaces', 'Collapse spaces']]) {
    assert.equal(await popup.locator(`label[for="${id}"]`).innerText(), label);
    assert.equal(await popup.locator(`#${id}`).getAttribute('role'), 'switch');
  }
  const grid = await popup.locator('.quick-options .form-check').evaluateAll((items) => items.map((item) => Math.round(item.getBoundingClientRect().top)));
  assert.equal(new Set(grid).size, 2, `a 2×2 grid (${grid})`);
  assert.match(await popup.locator('#shortcut-text').innerText(), /Alt\+Shift\+V copies the selection clean/);
  assert.match(await popup.locator('#auto').innerText(), new RegExp(`Clean every copy on ${SITE.replace(/\./g, '\\.')}`));
  const height = await popup.evaluate(() => document.documentElement.scrollHeight);
  assert.ok(height <= 600, `popup fits Chrome's 600px limit (${height}px)`);
  await shot(popup.locator('body'), 'popup-article');

  // Curated screenshots: two paragraphs, so the highlighted removals are in view.
  await selectBetween(page, '#lead', '#link-line');
  const hero = await openPopupFor(page);
  await hero.locator('#preview del.chg-tracking').waitFor();
  await shot(hero.locator('body'), 'popup-light', { curated: true });
  const dark = await openPopupFor(page, 'dark');
  await dark.locator('#preview del.chg-tracking').waitFor();
  await shot(dark.locator('body'), 'popup-dark', { curated: true });
  await select(page, '#article');

  await popup.bringToFront();
  await popup.locator('label[for="quick-merge"]').click();
  await waitFor(async () => (await cleanTextOf(preview)).includes('from scratch, so long'), 'preview follows "Merge lines"');
  assert.ok((await preview.locator('del.chg-line-break').count()) >= 2, 'merged line breaks are marked');
  await popup.locator('label[for="quick-bullets"]').click();
  await waitFor(async () => (await cleanTextOf(preview)).includes('\nFaster exports\nShared workspaces'), 'preview follows "Keep bullets"');
  const settings = await worker.evaluate(async () => (await chrome.storage.local.get('settings')).settings);
  assert.equal(settings.lineBreaks, 'merge');
  assert.equal(settings.keepBullets, false);

  await popup.locator('#copy-clean').click();
  await popup.locator('#copy-clean.is-copied').waitFor();
  assert.equal(await clipboardText(page), await cleanTextOf(preview));

  // Last copy: the copy just made, with what was removed, and Restore original.
  await popup.locator('#tab-last').click();
  const changes = popup.locator('#changes');
  await changes.waitFor();
  assert.equal(await cleanTextOf(changes), await clipboardText(page));
  assert.match(await popup.locator('.last-meta').innerText(), new RegExp(`Toolbar popup.*just now.*${SITE.replace(/\./g, '\\.')}`, 's'));
  assert.equal(await changes.locator('del.chg-tracking').innerText(), '&utm_source=newsletter&fbclid=IwAR0abc');
  assert.ok((await changes.locator('del.chg-bullet').count()) >= 3);
  const legend = (await popup.locator('.chg-legend .chg-key').allInnerTexts()).map((text) => text.replace(/\s+/g, ' '));
  assert.deepEqual(legend, ['text removed', 'ZWSP invisible character', '↵ lines joined']);
  assert.ok(await popup.locator('#quick-options').isHidden(), 'quick options belong to the Selection view');
  const lastHeight = await popup.evaluate(() => document.documentElement.scrollHeight);
  assert.ok(lastHeight <= 600, `Last copy fits Chrome's 600px limit (${lastHeight}px)`);
  await shot(popup.locator('body'), 'popup-last-article');
  await popup.locator('#restore-original').click();
  await popup.locator('#restored', { hasText: 'Original restored' }).waitFor();
  assert.deepEqual(await clipboardTypes(page), ['text/html', 'text/plain']);
  assert.match(await clipboardText(page), /We rebuilt the editor from\nscratch/);
  await popup.bringToFront();
  await popup.locator('#copy-again').click();
  await popup.locator('#restore-original').waitFor();
  assert.equal(await clipboardText(page), await cleanTextOf(changes));
  assert.deepEqual(await clipboardTypes(page), ['text/plain']);
  // "Show changes" off: just the clean text.
  await popup.bringToFront();
  await popup.locator('label[for="show-changes"]').click();
  await waitFor(async () => (await changes.locator('.chg').count()) === 0, 'plain view');
  assert.equal(await changes.innerText(), await clipboardText(page));
  await popup.bringToFront();
  await popup.locator('label[for="show-changes"]').click();
  // Forget: removed from memory right away.
  await popup.locator('#forget-copy').click();
  await popup.locator('#last .empty-state').waitFor();
  assert.equal(await lastCopy(), null);

  const form = await open('form.html');
  const emptyPopup = await openPopupFor(form);
  await emptyPopup.locator('#selection .empty-state').waitFor();
  assert.match(await emptyPopup.locator('#selection').innerText(), /Select text on the page/);
  assert.ok(await emptyPopup.locator('#clean-clipboard').isVisible(), 'Clean clipboard is there without a selection');
  await shot(emptyPopup.locator('body'), 'popup-empty');
});

await test('the real toolbar popup opens over the page and previews its selection', async () => {
  const probe = await newPage();
  await probe.goto(`chrome-extension://${extensionId}/options.html`);
  const page = await open('article.html');
  await select(page, '#title');
  await worker.evaluate(() => chrome.action.openPopup());
  await waitFor(
    () =>
      probe.evaluate(() => {
        const [popup] = chrome.extension.getViews({ type: 'popup' });
        return popup?.document.getElementById('preview')?.textContent === 'Quarterly update: faster exports';
      }),
    'popup previews the selection of the active tab',
  );
  await page.close();
});

await test('auto-clean: turned on from the popup, a real Ctrl+C comes out clean, only on that site', async () => {
  const page = await open('article.html');
  // Before: a normal copy keeps the page's formatting and junk.
  await select(page, '#lead');
  const raw = await pressCopy(page);
  assert.ok(raw.includes('​') || (await clipboardTypes(page)).includes('text/html'), 'without auto-clean the copy is the browser default');

  const popup = await openPopupFor(page);
  await popup.locator('#auto-here').waitFor();
  assert.equal(await popup.locator('#auto-here').isChecked(), false);
  await popup.locator('#auto-here').click();
  await popup.locator('#auto-state', { hasText: 'Auto-clean is on here' }).waitFor();
  assert.match(await popup.locator('#auto-state').innerText(), /Ctrl\+C here copies clean text/);
  assert.equal(await popup.locator('#auto-pill').innerText(), 'Auto-clean on');
  assert.deepEqual(await worker.evaluate(async () => (await chrome.storage.local.get('sites')).sites), [SITE]);
  assert.deepEqual(await registered(), [{ id: 'clean-copy-auto-clean', matches: [`*://${SITE}/*`] }]);
  await shot(popup.locator('body'), 'popup-auto-on', { curated: true });

  // The tab that was already open got the script without a reload.
  await waitForAutoState(page, (state) => state.sites.includes(SITE), 'content script injected into the open tab');
  // The toolbar badge says Ctrl+C is being rewritten on this tab.
  await waitFor(async () => (await badgeText(page)) === 'ON', 'ON badge on the auto-clean tab');
  await select(page, '#article');
  assert.equal(await pressCopy(page), ARTICLE_CLEAN);
  assert.deepEqual(await clipboardTypes(page), ['text/plain']);
  await toast(page).waitFor();
  assert.equal(await toastTitle(page).innerText(), 'Copied clean');
  assert.equal(await undoButton(page).innerText(), 'Undo');
  await shot(page, 'auto-clean-toast', { curated: true });
  const kept = await waitFor(async () => {
    const copy = await lastCopy();
    return copy?.via === 'auto' ? copy : null;
  }, 'auto-clean copy kept for Undo');
  assert.equal(kept.host, SITE);
  assert.equal(kept.cleaned, ARTICLE_CLEAN);
  await undoButton(page).click();
  await toastTitle(page).filter({ hasText: 'Original restored' }).waitFor();
  assert.deepEqual(await clipboardTypes(page), ['text/html', 'text/plain']);
  assert.match(await clipboardText(page), /utm_source=newsletter&fbclid=IwAR0abc/);

  // A fresh page load on the site: the registered script is there from the start.
  await page.reload();
  await waitForAutoState(page, (state) => state.sites.includes(SITE), 'registered script runs after a reload');
  await select(page, '#link-line');
  assert.equal(await pressCopy(page), 'Direct link: https://example.com/pricing?plan=pro');

  // Another site (blog.example.org) was not added: its copies are left alone.
  const other = await open('article.html', otherBase);
  assert.equal(await autoState(other), null, 'no content script on other sites');
  assert.equal(await badgeText(other), '', 'no badge on other sites');
  await select(other, '#link-line');
  assert.match(await pressCopy(other), /utm_source=newsletter/);
});

await test('auto-clean: text fields are left alone unless the setting says otherwise; site copy handlers are cleaned', async () => {
  await setStorage('sites', [SITE]);
  await worker.evaluate(() => globalThis.__cleanCopyTest.syncAutoClean());
  const form = await open('form.html');
  await waitForAutoState(form, (state) => state.sites.includes(SITE), 'content script ready');
  await form.evaluate(() => {
    const field = document.getElementById('notes');
    field.focus();
    field.setSelectionRange(0, field.value.length);
  });
  assert.equal(await pressCopy(form), 'First line of notes\nSecond  line with   spaces​', 'field copy untouched');

  await setStorage('settings', { autoCleanEditors: true });
  await waitForAutoState(form, (state) => state.settings.autoCleanEditors, 'content script sees the new setting');
  await form.evaluate(() => document.getElementById('notes').focus());
  assert.equal(await pressCopy(form), 'First line of notes\nSecond line with spaces');

  const story = await open('attribution.html');
  await waitForAutoState(story, (state) => state.sites.includes(SITE), 'content script ready');
  await select(story, '#story');
  assert.equal(await pressCopy(story), 'The council approved the new bike lanes on Tuesday.\n\nRead more at: https://news.example.com/story/42');
  assert.deepEqual(await clipboardTypes(story), ['text/plain'], "the site's styled HTML is gone");
  assert.equal(await toastTitle(story).innerText(), 'Copied clean (site text)');
  // Undo gives back exactly what the site put on the clipboard, its HTML included.
  await undoButton(story).click();
  await toastTitle(story).filter({ hasText: 'Original restored' }).waitFor();
  assert.equal(await clipboardText(story), 'The council approved the new\u200B bike lanes on Tuesday.\n\nRead more at: https://news.example.com/story/42?utm_source=copy&utm_medium=clipboard');
  assert.match(await clipboardHtml(story), /<b style="color:red">/);
});

await test('custom rules: validated and previewed live in settings, applied to auto-clean and Copy clean', async () => {
  await setStorage('sites', [SITE]);
  await worker.evaluate(() => globalThis.__cleanCopyTest.syncAutoClean());
  const options = await openOptions();
  await options.locator('#add-rule').click();
  const rule = options.locator('.rule').first();
  await rule.locator('.rule-mode').selectOption('regex');
  await rule.locator('.rule-find').fill('(Read more at:.*');
  await rule.locator('.rule-error', { hasText: 'not a valid regular expression' }).waitFor();
  await rule.locator('.rule-find').fill('(\\w+\\s?)+$');
  await rule.locator('.rule-error', { hasText: 'can take forever' }).waitFor();
  await rule.locator('.rule-find').fill('^Read more at:.*$');
  await waitFor(async () => (await rule.locator('.rule-error').innerText()) === '', 'error clears');
  await waitFor(async () => !(await options.locator('#rules-output').innerText()).includes('Read more'), 'live preview applies the rule');
  assert.match(await options.locator('#rules-summary').innerText(), /1 replacement by 1 rule/);

  await options.locator('#add-rule').click();
  const second = options.locator('.rule').nth(1);
  await second.locator('.rule-find').fill('council');
  await second.locator('.rule-replace').fill('City Council');
  await waitFor(async () => {
    const { rules } = await worker.evaluate(() => chrome.storage.local.get('rules'));
    return rules?.length === 2 && rules[1].replace === 'City Council' && rules[0].find === '^Read more at:.*$';
  }, 'rules saved');
  await shot(options.locator('#rules-card'), 'rules-light', { curated: true });

  const story = await open('attribution.html');
  await waitForAutoState(story, (state) => state.rules.length === 2, 'content script has the rules');
  await select(story, '#story');
  assert.equal(await pressCopy(story), 'The City Council approved the new bike lanes on Tuesday.');

  await select(story, '#story');
  await menu(story);
  assert.equal(await clipboardText(story), 'The City Council approved the new bike lanes on Tuesday.');

  // Order matters and can be changed.
  await options.bringToFront();
  await second.locator('[data-action="up"]').click();
  await waitFor(async () => (await worker.evaluate(() => chrome.storage.local.get('rules'))).rules?.[0]?.find === 'council', 'reordered');
});

await test('removing a site stops auto-clean right away (open tabs too) and unregisters the script', async () => {
  await setStorage('sites', [SITE]);
  await worker.evaluate(() => globalThis.__cleanCopyTest.syncAutoClean());
  const page = await open('article.html');
  await waitForAutoState(page, (state) => state.sites.includes(SITE), 'content script ready');
  await select(page, '#link-line');
  assert.equal(await pressCopy(page), 'Direct link: https://example.com/pricing?plan=pro');

  const options = await openOptions();
  const item = options.locator(`.site-item[data-host="${SITE}"]`);
  await item.waitFor();
  assert.match(await item.innerText(), /Active/);
  await shot(options.locator('#auto-card'), 'sites-light');
  await item.locator('[data-action="remove"]').click();
  await options.locator('#sites .empty-state').waitFor();
  await waitFor(async () => (await registered()).length === 0, 'content script unregistered');
  await waitFor(async () => (await badgeText(page)) === '', 'ON badge cleared');

  await waitForAutoState(page, (state) => state.sites.length === 0, 'open tab sees the removal');
  await select(page, '#link-line');
  assert.match(await pressCopy(page), /utm_source=newsletter/, 'open tab: normal copy again');
  await page.reload();
  assert.equal(await autoState(page), null, 'no script after a reload');
  await select(page, '#link-line');
  assert.match(await pressCopy(page), /utm_source=newsletter/);
});

await test('options: settings persist, example follows, sites can be added by typing, About Pro', async () => {
  const page = await openOptions();
  assert.equal(await page.locator('#shortcut').innerText(), 'Alt+Shift+V');
  const after = page.locator('#sample-after');
  assert.equal(
    await after.innerText(),
    'Our new pricing page is live:\nhttps://example.com/pricing?plan=pro\n\nWe rebuilt the editor from\nscratch, so long documents\nopen twice as fast.\n\n• Faster exports\n• Shared work-\n  spaces for teams',
  );
  await page.locator('label[for="breaks-merge"]').click();
  await page.locator('#keep-bullets').uncheck();
  await waitFor(
    async () => (await after.innerText()) === 'Our new pricing page is live: https://example.com/pricing?plan=pro\n\nWe rebuilt the editor from scratch, so long documents open twice as fast.\n\nFaster exports\nShared workspaces for teams',
    'example follows the options',
  );
  await page.locator('#save-status', { hasText: 'Saved' }).waitFor();

  await page.locator('#add-site').fill('chrome://settings');
  await page.locator('#add-site-button').click();
  await page.locator('#add-site-error', { hasText: 'http and https' }).waitFor();
  // A full address (scheme, port, path) is reduced to its host name.
  await page.locator('#add-site').fill(`http://${SITE}:8080/some/page`);
  await page.locator('#add-site-button').click();
  await page.locator(`.site-item[data-host="${SITE}"]`, { hasText: 'Active' }).waitFor();
  await waitFor(async () => (await registered()).length === 1, 'registered');

  await page.locator('#add-rule').click();
  await page.locator('.rule .rule-find').fill('Sent from my phone');
  await page.locator('.rule .rule-replace').fill('');
  await page.locator('#save-status', { hasText: 'Saved' }).waitFor();
  assert.match(await page.locator('#pro-note').innerText(), /Free during early access/);
  assert.equal(await page.locator('#get-pro').innerText(), 'Get Pro · $1.99 once');
  assert.ok(await page.locator('#get-pro').isDisabled());

  const stored = await worker.evaluate(() => chrome.storage.local.get(['settings', 'sites']));
  assert.equal(stored.settings.lineBreaks, 'merge');
  assert.equal(stored.settings.keepBullets, false);
  assert.deepEqual(stored.sites, [SITE]);
  await page.reload();
  assert.ok(await page.locator('#breaks-merge').isChecked());
  // Curated screenshots with default cleanup options.
  await setStorage('settings', { lineBreaks: 'keep', keepBullets: true });
  await setStorage('rules', [
    { id: 'readmore', enabled: true, mode: 'regex', find: '^Read more at:.*$', replace: '', caseSensitive: false },
    { id: 'iphone', enabled: true, mode: 'text', find: 'Sent from my iPhone', replace: '', caseSensitive: true },
  ]);
  await page.reload();
  await page.locator(`.site-item[data-host="${SITE}"]`).waitFor();
  // From the top: the sticky nav sits under the title in a full-page capture.
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await shot(page, 'options-light', { curated: true, fullPage: true });
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot(page, 'options-dark', { curated: true, fullPage: true });
});

const NOTES_ANSWER_CLEAN = [
  'Launch plan',
  'Ship the beta on Tuesday - it\'s "ready"...',
  '- Update the pricing page (https://docs.example.org/pricing)',
  '- Email early users',
  '```',
  'npm run release -- --tag beta',
  '```',
].join('\n');

await test('typography, Markdown and link addresses: opt-in options, shown as changes', async () => {
  const page = await open('notes.html', docsBase);
  await resetClipboard(page);
  // Off by default: quotes, dashes and Markdown stay.
  await select(page, '#answer');
  await menu(page);
  assert.match(await clipboardText(page), /^## Launch plan\n\*\*Ship\*\* the beta on Tuesday — it’s “ready”…\n\* Update the \[pricing page\]\(https:\/\/docs\.example\.org\/pricing\)/);

  await setStorage('settings', { typography: true, removeMarkdown: true, keepLinkUrls: true });
  await select(page, '#answer');
  const message = await menu(page);
  assert.equal(await clipboardText(page), NOTES_ANSWER_CLEAN);
  assert.match(message.detail, /removed 1 tracking parameter and \d+ Markdown marks · \d+ typography fixes/);
  await select(page, '#linked');
  await menu(page);
  assert.equal(await clipboardText(page), 'Read the setup guide (https://docs.example.org/setup?ref=nav) first - it takes "five minutes"...');

  // The dash setting keeps dashes.
  await setStorage('settings', { dashes: 'keep' });
  await select(page, '#linked');
  await menu(page);
  assert.equal(await clipboardText(page), 'Read the setup guide (https://docs.example.org/setup?ref=nav) first — it takes "five minutes"...');

  // Show changes for the Markdown answer.
  await setStorage('settings', { dashes: 'hyphen' });
  await select(page, '#answer');
  await menu(page);
  const popup = await openPopupFor(page);
  await popup.locator('#preview').waitFor();
  await popup.locator('#tab-last').click();
  const changes = popup.locator('#changes');
  assert.equal(await cleanTextOf(changes), NOTES_ANSWER_CLEAN);
  assert.deepEqual(await changes.locator('del.chg-markdown').allInnerTexts(), ['## ', '**', '**', '*', '[', '](', '*', '*', '*']);
  assert.deepEqual(await changes.locator('ins.chg-typography').allInnerTexts(), ['-', "'", '"', '"', '...']);
  assert.equal(await changes.locator('del.chg-tracking').innerText(), '?utm_source=chatgpt.com');
  assert.match(await popup.locator('.last-meta').innerText(), /Right-click menu/);
  await shot(popup.locator('body'), 'popup-changes-light', { curated: true });
  const dark = await openPopupFor(page, 'dark');
  await dark.locator('#preview').waitFor();
  await dark.locator('#tab-last').click();
  await shot(dark.locator('body'), 'popup-changes-dark', { curated: true });

  // Settings page: the new options are there and saved.
  const options = await openOptions();
  assert.ok(await options.locator('#typography').isChecked());
  assert.ok(await options.locator('#remove-markdown').isChecked());
  assert.ok(await options.locator('#keep-link-urls').isChecked());
  await options.locator('#dashes').selectOption('keep');
  await waitFor(async () => (await worker.evaluate(async () => (await chrome.storage.local.get('settings')).settings)).dashes === 'keep', 'dash setting saved');
  await options.locator('label[for="typography"]').click();
  await waitFor(async () => options.locator('#dashes').isDisabled(), 'dash setting follows the typography switch');
});

await test('clean clipboard: asks for clipboard access with an explanation, cleans, keeps the original for Undo', async () => {
  const page = await open('article.html');
  await setStorage('settings', { typography: true });
  await writeClipboard(page, 'Meet “Ada” — see https://shop.example.com/item?id=7&utm_source=chatgpt.com​  now');
  // First use (simulated in the e2e build, where access is granted up front): the explanation comes first.
  const popup = await newPage();
  await popup.setViewportSize({ width: 380, height: 600 });
  const tab = await tabOf(page);
  await popup.goto(`chrome-extension://${extensionId}/popup.html?tabId=${tab.id}&askClipboard=1`);
  await popup.locator('#clean-clipboard').click();
  const ask = popup.locator('#clipboard-ask');
  await ask.waitFor();
  assert.match(await ask.innerText(), /reads only when you click Clean clipboard/);
  await popup.mouse.move(0, 0);
  await shot(popup.locator('body'), 'popup-clipboard-ask', { curated: true });
  assert.equal(await clipboardText(page), 'Meet “Ada” — see https://shop.example.com/item?id=7&utm_source=chatgpt.com​  now', 'nothing read before the OK');

  await popup.bringToFront();
  await popup.locator('#allow-clipboard').click();
  await popup.locator('#status', { hasText: 'Clipboard cleaned' }).waitFor({ state: 'attached' });
  assert.equal(await clipboardText(page), 'Meet "Ada" - see https://shop.example.com/item?id=7 now');
  assert.deepEqual(await clipboardTypes(page), ['text/plain']);
  await popup.bringToFront();
  assert.equal(await popup.locator('#tab-last').getAttribute('aria-selected'), 'true', 'Last copy shows what was removed');
  const changes = popup.locator('#changes');
  assert.equal(await changes.locator('del.chg-tracking').innerText(), '&utm_source=chatgpt.com');
  assert.equal(await changes.locator('del.chg-invisible .chg-marker').innerText(), 'ZWSP');
  assert.match(await popup.locator('.last-meta').innerText(), /Clean clipboard/);
  const height = await popup.evaluate(() => document.documentElement.scrollHeight);
  assert.ok(height <= 600, `fits Chrome's 600px limit with the notice (${height}px)`);
  await shot(popup.locator('body'), 'popup-clipboard', { curated: true });
  const kept = await lastCopy();
  assert.equal(kept.via, 'clipboard');
  assert.equal(kept.original.text, 'Meet “Ada” — see https://shop.example.com/item?id=7&utm_source=chatgpt.com​  now');

  await popup.locator('#restore-original').click();
  await popup.locator('#restored').waitFor();
  assert.equal(await clipboardText(page), kept.original.text);

  // Already clean, and nothing to clean.
  await writeClipboard(page, 'Already clean.');
  await popup.bringToFront();
  await popup.locator('#tab-selection').click();
  await popup.locator('#clean-clipboard').click();
  await popup.locator('#clean-clipboard', { hasText: 'Already clean' }).waitFor();
  assert.match(await popup.locator('#status').textContent(), /already clean/);
  assert.equal(await clipboardText(page), 'Already clean.');
  await writeClipboard(page, '   ');
  await popup.bringToFront();
  await popup.locator('#clean-clipboard:not(.is-copied)', { hasText: 'Clean clipboard' }).click();
  await popup.locator('#clean-clipboard', { hasText: 'Clipboard is empty' }).waitFor();
  assert.match(await popup.locator('#status').textContent(), /Nothing to clean/);

  // Clipboard with formatting: the HTML goes, and comes back with Undo.
  await page.bringToFront();
  await page.evaluate(() =>
    navigator.clipboard.write([
      new ClipboardItem({ 'text/plain': new Blob(['Bold  text'], { type: 'text/plain' }), 'text/html': new Blob(['<b style="color:red">Bold  text</b>'], { type: 'text/html' }) }),
    ]),
  );
  // The keyboard command (no suggested key) does the same and confirms in the page, with Undo.
  const outcome = await worker.evaluate((tab) => globalThis.__cleanCopyTest.onCommand('clean-clipboard', tab), tab);
  assert.equal(outcome.status, 'cleaned');
  assert.match(outcome.summary, /^formatting removed · 9 characters/);
  await toastTitle(page).filter({ hasText: 'Clipboard cleaned' }).waitFor();
  assert.equal(await clipboardText(page), 'Bold text');
  assert.deepEqual(await clipboardTypes(page), ['text/plain']);
  await undoButton(page).click();
  await toastTitle(page).filter({ hasText: 'Original restored' }).waitFor();
  assert.equal(await clipboardText(page), 'Bold  text');
  assert.match(await clipboardHtml(page), /<b style="color:\s*red;?">Bold  text<\/b>/);
});

await test('auto-clean on all sites: one switch, registered everywhere, back to per-site when turned off', async () => {
  await setStorage('sites', [SITE]);
  await worker.evaluate(() => globalThis.__cleanCopyTest.syncAutoClean());
  const other = await open('article.html', otherBase);
  assert.equal(await autoState(other), null);
  const options = await openOptions();
  await options.locator(`.site-item[data-host="${SITE}"]`, { hasText: 'Active' }).waitFor();
  assert.equal(await options.locator('#auto-all').isChecked(), false, 'per-site is the default');
  await options.locator('label[for="auto-all"]').click();
  await options.locator('#auto-all-state', { hasText: 'every copy on every site' }).waitFor();
  assert.equal(await worker.evaluate(async () => (await chrome.storage.local.get('allSites')).allSites), true);
  await waitFor(async () => JSON.stringify(await registered()) === JSON.stringify([{ id: 'clean-copy-auto-clean', matches: ['*://*/*'] }]), 'registered for every site');
  await shot(options.locator('#auto-card'), 'sites-all-light');

  // The other site's open tab gets the script and its badge; a real Ctrl+C there comes out clean.
  await waitForAutoState(other, (state) => state.allSites, 'content script on the other site');
  await waitFor(async () => (await badgeText(other)) === 'ON', 'ON badge on the other site');
  await select(other, '#link-line');
  assert.equal(await pressCopy(other), 'Direct link: https://example.com/pricing?plan=pro');
  const popup = await openPopupFor(other);
  await popup.locator('#auto-on').waitFor();
  assert.match(await popup.locator('#auto').innerText(), /Auto-clean is on here[\s\S]*All sites is on/);
  assert.equal(await popup.locator('#auto-here').count(), 0);

  // Off again: back to the list, which kept its site.
  await options.bringToFront();
  await options.locator('label[for="auto-all"]').click();
  await waitFor(async () => JSON.stringify(await registered()) === JSON.stringify([{ id: 'clean-copy-auto-clean', matches: [`*://${SITE}/*`] }]), 'back to per-site');
  await options.locator(`.site-item[data-host="${SITE}"]`, { hasText: 'Active' }).waitFor();
  await waitForAutoState(other, (state) => !state.allSites, 'the other site sees it');
  await waitFor(async () => (await badgeText(other)) === '', 'badge cleared on the other site');
  await select(other, '#link-line');
  assert.match(await pressCopy(other), /utm_source=newsletter/);
});

await test('options: sticky section nav, rule presets', async () => {
  const page = await openOptions();
  const nav = page.locator('#section-nav');
  assert.deepEqual(await nav.locator('a').allInnerTexts(), ['Cleanup', 'Shortcut', 'Auto-clean', 'Rules', 'Pro', 'Privacy']);
  assert.equal(await nav.locator('a.active').innerText(), 'Cleanup');
  await nav.locator('a', { hasText: 'Rules' }).click();
  await waitFor(async () => (await nav.locator('a.active').innerText()) === 'Rules', 'nav follows the scroll');
  const navBox = await nav.boundingBox();
  assert.ok(navBox && navBox.y <= 1, `nav stays at the top (${navBox?.y})`);
  const rulesBox = await page.locator('#rules-card').boundingBox();
  assert.ok(rulesBox && rulesBox.y >= navBox.height - 1 && rulesBox.y < 200, `rules card below the nav (${rulesBox?.y})`);
  assert.equal(await nav.locator('a[aria-current="true"]').innerText(), 'Rules');
  await shot(page, 'options-nav-light');

  assert.deepEqual((await page.locator('#add-preset option').allInnerTexts()).slice(1), [
    'Remove "Read more at …" lines',
    'Remove "Sent from my iPhone"',
    'Remove "Get Outlook for …"',
    'Remove quoted reply lines ("> …")',
    'Remove "utm_source=chatgpt.com" from links',
  ]);
  await page.locator('#add-preset').selectOption('sent-from');
  await page.locator('#add-preset').selectOption('quoted');
  await waitFor(async () => (await worker.evaluate(() => chrome.storage.local.get('rules'))).rules?.length === 2, 'presets saved');
  const { rules } = await worker.evaluate(() => chrome.storage.local.get('rules'));
  assert.deepEqual(rules.map((rule) => [rule.mode, rule.find, rule.replace]), [
    ['regex', '^Sent from my [\\w ]{2,40}\\.?$', ''],
    ['regex', '^[ \\t]*>.*$', ''],
  ]);
  assert.equal(await page.locator('#add-preset').inputValue(), '', 'the menu resets');
  await page.locator('#rules-input').fill('Thanks!\n> Can you send it?\nSent from my iPhone');
  await waitFor(async () => (await page.locator('#rules-output').innerText()) === 'Thanks!', 'presets apply in the preview');
  await page.locator('#add-preset').selectOption('sent-from');
  await page.locator('#save-status', { hasText: 'already in the list' }).waitFor();
  assert.equal(await page.locator('.rule').count(), 2);
  assert.match(await page.locator('#clipboard-state').innerText(), /Allowed/);
  assert.equal(await page.locator('#shortcut-clipboard').innerText(), 'Not set');
});

await test('strict CSP page: the toast still renders with its styles', async () => {
  const page = await open('csp.html');
  await resetClipboard(page);
  await select(page, 'h1');
  await menu(page);
  await toast(page).waitFor();
  const style = await toast(page).evaluate((element) => {
    const computed = getComputedStyle(element);
    return { radius: computed.borderRadius, position: computed.position };
  });
  assert.equal(style.position, 'fixed');
  assert.notEqual(style.radius, '0px');
  assert.equal(await clipboardText(page), 'Quarterly update: faster exports');
});

await test('no network requests leave the extension', async () => {
  const requests = [];
  const listener = (request) => {
    const url = request.url();
    if (!url.startsWith(`${base}/`) && !url.startsWith(`${otherBase}/`) && !url.startsWith('chrome-extension://') && !url.startsWith('data:')) requests.push(url);
  };
  context.on('request', listener);
  await setStorage('sites', [SITE]);
  await worker.evaluate(() => globalThis.__cleanCopyTest.syncAutoClean());
  const page = await open('article.html');
  await waitForAutoState(page, (state) => state.sites.includes(SITE), 'content script ready');
  await select(page, '#article');
  await menu(page);
  await pressCopy(page);
  const popup = await openPopupFor(page);
  await popup.locator('#preview').waitFor();
  const options = await openOptions();
  await options.locator('#sample-after').waitFor();
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
