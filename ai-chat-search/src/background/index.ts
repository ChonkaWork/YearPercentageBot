import type { Conversation } from '../core/types';
import { isPageStateMessage, isSaveRequest, type PageStateMessage, type SaveRequest, type SaveResponse } from '../platform/messages';
import { clearConversations, getAllConversations, getConversation, notifyIndexChanged, putConversation, upsertConversation } from '../storage/db';
import { loadPlan } from '../storage/plan';
import { buildRecord, conversationKey, withMeta, type UserMeta } from '../storage/record';
import { loadSettings } from '../storage/settings';
import { autoSaveRefusal, limitRefusal } from './policy';

/**
 * Service worker: the only writer of saved conversations coming from chat pages. Content scripts
 * send conversations here because IndexedDB must live in the extension's origin, not the site's.
 * Also shows a warning badge on the toolbar icon when a chat page can't be read.
 */

const BADGE_COLOR = '#e67700';

/** e2e build only: the last save the service worker refused (compiled out of dist/). */
let e2eLastRefusal: { key: string; code: string; message: string } | null = null;

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
    const { limits } = await loadPlan();
    const now = Date.now();
    const response = await upsertConversation<SaveResponse>(conversationKey(conversation.site, conversation.conversationId), (previous, count) => {
      const refusal = limitRefusal(previous === undefined, count, limits);
      if (refusal) return { record: null, result: refusal };
      const { record, status } = buildRecord(conversation, previous, now);
      return { record, result: { ok: true, status, key: record.key, savedAt: record.savedAt } };
    });
    if (__E2E__ && !response.ok) e2eLastRefusal = { key: conversationKey(conversation.site, conversation.conversationId), code: response.code, message: response.message };
    if (response.ok && response.status !== 'unchanged') notifyIndexChanged();
    if (sender.tab?.id !== undefined) await setProblem(sender.tab.id, null);
    return response;
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
      async seed(items: ({ conversation: Conversation; at: number } & Partial<UserMeta>)[]) {
        for (const { conversation, at, ...meta } of items) {
          const previous = conversation.conversationId ? await getConversation(conversationKey(conversation.site, conversation.conversationId)) : undefined;
          await putConversation(withMeta(buildRecord(conversation, previous, at).record, meta));
        }
        notifyIndexChanged();
      },
      async all() {
        return (await getAllConversations()).records;
      },
      /** Many small conversations at once (limit tests). */
      async seedMany(count: number, at: number) {
        for (let i = 0; i < count; i++) {
          const id = `bulk-${String(i).padStart(4, '0')}`;
          const conversation: Conversation = {
            site: 'chatgpt',
            conversationId: id,
            title: `Bulk conversation ${i}`,
            url: `https://chatgpt.com/c/${id}`,
            streaming: false,
            messages: [
              { role: 'user', markdown: `Question ${i}`, text: `Question ${i}` },
              { role: 'assistant', markdown: `Answer ${i}`, text: `Answer ${i}` },
            ],
          };
          await putConversation(buildRecord(conversation, undefined, at - i * 60_000).record);
        }
        notifyIndexChanged();
      },
      lastRefusal() {
        return e2eLastRefusal;
      },
      async clear() {
        e2eLastRefusal = null;
        await clearConversations();
        notifyIndexChanged();
      },
    },
  });
}
