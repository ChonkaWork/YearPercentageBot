import { outermost, titleFromDocument } from './shared';
import type { ButtonTarget, RawMessage, SiteAdapter } from './types';

/**
 * Claude (claude.ai).
 *
 * UNVERIFIED: every selector below comes from knowledge of claude.ai's DOM as of 2025. None of
 * them could be checked against the live site while building this extension (it isn't
 * reachable from the build environment and needs a login). The e2e fixtures in
 * e2e/fixtures/claude*.html replicate these assumptions. If exporting breaks, compare the live
 * DOM with this list first.
 */
export const CLAUDE_SELECTORS = {
  /** A user turn. Widely used by other tools, unverified. */
  userMessage: '[data-testid="user-message"]',
  /**
   * An assistant reply. `.font-claude-message` is the long-standing class; `.font-claude-response`
   * is a newer name. Both unverified guesses.
   */
  assistantMessage: '.font-claude-response, .font-claude-message',
  /** Wrapper of a reply while it's generated (`data-is-streaming="true"`). Unverified guess. */
  streaming: '[data-is-streaming="true"]',
  /** Composer's stop button while a reply is generated. Unverified guess. */
  stopButton: 'button[aria-label="Stop response"]',
  /** Title button in the conversation header (title fallback). Unverified guess. */
  titleButton: '[data-testid="chat-menu-trigger"]',
  /** Share button in the conversation header. Unverified guess. */
  shareButton: 'button[data-testid="share-button"]',
  /** UI inside message bodies. Unverified guesses, on top of generic chrome. */
  chrome: '[data-testid="action-bar-copy"], [data-testid="action-bar-retry"], .sr-only',
} as const;

const HOSTS = ['claude.ai'];
const GENERIC_TITLES = new Set(['claude', 'new chat', 'new conversation']);

export const claude: SiteAdapter = {
  id: 'claude',
  name: 'Claude',
  chromeSelector: CLAUDE_SELECTORS.chrome,

  detect(url) {
    return HOSTS.includes(url.hostname);
  },

  getConversationId(url) {
    const chat = /\/chat\/([A-Za-z0-9-]{8,})/.exec(url.pathname);
    if (chat?.[1]) return chat[1];
    const shared = /\/share\/([A-Za-z0-9-]{8,})/.exec(url.pathname);
    return shared?.[1] ? `share-${shared[1]}` : null;
  },

  getConversationTitle(doc) {
    const title = titleFromDocument(doc, [' - Claude', ' | Claude', ' – Claude'], GENERIC_TITLES);
    if (title) return title;
    const button = doc.querySelector(CLAUDE_SELECTORS.titleButton);
    const text = button?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
    return GENERIC_TITLES.has(text.toLowerCase()) ? '' : text;
  },

  getMessages(doc) {
    const selector = `${CLAUDE_SELECTORS.userMessage}, ${CLAUDE_SELECTORS.assistantMessage}`;
    const messages: RawMessage[] = [];
    for (const element of outermost(doc.querySelectorAll(selector))) {
      const role = element.matches(CLAUDE_SELECTORS.userMessage) ? 'user' : 'assistant';
      messages.push({ role, parts: [element], streaming: role === 'assistant' && element.closest(CLAUDE_SELECTORS.streaming) !== null });
    }
    return messages;
  },

  isStreaming(doc) {
    return doc.querySelector(`${CLAUDE_SELECTORS.streaming}, ${CLAUDE_SELECTORS.stopButton}`) !== null;
  },

  injectButtonTarget(doc): ButtonTarget | null {
    const share = doc.querySelector(CLAUDE_SELECTORS.shareButton);
    return share ? { element: share, position: 'before' } : null;
  },
};
