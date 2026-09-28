import { isIndexFull, limitMessage, PRO_FEATURES, PRO_PRICE } from '../core/plan';
import { addTags, hasTag, MAX_TAGS_PER_CONVERSATION, removeTag, tagCounts } from '../core/tags';
import { SITE_NAMES, type SiteId } from '../core/types';
import { bestMessage, SearchIndex, type SearchDoc, type SearchResult } from '../search/engine';
import type { Clause } from '../search/query';
import { highlight, makeSnippet, type Segment } from '../search/snippet';
import { clearConversations, deleteConversation, getAllConversations, notifyIndexChanged, onIndexChanged, putConversation, updateConversationMeta } from '../storage/db';
import { DEFAULT_PLAN_STATE, loadPlan, onPlanChanged, type PlanState } from '../storage/plan';
import { buildIndexExport, formatBytes, type StoredConversation, type UserMeta } from '../storage/record';
import { loadSettings, onSettingsChanged, saveSettings } from '../storage/settings';
import { byId, h } from '../ui/dom';
import { downloadText } from '../ui/download';
import { formatDay, isoDay, plural } from '../ui/format';
import { icon, ICONS } from '../ui/icons';

/**
 * Search page. Loads every saved conversation from IndexedDB once, searches in memory, and
 * reloads when the service worker reports a change. Conversation text is only ever rendered as
 * text nodes; highlights are <mark> elements built around text nodes.
 *
 * Pro features (favourites, tags, export, unlimited index) are checked through the plan seam
 * (core/plan.ts via storage/plan.ts) only. Removing a star or a tag is always allowed: nothing the
 * user made is ever locked.
 */

const PAGE_SIZE = 50;
const SEARCH_DELAY_MS = 80;
/** Identifies this page's own change notices, which it has already applied. */
const PAGE_ID = `search-${Math.random().toString(36).slice(2)}`;

type SiteFilter = SiteId | 'all';

const els = {
  form: byId<HTMLFormElement>('search-form'),
  query: byId<HTMLInputElement>('query'),
  searchIcon: byId<HTMLSpanElement>('search-icon'),
  summary: byId<HTMLSpanElement>('summary'),
  filterStarred: byId<HTMLButtonElement>('filter-starred'),
  filterStarredIcon: byId<HTMLSpanElement>('filter-starred-icon'),
  activeTag: byId<HTMLSpanElement>('active-tag'),
  activeTagIcon: byId<HTMLSpanElement>('active-tag-icon'),
  activeTagName: byId<HTMLSpanElement>('active-tag-name'),
  activeTagClear: byId<HTMLButtonElement>('active-tag-clear'),
  limitNotice: byId<HTMLDivElement>('limit-notice'),
  limitNoticeIcon: byId<HTMLSpanElement>('limit-notice-icon'),
  limitNoticeText: byId<HTMLSpanElement>('limit-notice-text'),
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
  limitMeter: byId<HTMLDivElement>('limit-meter'),
  limitMeterText: byId<HTMLSpanElement>('limit-meter-text'),
  limitMeterBar: byId<HTMLDivElement>('limit-meter-bar'),
  autoSave: byId<HTMLInputElement>('auto-save'),
  privacyIcon: byId<HTMLSpanElement>('privacy-icon'),
  export: byId<HTMLButtonElement>('export'),
  exportIcon: byId<HTMLSpanElement>('export-icon'),
  exportNote: byId<HTMLParagraphElement>('export-note'),
  clear: byId<HTMLButtonElement>('clear'),
  clearIcon: byId<HTMLSpanElement>('clear-icon'),
  clearConfirm: byId<HTMLDivElement>('clear-confirm'),
  clearQuestion: byId<HTMLDivElement>('clear-question'),
  clearYes: byId<HTMLButtonElement>('clear-yes'),
  clearNo: byId<HTMLButtonElement>('clear-no'),
  manageStatus: byId<HTMLParagraphElement>('manage-status'),
  tagList: byId<HTMLDivElement>('tag-list'),
  tagsEmpty: byId<HTMLParagraphElement>('tags-empty'),
  aboutPro: byId<HTMLDivElement>('about-pro'),
  aboutProIcon: byId<HTMLSpanElement>('about-pro-icon'),
  planLine: byId<HTMLParagraphElement>('plan-line'),
  proFeatures: byId<HTMLUListElement>('pro-features'),
  getPro: byId<HTMLButtonElement>('get-pro'),
  proPrice: byId<HTMLSpanElement>('pro-price'),
  proAvailability: byId<HTMLDivElement>('pro-availability'),
  toast: byId<HTMLDivElement>('toast'),
  toastText: byId<HTMLSpanElement>('toast-text'),
  toastUndo: byId<HTMLButtonElement>('toast-undo'),
};

let records: StoredConversation[] = [];
let index = new SearchIndex([]);
let plan: PlanState = DEFAULT_PLAN_STATE;
let site: SiteFilter = 'all';
let starredOnly = false;
let tagFilter: string | null = null;
let shown = PAGE_SIZE;
let lastResults: SearchResult[] = [];
let lastClauses: Clause[] = [];
let searchTimer: number | undefined;
let toastTimer: number | undefined;
let undo: (() => Promise<void>) | null = null;
/** Key of the result whose "add tag" field is open. */
let editingTags: string | null = null;
/** An index reload that waits until the tag field is closed. */
let reloadPending = false;

// --- Loading --------------------------------------------------------------------------------

async function load(): Promise<void> {
  reloadPending = false;
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
    starred: record.starred,
    tags: record.tags,
  };
}

// --- Searching ------------------------------------------------------------------------------

function runSearch(resetPaging = true): void {
  if (resetPaging) shown = PAGE_SIZE;
  const query = els.query.value;
  const outcome = index.search(query, { site, starred: starredOnly, tag: tagFilter });
  lastResults = outcome.results;
  lastClauses = outcome.clauses;
  syncUrl(query);
  render(outcome.took);
}

function filterLabel(): string {
  const parts: string[] = [];
  if (starredOnly) parts.push('starred');
  if (site !== 'all') parts.push(SITE_NAMES[site]);
  return parts.join(' ');
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
    const where = [site === 'all' ? '' : ` in ${SITE_NAMES[site]}`, tagFilter ? ` tagged “${tagFilter}”` : ''].join('');
    els.noResultsTitle.textContent = hasQuery
      ? `No ${starredOnly ? 'starred ' : ''}conversations match “${els.query.value.trim()}”${where}.`
      : `No ${filterLabel() ? `${filterLabel()} ` : ''}conversations${tagFilter ? ` tagged “${tagFilter}”` : ''} saved yet.`;
  }
  // Keep keyboard focus on the same control when the list is rebuilt (star, tag, remove).
  const focusId = (document.activeElement as HTMLElement | null)?.dataset?.focusId;
  els.results.replaceChildren(...lastResults.slice(0, shown).map((result) => renderResult(result, lastClauses)));
  if (focusId) els.results.querySelector<HTMLElement>(`[data-focus-id="${CSS.escape(focusId)}"]`)?.focus();
  const editor = editingTags ? els.results.querySelector<HTMLInputElement>('.tag-editor input') : null;
  if (editor && !focusId) editor.focus();
  els.more.hidden = lastResults.length <= shown;
  els.more.textContent = `Show more (${(lastResults.length - shown).toLocaleString('en-US')} left)`;
}

function renderResult(result: SearchResult, clauses: Clause[]): HTMLLIElement {
  const { doc } = result;
  const messageIndex = bestMessage(doc, clauses);
  const message = doc.messages[messageIndex] ?? doc.messages.find((candidate) => candidate.role === 'user') ?? doc.messages[0];
  const snippet = message ? makeSnippet(message.text, clauses) : [];
  const role = message ? (message.role === 'user' ? 'You' : SITE_NAMES[doc.site]) : '';
  const tags = doc.tags ?? [];

  const title = h('a', { class: 'result-title stretched-link', attrs: { href: safeUrl(doc.url), target: '_blank', rel: 'noopener noreferrer' } });
  title.append(...segmentsToNodes(highlight(doc.title, clauses)));

  const snippetLine = h('p', { class: 'result-snippet' });
  if (role) snippetLine.append(h('span', { class: 'fw-semibold', text: `${role}: ` }));
  snippetLine.append(...segmentsToNodes(snippet));

  const actions = h('div', { class: 'result-actions' });
  // A star can always be removed; adding one is Pro.
  if (plan.has('favourites') || doc.starred) {
    actions.append(
      h(
        'button',
        {
          class: `action-button star-button${doc.starred ? ' is-starred' : ''}`,
          attrs: {
            type: 'button',
            'aria-pressed': String(Boolean(doc.starred)),
            'aria-label': `Star “${doc.title}”`,
            title: doc.starred ? 'Starred. Click to unstar' : 'Star',
            'data-focus-id': `star:${doc.key}`,
          },
          on: { click: () => void onToggleStar(doc.key) },
        },
        icon(doc.starred ? ICONS.starFill : ICONS.star),
      ),
    );
  }
  if (plan.has('tags')) {
    actions.append(
      h(
        'button',
        {
          class: 'action-button tag-button',
          attrs: {
            type: 'button',
            'aria-label': `Add a tag to “${doc.title}”`,
            'aria-expanded': String(editingTags === doc.key),
            title: 'Add a tag',
            'data-focus-id': `tag:${doc.key}`,
          },
          on: { click: () => openTagEditor(doc.key) },
        },
        icon(ICONS.tag),
      ),
    );
  }
  actions.append(
    h(
      'button',
      {
        class: 'action-button delete-button',
        attrs: { type: 'button', 'aria-label': `Delete “${doc.title}” from the index`, title: 'Delete from the index' },
        on: { click: () => void onDelete(doc.key) },
      },
      icon(ICONS.trash3),
    ),
  );

  const tagRow = tags.length ? h('div', { class: 'result-tags', attrs: { role: 'list', 'aria-label': 'Tags' } }, ...tags.map((tag) => renderTagChip(doc, tag, clauses))) : null;

  return h(
    'li',
    { class: `list-group-item position-relative${doc.starred ? ' is-starred' : ''}`, attrs: { 'data-key': doc.key } },
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
        tagRow,
        editingTags === doc.key ? renderTagEditor(doc) : null,
      ),
      actions,
    ),
  );
}

function renderTagChip(doc: SearchDoc, tag: string, clauses: Clause[]): HTMLSpanElement {
  const name = h('button', {
    class: 'chip-name',
    attrs: { type: 'button', title: `Show conversations tagged “${tag}”`, 'data-focus-id': `filter:${doc.key}:${tag}` },
    on: { click: () => setTagFilter(tag) },
  });
  name.append(...segmentsToNodes(highlight(tag, clauses)));
  return h(
    'span',
    { class: 'tag-chip', attrs: { role: 'listitem' } },
    name,
    h(
      'button',
      {
        class: 'chip-remove',
        attrs: { type: 'button', 'aria-label': `Remove tag “${tag}” from “${doc.title}”`, title: 'Remove tag' },
        on: { click: () => void onRemoveTag(doc.key, tag) },
      },
      icon(ICONS.x),
    ),
  );
}

function renderTagEditor(doc: SearchDoc): HTMLFormElement {
  const input = h('input', {
    class: 'form-control form-control-sm',
    attrs: { type: 'text', placeholder: 'New tag', 'aria-label': `New tag for “${doc.title}”`, maxlength: '60', autocomplete: 'off', enterkeyhint: 'done' },
  });
  const status = h('span', { class: 'small text-body-secondary', attrs: { role: 'status', 'aria-live': 'polite' } });
  const full = (doc.tags?.length ?? 0) >= MAX_TAGS_PER_CONVERSATION;
  if (full) status.textContent = `Up to ${MAX_TAGS_PER_CONVERSATION} tags per conversation.`;
  const form = h(
    'form',
    { class: 'tag-editor', attrs: { 'data-key': doc.key } },
    input,
    h('button', { class: 'btn btn-sm btn-primary', text: 'Add', attrs: { type: 'submit' } }),
    h('button', { class: 'btn btn-sm btn-link', text: 'Done', attrs: { type: 'button' }, on: { click: () => closeTagEditor(doc.key) } }),
    status,
  );
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const value = input.value;
    if (!value.trim()) return;
    if (hasTag(doc.tags ?? [], value.trim().replace(/^#+/, ''))) {
      status.textContent = 'Already tagged.';
      return;
    }
    input.value = '';
    void onAddTags(doc.key, value);
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeTagEditor(doc.key);
    }
  });
  return form;
}

function openTagEditor(key: string): void {
  editingTags = editingTags === key ? null : key;
  runSearch(false);
  els.results.querySelector<HTMLInputElement>('.tag-editor input')?.focus();
}

function closeTagEditor(key: string): void {
  if (editingTags !== key) return;
  editingTags = null;
  runSearch(false);
  els.results.querySelector<HTMLElement>(`[data-focus-id="${CSS.escape(`tag:${key}`)}"]`)?.focus();
  if (reloadPending) void load();
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
  if (starredOnly) params.set('starred', '1');
  if (tagFilter) params.set('tag', tagFilter);
  const next = `${params.size ? `?${params}` : location.pathname}${location.hash}`;
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

function setStarredOnly(next: boolean): void {
  starredOnly = next;
  els.filterStarred.classList.toggle('active', starredOnly);
  els.filterStarred.setAttribute('aria-pressed', String(starredOnly));
  runSearch();
}

function setTagFilter(next: string | null): void {
  tagFilter = next && tagFilter !== next ? next : null;
  els.activeTag.hidden = tagFilter === null;
  els.activeTagName.textContent = tagFilter ?? '';
  els.activeTagClear.setAttribute('aria-label', tagFilter ? `Stop filtering by “${tagFilter}”` : 'Show all tags');
  renderTagList();
  runSearch();
}

// --- Favourites and tags --------------------------------------------------------------------

async function applyMeta(key: string, patch: Partial<UserMeta>): Promise<boolean> {
  let updated: StoredConversation | undefined;
  try {
    updated = await updateConversationMeta(key, patch);
  } catch (error) {
    showToast(`Couldn't save: ${error instanceof Error ? error.message : String(error)}`, null);
    return false;
  }
  if (!updated) {
    showToast('This conversation is no longer in the index.', null);
    await load();
    return false;
  }
  notifyIndexChanged(PAGE_ID);
  const saved = updated;
  records = records.map((record) => (record.key === key ? saved : record));
  index = new SearchIndex(records.map(toDoc));
  renderStats();
  runSearch(false);
  return true;
}

async function onToggleStar(key: string): Promise<void> {
  const record = records.find((candidate) => candidate.key === key);
  if (!record) return;
  if (!record.starred && !plan.has('favourites')) return;
  await applyMeta(key, { starred: !record.starred });
}

async function onAddTags(key: string, input: string): Promise<void> {
  const record = records.find((candidate) => candidate.key === key);
  if (!record || !plan.has('tags')) return;
  await applyMeta(key, { tags: addTags(record.tags, input) });
}

async function onRemoveTag(key: string, tag: string): Promise<void> {
  const record = records.find((candidate) => candidate.key === key);
  if (!record) return;
  const tags = removeTag(record.tags, tag);
  const done = await applyMeta(key, { tags });
  if (!done) return;
  // The filtered tag may be gone now.
  if (tagFilter && !records.some((candidate) => hasTag(candidate.tags, tagFilter ?? ''))) setTagFilter(null);
  showToast(`Removed tag “${tag}”.`, async () => {
    const current = records.find((candidate) => candidate.key === key);
    if (current) await applyMeta(key, { tags: addTags(current.tags, tag) });
  });
}

function renderTagList(): void {
  const counts = tagCounts(records.map((record) => record.tags));
  els.tagList.replaceChildren(
    ...counts.map(({ tag, count }) => {
      const active = tagFilter !== null && hasTag([tag], tagFilter);
      return h(
        'button',
        {
          class: `tag-filter${active ? ' active' : ''}`,
          attrs: { type: 'button', 'aria-pressed': String(active), 'data-tag': tag },
          on: { click: () => setTagFilter(tag) },
        },
        h('span', { text: tag }),
        h('span', { class: 'count', text: String(count) }),
      );
    }),
  );
  els.tagList.hidden = counts.length === 0;
  els.tagsEmpty.hidden = counts.length > 0;
  els.tagsEmpty.replaceChildren(
    ...(plan.has('tags')
      ? ['Use the tag button on a result to add one. Click a tag here to see only those conversations.']
      : ['Tag conversations to group them and find them faster. ', aboutProLink()]),
  );
}

// --- Stats, plan and management -------------------------------------------------------------

function renderStats(): void {
  const bytes = records.reduce((sum, record) => sum + record.bytes, 0);
  const bySite = (id: SiteId) => records.filter((record) => record.site === id).length;
  const starred = records.filter((record) => record.starred).length;
  els.statCount.textContent = plural(records.length, 'conversation');
  els.statDetail.textContent = `${formatBytes(bytes)} of text · ChatGPT ${bySite('chatgpt')} · Claude ${bySite('claude')}`;
  for (const badge of Array.from(document.querySelectorAll<HTMLElement>('[data-count]'))) {
    const id = badge.dataset.count;
    badge.textContent = String(id === 'all' ? records.length : id === 'starred' ? starred : bySite(id as SiteId));
  }
  const canExport = plan.has('export');
  els.export.disabled = records.length === 0 || !canExport;
  els.exportNote.hidden = canExport;
  els.clear.disabled = records.length === 0;

  // Starred: a Pro filter, still usable to find stars made earlier.
  const canFilterStarred = plan.has('favourites') || starred > 0;
  els.filterStarred.disabled = !canFilterStarred;
  els.filterStarred.title = canFilterStarred ? 'Show only starred conversations' : 'Starring conversations is part of Pro';

  const { maxConversations } = plan.limits;
  const limited = Number.isFinite(maxConversations);
  els.limitMeter.hidden = !limited;
  if (limited) {
    const used = Math.min(records.length, maxConversations);
    els.limitMeterText.textContent = `${records.length.toLocaleString('en-US')} of ${maxConversations.toLocaleString('en-US')} on Free`;
    els.limitMeterBar.style.width = `${Math.round((used / maxConversations) * 100)}%`;
    const bar = els.limitMeterBar.parentElement;
    bar?.setAttribute('aria-valuenow', String(records.length));
    bar?.setAttribute('aria-valuemin', '0');
    bar?.setAttribute('aria-valuemax', String(maxConversations));
  }
  const full = isIndexFull(records.length, plan.limits);
  els.limitNotice.hidden = !full;
  if (full) els.limitNoticeText.textContent = limitMessage(plan.limits);
  renderTagList();
}

function renderAboutPro(): void {
  els.planLine.textContent = plan.earlyAccess
    ? 'Early access: every Pro feature is on for everyone, free.'
    : plan.plan === 'pro'
      ? 'You have Pro. Thank you!'
      : 'You are on Free. Pro is a one-time purchase for people who search their chats every day.';
  els.proFeatures.replaceChildren(
    ...PRO_FEATURES.map(({ feature, title, description }) =>
      h(
        'li',
        { attrs: { 'data-feature': feature } },
        icon(plan.has(feature) ? ICONS.checkCircleFill : ICONS.gem, { class: plan.has(feature) ? 'text-success' : 'text-body-secondary' }),
        h('div', {}, h('div', { class: 'fw-semibold', text: title }), h('div', { class: 'text-body-secondary', text: description })),
      ),
    ),
  );
  els.proPrice.textContent = PRO_PRICE;
  // No payments adapter yet: the button stays disabled (see docs/MONETIZATION.md).
  els.getPro.disabled = true;
  els.proAvailability.textContent = plan.earlyAccess ? 'Free during early access' : plan.plan === 'pro' ? 'Already yours' : 'Coming soon';
}

function aboutProLink(text = 'About Pro'): HTMLAnchorElement {
  return h('a', { class: 'about-pro-link', text, attrs: { href: '#about-pro' } });
}

function showAboutPro(): void {
  els.aboutPro.scrollIntoView({ block: 'center' });
  els.aboutPro.focus({ preventScroll: true });
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
  notifyIndexChanged(PAGE_ID);
  removeLocally(key);
  showToast(`Deleted “${record.title}”.`, async () => {
    await putConversation(record);
    notifyIndexChanged(PAGE_ID);
    await load();
  });
}

function removeLocally(key: string): void {
  records = records.filter((record) => record.key !== key);
  index = new SearchIndex(records.map(toDoc));
  if (editingTags === key) editingTags = null;
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
  notifyIndexChanged(PAGE_ID);
  els.clearConfirm.hidden = true;
  records = [];
  index = new SearchIndex([]);
  editingTags = null;
  renderStats();
  setTagFilter(null);
  setManageStatus('All saved conversations were deleted.', 'success');
}

function onExport(): void {
  if (!plan.has('export')) return;
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

function applyPlan(next: PlanState): void {
  plan = next;
  renderAboutPro();
  renderStats();
  runSearch(false);
}

// --- Setup ----------------------------------------------------------------------------------

async function init(): Promise<void> {
  els.searchIcon.append(icon(ICONS.search));
  els.emptyIcon.append(icon(ICONS.database));
  els.noResultsIcon.append(icon(ICONS.search));
  els.privacyIcon.append(icon(ICONS.shieldLock));
  els.exportIcon.append(icon(ICONS.download));
  els.clearIcon.append(icon(ICONS.trash3));
  els.filterStarredIcon.append(icon(ICONS.starFill));
  els.activeTagIcon.append(icon(ICONS.tag));
  els.activeTagClear.append(icon(ICONS.x));
  els.limitNoticeIcon.append(icon(ICONS.infoCircleFill));
  els.aboutProIcon.append(icon(ICONS.gem));

  const params = new URLSearchParams(location.search);
  els.query.value = params.get('q') ?? '';
  const initialSite = params.get('site');
  if (initialSite === 'chatgpt' || initialSite === 'claude') {
    site = initialSite;
    for (const button of Array.from(document.querySelectorAll<HTMLButtonElement>('[data-site]'))) {
      button.classList.toggle('active', button.dataset.site === site);
      button.setAttribute('aria-pressed', String(button.dataset.site === site));
    }
  }
  if (params.get('starred') === '1') {
    starredOnly = true;
    els.filterStarred.classList.add('active');
    els.filterStarred.setAttribute('aria-pressed', 'true');
  }
  const initialTag = params.get('tag');
  if (initialTag) {
    tagFilter = initialTag;
    els.activeTag.hidden = false;
    els.activeTagName.textContent = initialTag;
  }

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
  document.addEventListener('click', (event) => {
    const link = (event.target as HTMLElement | null)?.closest('a.about-pro-link');
    if (!link) return;
    event.preventDefault();
    showAboutPro();
  });
  for (const button of Array.from(document.querySelectorAll<HTMLButtonElement>('[data-site]'))) {
    button.addEventListener('click', () => setSite((button.dataset.site ?? 'all') as SiteFilter));
  }
  els.filterStarred.addEventListener('click', () => setStarredOnly(!starredOnly));
  els.activeTagClear.addEventListener('click', () => setTagFilter(null));
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
  onPlanChanged(applyPlan);

  let reloadTimer: number | undefined;
  onIndexChanged(() => {
    window.clearTimeout(reloadTimer);
    reloadTimer = window.setTimeout(() => {
      // Don't pull the list out from under someone typing a tag; reload when they're done.
      if (editingTags) reloadPending = true;
      else void load();
    }, 150);
  }, PAGE_ID);

  try {
    const settings = await loadSettings();
    els.autoSave.checked = settings.autoSave;
    updateEmptyText(settings.autoSave);
  } catch {
    els.autoSave.checked = true;
    updateEmptyText(true);
  }
  plan = await loadPlan();
  renderAboutPro();
  els.query.focus();
  await load();
  if (location.hash === '#about-pro') showAboutPro();
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
