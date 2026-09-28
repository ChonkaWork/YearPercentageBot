// End-to-end smoke test: loads the e2e build (dist-e2e/) into a real Chromium and drives every
// user flow against local fixture pages that replicate ChatGPT's and Claude's DOM.
//
//   npm run test:e2e                      (set CHROMIUM_PATH if Chromium isn't auto-detected)
//
// chatgpt.com and claude.ai are never contacted. The e2e build additionally runs the content
// script on http://127.0.0.1/*, where /chatgpt/… and /claude/… pages are served from e2e/fixtures.

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
const fixtures = join(root, 'e2e/fixtures');
const outputDir = join(root, 'e2e/output');
const screenshotsDir = join(root, 'screenshots');
const headless = process.env.HEADED !== '1';

const CHATGPT_ID = '6710aa01-1111-4000-8000-000000000001';
const LVIV_ID = '6710aa02-2222-4000-8000-000000000002';
const CLAUDE_ID = '0f3c2a9e-5b1d-4c8e-9a77-2d4e6f8a1b2c';

function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const candidates = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  const found = candidates.find((path) => existsSync(path));
  if (!found) throw new Error('Chromium not found. Set CHROMIUM_PATH.');
  return found;
}

// --- Fixture server ---------------------------------------------------------------------

function fixtureFor(pathname) {
  if (pathname === '/fixture.css') return ['fixture.css', 'text/css'];
  if (pathname.startsWith('/files/')) return [join('..', '..', 'static/icons/icon128.png'), 'image/png'];
  if (pathname === '/plain.html') return ['plain.html', 'text/html'];
  if (/^\/chatgpt\/?$/.test(pathname)) return ['chatgpt-home.html', 'text/html'];
  if (pathname.startsWith('/chatgpt/c/stream-')) return ['chatgpt-streaming.html', 'text/html'];
  if (pathname.startsWith('/chatgpt/c/broken-')) return ['chatgpt-broken.html', 'text/html'];
  if (pathname.startsWith('/chatgpt/c/')) return ['chatgpt.html', 'text/html'];
  if (pathname.startsWith('/claude/chat/')) return ['claude.html', 'text/html'];
  return null;
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  const match = fixtureFor(url.pathname);
  try {
    if (!match) throw new Error('not found');
    const [file, type] = match;
    let body = await readFile(join(fixtures, file));
    if (url.searchParams.has('hostile') && type === 'text/html') {
      // Aggressive page CSS: must not reach the extension's shadow DOM.
      body = Buffer.from(
        body
          .toString()
          .replace('</head>', '<style>* { font-family: "Comic Sans MS", cursive !important; border-radius: 0 !important; } button { all: unset !important; color: red !important; }</style></head>'),
      );
    }
    response.writeHead(200, { 'content-type': `${type}; charset=utf-8` }).end(body);
  } catch {
    response.writeHead(404).end('not found');
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

// --- Browser ----------------------------------------------------------------------------

await mkdir(outputDir, { recursive: true });
await mkdir(screenshotsDir, { recursive: true });
const userDataDir = await mkdtemp(join(tmpdir(), 'chat-exporter-e2e-'));
const context = await chromium.launchPersistentContext(userDataDir, {
  executablePath: findChromium(),
  headless,
  acceptDownloads: true,
  viewport: { width: 1280, height: 800 },
  args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
});
await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
// Record print dialogs instead of opening them (headless Chromium would skip them anyway).
await context.addInitScript(() => {
  window.print = () => {
    document.documentElement.dataset.printCalls = String(Number(document.documentElement.dataset.printCalls ?? 0) + 1);
  };
});
const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
const extensionId = new URL(worker.url()).host;
const extensionOrigin = `chrome-extension://${extensionId}`;

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

async function tabIdOf(page) {
  await page.bringToFront();
  return worker.evaluate(async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id);
}

async function openPopup(forPage, { width = 380, height = 600 } = {}) {
  const tabId = await tabIdOf(forPage);
  const popup = await newPage();
  await popup.setViewportSize({ width, height });
  await popup.goto(`${extensionOrigin}/popup.html?tab=${tabId}`);
  return popup;
}

async function waitFor(check, message, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out: ${message}`);
}

async function clipboard(page) {
  await page.bringToFront();
  return page.evaluate(() => navigator.clipboard.readText());
}

async function resetClipboard(page) {
  await page.bringToFront();
  await page.evaluate(() => navigator.clipboard.writeText('<empty>'));
}

/** Clicks and returns the download's suggested file name and text. */
async function download(page, click) {
  const [file] = await Promise.all([page.waitForEvent('download'), click()]);
  const path = await file.path();
  return { name: file.suggestedFilename(), text: await readFile(path, 'utf8') };
}

const button = (page) => page.locator('chat-exporter-button .cx-trigger');
const menu = (page) => page.locator('chat-exporter-ui .cx-menu');
const menuItem = (page, action) => page.locator(`chat-exporter-ui .cx-menu [data-action="${action}"]`);
const toast = (page) => page.locator('chat-exporter-ui .cx-toast');

async function shot(page, name, options = {}) {
  const { curated = false, fit = false, ...rest } = options;
  const path = join(outputDir, `${name}.png`);
  // Let transitions (toasts, switches) finish.
  await page.waitForTimeout(300);
  if (fit) {
    // Popups size to their content; so does the screenshot.
    const height = await page.evaluate(() => Math.ceil(document.body.getBoundingClientRect().height));
    await page.setViewportSize({ width: page.viewportSize().width, height });
  }
  await page.screenshot({ path, ...rest });
  if (curated) await copyFile(path, join(screenshotsDir, `${name}.png`));
}

/** Storage helpers (run in the service worker). */
async function setStorage(items) {
  await worker.evaluate(async (values) => chrome.storage.local.set(values), items);
}
async function clearStorage() {
  await worker.evaluate(async () => chrome.storage.local.clear());
}
async function storedSettings() {
  return worker.evaluate(async () => (await chrome.storage.local.get('settings')).settings);
}
async function openOptions(hash = '') {
  const page = await newPage();
  await page.setViewportSize({ width: 900, height: 1000 });
  await page.goto(`${extensionOrigin}/options.html${hash}`);
  await page.locator('#pro-features li').first().waitFor();
  return page;
}
/** Document coordinates of an element plus a margin (for full-page clipped screenshots). */
function sectionClip(page, selector, margin = 16) {
  return page.locator(selector).evaluate((element, pad) => {
    const box = element.getBoundingClientRect();
    return { x: box.left + scrollX - pad, y: box.top + scrollY - pad, width: box.width + 2 * pad, height: box.height + 2 * pad };
  }, margin);
}
const badges = (page) => page.evaluate(() =>
  Array.from(document.querySelector('chat-exporter-ui').shadowRoot.querySelectorAll('.cx-menu [data-action]'), (item) => ({
    action: item.dataset.action,
    pro: item.querySelector('.cx-pro') !== null,
    locked: item.classList.contains('cx-locked'),
  })),
);

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
    console.log(`  ✗ ${name}\n      ${String(error?.stack ?? error).split('\n').slice(0, 6).join('\n      ')}`);
  } finally {
    for (const page of openPages) await page.close().catch(() => undefined);
    openPages.clear();
  }
}

console.log(`Chromium ${context.browser()?.version() ?? ''} · extension ${extensionId}\n`);

await test('manifest: production build asks only for storage and the three chat origins', async () => {
  const manifest = JSON.parse(await readFile(join(root, 'dist/manifest.json'), 'utf8'));
  assert.deepEqual(manifest.permissions, ['storage']);
  assert.equal(manifest.host_permissions, undefined);
  assert.equal(manifest.optional_permissions, undefined);
  assert.equal(manifest.web_accessible_resources, undefined);
  assert.deepEqual(manifest.content_scripts.map((script) => script.matches), [
    ['https://chatgpt.com/*', 'https://chat.openai.com/*', 'https://claude.ai/*'],
  ]);
  const e2eManifest = JSON.parse(await readFile(join(extensionPath, 'manifest.json'), 'utf8'));
  assert.ok(e2eManifest.content_scripts[0].matches.includes('http://127.0.0.1/*'), 'e2e build runs on the fixture server');
  const productionScript = await readFile(join(root, 'dist/content.js'), 'utf8');
  assert.ok(!productionScript.includes('127.0.0.1'), 'fixture origin compiled out of production');
  assert.deepEqual(manifest.options_ui, { page: 'options.html', open_in_tab: true });
  // The test hooks (forced free tier, popup ?tab=) are compiled out of the store build.
  for (const file of ['background.js', 'content.js', 'popup.js', 'options.js', 'print.js']) {
    const code = await readFile(join(root, 'dist', file), 'utf8');
    assert.ok(!code.includes('e2eEarlyAccess'), `${file}: no e2e plan hook`);
    assert.ok(!code.includes('URLSearchParams(location.search)'), `${file}: no popup tab override`);
  }
  assert.ok((await readFile(join(extensionPath, 'content.js'), 'utf8')).includes('e2eEarlyAccess'), 'hook present in the e2e build');
});

await test('ChatGPT: Export button sits in the header, before Share', async () => {
  const page = await open(`/chatgpt/c/${CHATGPT_ID}`);
  await button(page).waitFor();
  const placement = await page.evaluate(() => {
    const host = document.querySelector('chat-exporter-button');
    return { parent: host?.parentElement?.id, next: host?.nextElementSibling?.getAttribute('data-testid') };
  });
  assert.deepEqual(placement, { parent: 'conversation-header-actions', next: 'share-chat-button' });
  assert.equal((await button(page).innerText()).trim(), 'Export');
  await shot(page, 'chatgpt-button');
});

await test('menu: shows the conversation, keyboard navigation, Escape closes', async () => {
  const page = await open(`/chatgpt/c/${CHATGPT_ID}`);
  await button(page).click();
  await menu(page).waitFor();
  assert.equal(await menu(page).locator('.dropdown-header').first().innerText(), 'Sorting in Python');
  assert.equal(await menu(page).locator('.cx-menu-meta').innerText(), 'ChatGPT · 4 messages');
  assert.equal(await button(page).getAttribute('aria-expanded'), 'true');
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.evaluate(() => document.querySelector('chat-exporter-ui').shadowRoot.activeElement?.dataset.action), 'markdown');
  await shot(page, 'menu-light', { curated: true, clip: { x: 520, y: 0, width: 760, height: 420 } });
  await page.keyboard.press('Escape');
  await menu(page).waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => document.activeElement?.localName), 'chat-exporter-button', 'focus back on the button');
  // Outside click closes too.
  await button(page).click();
  await menu(page).waitFor();
  await page.mouse.click(640, 500);
  await menu(page).waitFor({ state: 'detached' });
});

await test('Markdown download: header, roles, code, math, table, lists, images; no UI chrome', async () => {
  const page = await open(`/chatgpt/c/${CHATGPT_ID}`);
  await button(page).click();
  const { name, text } = await download(page, () => menuItem(page, 'markdown').click());
  assert.match(name, /^Sorting in Python \d{4}-\d{2}-\d{2}\.md$/);
  assert.ok(text.startsWith('# Sorting in Python\n\n- Source: ChatGPT\n'), text.slice(0, 200));
  assert.ok(text.includes(`- URL: <${base}/chatgpt/c/${CHATGPT_ID}>`));
  assert.equal(text.match(/^## You$/gm)?.length, 2);
  assert.equal(text.match(/^## ChatGPT$/gm)?.length, 2);
  assert.ok(text.includes('```python\nfrom operator import itemgetter\n'), 'code block with language');
  assert.ok(text.includes('#### Complexity'), 'message headings shifted below role headings');
  assert.ok(text.includes('$O(n \\log n)$') && text.includes('$$\nT(n) = \\sum_{i=1}^{\\log_2 n} n = n \\log_2 n\n$$'), 'math as TeX');
  assert.ok(text.includes('| `list.sort()` | Yes | Sorts in place, returns `None` |'), 'table');
  assert.ok(text.includes('- Sort by several keys:\n  - `key=itemgetter("age", "name")`'), 'nested list');
  assert.ok(text.includes(`[Image: Uploaded image](${base}/files/screenshot.png)`), 'image as link');
  assert.ok(text.includes('\\<script>alert("x")\\</script>'), 'user markup escaped');
  for (const chrome of ['Copy code', 'Copy table', 'ChatGPT said', 'Read aloud']) assert.ok(!text.includes(chrome), `no "${chrome}"`);
  await toast(page).waitFor();
  assert.match(await toast(page).innerText(), /Markdown file downloaded\./);
  await shot(page, 'toast-downloaded', { curated: true, clip: { x: 640, y: 560, width: 640, height: 240 } });
});

await test('JSON download follows the versioned schema', async () => {
  const page = await open(`/chatgpt/c/${CHATGPT_ID}`);
  await button(page).click();
  const { name, text } = await download(page, () => menuItem(page, 'json').click());
  assert.match(name, /^Sorting in Python \d{4}-\d{2}-\d{2}\.json$/);
  const data = JSON.parse(text);
  assert.equal(data.schemaVersion, 1);
  assert.equal(data.source, 'chatgpt');
  assert.equal(data.title, 'Sorting in Python');
  assert.equal(data.conversationId, CHATGPT_ID);
  assert.ok(!Number.isNaN(Date.parse(data.exportedAt)));
  assert.deepEqual(data.messages.map((message) => message.role), ['user', 'assistant', 'user', 'assistant']);
  assert.ok(data.messages.every((message) => typeof message.markdown === 'string' && typeof message.text === 'string'));
  assert.ok(data.messages[1].text.includes('by_age = sorted(people, key=itemgetter("age"))'));
});

await test('plain text download uses role labels', async () => {
  const page = await open(`/chatgpt/c/${CHATGPT_ID}`);
  await button(page).click();
  const { name, text } = await download(page, () => menuItem(page, 'text').click());
  assert.match(name, /\.txt$/);
  assert.ok(text.startsWith('Sorting in Python\nChatGPT · '));
  assert.ok(text.includes('\nYou:\n\n') && text.includes('\nChatGPT:\n\n'));
  assert.ok(text.includes('Thanks! Does this work for <script>alert("x")</script> strings'), 'plain text is not escaped');
});

await test('Copy as Markdown puts the document in the clipboard', async () => {
  const page = await open(`/chatgpt/c/${CHATGPT_ID}`);
  await resetClipboard(page);
  await button(page).click();
  await menuItem(page, 'copy').click();
  await toast(page).waitFor();
  assert.match(await toast(page).innerText(), /Copied as Markdown\./);
  const text = await clipboard(page);
  assert.ok(text.startsWith('# Sorting in Python\n'), text.slice(0, 100));
  assert.ok(text.includes('```python'));
});

await test('PDF: print view renders the conversation safely and opens the print dialog', async () => {
  const page = await open(`/chatgpt/c/${CHATGPT_ID}`);
  await button(page).click();
  const [print] = await Promise.all([context.waitForEvent('page'), menuItem(page, 'pdf').click()]);
  openPages.add(print);
  await print.waitForURL(/print\.html#/);
  await print.locator('#document').waitFor();
  assert.equal(await print.locator('#doc-title').innerText(), 'Sorting in Python');
  assert.equal(await print.locator('.message').count(), 4);
  assert.equal(await print.locator('.message.user .role').first().innerText(), 'YOU');
  assert.ok((await print.locator('.message.assistant pre code.language-python').innerText()).includes('itemgetter'));
  assert.equal(await print.locator('.message.assistant table').count(), 1);
  assert.equal(await print.locator('.math-inline').first().innerText(), 'O(n \\log n)');
  assert.ok((await print.locator('.message.user').nth(1).innerText()).includes('<script>alert("x")</script>'), 'user text shown literally');
  assert.equal(await print.locator('#messages script, #messages img, #messages iframe').count(), 0, 'no markup from the conversation');
  assert.equal(await print.locator('#print').isEnabled(), true);
  await print.waitForFunction(() => document.documentElement.dataset.printCalls === '1');
  assert.equal(await print.locator('#loading').isVisible(), false, 'loading state gone');
  assert.match(await print.title(), /^Sorting in Python \d{4}-\d{2}-\d{2}$/, 'title becomes the PDF file name');
  await print.setViewportSize({ width: 1100, height: 900 });
  await shot(print, 'print-view', { curated: true });
  await shot(print, 'print-view-full', { fullPage: true });
  await print.emulateMedia({ media: 'print' });
  assert.equal(await print.locator('.print-toolbar').isVisible(), false, 'toolbar hidden when printing');
  await toast(page).waitFor();
  assert.match(await toast(page).innerText(), /Print view opened in a new tab/);
});

await test('Pro badges: early access unlocks JSON, PDF, Obsidian and export options', async () => {
  const page = await open(`/chatgpt/c/${CHATGPT_ID}`);
  await button(page).click();
  await menu(page).waitFor();
  assert.deepEqual(await badges(page), [
    { action: 'copy', pro: false, locked: false },
    { action: 'markdown', pro: false, locked: false },
    { action: 'text', pro: false, locked: false },
    { action: 'obsidian', pro: true, locked: false },
    { action: 'json', pro: true, locked: false },
    { action: 'pdf', pro: true, locked: false },
    { action: 'options', pro: true, locked: false },
  ]);
  assert.equal(await menu(page).locator('.cx-menu-options').count(), 0, 'no options line with the defaults');
  const popup = await openPopup(page);
  await popup.locator('#conversation').waitFor();
  assert.equal(await popup.locator('.format-grid .pro-badge').count(), 3);
  assert.equal(await popup.locator('.format-grid .locked').count(), 0);
  assert.equal(await popup.locator('#plan-note').innerText(), 'Pro free during early access');
});

await test('Obsidian / Notion Markdown: front matter, tags, role headings', async () => {
  const page = await open(`/chatgpt/c/${CHATGPT_ID}`);
  await button(page).click();
  const { name, text } = await download(page, () => menuItem(page, 'obsidian').click());
  assert.match(name, /^Sorting in Python \d{4}-\d{2}-\d{2}\.md$/);
  const today = name.match(/\d{4}-\d{2}-\d{2}/)[0];
  assert.ok(
    text.startsWith(`---\ntitle: "Sorting in Python"\nsource: "ChatGPT"\nurl: "${base}/chatgpt/c/${CHATGPT_ID}"\ndate: ${today}\ntags:\n  - "ai-chat"\n  - "chatgpt"\n---\n\n## You\n`),
    text.slice(0, 300),
  );
  assert.ok(!text.includes('# Sorting in Python'), 'no H1: note apps show the file name');
  assert.ok(text.includes('```python\nfrom operator import itemgetter\n'));
  assert.match(await toast(page).innerText(), /Obsidian \/ Notion Markdown file downloaded\./);
});

await test('options page: export options are saved and applied to every export', async () => {
  try {
    const options = await openOptions('#options');
    assert.equal(await options.locator('#options-locked').isVisible(), false);
    assert.equal(await options.locator('#options-form').evaluate((fieldset) => fieldset.disabled), false);
    await options.locator('#include-code').click();
    await options.locator('#include-user').click();
    await options.locator('#last-enabled').click();
    await options.locator('#last-count').fill('2');
    await options.locator('#filename-template').fill('');
    await options.locator('[data-token="{site}"]').click();
    await options.locator('#filename-template').press('End');
    await options.locator('#filename-template').pressSequentially(' - ');
    await options.locator('[data-token="{title}"]').click();
    assert.match(await options.locator('#filename-preview').innerText(), /^ChatGPT - Sorting in Python\.md$/);
    await options.locator('#tags').fill('#Research, AI/chat python!');
    await options.locator('#tags').blur();
    assert.equal(await options.locator('#tags').inputValue(), 'Research, AI/chat, python');
    await options.locator('#callouts').click();
    await waitFor(async () => {
      const saved = (await storedSettings())?.exportOptions;
      return saved?.lastMessages === 2 && saved.filenameTemplate === '{site} - {title}' && saved.tags.length === 3 && saved.callouts;
    }, 'options saved');
    assert.deepEqual((await storedSettings()).exportOptions, {
      includeCode: false,
      includeUser: false,
      lastMessages: 2,
      filenameTemplate: '{site} - {title}',
      tags: ['Research', 'AI/chat', 'python'],
      callouts: true,
    });
    await options.locator('#save-status', { hasText: 'Saved' }).waitFor();
    await shot(options, 'options-light', { curated: true, fullPage: true });
    await options.emulateMedia({ colorScheme: 'dark' });
    await shot(options, 'options-dark', { fullPage: true });

    const page = await open(`/chatgpt/c/${CHATGPT_ID}`);
    await button(page).click();
    await menu(page).waitFor();
    assert.equal(await menu(page).locator('.cx-menu-meta').innerText(), 'ChatGPT · 2 of 4 messages');
    assert.equal(await menu(page).locator('.cx-menu-options').innerText(), 'Last 2 messages · Replies only · No code blocks');
    await shot(page, 'menu-options', { curated: true, clip: { x: 520, y: 0, width: 760, height: 470 } });
    const obsidian = await download(page, () => menuItem(page, 'obsidian').click());
    assert.equal(obsidian.name, 'ChatGPT - Sorting in Python.md');
    assert.ok(obsidian.text.includes('tags:\n  - "Research"\n  - "AI/chat"\n  - "python"\n  - "chatgpt"\n---'), obsidian.text.slice(0, 300));
    assert.ok(!obsidian.text.includes('> [!question] You'), 'user messages left out');
    assert.equal(obsidian.text.match(/^> \[!note\] ChatGPT$/gm)?.length, 2, 'only the replies, as callouts');
    assert.ok(obsidian.text.includes('> *(Code block omitted.)*'), 'code replaced by a note');
    assert.ok(!obsidian.text.includes('```'), 'no code fences');
    await button(page).click();
    const json = JSON.parse((await download(page, () => menuItem(page, 'json').click())).text);
    assert.deepEqual(json.messages.map((message) => message.role), ['assistant', 'assistant']);
    assert.ok(!json.messages[0].text.includes('by_age = sorted('), 'no code in the text either');
    await button(page).click();
    const md = await download(page, () => menuItem(page, 'markdown').click());
    assert.equal(md.name, 'ChatGPT - Sorting in Python.md');
    assert.ok(md.text.includes('- Messages: 2'));
    await button(page).click();
    const [print] = await Promise.all([context.waitForEvent('page'), menuItem(page, 'pdf').click()]);
    openPages.add(print);
    await print.locator('#document').waitFor();
    assert.equal(await print.locator('.message').count(), 2);
    assert.equal(await print.title(), 'ChatGPT - Sorting in Python', 'PDF name from the template');
    const popup = await openPopup(page);
    await popup.locator('#conversation').waitFor();
    assert.equal(await popup.locator('#count').innerText(), '2 of 4 messages');
    assert.equal(await popup.locator('#options-text').innerText(), 'Last 2 messages · Replies only · No code blocks');
    const fromPopup = await download(popup, () => popup.locator('[data-format="text"]').click());
    assert.equal(fromPopup.name, 'ChatGPT - Sorting in Python.txt');
    assert.ok(fromPopup.text.includes(' · 2 messages\n'), fromPopup.text.slice(0, 200));
    assert.ok(!fromPopup.text.includes('\nYou:\n'), 'no user messages in text');
    await shot(popup, 'popup-options', { fit: true });
  } finally {
    await clearStorage();
  }
});

await test('free plan (early access off): Pro items explain Pro, free exports still work', async () => {
  try {
    await setStorage({
      e2eEarlyAccess: false,
      settings: { showButton: true, exportOptions: { includeCode: false, includeUser: false, lastMessages: 1, filenameTemplate: '{site}', tags: [], callouts: true } },
    });
    const page = await open(`/chatgpt/c/${CHATGPT_ID}`);
    await button(page).click();
    await menu(page).waitFor();
    const items = await badges(page);
    assert.deepEqual(items.filter((item) => item.locked).map((item) => item.action), ['obsidian', 'json', 'pdf']);
    assert.equal(await menu(page).locator('.cx-menu-meta').innerText(), 'ChatGPT · 4 messages', 'stored options are not applied on Free');
    assert.equal(await menu(page).locator('.cx-menu-options').count(), 0);
    await shot(page, 'menu-free', { clip: { x: 520, y: 0, width: 760, height: 470 } });

    let downloaded = false;
    page.on('download', () => (downloaded = true));
    await menuItem(page, 'json').click();
    await toast(page).waitFor();
    assert.match(await toast(page).innerText(), /JSON export is part of Pro \(\$2\.99, one-time\)\. Free keeps Copy as Markdown and \.md \/ \.txt downloads\./);
    await shot(page, 'toast-pro', { curated: true, clip: { x: 640, y: 560, width: 640, height: 240 } });
    const [about] = await Promise.all([context.waitForEvent('page'), toast(page).locator('.cx-toast-action').click()]);
    openPages.add(about);
    await about.waitForURL(/options\.html#pro$/);
    assert.equal(downloaded, false, 'nothing downloaded');

    // Free exports ignore the stored (Pro) options but keep them.
    await page.bringToFront();
    await button(page).click();
    const md = await download(page, () => menuItem(page, 'markdown').click());
    assert.match(md.name, /^Sorting in Python \d{4}-\d{2}-\d{2}\.md$/);
    assert.equal(md.text.match(/^## You$/gm)?.length, 2);
    assert.ok(md.text.includes('```python'));
    assert.equal((await storedSettings()).exportOptions.lastMessages, 1, 'stored options kept');

    const popup = await openPopup(page);
    await popup.locator('#conversation').waitFor();
    assert.equal(await popup.locator('.format-grid .locked').count(), 3);
    assert.equal(await popup.locator('#plan-note').innerText(), 'Free plan');
    assert.equal(await popup.locator('#options-text').innerText(), 'Export options (Pro)');
    await popup.locator('[data-format="pdf"]').click();
    await popup.locator('#status', { hasText: 'PDF is part of Pro' }).waitFor();
    assert.equal(await popup.locator('#status button').innerText(), 'About Pro');
    await shot(popup, 'popup-free', { fit: true });
    // The service worker checks the plan too.
    const response = await popup.evaluate(() =>
      chrome.runtime.sendMessage({
        type: 'chat-exporter/print',
        conversation: { site: 'chatgpt', conversationId: null, title: 't', url: 'https://chatgpt.com/c/x', streaming: false, messages: [] },
      }),
    );
    assert.deepEqual(response, { ok: false, message: 'PDF is part of Pro ($2.99, one-time). Free keeps Copy as Markdown and .md / .txt downloads.' });

    const options = await openOptions('#options');
    await options.locator('#options-locked').waitFor();
    assert.equal(await options.locator('#options-form').evaluate((fieldset) => fieldset.disabled), true);
    assert.equal(await options.locator('#include-code').isChecked(), false, 'stored choices shown');
    assert.equal(await options.locator('#get-pro').isDisabled(), true);
    assert.equal(await options.locator('#pro-note').innerText(), 'Payments are coming soon.');
  } finally {
    await clearStorage();
  }
});

await test('About Pro card: price, features, disabled Get Pro during early access', async () => {
  const options = await openOptions('#pro');
  assert.equal(await options.locator('#pro-price').innerText(), '$2.99');
  assert.deepEqual(await options.locator('#pro-features li .fw-semibold').allInnerTexts(), ['JSON export', 'PDF', 'Obsidian / Notion Markdown', 'Export options']);
  assert.equal(await options.locator('#get-pro').isDisabled(), true);
  assert.equal(await options.locator('#get-pro').innerText(), 'Get Pro');
  assert.equal(await options.locator('#pro-note').innerText(), 'Free during early access');
  assert.equal(await options.locator('#plan-badge').innerText(), 'Early access: Pro unlocked');
  await shot(options, 'about-pro', { curated: true, fullPage: true, clip: await sectionClip(options, '#pro') });
  await options.emulateMedia({ colorScheme: 'dark' });
  await shot(options, 'about-pro-dark', { fullPage: true, clip: await sectionClip(options, '#pro') });
  // The in-page "Export options" item opens this page.
  const page = await open(`/chatgpt/c/${CHATGPT_ID}`);
  await button(page).click();
  const [opened] = await Promise.all([context.waitForEvent('page'), menuItem(page, 'options').click()]);
  openPages.add(opened);
  await opened.waitForURL(/options\.html#options$/);
});

await test('SPA navigation: the button comes back in the re-rendered header and exports the new chat', async () => {
  const page = await open(`/chatgpt/c/${CHATGPT_ID}`);
  await button(page).waitFor();
  await page.evaluate((id) => window.fixture.navigate(id, 'conversation-lviv', 'Trip to Lviv'), LVIV_ID);
  await waitFor(
    () => page.evaluate(() => document.querySelector('#conversation-header-actions > chat-exporter-button') !== null),
    'button re-injected into the new header',
  );
  assert.equal(await page.locator('chat-exporter-button').count(), 1, 'exactly one button');
  await button(page).click();
  assert.equal(await menu(page).locator('.dropdown-header').first().innerText(), 'Trip to Lviv');
  const { name, text } = await download(page, () => menuItem(page, 'markdown').click());
  assert.match(name, /^Trip to Lviv \d{4}-\d{2}-\d{2}\.md$/);
  assert.ok(text.includes('Сплануй поїздку до Львова на вихідні. Бюджет — 5000 грн.'));
  assert.ok(text.includes('#### Субота'), 'message h2 shifted below the role headings');
});

await test('Claude: floating button, language label used for the fence, math kept', async () => {
  const page = await open(`/claude/chat/${CLAUDE_ID}`);
  await button(page).waitFor();
  assert.equal(await page.evaluate(() => document.querySelector('chat-exporter-button')?.parentElement === document.documentElement), true);
  const box = await button(page).boundingBox();
  assert.ok(box && box.y > 52 && box.x > 1100, `floating below the header on the right: ${JSON.stringify(box)}`);
  await shot(page, 'claude-floating', { curated: true, clip: { x: 520, y: 0, width: 760, height: 360 } });
  await button(page).click();
  assert.equal(await menu(page).locator('.cx-menu-meta').innerText(), 'Claude · 4 messages');
  const { name, text } = await download(page, () => menuItem(page, 'markdown').click());
  assert.match(name, /^Rust ownership basics \d{4}-\d{2}-\d{2}\.md$/);
  assert.ok(text.includes('## Claude'));
  assert.ok(text.includes('```rust\nfn main() {\n'));
  assert.ok(!/^rust$/m.test(text), 'label not repeated as text');
  assert.ok(text.includes('$O(1)$'));
  assert.ok(text.includes('Keep it brief, please. Привіт, café!'));
});

await test('streaming reply: menu warns, export marks the reply incomplete', async () => {
  const page = await open('/chatgpt/c/stream-0001-aaaa-bbbb');
  await button(page).click();
  assert.match(await menu(page).locator('.cx-menu-warning').innerText(), /still being written/);
  const { text } = await download(page, () => menuItem(page, 'json').click());
  const data = JSON.parse(text);
  assert.equal(data.messages[1].incomplete, true);
  assert.match(await toast(page).innerText(), /may be cut off/);
  await page.evaluate(() => window.fixture.finish());
  await button(page).click();
  assert.equal(await menu(page).locator('.cx-menu-warning').count(), 0, 'warning gone after the reply finished');
  const done = JSON.parse((await download(page, () => menuItem(page, 'json').click())).text);
  assert.equal(done.messages[1].incomplete, undefined);
  assert.ok(done.messages[1].markdown.includes('```regex\n^\\d{4}-\\d{2}-\\d{2}$\n```'));
});

await test('changed layout: friendly error instead of exporting garbage', async () => {
  const page = await open('/chatgpt/c/broken-0001-aaaa-bbbb');
  await button(page).click();
  const warning = menu(page).locator('.cx-menu-warning');
  await warning.waitFor();
  assert.equal(await warning.innerText(), "Couldn't read this conversation, the site may have changed.");
  assert.equal(await menuItem(page, 'markdown').isDisabled(), true);
  assert.equal(await menuItem(page, 'copy').isDisabled(), true);
  await shot(page, 'menu-error', { curated: true, clip: { x: 520, y: 0, width: 760, height: 420 } });
  const popup = await openPopup(page);
  await popup.locator('#error').waitFor();
  assert.equal(await popup.locator('#error-text').innerText(), "Couldn't read this conversation, the site may have changed.");
  await shot(popup, 'popup-error', { curated: true, fit: true });
});

await test('home page (no conversation): no button; popup explains what to do', async () => {
  const page = await open('/chatgpt/');
  await page.waitForTimeout(800);
  assert.equal(await page.locator('chat-exporter-button').count(), 0);
  const popup = await openPopup(page);
  await popup.locator('#empty').waitFor();
  assert.match(await popup.locator('#empty').innerText(), /Open a ChatGPT or Claude conversation to export it\./);
});

await test('popup: exports the conversation in the active tab', async () => {
  const page = await open(`/chatgpt/c/${CHATGPT_ID}`);
  await button(page).waitFor();
  const popup = await openPopup(page);
  await popup.locator('#conversation').waitFor();
  assert.equal(await popup.locator('#title').innerText(), 'Sorting in Python');
  assert.equal(await popup.locator('#site-badge').innerText(), 'ChatGPT');
  assert.equal(await popup.locator('#count').innerText(), '4 messages');
  await shot(popup, 'popup-light', { curated: true, fit: true });
  const { name, text } = await download(popup, () => popup.locator('[data-format="markdown"]').click());
  assert.match(name, /^Sorting in Python \d{4}-\d{2}-\d{2}\.md$/);
  assert.ok(text.startsWith('# Sorting in Python'));
  assert.match(await popup.locator('#status').innerText(), /^Downloaded Sorting in Python/);
  const json = JSON.parse((await download(popup, () => popup.locator('[data-format="json"]').click())).text);
  assert.equal(json.messages.length, 4);
  await popup.locator('#copy').click();
  await popup.locator('#status', { hasText: 'Copied as Markdown.' }).waitFor();
  const copied = await clipboard(page);
  assert.ok(copied.startsWith('# Sorting in Python'), copied.slice(0, 80));
  const [print] = await Promise.all([context.waitForEvent('page'), popup.locator('[data-format="pdf"]').click()]);
  openPages.add(print);
  await print.locator('#document').waitFor();
  assert.equal(await print.locator('.message').count(), 4);
  await popup.evaluate(() => document.activeElement?.blur());
  await popup.mouse.move(1, 1);
  await popup.emulateMedia({ colorScheme: 'dark' });
  await shot(popup, 'popup-dark', { curated: true, fit: true });
});

await test('popup: empty state on other pages (light and dark)', async () => {
  const page = await open('/plain.html');
  const popup = await openPopup(page);
  await popup.locator('#empty').waitFor();
  await shot(popup, 'popup-empty', { curated: true, fit: true });
  await popup.emulateMedia({ colorScheme: 'dark' });
  await shot(popup, 'popup-empty-dark', { fit: true });
});

await test('setting: turning the button off removes it from open chat pages', async () => {
  const page = await open(`/chatgpt/c/${CHATGPT_ID}`);
  await button(page).waitFor();
  const popup = await openPopup(page);
  await popup.locator('#conversation').waitFor();
  assert.equal(await popup.locator('#show-button').isChecked(), true);
  await popup.locator('#show-button').click();
  await page.locator('chat-exporter-button').waitFor({ state: 'detached' });
  await popup.locator('#show-button').click();
  await button(page).waitFor();
  const stored = await worker.evaluate(async () => (await chrome.storage.local.get('settings')).settings);
  assert.equal(stored.showButton, true);
  assert.equal(stored.exportOptions.includeCode, true, 'export options stored with their defaults');
});

await test('dark page: in-page UI follows the site theme', async () => {
  const page = await open(`/chatgpt/c/${CHATGPT_ID}?theme=dark`);
  await button(page).waitFor();
  const theme = await page.evaluate(() => document.querySelector('chat-exporter-button').shadowRoot.querySelector('.cx-theme').dataset.bsTheme);
  assert.equal(theme, 'dark');
  await button(page).click();
  await menu(page).waitFor();
  await shot(page, 'menu-dark', { curated: true, clip: { x: 520, y: 0, width: 760, height: 420 } });
  const claude = await open(`/claude/chat/${CLAUDE_ID}?theme=dark`);
  await button(claude).waitFor();
  await shot(claude, 'claude-floating-dark', { clip: { x: 520, y: 0, width: 760, height: 360 } });
});

await test('hostile page CSS does not reach the button', async () => {
  const page = await open(`/chatgpt/c/${CHATGPT_ID}?hostile=1`);
  await button(page).waitFor();
  const style = await button(page).evaluate((element) => {
    const computed = getComputedStyle(element);
    return { font: computed.fontFamily, radius: computed.borderTopLeftRadius, color: computed.color };
  });
  assert.ok(!style.font.includes('Comic Sans'), style.font);
  assert.equal(style.radius, '8px');
  assert.notEqual(style.color, 'rgb(255, 0, 0)');
  await button(page).click();
  await menu(page).waitFor();
});

await test('no network requests leave the browser', async () => {
  const requests = [];
  const listener = (request) => {
    const url = request.url();
    if (!url.startsWith(base) && !url.startsWith('chrome-extension://') && !url.startsWith('data:') && !url.startsWith('blob:')) requests.push(url);
  };
  context.on('request', listener);
  const page = await open(`/chatgpt/c/${CHATGPT_ID}`);
  await button(page).click();
  await download(page, () => menuItem(page, 'markdown').click());
  await button(page).click();
  const [print] = await Promise.all([context.waitForEvent('page'), menuItem(page, 'pdf').click()]);
  openPages.add(print);
  await print.locator('#document').waitFor();
  context.off('request', listener);
  assert.deepEqual(requests, []);
});

// --- Summary ----------------------------------------------------------------------------

await context.close();
server.close();
await rm(userDataDir, { recursive: true, force: true });

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed. Screenshots: ${outputDir} (curated: ${screenshotsDir})`);
process.exit(failed.length ? 1 : 0);
