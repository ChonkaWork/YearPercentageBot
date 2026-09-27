// End-to-end smoke test: loads the e2e build (dist-e2e/) into a real Chromium, types into
// local fixture pages with real key events and drives the popup and the snippet manager.
//
//   npm run test:e2e                      (set CHROMIUM_PATH if Chromium isn't auto-detected)
//   HEADED=1 npm run test:e2e             (watch it)
//
// Automation can't click the toolbar button, so the popup is also opened as a normal page
// that is told which tab to act on (a hook that only exists in the e2e build).

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
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
const headless = process.env.HEADED !== '1';

function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const candidates = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  const found = candidates.find((path) => existsSync(path));
  if (!found) throw new Error('Chromium not found. Set CHROMIUM_PATH.');
  return found;
}

// --- Fixture server ---------------------------------------------------------------------

const hanging = [];
const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (url.pathname === '/hang.html') {
    // Never finishes loading, so the content script (document_idle) never runs: the popup
    // sees an http(s) tab without Snippets, like a tab opened before installing.
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.write('<!doctype html><title>Still loading</title><p>Still loading…</p>');
    hanging.push(response);
    return;
  }
  try {
    // /ext/… serves the built extension pages as ordinary web pages (no chrome.storage there),
    // to look at their loading and error states.
    const file = url.pathname.startsWith('/ext/') ? join(extensionPath, url.pathname.slice(5)) : join(fixtures, url.pathname.slice(1));
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.woff2': 'font/woff2' };
    const type = types[file.slice(file.lastIndexOf('.'))] ?? 'application/octet-stream';
    const body = await readFile(file);
    response.writeHead(200, { 'content-type': type }).end(body);
  } catch {
    response.writeHead(404).end('not found');
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

// --- Browser ----------------------------------------------------------------------------

await mkdir(outputDir, { recursive: true });
await mkdir(screenshotsDir, { recursive: true });
const userDataDir = await mkdtemp(join(tmpdir(), 'snippets-e2e-'));
const context = await chromium.launchPersistentContext(userDataDir, {
  executablePath: findChromium(),
  headless,
  viewport: { width: 1280, height: 800 },
  args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
});
await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
const isExtensionWorker = (candidate) => candidate.url().startsWith('chrome-extension://');
let worker = context.serviceWorkers().find(isExtensionWorker) ?? (await context.waitForEvent('serviceworker', { predicate: isExtensionWorker }));
// Chrome may restart the service worker (e.g. right after install); always talk to the latest.
context.on('serviceworker', (candidate) => {
  if (isExtensionWorker(candidate)) worker = candidate;
});
const extensionId = new URL(worker.url()).host;
const extensionUrl = (path) => `chrome-extension://${extensionId}/${path}`;

// Every request that isn't the fixture server or the extension itself.
const outsideRequests = [];
context.on('request', (request) => {
  const url = request.url();
  const local = url.startsWith(base) || url.startsWith(`http://localhost:${port}/`);
  if (!local && !/^(chrome-extension|data|blob|about|chrome):/.test(url)) outsideRequests.push(url);
});

const openPages = new Set();

async function newPage() {
  const page = await context.newPage();
  openPages.add(page);
  return page;
}

async function open(name) {
  const page = await newPage();
  await page.goto(`${base}/${name}`);
  await page.bringToFront();
  return page;
}

/** Waits until the content script in `target` (page or frame) has loaded its data. */
async function ready(target) {
  await target.waitForFunction(() => document.documentElement.dataset.snippetsE2e !== undefined);
}

async function openFields() {
  const page = await open('fields.html');
  await ready(page);
  return page;
}

function crossOriginFrame(page) {
  return page.frames().find((frame) => frame.url().startsWith(`http://localhost:${port}/frame.html`));
}

function srcdocFrame(page) {
  return page.frames().find((frame) => frame.url() === 'about:srcdoc');
}

async function appliedVersion(target) {
  return target.evaluate(() => document.documentElement.dataset.snippetsE2e);
}

/** Runs `change` and waits until every target's content script has applied it. */
async function applied(targets, change) {
  const before = await Promise.all(targets.map(appliedVersion));
  await change();
  await Promise.all(
    targets.map((target, i) => target.waitForFunction((version) => document.documentElement.dataset.snippetsE2e !== version, before[i])),
  );
}

async function storageGet(key) {
  return worker.evaluate(async (key) => (await chrome.storage.local.get(key))[key], key);
}

async function storageSet(items) {
  await worker.evaluate(async (items) => chrome.storage.local.set(items), items);
}

async function setSettings(patch) {
  const settings = (await storageGet('settings')) ?? {};
  await storageSet({ settings: { triggerMode: 'immediate', disabledSites: [], ...settings, ...patch } });
}

async function addSnippets(list) {
  const snippets = (await storageGet('snippets')) ?? [];
  const now = Date.now();
  const added = list.map((entry, i) => ({ id: `test-${now}-${i}`, label: '', createdAt: now, updatedAt: now, ...entry }));
  await storageSet({ snippets: [...snippets, ...added] });
}

async function removeSnippets(abbreviations) {
  const snippets = (await storageGet('snippets')) ?? [];
  await storageSet({ snippets: snippets.filter((snippet) => !abbreviations.includes(snippet.abbreviation)) });
}

async function tabOf(page) {
  await page.bringToFront();
  return worker.evaluate(async (url) => {
    const matches = (await chrome.tabs.query({})).filter((tab) => tab.url === url);
    if (matches.length) return matches.sort((a, b) => b.id - a.id)[0];
    // chrome:// URLs aren't visible even with host access: use the focused tab.
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

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function typeIn(target, selector, text) {
  const field = target.locator(selector);
  await field.click();
  // Headless Chromium sometimes doesn't move focus into a cross-origin frame on a click
  // right after switching tabs; focus it directly then.
  if (!(await field.evaluate((element) => element.matches(':focus')))) await field.focus();
  await field.page().keyboard.type(text);
}

const valueOf = (target, selector) => target.locator(selector).inputValue();
const textOf = async (target, selector) => (await target.locator(selector).innerText()).replace(/ /g, ' ');
const caretOf = (target, selector) => target.locator(selector).evaluate((element) => [element.selectionStart, element.selectionEnd]);

async function shot(page, name, { curated = false, fullPage = false } = {}) {
  const path = join(outputDir, `${name}.png`);
  await page.screenshot({ path, fullPage });
  if (curated) await copyFile(path, join(screenshotsDir, `${name}.png`));
}

async function readClipboard(page) {
  await page.bringToFront();
  return page.evaluate(() => navigator.clipboard.readText());
}

async function openPopupFor(page, { width = 380, height = 600 } = {}) {
  const tab = await tabOf(page);
  const popup = await newPage();
  await popup.setViewportSize({ width, height });
  await popup.goto(extensionUrl(`popup.html?tab=${tab.id}`));
  await popup.bringToFront();
  return popup;
}

async function openOptions() {
  const page = await newPage();
  await page.goto(extensionUrl('options.html'));
  await page.bringToFront();
  await page.locator('#list[aria-busy="false"]').waitFor({ state: 'attached' });
  return page;
}

const THANKS = 'Thank you so much for your help!';
const SIGNATURE = 'Best regards,\n[Your name]';
const MEET = 'Hi ,\n\nWould you have 30 minutes this week for a quick call?\n\nThanks!';

// --- Tests ------------------------------------------------------------------------------

const results = [];
async function test(name, fn) {
  // ONLY=text runs just the tests whose name contains it (for debugging).
  if (process.env.ONLY && !name.includes(process.env.ONLY)) return;
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
    // A failed test must not leave a disabled site or another mode behind for the next one.
    await storageSet({ settings: { triggerMode: 'immediate', disabledSites: [] } }).catch(() => undefined);
  }
}

// On a busy machine the worker can be reachable a moment before its chrome.* bindings are.
await waitFor(
  () => worker.evaluate(() => typeof chrome !== 'undefined' && typeof chrome.storage?.local?.get === 'function').catch(() => false),
  'extension service worker ready',
  15000,
);

console.log(`Chromium ${context.browser()?.version() ?? ''} · extension ${extensionId}\n`);

await test('first install adds the starter snippets', async () => {
  await waitFor(async () => (await storageGet('snippets'))?.length === 6, 'starter snippets');
  const snippets = await storageGet('snippets');
  assert.deepEqual(snippets.map((snippet) => snippet.abbreviation).sort(), [';addr', ';date', ';meet', ';shrug', ';sig', ';ty']);
  assert.equal(await storageGet('settings'), undefined, 'defaults are not written until changed');
});

await test('production manifest: only storage + activeTab, content script on all sites and frames', async () => {
  const manifest = JSON.parse(await readFile(join(root, 'dist/manifest.json'), 'utf8'));
  assert.deepEqual([...manifest.permissions].sort(), ['activeTab', 'storage']);
  assert.equal(manifest.host_permissions, undefined);
  assert.equal(manifest.optional_permissions, undefined);
  assert.equal(manifest.commands, undefined);
  assert.deepEqual(manifest.content_scripts, [
    { matches: ['<all_urls>'], js: ['content.js'], all_frames: true, match_about_blank: true, run_at: 'document_idle' },
  ]);
  const files = await readdir(join(root, 'dist'));
  assert.ok(!files.some((file) => file.endsWith('.map')), 'no source maps');
  const content = await readFile(join(root, 'dist/content.js'), 'utf8');
  assert.ok(!content.includes('snippetsE2e') && !content.includes('snippets-e2e-no-exec'), 'e2e hooks compiled out');
  const popup = await readFile(join(root, 'dist/popup.js'), 'utf8');
  assert.ok(!popup.includes('URLSearchParams'), 'popup tab override compiled out');
  for (const file of [content, popup, await readFile(join(root, 'dist/options.js'), 'utf8')]) {
    assert.ok(!/\bfetch\(|XMLHttpRequest|WebSocket|sendBeacon/.test(file), 'no network code');
    assert.ok(!/\.innerHTML\s*=|insertAdjacentHTML|outerHTML\s*=/.test(file), 'no HTML injection');
  }
});

await test('as you type: text, search, url and tel inputs expand; caret ends after the text', async () => {
  const page = await openFields();
  await typeIn(page, '#plain', 'Hello ;ty');
  assert.equal(await valueOf(page, '#plain'), `Hello ${THANKS}`);
  assert.deepEqual(await caretOf(page, '#plain'), [THANKS.length + 6, THANKS.length + 6]);
  await page.keyboard.type(' Bye');
  assert.equal(await valueOf(page, '#plain'), `Hello ${THANKS} Bye`);
  for (const id of ['#search', '#url', '#tel']) {
    await typeIn(page, id, ';shrug');
    assert.equal(await valueOf(page, id), '¯\\_(ツ)_/¯', id);
  }
  // Symbol-prefixed abbreviations expand even right after a word.
  await page.locator('#plain').fill('');
  await typeIn(page, '#plain', 'word;ty');
  assert.equal(await valueOf(page, '#plain'), `word${THANKS}`);
});

await test('textarea: multi-line snippet, native undo (Ctrl+Z) restores the abbreviation', async () => {
  const page = await openFields();
  await typeIn(page, '#area', 'Cheers\n;sig');
  assert.equal(await valueOf(page, '#area'), `Cheers\n${SIGNATURE}`);
  await page.keyboard.press('Control+z');
  assert.equal(await valueOf(page, '#area'), 'Cheers\n;sig');
  await page.keyboard.press('Control+Shift+z');
  assert.equal(await valueOf(page, '#area'), `Cheers\n${SIGNATURE}`);
});

await test('Backspace right after an expansion reverts to the abbreviation', async () => {
  const page = await openFields();
  await typeIn(page, '#plain', 'x ;ty');
  assert.equal(await valueOf(page, '#plain'), `x ${THANKS}`);
  await page.keyboard.press('Backspace');
  assert.equal(await valueOf(page, '#plain'), 'x ;ty');
  await page.keyboard.press('Backspace');
  assert.equal(await valueOf(page, '#plain'), 'x ;t', 'second Backspace is a normal one');

  await typeIn(page, '#area', ';sig');
  await page.keyboard.press('Backspace');
  assert.equal(await valueOf(page, '#area'), ';sig');

  await typeIn(page, '#editor', 'Hi ;sig');
  assert.equal(await textOf(page, '#editor'), `Hi ${SIGNATURE}`);
  await page.keyboard.press('Backspace');
  assert.equal(await textOf(page, '#editor'), 'Hi ;sig');

  // Only immediately: after moving the caret, Backspace is just Backspace.
  await page.locator('#search').click();
  await page.keyboard.type(';ty');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Backspace');
  assert.equal(await valueOf(page, '#search'), THANKS.slice(0, -2) + THANKS.slice(-1));
});

await test('{cursor}: caret lands at the marker in textarea, input and contenteditable', async () => {
  const page = await openFields();
  await typeIn(page, '#area', ';meet');
  assert.equal(await valueOf(page, '#area'), MEET);
  assert.deepEqual(await caretOf(page, '#area'), [3, 3]);
  await page.keyboard.type('Bob');
  assert.equal(await valueOf(page, '#area'), MEET.replace('Hi ,', 'Hi Bob,'));

  // Inputs can't hold line breaks: they become spaces.
  await typeIn(page, '#plain', 'Re: ;meet');
  assert.equal(await valueOf(page, '#plain'), 'Re: Hi , Would you have 30 minutes this week for a quick call? Thanks!');
  assert.deepEqual(await caretOf(page, '#plain'), [7, 7]);

  await typeIn(page, '#editor', ';meet');
  await page.keyboard.type('Ann');
  const text = await textOf(page, '#editor');
  assert.ok(text.startsWith('Hi Ann,\n'), JSON.stringify(text));
  assert.ok(text.includes('Would you have 30 minutes this week for a quick call?') && text.trimEnd().endsWith('Thanks!'), JSON.stringify(text));
});

await test('contenteditable: expands in the current text node, native undo works', async () => {
  const page = await openFields();
  await typeIn(page, '#editor', 'Hello ;ty and ;shrug');
  assert.equal(await textOf(page, '#editor'), `Hello ${THANKS} and ¯\\_(ツ)_/¯`);
  await page.keyboard.press('Control+z');
  assert.equal(await textOf(page, '#editor'), `Hello ${THANKS} and ;shrug`);
});

await test('variables: {date:FORMAT}, {weekday}, {time} and {datetime} use the current date', async () => {
  await addSnippets([
    { abbreviation: ';wd', text: 'Today is {weekday}.' },
    { abbreviation: ';tm', text: '{time:HH:mm}|{date:D MMMM YYYY}|{unknown}' },
    { abbreviation: ';dt', text: '{datetime}' },
  ]);
  const page = await openFields();
  await typeIn(page, '#plain', ';date');
  const iso = await page.evaluate(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  });
  assert.equal(await valueOf(page, '#plain'), iso);

  await typeIn(page, '#search', ';wd');
  const weekday = await page.evaluate(() => new Date().toLocaleDateString(navigator.language, { weekday: 'long' }));
  assert.equal(await valueOf(page, '#search'), `Today is ${weekday}.`);

  await typeIn(page, '#area', ';tm');
  const [time, date, unknown] = (await valueOf(page, '#area')).split('|');
  assert.match(time, /^\d{2}:\d{2}$/);
  const now = await page.evaluate(() => [new Date().getHours(), new Date().getMinutes()]);
  const [hours, minutes] = time.split(':').map(Number);
  assert.ok(Math.abs(hours * 60 + minutes - (now[0] * 60 + now[1])) <= 1, `${time} vs ${now}`);
  assert.match(date, /^\d{1,2} \S+ \d{4}$/);
  assert.equal(unknown, '{unknown}');

  await typeIn(page, '#url', ';dt');
  assert.match(await valueOf(page, '#url'), /\d{4}.*\d{1,2}:\d{2}/);
  await removeSnippets([';wd', ';tm', ';dt']);
});

await test('React-like controlled inputs receive the expanded value in their state', async () => {
  await addSnippets([{ abbreviation: ';em', text: 'alex@example.com' }]);
  const page = await openFields();
  await typeIn(page, '#react', 'Hi ;ty');
  assert.equal(await valueOf(page, '#react'), `Hi ${THANKS}`);
  assert.equal(await page.locator('#react-state').textContent(), `Hi ${THANKS}`);
  // Typing continues normally after the expansion and the state keeps up.
  await page.keyboard.type('!');
  assert.equal(await page.locator('#react-state').textContent(), `Hi ${THANKS}!`);

  // Email inputs expose no caret API: the native value setter path.
  await typeIn(page, '#react-email', ';em');
  assert.equal(await valueOf(page, '#react-email'), 'alex@example.com');
  assert.equal(await page.locator('#react-email-state').textContent(), 'alex@example.com');
  await page.keyboard.press('Backspace');
  assert.equal(await valueOf(page, '#react-email'), ';em', 'Backspace undo works in email inputs too');
  assert.equal(await page.locator('#react-email-state').textContent(), ';em');
  await removeSnippets([';em']);
});

await test('fallbacks when execCommand is unavailable: setRangeText + input event, direct DOM edit', async () => {
  const page = await openFields();
  await page.evaluate(() => document.documentElement.setAttribute('data-snippets-e2e-no-exec', ''));
  await typeIn(page, '#react', 'Hi ;ty');
  assert.equal(await valueOf(page, '#react'), `Hi ${THANKS}`);
  assert.equal(await page.locator('#react-state').textContent(), `Hi ${THANKS}`, 'React-like state updated by the dispatched input event');
  await page.keyboard.press('Backspace');
  assert.equal(await page.locator('#react-state').textContent(), 'Hi ;ty', 'Backspace undo through the fallback too');

  await typeIn(page, '#area', ';meet');
  assert.equal(await valueOf(page, '#area'), MEET);
  assert.deepEqual(await caretOf(page, '#area'), [3, 3]);

  await typeIn(page, '#editor', 'Hi ;sig');
  assert.equal(await textOf(page, '#editor'), `Hi ${SIGNATURE}`);
  await page.keyboard.type('!');
  assert.equal(await textOf(page, '#editor'), `Hi ${SIGNATURE}!`, 'caret after the inserted text');
});

await test('open shadow roots: input and contenteditable inside web components', async () => {
  const page = await openFields();
  await typeIn(page, '#shadow input', 'Shadow ;ty');
  assert.equal(await valueOf(page, '#shadow input'), `Shadow ${THANKS}`);
  await typeIn(page, '#shadow-editor div', 'Rich ;sig');
  assert.equal(await textOf(page, '#shadow-editor div'), `Rich ${SIGNATURE}`);
  await page.keyboard.press('Backspace');
  assert.equal(await textOf(page, '#shadow-editor div'), 'Rich ;sig');
});

await test('never expands in password, one-time-code, credit-card or revealed-password fields', async () => {
  const page = await openFields();
  for (const id of ['#password', '#otp', '#cc', '#revealed']) {
    await typeIn(page, id, ';ty');
    assert.equal(await valueOf(page, id), ';ty', id);
  }
});

await test('IME composition is left alone', async () => {
  const page = await openFields();
  await page.locator('#plain').click();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Input.imeSetComposition', { text: ';ty', selectionStart: 3, selectionEnd: 3 });
  await pause(100);
  assert.equal(await valueOf(page, '#plain'), ';ty', 'no expansion while composing');
  await cdp.send('Input.insertText', { text: ';ty' });
  await pause(100);
  assert.equal(await valueOf(page, '#plain'), ';ty', 'committed IME text is not treated as typing');
  await cdp.detach();
});

await test('iframes: cross-origin textarea and srcdoc editable body', async () => {
  const page = await openFields();
  const frame = crossOriginFrame(page);
  assert.ok(frame, 'cross-origin frame loaded');
  await ready(frame);
  await typeIn(frame, '#frame-area', 'Framed ;sig');
  assert.equal(await valueOf(frame, '#frame-area'), `Framed ${SIGNATURE}`);

  const rich = srcdocFrame(page);
  assert.ok(rich, 'srcdoc frame loaded');
  await ready(rich);
  await typeIn(rich, 'body', 'Inline ;ty');
  assert.equal(await textOf(rich, 'body'), `Inline ${THANKS}`);
});

await test('a length limit that cuts the snippet short shows a notice instead of failing silently', async () => {
  const page = await openFields();
  await typeIn(page, '#limited', ';ty');
  assert.equal(await valueOf(page, '#limited'), THANKS.slice(0, 12));
  await page.locator('snippets-notice').waitFor({ state: 'attached' });
  await page.locator('#limited').scrollIntoViewIfNeeded();
  await shot(page, 'page-notice');
});

await test('delimiter mode: Space keeps the space, Tab and Enter are consumed, applies live', async () => {
  const page = await openFields();
  await applied([page], () => setSettings({ triggerMode: 'delimiter' }));

  await typeIn(page, '#plain', ';ty');
  await pause(50);
  assert.equal(await valueOf(page, '#plain'), ';ty', 'waits for a delimiter');
  await page.keyboard.press('Space');
  assert.equal(await valueOf(page, '#plain'), `${THANKS} `);
  await page.keyboard.press('Backspace');
  assert.equal(await valueOf(page, '#plain'), ';ty ', 'Backspace restores what was typed, space included');

  await typeIn(page, '#search', ';shrug');
  await page.keyboard.press('Tab');
  assert.equal(await valueOf(page, '#search'), '¯\\_(ツ)_/¯');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'search', 'Tab did not move focus');

  await typeIn(page, '#form-input', ';ty');
  await page.keyboard.press('Enter');
  assert.equal(await valueOf(page, '#form-input'), THANKS);
  assert.equal(await page.locator('#submitted').textContent(), '', 'Enter did not submit the form');
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('#submitted').textContent(), `submitted: ${THANKS}`, 'a plain Enter still submits');

  await typeIn(page, '#editor', 'Hi ;sig');
  await page.keyboard.press('Space');
  assert.equal(await textOf(page, '#editor'), `Hi ${SIGNATURE} `);
  await page.keyboard.press('Backspace');
  assert.equal(await textOf(page, '#editor'), 'Hi ;sig ', 'Backspace undo in contenteditable keeps the typed space');

  // A normal space after a normal word is untouched.
  await typeIn(page, '#area', 'just words ');
  assert.equal(await valueOf(page, '#area'), 'just words ');
  await applied([page], () => setSettings({ triggerMode: 'immediate' }));
  await typeIn(page, '#url', ';ty');
  assert.equal(await valueOf(page, '#url'), THANKS, 'back to as-you-type without reloading');
});

await test('popup: "Expanding on this site" switch disables the site, frames included, live', async () => {
  const page = await openFields();
  const frame = crossOriginFrame(page);
  await ready(frame);
  const popup = await openPopupFor(page);
  await popup.locator('#site-status', { hasText: 'Expanding on this site' }).waitFor();
  assert.equal(await popup.locator('#site-host').innerText(), '127.0.0.1');
  assert.equal(await popup.locator('#site-toggle').isChecked(), true);
  await popup.locator('.snippet-button').first().waitFor();
  await shot(popup, 'popup-light', { curated: true });

  await applied([page, frame], () => popup.locator('#site-toggle').click());
  await popup.locator('#site-status', { hasText: 'Paused on this site' }).waitFor();
  assert.deepEqual((await storageGet('settings')).disabledSites, ['127.0.0.1']);
  await shot(popup, 'popup-paused', { curated: true });

  await page.bringToFront();
  await typeIn(page, '#plain', ';ty');
  assert.equal(await valueOf(page, '#plain'), ';ty', 'disabled on the page');
  await typeIn(frame, '#frame-area', ';ty');
  assert.equal(await valueOf(frame, '#frame-area'), ';ty', 'disabled in the cross-origin frame of a disabled page');

  await popup.bringToFront();
  await applied([page], () => popup.locator('#site-toggle').click());
  await popup.locator('#site-status', { hasText: 'Expanding on this site' }).waitFor();
  assert.deepEqual((await storageGet('settings')).disabledSites, []);
  await page.bringToFront();
  await typeIn(page, '#search', ';ty');
  assert.equal(await valueOf(page, '#search'), THANKS, 'enabled again without reloading');
});

await test('popup: search, click to copy the expanded text, keyboard, dark mode', async () => {
  const page = await openFields();
  const popup = await openPopupFor(page);
  await popup.locator('.snippet-button').first().waitFor();
  assert.equal(await popup.locator('.snippet-button').count(), 6);
  assert.equal(await popup.locator('#count').innerText(), '6');
  assert.equal(await popup.locator('#mode').innerText(), 'Expands as you type');
  assert.equal(await popup.evaluate(() => document.activeElement?.id), 'search', 'search is focused on open');
  assert.equal(await popup.evaluate(() => document.documentElement.scrollWidth <= 380), true, 'no horizontal scroll');

  await popup.locator('#search').fill('meet');
  assert.equal(await popup.locator('.snippet-button').count(), 1);
  assert.equal(await popup.locator('#count').innerText(), '1 of 6');
  await popup.locator('.snippet-button').click();
  await popup.locator('.snippet-button.copied').waitFor();
  assert.equal(await popup.locator('#copy-status').textContent(), 'Copied ;meet');
  await shot(popup, 'popup-copied');
  assert.equal(await readClipboard(page), MEET, 'variables filled, {cursor} removed');

  await popup.bringToFront();
  await popup.locator('#search').fill('date');
  await popup.locator('#search').press('Enter');
  await popup.locator('.snippet-button.copied').waitFor();
  assert.match(await readClipboard(page), /^\d{4}-\d{2}-\d{2}$/);

  await popup.bringToFront();
  await popup.locator('#search').fill('');
  await popup.locator('#search').press('ArrowDown');
  await popup.keyboard.press('ArrowDown');
  const focused = await popup.evaluate(() => document.activeElement?.querySelector('.abbr')?.textContent);
  assert.equal(focused, ';date', 'arrow keys move through the list');

  await popup.locator('#search').fill('zzz');
  await popup.locator('#empty', { hasText: 'No snippets match "zzz".' }).waitFor();
  await shot(popup, 'popup-no-results');

  await popup.locator('#search').fill('');
  await popup.emulateMedia({ colorScheme: 'dark' });
  await pause(400); // let Bootstrap's color transitions finish
  await shot(popup, 'popup-dark', { curated: true });
});

await test('popup: pages where Snippets cannot run, or has not loaded yet, say so', async () => {
  const blocked = await newPage();
  await blocked.goto('chrome://version');
  const popup = await openPopupFor(blocked);
  await popup.locator('#site-status', { hasText: "Chrome doesn't let extensions type on this page." }).waitFor();
  assert.equal(await popup.locator('#site-switch').isHidden(), true);
  await shot(popup, 'popup-restricted');

  const loading = await newPage();
  await loading.goto(`${base}/hang.html`, { waitUntil: 'commit' });
  const popup2 = await openPopupFor(loading);
  await popup2.locator('#site-status', { hasText: 'Reload this page to start expanding here' }).waitFor();
  assert.equal(await popup2.locator('#site-toggle').isChecked(), true);
  await shot(popup2, 'popup-reload');
});

await test('popup: empty library shows how to start', async () => {
  const saved = await storageGet('snippets');
  await storageSet({ snippets: [] });
  try {
    const page = await openFields();
    const popup = await openPopupFor(page);
    await popup.locator('#empty', { hasText: 'No snippets yet' }).waitFor();
    await shot(popup, 'popup-empty');
  } finally {
    await storageSet({ snippets: saved });
  }
});

await test('real toolbar popup finds the active tab and its site', async () => {
  // Opened first: focusing a new tab would close the popup.
  const probe = await newPage();
  await probe.goto(extensionUrl('options.html'));
  const page = await openFields();
  await page.bringToFront();
  await worker.evaluate(() => chrome.action.openPopup());
  await waitFor(
    () =>
      probe.evaluate(() => {
        const [popup] = chrome.extension.getViews({ type: 'popup' });
        const doc = popup?.document;
        return doc?.getElementById('site-host')?.textContent === '127.0.0.1' && doc.getElementById('site-status')?.textContent === 'Expanding on this site';
      }),
    'popup shows the tab host',
  );
});

await test('manager: create with validation, prefix warnings and preview; applies to open pages live', async () => {
  const fields = await openFields();
  const page = await openOptions();
  assert.equal(await page.locator('.snippet-row').count(), 6);
  assert.equal(await page.locator('#count').innerText(), '6');
  await shot(page, 'options-light', { curated: true });

  await page.locator('#new').click();
  await page.locator('#editor-abbreviation').fill('has space');
  await page.locator('#editor-text').fill('x');
  await page.locator('.editor button[type="submit"]').click();
  assert.equal(await page.locator('#editor-abbreviation-feedback').innerText(), "Abbreviations can't contain spaces or line breaks.");
  await page.locator('#editor-abbreviation').fill(';ty');
  assert.equal(await page.locator('#editor-abbreviation-feedback').innerText(), ';ty is already used by "Thanks".');
  await page.locator('#editor-abbreviation').fill(';s');
  const warning = await page.locator('.editor .alert-warning').innerText();
  assert.match(warning, /;shrug, ;sig will never expand as you type once this is saved: ;s expands first\./);
  await page.locator('#editor-abbreviation').fill('hello');
  assert.match(await page.locator('.editor .alert-warning').innerText(), /hello is an ordinary word/);

  await page.locator('#editor-abbreviation').fill(';hello');
  await page.locator('#editor-label').fill('Greeting');
  await page.locator('#editor-text').fill('Hello ');
  await page.locator('.variable-bar button', { hasText: '{cursor}' }).click();
  await page.keyboard.type('!\nHave a nice ');
  await page.locator('.variable-bar button', { hasText: '{weekday}' }).click();
  assert.equal(await valueOf(page, '#editor-text'), 'Hello {cursor}!\nHave a nice {weekday}');
  assert.equal(await page.locator('.editor .alert-warning').isHidden(), true);
  await page.locator('.editor .preview-caret').waitFor();
  assert.match(await page.locator('.editor .preview-body').innerText(), /^Hello !\nHave a nice \w+/);
  await shot(page, 'options-editor', { curated: true });
  await page.keyboard.press('Control+Enter');
  await page.locator('#toasts .toast', { hasText: 'Created ;hello' }).waitFor();
  assert.equal(await page.locator('.snippet-row').count(), 7);
  const created = (await storageGet('snippets')).find((snippet) => snippet.abbreviation === ';hello');
  assert.equal(created.label, 'Greeting');
  assert.equal(created.text, 'Hello {cursor}!\nHave a nice {weekday}');

  await fields.bringToFront();
  await typeIn(fields, '#area', ';hello');
  await fields.keyboard.type('Kim');
  assert.match(await valueOf(fields, '#area'), /^Hello Kim!\nHave a nice \w+$/);
});

await test('manager: edit, search, delete with undo, shadowed badge follows the trigger mode', async () => {
  const fields = await openFields();
  const page = await openOptions();
  const row = (abbreviation) => page.locator('.snippet-row', { has: page.locator('.abbr', { hasText: new RegExp(`^${abbreviation}$`) }) });

  await row(';hello').getByRole('button', { name: 'Edit ;hello' }).click();
  await page.locator('#editor-text').fill('Hello again');
  await page.locator('.editor button[type="submit"]').click();
  await page.locator('#toasts .toast', { hasText: 'Saved ;hello' }).waitFor();
  assert.equal((await storageGet('snippets')).find((snippet) => snippet.abbreviation === ';hello').text, 'Hello again');
  await fields.bringToFront();
  await typeIn(fields, '#plain', ';hello');
  assert.equal(await valueOf(fields, '#plain'), 'Hello again');

  await page.bringToFront();
  await page.locator('#search').fill('main street');
  assert.equal(await page.locator('.snippet-row').count(), 1);
  await page.locator('#search').fill('nothing like this');
  await page.locator('#empty', { hasText: 'No snippets match' }).waitFor();
  await page.locator('#empty button', { hasText: 'Clear search' }).click();
  assert.equal(await page.locator('.snippet-row').count(), 7);

  await row(';hello').getByRole('button', { name: 'Delete ;hello' }).click();
  await page.locator('#toasts .toast', { hasText: 'Deleted ;hello' }).waitFor();
  assert.ok(!(await storageGet('snippets')).some((snippet) => snippet.abbreviation === ';hello'));
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Edit ;meet', 'focus moves to the next row');
  // A change from elsewhere (another tab, the popup) re-renders the list; keyboard focus stays put.
  await addSnippets([{ abbreviation: ';other', text: 'from another tab' }]);
  await row(';other').waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Edit ;meet', 'focus survives re-renders');
  await removeSnippets([';other']);
  await row(';other').waitFor({ state: 'detached' });
  await shot(page, 'options-deleted');
  await page.locator('#toasts button', { hasText: 'Undo' }).click();
  await page.locator('#toasts .toast', { hasText: 'Restored ;hello' }).waitFor();
  assert.ok((await storageGet('snippets')).some((snippet) => snippet.abbreviation === ';hello'));
  await row(';hello').getByRole('button', { name: 'Delete ;hello' }).click();
  await waitFor(async () => !(await storageGet('snippets')).some((snippet) => snippet.abbreviation === ';hello'), 'deleted');

  await addSnippets([{ abbreviation: ';si', text: 'shadowing' }]);
  await row(';sig').locator('.warning-badge', { hasText: 'Never expands: ;si fires first' }).waitFor();
  await page.locator('#trigger-delimiter').check();
  await page.locator('#toasts .toast', { hasText: 'after Space, Tab or Enter' }).waitFor();
  assert.equal((await storageGet('settings')).triggerMode, 'delimiter');
  assert.equal(await page.locator('.warning-badge').count(), 0, 'no conflicts in delimiter mode');
  await page.locator('#trigger-immediate').check();
  await row(';sig').locator('.warning-badge').waitFor();
  await removeSnippets([';si']);
  await page.locator('.warning-badge').waitFor({ state: 'detached' });

  // Escape with unsaved changes asks for a second press.
  await page.locator('#new').click();
  await page.locator('#editor-abbreviation').fill(';draft');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.editor').count(), 1);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.editor').count(), 0);
});

await test('manager: disabled sites are validated, normalized and removable', async () => {
  const page = await openOptions();
  await page.locator('#site-input').fill('not a site');
  await page.locator('#site-form button').click();
  assert.equal(await page.locator('#site-error').innerText(), 'Enter a site like example.com.');
  await page.locator('#site-input').fill('https://Mail.Example.com/inbox');
  await page.locator('#site-form button').click();
  await page.locator('#sites li', { hasText: 'mail.example.com' }).waitFor();
  assert.deepEqual((await storageGet('settings')).disabledSites, ['mail.example.com']);
  await page.locator('#site-input').fill('mail.example.com');
  await page.locator('#site-form button').click();
  assert.equal(await page.locator('#site-error').innerText(), 'mail.example.com is already in the list.');
  await page.getByRole('button', { name: 'Enable on mail.example.com again' }).click();
  await page.locator('#sites li', { hasText: 'No sites disabled.' }).waitFor();
  assert.deepEqual((await storageGet('settings')).disabledSites, []);
});

await test('manager: export, then import with merge, replace and a broken file', async () => {
  const page = await openOptions();
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#export').click()]);
  assert.match(download.suggestedFilename(), /^snippets-\d{4}-\d{2}-\d{2}\.json$/);
  const exported = JSON.parse(await readFile(await download.path(), 'utf8'));
  assert.equal(exported.format, 'snippets-text-expander');
  const stored = await storageGet('snippets');
  assert.deepEqual(
    exported.snippets.map((snippet) => snippet.abbreviation).sort(),
    stored.map((snippet) => snippet.abbreviation).sort(),
  );
  assert.equal(exported.snippets.find((snippet) => snippet.abbreviation === ';sig').text, SIGNATURE);

  const file = (name, data) => ({ name, mimeType: 'application/json', buffer: Buffer.from(typeof data === 'string' ? data : JSON.stringify(data)) });
  await page.setInputFiles('#import-file', file('team-snippets.json', {
    snippets: [
      { abbreviation: ';ty', text: 'Thanks a lot!', label: 'Thanks' },
      { abbreviation: 'bad one', text: 'spaces are not allowed' },
      { abbreviation: ';team', text: 'The Team', label: 'Team' },
    ],
  }));
  await page.locator('#import-dialog[open]').waitFor();
  assert.equal(await page.locator('#import-summary').innerText(), 'Found 2 snippets in team-snippets.json.');
  assert.match(await page.locator('#import-skipped').innerText(), /1 entry will be skipped:\n#2 bad one: Abbreviations can't contain spaces/);
  assert.equal(await page.locator('#import-merge-help').innerText(), 'Adds 1 new snippet, updates 1 with the same abbreviation.');
  assert.equal(await page.locator('#import-replace-help').innerText(), 'Your 6 current snippets will be deleted first.');
  await shot(page, 'options-import', { curated: true });
  await page.locator('#import-confirm').click();
  await page.locator('#toasts .toast', { hasText: 'Imported: 1 added, 1 updated' }).waitFor();
  let snippets = await storageGet('snippets');
  assert.equal(snippets.length, 7);
  assert.equal(snippets.find((snippet) => snippet.abbreviation === ';ty').text, 'Thanks a lot!');

  await page.setInputFiles('#import-file', file('broken.json', '{ not json'));
  await page.locator('#import-error', { hasText: "This file isn't valid JSON." }).waitFor();
  assert.equal(await page.locator('#import-confirm').isHidden(), true);
  await shot(page, 'options-import-error');
  await page.locator('#import-cancel').click();
  await page.locator('#import-dialog[open]').waitFor({ state: 'detached' });

  // Replace with the original export: back to the starters.
  await page.setInputFiles('#import-file', file('export.json', exported));
  await page.locator('#import-dialog[open]').waitFor();
  await page.locator('#import-replace').check();
  await page.locator('#import-confirm').click();
  await page.locator('#toasts .toast', { hasText: 'Imported 6 snippets, replacing your previous ones' }).waitFor();
  snippets = await storageGet('snippets');
  assert.deepEqual(snippets.map((snippet) => snippet.abbreviation).sort(), [';addr', ';date', ';meet', ';shrug', ';sig', ';ty']);
  assert.equal(snippets.find((snippet) => snippet.abbreviation === ';ty').text, THANKS);
});

await test('manager: dark mode, empty state and load states', async () => {
  const page = await openOptions();
  await page.emulateMedia({ colorScheme: 'dark' });
  await pause(400); // let Bootstrap's color transitions finish
  await shot(page, 'options-dark', { curated: true });
  const saved = await storageGet('snippets');
  await storageSet({ snippets: [] });
  try {
    await page.locator('#empty', { hasText: 'No snippets yet' }).waitFor();
    await page.emulateMedia({ colorScheme: 'light' });
    await pause(400);
    await shot(page, 'options-empty');
    assert.equal(await page.locator('#export').isDisabled(), true);
  } finally {
    await storageSet({ snippets: saved });
  }
  await page.locator('.snippet-row').first().waitFor();
  await page.setViewportSize({ width: 420, height: 800 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= 420), true, 'manager fits a narrow window');
  await shot(page, 'options-narrow');
});

await test('manager and popup: loading skeletons and load errors are designed states', async () => {
  const loading = await newPage();
  await loading.route('**/ext/options.js', (route) => route.abort());
  await loading.goto(`${base}/ext/options.html`);
  await loading.locator('#list .placeholder').first().waitFor();
  await shot(loading, 'options-loading');

  // Outside the extension there's no chrome.storage: the page must say so, not stay blank.
  const failing = await newPage();
  await failing.goto(`${base}/ext/options.html`);
  await failing.locator('#list-alert', { hasText: "Couldn't load your snippets" }).waitFor();
  assert.equal(await failing.locator('#list').isHidden(), true);
  assert.equal(await failing.locator('#new').isDisabled(), true, 'actions that need storage are disabled');
  await shot(failing, 'options-load-error');

  const popupLoading = await newPage();
  await popupLoading.setViewportSize({ width: 380, height: 420 });
  await popupLoading.route('**/ext/popup.js', (route) => route.abort());
  await popupLoading.goto(`${base}/ext/popup.html`);
  await popupLoading.locator('#list .placeholder').first().waitFor();
  await shot(popupLoading, 'popup-loading');

  const popupFailing = await newPage();
  await popupFailing.setViewportSize({ width: 380, height: 420 });
  await popupFailing.goto(`${base}/ext/popup.html`);
  await popupFailing.locator('#error', { hasText: "Couldn't load your snippets" }).waitFor();
  await shot(popupFailing, 'popup-load-error');
});

await test('performance: 2,000 snippets, per-keystroke cost stays tiny', async () => {
  const saved = await storageGet('snippets');
  const big = Array.from({ length: 2000 }, (_, i) => ({ id: `big-${i}`, abbreviation: `;s${i}`, text: `Snippet ${i}`, label: '', createdAt: 1, updatedAt: 1 }));
  await storageSet({ snippets: big });
  try {
    const page = await openFields();
    await page.locator('#area').click();
    const prose = 'The quick brown fox jumps over the lazy dog; then it naps. '.repeat(6);
    await page.evaluate(() => { window.__timings = { input: [], keydown: [] }; });
    const started = Date.now();
    await page.keyboard.type(prose);
    const elapsed = Date.now() - started;
    await page.keyboard.type(';s1999');
    assert.ok((await valueOf(page, '#area')).endsWith('Snippet 1999'));
    const timings = await page.evaluate(() => window.__timings);
    const stats = (values) => {
      const sorted = [...values].sort((a, b) => a - b);
      return { n: values.length, mean: values.reduce((a, b) => a + b, 0) / values.length, p95: sorted[Math.floor(sorted.length * 0.95)] ?? 0 };
    };
    const input = stats(timings.input.slice(0, prose.length));
    const keydown = stats(timings.keydown.slice(0, prose.length));
    console.log(
      `      ${prose.length} keystrokes in ${elapsed} ms · handler time per keystroke: input mean ${input.mean.toFixed(3)} ms (p95 ${input.p95.toFixed(3)}), keydown mean ${keydown.mean.toFixed(3)} ms (p95 ${keydown.p95.toFixed(3)})`,
    );
    assert.ok(input.n >= prose.length - 5 && keydown.n >= prose.length - 5, 'timings recorded');
    assert.ok(input.mean < 0.5 && keydown.mean < 0.5, 'mean handler time under 0.5 ms');
  } finally {
    await storageSet({ snippets: saved });
  }
});

await test('demo: composing an email with snippets', async () => {
  const page = await open('demo.html');
  await ready(page);
  await page.setViewportSize({ width: 720, height: 470 });
  await typeIn(page, '#subject', 'Quick call this week?');
  await typeIn(page, '#body', ';meet');
  await page.keyboard.type('Sam');
  await page.keyboard.press('Control+End');
  await page.keyboard.type('\n\n;sig');
  assert.equal(await valueOf(page, '#body'), `${MEET.replace('Hi ,', 'Hi Sam,')}\n\n${SIGNATURE}`);
  await shot(page, 'demo-email', { curated: true });
});

await test('production build (no test hooks) expands on a page too', async () => {
  const productionDir = await mkdtemp(join(tmpdir(), 'snippets-prod-'));
  const productionPath = join(root, 'dist');
  const production = await chromium.launchPersistentContext(productionDir, {
    executablePath: findChromium(),
    headless,
    args: [`--disable-extensions-except=${productionPath}`, `--load-extension=${productionPath}`],
  });
  try {
    const productionWorker = production.serviceWorkers()[0] ?? (await production.waitForEvent('serviceworker'));
    await waitFor(
      () => productionWorker.evaluate(async () => ((await chrome.storage.local.get('snippets')).snippets ?? []).length === 6),
      'starters seeded in the production build',
    );
    const page = await production.newPage();
    await page.goto(`${base}/fields.html`);
    // No readiness marker in production: retry until the content script has loaded.
    await waitFor(async () => {
      await page.locator('#plain').fill('');
      await page.locator('#plain').click();
      await page.keyboard.type(';ty');
      return (await page.locator('#plain').inputValue()) === THANKS;
    }, 'expansion in the production build');
  } finally {
    await production.close();
    await rm(productionDir, { recursive: true, force: true });
  }
});

await test('no network requests leave the browser', async () => {
  assert.deepEqual(outsideRequests, []);
});

// --- Summary ----------------------------------------------------------------------------

await context.close();
for (const response of hanging) response.destroy();
server.close();
await rm(userDataDir, { recursive: true, force: true });

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed. Screenshots: ${outputDir} (curated: ${screenshotsDir})`);
process.exit(failed.length ? 1 : 0);
