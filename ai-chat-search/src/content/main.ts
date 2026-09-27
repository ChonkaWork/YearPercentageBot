import { readConversation, ReadError, READ_ERROR_MESSAGES } from '../core/read';
import {
  isContentRequest,
  type ContentRequest,
  type DescribeResponse,
  type PageStateMessage,
  type ReadResponse,
  type SaveRequest,
  type SaveResponse,
} from '../platform/messages';
import { adapterFor } from '../sites';
import type { SiteAdapter } from '../sites/types';
import { signatureOf } from '../storage/record';
import { loadSettings, onSettingsChanged } from '../storage/settings';
import { watchPage } from './watch';

/**
 * Content script on ChatGPT and Claude. No UI on the page. When a conversation is open and the
 * page has settled (no DOM changes for a moment, no reply being written), it reads the
 * conversation and sends it to the service worker to be saved, if auto-save is on and this isn't
 * a private window. It also answers the toolbar popup.
 */

/** Quiet time before a conversation is read. */
const SETTLE_MS = __E2E__ ? 500 : 1500;
/** While a reply is being written, check again this often. */
const STREAMING_POLL_MS = __E2E__ ? 500 : 2000;
/** A conversation page may take this long to render its messages before we call it unreadable. */
const LOAD_GRACE_MS = __E2E__ ? 1500 : 10_000;

function start(adapter: SiteAdapter): void {
  let autoSave = true;
  let navigatedAt = Date.now();
  let timer: number | undefined;
  let problem: string | null = null;
  const savedSignatures = new Map<string, string>();

  const stopWatching = watchPage(({ navigated }) => {
    if (!alive()) {
      stopWatching();
      window.clearTimeout(timer);
      return;
    }
    if (navigated) {
      navigatedAt = Date.now();
      report(null);
    }
    schedule(SETTLE_MS);
  });

  function alive(): boolean {
    try {
      return Boolean(chrome.runtime?.id);
    } catch {
      return false;
    }
  }

  function schedule(delay: number): void {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => void capture(), delay);
  }

  /** Tells the service worker whether there's a problem on this page (toolbar badge). */
  function report(message: string | null): void {
    if (message === problem) return;
    problem = message;
    const state: PageStateMessage = message ? { type: 'ai-chat-search/page-state', state: 'problem', message } : { type: 'ai-chat-search/page-state', state: 'ok' };
    chrome.runtime.sendMessage(state).catch(() => undefined);
  }

  async function capture(): Promise<void> {
    if (!alive()) return;
    const url = new URL(location.href);
    if (adapter.getConversationId(url) === null) return;
    if (adapter.isStreaming(document)) {
      // Saved once the reply is complete.
      schedule(STREAMING_POLL_MS);
      return;
    }
    let conversation;
    try {
      conversation = readConversation(adapter, document, location.href);
    } catch (error) {
      const wait = navigatedAt + LOAD_GRACE_MS - Date.now();
      if (wait > 0) {
        // Probably still loading: look again when the grace period is over.
        schedule(wait);
        return;
      }
      report(error instanceof ReadError ? error.message : `${READ_ERROR_MESSAGES.SITE_CHANGED} (${String(error)})`);
      return;
    }
    report(null);
    if (conversation.streaming || !autoSave || chrome.extension.inIncognitoContext) return;

    const signature = `${conversation.title}\u0000${signatureOf(conversation.title, conversation.messages)}`;
    if (savedSignatures.get(conversation.url) === signature) return;
    let response: SaveResponse | undefined;
    try {
      response = (await chrome.runtime.sendMessage({ type: 'ai-chat-search/save', conversation, trigger: 'auto' } satisfies SaveRequest)) as SaveResponse | undefined;
    } catch {
      return; // Extension reloaded: this copy of the script is orphaned.
    }
    if (response?.ok) savedSignatures.set(conversation.url, signature);
    else if (response && response.code === 'STORAGE') report(response.message);
  }

  chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    if (!isContentRequest(message)) return false;
    sendResponse(answer(message));
    return false;
  });

  function answer(request: ContentRequest): DescribeResponse | ReadResponse {
    try {
      const conversation = readConversation(adapter, document, location.href);
      if (request.type === 'ai-chat-search/read') return { ok: true, conversation };
      return {
        ok: true,
        site: adapter.id,
        conversationId: conversation.conversationId,
        title: conversation.title,
        messageCount: conversation.messages.length,
        streaming: conversation.streaming,
      };
    } catch (error) {
      const code = error instanceof ReadError ? error.code : 'INTERNAL';
      const message = error instanceof ReadError ? error.message : `Couldn't read this conversation: ${String(error)}`;
      return { ok: false, code, message, site: adapter.id };
    }
  }

  onSettingsChanged((settings) => {
    autoSave = settings.autoSave;
    if (autoSave) schedule(0);
  });
  loadSettings()
    .then((settings) => {
      autoSave = settings.autoSave;
    })
    .catch(() => undefined) // Storage unavailable: keep the default.
    .finally(() => schedule(SETTLE_MS));
}

const adapter = adapterFor(new URL(location.href));
if (adapter) start(adapter);
