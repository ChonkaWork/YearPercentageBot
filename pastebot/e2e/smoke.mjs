// End-to-end smoke test: loads the e2e build (dist-e2e/) into a real Chromium and drives
// every user flow against local fixture pages.
//
//   npm run test:e2e                      (set CHROMIUM_PATH if Chromium isn't auto-detected)
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
const base = `http://127.0.0.1:${server.address().port}`;

// --- Browser ----------------------------------------------------------------------------

await mkdir(outputDir, { recursive: true });
const userDataDir = await mkdtemp(join(tmpdir(), 'pastebot-e2e-'));
const context = await chromium.launchPersistentContext(userDataDir, {
  executablePath: findChromium(),
  headless,
  viewport: { width: 1280, height: 800 },
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

async function open(name, query = '') {
  const page = await newPage();
  await page.goto(`${base}/${name}${query}`);
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
    if (await check()) return;
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

const panel = (page) => page.locator('pastebot-overlay .card');
const toast = (page) => page.locator('pastebot-overlay .toast');
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
  assert.ok(text.includes(`URL: ${base}/article.html?id=7\n`), text);
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
  await page.keyboard.press('7');
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
  await page.locator('#action').selectOption('explain');
  await page.locator('#make').click();
  await page.locator('#copy-status', { hasText: 'Copied!' }).waitFor();
  const output = await page.locator('#output').inputValue();
  assert.ok(output.startsWith('Explain the following Java error.'), output);
  await shot(page, 'popup-result');

  // Edit before copying: the history entry is updated too.
  await page.locator('#output').fill(`${output}\n\nAnswer in Ukrainian.`);
  await page.locator('#copy').click();
  await waitFor(async () => (await history())[0]?.prompt.endsWith('Answer in Ukrainian.'), 'history entry updated after edit');
  assert.ok((await clipboard(page)).endsWith('Answer in Ukrainian.'));

  // Custom action and the too-large path.
  await page.locator('#action').selectOption('custom');
  await page.locator('#instruction').fill('');
  await page.locator('#make').click();
  await page.locator('#error', { hasText: 'Write what the AI should do' }).waitFor();
  await page.locator('#input').fill('x '.repeat(60_000));
  await page.locator('#instruction').fill('Count the words.');
  await page.locator('#make').click();
  await page.locator('#trim').waitFor();
  await page.locator('#trim').click();
  assert.ok((await page.locator('#input').inputValue()).length <= 100_000);
  await page.locator('#make').click();
  await page.waitForFunction(() => document.getElementById('output').value.startsWith('Count the words.'));
  await waitFor(async () => (await history())[0]?.prompt.startsWith('Count the words.'), 'custom prompt saved');

  // Delete one, then clear all (two clicks).
  const stored = (await history()).length;
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
  await page.waitForFunction(() => document.getElementById('max-history').value === '50');
  assert.match(await page.locator('.privacy').innerText(), /does not send your selected text or browsing data to a remote server/);
  // Suggested shortcut actually got assigned (Chrome silently drops conflicting ones, e.g. Ctrl+Shift+P).
  assert.equal(await page.locator('#shortcut').innerText(), 'Alt+P');
  await shot(page, 'options');
  const settings = await worker.evaluate(async () => (await chrome.storage.local.get('settings')).settings);
  assert.equal(settings.promptStyle, 'concise');
  assert.equal(settings.defaultAction, 'explain');
  assert.equal(settings.maxHistoryItems, 50);

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

await test('no network requests leave the extension', async () => {
  const requests = [];
  const listener = (request) => {
    if (!request.url().startsWith(base) && !request.url().startsWith('chrome-extension://') && !request.url().startsWith('data:')) {
      requests.push(request.url());
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

// --- Summary ----------------------------------------------------------------------------

await context.close();
server.close();
await rm(userDataDir, { recursive: true, force: true });

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed. Screenshots: ${outputDir}`);
process.exit(failed.length ? 1 : 0);
