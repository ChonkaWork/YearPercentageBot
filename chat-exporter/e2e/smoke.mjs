// End-to-end smoke test: loads the e2e build (dist-e2e/) into a real Chromium and drives every
// user flow against local fixture pages that replicate ChatGPT's and Claude's DOM.
//
//   npm run test:e2e                      (set CHROMIUM_PATH if Chromium isn't auto-detected)
//
// chatgpt.com and claude.ai are never contacted: Chromium resolves chatgpt.com, claude.ai and
// news.example.com (port 80) to a local fixture server (--host-resolver-rules), which serves
// copies of their DOM over plain http. The e2e build also matches those http origins, so the
// adapters pick the site by host exactly as in production, and no screenshot shows a local
// address or a port.

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';
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
/** An everyday chat for screenshots (the main fixture carries escaping test strings). */
const WEEKEND_ID = '6710aa04-4444-4000-8000-000000000004';

function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const candidates = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  const found = candidates.find((path) => existsSync(path));
  if (!found) throw new Error('Chromium not found. Set CHROMIUM_PATH.');
  return found;
}

// --- Fixture server ---------------------------------------------------------------------

const CHATGPT = 'http://chatgpt.com';
const CLAUDE = 'http://claude.ai';
const NEWS = 'http://news.example.com';
const FIXTURE_ORIGINS = [CHATGPT, CLAUDE, NEWS];

function fixtureFor(host, pathname) {
  if (pathname === '/fixture.css') return ['fixture.css', 'text/css'];
  if (pathname.startsWith('/files/')) return [join('..', '..', 'static/icons/icon128.png'), 'image/png'];
  if (host === 'chatgpt.com') {
    if (pathname === '/') return ['chatgpt-home.html', 'text/html'];
    if (pathname.startsWith('/c/stream-')) return ['chatgpt-streaming.html', 'text/html'];
    if (pathname.startsWith('/c/broken-')) return ['chatgpt-broken.html', 'text/html'];
    if (pathname.startsWith('/c/6710aa04-')) return ['chatgpt-weekend.html', 'text/html'];
    if (pathname.startsWith('/c/')) return ['chatgpt.html', 'text/html'];
  }
  if (host === 'claude.ai' && pathname.startsWith('/chat/')) return ['claude.html', 'text/html'];
  if (host === 'news.example.com' && (pathname === '/' || pathname === '/plain.html')) return ['plain.html', 'text/html'];
  return null;
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  const host = (request.headers.host ?? '').replace(/:\d+$/, '');
  const match = fixtureFor(host, url.pathname);
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
const port = server.address().port;

// --- Browser ----------------------------------------------------------------------------

await mkdir(outputDir, { recursive: true });
await mkdir(screenshotsDir, { recursive: true });
const userDataDir = await mkdtemp(join(tmpdir(), 'chat-exporter-e2e-'));
const context = await chromium.launchPersistentContext(userDataDir, {
  executablePath: findChromium(),
  headless,
  acceptDownloads: true,
  viewport: { width: 1280, height: 800 },
  args: [
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
    // chatgpt.com, claude.ai and news.example.com (port 80) resolve to the local fixture server...
    `--host-resolver-rules=${FIXTURE_ORIGINS.map((origin) => `MAP ${new URL(origin).host}:80 127.0.0.1:${port}`).join(',')}`,
    // ...directly, not through a proxy from the environment...
    '--no-proxy-server',
    // ...and count as secure contexts, like the real https sites (the Clipboard API needs one).
    `--unsafely-treat-insecure-origin-as-secure=${FIXTURE_ORIGINS.join(',')}`,
  ],
});
for (const origin of FIXTURE_ORIGINS) await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
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

async function open(url) {
  const page = await newPage();
  await page.goto(url);
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

/** Menus are clipped to this height in screenshots (tall enough for every item). */
const MENU_CLIP_HEIGHT = 600;

/** Drops a file on the options page's drop zone, as when dragging it from the desktop. */
async function dropFile(page, name, content, type) {
  const base64 = Buffer.from(content).toString('base64');
  await page.evaluate(
    ({ name, base64, type }) => {
      const zone = document.getElementById('drop-zone');
      const transfer = new DataTransfer();
      transfer.items.add(new File([Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))], name, { type }));
      for (const kind of ['dragenter', 'dragover', 'drop']) zone.dispatchEvent(new DragEvent(kind, { dataTransfer: transfer, bubbles: true, cancelable: true }));
    },
    { name, base64, type },
  );
}

/** A zip like the ones ChatGPT and Claude send (made with node:zlib, independent of the extension). */
function makeZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of files) {
    const raw = Buffer.from(data);
    const deflated = deflateRawSync(raw);
    const nameBytes = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc32(raw), 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc32(raw), 16);
    central.writeUInt32LE(deflated.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, deflated);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + deflated.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/** Reads a zip with node:zlib only: entry name → text. Checks every CRC. */
function readZip(buffer) {
  const endAt = buffer.length - 22;
  assert.equal(buffer.readUInt32LE(endAt), 0x06054b50, 'zip end record');
  const count = buffer.readUInt16LE(endAt + 10);
  let at = buffer.readUInt32LE(endAt + 16);
  const files = new Map();
  for (let i = 0; i < count; i++) {
    assert.equal(buffer.readUInt32LE(at), 0x02014b50, 'central directory entry');
    const method = buffer.readUInt16LE(at + 10);
    const crc = buffer.readUInt32LE(at + 16);
    const size = buffer.readUInt32LE(at + 20);
    const nameLength = buffer.readUInt16LE(at + 28);
    const localAt = buffer.readUInt32LE(at + 42);
    const name = buffer.toString('utf8', at + 46, at + 46 + nameLength);
    const dataAt = localAt + 30 + buffer.readUInt16LE(localAt + 26) + buffer.readUInt16LE(localAt + 28);
    const raw = buffer.subarray(dataAt, dataAt + size);
    const data = method === 8 ? inflateRawSync(raw) : raw;
    assert.equal(crc32(data), crc, `CRC of ${name}`);
    files.set(name, data.toString('utf8'));
    at += 46 + nameLength + buffer.readUInt16LE(at + 30) + buffer.readUInt16LE(at + 32);
  }
  return files;
}

/** Waits for a download and returns its name and bytes. */
async function downloadBytes(page, action) {
  const [file] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), action()]);
  return { name: file.suggestedFilename(), bytes: await readFile(await file.path()) };
}

/**
 * A realistic ChatGPT export for the screenshots: 148 conversations over 18 months, with the
 * things real exports have (hidden system messages, regenerated replies, tool calls, "thoughts").
 */
function realisticExport() {
  const titles = [
    'Fix flaky Playwright test', 'Quarterly report outline', 'Postgres index not used', 'Trip to Lviv', 'Sorting in Python',
    'Cover letter for a UX role', 'Kubernetes liveness vs readiness', 'Weekly meal plan', 'SQL window functions', 'Fix CORS error in Express',
    'Budget spreadsheet formulas', 'Refactor a React useEffect', 'Summarize meeting notes', 'Git rebase vs merge', 'Plan a 10k training schedule',
    'Explain Bayes’ theorem', 'Draft a reply to the landlord', 'Lazy-load images on a landing page', 'Bash script to rename photos', 'Compare Kafka and RabbitMQ',
    'Chrome extension manifest v3', 'Ukrainian verbs of motion', 'Debug Docker networking', 'Product launch checklist', 'Explain transformers simply',
    'Reschedule an interview', 'CSS grid vs flexbox', 'Terraform state locking', 'Sci-fi book recommendations', 'TypeScript generics',
  ];
  const conversations = [];
  let time = Date.parse('2026-09-27T15:20:00Z') / 1000;
  for (let index = 0; index < 148; index++) {
    time -= 3600 * (4 + ((index * 37) % 83));
    const id = `68${String(index).padStart(6, '0')}-aaaa-4bbb-8ccc-${String(100000000000 + index * 7919).slice(-12)}`;
    const mapping = { root: { id: 'root', parent: null, children: ['system'], message: null } };
    const add = (key, parent, role, content, extra = {}) => {
      mapping[parent].children.push(key);
      mapping[key] = { id: key, parent, children: [], message: { id: key, author: { role }, create_time: time + Object.keys(mapping).length * 30, content, metadata: extra.metadata ?? {}, recipient: 'all' } };
    };
    mapping.system = { id: 'system', parent: 'root', children: [], message: { id: 'system', author: { role: 'system' }, create_time: null, content: { content_type: 'text', parts: [''] }, metadata: { is_visually_hidden_from_conversation: true } } };
    let last = 'system';
    const turns = 1 + ((index * 5) % 6);
    for (let turn = 0; turn < turns; turn++) {
      add(`u${turn}`, last, 'user', { content_type: 'text', parts: [turn ? `Follow-up question ${turn} about ${titles[index % titles.length]}.` : `${titles[index % titles.length]}?`] });
      last = `u${turn}`;
      if (index % 9 === 0 && turn === 0) {
        add('thoughts', last, 'assistant', { content_type: 'thoughts', thoughts: [{ summary: 'Thinking', content: '…' }] });
        last = 'thoughts';
      }
      if (index % 11 === 0 && turn === 0) {
        add('code', last, 'assistant', { content_type: 'code', language: 'python', text: 'print(sum(range(10)))' });
        add('tool', 'code', 'tool', { content_type: 'execution_output', text: '45' });
        last = 'tool';
      }
      add(`a${turn}`, last, 'assistant', { content_type: 'text', parts: [`Here is a clear answer for turn ${turn + 1}.\n\n- One\n- Two`] });
      last = `a${turn}`;
    }
    conversations.push({ id, title: titles[index % titles.length], create_time: time, update_time: time + turns * 600, current_node: last, mapping });
  }
  return JSON.stringify(conversations);
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
  assert.deepEqual(e2eManifest.content_scripts[0].matches.slice(3), ['http://chatgpt.com/*', 'http://claude.ai/*'], 'e2e build also runs on the http fixture origins');
  assert.ok(!JSON.stringify(manifest).includes('http://'), 'no http origins in the production manifest');
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
  const page = await open(`${CHATGPT}/c/${CHATGPT_ID}`);
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
  const page = await open(`${CHATGPT}/c/${CHATGPT_ID}`);
  await button(page).click();
  await menu(page).waitFor();
  assert.equal(await menu(page).locator('.dropdown-header').first().innerText(), 'Sorting in Python');
  assert.equal(await menu(page).locator('.cx-menu-meta').innerText(), 'ChatGPT · 4 messages');
  assert.equal(await button(page).getAttribute('aria-expanded'), 'true');
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.evaluate(() => document.querySelector('chat-exporter-ui').shadowRoot.activeElement?.dataset.action), 'handoff');
  await page.keyboard.press('End');
  assert.equal(await page.evaluate(() => document.querySelector('chat-exporter-ui').shadowRoot.activeElement?.dataset.action), 'options');
  await page.keyboard.press('Home');
  await shot(page, 'menu-light', { curated: true, clip: { x: 520, y: 0, width: 760, height: MENU_CLIP_HEIGHT } });
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
  const page = await open(`${CHATGPT}/c/${CHATGPT_ID}`);
  await button(page).click();
  const { name, text } = await download(page, () => menuItem(page, 'markdown').click());
  assert.match(name, /^Sorting in Python \d{4}-\d{2}-\d{2}\.md$/);
  assert.ok(text.startsWith('# Sorting in Python\n\n- Source: ChatGPT\n'), text.slice(0, 200));
  assert.ok(text.includes(`- URL: <${CHATGPT}/c/${CHATGPT_ID}>`));
  assert.equal(text.match(/^## You$/gm)?.length, 2);
  assert.equal(text.match(/^## ChatGPT$/gm)?.length, 2);
  assert.ok(text.includes('```python\nfrom operator import itemgetter\n'), 'code block with language');
  assert.ok(text.includes('#### Complexity'), 'message headings shifted below role headings');
  assert.ok(text.includes('$O(n \\log n)$') && text.includes('$$\nT(n) = \\sum_{i=1}^{\\log_2 n} n = n \\log_2 n\n$$'), 'math as TeX');
  assert.ok(text.includes('| `list.sort()` | Yes | Sorts in place, returns `None` |'), 'table');
  assert.ok(text.includes('- Sort by several keys:\n  - `key=itemgetter("age", "name")`'), 'nested list');
  assert.ok(text.includes(`[Image: Uploaded image](${CHATGPT}/files/screenshot.png)`), 'image as link');
  assert.ok(text.includes('\\<script>alert("x")\\</script>'), 'user markup escaped');
  for (const chrome of ['Copy code', 'Copy table', 'ChatGPT said', 'Read aloud']) assert.ok(!text.includes(chrome), `no "${chrome}"`);
  await toast(page).waitFor();
  assert.match(await toast(page).innerText(), /Markdown file downloaded\./);
  await shot(page, 'toast-downloaded', { curated: true, clip: { x: 640, y: 560, width: 640, height: 240 } });
});

await test('JSON download follows the versioned schema', async () => {
  const page = await open(`${CHATGPT}/c/${CHATGPT_ID}`);
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
  const page = await open(`${CHATGPT}/c/${CHATGPT_ID}`);
  await button(page).click();
  const { name, text } = await download(page, () => menuItem(page, 'text').click());
  assert.match(name, /\.txt$/);
  assert.ok(text.startsWith('Sorting in Python\nChatGPT · '));
  assert.ok(text.includes('\nYou:\n\n') && text.includes('\nChatGPT:\n\n'));
  assert.ok(text.includes('Thanks! Does this work for <script>alert("x")</script> strings'), 'plain text is not escaped');
});

await test('Copy as Markdown puts the document in the clipboard', async () => {
  const page = await open(`${CHATGPT}/c/${CHATGPT_ID}`);
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
  const page = await open(`${CHATGPT}/c/${CHATGPT_ID}`);
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
  // The meta line shows the domain and a link, not the whole URL.
  assert.match(await print.locator('#doc-meta').innerText(), /^ChatGPT · chatgpt\.com · Open original · Exported \d{4}-\d{2}-\d{2} \d{2}:\d{2} · 4 messages$/);
  assert.equal(await print.locator('#doc-meta a').getAttribute('href'), `${CHATGPT}/c/${CHATGPT_ID}`);
  await print.setViewportSize({ width: 1100, height: 900 });
  assert.ok((await print.locator('#doc-meta').boundingBox()).height < 30, 'meta fits on one line');
  await shot(print, 'print-view', { curated: true });
  await shot(print, 'print-view-full', { fullPage: true });
  await print.emulateMedia({ media: 'print' });
  assert.equal(await print.locator('.print-toolbar').isVisible(), false, 'toolbar hidden when printing');
  await toast(page).waitFor();
  assert.match(await toast(page).innerText(), /Print view opened in a new tab/);
});

await test('Pro badges: early access unlocks JSON, PDF, Obsidian and export options', async () => {
  const page = await open(`${CHATGPT}/c/${CHATGPT_ID}`);
  await button(page).click();
  await menu(page).waitFor();
  assert.deepEqual(await badges(page), [
    { action: 'copy', pro: false, locked: false },
    { action: 'handoff', pro: false, locked: false },
    { action: 'select', pro: false, locked: false },
    { action: 'markdown', pro: false, locked: false },
    { action: 'text', pro: false, locked: false },
    { action: 'html', pro: false, locked: false },
    { action: 'obsidian', pro: true, locked: false },
    { action: 'json', pro: true, locked: false },
    { action: 'pdf', pro: true, locked: false },
    { action: 'options', pro: true, locked: false },
  ]);
  assert.equal(await menu(page).locator('.cx-menu-options').count(), 0, 'no options line with the defaults');
  const popup = await openPopup(page);
  await popup.locator('#conversation').waitFor();
  // A quiet "Pro" label on the three Pro tiles, and no lock while early access unlocks them.
  assert.deepEqual(await popup.locator('.format-grid [data-format]:has(.pro-label)').evaluateAll((tiles) => tiles.map((tile) => tile.dataset.format)), ['obsidian', 'json', 'pdf']);
  assert.deepEqual(await popup.locator('.format-grid .pro-label').allInnerTexts(), ['Pro', 'Pro', 'Pro']);
  assert.equal(await popup.locator('.format-grid .pro-label .bi, .options-line .pro-label .bi').count(), 0, 'no locks during early access');
  assert.equal(await popup.locator('.format-grid .locked').count(), 0);
  assert.equal(await popup.locator('#plan-note').innerText(), 'Pro free during early access');
});

await test('Obsidian / Notion Markdown: front matter, tags, role headings', async () => {
  const page = await open(`${CHATGPT}/c/${CHATGPT_ID}`);
  await button(page).click();
  const { name, text } = await download(page, () => menuItem(page, 'obsidian').click());
  assert.match(name, /^Sorting in Python \d{4}-\d{2}-\d{2}\.md$/);
  const today = name.match(/\d{4}-\d{2}-\d{2}/)[0];
  assert.ok(
    text.startsWith(`---\ntitle: "Sorting in Python"\nsource: "ChatGPT"\nurl: "${CHATGPT}/c/${CHATGPT_ID}"\ndate: ${today}\ntags:\n  - "ai-chat"\n  - "chatgpt"\n---\n\n## You\n`),
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

    const page = await open(`${CHATGPT}/c/${CHATGPT_ID}`);
    await button(page).click();
    await menu(page).waitFor();
    assert.equal(await menu(page).locator('.cx-menu-meta').innerText(), 'ChatGPT · 2 of 4 messages');
    assert.equal(await menu(page).locator('.cx-menu-options').innerText(), 'Last 2 messages · Replies only · No code blocks');
    await shot(page, 'menu-options', { curated: true, clip: { x: 520, y: 0, width: 760, height: MENU_CLIP_HEIGHT + 40 } });
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
    const page = await open(`${CHATGPT}/c/${CHATGPT_ID}`);
    await button(page).click();
    await menu(page).waitFor();
    const items = await badges(page);
    assert.deepEqual(items.filter((item) => item.locked).map((item) => item.action), ['obsidian', 'json', 'pdf']);
    assert.equal(await menu(page).locator('.cx-menu-meta').innerText(), 'ChatGPT · 4 messages', 'stored options are not applied on Free');
    assert.equal(await menu(page).locator('.cx-menu-options').count(), 0);
    await shot(page, 'menu-free', { clip: { x: 520, y: 0, width: 760, height: MENU_CLIP_HEIGHT } });

    let downloaded = false;
    page.on('download', () => (downloaded = true));
    await menuItem(page, 'json').click();
    await toast(page).waitFor();
    assert.match(await toast(page).innerText(), /JSON export is part of Pro \(\$2\.99, one-time\)\. Free keeps copying and \.md, \.txt and \.html downloads\./);
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

    // Free exports that are new in this version stay free.
    await button(page).click();
    const html = await download(page, () => menuItem(page, 'html').click());
    assert.match(html.name, /\.html$/);
    await resetClipboard(page);
    await button(page).click();
    await menuItem(page, 'handoff').click();
    await toast(page).filter({ hasText: 'Hand-off prompt copied' }).waitFor();

    const popup = await openPopup(page);
    await popup.locator('#conversation').waitFor();
    assert.equal(await popup.locator('.format-grid .locked').count(), 3);
    assert.deepEqual(await popup.locator('.format-grid .locked').evaluateAll((tiles) => tiles.map((tile) => tile.dataset.format)), ['obsidian', 'json', 'pdf']);
    assert.equal(await popup.locator('.format-grid .locked .pro-label .bi').count(), 3, 'a lock only where the plan lacks the feature');
    assert.equal(await popup.locator('.options-line .pro-label .bi').count(), 1);
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
    assert.deepEqual(response, { ok: false, message: 'PDF is part of Pro ($2.99, one-time). Free keeps copying and .md, .txt and .html downloads.' });

    const options = await openOptions('#options');
    await options.locator('#options-locked').waitFor();
    assert.equal(await options.locator('#options-form').evaluate((fieldset) => fieldset.disabled), true);
    assert.equal(await options.locator('#include-code').isChecked(), false, 'stored choices shown');
    assert.equal(await options.locator('#get-pro').isDisabled(), true);
    assert.equal(await options.locator('#pro-note').innerText(), 'Payments are coming soon.');

    // The history import is Pro: locked calmly, a dropped file is ignored.
    await options.locator('#import-locked').waitFor();
    assert.equal(await options.locator('#choose-file').isDisabled(), true);
    assert.equal(await options.locator('#drop-zone').getAttribute('aria-disabled'), 'true');
    assert.equal(await options.locator('#import .pro-label .bi').count(), 1, 'lock on the Pro label');
    let saved = false;
    options.on('download', () => (saved = true));
    await dropFile(options, 'conversations.json', await readFile(join(fixtures, 'claude-export.json'), 'utf8'), 'application/json');
    assert.equal(await options.locator('#import-working').isVisible(), false);
    assert.equal(await options.locator('#import-done').isVisible(), false);
    await options.locator('#import-locked').scrollIntoViewIfNeeded();
    await shot(options, 'import-locked', { fullPage: true, clip: await sectionClip(options, '#import') });
    assert.equal(saved, false, 'nothing imported on the free plan');
  } finally {
    await clearStorage();
  }
});

await test('About Pro card: price, features, disabled Get Pro during early access', async () => {
  const options = await openOptions('#pro');
  assert.equal(await options.locator('#pro-price').innerText(), '$2.99');
  assert.deepEqual(await options.locator('#pro-features li .fw-semibold').allInnerTexts(), ['Your whole history', 'JSON export', 'PDF', 'Obsidian / Notion Markdown', 'Export options']);
  assert.equal(await options.locator('#get-pro').isDisabled(), true);
  assert.equal(await options.locator('#get-pro').innerText(), 'Get Pro');
  assert.equal(await options.locator('#pro-note').innerText(), 'Free during early access');
  assert.equal(await options.locator('#plan-badge').innerText(), 'Early access: Pro unlocked');
  await shot(options, 'about-pro', { curated: true, fullPage: true, clip: await sectionClip(options, '#pro') });
  await options.emulateMedia({ colorScheme: 'dark' });
  await shot(options, 'about-pro-dark', { fullPage: true, clip: await sectionClip(options, '#pro') });
  // The in-page "Export options" item opens this page.
  const page = await open(`${CHATGPT}/c/${CHATGPT_ID}`);
  await button(page).click();
  const [opened] = await Promise.all([context.waitForEvent('page'), menuItem(page, 'options').click()]);
  openPages.add(opened);
  await opened.waitForURL(/options\.html#options$/);
});

await test('SPA navigation: the button comes back in the re-rendered header and exports the new chat', async () => {
  const page = await open(`${CHATGPT}/c/${CHATGPT_ID}`);
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
  const page = await open(`${CLAUDE}/chat/${CLAUDE_ID}`);
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
  const page = await open(`${CHATGPT}/c/stream-0001-aaaa-bbbb`);
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
  const page = await open(`${CHATGPT}/c/broken-0001-aaaa-bbbb`);
  await button(page).click();
  const warning = menu(page).locator('.cx-menu-warning');
  await warning.waitFor();
  assert.equal(await warning.innerText(), "Couldn't read this conversation, the site may have changed.");
  assert.equal(await menuItem(page, 'markdown').isDisabled(), true);
  assert.equal(await menuItem(page, 'copy').isDisabled(), true);
  await shot(page, 'menu-error', { curated: true, clip: { x: 520, y: 0, width: 760, height: 540 } });
  const popup = await openPopup(page);
  await popup.locator('#error').waitFor();
  assert.equal(await popup.locator('#error-text').innerText(), "Couldn't read this conversation, the site may have changed.");
  await shot(popup, 'popup-error', { curated: true, fit: true });
});

await test('home page (no conversation): no button; popup explains what to do', async () => {
  const page = await open(`${CHATGPT}/`);
  await page.waitForTimeout(800);
  assert.equal(await page.locator('chat-exporter-button').count(), 0);
  const popup = await openPopup(page);
  await popup.locator('#empty').waitFor();
  assert.match(await popup.locator('#empty').innerText(), /Open a ChatGPT or Claude conversation to export it\./);
});

await test('popup: exports the conversation in the active tab', async () => {
  const page = await open(`${CHATGPT}/c/${CHATGPT_ID}`);
  await button(page).waitFor();
  const popup = await openPopup(page);
  await popup.locator('#conversation').waitFor();
  assert.equal(await popup.locator('#title').innerText(), 'Sorting in Python');
  assert.equal(await popup.locator('#site-badge').innerText(), 'ChatGPT');
  assert.equal(await popup.locator('#count').innerText(), '4 messages');
  // No reserved space under the export options before the settings (it used to leave a gap).
  const gap = await popup.evaluate(() => document.querySelector('section[aria-label="Settings"]').getBoundingClientRect().top - document.querySelector('.options-line').getBoundingClientRect().bottom);
  assert.ok(gap <= 34, `gap under the export options: ${gap}px`);
  assert.equal(await popup.locator('#status').evaluate((status) => status.getBoundingClientRect().height), 0);
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
  await popup.bringToFront();
  await popup.locator('#handoff').click();
  await popup.locator('#status', { hasText: /^Hand-off prompt copied: [\d,]+ characters · ≈[\d,]+ tokens\. Paste it into a new chat in any AI\.$/ }).waitFor();
  await popup.evaluate(() => document.activeElement?.blur());
  await popup.mouse.move(1, 1);
  await popup.emulateMedia({ colorScheme: 'dark' });
  await shot(popup, 'popup-dark', { curated: true, fit: true });
});

await test('popup: empty state on other pages (light and dark)', async () => {
  const page = await open(`${NEWS}/`);
  const popup = await openPopup(page);
  await popup.locator('#empty').waitFor();
  await shot(popup, 'popup-empty', { curated: true, fit: true });
  await popup.emulateMedia({ colorScheme: 'dark' });
  await shot(popup, 'popup-empty-dark', { fit: true });
});

await test('setting: turning the button off removes it from open chat pages', async () => {
  const page = await open(`${CHATGPT}/c/${CHATGPT_ID}`);
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
  const page = await open(`${CHATGPT}/c/${CHATGPT_ID}?theme=dark`);
  await button(page).waitFor();
  const theme = await page.evaluate(() => document.querySelector('chat-exporter-button').shadowRoot.querySelector('.cx-theme').dataset.bsTheme);
  assert.equal(theme, 'dark');
  await button(page).click();
  await menu(page).waitFor();
  await shot(page, 'menu-dark', { curated: true, clip: { x: 520, y: 0, width: 760, height: MENU_CLIP_HEIGHT } });
  const claude = await open(`${CLAUDE}/chat/${CLAUDE_ID}?theme=dark`);
  await button(claude).waitFor();
  await shot(claude, 'claude-floating-dark', { clip: { x: 520, y: 0, width: 760, height: 360 } });
});

await test('hostile page CSS does not reach the button', async () => {
  const page = await open(`${CHATGPT}/c/${CHATGPT_ID}?hostile=1`);
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

await test('HTML: one self-contained file, light and dark, domain and a link to the original', async () => {
  const page = await open(`${CHATGPT}/c/${CHATGPT_ID}`);
  await button(page).click();
  const { name, text } = await download(page, () => menuItem(page, 'html').click());
  assert.match(name, /^Sorting in Python \d{4}-\d{2}-\d{2}\.html$/);
  assert.ok(text.startsWith('<!doctype html>'));
  assert.ok(!/<script|<link|<img|<iframe|\ssrc=|url\(/i.test(text), 'no scripts, no external or embedded resources');
  assert.ok(text.includes("<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'\">"));
  assert.ok(text.includes('@media (prefers-color-scheme: dark)'));
  assert.match(await toast(page).innerText(), /HTML file downloaded\./);

  // Open the file as a reader would.
  const viewer = await newPage();
  await viewer.setViewportSize({ width: 1000, height: 820 });
  const blocked = [];
  viewer.on('request', (request) => {
    if (!request.url().startsWith('data:') && request.url() !== 'about:blank') blocked.push(request.url());
  });
  await viewer.setContent(text);
  assert.equal(await viewer.locator('h1').innerText(), 'Sorting in Python');
  assert.equal(await viewer.locator('.meta').innerText(), `ChatGPT · chatgpt.com · Open original · Exported ${text.match(/Exported (\d{4}-\d{2}-\d{2} \d{2}:\d{2})/)[1]} · 4 messages`);
  assert.equal(await viewer.locator('.meta a').getAttribute('href'), `${CHATGPT}/c/${CHATGPT_ID}`);
  assert.equal(await viewer.locator('.message').count(), 4);
  assert.ok((await viewer.locator('.code-block pre code.language-python').innerText()).includes('itemgetter'));
  assert.ok((await viewer.locator('.message.user').nth(1).innerText()).includes('<script>alert("x")</script>'), 'typed markup shown literally');
  const background = () => viewer.evaluate(() => getComputedStyle(document.body).backgroundColor);
  assert.equal(await background(), 'rgb(255, 255, 255)');
  await shot(viewer, 'html-export', { curated: true });
  await viewer.emulateMedia({ colorScheme: 'dark' });
  assert.equal(await background(), 'rgb(21, 24, 27)', 'follows the dark setting');
  await shot(viewer, 'html-export-dark', { curated: true });
  assert.deepEqual(blocked, [], 'opening the file loads nothing');
});

await test('Continue in another AI: a hand-off prompt with its size, from the menu and the popup', async () => {
  const page = await open(`${CHATGPT}/c/${CHATGPT_ID}`);
  await resetClipboard(page);
  await button(page).click();
  const size = await menuItem(page, 'handoff').locator('.cx-ext').innerText();
  assert.match(size, /^≈\d+ tokens$/);
  await menuItem(page, 'handoff').click();
  await toast(page).waitFor();
  const message = await toast(page).innerText();
  const match = /Hand-off prompt copied: ([\d,]+) characters · ≈([\d,]+) tokens\. Paste it into a new chat in any AI\./.exec(message);
  assert.ok(match, message);
  await shot(page, 'toast-handoff', { curated: true, clip: { x: 640, y: 560, width: 640, height: 240 } });
  const prompt = await clipboard(page);
  assert.equal(prompt.length, Number(match[1].replace(/,/g, '')), 'the count is the prompt length');
  assert.equal(`≈${match[2]} tokens`, size, 'same estimate as in the menu');
  assert.ok(prompt.startsWith('Here is our earlier conversation from ChatGPT. Continue from where it ends.\n\nTitle: Sorting in Python\n\n<conversation>\n[User]\n'), prompt.slice(0, 200));
  assert.ok(prompt.includes('[ChatGPT]\nUse `sorted()` with a **key function**.'));
  assert.ok(prompt.includes('```python\nfrom operator import itemgetter'), 'code kept');
  assert.ok(prompt.endsWith('</conversation>\n'));

  const popup = await openPopup(page);
  await popup.locator('#conversation').waitFor();
  assert.equal(await popup.locator('#handoff-size').innerText(), size);
  await resetClipboard(page);
  await popup.bringToFront();
  await popup.locator('#handoff').click();
  await popup.locator('#status', { hasText: 'Hand-off prompt copied' }).waitFor();
  assert.equal(await clipboard(page), prompt, 'popup copies the same prompt');
});

await test('Select messages: checkboxes beside the messages, a bar, and exports of just those', async () => {
  const page = await open(`${CHATGPT}/c/${CHATGPT_ID}`);
  const threadBefore = await page.locator('#thread').evaluate((thread) => thread.outerHTML);
  await button(page).click();
  await menuItem(page, 'select').click();
  const picks = page.locator('chat-exporter-ui .cx-pick');
  const bar = page.locator('chat-exporter-ui .cx-select-bar');
  await bar.waitFor();
  assert.equal(await picks.count(), 4);
  assert.equal(await bar.locator('.cx-select-count').innerText(), 'Pick the messages to export');
  assert.equal(await bar.locator('.cx-select-export').isDisabled(), true, 'nothing to export yet');
  assert.equal(await page.evaluate(() => document.querySelector('chat-exporter-ui').shadowRoot.activeElement?.getAttribute('aria-label')), 'Select your message 1', 'focus on the first checkbox');
  // Each visible checkbox sits at the top left of its message.
  const boxes = await page.evaluate(() => {
    const messages = Array.from(document.querySelectorAll('[data-message-author-role]'), (element) => (element.querySelector('.markdown') ?? element).getBoundingClientRect());
    const picks = Array.from(document.querySelector('chat-exporter-ui').shadowRoot.querySelectorAll('.cx-pick'), (pick) => (pick.hidden ? null : pick.getBoundingClientRect()));
    const top = document.querySelector('.fx-scroll').getBoundingClientRect().top;
    return messages.map((message, index) => ({ top, message: { x: message.x, y: message.y, bottom: message.bottom }, pick: picks[index] && { x: picks[index].x, y: picks[index].y, right: picks[index].right } }));
  });
  for (const [index, { top, message, pick }] of boxes.entries()) {
    if (message.y > 792 || message.bottom < top + 8) continue;
    assert.ok(pick && pick.right <= message.x && Math.abs(pick.y - Math.max(message.y + 2, top + 8)) <= 2, `pick ${index} beside its message: ${JSON.stringify({ pick, message })}`);
  }
  await picks.nth(1).click();
  assert.equal(await bar.locator('.cx-select-count').innerText(), '1 selected');
  // The checkboxes follow the page as it scrolls; the keyboard works too.
  await page.locator('.fx-scroll').evaluate((scroller) => (scroller.scrollTop = scroller.scrollHeight));
  await picks.nth(3).waitFor({ state: 'visible' });
  await picks.nth(3).locator('input').focus();
  await page.keyboard.press('Space');
  assert.equal(await bar.locator('.cx-select-count').innerText(), '2 selected');
  assert.equal(await page.locator('chat-exporter-ui .cx-pick-frame').nth(3).isVisible(), true, 'selected messages are outlined');
  const header = await page.locator('.fx-header').boundingBox();
  for (const index of [0, 1]) {
    const pick = await page.locator('chat-exporter-ui .cx-pick').nth(index).boundingBox();
    assert.ok(!pick || pick.y >= header.y + header.height, `checkbox ${index} stays out of the site's header`);
  }
  assert.equal(await page.locator('chat-exporter-ui .cx-pick-frame').nth(2).isVisible(), false);
  assert.equal(await page.locator('#thread').evaluate((thread) => thread.outerHTML), threadBefore, "the site's DOM is untouched");
  await page.mouse.move(700, 300);
  await shot(page, 'select-messages-fixture');

  await bar.locator('.cx-select-export').click();
  await menu(page).waitFor();
  assert.equal(await menu(page).locator('.cx-menu-meta').innerText(), 'ChatGPT · 2 of 4 messages selected');
  assert.equal(await menuItem(page, 'select').count(), 0);
  assert.equal(await menuItem(page, 'options').count(), 0);
  await shot(page, 'select-menu', { clip: { x: 240, y: 180, width: 800, height: 620 } });
  const { text } = await download(page, () => menuItem(page, 'markdown').click());
  assert.equal(text.match(/^## ChatGPT$/gm)?.length, 2);
  assert.equal(text.match(/^## You$/gm), null, 'only the selected replies');
  assert.ok(text.includes('- Messages: 2'));
  assert.match(await toast(page).innerText(), /Markdown file downloaded \(2 messages\)\./);
  await bar.waitFor({ state: 'detached' });
  assert.equal(await picks.count(), 0, 'selection ends after the export');

  // Escape (or Cancel) leaves without exporting; a selection works for the hand-off too.
  await button(page).click();
  await menuItem(page, 'select').click();
  await bar.waitFor();
  await page.keyboard.press('Escape');
  await bar.waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => document.activeElement?.localName), 'chat-exporter-button', 'focus back on the Export button');
  await page.locator('.fx-scroll').evaluate((scroller) => (scroller.scrollTop = 0));
  await button(page).click();
  await menuItem(page, 'select').click();
  await picks.nth(0).click();
  await bar.locator('.cx-select-export').click();
  await resetClipboard(page);
  await menuItem(page, 'handoff').click();
  await toast(page).filter({ hasText: 'Hand-off prompt copied' }).waitFor();
  const prompt = await clipboard(page);
  assert.ok(prompt.includes('[User]\n[Image: Uploaded image]') && !prompt.includes('[ChatGPT]'), prompt.slice(0, 400));
});

await test('Select messages on an everyday chat (screenshot)', async () => {
  const page = await open(`${CHATGPT}/c/${WEEKEND_ID}`);
  await button(page).click();
  assert.equal(await menu(page).locator('.cx-menu-meta').innerText(), 'ChatGPT · 4 messages');
  await menuItem(page, 'select').click();
  const picks = page.locator('chat-exporter-ui .cx-pick');
  const bar = page.locator('chat-exporter-ui .cx-select-bar');
  await bar.waitFor();
  assert.equal(await picks.count(), 4);
  for (let index = 0; index < 4; index++) assert.equal(await picks.nth(index).isVisible(), true, `checkbox ${index} visible`);
  await picks.nth(1).click();
  await picks.nth(3).click();
  assert.equal(await bar.locator('.cx-select-count').innerText(), '2 selected');
  await page.mouse.move(700, 300);
  await page.evaluate(() => document.querySelector('chat-exporter-ui').shadowRoot.activeElement?.blur());
  await shot(page, 'select-messages', { curated: true });
  await bar.locator('.cx-select-export').click();
  const { text } = await download(page, () => menuItem(page, 'markdown').click());
  assert.equal(text.match(/^## ChatGPT$/gm)?.length, 2);
  assert.ok(text.includes('#### Friday evening') && text.includes('About **9,000 UAH** for the two of you:'));
});

await test('Select messages on Claude and after navigation', async () => {
  const page = await open(`${CLAUDE}/chat/${CLAUDE_ID}`);
  await button(page).click();
  await menuItem(page, 'select').click();
  await page.locator('chat-exporter-ui .cx-select-bar').waitFor();
  assert.equal(await page.locator('chat-exporter-ui .cx-pick').count(), 4);
  assert.deepEqual(await page.locator('chat-exporter-ui .cx-pick input').evaluateAll((inputs) => inputs.map((input) => input.getAttribute('aria-label'))), [
    'Select your message 1',
    'Select Claude reply 1',
    'Select your message 2',
    'Select Claude reply 2',
  ]);
  await page.locator('chat-exporter-ui .cx-select-cancel').click();
  await page.locator('chat-exporter-ui .cx-select-bar').waitFor({ state: 'detached' });

  const chat = await open(`${CHATGPT}/c/${CHATGPT_ID}`);
  await button(chat).click();
  await menuItem(chat, 'select').click();
  await chat.locator('chat-exporter-ui .cx-select-bar').waitFor();
  await chat.evaluate((id) => window.fixture.navigate(id, 'conversation-lviv', 'Trip to Lviv'), LVIV_ID);
  await chat.locator('chat-exporter-ui .cx-select-bar').waitFor({ state: 'detached' });
});

// --- Your whole history ----------------------------------------------------------------------

const chatgptExportJson = await readFile(join(fixtures, 'chatgpt-export.json'), 'utf8');
const claudeExportJson = await readFile(join(fixtures, 'claude-export.json'), 'utf8');
const localDay = (iso) => {
  const date = new Date(iso);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};

await test('history import: the ChatGPT zip becomes one Markdown file per conversation plus index.md', async () => {
  const options = await openOptions('#import');
  assert.equal(await options.locator('#import-locked').isVisible(), false);
  assert.equal(await options.locator('#import .pro-label').innerText(), 'Pro');
  assert.equal(await options.locator('#import .pro-label .bi').count(), 0, 'no lock during early access');
  await shot(options, 'import-idle', { curated: true, fullPage: true, clip: await sectionClip(options, '#import') });
  const zip = makeZip([
    { name: 'chat.html', data: '<html><body>Chat history</body></html>' },
    { name: 'user.json', data: '{"id":"user-1"}' },
    { name: 'conversations.json', data: chatgptExportJson },
    { name: 'file-Abc123-benchmark.png', data: await readFile(join(root, 'static/icons/icon128.png')) },
  ]);
  const { name, bytes } = await downloadBytes(options, () => options.locator('#import-file').setInputFiles({ name: 'chatgpt-export.zip', mimeType: 'application/zip', buffer: zip }));
  assert.match(name, /^ChatGPT history \d{4}-\d{2}-\d{2}\.zip$/);
  await options.locator('#import-done').waitFor();
  assert.equal(await options.locator('#import-headline').innerText(), '4 conversations · 10 messages');
  assert.match(await options.locator('#import-file-line').innerText(), /^Downloaded ChatGPT history \d{4}-\d{2}-\d{2}\.zip \([\d.]+ KB\): one Markdown file per conversation and index\.md\. Read from conversations\.json\.$/);
  assert.deepEqual(await options.locator('#import-skipped li').allInnerTexts(), [
    '3 system or tool messages (not shown in the chat)',
    "1 part with content that isn't text: thoughts (1)",
    '1 conversation with nothing to export',
  ]);
  assert.deepEqual(await options.locator('#import-recent .recent-title').allInnerTexts(), ['Sorting in Python', 'Sorting in Python', 'Trip to Lviv', 'Regex for ISO dates like 2026-09-27?']);
  assert.equal(await options.evaluate(() => document.activeElement?.id), 'import-again', 'focus on the result');

  const files = readZip(bytes);
  const sorting = `Sorting in Python ${localDay('2026-09-27T10:02:03Z')}.md`;
  assert.deepEqual([...files.keys()], [
    sorting,
    `Trip to Lviv ${localDay('2026-08-14T18:20:00Z')}.md`,
    `Regex for ISO dates like 2026-09-27 ${localDay('2026-03-02T09:00:00Z')}.md`,
    `Sorting in Python ${localDay('2026-09-27T16:40:00Z')} (2).md`,
    'index.md',
  ]);
  const note = files.get(sorting);
  assert.ok(note.startsWith(`---\ntitle: "Sorting in Python"\nsource: "ChatGPT"\nurl: "https://chatgpt.com/c/${CHATGPT_ID}"\ndate: ${localDay('2026-09-27T10:02:03Z')}\ncreated: `), note.slice(0, 300));
  assert.ok(!note.includes('OLD BRANCH'), 'only the visible branch');
  assert.ok(note.includes('```python\nfrom operator import itemgetter'));
  assert.ok(files.get('index.md').startsWith('# ChatGPT history\n\n- Conversations: 4\n- Messages: 10\n'));

  // "Download again" saves the same zip.
  const again = await downloadBytes(options, () => options.locator('#import-again').click());
  assert.equal(again.name, name);
  assert.ok(again.bytes.equals(bytes));
  await options.locator('#import-reset').click();
  await options.locator('#drop-zone').waitFor();
});

await test('history import: a dropped Claude conversations.json, with the Markdown format and the file name template', async () => {
  try {
    await setStorage({ settings: { showButton: true, exportOptions: { includeCode: true, includeUser: true, lastMessages: 0, filenameTemplate: '{date} {title}', tags: ['ai-chat'], callouts: false } } });
    const options = await openOptions('#import');
    await options.locator('#format-markdown').check();
    // The drop zone highlights while a file is dragged over it.
    await options.evaluate(() => {
      const transfer = new DataTransfer();
      transfer.items.add(new File(['[]'], 'conversations.json'));
      document.getElementById('drop-zone').dispatchEvent(new DragEvent('dragenter', { dataTransfer: transfer, bubbles: true, cancelable: true }));
    });
    assert.equal(await options.locator('#drop-zone.dragover').count(), 1);
    await options.evaluate(() => document.getElementById('drop-zone').dispatchEvent(new DragEvent('dragleave', { bubbles: true })));
    assert.equal(await options.locator('#drop-zone.dragover').count(), 0);

    const { name, bytes } = await downloadBytes(options, () => dropFile(options, 'conversations.json', claudeExportJson, 'application/json'));
    assert.match(name, /^Claude history \d{4}-\d{2}-\d{2}\.zip$/);
    await options.locator('#import-done').waitFor();
    assert.equal(await options.locator('#import-headline').innerText(), '2 conversations · 6 messages');
    assert.deepEqual(await options.locator('#import-skipped li').allInnerTexts(), ["1 part with content that isn't text: thinking (1)", '1 conversation with nothing to export']);
    const files = readZip(bytes);
    const rust = `${localDay('2026-09-20T07:15:00Z')} Rust ownership basics.md`;
    assert.deepEqual([...files.keys()].sort(), [`${localDay('2026-07-01T12:00:00Z')} Draft a polite reminder about the unpaid invoice #1042.md`, rust, 'index.md'].sort());
    const note = files.get(rust);
    assert.ok(note.startsWith('# Rust ownership basics\n\n- Source: Claude\n- URL: <https://claude.ai/chat/0f3c2a9e-5b1d-4c8e-9a77-2d4e6f8a1b2c>\n- Created: '), note.slice(0, 300));
    assert.ok(note.includes('## Claude\n\nEvery value has **one owner**.'));
    assert.ok(note.includes('\\[File: main.rs\\]'));
  } finally {
    await clearStorage();
  }
});

await test('history import: clear errors, and Cancel stops a large import without saving', async () => {
  const options = await openOptions('#import');
  let saved = 0;
  options.on('download', () => saved++);
  await options.locator('#import-file').setInputFiles({ name: 'photos.zip', mimeType: 'application/zip', buffer: makeZip([{ name: 'IMG_0001.jpg', data: 'jpeg' }]) });
  await options.locator('#import-error').waitFor();
  assert.equal(
    await options.locator('#import-error-text').innerText(),
    'This zip has no conversations.json. Use the zip from ChatGPT (Settings → Data controls → Export data) or Claude (Settings → Privacy → Export data).',
  );
  await shot(options, 'import-error', { curated: true, fullPage: true, clip: await sectionClip(options, '#import') });
  await options.locator('#import-file').setInputFiles({ name: 'notes.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7\n') });
  await options.locator('#import-error-text', { hasText: "This isn't a zip or a JSON file." }).waitFor();
  await options.locator('#import-file').setInputFiles({ name: 'conversations.json', mimeType: 'application/json', buffer: Buffer.from('[{"title": "x"}]') });
  await options.locator('#import-error-text', { hasText: 'No ChatGPT or Claude conversations were found' }).waitFor();
  const damaged = makeZip([{ name: 'conversations.json', data: chatgptExportJson }]);
  damaged[80] ^= 0xff;
  await options.locator('#import-file').setInputFiles({ name: 'export.zip', mimeType: 'application/zip', buffer: damaged });
  await options.locator('#import-error-text', { hasText: /damaged|can't be read/ }).waitFor();

  // A big export (about 40 MB of JSON) takes long enough to cancel. Passed as a file on disk, like
  // a real pick (a buffer this size would take seconds to hand to the browser).
  const bigDir = await mkdtemp(join(tmpdir(), 'chat-exporter-export-'));
  const big = join(bigDir, 'conversations.json');
  await writeFile(big, `[${Array.from({ length: 12000 }, () => JSON.stringify(JSON.parse(chatgptExportJson)[0])).join(',')}]`);
  await options.locator('#import-file').setInputFiles(big);
  await options.locator('#import-working').waitFor();
  assert.equal(await options.evaluate(() => document.activeElement?.id), 'import-cancel');
  await options.waitForFunction(() => Number(document.getElementById('import-progress').getAttribute('aria-valuenow')) > 0);
  await shot(options, 'import-working', { fullPage: true, clip: await sectionClip(options, '#import') });
  await options.locator('#import-cancel').click();
  await options.locator('#import-note-text', { hasText: 'Import cancelled. Nothing was saved.' }).waitFor();
  await rm(bigDir, { recursive: true, force: true });
  assert.equal(await options.locator('#import-error').isVisible(), false);
  await options.waitForTimeout(300);
  assert.equal(saved, 0, 'nothing saved by failed or cancelled imports');
});

await test('history import: a realistic 148-conversation export (screenshots)', async () => {
  const options = await openOptions('#import');
  const zip = makeZip([
    { name: 'conversations.json', data: realisticExport() },
    { name: 'message_feedback.json', data: '[]' },
    { name: 'chat.html', data: '<html></html>' },
  ]);
  const { bytes } = await downloadBytes(options, () => options.locator('#import-file').setInputFiles({ name: 'export.zip', mimeType: 'application/zip', buffer: zip }));
  await options.locator('#import-done').waitFor();
  assert.equal(await options.locator('#import-headline').innerText(), '148 conversations · 1,040 messages');
  const files = readZip(bytes);
  assert.equal(files.size, 149);
  assert.equal(new Set([...files.keys()].map((file) => file.toLowerCase())).size, 149, 'unique names');
  await options.locator('#import').scrollIntoViewIfNeeded();
  await options.evaluate(() => document.activeElement?.blur());
  await shot(options, 'import-summary', { curated: true, fullPage: true, clip: await sectionClip(options, '#import') });
  await options.emulateMedia({ colorScheme: 'dark' });
  await shot(options, 'import-summary-dark', { curated: true, fullPage: true, clip: await sectionClip(options, '#import') });
});

await test('no network requests leave the browser', async () => {
  const requests = [];
  const listener = (request) => {
    const url = request.url();
    if (!FIXTURE_ORIGINS.some((origin) => url.startsWith(`${origin}/`)) && !url.startsWith('chrome-extension://') && !url.startsWith('data:') && !url.startsWith('blob:')) requests.push(url);
  };
  context.on('request', listener);
  const page = await open(`${CHATGPT}/c/${CHATGPT_ID}`);
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
