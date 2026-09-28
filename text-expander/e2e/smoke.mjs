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

// The pages are opened under realistic host names without a port (the curated screenshots are
// also store graphics): Chromium resolves these reserved example hosts to the local server and
// treats them as secure origins. The test fields live on forms.example.com, the cross-origin
// frame on widgets.example.net and the email demo on mail.example.com.
const HOSTS = { forms: 'forms.example.com', widgets: 'widgets.example.net', mail: 'mail.example.com' };
const pageHosts = { 'demo.html': HOSTS.mail, 'frame.html': HOSTS.widgets };
const fixtureOrigins = Object.values(HOSTS).map((host) => `http://${host}`);
const base = `http://${HOSTS.forms}`;
const fixtureUrl = (name) => `http://${pageHosts[name] ?? HOSTS.forms}/${name}`;
const browserArgs = (extension) => [
  `--disable-extensions-except=${extension}`,
  `--load-extension=${extension}`,
  `--host-resolver-rules=${Object.values(HOSTS).map((host) => `MAP ${host}:80 127.0.0.1:${port}`).join(',')}`,
  '--no-proxy-server', // a proxy from the environment would otherwise get these requests
  `--unsafely-treat-insecure-origin-as-secure=${fixtureOrigins.join(',')}`,
];

// --- Browser ----------------------------------------------------------------------------

await mkdir(outputDir, { recursive: true });
await mkdir(screenshotsDir, { recursive: true });
const userDataDir = await mkdtemp(join(tmpdir(), 'snippets-e2e-'));
const context = await chromium.launchPersistentContext(userDataDir, {
  executablePath: findChromium(),
  headless,
  viewport: { width: 1280, height: 800 },
  locale: 'en-US',
  args: browserArgs(extensionPath),
});
// Not for mail.example.com: {clipboard} is tested there, so only the extension's own
// permission can make it work.
for (const origin of [`http://${HOSTS.forms}`, `http://${HOSTS.widgets}`]) await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
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
  const local = fixtureOrigins.some((origin) => url.startsWith(`${origin}/`));
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
  await page.goto(fixtureUrl(name));
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

/** The fixture's cross-origin frame, once it has loaded. */
async function crossOriginFrame(page) {
  const find = () => page.frames().find((frame) => frame.url() === fixtureUrl('frame.html'));
  await waitFor(() => find() !== undefined, 'cross-origin frame loaded');
  return find();
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

/** Map of abbreviation → id of the stored snippets. */
async function snippetIds() {
  // (With ONLY=…, this can run before the starter snippets are seeded.)
  await waitFor(async () => ((await storageGet('snippets')) ?? []).length > 0, 'snippets stored');
  return Object.fromEntries((await storageGet('snippets')).map((snippet) => [snippet.abbreviation, snippet.id]));
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

async function openPopupFor(page, { width = 400, height = 600 } = {}) {
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
    // A failed test must not leave a disabled site, another mode or the free plan behind.
    await storageSet({ settings: { triggerMode: 'immediate', disabledSites: [] } }).catch(() => undefined);
    await worker.evaluate(() => chrome.storage.local.remove(['e2eEarlyAccess', 'plan'])).catch(() => undefined);
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

await test('production manifest: only storage + activeTab (clipboardRead optional), content script on all sites and frames', async () => {
  const manifest = JSON.parse(await readFile(join(root, 'dist/manifest.json'), 'utf8'));
  assert.deepEqual([...manifest.permissions].sort(), ['activeTab', 'storage']);
  assert.equal(manifest.host_permissions, undefined);
  assert.deepEqual(manifest.optional_permissions, ['clipboardRead']);
  assert.equal(manifest.optional_host_permissions, undefined);
  assert.equal(manifest.commands, undefined);
  assert.deepEqual(manifest.content_scripts, [
    { matches: ['<all_urls>'], js: ['content.js'], all_frames: true, match_about_blank: true, run_at: 'document_idle' },
  ]);
  const files = await readdir(join(root, 'dist'));
  assert.ok(!files.some((file) => file.endsWith('.map')), 'no source maps');
  const content = await readFile(join(root, 'dist/content.js'), 'utf8');
  assert.ok(!content.includes('snippetsE2e') && !content.includes('snippets-e2e-no-exec'), 'e2e hooks compiled out');
  assert.ok(!content.includes('"open"') && content.includes('"closed"'), 'fill-in form and suggestions use closed shadow roots in production');
  assert.ok(!content.includes('dataset.query'), 'suggestion test hook compiled out');
  for (const name of ['background.js', 'content.js', 'popup.js', 'options.js']) {
    const code = await readFile(join(root, 'dist', name), 'utf8');
    assert.ok(!code.includes('e2eEarlyAccess') && !code.includes('dataset.fields'), `plan test hook compiled out of ${name}`);
    assert.ok(!code.includes('e2eClipboardDenied'), `clipboard test hook compiled out of ${name}`);
  }
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
  const frame = await crossOriginFrame(page);
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
  const frame = await crossOriginFrame(page);
  await ready(frame);
  const popup = await openPopupFor(page);
  await popup.locator('#site-status', { hasText: 'Expanding on this site' }).waitFor();
  assert.equal(await popup.locator('#site-host').innerText(), HOSTS.forms);
  assert.equal(await popup.locator('#site-toggle').isChecked(), true);
  await popup.locator('.snippet-button').first().waitFor();
  await shot(popup, 'popup-light-starters');

  await applied([page, frame], () => popup.locator('#site-toggle').click());
  await popup.locator('#site-status', { hasText: 'Paused on this site' }).waitFor();
  assert.deepEqual((await storageGet('settings')).disabledSites, [HOSTS.forms]);
  await shot(popup, 'popup-paused-starters');

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

await test('popup: search, click to copy the expanded text, most used first, keyboard, dark mode', async () => {
  const ids = await snippetIds();
  const now = Date.now();
  await storageSet({ usage: { [ids[';sig']]: { count: 9, lastUsed: now - 3 * 86400000 }, [ids[';ty']]: { count: 4, lastUsed: now - 3600000 } } });
  const page = await openFields();
  const popup = await openPopupFor(page);
  await popup.locator('.snippet-button').first().waitFor();
  assert.equal(await popup.locator('.snippet-button').count(), 6);
  assert.deepEqual(await popup.locator('.snippet-button .abbr').allInnerTexts(), [';sig', ';ty', ';addr', ';date', ';meet', ';shrug'], 'most used first, then A-Z');
  assert.equal(await popup.locator('.snippet-button', { hasText: ';sig' }).locator('.usage-meta').innerText(), 'used 9× · 3 days ago');
  assert.equal(await popup.locator('.snippet-button', { hasText: ';ty' }).locator('.usage-meta').innerText(), 'used 4× · 1 h ago');
  assert.equal(await popup.locator('.snippet-button', { hasText: ';addr' }).locator('.usage-meta').isHidden(), true, 'nothing shown for unused snippets');
  assert.equal(await popup.locator('#count').innerText(), '6');
  assert.equal(await popup.locator('#mode').innerText(), 'Expands as you type');
  assert.equal(await popup.evaluate(() => document.activeElement?.id), 'search', 'search is focused on open');
  assert.equal(await popup.evaluate(() => document.documentElement.scrollWidth <= 400), true, 'no horizontal scroll');

  await popup.locator('#search').fill('meet');
  assert.equal(await popup.locator('.snippet-button').count(), 1);
  assert.equal(await popup.locator('#count').innerText(), '1 of 6');
  await popup.locator('.snippet-button').click();
  await popup.locator('.snippet-button.copied').waitFor();
  assert.equal(await popup.locator('#copy-status').textContent(), 'Copied ;meet');
  // Copying counts as a use; the count updates in place.
  // (Attached, not visible: the count gives its spot to "Copied" while the row is hovered.)
  await popup.locator('.snippet-button', { hasText: ';meet' }).locator('.usage-meta', { hasText: 'used 1× · just now' }).waitFor({ state: 'attached' });
  await shot(popup, 'popup-copied');
  assert.equal(await readClipboard(page), MEET, 'variables filled, {cursor} removed');

  await popup.bringToFront();
  await popup.locator('#search').fill('date');
  await popup.locator('#search').press('Enter');
  await popup.locator('.snippet-button.copied').waitFor();
  await popup.locator('.snippet-button', { hasText: ';date' }).locator('.usage-meta', { hasText: 'used 1× · just now' }).waitFor({ state: 'attached' });
  assert.match(await readClipboard(page), /^\d{4}-\d{2}-\d{2}$/);

  await popup.bringToFront();
  await popup.locator('#search').fill('');
  // ;date was used last of the snippets used once.
  assert.deepEqual(await popup.locator('.snippet-button .abbr').allInnerTexts(), [';sig', ';ty', ';date', ';meet', ';addr', ';shrug']);
  await popup.locator('#search').press('ArrowDown');
  await popup.keyboard.press('ArrowDown');
  const focused = await popup.evaluate(() => document.activeElement?.querySelector('.abbr')?.textContent);
  assert.equal(focused, ';ty', 'arrow keys move through the list');

  await popup.locator('#search').fill('zzz');
  await popup.locator('#empty', { hasText: 'No snippets match "zzz".' }).waitFor();
  await shot(popup, 'popup-no-results');

  await popup.locator('#search').fill('');
  await popup.emulateMedia({ colorScheme: 'dark' });
  await pause(400); // let Bootstrap's color transitions finish
  await shot(popup, 'popup-dark-starters');
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
      probe.evaluate((host) => {
        const [popup] = chrome.extension.getViews({ type: 'popup' });
        const doc = popup?.document;
        return doc?.getElementById('site-host')?.textContent === host && doc.getElementById('site-status')?.textContent === 'Expanding on this site';
      }, HOSTS.forms),
    'popup shows the tab host',
  );
});

await test('manager: create with validation, prefix warnings and preview; applies to open pages live', async () => {
  const fields = await openFields();
  const page = await openOptions();
  assert.equal(await page.locator('.snippet-row').count(), 6);
  assert.equal(await page.locator('#count').innerText(), '6');
  await shot(page, 'options-light-starters');

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
  await page.locator('.editor .preview-body .caret-mark').waitFor();
  assert.match(await page.locator('.editor .preview-body').innerText(), /^Hello !\nHave a nice \w+/);
  assert.match(await page.locator('.editor .preview-body .var-chip').innerText(), /^\w+day$/, 'the weekday shows as a filled-in chip');
  await shot(page, 'options-editor-starters');
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
  await shot(page, 'options-dark-starters');
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
  await popupLoading.setViewportSize({ width: 400, height: 420 });
  await popupLoading.route('**/ext/popup.js', (route) => route.abort());
  await popupLoading.goto(`${base}/ext/popup.html`);
  await popupLoading.locator('#list .placeholder').first().waitFor();
  await shot(popupLoading, 'popup-loading');

  const popupFailing = await newPage();
  await popupFailing.setViewportSize({ width: 400, height: 420 });
  await popupFailing.goto(`${base}/ext/popup.html`);
  await popupFailing.locator('#error', { hasText: "Couldn't load your snippets" }).waitFor();
  await shot(popupFailing, 'popup-load-error');
});

// --- Pro: fill-in fields, tags, plan ------------------------------------------------------

const GREET = 'Hi {input:Name},\nThanks for contacting {input:Company=Acme}. {cursor}';
const fillForm = (page) => page.locator('snippets-fill');
const fillInputs = (page) => page.locator('snippets-fill input');

/** Waits for the fill-in form and returns the field names it asks for. */
async function waitForFill(target) {
  await fillForm(target).waitFor({ state: 'attached' });
  await target.waitForFunction(() => ['input', 'select'].includes(document.querySelector('snippets-fill')?.shadowRoot?.activeElement?.localName));
  return (await fillForm(target).getAttribute('data-fields')).split('|');
}

async function withSnippets(list, fn) {
  const saved = await storageGet('snippets');
  await addSnippets(list);
  try {
    await fn();
  } finally {
    await storageSet({ snippets: saved });
  }
}

await test('fill-in fields: a form next to the caret, Tab between fields, Enter inserts (textarea, input, contenteditable)', async () => {
  await withSnippets([{ abbreviation: ';greet', text: GREET, label: 'Greeting' }], async () => {
    const page = await openFields();
    // The page must never see what is typed into the form.
    await page.evaluate(() => {
      window.__pageKeys = 0;
      document.addEventListener('keydown', () => window.__pageKeys++);
    });
    await typeIn(page, '#area', 'Note: ;greet');
    assert.deepEqual(await waitForFill(page), ['Name', 'Company']);
    assert.equal(await valueOf(page, '#area'), 'Note: ;greet', 'the abbreviation stays until the form is confirmed');
    assert.equal(await fillInputs(page).nth(1).inputValue(), 'Acme', 'default value is prefilled');
    const [form, area] = await Promise.all([fillForm(page).boundingBox(), page.locator('#area').boundingBox()]);
    assert.ok(form.y >= area.y && form.y < area.y + 60 && form.x >= area.x + 40 && form.x < area.x + 160, `form next to the caret: ${JSON.stringify({ form, area })}`);

    const keysBefore = await page.evaluate(() => window.__pageKeys);
    await page.keyboard.type('Ann');
    await page.keyboard.press('Tab');
    await page.keyboard.type('Globex');
    assert.equal(await page.evaluate(() => window.__pageKeys), keysBefore, 'keys typed in the form stay in the form');
    await shot(page, 'fill-in-textarea');
    await page.keyboard.press('Enter');
    await fillForm(page).waitFor({ state: 'detached' });
    assert.equal(await valueOf(page, '#area'), 'Note: Hi Ann,\nThanks for contacting Globex. ');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'area', 'focus is back in the field');
    await page.keyboard.type('Bye');
    assert.equal(await valueOf(page, '#area'), 'Note: Hi Ann,\nThanks for contacting Globex. Bye', 'caret at {cursor}');

    // Tab wraps inside the form instead of leaving it.
    await typeIn(page, '#plain', ';greet');
    await waitForFill(page);
    await page.keyboard.type('Bo');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.querySelector('snippets-fill').shadowRoot.activeElement?.dataset.field), 'Name', 'Tab wraps');
    await page.keyboard.press('Enter');
    await fillForm(page).waitFor({ state: 'detached' });
    assert.equal(await valueOf(page, '#plain'), 'Hi Bo, Thanks for contacting Acme. ', 'single-line input, default kept');

    await typeIn(page, '#editor', 'X ;greet');
    await waitForFill(page);
    await page.keyboard.type('Kim');
    await page.keyboard.press('Enter');
    await fillForm(page).waitFor({ state: 'detached' });
    const text = await textOf(page, '#editor');
    assert.ok(text.startsWith('X Hi Kim,\nThanks for contacting Acme.'), JSON.stringify(text));
    await page.keyboard.press('Backspace');
    assert.equal(await textOf(page, '#editor'), 'X ;greet', 'Backspace right after still reverts to the abbreviation');

    // React-like controlled input and an open shadow root.
    await typeIn(page, '#react', ';greet');
    await waitForFill(page);
    await page.keyboard.type('Lee');
    await page.keyboard.press('Enter');
    await fillForm(page).waitFor({ state: 'detached' });
    assert.equal(await page.locator('#react-state').textContent(), 'Hi Lee, Thanks for contacting Acme. ');
    await typeIn(page, '#shadow input', ';greet');
    await waitForFill(page);
    await page.keyboard.press('Enter');
    await fillForm(page).waitFor({ state: 'detached' });
    assert.equal(await valueOf(page, '#shadow input'), 'Hi , Thanks for contacting Acme. ');
  });
});

await test('fill-in fields: Esc and clicking elsewhere cancel and keep the abbreviation; the form never expands; delimiter mode', async () => {
  await withSnippets([{ abbreviation: ';greet', text: GREET }], async () => {
    const page = await openFields();
    await typeIn(page, '#area', ';greet');
    await waitForFill(page);
    await page.keyboard.type('Ann');
    await page.keyboard.press('Escape');
    await fillForm(page).waitFor({ state: 'detached' });
    assert.equal(await valueOf(page, '#area'), ';greet');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'area');
    await page.keyboard.type('!');
    assert.equal(await valueOf(page, '#area'), ';greet!', 'caret back where it was');

    // An abbreviation typed into the form is just text.
    await typeIn(page, '#search', ';greet');
    await waitForFill(page);
    await page.keyboard.type(';ty');
    assert.equal(await fillInputs(page).first().inputValue(), ';ty');
    await page.keyboard.press('Enter');
    await fillForm(page).waitFor({ state: 'detached' });
    assert.equal(await valueOf(page, '#search'), 'Hi ;ty, Thanks for contacting Acme. ');

    // Clicking somewhere else in the page closes the form and leaves the text alone.
    await typeIn(page, '#url', ';greet');
    await waitForFill(page);
    await page.locator('h1').click();
    await fillForm(page).waitFor({ state: 'detached' });
    assert.equal(await valueOf(page, '#url'), ';greet');

    // Delimiter mode: the Space that opened the form comes back on cancel and after the text.
    await applied([page], () => setSettings({ triggerMode: 'delimiter' }));
    await typeIn(page, '#tel', ';greet');
    await page.keyboard.press('Space');
    await waitForFill(page);
    await page.keyboard.press('Escape');
    await fillForm(page).waitFor({ state: 'detached' });
    assert.equal(await valueOf(page, '#tel'), ';greet ');
    await page.locator('#tel').fill('');
    await typeIn(page, '#tel', ';greet');
    await page.keyboard.press('Space');
    await waitForFill(page);
    await page.keyboard.type('Max');
    await page.keyboard.press('Enter');
    await fillForm(page).waitFor({ state: 'detached' });
    assert.equal(await valueOf(page, '#tel'), 'Hi Max, Thanks for contacting Acme.  ');
    // Enter as the delimiter doesn't submit the page's form.
    await typeIn(page, '#form-input', ';greet');
    await page.keyboard.press('Enter');
    await waitForFill(page);
    await page.keyboard.press('Enter');
    await fillForm(page).waitFor({ state: 'detached' });
    assert.equal(await valueOf(page, '#form-input'), 'Hi , Thanks for contacting Acme. ');
    assert.equal(await page.locator('#submitted').textContent(), '', 'Enter did not submit the page form');
  });
});

await test('fill-in fields in iframes: cross-origin textarea and srcdoc editor', async () => {
  await withSnippets([{ abbreviation: ';greet', text: GREET }], async () => {
    const page = await openFields();
    const frame = await crossOriginFrame(page);
    await ready(frame);
    await typeIn(frame, '#frame-area', ';greet');
    await waitForFill(frame);
    await page.keyboard.type('Zoe');
    await page.keyboard.press('Enter');
    await fillForm(frame).waitFor({ state: 'detached' });
    assert.equal(await valueOf(frame, '#frame-area'), 'Hi Zoe,\nThanks for contacting Acme. ');

    const rich = srcdocFrame(page);
    await ready(rich);
    await typeIn(rich, 'body', ';greet');
    await waitForFill(rich);
    await page.keyboard.type('Rae');
    await page.keyboard.press('Enter');
    await fillForm(rich).waitFor({ state: 'detached' });
    assert.ok((await textOf(rich, 'body')).startsWith('Hi Rae,\nThanks for contacting Acme.'));
    assert.equal(await rich.evaluate(() => document.body.querySelector('snippets-fill')), null, 'the form never lands inside the editor');
  });
});

await test('demo: fill-in form while composing an email', async () => {
  await withSnippets([{ abbreviation: ';intro', label: 'Intro call', text: 'Hi {input:Name},\n\nThanks for your interest in {input:Product=Snippets}. Would {input:Day=Tuesday} work for a quick call?\n\n{cursor}' }], async () => {
    const page = await open('demo.html');
    await ready(page);
    await page.setViewportSize({ width: 720, height: 470 });
    await typeIn(page, '#subject', 'Quick call?');
    await typeIn(page, '#body', ';intro');
    await waitForFill(page);
    await page.keyboard.type('Sam');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await page.keyboard.type('Thursday');
    await pause(150);
    await shot(page, 'demo-fill-in-starters');
    await page.keyboard.press('Enter');
    await fillForm(page).waitFor({ state: 'detached' });
    assert.equal(await valueOf(page, '#body'), 'Hi Sam,\n\nThanks for your interest in Snippets. Would Thursday work for a quick call?\n\n');
    await page.emulateMedia({ colorScheme: 'dark' });
    await typeIn(page, '#subject', ' ;intro');
    await waitForFill(page);
    await pause(150);
    await shot(page, 'fill-in-dark');
    await page.keyboard.press('Escape');
  });
});

await test('tags: assign in the editor, filter in the manager and the popup', async () => {
  const saved = await storageGet('snippets');
  try {
    const page = await openOptions();
    const row = (abbreviation) => page.locator('.snippet-row', { has: page.locator('.abbr', { hasText: new RegExp(`^${abbreviation}$`) }) });
    assert.equal(await page.locator('#tag-filter').isHidden(), true, 'no filter without tags');
    assert.equal(await page.locator('#plan-status').innerText(), 'Early access');
    assert.equal(await page.locator('#pro-price').innerText(), '$3.99');
    assert.equal(await page.locator('#pro-note').innerText(), 'Free during early access');
    assert.equal(await page.locator('#get-pro').isDisabled(), true);
    assert.equal(await page.locator('#pro-features li').count(), 3);

    await row(';sig').getByRole('button', { name: 'Edit ;sig' }).click();
    assert.equal(await page.locator('#editor-tags').isDisabled(), false);
    await page.locator('#editor-tags').fill('Work, email');
    await page.keyboard.press('Control+Enter');
    await page.locator('#toasts .toast', { hasText: 'Saved ;sig' }).waitFor();
    await row(';ty').getByRole('button', { name: 'Edit ;ty' }).click();
    // Existing tags are offered with one click.
    await page.locator('.tag-suggestions button', { hasText: '+ Work' }).click();
    await page.locator('.tag-suggestions button', { hasText: '+ email' }).click();
    assert.equal(await valueOf(page, '#editor-tags'), 'Work, email');
    await page.locator('#editor-tags').fill('work, replies');
    await page.keyboard.press('Control+Enter');
    await page.locator('#toasts .toast', { hasText: 'Saved ;ty' }).waitFor();
    await row(';meet').getByRole('button', { name: 'Edit ;meet' }).click();
    await page.locator('#editor-tags').fill('email');
    await page.keyboard.press('Control+Enter');
    await page.locator('#toasts .toast', { hasText: 'Saved ;meet' }).waitFor();

    const stored = await storageGet('snippets');
    assert.deepEqual(stored.find((snippet) => snippet.abbreviation === ';ty').tags, ['work', 'replies']);
    assert.equal(stored.find((snippet) => snippet.abbreviation === ';addr').tags, undefined);

    await page.locator('#tag-filter').waitFor();
    assert.equal(await page.locator('#tag-filter .filter-chip', { hasText: 'Work' }).innerText(), 'Work\n2');
    await page.locator('#tag-filter .filter-chip', { hasText: 'Work' }).click();
    assert.equal(await page.locator('.snippet-row').count(), 2);
    assert.equal(await page.locator('#tag-filter .filter-chip.active').getAttribute('aria-pressed'), 'true');
    await page.locator('#search').fill('thank');
    assert.equal(await page.locator('.snippet-row').count(), 1, 'search within the tag');
    await page.locator('#search').fill('');
    await row(';meet').waitFor({ state: 'detached' });
    await row(';sig').locator('button.tag', { hasText: 'email' }).click();
    assert.equal(await page.locator('.snippet-row').count(), 2, 'clicking a tag on a row filters by it');
    await row(';meet').waitFor();
    await page.locator('#tag-filter .filter-chip', { hasText: 'All' }).click();
    assert.equal(await page.locator('.snippet-row').count(), 6);
    await page.evaluate(() => {
      for (const toast of document.querySelectorAll('#toasts .toast')) toast.remove();
      window.scrollTo(0, 0);
    });
    await page.locator('.snippet-row').first().hover();
    await shot(page, 'options-tags', { curated: true });

    // Export carries tags.
    const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#export').click()]);
    const exported = JSON.parse(await readFile(await download.path(), 'utf8'));
    assert.deepEqual(exported.snippets.find((snippet) => snippet.abbreviation === ';sig').tags, ['Work', 'email']);

    const fields = await openFields();
    const popup = await openPopupFor(fields);
    await popup.locator('.snippet-button').first().waitFor();
    assert.equal(await popup.locator('#tag-select').isVisible(), true);
    assert.deepEqual(await popup.locator('#tag-select option').allInnerTexts(), ['All tags', 'email (2)', 'replies (1)', 'Work (2)']);
    await popup.locator('#tag-select').selectOption('email');
    assert.equal(await popup.locator('.snippet-button').count(), 2);
    assert.equal(await popup.locator('#count').innerText(), '2 of 6');
    await popup.locator('#search').fill('sig');
    assert.equal(await popup.locator('.snippet-button').count(), 1);
    await popup.locator('#search').fill('');
    assert.equal(await popup.evaluate(() => document.documentElement.scrollWidth <= 400), true, 'no horizontal scroll');
    await shot(popup, 'popup-tags', { curated: true });
    await popup.locator('#tag-select').selectOption('');
    assert.equal(await popup.locator('.snippet-button').count(), 6);
  } finally {
    await storageSet({ snippets: saved });
  }
});

await test('popup: fill-in fields are asked inside the popup before copying', async () => {
  await withSnippets([{ abbreviation: ';greet', text: GREET, label: 'Greeting' }], async () => {
    const page = await openFields();
    const popup = await openPopupFor(page);
    await popup.locator('.snippet-button').first().waitFor();
    const greetPreview = popup.locator('.snippet-button', { hasText: ';greet' }).locator('.snippet-preview');
    assert.match(await greetPreview.innerText(), /^Hi Name, ⏎ Thanks for contacting Company\. $/);
    assert.deepEqual(await greetPreview.locator('.var-chip.is-field').allInnerTexts(), ['Name', 'Company'], 'fill-in fields show as chips');
    assert.equal(await greetPreview.locator('.caret-mark').count(), 1, '{cursor} shows as a caret');
    await popup.locator('#search').fill('greet');
    await popup.locator('#search').press('Enter');
    await popup.locator('.fill-inline').waitFor();
    assert.equal(await popup.evaluate(() => document.activeElement?.dataset.field), 'Name', 'first field focused');
    await popup.keyboard.type('Ann');
    await popup.keyboard.press('Tab');
    assert.equal(await popup.evaluate(() => document.activeElement?.dataset.field), 'Company');
    await popup.keyboard.type('Initech');
    await shot(popup, 'popup-fill-in', { curated: true });
    await popup.keyboard.press('Enter');
    await popup.locator('.snippet-button.copied').waitFor();
    assert.equal(await popup.locator('.fill-inline').count(), 0);
    assert.equal(await readClipboard(page), 'Hi Ann,\nThanks for contacting Initech. ');

    // Esc closes the form without copying and gives focus back to the snippet.
    await popup.bringToFront();
    await page.evaluate(() => navigator.clipboard.writeText('unchanged'));
    await popup.bringToFront();
    await popup.locator('.snippet-button', { hasText: ';greet' }).click();
    await popup.locator('.fill-inline').waitFor();
    await popup.keyboard.press('Escape');
    assert.equal(await popup.locator('.fill-inline').count(), 0);
    assert.equal(await popup.evaluate(() => document.activeElement?.querySelector('.abbr')?.textContent), ';greet');
    assert.equal(await readClipboard(page), 'unchanged');
    // A plain snippet still copies with one click.
    await popup.bringToFront();
    await popup.locator('#search').fill(';ty');
    await popup.locator('.snippet-button').first().click();
    await popup.locator('.snippet-button.copied').waitFor();
    assert.equal(await readClipboard(page), THANKS);
  });
});

await test('free plan (early access off): 20-snippet limit, Pro features off, nothing deleted', async () => {
  const saved = await storageGet('snippets');
  try {
    const extra = Array.from({ length: 15 }, (_, i) => ({ abbreviation: `;x${String(i).padStart(2, '0')}`, text: `Extra ${i}` }));
    await addSnippets([...extra, { abbreviation: ';greet', text: GREET, tags: ['work'] }]);
    await storageSet({ e2eEarlyAccess: false });
    const fields = await openFields();
    const page = await openOptions();
    // 22 snippets on a 20-snippet plan (a downgrade): all kept, adding is blocked.
    assert.equal(await page.locator('.snippet-row').count(), 22);
    assert.equal(await page.locator('#count').innerText(), '22 / 20');
    await page.locator('#limit-alert').waitFor();
    assert.match(await page.locator('#limit-alert').innerText(), /Free keeps 20 snippets\. Pro removes the limit\./);
    assert.equal(await page.locator('#plan-status').innerText(), 'Free plan');
    assert.equal(await page.locator('#pro-note').innerText(), 'One-time payment, no subscription.');
    assert.equal(await page.locator('#tag-filter').isHidden(), true, 'no tag filter on Free');
    assert.equal(await page.locator('.snippet-row .tag', { hasText: 'work' }).count(), 1, 'existing tags are still shown');
    await page.locator('#new').click();
    assert.equal(await page.locator('.editor').count(), 0, 'no editor for a 23rd snippet');
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'About Pro', 'focus goes to the About Pro link');
    await shot(page, 'options-free-limit', { curated: true });
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.activeElement?.id === 'about-pro');

    // Editing works; tags are read-only and kept; the fill-in chip is off.
    const row = page.locator('.snippet-row', { has: page.locator('.abbr', { hasText: /^;greet$/ }) });
    await row.getByRole('button', { name: 'Edit ;greet' }).click();
    assert.equal(await page.locator('#editor-tags').isDisabled(), true);
    assert.equal(await page.locator('.field-chip').count(), 2);
    for (const chip of await page.locator('.field-chip').all()) assert.equal(await chip.isDisabled(), true);
    assert.match(await page.locator('.editor .alert-warning').innerText(), /Fill-in fields are part of Pro/);
    await page.locator('#editor-text').fill('Hi {input:Name}!');
    await page.keyboard.press('Control+Enter');
    await page.locator('#toasts .toast', { hasText: 'Saved ;greet' }).waitFor();
    const stored = (await storageGet('snippets')).find((snippet) => snippet.abbreviation === ';greet');
    assert.deepEqual(stored.tags, ['work'], 'tags kept');

    // Import can update but not add past the limit.
    const file = (name, data) => ({ name, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(data)) });
    await page.setInputFiles('#import-file', file('more.json', [{ abbreviation: ';brand-new', text: 'x' }]));
    await page.locator('#import-dialog[open]').waitFor();
    assert.match(await page.locator('#import-merge-help').innerText(), /Free keeps 20 snippets\. Pro removes the limit\. This would make 23\./);
    assert.equal(await page.locator('#import-confirm').isDisabled(), true);
    await page.locator('#import-replace').check();
    assert.equal(await page.locator('#import-confirm').isDisabled(), false, 'replacing with 1 snippet fits');
    await page.locator('#import-cancel').click();

    // Content script: no form on Free, the field is inserted exactly as written.
    await fields.bringToFront();
    await typeIn(fields, '#plain', ';greet');
    assert.equal(await valueOf(fields, '#plain'), 'Hi {input:Name}!');
    assert.equal(await fillForm(fields).count(), 0);

    // Popup: no tag filter, copying doesn't ask.
    const popup = await openPopupFor(fields);
    await popup.locator('.snippet-button').first().waitFor();
    assert.equal(await popup.locator('#tag-select').isHidden(), true);
    await popup.locator('#search').fill('greet');
    await popup.locator('#search').press('Enter');
    await popup.locator('.snippet-button.copied').waitFor();
    assert.equal(await readClipboard(fields), 'Hi {input:Name}!');

    // Deleting one still leaves 21: over the limit, still blocked, nothing else removed.
    await page.bringToFront();
    await page.locator('.snippet-row', { has: page.locator('.abbr', { hasText: /^;x00$/ }) }).getByRole('button', { name: 'Delete ;x00' }).click();
    await page.locator('#toasts .toast', { hasText: 'Deleted ;x00' }).waitFor();
    assert.equal(await page.locator('#count').innerText(), '21 / 20');
    assert.equal((await storageGet('snippets')).length, 21);

    // Early access back on (live): the limit is gone.
    await storageSet({ e2eEarlyAccess: true });
    await page.locator('#count', { hasText: /^21$/ }).waitFor();
    assert.equal(await page.locator('#limit-alert').isHidden(), true);
    await page.locator('#new').click();
    await page.locator('.editor').waitFor();
  } finally {
    await storageSet({ snippets: saved });
  }
});

await test('About Pro card and PRO badges in both themes', async () => {
  const page = await openOptions();
  await page.locator('#about-pro').scrollIntoViewIfNeeded();
  assert.equal(await page.locator('#pro-features .pro-badge').count(), 3, 'a PRO badge on each Pro feature');
  await page.locator('#new').click();
  // Next to the Pro parts of the editor: tags, the two fill-in chips and their help.
  assert.ok((await page.locator('.editor .pro-badge').count()) >= 4, 'PRO badges next to Pro features');
  assert.equal(await page.locator('.editor label[for="editor-tags"] .pro-badge').count(), 1);
  assert.equal(await page.locator('.editor .field-chip .pro-badge').count(), 2);
  const inputChip = page.locator('.field-chip', { hasText: '{input:Name}' });
  const choiceChip = page.locator('.field-chip', { hasText: '{choice:' });
  await inputChip.waitFor();
  assert.equal(await inputChip.isDisabled(), false, 'fill-in chip enabled during early access');
  assert.equal(await choiceChip.isDisabled(), false, 'choice chip enabled during early access');
  await inputChip.click();
  await page.keyboard.type('Client');
  assert.equal(await valueOf(page, '#editor-text'), '{input:Client}', 'the chip selects "Name" to rename it');
  await page.locator('.editor .preview-body .var-chip.is-field', { hasText: 'Client' }).waitFor();
  await page.keyboard.press('End');
  await page.keyboard.type(' on ');
  await choiceChip.click();
  await page.keyboard.type('Day');
  assert.equal(await valueOf(page, '#editor-text'), '{input:Client} on {choice:Day=Option A|Option B}', 'the choice chip selects "Name" too');
  await page.locator('.editor .preview-body .var-chip.is-field', { hasText: 'Day ▾' }).waitFor();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await page.locator('#about-pro').scrollIntoViewIfNeeded();
  await pause(300); // the focus flash and smooth scroll settle
  await page.locator('#about-pro').screenshot({ path: join(outputDir, 'options-about-pro.png') });
  await copyFile(join(outputDir, 'options-about-pro.png'), join(screenshotsDir, 'options-about-pro.png'));
  await page.emulateMedia({ colorScheme: 'dark' });
  await pause(400);
  await page.locator('#about-pro').screenshot({ path: join(outputDir, 'options-about-pro-dark.png') });
});

// --- Suggestions under the caret (Free) ----------------------------------------------------

const suggestList = (target) => target.locator('snippets-suggest .suggest');
const suggestAbbrs = (target) => target.locator('snippets-suggest .suggest-abbr').allInnerTexts();

/** Waits until the list shows the suggestions for `query` and returns their abbreviations. */
async function waitSuggest(target, query) {
  await target.locator(`snippets-suggest[data-query="${query}"]`).waitFor({ state: 'attached' });
  return suggestAbbrs(target);
}

async function noSuggestions(target) {
  assert.equal(await target.locator('snippets-suggest').count(), 0, 'no suggestion list');
}

async function setUsage(entries) {
  const ids = await snippetIds();
  const now = Date.now();
  await storageSet({ usage: Object.fromEntries(entries.map(([abbreviation, count, ago = 0]) => [ids[abbreviation], { count, lastUsed: now - ago }])) });
}

async function usageOf(abbreviation) {
  const ids = await snippetIds();
  return (await storageGet('usage'))?.[ids[abbreviation]]?.count ?? 0;
}

await test('suggestions: a trigger lists snippets under the caret, typing filters, arrows move, Enter and Tab insert', async () => {
  await setUsage([[';sig', 5]]);
  const page = await openFields();
  await page.evaluate(() => {
    window.__pageKeys = [];
    document.addEventListener('keydown', (event) => window.__pageKeys.push(event.key));
  });
  await typeIn(page, '#area', 'Hi ;');
  assert.deepEqual(await waitSuggest(page, ';'), [';sig', ';addr', ';date', ';meet', ';shrug', ';ty'], 'every ; snippet, most used first');
  const [box, area] = await Promise.all([suggestList(page).boundingBox(), page.locator('#area').boundingBox()]);
  assert.ok(box.y > area.y + 10 && box.y < area.y + 45 && box.x > area.x + 12 && box.x < area.x + 60, `list under the caret: ${JSON.stringify({ box, area })}`);

  // Accessible: a listbox whose active option is announced.
  const listbox = page.locator('snippets-suggest [role="listbox"]');
  const options = page.locator('snippets-suggest [role="option"]');
  const activeId = () => listbox.getAttribute('aria-activedescendant');
  assert.equal(await activeId(), await options.nth(0).getAttribute('id'));
  assert.equal(await options.nth(0).getAttribute('aria-selected'), 'true');
  assert.match(await page.locator('snippets-suggest [role="status"]').textContent(), /^;sig, Email signature\. 1 of 6 snippets/);
  await page.keyboard.press('ArrowDown');
  assert.equal(await activeId(), await options.nth(1).getAttribute('id'));
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  assert.equal(await activeId(), await options.nth(5).getAttribute('id'), 'wraps around');
  assert.equal(await options.nth(0).getAttribute('aria-selected'), 'false');
  await shot(page, 'suggest-fields');

  await page.keyboard.type('me');
  // ;meet by its abbreviation, then "Address (edit me)" by a word of its label.
  assert.deepEqual(await waitSuggest(page, ';me'), [';meet', ';addr']);
  await page.keyboard.press('Enter');
  await page.locator('snippets-suggest').waitFor({ state: 'detached' });
  assert.equal(await valueOf(page, '#area'), `Hi ${MEET}`);
  assert.deepEqual(await caretOf(page, '#area'), [6, 6], 'caret at {cursor}, like an expansion');
  const keys = await page.evaluate(() => window.__pageKeys);
  assert.ok(!keys.includes('ArrowDown') && !keys.includes('ArrowUp') && !keys.includes('Enter'), `the page never saw the list keys: ${keys}`);
  await waitFor(async () => (await usageOf(';meet')) === 1, 'an inserted suggestion counts as a use');
  // Backspace right after takes it back, like after an expansion.
  await page.keyboard.press('Backspace');
  assert.equal(await valueOf(page, '#area'), 'Hi ;me');

  // Tab inserts too, and doesn't move focus.
  await typeIn(page, '#plain', ';s');
  assert.deepEqual(await waitSuggest(page, ';s'), [';sig', ';shrug']);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Tab');
  assert.equal(await valueOf(page, '#plain'), '¯\\_(ツ)_/¯');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'plain');

  // The label matches too: ";thank" finds "Thanks".
  await typeIn(page, '#search', ';thank');
  assert.deepEqual(await waitSuggest(page, ';thank'), [';ty']);
  await page.keyboard.press('Enter');
  assert.equal(await valueOf(page, '#search'), THANKS);

  // A click inserts without taking focus from the field.
  await typeIn(page, '#url', ';a');
  assert.deepEqual(await waitSuggest(page, ';a'), [';addr']);
  await page.locator('snippets-suggest [role="option"]').first().click();
  assert.equal(await valueOf(page, '#url'), '123 Main Street Springfield, 12345');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'url');

  // In the middle of a word a lone ; lists nothing, an abbreviation start does.
  await typeIn(page, '#tel', 'word;');
  await noSuggestions(page);
  await page.keyboard.type('s');
  assert.deepEqual(await waitSuggest(page, ';s'), [';sig', ';shrug']);
  await page.keyboard.press('Space');
  await noSuggestions(page);
  assert.equal(await valueOf(page, '#tel'), 'word;s ', 'Space just types a space');

  // An exact abbreviation still expands the moment it's complete.
  await page.locator('#plain').fill('');
  await typeIn(page, '#plain', ';ty');
  assert.equal(await valueOf(page, '#plain'), THANKS);
  await noSuggestions(page);
});

await test('suggestions: Esc closes for the rest of the word; Enter and Tab are never taken without a list', async () => {
  const page = await openFields();
  await page.evaluate(() => {
    window.__pageKeys = [];
    document.addEventListener('keydown', (event) => window.__pageKeys.push(event.key));
  });
  await typeIn(page, '#form-input', ';');
  await waitSuggest(page, ';');
  await page.keyboard.press('Escape');
  await noSuggestions(page);
  assert.ok(!(await page.evaluate(() => window.__pageKeys)).includes('Escape'), 'Esc closed the list, not something in the page');
  await page.keyboard.type('s');
  await noSuggestions(page);
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('#submitted').textContent(), 'submitted: ;s', 'Enter reached the page and submitted the form');

  await page.locator('#form-input').fill('');
  await typeIn(page, '#form-input', 'hello');
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('#submitted').textContent(), 'submitted: hello');
  // Tab without a list moves focus as usual.
  await typeIn(page, '#plain', 'no list here');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'search');

  // Arrow keys that move the caret, a click elsewhere or leaving the field close the list.
  await typeIn(page, '#area', ';s');
  await waitSuggest(page, ';s');
  await page.keyboard.press('ArrowLeft');
  await noSuggestions(page);
  await page.keyboard.press('End');
  await page.keyboard.type('i');
  await waitSuggest(page, ';si');
  await page.locator('h1').click();
  await noSuggestions(page);
});

await test('suggestions: contenteditable, open shadow roots and iframes; never in password fields, paused sites or when switched off', async () => {
  await setUsage([[';sig', 5]]);
  const page = await openFields();
  await typeIn(page, '#editor', 'X ;me');
  assert.deepEqual(await waitSuggest(page, ';me'), [';meet', ';addr']);
  await page.keyboard.press('Enter');
  await page.keyboard.type('Ann');
  assert.ok((await textOf(page, '#editor')).startsWith('X Hi Ann,\n'), JSON.stringify(await textOf(page, '#editor')));

  await typeIn(page, '#shadow input', ';sh');
  assert.deepEqual(await waitSuggest(page, ';sh'), [';shrug']);
  await page.keyboard.press('Enter');
  assert.equal(await valueOf(page, '#shadow input'), '¯\\_(ツ)_/¯');

  const frame = await crossOriginFrame(page);
  await ready(frame);
  await typeIn(frame, '#frame-area', 'Framed ;s');
  assert.deepEqual(await waitSuggest(frame, ';s'), [';sig', ';shrug']);
  await page.keyboard.press('Enter');
  assert.equal(await valueOf(frame, '#frame-area'), `Framed ${SIGNATURE}`);

  const rich = srcdocFrame(page);
  await ready(rich);
  await typeIn(rich, 'body', ';t');
  assert.deepEqual(await waitSuggest(rich, ';t'), [';ty']);
  await page.keyboard.press('Tab');
  assert.equal(await textOf(rich, 'body'), THANKS);
  assert.equal(await rich.evaluate(() => document.body.querySelector('snippets-suggest')), null, 'the list never lands inside the editor');

  for (const id of ['#password', '#otp', '#revealed']) {
    await typeIn(page, id, ';');
    await noSuggestions(page);
  }

  await applied([page], () => setSettings({ disabledSites: [HOSTS.forms] }));
  await typeIn(page, '#search', ';');
  await noSuggestions(page);
  await applied([page], () => setSettings({ disabledSites: [] }));
  await page.locator('#search').fill('');

  await applied([page], () => setSettings({ autocomplete: false }));
  await typeIn(page, '#search', ';');
  await noSuggestions(page);
  await page.keyboard.type('ty');
  assert.equal(await valueOf(page, '#search'), THANKS, 'expansion works without suggestions');
  await applied([page], () => setSettings({ autocomplete: true }));
  await typeIn(page, '#url', ';');
  await waitSuggest(page, ';');
});

const BOOK = 'Booked the {choice:Room=Blue room|Red room|Garden} for {input:Team=Sales}.';

await test('suggestions: fill-in snippets open the form (with a dropdown), delimiter mode, flips above near the bottom', async () => {
  await withSnippets([{ abbreviation: ';book', label: 'Room booking', text: BOOK }], async () => {
    const page = await openFields();
    await typeIn(page, '#area', ';bo');
    assert.deepEqual(await waitSuggest(page, ';bo'), [';book']);
    assert.deepEqual(await page.locator('snippets-suggest .var-chip.is-field').allInnerTexts(), ['Room ▾', 'Team'], 'the preview shows the fields as chips');
    await page.keyboard.press('Enter');
    assert.deepEqual(await waitForFill(page), ['Room', 'Team']);
    assert.equal(await page.evaluate(() => document.querySelector('snippets-fill').shadowRoot.activeElement?.localName), 'select');
    assert.deepEqual(await page.locator('snippets-fill select option').allInnerTexts(), ['Blue room', 'Red room', 'Garden']);
    assert.equal(await page.locator('snippets-fill select').inputValue(), 'Blue room', 'the first option is preselected');
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.locator('snippets-fill select').inputValue(), 'Red room');
    await page.keyboard.press('Tab');
    await page.keyboard.type('Ops');
    await shot(page, 'fill-in-choice');
    await page.keyboard.press('Enter');
    await fillForm(page).waitFor({ state: 'detached' });
    assert.equal(await valueOf(page, '#area'), 'Booked the Red room for Ops.');

    await applied([page], () => setSettings({ triggerMode: 'delimiter' }));
    await typeIn(page, '#plain', ';m');
    assert.deepEqual(await waitSuggest(page, ';m'), [';meet']);
    await page.keyboard.press('Enter');
    assert.equal(await valueOf(page, '#plain'), 'Hi , Would you have 30 minutes this week for a quick call? Thanks!');
    await typeIn(page, '#search', ';ty');
    assert.deepEqual(await waitSuggest(page, ';ty'), [';ty'], 'the exact abbreviation is listed');
    await page.keyboard.press('Space');
    assert.equal(await valueOf(page, '#search'), `${THANKS} `, 'Space still expands in delimiter mode');
    await noSuggestions(page);
    await applied([page], () => setSettings({ triggerMode: 'immediate' }));

    // Near the bottom of the window the list opens above the caret.
    await page.setViewportSize({ width: 1280, height: 400 });
    await page.locator('#area').evaluate((element) => element.scrollIntoView({ block: 'end' }));
    await page.locator('#area').fill('');
    await typeIn(page, '#area', ';');
    await waitSuggest(page, ';');
    const [box, area] = await Promise.all([suggestList(page).boundingBox(), page.locator('#area').boundingBox()]);
    assert.equal(await page.locator('snippets-suggest .suggest.is-above').count(), 1);
    assert.ok(box.y + box.height <= area.y + 6, `list above the caret: ${JSON.stringify({ box, area })}`);
    await page.keyboard.press('Escape');
  });
});

// --- {clipboard} (Free, optional permission) ------------------------------------------------

await test('{clipboard}: expands to the clipboard text, read only at that moment, in fields, editors and frames', async () => {
  await withSnippets([{ abbreviation: ';link', label: 'Share a link', text: 'Here is the link: {clipboard}' }], async () => {
    const writer = await openFields();
    await writer.evaluate(() => navigator.clipboard.writeText('https://example.com/pricing\r\nsee page 2'));
    const page = await open('demo.html');
    await ready(page);
    // This page has no clipboard permission of its own: only the extension's optional one reads it.
    assert.notEqual(await page.evaluate(async () => (await navigator.permissions.query({ name: 'clipboard-read' })).state), 'granted');
    await page.evaluate(() => {
      window.__pastes = 0;
      document.addEventListener('paste', () => window.__pastes++, true);
    });
    await typeIn(page, '#body', 'Hi Sam, ;link');
    assert.equal(await valueOf(page, '#body'), 'Hi Sam, Here is the link: https://example.com/pricing\nsee page 2');
    assert.equal(await page.evaluate(() => window.__pastes), 0, 'the page never saw a paste');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'body', 'focus stayed in the field');
    await page.keyboard.press('Backspace');
    assert.equal(await valueOf(page, '#body'), 'Hi Sam, ;link', 'Backspace undo works as usual');
    await typeIn(page, '#subject', ';link');
    assert.equal(await valueOf(page, '#subject'), 'Here is the link: https://example.com/pricing see page 2', 'single-line input');

    await writer.bringToFront();
    await writer.evaluate(() => navigator.clipboard.writeText('second copy'));
    await typeIn(writer, '#editor', ';link');
    assert.equal(await textOf(writer, '#editor'), 'Here is the link: second copy', 'read again at each expansion');
    const frame = await crossOriginFrame(writer);
    await ready(frame);
    await typeIn(frame, '#frame-area', ';link');
    assert.equal(await valueOf(frame, '#frame-area'), 'Here is the link: second copy', 'works in a cross-origin frame');
    // Picked from the suggestions too.
    await typeIn(writer, '#plain', ';li');
    await waitSuggest(writer, ';li');
    assert.deepEqual(await writer.locator('snippets-suggest .var-chip.is-field').allInnerTexts(), ['clipboard']);
    await writer.keyboard.press('Enter');
    assert.equal(await valueOf(writer, '#plain'), 'Here is the link: second copy');
  });
});

await test('{clipboard}: the manager asks for clipboard access on save and explains a refusal; the popup copies with it', async () => {
  const saved = await storageGet('snippets');
  try {
    const page = await openOptions();
    // The test build has the optional permission up front (see scripts/build.mjs).
    await page.locator('#clipboard-access', { hasText: 'Clipboard access: allowed' }).waitFor();
    await page.locator('#new').click();
    await page.locator('#editor-abbreviation').fill(';link');
    await page.locator('#editor-label').fill('Share a link');
    await page.locator('#editor-text').fill('Here is the link: ');
    await page.locator('.variable-bar button', { hasText: '{clipboard}' }).click();
    assert.equal(await valueOf(page, '#editor-text'), 'Here is the link: {clipboard}');
    await page.locator('.editor .preview-body .var-chip.is-field', { hasText: 'clipboard' }).waitFor();
    assert.equal(await page.locator('.editor .clipboard-warning').count(), 0, 'no warning with access granted');
    await page.keyboard.press('Control+Enter');
    await page.locator('#toasts .toast', { hasText: 'Created ;link' }).waitFor();
    assert.equal(await page.locator('#toasts .toast-danger').count(), 0);
    await page.locator('#clipboard-access', { hasText: 'Clipboard access: allowed' }).waitFor();

    // Refused (the test build's stand-in for clicking "Deny" in Chrome's prompt).
    await storageSet({ e2eClipboardDenied: true });
    await page.locator('#clipboard-access', { hasText: 'off. 1 snippet uses {clipboard}, which inserts nothing without it.' }).waitFor();
    const row = page.locator('.snippet-row', { has: page.locator('.abbr', { hasText: /^;link$/ }) });
    await row.getByRole('button', { name: 'Edit ;link' }).click();
    const warning = page.locator('.editor .clipboard-warning');
    await warning.waitFor();
    assert.match(await warning.innerText(), /Clipboard access is off, so \{clipboard\} inserts nothing\./);
    await warning.evaluate((element) => element.scrollIntoView({ block: 'center' }));
    await shot(page, 'options-clipboard-warning');
    await page.keyboard.press('Control+Enter');
    await page.locator('#toasts .toast-danger', { hasText: "Clipboard access wasn't allowed, so {clipboard} in ;link inserts nothing." }).waitFor();

    // Allowed again, then given back from the Privacy card.
    await storageSet({ e2eClipboardDenied: false });
    await page.locator('#clipboard-access', { hasText: 'Clipboard access: allowed' }).waitFor();
    await page.locator('#clipboard-access button', { hasText: 'Remove access' }).click();
    await page.locator('#clipboard-access', { hasText: 'Clipboard access: off.' }).waitFor();
    assert.equal(await storageGet('e2eClipboardDenied'), true);
    await storageSet({ e2eClipboardDenied: false });

    // The popup fills {clipboard} when copying.
    const fields = await openFields();
    await fields.evaluate(() => navigator.clipboard.writeText('https://example.com/docs'));
    const popup = await openPopupFor(fields);
    await popup.locator('#search').fill(';link');
    await popup.locator('.snippet-button').first().click();
    await popup.locator('.snippet-button.copied').waitFor();
    assert.equal(await readClipboard(fields), 'Here is the link: https://example.com/docs');
  } finally {
    await storageSet({ snippets: saved });
    await worker.evaluate(() => chrome.storage.local.remove('e2eClipboardDenied'));
  }
});

// --- Usage stats, sorting, editor help, popup "+" ----------------------------------------------

await test('usage stats: expansions, suggestions and copies count; the manager shows them and sorts by most used, A–Z or recent', async () => {
  await storageSet({ usage: {} });
  const fields = await openFields();
  await typeIn(fields, '#plain', ';ty ;ty');
  await waitFor(async () => (await usageOf(';ty')) === 2, 'two expansions counted');
  await typeIn(fields, '#area', ';si');
  await waitSuggest(fields, ';si');
  await fields.keyboard.press('Enter');
  await waitFor(async () => (await usageOf(';sig')) === 1, 'a suggestion counted');
  const usage = await storageGet('usage');
  const ids = await snippetIds();
  assert.ok(usage[ids[';sig']].lastUsed >= usage[ids[';ty']].lastUsed, 'last use recorded');

  const page = await openOptions();
  const row = (abbreviation) => page.locator('.snippet-row', { has: page.locator('.abbr', { hasText: new RegExp(`^${abbreviation}$`) }) });
  assert.equal(await row(';ty').locator('.usage-meta').innerText(), 'used 2× · just now');
  assert.equal(await row(';sig').locator('.usage-meta').innerText(), 'used 1× · just now');
  assert.equal(await row(';addr').locator('.usage-meta').innerText(), 'not used yet');
  const order = () => page.locator('.snippet-row .abbr').allInnerTexts();
  assert.equal(await page.locator('#sort').inputValue(), 'az');
  assert.deepEqual(await order(), [';addr', ';date', ';meet', ';shrug', ';sig', ';ty']);
  await page.locator('#sort').selectOption('used');
  assert.deepEqual(await order(), [';ty', ';sig', ';addr', ';date', ';meet', ';shrug']);
  await waitFor(async () => (await storageGet('settings'))?.managerSort === 'used', 'sort order saved');
  await page.locator('#sort').selectOption('recent');
  assert.deepEqual((await order()).slice(0, 2), [';sig', ';ty'], 'last used first');
  // Search ranks by relevance first, then by the chosen order.
  await page.locator('#search').fill(';s');
  assert.deepEqual(await order(), [';sig', ';shrug']);
  await page.locator('#search').fill('');

  // The order is remembered; a new use shows up live.
  await page.locator('#sort').selectOption('used');
  await waitFor(async () => (await storageGet('settings'))?.managerSort === 'used', 'sort order saved');
  const again = await openOptions();
  assert.equal(await again.locator('#sort').inputValue(), 'used');
  await fields.bringToFront();
  await typeIn(fields, '#search', ';sig ;sig ;sig');
  await again.bringToFront();
  await again.locator('.snippet-row .usage-meta', { hasText: 'used 4× · just now' }).waitFor();
  assert.deepEqual((await again.locator('.snippet-row .abbr').allInnerTexts()).slice(0, 2), [';sig', ';ty']);
});

await test('design: popup "+" opens the manager with a new snippet; one search control; variables help lives in the editor', async () => {
  const fields = await openFields();
  const popup = await openPopupFor(fields);
  await popup.locator('.snippet-button').first().waitFor();
  // The magnifier is inside the bordered search control, which shows focus as a whole.
  assert.equal(await popup.locator('.search-box #search-icon svg').count(), 1);
  assert.equal(await popup.locator('.search-box #search').count(), 1);
  const ring = await popup.locator('.search-box').evaluate((element) => getComputedStyle(element).boxShadow);
  assert.ok(ring !== 'none' && ring.includes('rgba'), `focus ring on the group: ${ring}`);
  assert.equal(await popup.locator('#search').evaluate((element) => getComputedStyle(element).outlineStyle), 'none', 'no ring on the input alone');
  const [opened] = await Promise.all([context.waitForEvent('page', (candidate) => candidate.url().includes('/options.html')), popup.locator('#new-snippet').click()]);
  openPages.add(opened);
  await opened.locator('.editor', { hasText: 'New snippet' }).waitFor();
  assert.equal(await opened.evaluate(() => document.activeElement?.id), 'editor-abbreviation');

  // No separate Variables card: the reference is folded into the editor.
  assert.equal(await opened.locator('#variables').count(), 0);
  const help = opened.locator('.editor .variable-help');
  assert.equal(await help.locator('dl').isVisible(), false, 'folded by default');
  await help.locator('summary').click();
  assert.match(await help.innerText(), /\{clipboard\}[\s\S]*\{choice:Name=A\|B\|C\}[\s\S]*Date formats/);
  await opened.locator('#editor-text').fill('Hi {cursor},\nsee you {choice:Day=Monday|Friday}. {clipboard}');
  await opened.locator('.editor .preview-body .caret-mark').waitFor();
  assert.deepEqual(await opened.locator('.editor .preview-body .var-chip').allInnerTexts(), ['Day ▾', 'clipboard']);
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
  await shot(page, 'demo-email-starters');
});

// --- Curated screenshots with a realistic library (README and store graphics) ---------------

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const SHOWCASE = [
  { abbreviation: ';sig', label: 'Email signature', text: 'Best regards,\nAlex Morgan\nCustomer Success, Northwind', used: [34, 2 * DAY] },
  { abbreviation: ';ty', label: 'Thanks', text: 'Thank you so much for your help!', used: [21, 3 * HOUR] },
  { abbreviation: ';meet', label: 'Meeting request', text: 'Hi {cursor},\n\nWould you have 30 minutes this week for a quick call?\n\nThanks!', used: [12, DAY] },
  {
    abbreviation: ';follow',
    label: 'Follow-up',
    text: 'Hi {input:Name},\n\nJust following up on {choice:Topic=the proposal|my last email|our call}. Any questions so far?\n\n{cursor}',
    used: [9, 5 * HOUR],
  },
  { abbreviation: ';addr', label: 'Office address', text: 'Northwind Ltd.\n42 Harbour Street\nSpringfield 12345', used: [5, 8 * DAY] },
  { abbreviation: ';date', label: "Today's date", text: '{date:YYYY-MM-DD}', used: [4, 30 * MINUTE] },
  { abbreviation: ';link', label: 'Share a link', text: 'Here is the link: {clipboard}', used: [3, 3 * DAY] },
  {
    abbreviation: ';intro',
    label: 'Intro call',
    text: 'Hi {input:Name},\n\nThanks for your interest in {input:Product=Northwind CRM}. Would {choice:Day=Tuesday|Wednesday|Thursday} work for a quick call?\n\n{cursor}',
    used: [2, 6 * DAY],
  },
  { abbreviation: ';eta', label: 'Delivery estimate', text: 'Your order ships within 2 business days, so expect it by {date:dddd, MMMM D}.', used: [1, 12 * DAY] },
  { abbreviation: ';shrug', label: 'Shrug', text: '¯\\_(ツ)_/¯' },
];

async function withShowcase(fn) {
  const saved = { snippets: await storageGet('snippets'), usage: (await storageGet('usage')) ?? {} };
  const now = Date.now();
  const snippets = SHOWCASE.map(({ used: _used, ...snippet }, i) => ({ id: `show-${i}`, createdAt: now - 60 * DAY, updatedAt: now - 30 * DAY, ...snippet }));
  const usage = Object.fromEntries(SHOWCASE.flatMap((entry, i) => (entry.used ? [[`show-${i}`, { count: entry.used[0], lastUsed: now - entry.used[1] }]] : [])));
  await storageSet({ snippets, usage });
  try {
    await fn();
  } finally {
    await storageSet(saved);
  }
}

async function openDemo(size = { width: 760, height: 640 }) {
  const page = await open('demo.html');
  await ready(page);
  await page.setViewportSize(size);
  return page;
}

await test('screenshots: suggestions while writing an email (hero), light and dark', async () => {
  await withShowcase(async () => {
    const page = await openDemo();
    await typeIn(page, '#subject', 'Onboarding next week');
    await typeIn(page, '#body', 'Hi Sam,\n\nGreat talking to you today. ');
    await page.keyboard.type(';');
    assert.deepEqual(await waitSuggest(page, ';'), [';sig', ';ty', ';meet', ';follow', ';addr', ';date', ';link', ';intro', ';eta', ';shrug'], 'most used first');
    await pause(150); // let the caret blink settle for a steady picture
    await shot(page, 'demo-suggest', { curated: true });
    await page.keyboard.type('fo');
    assert.deepEqual(await waitSuggest(page, ';fo'), [';follow']);
    await page.keyboard.press('Escape');
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Backspace');
    await page.keyboard.type(';');
    await waitSuggest(page, ';');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await pause(150);
    await shot(page, 'demo-suggest-dark', { curated: true });
  });
});

await test('screenshots: expanding and filling in an email', async () => {
  await withShowcase(async () => {
    const page = await openDemo({ width: 720, height: 470 });
    await typeIn(page, '#subject', 'Quick call this week?');
    await typeIn(page, '#body', ';meet');
    await page.keyboard.type('Sam');
    await page.keyboard.press('Control+End');
    await page.keyboard.type('\n\n;sig');
    assert.equal(await valueOf(page, '#body'), 'Hi Sam,\n\nWould you have 30 minutes this week for a quick call?\n\nThanks!\n\nBest regards,\nAlex Morgan\nCustomer Success, Northwind');
    await shot(page, 'demo-email', { curated: true });

    const form = await openDemo({ width: 720, height: 470 });
    await typeIn(form, '#subject', 'Northwind CRM demo');
    await typeIn(form, '#body', ';intro');
    assert.deepEqual(await waitForFill(form), ['Name', 'Product', 'Day']);
    await form.keyboard.type('Sam');
    await form.locator('snippets-fill select').selectOption('Thursday');
    await form.locator('snippets-fill select').focus();
    await pause(150);
    await shot(form, 'demo-fill-in', { curated: true });
    await form.keyboard.press('Enter');
    await fillForm(form).waitFor({ state: 'detached' });
    assert.equal(await valueOf(form, '#body'), 'Hi Sam,\n\nThanks for your interest in Northwind CRM. Would Thursday work for a quick call?\n\n');
  });
});

await test('screenshots: popup and manager with usage stats, light and dark', async () => {
  await withShowcase(async () => {
    const page = await openDemo();
    const popup = await openPopupFor(page);
    await popup.locator('#site-status', { hasText: 'Expanding on this site' }).waitFor();
    assert.equal(await popup.locator('#site-host').innerText(), HOSTS.mail);
    assert.deepEqual((await popup.locator('.snippet-button .abbr').allInnerTexts()).slice(0, 4), [';sig', ';ty', ';meet', ';follow']);
    assert.equal(await popup.locator('.snippet-button', { hasText: ';sig' }).locator('.usage-meta').innerText(), 'used 34× · 2 days ago');
    await popup.mouse.move(0, 0);
    await shot(popup, 'popup-light', { curated: true });
    await popup.locator('#site-toggle').click();
    await popup.locator('#site-status', { hasText: 'Paused on this site' }).waitFor();
    await shot(popup, 'popup-paused', { curated: true });
    await popup.locator('#site-toggle').click();
    await popup.locator('#site-status', { hasText: 'Expanding on this site' }).waitFor();
    await popup.emulateMedia({ colorScheme: 'dark' });
    await pause(400); // let Bootstrap's color transitions finish
    await shot(popup, 'popup-dark', { curated: true });

    const options = await openOptions();
    await options.locator('#sort').selectOption('used');
    assert.deepEqual((await options.locator('.snippet-row .abbr').allInnerTexts()).slice(0, 3), [';sig', ';ty', ';meet']);
    await options.mouse.move(0, 0);
    await shot(options, 'options-light', { curated: true });
    await options.emulateMedia({ colorScheme: 'dark' });
    await pause(400);
    await shot(options, 'options-dark', { curated: true });
    await options.emulateMedia({ colorScheme: 'light' });
    await pause(400);

    const row = options.locator('.snippet-row', { has: options.locator('.abbr', { hasText: /^;follow$/ }) });
    await row.getByRole('button', { name: 'Edit ;follow' }).click();
    await options.locator('.editor .preview-body .var-chip', { hasText: 'Topic ▾' }).waitFor();
    await options.locator('.editor').evaluate((element) => {
      const header = document.querySelector('.app-header')?.offsetHeight ?? 0;
      window.scrollTo({ top: element.getBoundingClientRect().top + window.scrollY - header - 12, behavior: 'instant' });
    });
    await options.mouse.move(0, 0);
    await shot(options, 'options-editor', { curated: true });
    await options.locator('.editor .variable-help summary').click();
    await options.locator('.editor .variable-help dl').scrollIntoViewIfNeeded();
    await shot(options, 'options-editor-help');
    await options.locator('#sort').selectOption('az');
  });
});

await test('production build (no test hooks) expands on a page too', async () => {
  const productionDir = await mkdtemp(join(tmpdir(), 'snippets-prod-'));
  const productionPath = join(root, 'dist');
  const production = await chromium.launchPersistentContext(productionDir, {
    executablePath: findChromium(),
    headless,
    args: browserArgs(productionPath),
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

    // Suggestions work with the closed shadow root.
    await page.locator('#search').click();
    await page.keyboard.type(';m');
    await page.locator('snippets-suggest').waitFor({ state: 'attached' });
    assert.equal(await page.locator('snippets-suggest').evaluate((host) => host.shadowRoot), null, 'closed shadow root');
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('#search').inputValue(), 'Hi , Would you have 30 minutes this week for a quick call? Thanks!');

    // clipboardRead is optional and not granted here: {clipboard} inserts nothing.
    await production.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
    await page.evaluate(() => navigator.clipboard.writeText('secret on the clipboard'));
    assert.equal(await productionWorker.evaluate(() => chrome.permissions.contains({ permissions: ['clipboardRead'] })), false);
    await productionWorker.evaluate(async () => {
      const { snippets } = await chrome.storage.local.get('snippets');
      await chrome.storage.local.set({ snippets: [...snippets, { id: 'clip', abbreviation: ';link', text: 'Link: {clipboard}!', label: '', createdAt: 1, updatedAt: 1 }] });
    });
    await waitFor(async () => {
      await page.locator('#url').fill('');
      await page.locator('#url').click();
      await page.keyboard.type(';link');
      return (await page.locator('#url').inputValue()) !== ';link';
    }, 'the new snippet reached the page');
    assert.equal(await page.locator('#url').inputValue(), 'Link: !', 'nothing read without the permission');
  } finally {
    await production.close();
    await rm(productionDir, { recursive: true, force: true });
  }
});

await test('no network requests leave the browser', async () => {
  assert.deepEqual(outsideRequests, [], `requests outside the fixture hosts: ${outsideRequests.join(', ')}`);
});

// --- Summary ----------------------------------------------------------------------------

await context.close();
for (const response of hanging) response.destroy();
server.close();
await rm(userDataDir, { recursive: true, force: true });

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed. Screenshots: ${outputDir} (curated: ${screenshotsDir})`);
process.exit(failed.length ? 1 : 0);
