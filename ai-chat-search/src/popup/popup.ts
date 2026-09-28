import { isIndexFull, limitMessage } from '../core/plan';
import { SITE_NAMES, type Conversation } from '../core/types';
import type { DescribeResponse, ReadResponse, SaveRequest, SaveResponse } from '../platform/messages';
import { clearConversations, getAllSummaries, getSummary, notifyIndexChanged, type ConversationSummary } from '../storage/db';
import { DEFAULT_PLAN_STATE, loadPlan, type PlanState } from '../storage/plan';
import { conversationKey, formatBytes } from '../storage/record';
import { loadSettings, saveSettings } from '../storage/settings';
import { byId } from '../ui/dom';
import { plural, relativeTime } from '../ui/format';
import { icon, ICONS } from '../ui/icons';

/** Toolbar popup: search box, the open conversation's save state, and the privacy setting. */

const els = {
  form: byId<HTMLFormElement>('search-form'),
  query: byId<HTMLInputElement>('query'),
  searchIcon: byId<HTMLSpanElement>('search-icon'),
  searchGo: byId<HTMLButtonElement>('search-go'),
  stats: byId<HTMLSpanElement>('stats'),
  browse: byId<HTMLAnchorElement>('browse'),
  limitNotice: byId<HTMLDivElement>('limit-notice'),
  limitNoticeIcon: byId<HTMLSpanElement>('limit-notice-icon'),
  limitNoticeText: byId<HTMLSpanElement>('limit-notice-text'),
  aboutPro: byId<HTMLAnchorElement>('about-pro'),
  loading: byId<HTMLDivElement>('loading'),
  empty: byId<HTMLDivElement>('empty'),
  emptyIcon: byId<HTMLDivElement>('empty-icon'),
  error: byId<HTMLDivElement>('error'),
  errorIcon: byId<HTMLSpanElement>('error-icon'),
  errorText: byId<HTMLDivElement>('error-text'),
  conversation: byId<HTMLDivElement>('conversation'),
  title: byId<HTMLDivElement>('title'),
  siteBadge: byId<HTMLSpanElement>('site-badge'),
  count: byId<HTMLSpanElement>('count'),
  savedState: byId<HTMLDivElement>('saved-state'),
  streaming: byId<HTMLDivElement>('streaming'),
  save: byId<HTMLButtonElement>('save'),
  saveIcon: byId<HTMLSpanElement>('save-icon'),
  saveLabel: byId<HTMLSpanElement>('save-label'),
  status: byId<HTMLParagraphElement>('status'),
  autoSave: byId<HTMLInputElement>('auto-save'),
  privacyIcon: byId<HTMLSpanElement>('privacy-icon'),
  manage: byId<HTMLAnchorElement>('manage'),
  clear: byId<HTMLButtonElement>('clear'),
  clearConfirm: byId<HTMLDivElement>('clear-confirm'),
  clearQuestion: byId<HTMLDivElement>('clear-question'),
  clearYes: byId<HTMLButtonElement>('clear-yes'),
  clearNo: byId<HTMLButtonElement>('clear-no'),
};

let tabId: number | null = null;
let current: { site: Conversation['site']; conversationId: string | null } | null = null;
let plan: PlanState = DEFAULT_PLAN_STATE;
/** Free index full: new conversations can't be added (saved ones still update). */
let indexFull = false;

type View = 'loading' | 'empty' | 'error' | 'conversation';

function show(view: View): void {
  els.loading.hidden = view !== 'loading';
  els.empty.hidden = view !== 'empty';
  els.error.hidden = view !== 'error';
  els.conversation.hidden = view !== 'conversation';
}

function setStatus(text: string, tone: 'success' | 'error' | 'muted'): void {
  els.status.hidden = !text;
  els.status.textContent = text;
  els.status.className = `small mt-2 mb-0 ${tone === 'error' ? 'text-danger' : tone === 'success' ? 'text-success-emphasis' : 'text-body-secondary'}`;
}

function openSearch(query = '', hash = ''): void {
  const url = chrome.runtime.getURL(`search.html${query ? `?q=${encodeURIComponent(query)}` : ''}${hash}`);
  chrome.tabs.create({ url }).then(
    () => window.close(),
    () => setStatus("Couldn't open the search page.", 'error'),
  );
}

async function activeTabId(): Promise<number | null> {
  if (__E2E__) {
    // Test build: the popup is opened as a normal tab and told which tab to act on.
    const forced = new URLSearchParams(location.search).get('tab');
    if (forced) return Number(forced);
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id ?? null;
}

async function ask<T>(message: object): Promise<T | null> {
  if (tabId === null) return null;
  try {
    return ((await chrome.tabs.sendMessage(tabId, message)) as T | undefined) ?? null;
  } catch {
    return null;
  }
}

async function renderStats(): Promise<void> {
  try {
    const summaries = await getAllSummaries();
    const bytes = summaries.reduce((sum, summary) => sum + summary.bytes, 0);
    els.stats.textContent = summaries.length ? `${plural(summaries.length, 'conversation')} saved · ${formatBytes(bytes)}` : 'Nothing saved yet';
    indexFull = isIndexFull(summaries.length, plan.limits);
    els.limitNotice.hidden = !indexFull;
    if (indexFull) els.limitNoticeText.textContent = limitMessage(plan.limits);
  } catch (error) {
    els.stats.textContent = `Couldn't read the index: ${error instanceof Error ? error.message : String(error)}`;
    els.stats.classList.add('text-danger');
  }
}

async function renderSavedState(): Promise<void> {
  // Build first, swap once: clearing before the await left the line empty while the index was read.
  if (!current?.conversationId) {
    els.savedState.replaceChildren("This chat can't be saved until it has an address (after the first reply).");
    els.save.disabled = true;
    return;
  }
  let summary: ConversationSummary | undefined;
  try {
    summary = await getSummary(conversationKey(current.site, current.conversationId));
  } catch (error) {
    els.savedState.replaceChildren(`Couldn't check the index: ${error instanceof Error ? error.message : String(error)}`);
    els.save.disabled = false;
    return;
  }
  if (summary) {
    els.savedState.className = 'saved-state small mt-2 d-flex align-items-center gap-1 text-success-emphasis';
    els.savedState.replaceChildren(icon(ICONS.bookmarkCheck), `Saved ${relativeTime(summary.savedAt)}`);
    els.saveLabel.textContent = 'Save again';
    els.save.disabled = false;
  } else {
    els.savedState.className = 'saved-state small mt-2 d-flex align-items-center gap-1 text-body-secondary';
    els.savedState.replaceChildren(indexFull ? 'Not saved: the free index is full' : 'Not saved yet');
    els.saveLabel.textContent = 'Save this conversation';
    els.save.disabled = indexFull;
  }
}

async function describe(): Promise<void> {
  const response = await ask<DescribeResponse>({ type: 'ai-chat-search/describe' });
  if (!response) {
    show('empty');
    return;
  }
  if (!response.ok) {
    if (response.code === 'NOT_CONVERSATION') show('empty');
    else {
      els.errorText.textContent = response.message;
      show('error');
    }
    return;
  }
  current = { site: response.site, conversationId: response.conversationId };
  els.title.textContent = response.title;
  els.title.title = response.title;
  els.siteBadge.textContent = SITE_NAMES[response.site];
  els.count.textContent = plural(response.messageCount, 'message');
  els.streaming.hidden = !response.streaming;
  await renderSavedState();
  show('conversation');
}

async function onSave(): Promise<void> {
  els.save.disabled = true;
  setStatus('Saving…', 'muted');
  try {
    const read = await ask<ReadResponse>({ type: 'ai-chat-search/read' });
    if (!read) return setStatus('The page stopped responding. Reload it and try again.', 'error');
    if (!read.ok) return setStatus(read.message, 'error');
    const response = (await chrome.runtime.sendMessage({ type: 'ai-chat-search/save', conversation: read.conversation, trigger: 'manual' } satisfies SaveRequest)) as
      | SaveResponse
      | undefined;
    if (!response) return setStatus("Couldn't save. Please try again.", 'error');
    if (!response.ok) return setStatus(response.message, 'error');
    // Refresh the saved line first so "Saved" never shows next to a stale or empty state.
    await Promise.all([renderSavedState(), renderStats()]);
    setStatus(response.status === 'unchanged' ? 'Already up to date.' : 'Saved. It will show up in search.', 'success');
  } catch (error) {
    setStatus(`Couldn't save: ${error instanceof Error ? error.message : String(error)}`, 'error');
  } finally {
    await renderSavedState().catch(() => undefined);
  }
}

async function onClearConfirmed(): Promise<void> {
  try {
    await clearConversations();
    notifyIndexChanged();
    els.clearConfirm.hidden = true;
    setStatus('All saved conversations were deleted.', 'success');
    await Promise.all([renderStats(), current ? renderSavedState() : Promise.resolve()]);
  } catch (error) {
    els.clearQuestion.textContent = `Couldn't clear the index: ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function init(): Promise<void> {
  els.searchIcon.append(icon(ICONS.search));
  els.searchGo.append(icon(ICONS.arrowRight));
  els.emptyIcon.append(icon(ICONS.chatSquareText));
  els.errorIcon.append(icon(ICONS.exclamationTriangleFill));
  els.saveIcon.append(icon(ICONS.bookmarkPlus));
  els.privacyIcon.append(icon(ICONS.shieldLock));

  els.form.addEventListener('submit', (event) => {
    event.preventDefault();
    openSearch(els.query.value.trim());
  });
  els.limitNoticeIcon.append(icon(ICONS.infoCircleFill));
  els.aboutPro.addEventListener('click', (event) => {
    event.preventDefault();
    openSearch('', '#about-pro');
  });
  for (const link of [els.browse, els.manage]) {
    link.addEventListener('click', (event) => {
      event.preventDefault();
      openSearch();
    });
  }
  els.save.addEventListener('click', () => void onSave());
  els.autoSave.addEventListener('change', () => {
    saveSettings({ autoSave: els.autoSave.checked }).catch(() => {
      els.autoSave.checked = !els.autoSave.checked;
      setStatus("Couldn't save this setting.", 'error');
    });
  });
  els.clear.addEventListener('click', async () => {
    const count = (await getAllSummaries().catch(() => [])).length;
    els.clearQuestion.textContent = count ? `Delete all ${plural(count, 'saved conversation')}? This can't be undone.` : 'Nothing is saved yet.';
    els.clearYes.hidden = count === 0;
    els.clearConfirm.hidden = false;
  });
  els.clearNo.addEventListener('click', () => {
    els.clearConfirm.hidden = true;
  });
  els.clearYes.addEventListener('click', () => void onClearConfirmed());

  try {
    els.autoSave.checked = (await loadSettings()).autoSave;
  } catch {
    els.autoSave.checked = true;
  }
  els.query.focus();
  tabId = await activeTabId();
  plan = await loadPlan();
  // Stats first: whether the index is full decides the save button.
  await renderStats();
  await describe();
}

init().catch((error: unknown) => {
  els.errorText.textContent = `Something went wrong: ${error instanceof Error ? error.message : String(error)}`;
  show('error');
});
