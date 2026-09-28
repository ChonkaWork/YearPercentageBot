import checkIcon from 'bootstrap-icons/icons/check2.svg';
import copyIcon from 'bootstrap-icons/icons/copy.svg';
import gearIcon from 'bootstrap-icons/icons/gear.svg';
import keyboardIcon from 'bootstrap-icons/icons/keyboard.svg';
import lightningIcon from 'bootstrap-icons/icons/lightning-charge.svg';
import pauseIcon from 'bootstrap-icons/icons/pause-circle.svg';
import searchIcon from 'bootstrap-icons/icons/search.svg';
import slashIcon from 'bootstrap-icons/icons/slash-circle.svg';
import reloadIcon from 'bootstrap-icons/icons/arrow-clockwise.svg';
import { defaultPlanState, hasFeature, type PlanState, type ProFeature } from '../core/plan';
import { defaultSettings, findDisablingEntry, type Settings } from '../core/settings';
import { allTags, filterByTag, previewText, searchSnippets, type Snippet } from '../core/snippets';
import { normalizeInputValue, parseFields, renderForCopy, type FillField } from '../core/variables';
import { loadPlanState, loadSettings, loadSnippets, onStoreChanged, setSiteEnabled } from '../storage/store';
import { copyText } from '../ui/clipboard';
import { byId, h } from '../ui/dom';
import { svgIcon } from '../ui/icons';

const els = {
  managerIcon: byId<HTMLButtonElement>('open-manager-icon'),
  manager: byId<HTMLButtonElement>('open-manager'),
  site: byId<HTMLElement>('site'),
  siteIcon: byId<HTMLDivElement>('site-icon'),
  siteHost: byId<HTMLDivElement>('site-host'),
  siteStatus: byId<HTMLDivElement>('site-status'),
  siteSwitch: byId<HTMLDivElement>('site-switch'),
  siteToggle: byId<HTMLInputElement>('site-toggle'),
  searchIcon: byId<HTMLSpanElement>('search-icon'),
  search: byId<HTMLInputElement>('search'),
  tagSelect: byId<HTMLSelectElement>('tag-select'),
  count: byId<HTMLSpanElement>('count'),
  listHead: byId<HTMLDivElement>('list-head'),
  error: byId<HTMLDivElement>('error'),
  list: byId<HTMLUListElement>('list'),
  empty: byId<HTMLDivElement>('empty'),
  copyStatus: byId<HTMLDivElement>('copy-status'),
  mode: byId<HTMLSpanElement>('mode'),
};

let snippets: Snippet[] = [];
let settings: Settings = defaultSettings();
let plan: PlanState = defaultPlanState();
let loaded = false;
/** Tag filter (Pro); null shows everything. */
let activeTag: string | null = null;
/** The open fill-in form, if any. The list isn't re-rendered under it. */
let fill: { form: HTMLFormElement; button: HTMLButtonElement } | null = null;
let renderPending = false;

function can(feature: ProFeature): boolean {
  return hasFeature(plan.plan, feature, plan.earlyAccess);
}

interface TabInfo {
  /** Hostname for http(s) pages, null where extensions can't run. */
  host: string | null;
  label: string;
  /** Whether the content script answered in this tab. */
  running: boolean;
}
let tab: TabInfo | null = null;

// --- Current tab ------------------------------------------------------------------------

async function currentTab(): Promise<chrome.tabs.Tab | undefined> {
  if (__E2E__) {
    // Test build only: the popup is opened as a normal page and told which tab to act on.
    const id = Number(new URLSearchParams(location.search).get('tab'));
    if (id) return chrome.tabs.get(id);
  }
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  return active;
}

const RESTRICTED_HOSTS = ['chromewebstore.google.com', 'chrome.google.com'];

async function inspectTab(): Promise<TabInfo> {
  const current = await currentTab();
  // activeTab exposes the URL of the tab the popup was opened on.
  const url = current?.url ? new URL(current.url) : null;
  if (!current?.id || !url) return { host: null, label: 'This page', running: false };
  const web = url.protocol === 'http:' || url.protocol === 'https:';
  if (!web || RESTRICTED_HOSTS.includes(url.hostname) || !url.hostname) {
    return { host: null, label: web ? url.hostname : `${url.protocol}//${url.hostname}`, running: false };
  }
  let running = false;
  try {
    const reply = (await chrome.tabs.sendMessage(current.id, { type: 'snippets/ping' }, { frameId: 0 })) as { running?: boolean } | undefined;
    running = reply?.running === true;
  } catch {
    // No content script: the page was open before Snippets was installed or updated.
  }
  return { host: url.hostname, label: url.hostname, running };
}

function renderSite(): void {
  els.siteHost.classList.remove('placeholder-glow');
  els.site.classList.remove('is-on', 'is-off', 'is-na');
  if (!tab) return;
  els.siteHost.textContent = tab.label;
  els.siteHost.title = tab.label;
  if (!tab.host) {
    els.site.classList.add('is-na');
    els.siteIcon.replaceChildren(svgIcon(slashIcon));
    els.siteStatus.textContent = "Chrome doesn't let extensions type on this page.";
    els.siteSwitch.hidden = true;
    return;
  }
  const entry = findDisablingEntry([tab.host], settings.disabledSites);
  els.siteSwitch.hidden = false;
  els.siteToggle.checked = entry === null;
  if (entry !== null) {
    els.site.classList.add('is-off');
    els.siteIcon.replaceChildren(svgIcon(pauseIcon));
    els.siteStatus.textContent = entry === tab.host ? 'Paused on this site' : `Paused on this site (rule for ${entry})`;
  } else if (!tab.running) {
    els.site.classList.add('is-off');
    els.siteIcon.replaceChildren(svgIcon(reloadIcon));
    els.siteStatus.textContent = 'Reload this page to start expanding here';
  } else {
    els.site.classList.add('is-on');
    els.siteIcon.replaceChildren(svgIcon(lightningIcon));
    els.siteStatus.textContent = 'Expanding on this site';
  }
}

async function onToggleSite(): Promise<void> {
  if (!tab?.host) return;
  const enabled = els.siteToggle.checked;
  els.siteToggle.disabled = true;
  try {
    settings = await setSiteEnabled(tab.host, enabled);
    renderSite();
  } catch (error) {
    els.siteToggle.checked = !enabled;
    els.siteStatus.textContent = `Couldn't save: ${error instanceof Error ? error.message : 'unknown error'}`;
  } finally {
    els.siteToggle.disabled = false;
  }
}

// --- Snippet list -----------------------------------------------------------------------

function renderMode(): void {
  els.mode.textContent = settings.triggerMode === 'immediate' ? 'Expands as you type' : 'Expands after Space, Tab or Enter';
}

function renderTagSelect(): void {
  const tags = can('tags') ? allTags(snippets) : [];
  if (activeTag !== null && !tags.some((entry) => entry.tag.toLocaleLowerCase() === activeTag?.toLocaleLowerCase())) activeTag = null;
  els.tagSelect.hidden = tags.length === 0;
  els.tagSelect.replaceChildren(
    h('option', { text: 'All tags', attrs: { value: '' } }),
    ...tags.map((entry) => h('option', { text: `${entry.tag} (${entry.count})`, attrs: { value: entry.tag } })),
  );
  els.tagSelect.value = activeTag ?? '';
}

function renderList(): void {
  if (!loaded) return;
  if (fill) {
    renderPending = true;
    return;
  }
  renderTagSelect();
  const query = els.search.value.trim();
  const visible = filterByTag(searchSnippets(snippets, query), activeTag);
  const filtered = query !== '' || activeTag !== null;
  els.count.textContent = filtered ? `${visible.length} of ${snippets.length}` : String(snippets.length);
  const now = new Date();
  // Keep keyboard focus on the same snippet when a change elsewhere re-renders the list.
  const focused = document.activeElement?.closest('.snippet-button')?.querySelector('.abbr')?.textContent ?? null;
  els.list.replaceChildren(...visible.map((snippet) => renderRow(snippet, now)));
  if (focused !== null) listButtons().find((button) => button.querySelector('.abbr')?.textContent === focused)?.focus();
  els.listHead.hidden = snippets.length === 0;
  els.list.setAttribute('aria-busy', 'false');
  els.list.hidden = visible.length === 0;
  els.empty.hidden = visible.length > 0;
  if (visible.length > 0) return;
  if (snippets.length === 0) {
    els.empty.replaceChildren(
      svgIcon(keyboardIcon, 'empty-icon'),
      h('p', { class: 'fw-semibold text-body', text: 'No snippets yet' }),
      h('p', { text: 'Save text you type often and insert it with a short abbreviation.' }),
      h('button', { class: 'btn btn-primary btn-sm mt-1', text: 'Create a snippet', attrs: { type: 'button' }, on: { click: () => openManager(true) } }),
    );
  } else if (!query && activeTag !== null) {
    els.empty.replaceChildren(svgIcon(searchIcon, 'empty-icon'), h('p', { text: `No snippets are tagged ${activeTag}.` }));
  } else {
    els.empty.replaceChildren(
      svgIcon(searchIcon, 'empty-icon'),
      h('p', { text: activeTag === null ? `No snippets match "${query}".` : `No snippets tagged ${activeTag} match "${query}".` }),
    );
  }
}

function renderRow(snippet: Snippet, now: Date): HTMLLIElement {
  const indicator = h('span', { class: 'copy-indicator' }, svgIcon(copyIcon));
  // Show what gets copied: variables filled in, fill-in fields as their default or [Name].
  const fields = can('fill-in-fields') ? parseFields(snippet.text) : [];
  const preview = fields.length ? Object.fromEntries(fields.map((field) => [field.name, field.defaultValue || `[${field.name}]`])) : undefined;
  const rendered = renderForCopy(snippet.text, now, navigator.language, preview);
  const title = snippet.label || previewText(rendered, 80);
  const button = h(
    'button',
    {
      class: 'snippet-button',
      attrs: { type: 'button', title: `Copy "${previewText(rendered, 300)}"`, 'aria-label': `Copy ${snippet.abbreviation}: ${title}` },
      on: { click: () => (fields.length ? openFill(snippet, fields, button, indicator) : void copySnippet(snippet, button, indicator)) },
    },
    h('span', { class: 'abbr', text: snippet.abbreviation }),
    h(
      'span',
      { class: 'snippet-body' },
      h('span', { class: 'snippet-title', text: title }),
      snippet.label && h('span', { class: 'snippet-preview', text: previewText(rendered, 120) }),
    ),
    indicator,
  );
  return h('li', { class: 'list-group-item p-0' }, button);
}

// --- Fill-in fields (Pro) -----------------------------------------------------------------

function closeFill(focusButton: boolean): void {
  if (!fill) return;
  const { form, button } = fill;
  fill = null;
  form.remove();
  button.setAttribute('aria-expanded', 'false');
  if (focusButton && button.isConnected) button.focus();
  if (renderPending) {
    renderPending = false;
    renderList();
  }
}

/** Asks for the snippet's fill-in values right under it, then copies. Keyboard-first. */
function openFill(snippet: Snippet, fields: readonly FillField[], button: HTMLButtonElement, indicator: HTMLSpanElement): void {
  if (fill?.button === button) {
    closeFill(true);
    return;
  }
  closeFill(false);
  const inputs = fields.map((field, index) => {
    const input = h('input', {
      class: 'form-control form-control-sm',
      attrs: { type: 'text', id: `fill-${index}`, autocomplete: 'off', 'data-field': field.name },
    });
    input.value = field.defaultValue;
    return input;
  });
  const cancel = h('button', { class: 'btn btn-sm btn-outline-secondary', text: 'Cancel', attrs: { type: 'button' } });
  const form = h(
    'form',
    { class: 'fill-inline', attrs: { 'aria-label': `Fill in ${snippet.abbreviation}`, novalidate: '' } },
    ...fields.map((field, index) => h('div', { class: 'fill-row' }, h('label', { class: 'form-label', text: field.name, attrs: { for: `fill-${index}` } }), inputs[index] ?? null)),
    h(
      'div',
      { class: 'fill-foot' },
      h('span', { class: 'fill-hint', text: 'Enter copies · Esc cancels' }),
      cancel,
      h('button', { class: 'btn btn-sm btn-primary', text: 'Copy', attrs: { type: 'submit' } }),
    ),
  );
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const values = Object.fromEntries(fields.map((field, index) => [field.name, normalizeInputValue(inputs[index]?.value ?? '')]));
    closeFill(true);
    void copySnippet(snippet, button, indicator, values);
  });
  form.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      // Only the form closes, not the popup.
      event.preventDefault();
      event.stopPropagation();
      closeFill(true);
    }
  });
  cancel.addEventListener('click', () => closeFill(true));
  button.after(form);
  button.setAttribute('aria-expanded', 'true');
  fill = { form, button };
  form.scrollIntoView({ block: 'nearest' });
  inputs[0]?.focus();
  inputs[0]?.select();
}

async function copySnippet(snippet: Snippet, button: HTMLButtonElement, indicator: HTMLSpanElement, inputs?: Record<string, string>): Promise<void> {
  els.error.hidden = true;
  const copied = await copyText(renderForCopy(snippet.text, new Date(), navigator.language, inputs));
  if (!copied) {
    els.error.textContent = "Couldn't copy to the clipboard. Click the snippet again, or open the manager and copy the text from there.";
    els.error.hidden = false;
    return;
  }
  els.copyStatus.textContent = `Copied ${snippet.abbreviation}`;
  button.classList.add('copied');
  indicator.replaceChildren(svgIcon(checkIcon), h('span', { text: 'Copied' }));
  window.setTimeout(() => {
    button.classList.remove('copied');
    indicator.replaceChildren(svgIcon(copyIcon));
  }, 1500);
}

function openManager(newSnippet = false): void {
  if (newSnippet) void chrome.tabs.create({ url: chrome.runtime.getURL('options.html#new') });
  else void chrome.runtime.openOptionsPage();
  window.close();
}

function listButtons(): HTMLButtonElement[] {
  return [...els.list.querySelectorAll<HTMLButtonElement>('.snippet-button')];
}

// --- Setup ------------------------------------------------------------------------------

async function init(): Promise<void> {
  els.managerIcon.append(svgIcon(gearIcon));
  els.searchIcon.append(svgIcon(searchIcon));
  els.search.focus();

  const [tabResult, dataResult] = await Promise.allSettled([inspectTab(), Promise.all([loadSnippets(), loadSettings(), loadPlanState()])]);
  tab = tabResult.status === 'fulfilled' ? tabResult.value : { host: null, label: 'This page', running: false };
  if (dataResult.status === 'rejected') {
    els.list.hidden = true;
    els.listHead.hidden = true;
    els.error.textContent = "Couldn't load your snippets. Close and reopen this popup to try again.";
    els.error.hidden = false;
    els.siteHost.classList.remove('placeholder-glow');
    els.siteHost.textContent = tab.label;
    return;
  }
  [snippets, settings, plan] = dataResult.value;
  loaded = true;
  renderList();
  renderMode();
  renderSite();

  onStoreChanged((change) => {
    if (change.snippets) snippets = change.snippets;
    if (change.settings) settings = change.settings;
    if (change.plan) plan = change.plan;
    renderList();
    renderMode();
    renderSite();
  });
}

els.managerIcon.addEventListener('click', () => openManager());
els.manager.addEventListener('click', () => openManager());
els.siteToggle.addEventListener('change', () => void onToggleSite());
els.search.addEventListener('input', () => {
  closeFill(false);
  renderList();
});
els.tagSelect.addEventListener('change', () => {
  activeTag = els.tagSelect.value || null;
  closeFill(false);
  renderList();
});
els.search.addEventListener('keydown', (event) => {
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    listButtons()[0]?.focus();
  } else if (event.key === 'Enter') {
    event.preventDefault();
    listButtons()[0]?.click();
  }
});
els.list.addEventListener('keydown', (event) => {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
  if (event.target instanceof Element && event.target.closest('.fill-inline')) return;
  event.preventDefault();
  const buttons = listButtons();
  const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
  const next = event.key === 'ArrowDown' ? buttons[index + 1] : index <= 0 ? els.search : buttons[index - 1];
  next?.focus();
});

init().catch(() => {
  els.error.textContent = 'Something went wrong. Close and reopen this popup.';
  els.error.hidden = false;
});
