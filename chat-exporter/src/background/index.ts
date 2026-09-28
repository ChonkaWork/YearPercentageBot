import { proMessage } from '../core/plan';
import { isOpenOptionsRequest, isPrintRequest, PRINT_KEY_PREFIX, type PrintPayload, type PrintResponse } from '../platform/messages';
import { loadPlan } from '../storage/plan';

/**
 * Service worker. Hands a conversation to the print view (the conversation goes into
 * chrome.storage.session, memory only, cleared when the browser closes, and the print view opens
 * in a new tab next to the chat), and opens the options page for the in-page menu.
 */

const KEEP_PRINT_PAYLOADS = 5;

async function openPrintView(payload: PrintPayload, tab: chrome.tabs.Tab | undefined): Promise<PrintResponse> {
  if (!(await loadPlan()).has('pdf')) return { ok: false, message: proMessage('pdf') };
  const id = crypto.randomUUID();
  try {
    await chrome.storage.session.set({ [`${PRINT_KEY_PREFIX}${id}`]: payload });
  } catch (error) {
    const quota = error instanceof Error && /quota/i.test(error.message);
    return { ok: false, message: quota ? 'This conversation is too large for the print view. Export it as Markdown instead.' : "Couldn't prepare the print view." };
  }
  await prunePayloads();
  const url = chrome.runtime.getURL(`print.html#${id}`);
  await chrome.tabs.create(nextTo(url, tab));
  return { ok: true };
}

function nextTo(url: string, tab: chrome.tabs.Tab | undefined): chrome.tabs.CreateProperties {
  return tab?.index !== undefined && tab.windowId !== undefined ? { url, index: tab.index + 1, windowId: tab.windowId } : { url };
}

/** Keeps only the most recent payloads (a print view can be reloaded while it's still around). */
async function prunePayloads(): Promise<void> {
  const all = await chrome.storage.session.get(null);
  const keys = Object.entries(all)
    .filter(([key]) => key.startsWith(PRINT_KEY_PREFIX))
    .sort(([, a], [, b]) => ((b as PrintPayload).exportedAt ?? 0) - ((a as PrintPayload).exportedAt ?? 0))
    .slice(KEEP_PRINT_PAYLOADS)
    .map(([key]) => key);
  if (keys.length) await chrome.storage.session.remove(keys);
}

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  // Only our own content scripts and pages; no externally_connectable is declared.
  if (sender.id !== chrome.runtime.id) return false;
  if (isOpenOptionsRequest(message)) {
    chrome.tabs
      .create(nextTo(chrome.runtime.getURL(`options.html#${message.section ?? 'pro'}`), sender.tab))
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (!isPrintRequest(message)) return false;
  const payload: PrintPayload = { conversation: message.conversation, exportedAt: Date.now(), ...(message.title ? { title: message.title } : {}) };
  openPrintView(payload, sender.tab)
    .then(sendResponse)
    .catch((error: unknown) => {
      console.error('Chat Exporter: print view failed', error);
      sendResponse({ ok: false, message: "Couldn't open the print view. Please try again." } satisfies PrintResponse);
    });
  return true;
});
