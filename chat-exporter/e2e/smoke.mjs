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
  assert.deepEqual(stored, { showButton: true });
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
