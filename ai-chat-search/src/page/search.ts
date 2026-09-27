import { SITE_NAMES, type SiteId } from '../core/types';
import { bestMessage, SearchIndex, type SearchDoc, type SearchResult } from '../search/engine';
import type { Clause } from '../search/query';
import { highlight, makeSnippet, type Segment } from '../search/snippet';
import { clearConversations, deleteConversation, getAllConversations, notifyIndexChanged, onIndexChanged, putConversation } from '../storage/db';
import { buildIndexExport, formatBytes, type StoredConversation } from '../storage/record';
import { loadSettings, onSettingsChanged, saveSettings } from '../storage/settings';
import { byId, h } from '../ui/dom';
import { downloadText } from '../ui/download';
import { formatDay, isoDay, plural } from '../ui/format';
import { icon, ICONS } from '../ui/icons';

/**
 * Search page. Loads every saved conversation from IndexedDB once, searches in memory, and
 * reloads when the service worker reports a change. Conversation text is only ever rendered as
 * text nodes; highlights are <mark> elements built around text nodes.
 */

const PAGE_SIZE = 50;
const SEARCH_DELAY_MS = 80;

type SiteFilter = SiteId | 'all';

const els = {
  form: byId<HTMLFormElement>('search-form'),
  query: byId<HTMLInputElement>('query'),
  searchIcon: byId<HTMLSpanElement>('search-icon'),
  summary: byId<HTMLSpanElement>('summary'),
  loading: byId<HTMLDivElement>('state-loading'),
  error: byId<HTMLDivElement>('state-error'),
  errorDetail: byId<HTMLDivElement>('error-detail'),
  retry: byId<HTMLButtonElement>('retry'),
  empty: byId<HTMLDivElement>('state-empty'),
  emptyIcon: byId<HTMLSpanElement>('empty-icon'),
  emptyText: byId<HTMLParagraphElement>('empty-text'),
  noResults: byId<HTMLDivElement>('state-no-results'),
  noResultsIcon: byId<HTMLSpanElement>('no-results-icon'),
  noResultsTitle: byId<HTMLHeadingElement>('no-results-title'),
  results: byId<HTMLOListElement>('results'),
  more: byId<HTMLButtonElement>('more'),
  statCount: byId<HTMLDivElement>('stat-count'),
  statDetail: byId<HTMLDivElement>('stat-detail'),
  autoSave: byId<HTMLInputElement>('auto-save'),
  privacyIcon: byId<HTMLSpanElement>('privacy-icon'),
  export: byId<HTMLButtonElement>('export'),
  exportIcon: byId<HTMLSpanElement>('export-icon'),
  clear: byId<HTMLButtonElement>('clear'),
  clearIcon: byId<HTMLSpanElement>('clear-icon'),
  clearConfirm: byId<HTMLDivElement>('clear-confirm'),
  clearQuestion: byId<HTMLDivElement>('clear-question'),
  clearYes: byId<HTMLButtonElement>('clear-yes'),
  clearNo: byId<HTMLButtonElement>('clear-no'),
  manageStatus: byId<HTMLParagraphElement>('manage-status'),
  toast: byId<HTMLDivElement>('toast'),
  toastText: byId<HTMLSpanElement>('toast-text'),
  toastUndo: byId<HTMLButtonElement>('toast-undo'),
};

let records: StoredConversation[] = [];
let index = new SearchIndex([]);
let site: SiteFilter = 'all';
let shown = PAGE_SIZE;
let lastResults: SearchResult[] = [];
let lastClauses: Clause[] = [];
let searchTimer: number | undefined;
let toastTimer: number | undefined;
let undo: (() => Promise<void>) | null = null;

// --- Loading --------------------------------------------------------------------------------

async function load(): Promise<void> {
  try {
    const { records: loaded, skipped } = await getAllConversations();
    records = loaded;
    index = new SearchIndex(records.map(toDoc));
    if (skipped) setManageStatus(`${plural(skipped, 'saved conversation')} could not be read and ${skipped === 1 ? 'was' : 'were'} skipped.`, 'error');
    els.loading.hidden = true;
    els.error.hidden = true;
    renderStats();
    runSearch();
  } catch (error) {
    els.loading.hidden = true;
    els.results.hidden = true;
    els.errorDetail.textContent = error instanceof Error ? error.message : String(error);
    els.error.hidden = false;
  }
}

function toDoc(record: StoredConversation): SearchDoc {
  return {
    key: record.key,
    site: record.site,
    title: record.title,
    url: record.url,
    updatedAt: record.updatedAt,
    messages: record.messages,
    searchText: record.searchText,
  };
}

// --- Searching ------------------------------------------------------------------------------

function runSearch(resetPaging = true): void {
  if (resetPaging) shown = PAGE_SIZE;
  const query = els.query.value;
  const outcome = index.search(query, { site });
  lastResults = outcome.results;
  lastClauses = outcome.clauses;
  syncUrl(query);
  render(outcome.took);
}

function render(took: number): void {
  const hasQuery = lastClauses.length > 0;
  els.empty.hidden = records.length > 0;
  els.noResults.hidden = records.length === 0 || lastResults.length > 0;
  els.results.hidden = lastResults.length === 0;
  if (records.length === 0) {
    els.summary.textContent = '';
  } else if (hasQuery) {
    els.summary.textContent = `${plural(lastResults.length, 'result')} · ${took < 1 ? '<1' : Math.round(took)} ms`;
  } else {
    els.summary.textContent = `${plural(lastResults.length, 'conversation')}, newest first`;
  }
  if (!els.noResults.hidden) {
    els.noResultsTitle.textContent = hasQuery
      ? `No conversations match “${els.query.value.trim()}”${site === 'all' ? '' : ` in ${SITE_NAMES[site]}`}.`
      : `No ${SITE_NAMES[site as SiteId] ?? ''} conversations saved yet.`;
  }
  els.results.replaceChildren(...lastResults.slice(0, shown).map((result) => renderResult(result, lastClauses)));
  els.more.hidden = lastResults.length <= shown;
  els.more.textContent = `Show more (${(lastResults.length - shown).toLocaleString('en-US')} left)`;
}

function renderResult(result: SearchResult, clauses: Clause[]): HTMLLIElement {
  const { doc } = result;
  const messageIndex = bestMessage(doc, clauses);
  const message = doc.messages[messageIndex] ?? doc.messages.find((candidate) => candidate.role === 'user') ?? doc.messages[0];
  const snippet = message ? makeSnippet(message.text, clauses) : [];
  const role = message ? (message.role === 'user' ? 'You' : SITE_NAMES[doc.site]) : '';

  const title = h('a', { class: 'result-title stretched-link', attrs: { href: safeUrl(doc.url), target: '_blank', rel: 'noopener noreferrer' } });
  title.append(...segmentsToNodes(highlight(doc.title, clauses)));

  const snippetLine = h('p', { class: 'result-snippet' });
  if (role) snippetLine.append(h('span', { class: 'fw-semibold', text: `${role}: ` }));
  snippetLine.append(...segmentsToNodes(snippet));

  const remove = h(
    'button',
    {
      class: 'delete-button',
      attrs: { type: 'button', 'aria-label': `Delete “${doc.title}” from the index`, title: 'Delete from the index' },
      on: { click: () => void onDelete(doc.key) },
    },
    icon(ICONS.trash3),
  );

  return h(
    'li',
    { class: 'list-group-item position-relative', attrs: { 'data-key': doc.key } },
    h(
      'div',
      { class: 'd-flex align-items-start gap-2' },
      h(
        'div',
        { class: 'flex-grow-1 min-w-0', attrs: { style: 'min-width: 0' } },
        title,
        h(
          'div',
          { class: 'result-meta' },
          h('span', { class: 'badge site-badge', text: SITE_NAMES[doc.site] }),
          h('span', { text: formatDay(doc.updatedAt) }),
          h('span', { text: '·' }),
          h('span', { text: plural(doc.messages.length, 'message') }),
        ),
        snippet.length ? snippetLine : null,
      ),
      remove,
    ),
  );
}

/** Text nodes, with matches wrapped in <mark>. Never parses markup. */
function segmentsToNodes(segments: Segment[]): Node[] {
  return segments.map((segment) => (segment.match ? h('mark', { text: segment.text }) : document.createTextNode(segment.text)));
}

/** Saved URLs come from chat pages; only web URLs become links. */
function safeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : '#';
  } catch {
    return '#';
  }
}

function syncUrl(query: string): void {
  const params = new URLSearchParams();
  if (query.trim()) params.set('q', query);
  if (site !== 'all') params.set('site', site);
  const next = params.size ? `?${params}` : location.pathname;
  history.replaceState(null, '', next);
}

function setSite(next: SiteFilter): void {
  site = next;
  for (const button of Array.from(document.querySelectorAll<HTMLButtonElement>('[data-site]'))) {
    const active = button.dataset.site === site;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  }
  runSearch();
}

// --- Stats and management -------------------------------------------------------------------

function renderStats(): void {
  const bytes = records.reduce((sum, record) => sum + record.bytes, 0);
  const bySite = (id: SiteId) => records.filter((record) => record.site === id).length;
  els.statCount.textContent = plural(records.length, 'conversation');
  els.statDetail.textContent = `${formatBytes(bytes)} of text · ChatGPT ${bySite('chatgpt')} · Claude ${bySite('claude')}`;
  for (const badge of Array.from(document.querySelectorAll<HTMLElement>('[data-count]'))) {
    const id = badge.dataset.count;
    badge.textContent = String(id === 'all' ? records.length : bySite(id as SiteId));
  }
  els.export.disabled = records.length === 0;
  els.clear.disabled = records.length === 0;
}

function setManageStatus(text: string, tone: 'success' | 'error'): void {
  els.manageStatus.hidden = !text;
  els.manageStatus.textContent = text;
  els.manageStatus.className = `small mt-2 mb-0 ${tone === 'error' ? 'text-danger' : 'text-success-emphasis'}`;
}

async function onDelete(key: string): Promise<void> {
  const record = records.find((candidate) => candidate.key === key);
  if (!record) return;
  try {
    await deleteConversation(key);
  } catch (error) {
    showToast(`Couldn't delete: ${error instanceof Error ? error.message : String(error)}`, null);
    return;
  }
  notifyIndexChanged();
  removeLocally(key);
  showToast(`Deleted “${record.title}”.`, async () => {
    await putConversation(record);
    notifyIndexChanged();
    await load();
  });
}

function removeLocally(key: string): void {
  records = records.filter((record) => record.key !== key);
  index = new SearchIndex(records.map(toDoc));
  renderStats();
  runSearch(false);
}

async function onClearConfirmed(): Promise<void> {
  try {
    await clearConversations();
  } catch (error) {
    els.clearQuestion.textContent = `Couldn't clear the index: ${error instanceof Error ? error.message : String(error)}`;
    return;
  }
  notifyIndexChanged();
  els.clearConfirm.hidden = true;
  records = [];
  index = new SearchIndex([]);
  renderStats();
  runSearch();
  setManageStatus('All saved conversations were deleted.', 'success');
}

function onExport(): void {
  const now = new Date();
  try {
    downloadText(`ai-chat-search-index ${isoDay(now)}.json`, buildIndexExport(records, now), 'application/json');
    setManageStatus(`Exported ${plural(records.length, 'conversation')}.`, 'success');
  } catch (error) {
    setManageStatus(`Couldn't export: ${error instanceof Error ? error.message : String(error)}`, 'error');
  }
}

function showToast(text: string, action: (() => Promise<void>) | null): void {
  window.clearTimeout(toastTimer);
  undo = action;
  els.toastText.textContent = text;
  els.toastUndo.hidden = action === null;
  els.toast.hidden = false;
  els.toast.classList.add('show');
  toastTimer = window.setTimeout(hideToast, action ? 8000 : 6000);
}

function hideToast(): void {
  els.toast.classList.remove('show');
  els.toast.hidden = true;
  undo = null;
}

// --- Setup ----------------------------------------------------------------------------------

async function init(): Promise<void> {
  els.searchIcon.append(icon(ICONS.search));
  els.emptyIcon.append(icon(ICONS.database));
  els.noResultsIcon.append(icon(ICONS.search));
  els.privacyIcon.append(icon(ICONS.shieldLock));
  els.exportIcon.append(icon(ICONS.download));
  els.clearIcon.append(icon(ICONS.trash3));

  const params = new URLSearchParams(location.search);
  els.query.value = params.get('q') ?? '';
  const initialSite = params.get('site');
  if (initialSite === 'chatgpt' || initialSite === 'claude') setSite(initialSite);

  els.form.addEventListener('submit', (event) => {
    event.preventDefault();
    runSearch();
  });
  els.query.addEventListener('input', () => {
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => runSearch(), SEARCH_DELAY_MS);
  });
  els.query.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && els.query.value) {
      event.preventDefault();
      els.query.value = '';
      runSearch();
    }
  });
  document.addEventListener('keydown', (event) => {
    const target = event.target as HTMLElement | null;
    if (event.key === '/' && !event.ctrlKey && !event.metaKey && target?.closest('input, textarea') === null) {
      event.preventDefault();
      els.query.focus();
      els.query.select();
    }
  });
  for (const button of Array.from(document.querySelectorAll<HTMLButtonElement>('[data-site]'))) {
    button.addEventListener('click', () => setSite((button.dataset.site ?? 'all') as SiteFilter));
  }
  els.more.addEventListener('click', () => {
    shown += PAGE_SIZE;
    render(0);
  });
  els.retry.addEventListener('click', () => {
    els.error.hidden = true;
    els.loading.hidden = false;
    void load();
  });
  els.export.addEventListener('click', onExport);
  els.clear.addEventListener('click', () => {
    els.clearQuestion.textContent = `Delete all ${plural(records.length, 'saved conversation')}? This can't be undone.`;
    els.clearConfirm.hidden = false;
    els.clearNo.focus();
  });
  els.clearNo.addEventListener('click', () => {
    els.clearConfirm.hidden = true;
  });
  els.clearYes.addEventListener('click', () => void onClearConfirmed());
  els.toastUndo.addEventListener('click', () => {
    const action = undo;
    hideToast();
    action?.().catch((error: unknown) => showToast(`Couldn't undo: ${error instanceof Error ? error.message : String(error)}`, null));
  });
  els.autoSave.addEventListener('change', () => {
    saveSettings({ autoSave: els.autoSave.checked }).catch(() => {
      els.autoSave.checked = !els.autoSave.checked;
      setManageStatus("Couldn't save this setting.", 'error');
    });
  });
  onSettingsChanged((settings) => {
    els.autoSave.checked = settings.autoSave;
    updateEmptyText(settings.autoSave);
  });

  let reloadTimer: number | undefined;
  onIndexChanged(() => {
    window.clearTimeout(reloadTimer);
    reloadTimer = window.setTimeout(() => void load(), 150);
  });

  try {
    const settings = await loadSettings();
    els.autoSave.checked = settings.autoSave;
    updateEmptyText(settings.autoSave);
  } catch {
    els.autoSave.checked = true;
    updateEmptyText(true);
  }
  els.query.focus();
  await load();
}

function updateEmptyText(autoSave: boolean): void {
  els.emptyText.textContent = autoSave
    ? 'Open a conversation on ChatGPT or Claude and it will be saved here automatically.'
    : 'Auto-save is off. Open a conversation and click “Save this conversation” in the toolbar popup.';
}

init().catch((error: unknown) => {
  els.loading.hidden = true;
  els.errorDetail.textContent = error instanceof Error ? error.message : String(error);
  els.error.hidden = false;
});
