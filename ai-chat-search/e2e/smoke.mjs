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
const DAY = 24 * 60 * 60 * 1000;

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
    response.writeHead(200, { 'content-type': `${type}; charset=utf-8` }).end(await readFile(join(fixtures, file)));
  } catch {
    response.writeHead(404).end('not found');
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

// --- Browser ----------------------------------------------------------------------------

await mkdir(outputDir, { recursive: true });
await mkdir(screenshotsDir, { recursive: true });
const userDataDir = await mkdtemp(join(tmpdir(), 'ai-chat-search-e2e-'));
const context = await chromium.launchPersistentContext(userDataDir, {
  executablePath: findChromium(),
  headless,
  acceptDownloads: true,
  viewport: { width: 1280, height: 800 },
  args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
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

async function openPopup(forPage) {
  const tabId = forPage ? await tabIdOf(forPage) : '';
  const popup = await newPage();
  await popup.setViewportSize({ width: 380, height: 600 });
  await popup.goto(`${extensionOrigin}/popup.html?tab=${tabId}`);
  return popup;
}

async function openSearchPage(query = '') {
  const page = await newPage();
  await page.goto(`${extensionOrigin}/search.html${query ? `?q=${encodeURIComponent(query)}` : ''}`);
  await page.locator('#state-loading').waitFor({ state: 'hidden' });
  return page;
}

async function waitFor(check, message, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${message}`);
}

const saved = () => worker.evaluate(() => globalThis.__searchTest.all());
const clearIndex = () => worker.evaluate(() => globalThis.__searchTest.clear());
const setAutoSave = (autoSave) => worker.evaluate((autoSave) => chrome.storage.local.set({ settings: { autoSave } }), autoSave);

async function savedRecord(key) {
  return (await saved()).find((record) => record.key === key);
}

function conversation(site, id, title, texts) {
  return {
    site,
    conversationId: id,
    title,
    url: site === 'claude' ? `https://claude.ai/chat/${id}` : `https://chatgpt.com/c/${id}`,
    streaming: false,
    messages: texts.map((text, index) => ({ role: index % 2 === 0 ? 'user' : 'assistant', markdown: text, text })),
  };
}

async function seedRankingData() {
  const now = Date.now();
  const items = [
    { conversation: conversation('chatgpt', 'rank-title', 'Python packaging guide', ['How do I publish a package?', 'Build a wheel, then upload it. Python has twine for that.']), at: now - 40 * DAY },
    { conversation: conversation('chatgpt', 'rank-many', 'Weekend plans', ['python python python', 'More python here, python again and python.']), at: now - 41 * DAY },
    { conversation: conversation('chatgpt', 'rank-old', 'Old script notes', ['I once used python for scripts.', 'Fine.']), at: now - 200 * DAY },
    { conversation: conversation('claude', 'rank-new', 'New script notes', ['I once used python for scripts.', 'Nice.']), at: now - 1 * DAY },
    { conversation: conversation('claude', 'rank-other', 'Kyiv coffee', ['Де випити кави у Києві?', 'Спробуйте кав’ярні на Подолі.']), at: now - 5 * DAY },
  ];
  await worker.evaluate((items) => globalThis.__searchTest.seed(items), items);
}

const resultTitles = (page) => page.locator('#results .result-title').allInnerTexts();

async function shot(page, name, options = {}) {
  const { curated = false, fit = false, ...rest } = options;
  const path = join(outputDir, `${name}.png`);
  await page.waitForTimeout(300);
  if (fit) {
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
    await clearIndex();
    await setAutoSave(true);
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

await test('manifest: production build asks only for storage, unlimitedStorage and the three chat origins', async () => {
  const manifest = JSON.parse(await readFile(join(root, 'dist/manifest.json'), 'utf8'));
  assert.deepEqual(manifest.permissions, ['storage', 'unlimitedStorage']);
  assert.equal(manifest.host_permissions, undefined);
  assert.equal(manifest.optional_permissions, undefined);
  assert.equal(manifest.web_accessible_resources, undefined);
  assert.deepEqual(manifest.content_scripts.map((script) => script.matches), [
    ['https://chatgpt.com/*', 'https://chat.openai.com/*', 'https://claude.ai/*'],
  ]);
  const productionScript = await readFile(join(root, 'dist/content.js'), 'utf8');
  assert.ok(!productionScript.includes('127.0.0.1'), 'fixture origin compiled out of production');
  const productionWorker = await readFile(join(root, 'dist/background.js'), 'utf8');
  assert.ok(!productionWorker.includes('__searchTest'), 'test hooks compiled out of production');
});

await test('auto-index: opening a ChatGPT conversation saves it', async () => {
  await open(`/chatgpt/c/${CHATGPT_ID}`);
  await waitFor(async () => Boolean(await savedRecord(`chatgpt:${CHATGPT_ID}`)), 'conversation saved');
  const record = await savedRecord(`chatgpt:${CHATGPT_ID}`);
  assert.equal(record.title, 'Sorting in Python');
  assert.equal(record.url, `${base}/chatgpt/c/${CHATGPT_ID}`);
  assert.deepEqual(record.messages.map((message) => message.role), ['user', 'assistant', 'user', 'assistant']);
  assert.ok(record.messages[1].text.includes('by_age = sorted(people, key=itemgetter("age"))'));
  assert.ok(!record.messages.some((message) => message.text.includes('Copy code')));
  assert.ok(record.searchText.includes(' itemgetter '));
});

await test('auto-index: Claude too, and SPA navigation saves the next conversation', async () => {
  await open(`/claude/chat/${CLAUDE_ID}`);
  await waitFor(async () => Boolean(await savedRecord(`claude:${CLAUDE_ID}`)), 'Claude conversation saved');
  assert.equal((await savedRecord(`claude:${CLAUDE_ID}`)).title, 'Rust ownership basics');
  const page = await open(`/chatgpt/c/${CHATGPT_ID}`);
  await waitFor(async () => Boolean(await savedRecord(`chatgpt:${CHATGPT_ID}`)), 'first conversation saved');
  await page.evaluate((id) => window.fixture.navigate(id, 'conversation-lviv', 'Trip to Lviv'), LVIV_ID);
  await waitFor(async () => Boolean(await savedRecord(`chatgpt:${LVIV_ID}`)), 'navigated conversation saved');
  const lviv = await savedRecord(`chatgpt:${LVIV_ID}`);
  assert.equal(lviv.title, 'Trip to Lviv');
  assert.ok(lviv.messages[0].text.startsWith('Сплануй поїздку до Львова'));
  assert.equal((await saved()).length, 3);
});

await test('auto-index: re-opening an unchanged conversation does not duplicate or bump it', async () => {
  await open(`/chatgpt/c/${CHATGPT_ID}`);
  await waitFor(async () => Boolean(await savedRecord(`chatgpt:${CHATGPT_ID}`)), 'saved');
  const first = await savedRecord(`chatgpt:${CHATGPT_ID}`);
  const again = await open(`/chatgpt/c/${CHATGPT_ID}`);
  await waitFor(async () => (await savedRecord(`chatgpt:${CHATGPT_ID}`)).savedAt > first.savedAt, 'saved again', 6000).catch(() => undefined);
  const second = await savedRecord(`chatgpt:${CHATGPT_ID}`);
  assert.equal((await saved()).length, 1);
  assert.equal(second.updatedAt, first.updatedAt);
  assert.equal(second.createdAt, first.createdAt);
  await again.close();
});

await test('streaming: a reply being written is saved only once it is finished', async () => {
  const page = await open('/chatgpt/c/stream-0001-aaaa-bbbb');
  await page.evaluate(() => window.fixture.write('<p>Chunk one…</p>'));
  await page.waitForTimeout(1500);
  assert.equal(await savedRecord('chatgpt:stream-0001-aaaa-bbbb'), undefined, 'nothing saved while streaming');
  await page.evaluate(() => window.fixture.finish());
  await waitFor(async () => Boolean(await savedRecord('chatgpt:stream-0001-aaaa-bbbb')), 'saved after finishing');
  const record = await savedRecord('chatgpt:stream-0001-aaaa-bbbb');
  assert.ok(record.messages[1].text.includes('It checks the shape only, not whether the date exists.'), record.messages[1].text);
});

await test('auto-save off: nothing is saved until "Save this conversation"', async () => {
  await setAutoSave(false);
  const page = await open(`/claude/chat/${CLAUDE_ID}`);
  await page.waitForTimeout(1500);
  assert.deepEqual(await saved(), []);
  const popup = await openPopup(page);
  await popup.locator('#conversation').waitFor();
  assert.equal(await popup.locator('#title').innerText(), 'Rust ownership basics');
  assert.equal(await popup.locator('#saved-state').innerText(), 'Not saved yet');
  assert.equal(await popup.locator('#auto-save').isChecked(), false);
  await shot(popup, 'popup-not-saved', { fit: true });
  await popup.locator('#save').click();
  await popup.locator('#status', { hasText: 'Saved. It will show up in search.' }).waitFor();
  assert.match(await popup.locator('#saved-state').innerText(), /Saved just now/);
  assert.equal((await saved()).length, 1);
  assert.match(await popup.locator('#stats').innerText(), /^1 conversation saved · /);
});

await test('popup: privacy explanation, search box opens the search page', async () => {
  const page = await open(`/chatgpt/c/${CHATGPT_ID}`);
  await waitFor(async () => Boolean(await savedRecord(`chatgpt:${CHATGPT_ID}`)), 'saved');
  const popup = await openPopup(page);
  await popup.locator('#conversation').waitFor();
  assert.match(await popup.locator('.privacy-note').innerText(), /saved in this browser .* Nothing is uploaded, and private windows are never saved\./);
  assert.equal(await popup.locator('#auto-save').isChecked(), true);
  await popup.locator('#saved-state', { hasText: 'Saved' }).waitFor();
  await shot(popup, 'popup-light', { curated: true, fit: true });
  await popup.emulateMedia({ colorScheme: 'dark' });
  await shot(popup, 'popup-dark', { curated: true, fit: true });
  await popup.locator('#query').fill('itemgetter');
  // The popup opens the search page in a tab and closes itself.
  const [search] = await Promise.all([context.waitForEvent('page'), popup.keyboard.press('Enter').catch(() => undefined)]);
  openPages.add(search);
  await waitFor(() => popup.isClosed(), 'popup closed after opening the search page');
  await search.waitForURL(/search\.html\?q=itemgetter/);
  await search.locator('#results .result-title').first().waitFor();
  assert.deepEqual(await resultTitles(search), ['Sorting in Python']);
});

await test('search: ranking by title, frequency and recency; highlights with <mark>', async () => {
  await seedRankingData();
  const page = await openSearchPage('python');
  await page.locator('#results .result-title').first().waitFor();
  assert.deepEqual(await resultTitles(page), ['Python packaging guide', 'Weekend plans', 'New script notes', 'Old script notes']);
  assert.match(await page.locator('#summary').innerText(), /^4 results · (<1|\d+) ms$/);
  assert.equal(await page.locator('#results li').first().locator('.result-title mark').innerText(), 'Python');
  const marks = await page.locator('#results li').nth(1).locator('.result-snippet mark').allInnerTexts();
  assert.ok(marks.length >= 3 && marks.every((text) => text.toLowerCase() === 'python'), marks.join(','));
  assert.equal(await page.locator('#results script, #results img').count(), 0);
  await page.setViewportSize({ width: 1280, height: 720 });
  await shot(page, 'search-results-light', { curated: true });
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot(page, 'search-results-dark', { curated: true });
});

await test('search: phrases, prefixes, AND, Cyrillic and diacritics, site filter', async () => {
  await seedRankingData();
  await open(`/claude/chat/${CLAUDE_ID}`);
  await waitFor(async () => Boolean(await savedRecord(`claude:${CLAUDE_ID}`)), 'Claude fixture saved');
  const page = await openSearchPage();
  const search = async (query) => {
    await page.locator('#query').fill(query);
    await page.waitForFunction((query) => new URLSearchParams(location.search).get('q') === query || (!query && !location.search.includes('q=')), query);
    return resultTitles(page);
  };
  assert.deepEqual(await search('"used python for scripts"'), ['New script notes', 'Old script notes']);
  assert.deepEqual(await search('"python for used"'), []);
  assert.ok(await page.locator('#state-no-results').isVisible());
  assert.match(await page.locator('#no-results-title').innerText(), /No conversations match “"python for used"”\./);
  assert.deepEqual(await search('pack wheel'), ['Python packaging guide']);
  assert.deepEqual(await search('КАВЯРНІ подолі'), ['Kyiv coffee']);
  assert.deepEqual(await search('CAFE привіт'), ['Rust ownership basics']);
  assert.deepEqual(await page.locator('#results li').first().locator('.result-snippet mark').allInnerTexts(), ['Привіт', 'café']);
  assert.deepEqual(await search('naive'), ['Rust ownership basics']);
  assert.deepEqual(await page.locator('#results li').first().locator('.result-snippet mark').allInnerTexts(), ['naïve']);
  assert.deepEqual(await search('script'), ['New script notes', 'Old script notes']);
  await page.locator('[data-site="claude"]').click();
  assert.deepEqual(await resultTitles(page), ['New script notes']);
  assert.match(page.url(), /site=claude/);
  await page.locator('[data-site="all"]').click();
  assert.deepEqual(await search(''), ['Rust ownership basics', 'New script notes', 'Kyiv coffee', 'Python packaging guide', 'Weekend plans', 'Old script notes']);
  assert.match(await page.locator('#summary').innerText(), /^6 conversations, newest first$/);
});

await test('search: clicking a result opens the conversation', async () => {
  await open(`/chatgpt/c/${CHATGPT_ID}`);
  await waitFor(async () => Boolean(await savedRecord(`chatgpt:${CHATGPT_ID}`)), 'saved');
  const page = await openSearchPage('timsort');
  await page.locator('#results .result-title').first().waitFor();
  assert.match(await page.locator('#results .result-snippet').first().innerText(), /Timsort/);
  const [opened] = await Promise.all([context.waitForEvent('page'), page.locator('#results .result-title').first().click()]);
  openPages.add(opened);
  await opened.waitForURL(`${base}/chatgpt/c/${CHATGPT_ID}`);
});

await test('search page updates live when a conversation is saved', async () => {
  const page = await openSearchPage();
  await page.locator('#state-empty').waitFor();
  assert.match(await page.locator('#empty-text').innerText(), /saved here automatically/);
  await shot(page, 'search-empty', { curated: true });
  await open(`/claude/chat/${CLAUDE_ID}`);
  await page.locator('#results .result-title', { hasText: 'Rust ownership basics' }).waitFor({ timeout: 8000 });
  assert.equal(await page.locator('#stat-count').innerText(), '1 conversation');
});

await test('management: delete one (with undo), export JSON, clear all', async () => {
  await seedRankingData();
  const page = await openSearchPage();
  await page.locator('#results li').first().waitFor();
  assert.equal(await page.locator('#stat-count').innerText(), '5 conversations');
  assert.match(await page.locator('#stat-detail').innerText(), /^\d+(\.\d)? (B|KB) of text · ChatGPT 3 · Claude 2$/);

  await page.locator('#results li', { hasText: 'Weekend plans' }).getByLabel('Delete “Weekend plans” from the index').click();
  await page.locator('#toast', { hasText: 'Deleted “Weekend plans”.' }).waitFor();
  assert.equal(await page.locator('#results li', { hasText: 'Weekend plans' }).count(), 0);
  assert.equal((await saved()).length, 4);
  await shot(page, 'search-deleted-toast');
  await page.locator('#toast-undo').click();
  await page.locator('#results li', { hasText: 'Weekend plans' }).waitFor();
  assert.equal((await saved()).length, 5);

  const [file] = await Promise.all([page.waitForEvent('download'), page.locator('#export').click()]);
  assert.match(file.suggestedFilename(), /^ai-chat-search-index \d{4}-\d{2}-\d{2}\.json$/);
  const data = JSON.parse(await readFile(await file.path(), 'utf8'));
  assert.equal(data.schemaVersion, 1);
  assert.equal(data.kind, 'ai-chat-search-index');
  assert.equal(data.conversations.length, 5);
  assert.deepEqual(Object.keys(data.conversations[0]).sort(), ['conversationId', 'createdAt', 'messages', 'source', 'title', 'updatedAt', 'url']);

  await page.locator('#clear').click();
  assert.equal(await page.locator('#clear-question').innerText(), "Delete all 5 saved conversations? This can't be undone.");
  await shot(page, 'search-clear-confirm', { curated: true });
  await page.locator('#clear-no').click();
  assert.equal((await saved()).length, 5);
  await page.locator('#clear').click();
  await page.locator('#clear-yes').click();
  await page.locator('#state-empty').waitFor();
  assert.deepEqual(await saved(), []);
  assert.equal(await page.locator('#stat-count').innerText(), '0 conversations');
});

await test('popup: clear all from the popup', async () => {
  await seedRankingData();
  const page = await open('/plain.html');
  const popup = await openPopup(page);
  await popup.locator('#empty').waitFor();
  assert.match(await popup.locator('#stats').innerText(), /^5 conversations saved/);
  await shot(popup, 'popup-empty', { fit: true });
  await popup.locator('#clear').click();
  await popup.locator('#clear-confirm').waitFor();
  assert.equal(await popup.locator('#clear-question').innerText(), "Delete all 5 saved conversations? This can't be undone.");
  await shot(popup, 'popup-clear-confirm', { fit: true });
  await popup.locator('#clear-yes').click();
  await popup.locator('#stats', { hasText: 'Nothing saved yet' }).waitFor();
  assert.deepEqual(await saved(), []);
});

await test('changed layout: toolbar badge and a friendly error, nothing saved', async () => {
  const page = await open('/chatgpt/c/broken-0001-aaaa-bbbb');
  const tabId = await tabIdOf(page);
  await waitFor(async () => (await worker.evaluate((tabId) => chrome.action.getBadgeText({ tabId }), tabId)) === '!', 'warning badge', 10000);
  assert.equal(await worker.evaluate((tabId) => chrome.action.getTitle({ tabId }), tabId), "AI Chat Search: Couldn't read this conversation, the site may have changed.");
  assert.deepEqual(await saved(), []);
  const popup = await openPopup(page);
  await popup.locator('#error').waitFor();
  assert.equal(await popup.locator('#error-text').innerText(), "Couldn't read this conversation, the site may have changed.");
  await shot(popup, 'popup-error', { curated: true, fit: true });
  // A readable conversation in the same tab clears the badge.
  await page.goto(`${base}/chatgpt/c/${CHATGPT_ID}`);
  await waitFor(async () => (await worker.evaluate((tabId) => chrome.action.getBadgeText({ tabId }), tabId)) === '', 'badge cleared');
});

await test('no network requests leave the browser', async () => {
  const requests = [];
  const listener = (request) => {
    const url = request.url();
    if (!url.startsWith(base) && !url.startsWith('chrome-extension://') && !url.startsWith('data:') && !url.startsWith('blob:')) requests.push(url);
  };
  context.on('request', listener);
  await open(`/chatgpt/c/${CHATGPT_ID}`);
  await waitFor(async () => Boolean(await savedRecord(`chatgpt:${CHATGPT_ID}`)), 'saved');
  const page = await openSearchPage('sorted');
  await page.locator('#results li').first().waitFor();
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
