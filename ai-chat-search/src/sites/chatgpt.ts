import { outermost, titleFromDocument } from './shared';
import type { ButtonTarget, RawMessage, SiteAdapter } from './types';

/**
 * ChatGPT (chatgpt.com, formerly chat.openai.com).
 *
 * UNVERIFIED: every selector below comes from knowledge of ChatGPT's DOM as of 2025. None of
 * them could be checked against the live site while building this extension (it isn't
 * reachable from the build environment and needs a login). The e2e fixtures in
 * e2e/fixtures/chatgpt*.html replicate these assumptions. If exporting breaks, compare the
 * live DOM with this list first.
 */
export const CHATGPT_SELECTORS = {
  /** A message; the attribute value is "user", "assistant", "tool" or "system". Well known, unverified. */
  message: '[data-message-author-role]',
  /** Rendered Markdown of an assistant message. Unverified guess. */
  assistantBody: '.markdown',
  /** Streaming markers: the class on a message being written, and the composer's stop button. Unverified guesses. */
  streamingMessage: '.result-streaming',
  stopButton: '[data-testid="stop-button"]',
  /** Header container with the Share button, and the Share button itself. Unverified guesses. */
  headerActions: '#conversation-header-actions',
  shareButton: '[data-testid="share-chat-button"]',
  /** Sidebar link of the open conversation (title fallback). Unverified guess. */
  sidebarLink: (id: string) => `nav a[href$="/c/${cssEscape(id)}"]`,
  /** UI inside message bodies (copy/edit rows, hidden labels). Unverified guesses, on top of generic chrome. */
  chrome: '[data-testid$="turn-action-button"], [data-testid="copy-turn-action-button"], .sr-only',
} as const;

const HOSTS = ['chatgpt.com', 'chat.openai.com'];
const GENERIC_TITLES = new Set(['chatgpt', 'new chat', 'openai']);

export const chatgpt: SiteAdapter = {
  id: 'chatgpt',
  name: 'ChatGPT',
  chromeSelector: CHATGPT_SELECTORS.chrome,

  detect(url) {
    return HOSTS.includes(url.hostname);
  },

  getConversationId(url) {
    // /c/<id>, also inside GPTs and projects: /g/<gizmo>/c/<id>. Shared links: /share/<id>.
    const chat = /\/c\/([A-Za-z0-9-]{8,})/.exec(url.pathname);
    if (chat?.[1]) return chat[1];
    const shared = /\/share\/([A-Za-z0-9-]{8,})/.exec(url.pathname);
    return shared?.[1] ? `share-${shared[1]}` : null;
  },

  getConversationTitle(doc, url) {
    const title = titleFromDocument(doc, [' - ChatGPT', ' | ChatGPT'], GENERIC_TITLES);
    if (title) return title;
    const id = this.getConversationId(url);
    const link = id ? doc.querySelector(CHATGPT_SELECTORS.sidebarLink(id)) : null;
    return link?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  },

  getMessages(doc) {
    const messages: RawMessage[] = [];
    for (const element of outermost(doc.querySelectorAll(CHATGPT_SELECTORS.message))) {
      const role = element.getAttribute('data-message-author-role');
      // "tool" and "system" messages are internal steps the site doesn't show as chat turns.
      if (role !== 'user' && role !== 'assistant') continue;
      let parts: Element[] = [element];
      if (role === 'assistant') {
        const bodies = outermost(element.querySelectorAll(CHATGPT_SELECTORS.assistantBody));
        if (bodies.length > 0) parts = bodies;
      }
      const streaming =
        element.matches(CHATGPT_SELECTORS.streamingMessage) || element.querySelector(CHATGPT_SELECTORS.streamingMessage) !== null;
      messages.push({ role, parts, streaming });
    }
    return messages;
  },

  isStreaming(doc) {
    return doc.querySelector(`${CHATGPT_SELECTORS.stopButton}, ${CHATGPT_SELECTORS.streamingMessage}`) !== null;
  },

  injectButtonTarget(doc): ButtonTarget | null {
    const actions = doc.querySelector(CHATGPT_SELECTORS.headerActions);
    if (actions) return { element: actions, position: 'prepend' };
    const share = doc.querySelector(CHATGPT_SELECTORS.shareButton);
    if (share) return { element: share, position: 'before' };
    return null;
  },
};

function cssEscape(value: string): string {
  return value.replace(/[^\w-]/g, (char) => `\\${char}`);
}
