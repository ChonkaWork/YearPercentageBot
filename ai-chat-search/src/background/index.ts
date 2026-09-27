import type { Conversation } from '../core/types';
import { isPageStateMessage, isSaveRequest, type PageStateMessage, type SaveRequest, type SaveResponse } from '../platform/messages';
import { clearConversations, getAllConversations, getConversation, notifyIndexChanged, putConversation } from '../storage/db';
import { buildRecord, conversationKey } from '../storage/record';
import { loadSettings } from '../storage/settings';
import { autoSaveRefusal } from './policy';

/**
 * Service worker: the only writer of saved conversations coming from chat pages. Content scripts
 * send conversations here because IndexedDB must live in the extension's origin, not the site's.
 * Also shows a warning badge on the toolbar icon when a chat page can't be read.
 */

const BADGE_COLOR = '#e67700';

async function save(request: SaveRequest, sender: chrome.runtime.MessageSender): Promise<SaveResponse> {
  const { conversation, trigger } = request;
  if (trigger === 'auto') {
    // Checked in the content script too; the service worker has the final say.
    const refusal = autoSaveRefusal(trigger, (await loadSettings()).autoSave, sender.tab?.incognito === true);
    if (refusal) return refusal;
  }
  if (!conversation.conversationId) {
    return { ok: false, code: 'NO_ID', message: "This chat doesn't have an address yet. Try again after the first reply." };
  }
  try {
    const previous = await getConversation(conversationKey(conversation.site, conversation.conversationId));
    const { record, status } = buildRecord(conversation, previous, Date.now());
    await putConversation(record);
    if (status !== 'unchanged') notifyIndexChanged();
    if (sender.tab?.id !== undefined) await setProblem(sender.tab.id, null);
    return { ok: true, status, key: record.key, savedAt: record.savedAt };
  } catch (error) {
    console.error('AI Chat Search: saving failed', error);
    const quota = error instanceof DOMException && error.name === 'QuotaExceededError';
    return {
      ok: false,
      code: 'STORAGE',
      message: quota ? 'The disk is full, so the conversation was not saved.' : `Couldn't save the conversation: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** Warning badge on the toolbar icon for this tab, or none. */
async function setProblem(tabId: number, message: string | null): Promise<void> {
  await chrome.action.setBadgeText({ tabId, text: message ? '!' : '' });
  if (message) await chrome.action.setBadgeBackgroundColor({ tabId, color: BADGE_COLOR });
  await chrome.action.setTitle({ tabId, title: message ? `AI Chat Search: ${message}` : 'AI Chat Search' });
}

async function onPageState(message: PageStateMessage, sender: chrome.runtime.MessageSender): Promise<void> {
  if (sender.tab?.id === undefined) return;
  await setProblem(sender.tab.id, message.state === 'problem' ? (message.message ?? "Couldn't read this conversation, the site may have changed.") : null);
}

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  // Only our own content scripts and pages; no externally_connectable is declared.
  if (sender.id !== chrome.runtime.id) return false;
  if (isSaveRequest(message)) {
    save(message, sender).then(sendResponse, (error: unknown) => {
      sendResponse({ ok: false, code: 'STORAGE', message: `Couldn't save the conversation: ${String(error)}` } satisfies SaveResponse);
    });
    return true;
  }
  if (isPageStateMessage(message)) {
    onPageState(message, sender).catch((error: unknown) => console.error('AI Chat Search: badge update failed', error));
  }
  return false;
});

if (__E2E__) {
  // Test build only: seed and inspect the index directly.
  Object.assign(globalThis, {
    __searchTest: {
      async seed(items: { conversation: Conversation; at: number }[]) {
        for (const { conversation, at } of items) {
          const previous = conversation.conversationId ? await getConversation(conversationKey(conversation.site, conversation.conversationId)) : undefined;
          await putConversation(buildRecord(conversation, previous, at).record);
        }
        notifyIndexChanged();
      },
      async all() {
        return (await getAllConversations()).records;
      },
      async clear() {
        await clearConversations();
        notifyIndexChanged();
      },
    },
  });
}
