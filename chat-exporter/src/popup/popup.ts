import { buildHandoff, compactTokens, describeSize } from '../core/handoff';
import { proMessage, type ProFeature } from '../core/plan';
import { SITE_NAMES, type Conversation } from '../core/types';
import { buildExportFile, featureFor, pdfTitle, type ExportAction } from '../export/actions';
import { isExportFormat, toMarkdownDocument } from '../export/formats';
import { describeExportOptions, effectiveExportOptions, type ExportOptions } from '../export/options';
import type { DescribeResponse, PrintRequest, PrintResponse, ReadResponse } from '../platform/messages';
import { loadPlan, planState, type PlanState } from '../storage/plan';
import { DEFAULT_SETTINGS, loadSettings, saveSettings, type Settings } from '../storage/settings';
import { copyText } from '../ui/clipboard';
import { byId, h } from '../ui/dom';
import { downloadText } from '../ui/download';
import { icon, ICONS } from '../ui/icons';

/** Toolbar popup: the same exports as the in-page button, for the active tab. */

const els = {
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
  streaming: byId<HTMLDivElement>('streaming'),
  copy: byId<HTMLButtonElement>('copy'),
  copyIcon: byId<HTMLSpanElement>('copy-icon'),
  handoff: byId<HTMLButtonElement>('handoff'),
  handoffSize: byId<HTMLSpanElement>('handoff-size'),
  optionsText: byId<HTMLSpanElement>('options-text'),
  editOptions: byId<HTMLButtonElement>('edit-options'),
  status: byId<HTMLParagraphElement>('status'),
  showButton: byId<HTMLInputElement>('show-button'),
  openOptions: byId<HTMLButtonElement>('open-options'),
  openHistory: byId<HTMLButtonElement>('open-history'),
  emptyHistory: byId<HTMLButtonElement>('empty-history'),
  aboutPro: byId<HTMLButtonElement>('about-pro'),
  planNote: byId<HTMLSpanElement>('plan-note'),
};

type View = 'loading' | 'empty' | 'error' | 'conversation';

let tabId: number | null = null;
let settings: Settings = DEFAULT_SETTINGS;
let plan: PlanState = planState('free');

function show(view: View): void {
  els.loading.hidden = view !== 'loading';
  els.empty.hidden = view !== 'empty';
  els.error.hidden = view !== 'error';
  els.conversation.hidden = view !== 'conversation';
}

function setStatus(text: string, tone: 'success' | 'error' | 'muted' = 'success', link?: { label: string; run: () => void }): void {
  els.status.replaceChildren(text);
  if (link) {
    els.status.append(' ', h('button', { class: 'btn btn-link btn-sm p-0 align-baseline', text: link.label, attrs: { type: 'button' }, on: { click: link.run } }));
  }
  els.status.className = `status-line small mt-2 mb-0 ${tone === 'error' ? 'text-danger' : tone === 'success' ? 'text-success-emphasis' : 'text-body-secondary'}`;
}

function showError(message: string): void {
  els.errorText.textContent = message;
  show('error');
}

function options(): ExportOptions {
  return effectiveExportOptions(settings.exportOptions, plan.has('export-options'));
}

function openOptionsPage(section: 'pro' | 'options' | 'import'): void {
  void chrome.tabs.create({ url: chrome.runtime.getURL(`options.html#${section}`) });
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

/** Sends a request to the content script. Null when there is none (not a chat page, or it needs a reload). */
async function ask<T>(message: object): Promise<T | null> {
  if (tabId === null) return null;
  try {
    return ((await chrome.tabs.sendMessage(tabId, message)) as T | undefined) ?? null;
  } catch {
    return null;
  }
}

async function describe(): Promise<void> {
  const response = await ask<DescribeResponse>({ type: 'chat-exporter/describe' });
  if (!response) {
    show('empty');
    return;
  }
  if (!response.ok) {
    if (response.code === 'NOT_CONVERSATION') {
      els.title.textContent = '';
      show('empty');
    } else {
      showError(response.message);
    }
    return;
  }
  els.title.textContent = response.title;
  els.title.title = response.title;
  els.siteBadge.textContent = SITE_NAMES[response.site];
  const total = typeof response.totalCount === 'number' ? response.totalCount : response.messageCount;
  const noun = total === 1 ? 'message' : 'messages';
  els.count.textContent = response.messageCount === total ? `${total} ${noun}` : `${response.messageCount} of ${total} ${noun}`;
  els.handoffSize.textContent = response.handoff ? compactTokens(response.handoff.tokens) : '';
  els.streaming.hidden = !response.streaming;
  show('conversation');
}

/** A subtle "Pro" label, with a lock only when the current plan doesn't include the feature. */
function renderProLabel(label: Element, feature: ProFeature): boolean {
  const locked = !plan.has(feature);
  label.replaceChildren(...(locked ? [icon(ICONS.lockFill)] : []), 'Pro');
  label.classList.toggle('pro-locked', locked);
  label.setAttribute('title', locked ? 'Pro feature: see About Pro' : plan.plan === 'pro' ? 'Pro feature' : 'Pro feature (free during early access)');
  return locked;
}

/** Pro labels, locks and the export options summary for the current plan. */
function renderPlan(): void {
  for (const button of Array.from(document.querySelectorAll<HTMLButtonElement>('[data-format]'))) {
    const feature = featureFor(button.dataset.format as ExportAction);
    const label = button.querySelector('.pro-label');
    const locked = feature !== null && label !== null && renderProLabel(label, feature);
    button.classList.toggle('locked', locked);
  }
  for (const label of Array.from(document.querySelectorAll<HTMLElement>('.pro-label[data-feature]'))) renderProLabel(label, label.dataset.feature as ProFeature);
  const labels = describeExportOptions(options());
  els.optionsText.textContent = plan.has('export-options') ? (labels.length ? labels.join(' · ') : 'Export options: defaults') : 'Export options (Pro)';
  els.planNote.textContent = plan.plan === 'pro' ? 'Pro' : plan.earlyAccess ? 'Pro free during early access' : 'Free plan';
}

async function readConversation(): Promise<Conversation | null> {
  const response = await ask<ReadResponse>({ type: 'chat-exporter/read' });
  if (!response) {
    setStatus('The page stopped responding. Reload it and try again.', 'error');
    return null;
  }
  if (!response.ok) {
    showError(response.message);
    return null;
  }
  return response.conversation;
}

async function onCopy(): Promise<void> {
  const conversation = await readConversation();
  if (!conversation) return;
  const copied = await copyText(toMarkdownDocument(conversation, new Date()));
  if (copied) setStatus('Copied as Markdown.');
  else setStatus("Couldn't copy to the clipboard. Download the Markdown file instead.", 'error');
}

async function onHandoff(): Promise<void> {
  const conversation = await readConversation();
  if (!conversation) return;
  const handoff = buildHandoff(conversation);
  if (await copyText(handoff.text)) setStatus(`Hand-off prompt copied: ${describeSize(handoff)}. Paste it into a new chat in any AI.`);
  else setStatus("Couldn't copy to the clipboard. Please try again.", 'error');
}

async function onFormat(format: string): Promise<void> {
  const feature = featureFor(format as ExportAction);
  if (feature && !plan.has(feature)) {
    setStatus(proMessage(feature), 'muted', { label: 'About Pro', run: () => openOptionsPage('pro') });
    return;
  }
  const conversation = await readConversation();
  if (!conversation) return;
  const now = new Date();
  if (isExportFormat(format)) {
    const file = buildExportFile(format, conversation, now, options());
    downloadText(file.filename, file.content, file.mime);
    setStatus(`Downloaded ${file.filename}`);
    return;
  }
  setStatus('Opening the print view…', 'muted');
  try {
    const request: PrintRequest = { type: 'chat-exporter/print', conversation, title: pdfTitle(conversation, now, options()) };
    const response = (await chrome.runtime.sendMessage(request)) as PrintResponse | undefined;
    if (response?.ok) setStatus('Print view opened. Choose “Save as PDF” as the destination.');
    else setStatus(response?.message ?? "Couldn't open the print view.", 'error');
  } catch {
    setStatus("Couldn't open the print view. Please try again.", 'error');
  }
}

async function init(): Promise<void> {
  els.emptyIcon.append(icon(ICONS.chatSquareText));
  els.errorIcon.append(icon(ICONS.exclamationTriangleFill));
  els.copyIcon.append(icon(ICONS.clipboard));
  for (const slot of Array.from(document.querySelectorAll<HTMLElement>('[data-icon]'))) {
    const name = slot.dataset.icon as keyof typeof ICONS;
    if (ICONS[name]) slot.replaceWith(icon(ICONS[name]));
  }

  els.copy.addEventListener('click', () => void run(onCopy));
  els.handoff.addEventListener('click', () => void run(onHandoff));
  for (const button of Array.from(document.querySelectorAll<HTMLButtonElement>('[data-format]'))) {
    button.addEventListener('click', () => void run(() => onFormat(button.dataset.format ?? '')));
  }
  els.editOptions.addEventListener('click', () => openOptionsPage('options'));
  els.openOptions.addEventListener('click', () => openOptionsPage('options'));
  els.openHistory.addEventListener('click', () => openOptionsPage('import'));
  els.emptyHistory.addEventListener('click', () => openOptionsPage('import'));
  els.aboutPro.addEventListener('click', () => openOptionsPage('pro'));
  els.showButton.addEventListener('change', () => {
    saveSettings({ showButton: els.showButton.checked }).catch(() => {
      els.showButton.checked = !els.showButton.checked;
      setStatus("Couldn't save this setting.", 'error');
    });
  });

  try {
    settings = await loadSettings();
  } catch {
    settings = DEFAULT_SETTINGS;
  }
  plan = await loadPlan();
  els.showButton.checked = settings.showButton;
  renderPlan();
  tabId = await activeTabId();
  await describe();
}

let running = false;
async function run(task: () => Promise<void>): Promise<void> {
  if (running) return;
  running = true;
  const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('#conversation button'));
  for (const button of buttons) button.disabled = true;
  try {
    await task();
  } finally {
    for (const button of buttons) button.disabled = false;
    running = false;
  }
}

init().catch((error: unknown) => showError(`Something went wrong: ${error instanceof Error ? error.message : String(error)}`));
