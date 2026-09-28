// End-to-end smoke test: loads the e2e build (dist-e2e/) into a real Chromium and drives
// every user flow against local fixture pages.
//
//   npm run test:e2e                      (set CHROMIUM_PATH if Chromium isn't auto-detected)
//
// Native context menus and browser-level shortcuts can't be clicked from automation, so the
// test calls the exact handlers Chrome would call (exposed only in the e2e build).

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const extensionPath = join(root, 'dist-e2e');
const fixtures = join(root, 'e2e/fixtures');
const outputDir = join(root, 'e2e/output');
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
  // Same article, served with a strict CSP to check the panel still renders and works.
  const strictCsp = url.pathname === '/csp.html';
  const file = strictCsp ? 'article.html' : url.pathname.slice(1);
  try {
    const body = await readFile(join(fixtures, file));
    const headers = { 'content-type': 'text/html; charset=utf-8' };
    if (strictCsp) headers['content-security-policy'] = "default-src 'none'; style-src 'self'; script-src 'none'";
    response.writeHead(200, headers).end(body);
  } catch {
    response.writeHead(404).end('not found');
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
// Fixtures are served under realistic host names without a port, so no screenshot or prompt
// shows 127.0.0.1, localhost or a port. Chromium maps every name to this server (launch args).
const HOSTS = {
  'article.html': 'news.example.com',
  'csp.html': 'news.example.com',
  'big.html': 'news.example.com',
  'stackoverflow.html': 'qa.example.com',
  'github.html': 'code.example.org',
  'table.html': 'saas.example.com',
  'social.html': 'social.example.com',
  'weird.html': 'blog.example.org',
  'logs.html': 'docs.example.com',
};
const SITES = [...new Set(Object.values(HOSTS))];
const originOf = (file) => `http://${HOSTS[file]}`;
const FIXTURE_ORIGINS = SITES.map((host) => `http://${host}`);
// "Copy & open" targets. The sandbox can't reach them, so a stub page answers instead.
const AI_SITES = /^https:\/\/(?:chatgpt\.com|www\.perplexity\.ai|claude\.ai|gemini\.google\.com)\//;

// --- Browser ----------------------------------------------------------------------------

await mkdir(outputDir, { recursive: true });
const userDataDir = await mkdtemp(join(tmpdir(), 'pastebot-e2e-'));
const context = await chromium.launchPersistentContext(userDataDir, {
  executablePath: findChromium(),
  headless,
  viewport: { width: 1280, height: 800 },
  locale: 'en-US',
  args: [
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
    // The fixture host names (port 80) resolve to the local fixture server...
    `--host-resolver-rules=${SITES.map((host) => `MAP ${host}:80 127.0.0.1:${port}`).join(',')}`,
    // ...directly, not through a proxy from the environment...
    '--no-proxy-server',
    // ...and are secure contexts like 127.0.0.1 (the Clipboard API needs one).
    `--unsafely-treat-insecure-origin-as-secure=${FIXTURE_ORIGINS.join(',')}`,
  ],
});
for (const origin of FIXTURE_ORIGINS) await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
await context.route(AI_SITES, (route) =>
  route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>AI chat (stub)</title><p>Stub page for the e2e test.</p>' }),
);
const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
const extensionId = new URL(worker.url()).host;

const openPages = new Set();

async function newPage() {
  const page = await context.newPage();
  openPages.add(page);
  return page;
}

async function open(name, query = '') {
  const page = await newPage();
  await page.goto(`${originOf(name)}/${name}${query}`);
  await page.bringToFront();
  return page;
}

async function select(page, selector) {
  await page.evaluate((selector) => {
    const node = document.querySelector(selector);
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
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out: ${message}`);
}

/** What chrome.contextMenus.onClicked would deliver. */
async function menu(page, menuItemId, extra = {}) {
  const tab = await tabOf(page);
  const selectionText = await page.evaluate(() => window.getSelection()?.toString() ?? '');
  const info = { menuItemId, frameId: 0, pageUrl: page.url(), editable: false, selectionText, ...extra };
  await worker.evaluate(({ info, tab }) => globalThis.__pastebotTest.onContextMenuClick(info, tab), { info, tab });
}

async function shortcut(page) {
  const tab = await tabOf(page);
  await worker.evaluate((tab) => globalThis.__pastebotTest.onCommand('make-prompt', tab), tab);
}

async function resetClipboard(page) {
  await page.bringToFront();
  await page.evaluate(() => navigator.clipboard.writeText('<empty>'));
}

async function clipboard(page) {
  await page.bringToFront();
  return page.evaluate(() => navigator.clipboard.readText());
}

async function setSettings(patch) {
  await worker.evaluate(async (patch) => {
    const { settings = {} } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...settings, ...patch } });
  }, patch);
}

async function history() {
  return worker.evaluate(async () => (await chrome.storage.local.get('history')).history ?? []);
}

async function setStorage(items) {
  await worker.evaluate((items) => chrome.storage.local.set(items), items);
}

async function removeStorage(keys) {
  await worker.evaluate((keys) => chrome.storage.local.remove(keys), keys);
}

async function templates() {
  return worker.evaluate(async () => (await chrome.storage.local.get('customTemplates')).customTemplates ?? []);
}

/** Ids of the context-menu items the background created last (native menus can't be read). */
async function menuIds() {
  return worker.evaluate(() => globalThis.__pastebotTest.menuIds());
}

async function menuTitles() {
  return worker.evaluate(() => globalThis.__pastebotTest.menuTitles());
}

async function settings() {
  return worker.evaluate(async () => (await chrome.storage.local.get('settings')).settings ?? {});
}

/** Waits for a tab the extension opened on an AI site, returns its address and closes it. */
async function openedTab(prefix) {
  const tab = await waitFor(
    () =>
      worker.evaluate(async (prefix) => {
        const tabs = await chrome.tabs.query({});
        return tabs.find((tab) => (tab.pendingUrl || tab.url || '').startsWith(prefix)) ?? null;
      }, prefix),
    `a tab opened on ${prefix}`,
  );
  await worker.evaluate((id) => chrome.tabs.remove(id), tab.id);
  return tab.pendingUrl || tab.url;
}

/** Waits until the context menu offers exactly these templates, in this order. */
async function waitForTemplateMenu(ids) {
  const expected = JSON.stringify(ids.map((id) => `pastebot:template:${id}`));
  const actual = async () => JSON.stringify((await menuIds()).filter((id) => id.startsWith('pastebot:template:')));
  await waitFor(async () => (await actual()) === expected, `menu templates = ${expected}`);
}

/** History items as stored, newest first. */
function seedHistory(count, extra = () => ({})) {
  const now = Date.now();
  return Array.from({ length: count }, (_, i) => ({
    id: `seed-${i}`,
    timestamp: now - i * 60_000,
    action: 'summarize',
    prompt: `Summarize the following content.\n\nSeeded prompt number ${i}`,
    preview: `Seeded source ${i}`,
    ...extra(i),
  }));
}

async function openOptions() {
  const page = await newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  await page.locator('#pro-price', { hasText: '$' }).waitFor();
  return page;
}

async function openPopup() {
  const page = await newPage();
  await page.setViewportSize({ width: 380, height: 600 });
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  return page;
}

const panel = (page) => page.locator('pastebot-overlay .card');
const toast = (page) => page.locator('pastebot-overlay .toast');
const inPanel = (page, selector) => page.locator(`pastebot-overlay ${selector}`);
const done = (page) => page.locator('pastebot-overlay .headline.success');

/** Fake secrets in e2e/fixtures/logs.html: none of them may reach a masked prompt or history. */
const LOG_SECRETS = [
  'anna.kowalski@example.com',
  'sk-proj-Xq7LmN2pR8sT4vW9yZ1aB3cD5eF6gH0jK2lM4nP9fQ2',
  '4242 4242 4242 4242',
  '203.0.113.42',
  '+1 415 555 0132',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
  '/Users/anna',
];

function assertNoSecrets(text, where) {
  for (const secret of LOG_SECRETS) assert.ok(!text.includes(secret), `${where} contains ${secret}`);
}
const shot = (page, name) => page.screenshot({ path: join(outputDir, `${name}.png`) });

// --- Tests ------------------------------------------------------------------------------

const results = [];
async function test(name, fn) {
  const started = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - started });
    console.log(`  ✓ ${name} (${Date.now() - started} ms)`);
  } catch (error) {
    results.push({ name, ok: false, error });
    console.log(`  ✗ ${name}\n      ${String(error?.message ?? error).split('\n').join('\n      ')}`);
  } finally {
    for (const page of openPages) await page.close().catch(() => undefined);
    openPages.clear();
  }
}

console.log(`Chromium ${context.browser()?.version() ?? ''} · extension ${extensionId}\n`);

await test('manifest requests only the expected permissions (production build)', async () => {
  const manifest = JSON.parse(await readFile(join(root, 'dist/manifest.json'), 'utf8'));
  assert.deepEqual([...manifest.permissions].sort(), ['activeTab', 'clipboardWrite', 'contextMenus', 'offscreen', 'scripting', 'storage']);
  assert.equal(manifest.host_permissions, undefined);
  assert.equal(manifest.content_scripts, undefined);
});

await test('article: Summarize from the context menu copies a cleaned prompt and shows a toast', async () => {
  const page = await open('article.html');
  await resetClipboard(page);
  await select(page, '#article');
  const started = Date.now();
  await menu(page, 'pastebot:action:summarize');
  await toast(page).waitFor();
  const elapsed = Date.now() - started;
  const text = await clipboard(page);
  assert.ok(text.startsWith('Summarize the following content.'), text);
  assert.ok(text.includes('5.25%') && text.includes('4.31 per euro') && text.includes('https://example.com/decision?id=42'));
  assert.ok(!/^Share$/m.test(text) && !/^Advertisement$/m.test(text) && !/^Read more$/m.test(text), 'UI noise removed');
  assert.equal(text.match(/By Anna Kowalski/g)?.length, 1, 'duplicated byline removed');
  assert.ok(!text.includes('Page:'), 'page context off by default');
  assert.match(await toast(page).innerText(), /Summarize prompt copied/);
  assert.ok(elapsed < 2000, `took ${elapsed} ms`);
  await shot(page, 'article-toast');
  await page.close();
});

await test('page context: title and cleaned URL are included when enabled', async () => {
  await setSettings({ includePageContext: true });
  const page = await open('article.html', '?utm_source=newsletter&id=7');
  await resetClipboard(page);
  await select(page, '#article p:nth-of-type(3)');
  await menu(page, 'pastebot:action:explain');
  await toast(page).waitFor();
  const text = await clipboard(page);
  assert.ok(text.includes('Page: Central bank raises rates again | Example News'), text);
  assert.ok(text.includes('URL: http://news.example.com/article.html?id=7\n'), text);
  assert.ok(!text.includes('utm_source'));
  await setSettings({ includePageContext: false });
  await page.close();
});

await test('stack overflow: Explain on a Java stack trace keeps lines and detects Java', async () => {
  const page = await open('stackoverflow.html');
  await resetClipboard(page);
  await select(page, '#trace');
  await menu(page, 'pastebot:action:explain');
  await toast(page).waitFor();
  const text = await clipboard(page);
  assert.ok(text.startsWith('Explain the following Java error.'), text);
  assert.ok(text.includes('experienced Java developer'));
  assert.ok(text.includes('\n    at com.example.UserService.validate(UserService.java:142)\n'), 'indentation and newlines kept');
  await page.close();
});

await test('stack overflow: Analyze on code uses a java fence and ignores the post menu', async () => {
  const page = await open('stackoverflow.html');
  await resetClipboard(page);
  await select(page, '#question');
  await menu(page, 'pastebot:action:analyze');
  await toast(page).waitFor();
  const text = await clipboard(page);
  assert.ok(text.includes('if (name.length() < 3) {'), 'code content preserved');
  assert.ok(!/^Improve this question$/m.test(text), 'post menu removed');
  await page.close();
});

await test('github: code view selection keeps code and line structure', async () => {
  const page = await open('github.html');
  await resetClipboard(page);
  await select(page, '#blob');
  await menu(page, 'pastebot:action:explain');
  await toast(page).waitFor();
  const text = await clipboard(page);
  assert.ok(text.includes('Explain the following'), text);
  assert.ok(text.includes('if (text.length <= limit) return text;'));
  assert.ok(text.includes("cut.lastIndexOf('\\n')"), 'escape sequences untouched');
  await page.close();
});

await test('table: Make Prompt panel → Compare keeps rows and empty cells', async () => {
  const page = await open('table.html');
  await resetClipboard(page);
  await select(page, '#pricing');
  await menu(page, 'pastebot:make');
  await panel(page).waitFor();
  await shot(page, 'table-panel');
  await page.locator('pastebot-overlay [data-action="compare"]').click();
  await page.locator('pastebot-overlay .headline.success').waitFor();
  await shot(page, 'table-done');
  const text = await clipboard(page);
  assert.ok(text.startsWith('Compare the items in the following table.'), text);
  assert.ok(text.includes('Free\t$0\t1\t'), 'tab-separated with empty trailing cell');
  assert.ok(text.includes('Team\t$30/mo\t25\tPriority, 24/7'));
  await page.close();
});

await test('panel: number keys pick an action, Custom takes an instruction', async () => {
  const page = await open('social.html');
  await resetClipboard(page);
  await select(page, '#post .text');
  await menu(page, 'pastebot:make');
  await panel(page).waitFor();
  // 1-7 are the built-in actions (Translate is 7), 8 opens Custom.
  await page.keyboard.press('8');
  await page.locator('pastebot-overlay textarea').fill('Turn this into a professional email to my team.');
  await shot(page, 'custom-panel');
  await page.keyboard.press('Enter');
  await page.locator('pastebot-overlay .headline.success').waitFor();
  const text = await clipboard(page);
  assert.ok(text.startsWith('Turn this into a professional email to my team.\n\nContent:\n"""'), text);
  assert.ok(text.includes('2.1M users 🎉'), 'emoji preserved');

  // Last instruction is remembered and the digit shortcut runs the default action.
  await resetClipboard(page);
  await select(page, '#post .text');
  await menu(page, 'pastebot:make');
  await panel(page).waitFor();
  await page.keyboard.press('2');
  await page.locator('pastebot-overlay .headline.success').waitFor();
  assert.ok((await clipboard(page)).startsWith('Summarize the following content.'));
  const stored = await worker.evaluate(async () => (await chrome.storage.local.get('lastCustomInstruction')).lastCustomInstruction);
  assert.equal(stored, 'Turn this into a professional email to my team.');
  await page.close();
});

await test('social: YouTube-like description drops "Show more", keeps timestamps', async () => {
  const page = await open('social.html');
  await resetClipboard(page);
  await select(page, '#desc');
  await menu(page, 'pastebot:action:summarize');
  await toast(page).waitFor();
  const text = await clipboard(page);
  assert.ok(text.includes('0:00 Intro\n1:42 Manifest V3 basics'), text);
  assert.ok(!/^Show more$/m.test(text));
  await page.close();
});

await test('unusual formatting: invisible chars cleaned, symbols kept, hostile CSS does not leak', async () => {
  const page = await open('weird.html');
  await resetClipboard(page);
  await select(page, '#weird');
  await menu(page, 'pastebot:make');
  await panel(page).waitFor();
  const font = await panel(page).evaluate((element) => getComputedStyle(element).fontFamily);
  assert.ok(!font.includes('Comic Sans'), `panel font: ${font}`);
  await shot(page, 'weird-panel');
  await page.locator('pastebot-overlay [data-action="rewrite"]').click();
  await page.locator('pastebot-overlay .headline.success').waitFor();
  const text = await clipboard(page);
  assert.ok(text.includes('Price: 1 299 ₴ — including VAT.'), text);
  assert.ok(text.includes('x < y && y > z'));
  assert.ok(text.includes('👨‍👩‍👧') && text.includes('<script>alert(1)</script>'));
  assert.ok(text.includes('Кирилиця теж'));
  assert.ok(!text.includes('\n\n\n'), 'blank lines collapsed');
  await page.close();
});

await test('textarea selection works through the keyboard shortcut', async () => {
  const page = await open('weird.html');
  await resetClipboard(page);
  await page.evaluate(() => {
    const field = document.getElementById('field');
    field.focus();
    field.setSelectionRange(0, field.value.length);
  });
  await shortcut(page);
  await panel(page).waitFor();
  assert.match(await page.locator('pastebot-overlay .meta').innerText(), /55 chars/);
  await page.keyboard.press('1');
  await page.locator('pastebot-overlay .headline.success').waitFor();
  const text = await clipboard(page);
  assert.ok(text.includes('Selected inside a textarea.\nSecond line'), text);
  await page.close();
});

await test('shortcut without a selection explains what to do', async () => {
  const page = await open('article.html');
  await shortcut(page);
  await toast(page).waitFor();
  assert.match(await toast(page).innerText(), /Select some text on the page first/);
  await page.close();
});

await test('strict CSP page: panel is styled and works', async () => {
  const page = await open('csp.html');
  await resetClipboard(page);
  await select(page, '#article');
  await menu(page, 'pastebot:make');
  await panel(page).waitFor();
  const radius = await panel(page).evaluate((element) => getComputedStyle(element).borderRadius);
  assert.equal(radius, '12px');
  await page.locator('pastebot-overlay [data-action="extract"]').click();
  await page.locator('pastebot-overlay .headline.success').waitFor();
  assert.ok((await clipboard(page)).startsWith('Extract the important structured information'));
  await shot(page, 'csp-done');
  await page.close();
});

await test('huge selection: warned, trimmed on request, then copied', async () => {
  const page = await open('big.html');
  await resetClipboard(page);
  await select(page, '#big');
  const started = Date.now();
  await menu(page, 'pastebot:action:summarize');
  await page.locator('pastebot-overlay .headline.warn').waitFor();
  await shot(page, 'too-large');
  assert.match(await panel(page).innerText(), /This selection is too long/);
  await page.locator('pastebot-overlay .primary').click();
  await page.locator('pastebot-overlay .headline.success').waitFor();
  const text = await clipboard(page);
  assert.ok(text.startsWith('Summarize the following content.'));
  assert.ok(text.length > 95_000 && text.length < 101_000, `length ${text.length}`);
  assert.ok(Date.now() - started < 5000);
  await page.close();
});

await test('unscriptable frame: falls back to the text Chrome reports', async () => {
  const page = await open('article.html');
  await resetClipboard(page);
  // A frame id that can't be scripted, like a cross-origin iframe without access.
  await menu(page, 'pastebot:action:rewrite', { frameId: 987654, selectionText: 'teh quick brown fox jumpd' });
  await toast(page).waitFor();
  const text = await clipboard(page);
  assert.ok(text.includes('teh quick brown fox jumpd'), text);
  await page.close();
});

await test('panel closes with Escape and on outside click', async () => {
  const page = await open('article.html');
  await select(page, '#article');
  await menu(page, 'pastebot:make');
  await panel(page).waitFor();
  await page.keyboard.press('Escape');
  await panel(page).waitFor({ state: 'detached' });
  await menu(page, 'pastebot:make');
  await panel(page).waitFor();
  await page.mouse.click(5, 790);
  await panel(page).waitFor({ state: 'detached' });
  await page.close();
});

await test('history keeps newest first and respects the limit', async () => {
  await setSettings({ maxHistoryItems: 3 });
  const page = await open('article.html');
  for (const action of ['analyze', 'extract', 'compare', 'explain']) {
    await select(page, '#article p:nth-of-type(3)');
    await menu(page, `pastebot:action:${action}`);
  }
  const items = await history();
  assert.equal(items.length, 3);
  assert.deepEqual(items.map((item) => item.action), ['explain', 'compare', 'extract']);
  assert.ok(items[0].pageTitle && items[0].pageUrl && items[0].preview && items[0].timestamp);

  await setSettings({ maxHistoryItems: 20 });
  await page.close();
});

await test('popup: paste text, make, edit, copy, history actions', async () => {
  const page = await newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.setViewportSize({ width: 380, height: 600 });
  await page.locator('#input').fill('NullPointerException at UserService.java:142');
  // The same numbered chips as the panel; a chip makes and copies the prompt right away.
  assert.deepEqual(
    await page.locator('#actions .chip').evaluateAll((chips) => chips.map((chip) => chip.innerText.replace(/\s+/g, ' ').trim())),
    ['1 Analyze', '2 Summarize', '3 Explain', '4 Extract', '5 Compare', '6 Rewrite', '7 Translate', '8 Custom…'],
  );
  await page.locator('[data-action="explain"]').click();
  await page.locator('#copy-status', { hasText: 'Copied!' }).waitFor();
  const output = await page.locator('#output').inputValue();
  assert.ok(output.startsWith('Explain the following Java error.'), output);
  // The text collapses to one line so the prompt and Copy stay in view.
  assert.equal(await page.locator('#input-block').isHidden(), true);
  assert.match(await page.locator('#input-summary').innerText(), /NullPointerException at UserService\.java:142.*44 chars/);
  assert.equal(await page.locator('[data-action="explain"]').getAttribute('aria-pressed'), 'true');
  await shot(page, 'popup-result');

  // Edit before copying: the history entry is updated too.
  await page.locator('#output').fill(`${output}\n\nAnswer in Ukrainian.`);
  await page.locator('#copy').click();
  await waitFor(async () => (await history())[0]?.prompt.endsWith('Answer in Ukrainian.'), 'history entry updated after edit');
  assert.ok((await clipboard(page)).endsWith('Answer in Ukrainian.'));

  // Custom action and the too-large path.
  await page.locator('[data-action="custom"]').click();
  await page.locator('#instruction').fill('');
  await page.locator('#make').click();
  await page.locator('#error', { hasText: 'Write what the AI should do' }).waitFor();
  await page.locator('#input-summary').click();
  await page.locator('#input').fill('x '.repeat(60_000));
  await page.locator('#instruction').fill('Count the words.');
  await page.locator('#make').click();
  await page.locator('#trim').waitFor();
  await page.locator('#trim').click();
  assert.ok((await page.locator('#input').inputValue()).length <= 100_000);
  await page.locator('#make').click();
  await page.waitForFunction(() => document.getElementById('output').value.startsWith('Count the words.'));
  await waitFor(async () => (await history())[0]?.prompt.startsWith('Count the words.'), 'custom prompt saved');

  // Delete one, then clear all (two clicks), in the History tab.
  await page.locator('#tab-history').click();
  assert.equal(await page.locator('#panel-compose').isHidden(), true);
  const stored = (await history()).length;
  assert.equal(await page.locator('#history-tab-count').innerText(), String(stored));
  await waitFor(async () => (await page.locator('.history-item').count()) === stored, 'history list rendered');
  const before = stored;
  await page.locator('.history-item').first().getByLabel('Delete prompt').click();
  await page.waitForFunction((n) => document.querySelectorAll('.history-item').length === n - 1, before);
  await page.locator('#clear-history').click();
  await page.locator('#clear-history').click();
  await page.locator('#history-empty').waitFor();
  assert.equal((await history()).length, 0);
  await page.close();
});

await test('unscriptable page (chrome://): Make Prompt opens the real popup with the selection', async () => {
  // An extension page to inspect the toolbar popup from. Opened first: focusing a new tab
  // would close the popup.
  const probe = await newPage();
  await probe.goto(`chrome-extension://${extensionId}/options.html`);
  const blocked = await newPage();
  await blocked.goto('chrome://version');
  const tab = await tabOf(blocked);
  await worker.evaluate(
    ({ tab }) =>
      globalThis.__pastebotTest.onContextMenuClick(
        { menuItemId: 'pastebot:make', frameId: 0, pageUrl: 'chrome://version', editable: false, selectionText: 'Google Chrome 141' },
        tab,
      ),
    { tab },
  );
  await waitFor(
    () =>
      probe.evaluate(() => {
        const [popup] = chrome.extension.getViews({ type: 'popup' });
        return popup?.document.getElementById('input')?.value === 'Google Chrome 141';
      }),
    'popup opened with the pending selection',
  );
});

await test('options: settings persist and change the generated prompt', async () => {
  const page = await newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  await page.locator('input[value="concise"]').check();
  await page.locator('#save-status', { hasText: 'Saved' }).waitFor();
  await page.locator('#default-action').selectOption('explain');
  await page.locator('#max-history').fill('999');
  await page.locator('#max-history').blur();
  await page.waitForFunction(() => document.getElementById('max-history').value === '500');
  assert.match(await page.locator('.privacy').innerText(), /does not send your selected text or browsing data to a remote server/);
  assert.match(await page.locator('.privacy').innerText(), /Copy & open/);
  // Suggested shortcut actually got assigned (Chrome silently drops conflicting ones, e.g. Ctrl+Shift+P).
  assert.equal(await page.locator('#shortcut').innerText(), 'Alt+P');
  await shot(page, 'options');
  const settings = await worker.evaluate(async () => (await chrome.storage.local.get('settings')).settings);
  assert.equal(settings.promptStyle, 'concise');
  assert.equal(settings.defaultAction, 'explain');
  assert.equal(settings.maxHistoryItems, 500);

  const article = await open('stackoverflow.html');
  await resetClipboard(article);
  await select(article, '#trace');
  await menu(article, 'pastebot:make');
  await panel(article).waitFor();
  assert.match(await article.locator('pastebot-overlay .action.default').innerText(), /Explain/);
  await article.keyboard.press('Enter');
  await article.locator('pastebot-overlay .headline.success').waitFor();
  assert.ok((await clipboard(article)).startsWith('Explain what is most likely causing the following Java error'));
  await article.close();
  await page.close();
});

await test('templates: create in settings, then use from the menu, the panel and the popup', async () => {
  await removeStorage(['customTemplates']);
  await setSettings({ promptStyle: 'balanced' });
  const options = await openOptions();
  await options.locator('#add-template').click();
  await options.locator('#template-name').fill('Email to my team');
  await options.locator('#template-instruction').fill('Rewrite {content} as a short email to my team. Keep every number.');
  // The preview runs the real generator on sample text.
  await options.waitForFunction(() => document.getElementById('template-preview').textContent.startsWith('Rewrite\n"""\nQ3 revenue'));
  await options.locator('#save-template').click();
  await options.locator('.template-item').first().waitFor();
  assert.equal(await options.locator('#template-editor').isHidden(), true);
  const [template] = await templates();
  assert.equal(template.name, 'Email to my team');
  await waitForTemplateMenu([template.id]);
  const ids = await menuIds();
  assert.ok(ids.indexOf(`pastebot:template:${template.id}`) > ids.indexOf('pastebot:action:rewrite'), 'templates come after the built-in actions');

  // Context menu: copied right away, through the same generator (cleanup still applies).
  const page = await open('article.html');
  await resetClipboard(page);
  await select(page, '#article');
  await menu(page, `pastebot:template:${template.id}`);
  await toast(page).waitFor();
  assert.match(await toast(page).innerText(), /“Email to my team” prompt copied/);
  let text = await clipboard(page);
  assert.ok(text.startsWith('Rewrite\n"""\n'), text);
  assert.ok(text.includes('as a short email to my team. Keep every number.'), text);
  assert.ok(text.includes('5.25%') && !/^Share$/m.test(text), 'content kept, UI noise removed');
  const [saved] = await history();
  assert.equal(saved.templateName, 'Email to my team');
  assert.equal(saved.action, 'custom');

  // Panel: the template is offered under "Your templates" and gets the digit after Custom (9).
  const lastInstructionBefore = await worker.evaluate(async () => (await chrome.storage.local.get('lastCustomInstruction')).lastCustomInstruction);
  await resetClipboard(page);
  await select(page, '#article p:nth-of-type(3)');
  await menu(page, 'pastebot:make');
  await panel(page).waitFor();
  const button = page.locator(`pastebot-overlay [data-template-id="${template.id}"]`);
  assert.equal((await button.innerText()).replace(/\s+/g, ' ').trim(), '9 Email to my team');
  assert.match(await panel(page).innerText(), /Your templates\s*PRO/i);
  await shot(page, 'panel-templates');
  await page.keyboard.press('9');
  await page.locator('pastebot-overlay .headline.success').waitFor();
  text = await clipboard(page);
  assert.ok(text.startsWith('Rewrite\n"""\nThe central bank'), text);
  assert.ok(text.endsWith('as a short email to my team. Keep every number.'), 'balanced style adds nothing after the instruction');
  const lastInstruction = await worker.evaluate(async () => (await chrome.storage.local.get('lastCustomInstruction')).lastCustomInstruction);
  assert.equal(lastInstruction, lastInstructionBefore, 'templates do not overwrite the last Custom instruction');

  // Popup: templates are chips under the actions.
  const popup = await openPopup();
  await popup.locator(`#template-chips [data-template-id="${template.id}"]`).waitFor();
  await popup.locator('#input').fill('Revenue grew 18% in Q3.');
  await popup.locator(`[data-template-id="${template.id}"]`).click();
  assert.equal(await popup.locator('#instruction').isHidden(), true);
  await popup.waitForFunction(() => document.getElementById('output').value.startsWith('Rewrite\n"""\nRevenue grew 18% in Q3.'));
  await popup.locator('#tab-history').click();
  await popup.locator('.history-item .badge', { hasText: 'Email to my team' }).first().waitFor();
});

await test('templates: edit, reorder and delete; the menu follows', async () => {
  const options = await openOptions();
  const [first] = await templates();
  await options.locator('#add-template').click();
  await options.locator('#template-name').fill('Code review');
  await options.locator('#template-instruction').fill('Review this code like a senior engineer. List bugs first.');
  await options.locator('#save-template').click();
  await options.locator('.template-item').nth(1).waitFor();
  const second = (await templates())[1];
  await waitForTemplateMenu([first.id, second.id]);

  // Reorder.
  await options.locator(`.template-item[data-id="${second.id}"]`).getByLabel('Move up: Code review').click();
  await waitFor(async () => (await templates())[0]?.id === second.id, 'order saved');
  await waitForTemplateMenu([second.id, first.id]);

  // Validation: names are unique, {content} at most once.
  await options.locator('#add-template').click();
  await options.locator('#template-name').fill('code review');
  await options.locator('#template-instruction').fill('Anything');
  await options.locator('#save-template').click();
  await options.locator('#template-name-error', { hasText: 'already a template with this name' }).waitFor();
  await options.locator('#template-name').fill('Twice');
  await options.locator('#template-instruction').fill('{content} vs {content}');
  await options.locator('#save-template').click();
  await options.locator('#template-instruction-error', { hasText: 'at most once' }).waitFor();
  await options.locator('#template-instruction').fill('Write for {{Audience');
  await options.locator('#save-template').click();
  await options.locator('#template-instruction-error', { hasText: 'not closed' }).waitFor();
  await options.locator('#cancel-template').click();
  assert.equal((await templates()).length, 2);

  // Edit: rename; same id, so the menu keeps its place.
  await options.locator(`.template-item[data-id="${first.id}"]`).getByLabel('Edit: Email to my team').click();
  assert.equal(await options.locator('#template-name').inputValue(), 'Email to my team');
  await options.locator('#template-name').fill('Team email');
  await options.locator('#save-template').click();
  await options.locator('.template-name', { hasText: 'Team email' }).waitFor();
  assert.equal((await templates()).find((item) => item.id === first.id).name, 'Team email');

  // Panel click path, with two templates.
  const page = await open('stackoverflow.html');
  await resetClipboard(page);
  await select(page, '#question');
  await menu(page, 'pastebot:make');
  await panel(page).waitFor();
  await page.locator(`pastebot-overlay [data-template-id="${second.id}"]`).click();
  await page.locator('pastebot-overlay .headline.success').waitFor();
  const text = await clipboard(page);
  // The question mixes a stack trace and code, so it is fenced as an error.
  assert.ok(text.startsWith('Review this code like a senior engineer. List bugs first.\n\nError:\n```\n'), text);
  assert.ok(text.includes('if (name.length() < 3) {'), text);

  // Delete (two clicks), then a stale menu click explains instead of failing silently.
  const remove = options.locator(`.template-item[data-id="${second.id}"]`).getByLabel('Delete: Code review');
  await remove.click();
  await remove.click();
  await waitFor(async () => (await templates()).length === 1, 'template deleted');
  await waitForTemplateMenu([first.id]);
  await select(page, '#question');
  await menu(page, `pastebot:template:${second.id}`);
  await toast(page).waitFor();
  assert.match(await toast(page).innerText(), /no longer exists/);
});

await test('history: Pro keeps more than 20, search finds old prompts, pins stay on top', async () => {
  await setSettings({ maxHistoryItems: 500 });
  await setStorage({
    history: seedHistory(40, (i) => (i === 33 ? { prompt: 'Explain the following Kubernetes error.\n\nCrashLoopBackOff', pageTitle: 'Pod logs' } : {})),
  });
  const page = await open('article.html');
  await select(page, '#article p:nth-of-type(3)');
  await menu(page, 'pastebot:action:explain');
  await toast(page).waitFor();
  assert.equal((await history()).length, 41, 'no free-plan cap in early access');

  const popup = await openPopup();
  // History is one click away: its tab shows the count before it is opened.
  await popup.locator('#history-tab-count', { hasText: '41' }).waitFor();
  await popup.locator('#tab-history').click();
  await popup.locator('#history-count', { hasText: '41' }).waitFor();
  assert.equal(await popup.locator('.history-item').count(), 41);
  assert.equal(await popup.locator('#history-limit').isHidden(), true);
  await popup.locator('#history-search').fill('kubernetes crashloop');
  await popup.waitForFunction(() => document.querySelectorAll('.history-item').length === 1);
  assert.match(await popup.locator('.history-item').innerText(), /Pod logs/);
  assert.match(await popup.locator('#history-count').innerText(), /1 of 41/i);
  await popup.locator('#history-search').fill('nothing like this');
  await popup.locator('#history-no-match', { hasText: 'No prompts match' }).waitFor();
  await popup.locator('#history-search').fill('');
  await popup.waitForFunction(() => document.querySelectorAll('.history-item').length === 41);

  // Pin an older prompt: it moves to the top and is stored as pinned.
  await popup.locator('.history-item[data-id="seed-33"]').getByLabel('Pin prompt', { exact: true }).click();
  await popup.locator('.history-item.pinned[data-id="seed-33"]').waitFor();
  assert.equal(await popup.locator('.history-item').first().getAttribute('data-id'), 'seed-33');
  assert.equal((await history()).find((item) => item.id === 'seed-33').pinned, true);
  await shot(popup, 'popup-pinned');

  // "Clear unpinned" keeps the pin; unpinning is explicit.
  assert.equal(await popup.locator('#clear-history').innerText(), 'Clear unpinned');
  await popup.locator('#clear-history').click();
  await popup.locator('#clear-history').click();
  await waitFor(async () => (await history()).length === 1, 'only the pinned prompt left');
  await popup.waitForFunction(() => document.querySelectorAll('.history-item').length === 1);
  await popup.locator('.history-item').getByLabel('Unpin prompt').click();
  await waitFor(async () => (await history())[0]?.pinned === undefined, 'unpinned');
  await setSettings({ maxHistoryItems: 20 });
});

await test('free plan (early access off): calm limits, nothing deleted, templates kept', async () => {
  const [template] = await templates();
  await setSettings({ maxHistoryItems: 500 });
  await setStorage({ history: seedHistory(25, (i) => (i === 10 ? { pinned: true } : {})), e2eEarlyAccess: false });
  try {
    await waitForTemplateMenu([]);

    // History over the free size is not trimmed: it rotates at its current size.
    const page = await open('article.html');
    await select(page, '#article p:nth-of-type(3)');
    await menu(page, 'pastebot:action:summarize');
    await toast(page).waitFor();
    let items = await history();
    assert.equal(items.length, 25);
    assert.equal(items[0].action, 'summarize');
    assert.ok(items.some((item) => item.id === 'seed-10' && item.pinned), 'pinned prompt kept');

    // A template menu item that is still showing somewhere explains calmly.
    await menu(page, `pastebot:template:${template.id}`);
    await toast(page).filter({ hasText: 'Custom templates are part of Pro' }).waitFor();

    // Popup: search off, only unpinning, and the one-line note with a link to About Pro.
    const popup = await openPopup();
    await popup.locator('#tab-history').click();
    await popup.locator('#history-limit').waitFor();
    assert.match(await popup.locator('#history-limit').innerText(), /Free keeps the last 20 prompts\. Pro keeps up to 500, with search and pins\.\s*About Pro/);
    assert.equal(await popup.locator('#history-search').isDisabled(), true);
    assert.equal(await popup.locator('.history-item').count(), 25, 'every saved prompt is still listed');
    assert.equal(await popup.getByLabel('Pin prompt', { exact: true }).count(), 0);
    assert.equal(await popup.getByLabel('Unpin prompt', { exact: true }).count(), 1);
    assert.equal(await popup.locator('[data-template-id]').count(), 0, 'no template chips');
    assert.equal(await popup.locator('#templates-block').isHidden(), true);
    await shot(popup, 'popup-free');

    // Settings: templates listed but not addable; history size capped with a note.
    const options = await openOptions();
    await options.locator('#templates-locked', { hasText: 'Custom templates are part of Pro. Templates you already made are kept.' }).waitFor();
    assert.equal(await options.locator('#add-template').isDisabled(), true);
    assert.equal(await options.locator('#import-templates').isDisabled(), true, 'importing is Pro');
    assert.equal(await options.locator('#export-templates').isDisabled(), false, 'your own templates can always be exported');
    assert.equal(await options.locator('.template-item').count(), 1);
    assert.equal(await options.locator('#max-history').inputValue(), '20');
    await options.locator('#max-history').fill('100');
    await options.locator('#max-history').blur();
    await options.locator('#history-limit', { hasText: 'Free keeps the last 20 prompts' }).waitFor();
    const storedSettings = async () => worker.evaluate(async () => (await chrome.storage.local.get('settings')).settings);
    await waitFor(async () => (await storedSettings()).maxHistoryItems === 20, 'setting capped at 20');
    assert.equal(await options.locator('#get-pro').isDisabled(), true);
    assert.equal(await options.locator('#get-pro').innerText(), 'Get Pro · $2.99');
    await shot(options, 'options-free');
    // Lowering the setting is the user's choice: unpinned prompts beyond it go, the pin stays.
    await waitFor(async () => (await history()).length === 20, 'history trimmed to 20, the pin included');
    assert.ok((await history()).some((item) => item.id === 'seed-10'), 'pinned prompt kept');
  } finally {
    await removeStorage(['e2eEarlyAccess']);
    await setSettings({ maxHistoryItems: 20 });
  }
  await waitForTemplateMenu([template.id]);
});

await test('About Pro card: price, features, disabled button during early access', async () => {
  const options = await openOptions();
  const card = options.locator('#pro');
  assert.equal(await options.locator('#pro-price').innerText(), '$2.99');
  assert.match(await card.innerText(), /Free during early access/);
  assert.match(await card.innerText(), /Custom templates[\s\S]*History up to 500[\s\S]*History search[\s\S]*Pinned favourites/);
  assert.match(await card.innerText(), /Template variables[\s\S]*Import and export templates/);
  assert.match(await card.innerText(), /secret masking, Copy & open/);
  assert.equal(await options.locator('#get-pro').isDisabled(), true);
  assert.equal(await options.locator('#get-pro').innerText(), 'Free during early access');
  assert.equal(await options.locator('#templates-locked').isHidden(), true);
  assert.equal(await options.locator('#templates .pro-badge').innerText(), 'PRO');
});

await test('panel: "Title & URL" is an icon toggle in the header and is remembered', async () => {
  await setSettings({ includePageContext: false });
  const page = await open('article.html');
  await resetClipboard(page);
  await select(page, '#article p:nth-of-type(3)');
  await menu(page, 'pastebot:make');
  await panel(page).waitFor();
  const toggle = inPanel(page, '.head [data-page-context]');
  assert.equal((await toggle.innerText()).trim(), 'Title & URL');
  assert.equal(await toggle.getAttribute('aria-pressed'), 'false');
  await toggle.click();
  assert.equal(await toggle.getAttribute('aria-pressed'), 'true');
  await waitFor(async () => (await settings()).includePageContext === true, 'setting saved');
  await inPanel(page, '[data-action="summarize"]').click();
  await done(page).waitFor();
  const text = await clipboard(page);
  assert.ok(text.includes('Page: Central bank raises rates again | Example News\nURL: http://news.example.com/article.html'), text);
  await setSettings({ includePageContext: false });
});

await test('masking: the panel masks secrets in a log, reviews them safely, and undo is for one prompt only', async () => {
  await setSettings({ maskSecrets: true, maskOff: [], includePageContext: false, openIn: 'chatgpt' });
  const page = await open('logs.html');
  await page.setViewportSize({ width: 1100, height: 820 });
  await resetClipboard(page);
  await select(page, '#log');
  await menu(page, 'pastebot:make');
  await panel(page).waitFor();
  // Before anything is made, the panel says what will be masked.
  assert.equal(
    await inPanel(page, '.mask-note').innerText(),
    'Masks 7 items: API key, JWT, email, phone number, card number, IP address, home path',
  );
  await page.keyboard.press('3');
  await done(page).waitFor();
  const masked = await clipboard(page);
  assert.ok(masked.startsWith('Explain the following'), masked);
  assertNoSecrets(masked, 'the copied prompt');
  for (const expected of [
    'for [EMAIL_1]',
    'api_key=[API_KEY_1]',
    'card=[CARD_1] amount=129.00 EUR ip=[IP_1] phone=[PHONE_1]',
    'Authorization: Bearer [JWT_1]',
    'at <HOME>/acme/checkout/server.js:120',
    'at com.example.payments.StripeClient.charge(StripeClient.java:88)',
  ]) {
    assert.ok(masked.includes(expected), `prompt has ${expected}`);
  }
  // History keeps the masked prompt, and its preview is masked too.
  const [saved] = await history();
  assertNoSecrets(JSON.stringify(saved), 'history');
  assert.ok(saved.preview.includes('[EMAIL_1]'), saved.preview);

  // "7 items masked" → Review lists category, a safe preview and the placeholder.
  assert.equal(await inPanel(page, '.mask-summary').innerText(), '7 items masked');
  const toggle = inPanel(page, '.mask-toggle');
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
  await toggle.click();
  await inPanel(page, '.mask-list').waitFor();
  assert.equal(await inPanel(page, '.mask-toggle').getAttribute('aria-expanded'), 'true');
  const rows = await inPanel(page, '.mask-list li').evaluateAll((items) =>
    items.map((item) => [...item.children].map((child) => child.textContent).join(' | ')),
  );
  assert.deepEqual(rows, [
    'API key | sk-proj-…9fQ2 | [API_KEY_1]',
    'JWT | eyJ…sw5c | [JWT_1]',
    'Email | a…@example.com | [EMAIL_1]',
    'Phone | …0132 | [PHONE_1]',
    'Card | …4242 | [CARD_1]',
    'IP address | 203.… | [IP_1]',
    'Home path | /Users/a… | <HOME>',
  ]);
  assertNoSecrets(await panel(page).innerText(), 'the panel');
  // Something was masked, so the panel waits for the user instead of closing by itself. This
  // checks that nothing happens, so it has to wait out the auto-close delay (4 s).
  await page.waitForTimeout(4500);
  assert.equal(await panel(page).isVisible(), true);
  await shot(page, 'mask-review');

  // Undo masking for this prompt: the original is copied once, history keeps the masked prompt.
  const historyBefore = await history();
  await inPanel(page, '[data-undo-mask]').click();
  await inPanel(page, '.mask-review.undone').waitFor();
  const original = await clipboard(page);
  assert.ok(original.includes('anna.kowalski@example.com') && original.includes('4242 4242 4242 4242'), original);
  assert.match(await inPanel(page, '.mask-review.undone').innerText(), /Masking undone for this prompt[\s\S]*History keeps the masked one/);
  assert.deepEqual(await history(), historyBefore, 'undo never touches history');
  // Mask again.
  await inPanel(page, '[data-mask-again]').click();
  await inPanel(page, '.mask-summary', { hasText: '7 items masked' }).waitFor();
  assert.equal(await clipboard(page), masked);
});

await test('masking: menu actions and the shortcut mask too; settings turn categories or masking off', async () => {
  const page = await open('logs.html');
  await resetClipboard(page);
  await select(page, '#log');
  await menu(page, 'pastebot:action:summarize');
  await toast(page).filter({ hasText: 'Summarize prompt copied, 7 items masked' }).waitFor();
  assertNoSecrets(await clipboard(page), 'menu action');

  await resetClipboard(page);
  await select(page, '#log');
  await shortcut(page);
  await panel(page).waitFor();
  await page.keyboard.press('4');
  await done(page).waitFor();
  assertNoSecrets(await clipboard(page), 'shortcut');
  await page.keyboard.press('Escape');

  // Settings: one category off. "Try it" runs the real masker with the settings.
  const options = await openOptions();
  assert.equal(await options.locator('#mask-secrets').isChecked(), true);
  assert.equal(await options.locator('#mask-categories input').count(), 10);
  await options.locator('#masking summary').click();
  assert.ok((await options.locator('#mask-try-output').innerText()).includes('[EMAIL_1]'));
  await options.locator('#mask-email').uncheck();
  await waitFor(async () => JSON.stringify((await settings()).maskOff) === '["email"]', 'email masking off');
  await options.locator('#mask-try-output', { hasText: 'anna.kowalski@example.com' }).waitFor();
  await options.locator('#mask-try-input').fill('Call me at +1 415 555 0132 or write to ops@example.com');
  assert.equal(await options.locator('#mask-try-output').innerText(), 'Call me at [PHONE_1] or write to ops@example.com');
  assert.equal(await options.locator('#mask-try-summary').innerText(), '1 item masked.');
  await shot(options, 'options-masking');

  await resetClipboard(page);
  await select(page, '#log');
  await menu(page, 'pastebot:action:summarize');
  await toast(page).filter({ hasText: '6 items masked' }).waitFor();
  let text = await clipboard(page);
  assert.ok(text.includes('anna.kowalski@example.com') && text.includes('[CARD_1]'), text);

  // Masking off: prompts keep every value, the toast says nothing about masking.
  await options.locator('#mask-secrets').uncheck();
  await waitFor(async () => (await settings()).maskSecrets === false, 'masking off');
  assert.equal(await options.locator('#mask-card').isDisabled(), true);
  await resetClipboard(page);
  await select(page, '#log');
  await menu(page, 'pastebot:action:summarize');
  await waitFor(async () => (await clipboard(page)) !== '<empty>', 'prompt copied');
  text = await clipboard(page);
  for (const secret of LOG_SECRETS) assert.ok(text.includes(secret), `kept ${secret}`);
  assert.doesNotMatch(await toast(page).innerText(), /masked/);

  await options.locator('#mask-secrets').check();
  await options.locator('#mask-email').check();
  await waitFor(async () => {
    const current = await settings();
    return current.maskSecrets === true && current.maskOff.length === 0;
  }, 'masking back on');
});

await test('masking: the popup notes, reviews and undoes; edits to an unmasked prompt never reach history', async () => {
  const logs = await open('logs.html');
  const log = await logs.locator('#log').innerText();
  const popup = await openPopup();
  await popup.locator('#input').fill(log);
  await popup.locator('#mask-note', { hasText: 'Masks 7 items: API key, JWT, email' }).waitFor();
  await popup.locator('[data-action="explain"]').click();
  await popup.locator('#copy-status', { hasText: 'Copied!' }).waitFor();
  assertNoSecrets(await popup.locator('#output').inputValue(), 'popup prompt');
  assertNoSecrets(await clipboard(popup), 'popup clipboard');
  assert.equal(await popup.locator('#mask-note').isHidden(), true, 'the note gives way to the review');
  assert.equal(await popup.locator('#mask-review-slot .mask-summary').innerText(), '7 items masked');
  await popup.locator('#mask-review-slot .mask-toggle').click();
  assert.equal(await popup.locator('#mask-review-slot .mask-list li').count(), 7);

  await popup.locator('[data-undo-mask]').click();
  await popup.waitForFunction(() => document.getElementById('output').value.includes('anna.kowalski@example.com'));
  await popup.locator('#copy-status', { hasText: 'Copied without masking.' }).waitFor();
  const unmasked = await popup.locator('#output').inputValue();
  await popup.locator('#output').fill(`${unmasked}\n\nThanks!`);
  await popup.locator('#copy').click();
  await waitFor(async () => (await clipboard(popup)).endsWith('Thanks!'), 'edited prompt copied');
  const [saved] = await history();
  assertNoSecrets(JSON.stringify(saved), 'history after undo and edit');
  assert.ok(!saved.prompt.endsWith('Thanks!'));
});

await test('copy & open: the panel opens ChatGPT with the prompt, remembers Claude, keyboard picks Gemini', async () => {
  await setSettings({ openIn: 'chatgpt' });
  const page = await open('article.html');
  await resetClipboard(page);
  await select(page, '#article p:nth-of-type(3)');
  await menu(page, 'pastebot:make');
  await panel(page).waitFor();
  await page.keyboard.press('2');
  await done(page).waitFor();
  const prompt = await clipboard(page);
  assert.equal((await inPanel(page, '[data-copy]').innerText()).trim(), 'Copy');
  assert.equal((await inPanel(page, '[data-open]').innerText()).trim(), 'Copy & open ChatGPT');
  assert.equal(await inPanel(page, '.open-hint').innerText(), 'ChatGPT opens with the prompt filled in.');
  await resetClipboard(page);
  await inPanel(page, '[data-open]').click();
  const url = await openedTab('https://chatgpt.com/');
  assert.equal(new URL(url).searchParams.get('q'), prompt, 'the prompt is in the address');
  assert.equal(await clipboard(page), prompt, 'and on the clipboard');
  await inPanel(page, '.status', { hasText: 'Opened ChatGPT with the prompt.' }).waitFor();

  // ▾ lists the destinations; the choice is remembered.
  await inPanel(page, '.btn-caret').click();
  await inPanel(page, '.dest-menu').waitFor();
  assert.deepEqual(await inPanel(page, '.dest-item .dest-name').allInnerTexts(), ['ChatGPT', 'Perplexity', 'Claude', 'Gemini']);
  assert.equal(await inPanel(page, '[data-destination="chatgpt"]').getAttribute('aria-checked'), 'true');
  await shot(page, 'open-menu');
  await inPanel(page, '[data-destination="claude"]').click();
  await waitFor(async () => (await settings()).openIn === 'claude', 'Claude remembered');
  assert.equal((await inPanel(page, '[data-open]').innerText()).trim(), 'Copy & open Claude');
  assert.equal(await inPanel(page, '.open-hint').innerText(), 'Claude opens in a new tab. Press Ctrl+V to paste.');
  await inPanel(page, '[data-open]').click();
  assert.equal(await openedTab('https://claude.ai/'), 'https://claude.ai/new');
  await inPanel(page, '.status', { hasText: 'Opened Claude. Paste the prompt there.' }).waitFor();

  // Keyboard: arrows move in the menu, Enter picks, Escape closes it.
  await inPanel(page, '.btn-caret').focus();
  await page.keyboard.press('ArrowDown');
  await inPanel(page, '.dest-menu').waitFor();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await waitFor(async () => (await settings()).openIn === 'gemini', 'Gemini picked with the keyboard');
  assert.equal(await inPanel(page, '.dest-menu').isHidden(), true);
  await inPanel(page, '.btn-caret').click();
  await page.keyboard.press('Escape');
  assert.equal(await inPanel(page, '.dest-menu').isHidden(), true);
  assert.equal(await panel(page).isVisible(), true, 'Escape closes the menu, not the panel');

  // Next time the panel opens, the choice is still there.
  await page.keyboard.press('Escape');
  await select(page, '#article p:nth-of-type(3)');
  await menu(page, 'pastebot:make');
  await panel(page).waitFor();
  await page.keyboard.press('1');
  await done(page).waitFor();
  assert.equal((await inPanel(page, '[data-open]').innerText()).trim(), 'Copy & open Gemini');
  await setSettings({ openIn: 'chatgpt' });
});

await test('copy & open: the popup opens Perplexity; a prompt too long for an address opens ChatGPT to paste', async () => {
  await setSettings({ openIn: 'chatgpt' });
  const popup = await openPopup();
  await popup.locator('#input').fill('Postgres is relational. MongoDB stores documents.');
  await popup.locator('[data-action="compare"]').click();
  await popup.locator('#copy-status', { hasText: 'Copied!' }).waitFor();
  await popup.locator('#split-slot .btn-caret').click();
  await popup.locator('#split-slot [data-destination="perplexity"]').click();
  await waitFor(async () => (await settings()).openIn === 'perplexity', 'Perplexity remembered');
  const prompt = await popup.locator('#output').inputValue();
  await popup.locator('#split-slot [data-open]').click();
  const url = await openedTab('https://www.perplexity.ai/');
  assert.equal(new URL(url).searchParams.get('q'), prompt);

  const long = await openPopup();
  await long.locator('#input').fill('word '.repeat(1_500));
  await long.locator('[data-action="summarize"]').click();
  await long.locator('#copy-status', { hasText: 'Copied!' }).waitFor();
  await long.locator('#split-slot .btn-caret').click();
  await long.locator('#split-slot [data-destination="chatgpt"]').click();
  assert.equal(await long.locator('#split-slot .open-hint').innerText(), 'Too long to fill in: ChatGPT opens, press Ctrl+V to paste.');
  await long.locator('#split-slot [data-open]').click();
  assert.equal(await openedTab('https://chatgpt.com/'), 'https://chatgpt.com/');
  assert.ok((await clipboard(long)).startsWith('Summarize the following content.'), 'copied before opening');
});

await test('translate: built-in action 7, the menu names the language, settings pick the target', async () => {
  await setSettings({ translateTo: '' });
  await waitFor(async () => (await menuTitles())['pastebot:action:translate'] === 'Translate to English', 'menu follows the browser language');
  const ids = await menuIds();
  assert.equal(ids.indexOf('pastebot:action:translate'), ids.indexOf('pastebot:action:rewrite') + 1);

  const options = await openOptions();
  assert.equal(await options.locator('#translate-to option[value=""]').innerText(), 'Browser language (English)');
  await options.locator('#translate-to').selectOption('uk');
  await waitFor(async () => (await menuTitles())['pastebot:action:translate'] === 'Translate to Ukrainian', 'menu follows the setting');

  const page = await open('article.html');
  await resetClipboard(page);
  await select(page, '#article p:nth-of-type(3)');
  await menu(page, 'pastebot:make');
  await panel(page).waitFor();
  assert.match(await inPanel(page, '[data-action="translate"]').getAttribute('title'), /Translate to Ukrainian/);
  await page.keyboard.press('7');
  await done(page).waitFor();
  let text = await clipboard(page);
  assert.ok(text.startsWith('Translate the following content into Ukrainian.\n\nKeep the meaning, tone and formatting'), text);
  assert.ok(text.endsWith('Return only the translation.'), text);

  await resetClipboard(page);
  await select(page, '#article p:nth-of-type(3)');
  await menu(page, 'pastebot:action:translate');
  await toast(page).filter({ hasText: 'Translate prompt copied' }).waitFor();
  text = await clipboard(page);
  assert.ok(text.startsWith('Translate the following content into Ukrainian.'), text);

  // Translate can be the default action.
  await options.bringToFront();
  await options.locator('#default-action').selectOption('translate');
  await waitFor(async () => (await settings()).defaultAction === 'translate', 'default action saved');
  await options.locator('#translate-to').selectOption('');
  await waitFor(async () => (await settings()).translateTo === '', 'back to the browser language');
  await options.locator('#default-action').selectOption('analyze');
  await waitFor(async () => (await settings()).defaultAction === 'analyze', 'default action restored');
});

await test('template variables: the panel asks for {{values}} and fills {title} and {date}; menu and popup too', async () => {
  const today = (() => {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  })();
  const existing = await templates();
  const brief = { id: 'vars', name: 'Brief for an audience', instruction: 'Explain {content} to {{Audience}} in {{Language=English}}. Source: “{title}”, {date}.' };
  await setStorage({ customTemplates: [brief, ...existing] });
  await waitForTemplateMenu(['vars', ...existing.map((template) => template.id)]);

  const page = await open('article.html');
  await resetClipboard(page);
  await select(page, '#article p:nth-of-type(3)');
  await menu(page, 'pastebot:make');
  await panel(page).waitFor();
  const chip = inPanel(page, '[data-template-id="vars"]');
  assert.equal((await chip.innerText()).replace(/\s+/g, ' ').trim(), '9 Brief for an audience…');
  assert.match(await chip.getAttribute('title'), /asks for Audience, Language/);
  await page.keyboard.press('9');
  await inPanel(page, 'form.variables').waitFor();
  assert.equal(await inPanel(page, '[data-variable="Audience"]').inputValue(), '');
  assert.equal(await inPanel(page, '[data-variable="Language"]').inputValue(), 'English');
  await shot(page, 'panel-variables');
  await page.keyboard.press('Enter');
  await inPanel(page, '.status.error', { hasText: 'Fill in Audience.' }).waitFor();
  await inPanel(page, '[data-variable="Audience"]').fill('our sales team');
  await page.keyboard.press('Enter');
  await done(page).waitFor();
  const text = await clipboard(page);
  assert.equal(
    text,
    `Explain\n"""\nThe central bank raised its key rate by 25 basis points to 5.25% on Tuesday, its third increase this year. Governor Marek Nowak said inflation, at 6.1% in February, remained well above the 2% target.\n"""\nto our sales team in English. Source: “Central bank raises rates again | Example News”, ${today}.`,
  );
  assert.equal((await history())[0].templateName, 'Brief for an audience');

  // From the context menu, a template with variables opens the panel with its form.
  await page.keyboard.press('Escape');
  await select(page, '#article p:nth-of-type(3)');
  await menu(page, 'pastebot:template:vars');
  await inPanel(page, 'form.variables').waitFor();
  await page.keyboard.press('Escape');
  await inPanel(page, '[data-action="analyze"]').waitFor();

  // Popup: the chip shows the same form.
  const popup = await openPopup();
  await popup.locator('#input').fill('Revenue grew 18% in Q3.');
  await popup.locator('[data-template-id="vars"]').click();
  await popup.locator('#variables-form').waitFor();
  await popup.locator('#make-variables').click();
  await popup.locator('#error', { hasText: 'Fill in Audience.' }).waitFor();
  await popup.locator('#variables-form [data-variable="Audience"]').fill('developers');
  await popup.locator('#variables-form [data-variable="Language"]').fill('Polish');
  await popup.locator('#make-variables').click();
  await popup.waitForFunction(() => document.getElementById('output').value.includes('to developers in Polish. Source: “”,'));
  await setStorage({ customTemplates: existing });
  await waitForTemplateMenu(existing.map((template) => template.id));
});

await test('template editor: variable chips insert at the cursor; import and export as JSON', async () => {
  const options = await openOptions();
  await options.locator('#add-template').click();
  assert.deepEqual(await options.locator('#variable-chips .variable-chip').allInnerTexts(), ['{content}', '{title}', '{url}', '{date}', '{{Variable}}']);
  const field = options.locator('#template-instruction');
  await options.locator('#template-name').fill('Chip test');
  await field.fill('Summarize  for ');
  await field.evaluate((element) => element.setSelectionRange(10, 10));
  await options.locator('[data-insert="{content}"]').click();
  assert.equal(await field.inputValue(), 'Summarize {content} for ');
  await field.evaluate((element) => element.setSelectionRange(element.value.length, element.value.length));
  await options.locator('[data-insert="{{Variable}}"]').click();
  // The name is selected, so typing replaces it.
  await options.keyboard.type('Audience');
  await options.keyboard.press('End');
  await options.keyboard.type(' (source: ');
  await options.locator('[data-insert="{title}"]').click();
  await options.keyboard.type(')');
  assert.equal(await field.inputValue(), 'Summarize {content} for {{Audience}} (source: {title})');
  assert.equal(await options.locator('#template-asks').innerText(), 'Asks when you run it: Audience.');
  await options.waitForFunction(() => document.getElementById('template-preview').textContent.endsWith('for [Audience] (source: Q3 results · Acme Blog)'));
  await options.locator('#save-template').click();
  await waitFor(async () => (await templates()).some((template) => template.name === 'Chip test'), 'template saved');

  // Export: a JSON file with names and instructions (no ids).
  const [download] = await Promise.all([options.waitForEvent('download'), options.locator('#export-templates').click()]);
  assert.match(download.suggestedFilename(), /^pastebot-templates-\d{4}-\d{2}-\d{2}\.json$/);
  const exported = JSON.parse(await readFile(await download.path(), 'utf8'));
  assert.equal(exported.format, 'pastebot-templates');
  assert.deepEqual(exported.templates.map((template) => template.name), (await templates()).map((template) => template.name));
  assert.ok(exported.templates.every((template) => Object.keys(template).join() === 'name,instruction'));

  // Import: same-named templates are updated in place, new ones added, broken ones skipped.
  const importPath = join(outputDir, 'import.json');
  await writeFile(
    importPath,
    JSON.stringify({
      format: 'pastebot-templates',
      version: 1,
      templates: [
        { name: 'chip TEST', instruction: 'Summarize {content} in three bullets for {{Audience=my team}}.' },
        { name: 'Standup notes', instruction: 'Turn {content} into standup notes for the {{Team=Platform}} team.' },
        { name: 'Broken', instruction: 'Hello {{Oops' },
      ],
    }),
  );
  const before = await templates();
  await options.locator('#import-file').setInputFiles(importPath);
  await options.locator('#import-status.alert-success', { hasText: 'Imported 2 templates: 1 new, 1 updated. 1 skipped' }).waitFor();
  const after = await templates();
  assert.equal(after.length, before.length + 1);
  const chipTest = after.find((template) => template.name === 'Chip test');
  assert.equal(chipTest.id, before.find((template) => template.name === 'Chip test').id, 'updated in place');
  assert.equal(chipTest.instruction, 'Summarize {content} in three bullets for {{Audience=my team}}.');
  const standup = after.find((template) => template.name === 'Standup notes');
  await waitForTemplateMenu(after.map((template) => template.id));
  assert.ok(standup);

  await writeFile(importPath, 'not json at all');
  await options.locator('#import-file').setInputFiles(importPath);
  await options.locator('#import-status.alert-danger', { hasText: "This file isn't valid JSON." }).waitFor();
  assert.equal((await templates()).length, after.length, 'a bad file changes nothing');
  await setStorage({ customTemplates: before.filter((template) => template.name !== 'Chip test') });
});

await test('popup: tabs, number keys and the Title & URL toggle', async () => {
  await setSettings({ includePageContext: false });
  const popup = await openPopup();
  assert.equal(await popup.locator('#tab-compose').getAttribute('aria-selected'), 'true');
  assert.equal(await popup.locator('#panel-history').isHidden(), true);
  // Keyboard: arrows move between the tabs.
  await popup.locator('#tab-compose').focus();
  await popup.keyboard.press('ArrowRight');
  assert.equal(await popup.locator('#tab-history').getAttribute('aria-selected'), 'true');
  assert.equal(await popup.evaluate(() => document.activeElement?.id), 'tab-history');
  await popup.keyboard.press('ArrowLeft');
  assert.equal(await popup.locator('#panel-compose').isVisible(), true);

  // Without a page there is no title or URL to add.
  assert.equal(await popup.locator('#context-toggle').isDisabled(), true);
  await popup.locator('#input').fill('Revenue grew 18% in Q3, churn fell to 2.9%.');
  // Number keys pick chips when the focus is not in a text field (same numbers as the panel).
  await popup.locator('#tab-compose').focus();
  await popup.keyboard.press('2');
  await popup.waitForFunction(() => document.getElementById('output').value.startsWith('Summarize the following content.'));
  assert.equal(await popup.locator('[data-action="summarize"]').getAttribute('aria-pressed'), 'true');
  // Typing digits in the text field stays typing.
  await popup.locator('#input-summary').click();
  await popup.locator('#input').press('End');
  await popup.keyboard.type(' 7');
  assert.ok((await popup.locator('#input').inputValue()).endsWith('2.9%. 7'));
  assert.ok((await popup.locator('#output').inputValue()).startsWith('Summarize'), 'no action ran');
});

await test('no network requests leave the extension', async () => {
  const requests = [];
  const listener = (request) => {
    const url = request.url();
    if (!FIXTURE_ORIGINS.some((origin) => url.startsWith(origin)) && !url.startsWith('chrome-extension://') && !url.startsWith('data:')) {
      requests.push(url);
    }
  };
  context.on('request', listener);
  const page = await open('article.html');
  await select(page, '#article');
  await menu(page, 'pastebot:action:analyze');
  await toast(page).waitFor();
  context.off('request', listener);
  assert.deepEqual(requests, []);
  await page.close();
});

await test('curated screenshots for the README (light and dark)', async () => {
  const dir = join(root, 'screenshots');
  await mkdir(dir, { recursive: true });
  const settle = (page) => page.waitForTimeout(250);
  await setSettings({
    includePageContext: false,
    promptStyle: 'balanced',
    defaultAction: 'analyze',
    maxHistoryItems: 20,
    maskSecrets: true,
    maskOff: [],
    openIn: 'chatgpt',
    translateTo: '',
  });
  const shotTemplates = [
    {
      id: 'shot-junior',
      name: 'Explain to a junior dev',
      instruction: 'Explain this to a junior developer on my team. Use plain words and one short example.',
    },
    {
      id: 'shot-bug',
      name: 'Draft a bug report',
      instruction: 'Write a bug report for this, with steps to reproduce, expected and actual behavior:\n\n{content}',
    },
    {
      id: 'shot-brief',
      name: 'Brief for an audience',
      instruction: 'Summarize {content} for {{Audience}} in {{Language=English}}.\nSource: “{title}” ({url}), {date}.',
    },
  ];
  await setStorage({ customTemplates: shotTemplates });
  await waitForTemplateMenu(shotTemplates.map((template) => template.id));
  const minutes = (n) => Date.now() - n * 60_000;
  const shotHistory = [
    {
      id: 'shot-h1',
      timestamp: minutes(3),
      action: 'explain',
      prompt: 'Explain the following Java error.\n\nError:\n```\nNullPointerException: Cannot invoke "String.length()"\n```',
      pageTitle: 'NullPointerException when validating a user',
      pageUrl: 'https://qa.example.com/questions/218384',
      preview: 'Exception in thread "main" java.lang.NullPointerException',
      pinned: true,
    },
    {
      id: 'shot-h2',
      timestamp: minutes(18),
      action: 'custom',
      templateName: 'Draft a bug report',
      prompt: 'Write a bug report for this, with steps to reproduce, expected and actual behavior:\n\nError: 502 Bad Gateway on /checkout',
      pageTitle: 'Checkout fails with 502 · Issue #412',
      pageUrl: 'https://code.example.org/acme/shop/issues/412',
      preview: 'Error: 502 Bad Gateway on /checkout after applying a coupon',
    },
    {
      id: 'shot-h3',
      timestamp: minutes(41),
      action: 'explain',
      prompt: 'Explain the following error.\n\nError:\n```\nChargeFailedException: card_declined for [EMAIL_1]\n```',
      pageTitle: 'Charges fail with 402 · Troubleshooting · Acme Pay Docs',
      pageUrl: 'https://docs.example.com/payments/troubleshooting',
      preview: 'ERROR [payments] ChargeFailedException: card_declined for [EMAIL_1] api_key=[API_KEY_1]',
    },
    {
      id: 'shot-h4',
      timestamp: minutes(75),
      action: 'summarize',
      prompt: 'Summarize the following content.\n\nContent:\nThe central bank raised its key rate to 5.25%.',
      pageTitle: 'Central bank raises rates again',
      pageUrl: 'https://news.example.com/economy/rates',
      preview: 'The central bank raised its key rate by 25 basis points to 5.25%',
    },
    {
      id: 'shot-h5',
      timestamp: minutes(60 * 26),
      action: 'translate',
      prompt: 'Translate the following content into English.\n\nContent:\nSenior Java Developer, Kraków, hybrid',
      pageTitle: 'Senior Java Developer · Acme Jobs',
      pageUrl: 'https://jobs.example.com/4411',
      preview: 'Starszy programista Java, Kraków, praca hybrydowa. Wynagrodzenie 25 000 – 32 000 PLN',
    },
  ];

  for (const scheme of ['light', 'dark']) {
    await setStorage({ history: shotHistory });
    // In-page panel next to a selection.
    const trace = await open('stackoverflow.html');
    // Tall enough for the panel (with three templates) to open below the selection.
    await trace.setViewportSize({ width: 1100, height: 760 });
    await trace.emulateMedia({ colorScheme: scheme });
    await select(trace, '#trace');
    await menu(trace, 'pastebot:make');
    await panel(trace).waitFor();
    await settle(trace);
    await trace.screenshot({ path: join(dir, `panel-${scheme}.png`) });
    await trace.keyboard.press('3');
    await done(trace).waitFor();
    await trace.mouse.move(600, 150);
    await settle(trace);
    await trace.screenshot({ path: join(dir, `copied-${scheme}.png`) });
    await trace.close();

    // Secrets masked in a log: the review is open.
    const logs = await open('logs.html');
    // Tall enough for the panel, with the review open, to sit below the log instead of over it.
    await logs.setViewportSize({ width: 1100, height: 920 });
    await logs.emulateMedia({ colorScheme: scheme });
    await select(logs, '#log');
    await menu(logs, 'pastebot:make');
    await panel(logs).waitFor();
    await logs.keyboard.press('3');
    await done(logs).waitFor();
    await inPanel(logs, '.mask-toggle').click();
    await inPanel(logs, '.mask-list').waitFor();
    await logs.mouse.move(900, 60);
    await settle(logs);
    await logs.screenshot({ path: join(dir, `mask-${scheme}.png`) });
    await logs.close();

    // Popup: compose with a result (an email in the text is masked).
    await setStorage({ history: shotHistory });
    const popup = await newPage();
    await popup.setViewportSize({ width: 380, height: 600 });
    await popup.emulateMedia({ colorScheme: scheme });
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await popup.locator('#input').fill(
      'Our Q3 revenue grew 18% to $4.2M, driven by the EU launch. Churn rose to 3.1%. Questions to finance@acme-corp.example.',
    );
    await popup.locator('[data-action="summarize"]').click();
    await popup.waitForFunction(() => document.getElementById('output').value.startsWith('Summarize'));
    await popup.locator('#output').blur();
    await settle(popup);
    await popup.screenshot({ path: join(dir, `popup-${scheme}.png`) });
    await popup.close();

    // Settings page.
    const options = await newPage();
    await options.setViewportSize({ width: 900, height: 980 });
    await options.emulateMedia({ colorScheme: scheme });
    await options.goto(`chrome-extension://${extensionId}/options.html`);
    await options.locator('#shortcut', { hasText: 'Alt+P' }).waitFor();
    await options.locator('.template-item').nth(2).waitFor();
    await settle(options);
    await options.screenshot({ path: join(dir, `options-${scheme}.png`), fullPage: true });

    // Mask secrets card with "Try it" open.
    await options.locator('#masking summary').click();
    await options.locator('#mask-try-output', { hasText: '[EMAIL_1]' }).waitFor();
    await settle(options);
    await options.locator('#masking').screenshot({ path: join(dir, `masking-${scheme}.png`) });

    // Template editor with the variable chips and the live preview.
    await options.locator('.template-item[data-id="shot-brief"]').getByLabel('Edit: Brief for an audience').click();
    await options.waitForFunction(() => document.getElementById('template-preview').textContent.startsWith('Summarize\n"""'));
    await options.locator('#template-instruction').blur();
    await settle(options);
    await options.locator('#templates').screenshot({ path: join(dir, `templates-${scheme}.png`) });
    await options.close();

    // History tab with a pin, a template prompt and a search.
    await setStorage({ history: shotHistory });
    const recent = await newPage();
    await recent.setViewportSize({ width: 380, height: 540 });
    await recent.emulateMedia({ colorScheme: scheme });
    await recent.goto(`chrome-extension://${extensionId}/popup.html`);
    await recent.locator('#tab-history').click();
    await recent.locator('.history-item').nth(4).waitFor();
    await recent.locator('#history-search').fill('error');
    await recent.waitForFunction(() => document.querySelectorAll('.history-item').length === 3);
    await recent.locator('#history-search').blur();
    await settle(recent);
    await recent.screenshot({ path: join(dir, `history-${scheme}.png`) });
    await recent.close();
  }

  // Template variables asked for in the panel, and the "Copy & open" menu.
  const article = await open('article.html');
  await article.setViewportSize({ width: 1100, height: 700 });
  await select(article, '#article p:nth-of-type(3)');
  await menu(article, 'pastebot:make');
  await panel(article).waitFor();
  await inPanel(article, '[data-template-id="shot-brief"]').click();
  await inPanel(article, 'form.variables').waitFor();
  await article.keyboard.type('the sales team');
  await article.mouse.move(900, 100);
  await settle(article);
  await article.screenshot({ path: join(dir, 'variables-light.png') });
  await article.keyboard.press('Enter');
  await done(article).waitFor();
  await inPanel(article, '.btn-caret').click();
  await inPanel(article, '.dest-menu').waitFor();
  await settle(article);
  await article.screenshot({ path: join(dir, 'open-menu-light.png') });
  await article.keyboard.press('Escape');
  await article.keyboard.press('Escape');

  // Toast after a direct context-menu action, and the too-long warning.
  await article.setViewportSize({ width: 1100, height: 640 });
  await select(article, '#article');
  await menu(article, 'pastebot:action:summarize');
  await toast(article).waitFor();
  await settle(article);
  await article.screenshot({ path: join(dir, 'toast-light.png') });
  const big = await open('big.html');
  await big.setViewportSize({ width: 1100, height: 640 });
  await select(big, '#big');
  await menu(big, 'pastebot:make');
  await big.locator('pastebot-overlay .headline.warn').waitFor();
  await settle(big);
  await big.screenshot({ path: join(dir, 'too-long-light.png') });
});

// --- Summary ----------------------------------------------------------------------------

await context.close();
server.close();
await rm(userDataDir, { recursive: true, force: true });

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed. Screenshots: ${outputDir}`);
process.exit(failed.length ? 1 : 0);
