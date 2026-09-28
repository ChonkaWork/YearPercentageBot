import checkIcon from 'bootstrap-icons/icons/check2.svg';
import chevronIcon from 'bootstrap-icons/icons/chevron-down.svg';
import codeIcon from 'bootstrap-icons/icons/code-slash.svg';
import cursorIcon from 'bootstrap-icons/icons/cursor-text.svg';
import downloadIcon from 'bootstrap-icons/icons/download.svg';
import errorIcon from 'bootstrap-icons/icons/exclamation-circle-fill.svg';
import warningIcon from 'bootstrap-icons/icons/exclamation-triangle-fill.svg';
import articleIcon from 'bootstrap-icons/icons/file-text.svg';
import gearIcon from 'bootstrap-icons/icons/gear.svg';
import infoIcon from 'bootstrap-icons/icons/info-circle-fill.svg';
import keyboardIcon from 'bootstrap-icons/icons/keyboard.svg';
import markdownIcon from 'bootstrap-icons/icons/markdown.svg';
import quoteIcon from 'bootstrap-icons/icons/quote.svg';
import successIcon from 'bootstrap-icons/icons/check-circle-fill.svg';
import tableIcon from 'bootstrap-icons/icons/table.svg';
import textIcon from 'bootstrap-icons/icons/text-left.svg';
import {
  SELECTION_FORMAT_LABELS,
  TABLE_FORMAT_LABELS,
  TABLE_FORMATS,
  isClipFormat,
  type ClipboardPayload,
  type ClipFormat,
  type TableFormat,
} from '../core/convert';
import { downloadFile, type DownloadKind } from '../core/download';
import { frontMatterValues, renderFrontMatter, withFrontMatter, type PageMeta } from '../core/frontMatter';
import { cleanPageUrl, pageLinkMarkdown } from '../core/pageLink';
import { EARLY_ACCESS, proMessage, type ProFeature } from '../core/plan';
import { defaultSettings, type Settings } from '../core/settings';
import { countWords, estimateTokens, htmlWords } from '../core/stats';
import type { ClipResult, ClipSource, DeepLink, PageInfo } from '../page/index';
import type { TableList, TableSummary } from '../page/reader';
import type { CopyRequest } from '../platform/messages';
import { callPage, readPageInfo } from '../platform/page';
import { canUse, loadEntitlements, loadPopupState, loadSettings, savePopupState, takeNotice, type Entitlements } from '../storage/store';
import { copyFromPage } from '../ui/clipboard';
import { saveFile } from '../ui/download';
import { byId, h } from '../ui/dom';
import { formatCount, plural, tableSize } from '../ui/format';
import { svgIcon } from '../ui/icons';
import { openAboutPro, proBadge } from '../ui/pro';

const COMMAND = 'copy-selection';
const QUOTE_COMMAND = 'copy-quote';
const PREVIEW_COLUMNS = 6;
const PAGE_TITLE_CHARS = 32;
/** Longer previews are shown cut and read-only: a textarea with megabytes of text is sluggish. */
const EDIT_LIMIT = 150_000;

const els = {
  openOptions: byId<HTMLButtonElement>('open-options'),
  notice: byId<HTMLDivElement>('notice'),
  clipSection: byId<HTMLElement>('clip-section'),
  tabs: byId<HTMLDivElement>('source-tabs'),
  tabSelection: byId<HTMLButtonElement>('tab-selection'),
  tabArticle: byId<HTMLButtonElement>('tab-article'),
  stats: byId<HTMLSpanElement>('clip-stats'),
  clip: byId<HTMLDivElement>('clip'),
  formatSwitch: byId<HTMLDivElement>('format-switch'),
  clipState: byId<HTMLDivElement>('clip-state'),
  clipContent: byId<HTMLDivElement>('clip-content'),
  clipNote: byId<HTMLDivElement>('clip-note'),
  preview: byId<HTMLTextAreaElement>('preview'),
  edited: byId<HTMLDivElement>('clip-edited'),
  resetEdit: byId<HTMLButtonElement>('reset-edit'),
  frontMatter: byId<HTMLDetailsElement>('front-matter'),
  frontMatterBadge: byId<HTMLSpanElement>('front-matter-badge'),
  frontMatterCaret: byId<HTMLSpanElement>('front-matter-caret'),
  frontMatterPreview: byId<HTMLPreElement>('front-matter-preview'),
  frontMatterNote: byId<HTMLDivElement>('front-matter-note'),
  copyClip: byId<HTMLButtonElement>('copy-clip'),
  downloadMd: byId<HTMLButtonElement>('download-md'),
  pageSection: byId<HTMLElement>('page-section'),
  pageLink: byId<HTMLElement>('page-link'),
  copyPageLink: byId<HTMLButtonElement>('copy-page-link'),
  copyArticle: byId<HTMLButtonElement>('copy-article'),
  tablesSection: byId<HTMLElement>('tables-section'),
  tables: byId<HTMLDivElement>('tables'),
  tablesCount: byId<HTMLSpanElement>('tables-count'),
  shortcutIcon: byId<HTMLSpanElement>('shortcut-icon'),
  shortcutText: byId<HTMLSpanElement>('shortcut-text'),
  changeShortcut: byId<HTMLButtonElement>('change-shortcut'),
  status: byId<HTMLDivElement>('status'),
};

const formatInputs = [...els.formatSwitch.querySelectorAll<HTMLInputElement>('input[name="clip-format"]')];

let tabId: number | null = null;
let settings: Settings = defaultSettings();
let entitlements: Entitlements = { plan: 'free', earlyAccess: EARLY_ACCESS };
let page: PageInfo = { title: '', url: '' };
let meta: PageMeta | null = null;

/** What the clip card shows: the selection or the article, in one of four formats. */
let source: ClipSource = 'selection';
let format: ClipFormat = 'markdown';
let tableFormat: TableFormat = 'csv';
/** Why the selection tab can't show anything, if it can't. */
let selectionState: 'ok' | 'empty' | 'error' = 'ok';
/** The article tab was opened automatically because nothing is selected. */
let autoArticle = false;
/** The quote shortcut as Chrome assigned it (the user can change it), for the Quote tip. */
let quoteShortcut = '';

interface ClipEntry {
  result: ClipResult;
  /** The user's edits in the preview; null when untouched. */
  edited: string | null;
}

const clips = new Map<string, ClipEntry>();
let clipRequest = 0;

const clipKey = (from: ClipSource, as: ClipFormat) => `${from}:${as}`;

/** The format actually converted: quotes need a selection. */
function effectiveFormat(): ClipFormat {
  return source === 'article' && format === 'quote' ? 'markdown' : format;
}

// --- Setup ------------------------------------------------------------------------------

async function targetTab(): Promise<chrome.tabs.Tab | undefined> {
  if (__E2E__) {
    // Tests open the popup as a normal page and point it at a fixture tab.
    const forced = Number(new URLSearchParams(location.search).get('tabId'));
    if (forced) return chrome.tabs.get(forced);
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function init(): Promise<void> {
  els.openOptions.append(svgIcon(gearIcon, 16));
  els.shortcutIcon.append(svgIcon(keyboardIcon, 14));
  els.downloadMd.append(svgIcon(downloadIcon, 15), '.md', proBadge());
  els.frontMatterBadge.append(proBadge());
  els.frontMatterCaret.append(svgIcon(chevronIcon, 11));
  els.copyPageLink.append(proBadge());
  els.copyArticle.prepend(svgIcon(articleIcon, 15));
  renderLoading();

  const [notice, loaded, access, remembered, tab] = await Promise.all([takeNotice(), loadSettings(), loadEntitlements(), loadPopupState(), targetTab()]);
  settings = loaded;
  entitlements = access;
  format = remembered.format;
  tableFormat = remembered.tableFormat;
  for (const input of formatInputs) input.checked = input.value === format;
  void renderShortcuts();
  if (notice) showNotice(notice.tone, notice.title, notice.detail, 'stored');
  void clearBadge(tab?.id);

  if (tab?.id === undefined) return renderUnreadable();
  tabId = tab.id;
  const [selection, tables, info, pageMeta] = await Promise.allSettled([
    callPage(tab.id, 0, 'convertClip', 'selection', format, settings),
    callPage(tab.id, 0, 'listTables'),
    readPageInfo(tab),
    callPage(tab.id, 0, 'pageMeta'),
  ]);
  if (selection.status === 'rejected' && tables.status === 'rejected') return renderUnreadable();
  meta = pageMeta.status === 'fulfilled' ? pageMeta.value : null;
  renderPage(info.status === 'fulfilled' ? info.value : { title: tab.title ?? '', url: tab.url ?? '' });
  renderTables(tables.status === 'fulfilled' ? tables.value : null);

  if (selection.status === 'fulfilled') {
    clips.set(clipKey('selection', format), { result: selection.value, edited: null });
    if (selection.value.kind === 'empty') {
      selectionState = 'empty';
      source = 'article';
      autoArticle = true;
    }
  } else {
    selectionState = 'error';
  }
  await showClip();
}

function renderLoading(): void {
  const line = (width: string) => h('span', { class: `placeholder d-block mb-1 rounded w-${width}` });
  els.clipContent.hidden = true;
  els.clipState.hidden = false;
  els.clipState.replaceChildren(
    h('div', { class: 'placeholder-glow', attrs: { 'aria-hidden': 'true' } }, line('100'), line('75'), line('90'), h('span', { class: 'placeholder d-block w-100 rounded mt-3', attrs: { style: 'height: 2.25rem' } })),
  );
  els.tables.replaceChildren(
    ...[0, 1].map(() => h('div', { class: 'list-group-item table-skeleton placeholder-glow', attrs: { 'aria-hidden': 'true' } }, line('50'))),
  );
  els.status.textContent = 'Reading the page…';
}

function renderUnreadable(): void {
  els.clipSection.hidden = true;
  els.pageSection.hidden = true;
  els.tablesSection.hidden = true;
  els.status.textContent = "This page can't be read.";
  // A message left by the background already explains it.
  if (els.notice.querySelector('[data-key="stored"]')) return;
  showNotice(
    'warning',
    "Universal Copy can't read this page",
    "Chrome doesn't let extensions read chrome:// pages, the Chrome Web Store or the PDF viewer. Open a regular web page and try again.",
    'page',
    false,
  );
}

async function clearBadge(id: number | undefined): Promise<void> {
  try {
    await chrome.action.setBadgeText(id !== undefined ? { tabId: id, text: '' } : { text: '' });
  } catch {
    // Nothing to clear.
  }
}

async function renderShortcuts(): Promise<void> {
  try {
    const commands = await chrome.commands.getAll();
    const copy = commands.find((command) => command.name === COMMAND)?.shortcut;
    const quote = commands.find((command) => command.name === QUOTE_COMMAND)?.shortcut;
    if (copy) {
      els.shortcutText.replaceChildren(h('kbd', { text: copy }), ` copies the selection as ${SELECTION_FORMAT_LABELS[settings.shortcutFormat]}`);
    } else {
      els.shortcutText.textContent = 'No keyboard shortcut set';
    }
    quoteShortcut = quote ?? '';
  } catch {
    els.shortcutText.textContent = 'Keyboard shortcut unavailable';
  }
}

// --- Notices ----------------------------------------------------------------------------

type Tone = 'success' | 'error' | 'info' | 'warning';

/**
 * Alerts at the top of the popup. Each key holds one alert, so the page state ("can't read
 * this page"), a message left by the background and the latest copy error can coexist.
 */
function showNotice(tone: Tone, title: string, detail?: string, key = 'message', dismissible = true, action?: { label: string; run: () => void }): void {
  const variant = { success: 'success', error: 'danger', info: 'primary', warning: 'warning' }[tone];
  const iconSource = { success: successIcon, error: errorIcon, info: infoIcon, warning: warningIcon }[tone];
  const alert = h(
    'div',
    {
      class: `alert alert-${variant} d-flex align-items-start gap-2 py-2 px-3 small mb-3`,
      attrs: { role: tone === 'error' ? 'alert' : 'status', 'data-key': key },
    },
    svgIcon(iconSource, 16),
    h(
      'div',
      {},
      h('div', { class: 'fw-bold', text: title }),
      detail ? h('div', { text: detail }) : null,
      action ? h('button', { class: 'btn btn-link btn-sm p-0 mt-1 notice-action', text: action.label, attrs: { type: 'button' }, on: { click: action.run } }) : null,
    ),
  );
  if (dismissible) {
    alert.append(
      h('button', {
        class: 'btn-close ms-auto',
        attrs: { type: 'button', 'aria-label': 'Dismiss' },
        on: { click: () => alert.remove() },
      }),
    );
  }
  const existing = els.notice.querySelector(`[data-key="${key}"]`);
  if (existing) existing.replaceWith(alert);
  else els.notice.append(alert);
  els.notice.hidden = false;
}

function announce(message: string): void {
  els.status.textContent = message;
}

// --- The clip card: selection or article, four formats, editable preview ------------------

const COPY_LABELS: Record<ClipFormat, { label: string; icon: string }> = {
  markdown: { label: 'Copy Markdown', icon: markdownIcon },
  text: { label: 'Copy text', icon: textIcon },
  html: { label: 'Copy HTML', icon: codeIcon },
  quote: { label: 'Copy quote with link', icon: quoteIcon },
};

function renderTabs(): void {
  for (const tab of [els.tabSelection, els.tabArticle]) {
    const selected = tab.dataset.source === source;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
  }
  els.clip.setAttribute('aria-labelledby', source === 'selection' ? 'tab-selection' : 'tab-article');
  const quote = formatInputs.find((input) => input.value === 'quote');
  if (quote) {
    quote.disabled = source === 'article';
    const label = els.formatSwitch.querySelector<HTMLLabelElement>('label[for="format-quote"]');
    if (label) label.title = source === 'article' ? 'Quotes need a selection' : 'A quote with a link that opens the page at this passage';
  }
  for (const input of formatInputs) input.checked = input.value === effectiveFormat();
}

async function showClip(): Promise<void> {
  renderTabs();
  const request = ++clipRequest;
  if (source === 'selection' && selectionState !== 'ok') {
    renderClipState(selectionState);
    return;
  }
  const as = effectiveFormat();
  let entry = clips.get(clipKey(source, as));
  if (!entry) {
    if (tabId === null) return;
    renderConverting();
    let result: ClipResult;
    try {
      result = await callPage(tabId, 0, 'convertClip', source, as, settings);
    } catch {
      if (request !== clipRequest) return;
      renderClipState('error');
      return;
    }
    if (request !== clipRequest) return;
    if (source === 'selection' && result.kind === 'empty') {
      selectionState = 'empty';
      renderClipState('empty');
      return;
    }
    entry = { result, edited: null };
    clips.set(clipKey(source, as), entry);
  }
  if (source === 'article' && !entry.result.payload.text.trim()) {
    renderClipState('no-article');
    return;
  }
  renderClip(entry, as);
}

function renderConverting(): void {
  els.formatSwitch.hidden = false;
  els.clipState.hidden = true;
  els.clipContent.hidden = false;
  els.preview.value = '';
  els.preview.placeholder = source === 'article' ? 'Finding the article…' : 'Converting…';
  els.preview.disabled = true;
  els.copyClip.disabled = true;
  els.downloadMd.disabled = true;
  els.stats.textContent = '';
}

function renderClipState(state: 'empty' | 'error' | 'no-article'): void {
  // Nothing to convert, so no format to pick.
  els.formatSwitch.hidden = true;
  els.clipContent.hidden = true;
  els.clipState.hidden = false;
  els.stats.textContent = '';
  if (state === 'error') {
    els.clipState.replaceChildren(emptyState(warningIcon, "Couldn't read this page. It may have changed or navigated away: reopen the popup and try again."));
    return;
  }
  if (state === 'no-article') {
    els.clipState.replaceChildren(emptyState(articleIcon, 'This page has no article text to copy. Select what you need on the page instead.'));
    return;
  }
  els.clipState.replaceChildren(
    emptyState(
      cursorIcon,
      'Select text on the page to copy it as Markdown, text, HTML or a quote with a link.',
      '',
      h('button', { class: 'btn btn-link btn-sm p-0 mt-1', text: 'Copy the whole article instead', attrs: { type: 'button', id: 'show-article' }, on: { click: () => void switchSource('article') } }),
    ),
  );
}

/** The text the preview shows for a result: HTML source for HTML, text otherwise. */
function originalText(entry: ClipEntry, as: ClipFormat): string {
  return as === 'html' ? (entry.result.payload.html ?? entry.result.payload.text) : entry.result.payload.text;
}

function renderClip(entry: ClipEntry, as: ClipFormat): void {
  els.formatSwitch.hidden = false;
  els.clipState.hidden = true;
  els.clipContent.hidden = false;
  const original = originalText(entry, as);
  const tooLong = original.length > EDIT_LIMIT;
  els.preview.disabled = false;
  els.preview.placeholder = '';
  els.preview.readOnly = tooLong;
  els.preview.value = entry.edited ?? (tooLong ? `${original.slice(0, EDIT_LIMIT)}\n…` : original);
  els.preview.classList.toggle('is-code', as !== 'text' && !(as === 'quote' && settings.quoteStyle === 'text'));
  // Quotes come with notes about the link: a slightly shorter box keeps the popup within 600px.
  els.preview.classList.toggle('is-short', as === 'quote');
  els.preview.scrollTop = 0;
  els.edited.hidden = entry.edited === null;
  const { label, icon } = COPY_LABELS[as];
  // A "Copied" flash from the previous format must not come back with the old label.
  endFlash(els.copyClip);
  els.copyClip.disabled = false;
  els.copyClip.replaceChildren(svgIcon(icon, 15), label);
  els.downloadMd.disabled = false;
  renderNote(entry, as, tooLong);
  renderFrontMatterPreview(as);
  updateStats();
}

function renderNote(entry: ClipEntry, as: ClipFormat, tooLong: boolean): void {
  const notes: { tone: 'success' | 'info' | 'warning'; text: string }[] = [];
  if (source === 'article' && autoArticle) notes.push({ tone: 'info', text: 'Nothing is selected, so this is the page’s main article.' });
  if (source === 'article' && entry.result.found === false) {
    notes.push({ tone: 'warning', text: 'No single article stood out: this is the whole page without menus and ads.' });
  }
  if (as === 'quote') {
    notes.push(DEEP_LINK_NOTES[entry.result.deepLink ?? 'page']);
    if (quoteShortcut) notes.push({ tone: 'info', text: `Tip: ${quoteShortcut} does this right on the page.` });
  }
  if (entry.result.truncated) notes.push({ tone: 'warning', text: 'Very large: only the first part is copied.' });
  if (tooLong) notes.push({ tone: 'info', text: 'Long text: the preview shows the start and can’t be edited. Copy takes all of it.' });
  els.clipNote.hidden = notes.length === 0;
  els.clipNote.replaceChildren(
    ...notes.map((note) =>
      h('div', { class: `clip-note-line tone-${note.tone}` }, svgIcon(note.tone === 'success' ? successIcon : note.tone === 'warning' ? warningIcon : infoIcon, 13), h('span', { text: note.text })),
    ),
  );
}

const DEEP_LINK_NOTES: Record<DeepLink, { tone: 'success' | 'info' | 'warning'; text: string }> = {
  passage: { tone: 'success', text: 'The link opens the page at this passage, highlighted.' },
  ambiguous: { tone: 'warning', text: 'This passage appears more than once, so the link opens the page without jumping to it.' },
  page: { tone: 'info', text: 'This text can’t be linked to directly; the link opens the page.' },
  none: { tone: 'info', text: 'This page has no web address, so the quote has no link.' },
};

function currentEntry(): ClipEntry | undefined {
  return clips.get(clipKey(source, effectiveFormat()));
}

function updateStats(): void {
  const value = els.preview.value;
  const as = effectiveFormat();
  const words = as === 'html' ? htmlWords(value) : countWords(value);
  const entry = currentEntry();
  // Counts are of what gets copied: the whole text, even when the preview is cut.
  const full = entry && entry.edited === null ? originalText(entry, as) : value;
  const tokens = estimateTokens(full);
  const allWords = full === value ? words : as === 'html' ? htmlWords(full) : countWords(full);
  els.stats.textContent = `${formatCount(allWords)} ${plural(allWords, 'word')} · ~${formatCount(tokens)} ${plural(tokens, 'token')}`;
  els.stats.title = 'Approximate token count for AI tools (characters ÷ 4)';
}

let statsFrame = 0;
function onPreviewInput(): void {
  const entry = currentEntry();
  if (!entry || els.preview.readOnly) return;
  entry.edited = els.preview.value;
  els.edited.hidden = false;
  cancelAnimationFrame(statsFrame);
  statsFrame = requestAnimationFrame(updateStats);
}

function resetEdits(): void {
  const entry = currentEntry();
  if (!entry) return;
  entry.edited = null;
  renderClip(entry, effectiveFormat());
  els.preview.focus();
  announce('Edits undone.');
}

function renderFrontMatterPreview(as: ClipFormat): void {
  const relevant = as === 'markdown' && settings.frontMatter;
  els.frontMatter.hidden = !relevant;
  if (!relevant) return;
  if (!canUse(entitlements, 'front-matter')) {
    els.frontMatterPreview.hidden = true;
    els.frontMatterNote.replaceChildren(`${proMessage('front-matter')} `, h('button', { class: 'btn btn-link btn-sm p-0 align-baseline', text: 'About Pro', attrs: { type: 'button' }, on: { click: openAboutPro } }));
    return;
  }
  const block = frontMatter();
  els.frontMatterPreview.hidden = !block;
  els.frontMatterPreview.textContent = block.trimEnd();
  els.frontMatterNote.replaceChildren(
    block ? '' : 'The template is empty, so downloads have no front matter. ',
    h('button', { class: 'btn btn-link btn-sm p-0 align-baseline', text: 'Edit template', attrs: { type: 'button', id: 'edit-template' }, on: { click: openTemplateEditor } }),
  );
}

function frontMatter(): string {
  if (!settings.frontMatter || !canUse(entitlements, 'front-matter')) return '';
  const info: PageMeta = meta ?? { title: page.title, url: page.url, author: '', published: '', description: '', site: '' };
  return renderFrontMatter(settings.frontMatterTemplate, frontMatterValues(info, settings.defaultTags, new Date()));
}

function openTemplateEditor(): void {
  void chrome.tabs.create({ url: chrome.runtime.getURL('options.html#front-matter') });
}

async function switchSource(next: ClipSource, focus = false): Promise<void> {
  if (next === source) return;
  source = next;
  autoArticle = false;
  if (focus) (next === 'selection' ? els.tabSelection : els.tabArticle).focus();
  await showClip();
}

async function switchFormat(next: ClipFormat): Promise<void> {
  if (next === format && next === effectiveFormat()) return;
  format = next;
  void savePopupState({ format: next });
  await showClip();
}

/** What the Copy button puts on the clipboard: the preview as edited, or the conversion. */
function payloadFor(entry: ClipEntry, as: ClipFormat): ClipboardPayload {
  if (entry.edited === null) return entry.result.payload;
  if (as === 'html') return { text: textOfHtml(entry.edited), html: entry.edited };
  return { text: entry.edited };
}

/** Plain text of edited HTML, for text/plain. Parsed in an inert document; nothing is rendered. */
function textOfHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return (doc.body.textContent ?? '').replace(/\n{3,}/g, '\n\n').trim();
}

async function copyClip(): Promise<void> {
  const entry = currentEntry();
  if (!entry) return;
  const as = effectiveFormat();
  const payload = payloadFor(entry, as);
  if (!payload.text.trim()) {
    showNotice('error', 'Nothing to copy', 'The preview is empty. Undo your edits or select text on the page.');
    return;
  }
  const what = source === 'article' ? 'the article' : 'the selection';
  const message = as === 'quote' ? 'Copied the quote with a link to the passage.' : `Copied ${what} as ${SELECTION_FORMAT_LABELS[as]}.`;
  await copyAndConfirm(payload, els.copyClip, message);
}

/** Markdown for a download: the preview when it is Markdown, otherwise a fresh conversion. */
async function markdownForDownload(): Promise<string | null> {
  const as = effectiveFormat();
  const entry = currentEntry();
  if (entry && (as === 'markdown' || (as === 'quote' && settings.quoteStyle === 'markdown'))) return entry.edited ?? entry.result.payload.text;
  const cached = clips.get(clipKey(source, 'markdown'));
  if (cached) return cached.edited ?? cached.result.payload.text;
  if (tabId === null) return null;
  const result = await callPage(tabId, 0, 'convertClip', source, 'markdown', settings);
  if (result.kind === 'empty') return '';
  clips.set(clipKey(source, 'markdown'), { result, edited: null });
  return result.payload.text;
}

async function downloadMarkdown(): Promise<void> {
  if (!requirePro('download')) return;
  let markdown: string | null;
  try {
    markdown = await markdownForDownload();
  } catch {
    showNotice('error', "Couldn't read the page", 'It may have changed or navigated away. Reopen the popup and try again.');
    return;
  }
  if (!markdown?.trim()) {
    showNotice('error', 'Nothing to download', 'The preview is empty. Select text on the page and reopen the popup.');
    return;
  }
  save(withFrontMatter(frontMatter(), markdown), 'md', page.title, els.downloadMd);
}

// --- This page ------------------------------------------------------------------------------

function renderPage(info: PageInfo): void {
  page = info;
  const url = cleanPageUrl(info.url);
  const link = pageLinkMarkdown(info.title, info.url);
  // The text that gets copied, with a long title shortened so the address (where tracking
  // parameters would be) stays visible. The full string is in the tooltip.
  const title = info.title.replace(/\s+/g, ' ').trim();
  const short = [...title].length > PAGE_TITLE_CHARS ? `${[...title].slice(0, PAGE_TITLE_CHARS - 1).join('').trimEnd()}…` : title;
  els.pageLink.textContent = pageLinkMarkdown(short, info.url)?.text ?? (title || 'This page has no web address');
  els.pageLink.title = link?.text ?? '';
  els.copyPageLink.disabled = !url;
  els.pageSection.hidden = false;
}

async function copyPageLink(): Promise<void> {
  if (!requirePro('page-link')) return;
  const payload = pageLinkMarkdown(page.title, page.url);
  if (!payload) {
    showNotice('error', 'No web address to link to', 'Only http and https pages can be copied as a link.');
    return;
  }
  await copyAndConfirm(payload, els.copyPageLink, `Copied the page link as Markdown: ${payload.text}`);
}

async function copyArticle(): Promise<void> {
  if (tabId === null) return;
  const cached = clips.get(clipKey('article', 'markdown'));
  let payload: ClipboardPayload;
  if (cached) payload = payloadFor(cached, 'markdown');
  else {
    try {
      const result = await callPage(tabId, 0, 'convertArticle', 'markdown', settings);
      clips.set(clipKey('article', 'markdown'), { result, edited: null });
      payload = result.payload;
    } catch {
      showNotice('error', "Couldn't read the page", 'It may have changed or navigated away. Reopen the popup and try again.');
      return;
    }
  }
  if (!payload.text.trim()) {
    showNotice('error', 'No article text on this page', 'It has no readable text to copy.');
    return;
  }
  const words = countWords(payload.text);
  await copyAndConfirm(payload, els.copyArticle, `Copied the article as Markdown: ${formatCount(words)} ${plural(words, 'word')}.`);
}

// --- Tables -----------------------------------------------------------------------------

function renderTables(list: TableList | null): void {
  if (!list) {
    els.tables.replaceChildren(emptyState(warningIcon, "Couldn't look for tables on this page.", 'list-group-item'));
    return;
  }
  els.tablesCount.hidden = list.total === 0;
  els.tablesCount.textContent = formatCount(list.total);
  if (list.total === 0) {
    els.tables.replaceChildren(emptyState(tableIcon, 'No tables on this page.', 'list-group-item'));
    return;
  }
  const items = list.tables.map((summary, position) => tableItem(summary, position + 1));
  if (list.total > list.tables.length) {
    items.push(h('div', { class: 'list-group-item small text-body-secondary', text: `Showing the first ${list.tables.length} of ${formatCount(list.total)} tables.` }));
  }
  els.tables.replaceChildren(...items);
}

function tableFormatLabel(as: TableFormat): string {
  return as === 'tsv' ? 'TSV' : TABLE_FORMAT_LABELS[as];
}

/** Every split button says "Copy <last format used>". */
function updateSplitLabels(): void {
  for (const button of els.tables.querySelectorAll<HTMLButtonElement>('[data-copy-last]')) {
    if (button.classList.contains('is-copied')) continue;
    button.textContent = `Copy ${tableFormatLabel(tableFormat)}`;
  }
}

/**
 * One compact row per table: name, size, and a split button that copies in the last format
 * used. The caret (or the name) opens the row: preview, every format, downloads.
 */
function tableItem(summary: TableSummary, position: number): HTMLElement {
  const name = summary.title || `Table ${position}`;
  const panelId = `table-panel-${summary.index}`;
  const panel = h('div', { class: 'table-panel', attrs: { id: panelId } });
  panel.hidden = true;

  const toggle = h(
    'button',
    { class: 'table-toggle', attrs: { type: 'button', 'aria-expanded': 'false', 'aria-controls': panelId, title: `${name}: show the preview, all formats and downloads` } },
    svgIcon(chevronIcon, 12),
    h('span', { class: 'table-title text-truncate', text: name }),
  );
  const copyLast = h('button', {
    class: 'btn btn-outline-primary table-copy',
    text: `Copy ${tableFormatLabel(tableFormat)}`,
    attrs: { type: 'button', 'data-copy-last': '', title: `Copy ${name} in the last format you used` },
  });
  copyLast.addEventListener('click', () => void copyTable(summary, name, tableFormat, copyLast));
  const more = h('button', {
    class: 'btn btn-outline-primary table-more',
    attrs: { type: 'button', 'aria-expanded': 'false', 'aria-controls': panelId, 'aria-label': `More formats and downloads for ${name}` },
  }, svgIcon(chevronIcon, 12));

  const item = h(
    'div',
    { class: 'list-group-item table-item', attrs: { 'data-index': String(summary.index) } },
    h(
      'div',
      { class: 'table-row' },
      toggle,
      h('span', { class: 'table-dims mono', text: `${formatCount(summary.rows)} × ${formatCount(summary.columns)}`, attrs: { title: tableSize(summary.rows, summary.columns) } }),
      h('div', { class: 'btn-group btn-group-sm split-copy', attrs: { role: 'group', 'aria-label': `Copy ${name}` } }, copyLast, more),
    ),
    panel,
  );

  let isOpen = false;
  const setOpen = (open: boolean) => {
    isOpen = open;
    if (open && panel.childElementCount === 0) fillTablePanel(panel, summary, name, position);
    panel.hidden = !open;
    item.classList.toggle('is-open', open);
    toggle.setAttribute('aria-expanded', String(open));
    more.setAttribute('aria-expanded', String(open));
  };
  toggle.addEventListener('click', () => setOpen(!isOpen));
  more.addEventListener('click', () => setOpen(!isOpen));
  return item;
}

function fillTablePanel(panel: HTMLElement, summary: TableSummary, name: string, position: number): void {
  const buttons = TABLE_FORMATS.map((as) => {
    const button = h('button', {
      class: 'btn btn-outline-primary',
      text: tableFormatLabel(as),
      attrs: {
        type: 'button',
        'data-format': as,
        title: as === 'tsv' ? 'Copy as TSV: pastes into Excel and Google Sheets as cells' : `Copy as ${TABLE_FORMAT_LABELS[as]}`,
      },
    });
    button.addEventListener('click', () => void copyTable(summary, name, as, button));
    return button;
  });
  const more = summary.columns - PREVIEW_COLUMNS;
  panel.append(
    previewTable(summary) ?? '',
    more > 0 ? h('div', { class: 'more-columns mt-1', text: `+${more} more ${plural(more, 'column')}` }) : '',
    h('div', { class: 'btn-group btn-group-sm w-100 mt-2 format-buttons', attrs: { role: 'group', 'aria-label': `Copy ${name} as` } }, ...buttons),
    tableDownloads(summary, name, position),
  );
}

const TABLE_DOWNLOADS: readonly { kind: DownloadKind; format: TableFormat }[] = [
  { kind: 'csv', format: 'csv' },
  { kind: 'json', format: 'json' },
];

function tableDownloads(summary: TableSummary, name: string, position: number): HTMLElement {
  // Tables without a caption are named after the page: "Page title - table 2.csv".
  const fileName = summary.title || `${page.title || 'table'} - table ${position}`;
  const buttons = TABLE_DOWNLOADS.map(({ kind, format: as }) => {
    const button = h(
      'button',
      { class: 'btn btn-link btn-sm download-button', attrs: { type: 'button', 'data-download': kind, title: `Download ${name} as a .${kind} file` } },
      `.${kind}`,
    );
    button.addEventListener('click', () => void downloadTable(summary, as, kind, fileName, button));
    return button;
  });
  return h(
    'div',
    { class: 'download-row mt-1', attrs: { role: 'group', 'aria-label': `Download ${name}` } },
    h('span', { class: 'download-label' }, svgIcon(downloadIcon, 14), 'Download'),
    ...buttons,
    proBadge(),
  );
}

async function downloadTable(summary: TableSummary, as: TableFormat, kind: DownloadKind, fileName: string, button: HTMLButtonElement): Promise<void> {
  if (tabId === null || !requirePro('download')) return;
  let result;
  try {
    result = await callPage(tabId, 0, 'convertTableAt', summary.index, summary.signature, as, settings);
  } catch {
    showNotice('error', "Couldn't read the table", 'The page may have changed or navigated away. Reopen the popup and try again.');
    return;
  }
  if (result.status !== 'ok') {
    showNotice('error', 'This table has changed', 'The page updated since the popup opened. Reopen the popup to download the current table.');
    return;
  }
  if (!result.payload.text.trim()) {
    showNotice('error', 'This table is empty', 'It has no visible text to download.');
    return;
  }
  save(result.payload.text, kind, fileName, button);
}

function previewTable(summary: TableSummary): HTMLElement | null {
  if (summary.preview.length === 0) return null;
  const rows = summary.preview.map((row, index) => {
    const header = index < summary.headerRows;
    return h('tr', { class: header ? 'header-row' : '' }, ...row.map((value) => h(header ? 'th' : 'td', { text: value, attrs: { title: value } })));
  });
  return h('div', { class: 'table-preview', attrs: { 'aria-hidden': 'true' } }, h('table', { class: 'table table-sm' }, h('tbody', {}, ...rows)));
}

async function copyTable(summary: TableSummary, name: string, as: TableFormat, button: HTMLButtonElement): Promise<void> {
  if (tabId === null) return;
  let result;
  try {
    result = await callPage(tabId, 0, 'convertTableAt', summary.index, summary.signature, as, settings);
  } catch {
    showNotice('error', "Couldn't read the table", 'The page may have changed or navigated away. Reopen the popup and try again.');
    return;
  }
  if (result.status !== 'ok') {
    showNotice('error', 'This table has changed', 'The page updated since the popup opened. Reopen the popup to copy the current table.');
    return;
  }
  if (!result.payload.text.trim()) {
    showNotice('error', 'This table is empty', 'It has no visible text to copy.');
    return;
  }
  const copied = await copyAndConfirm(result.payload, button, `Copied ${name} as ${TABLE_FORMAT_LABELS[as]}: ${tableSize(result.rows, result.columns)}.`);
  if (copied && as !== tableFormat) {
    tableFormat = as;
    void savePopupState({ tableFormat: as });
    updateSplitLabels();
  }
}

// --- Pro ----------------------------------------------------------------------------------

/** True when the feature is available; otherwise a calm note with a link to About Pro. */
function requirePro(feature: ProFeature): boolean {
  if (canUse(entitlements, feature)) return true;
  showNotice('info', 'Pro feature', proMessage(feature), 'pro', true, { label: 'About Pro', run: openAboutPro });
  return false;
}

// --- Copying and saving -------------------------------------------------------------------

function save(content: string, kind: DownloadKind, baseName: string, button: HTMLButtonElement): void {
  const file = downloadFile(content, kind, baseName);
  try {
    saveFile(file);
  } catch {
    showNotice('error', "Couldn't save the file", 'Please try again.');
    return;
  }
  flashDone(button, 'Saved');
  announce(`Downloaded ${file.filename}.`);
}

async function copyAndConfirm(payload: ClipboardPayload, button: HTMLButtonElement, message: string): Promise<boolean> {
  button.disabled = true;
  let copied = false;
  try {
    copied = (await copyFromPage(payload)) || (await copyInBackground(payload));
  } finally {
    button.disabled = false;
  }
  if (!copied) {
    showNotice('error', "Couldn't copy to the clipboard", 'Please try again.');
    return false;
  }
  flashDone(button, 'Copied');
  announce(message);
  return true;
}

async function copyInBackground(payload: ClipboardPayload): Promise<boolean> {
  try {
    const request: CopyRequest = { type: 'uc/copy', payload };
    const response = (await chrome.runtime.sendMessage(request)) as { ok?: boolean } | undefined;
    return response?.ok === true;
  } catch {
    return false;
  }
}

const copiedButtons = new WeakMap<HTMLButtonElement, { children: Node[]; timer: number }>();

/** Inline success state on the button that was pressed, restored after a moment. */
function flashDone(button: HTMLButtonElement, label: string): void {
  const current = copiedButtons.get(button);
  const children = current?.children ?? Array.from(button.childNodes);
  window.clearTimeout(current?.timer);
  button.classList.add('is-copied');
  button.replaceChildren(svgIcon(checkIcon, 15), label);
  const timer = window.setTimeout(() => {
    button.classList.remove('is-copied');
    button.replaceChildren(...children);
    copiedButtons.delete(button);
    if (button.hasAttribute('data-copy-last')) updateSplitLabels();
  }, 1600);
  copiedButtons.set(button, { children, timer });
}

/** Ends a button's success flash now, without restoring its old content. */
function endFlash(button: HTMLButtonElement): void {
  const current = copiedButtons.get(button);
  if (!current) return;
  window.clearTimeout(current.timer);
  button.classList.remove('is-copied');
  copiedButtons.delete(button);
}

function emptyState(icon: string, message: string, extraClass = '', action?: HTMLElement): HTMLElement {
  return h('div', { class: `empty-state ${extraClass}`.trim() }, svgIcon(icon, 22), h('div', {}, h('div', { text: message }), action ?? null));
}

// --- Events -----------------------------------------------------------------------------

els.openOptions.addEventListener('click', () => void chrome.runtime.openOptionsPage());
els.copyPageLink.addEventListener('click', () => void copyPageLink());
els.copyArticle.addEventListener('click', () => void copyArticle());
els.copyClip.addEventListener('click', () => void copyClip());
els.downloadMd.addEventListener('click', () => void downloadMarkdown());
els.resetEdit.addEventListener('click', resetEdits);
els.preview.addEventListener('input', onPreviewInput);
els.changeShortcut.addEventListener('click', () => void chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }));
for (const input of formatInputs) {
  input.addEventListener('change', () => {
    if (input.checked && isClipFormat(input.value)) void switchFormat(input.value);
  });
}
for (const tab of [els.tabSelection, els.tabArticle]) {
  tab.addEventListener('click', () => void switchSource(tab.dataset.source === 'article' ? 'article' : 'selection'));
}
// Arrow keys move between the two tabs (ARIA tabs pattern).
els.tabs.addEventListener('keydown', (event) => {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home' && event.key !== 'End') return;
  event.preventDefault();
  const next = event.key === 'Home' ? 'selection' : event.key === 'End' ? 'article' : source === 'selection' ? 'article' : 'selection';
  void switchSource(next, true);
});

init().catch((error: unknown) => {
  console.error('Universal Copy: popup failed', error);
  showNotice('error', 'Universal Copy failed to start', 'Close and reopen the popup.');
});
