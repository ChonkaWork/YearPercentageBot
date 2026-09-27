import { SITE_NAMES, type Conversation } from '../core/types';
import { exportFilename, FORMAT_INFO, formatConversation, isExportFormat, toMarkdownDocument } from '../export/formats';
import type { DescribeResponse, PrintRequest, PrintResponse, ReadResponse } from '../platform/messages';
import { loadSettings, saveSettings } from '../storage/settings';
import { copyText } from '../ui/clipboard';
import { byId } from '../ui/dom';
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
  status: byId<HTMLParagraphElement>('status'),
  showButton: byId<HTMLInputElement>('show-button'),
};

type View = 'loading' | 'empty' | 'error' | 'conversation';

let tabId: number | null = null;

function show(view: View): void {
  els.loading.hidden = view !== 'loading';
  els.empty.hidden = view !== 'empty';
  els.error.hidden = view !== 'error';
  els.conversation.hidden = view !== 'conversation';
}

function setStatus(text: string, tone: 'success' | 'error' | 'muted' = 'success'): void {
  els.status.textContent = text;
  els.status.className = `status-line small mt-2 mb-0 ${tone === 'error' ? 'text-danger' : tone === 'success' ? 'text-success-emphasis' : 'text-body-secondary'}`;
}

function showError(message: string): void {
  els.errorText.textContent = message;
  show('error');
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
  els.count.textContent = `${response.messageCount} ${response.messageCount === 1 ? 'message' : 'messages'}`;
  els.streaming.hidden = !response.streaming;
  show('conversation');
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

async function onFormat(format: string): Promise<void> {
  const conversation = await readConversation();
  if (!conversation) return;
  const now = new Date();
  if (isExportFormat(format)) {
    const info = FORMAT_INFO[format];
    const filename = exportFilename(conversation.title, now, info.extension);
    downloadText(filename, formatConversation(format, conversation, now), info.mime);
    setStatus(`Downloaded ${filename}`);
    return;
  }
  setStatus('Opening the print view…', 'muted');
  try {
    const response = (await chrome.runtime.sendMessage({ type: 'chat-exporter/print', conversation } satisfies PrintRequest)) as PrintResponse | undefined;
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
  for (const button of Array.from(document.querySelectorAll<HTMLButtonElement>('[data-format]'))) {
    button.addEventListener('click', () => void run(() => onFormat(button.dataset.format ?? '')));
  }
  els.showButton.addEventListener('change', () => {
    saveSettings({ showButton: els.showButton.checked }).catch(() => {
      els.showButton.checked = !els.showButton.checked;
      setStatus("Couldn't save this setting.", 'error');
    });
  });

  try {
    els.showButton.checked = (await loadSettings()).showButton;
  } catch {
    els.showButton.checked = true;
  }
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
