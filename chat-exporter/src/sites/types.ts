import type { Role, SiteId } from '../core/types';

/** One message as found on the page, before conversion. */
export interface RawMessage {
  role: Role;
  /** Elements holding the message body, in order (usually one). */
  parts: Element[];
  /** This message is still being generated. */
  streaming: boolean;
}

export interface ButtonTarget {
  element: Element;
  /** Where the button host goes relative to `element`. */
  position: 'before' | 'prepend' | 'append';
}

/**
 * Everything that depends on a chat site's DOM. When a site changes its markup, the fix is a
 * change to one adapter file (src/sites/chatgpt.ts or src/sites/claude.ts).
 */
export interface SiteAdapter {
  readonly id: SiteId;
  /** Display name: "ChatGPT", "Claude". */
  readonly name: string;
  /** True when the adapter handles pages on this URL's host. */
  detect(url: URL): boolean;
  /** Stable id of the open conversation, from the URL. Null on pages without one. */
  getConversationId(url: URL): string | null;
  /** Title of the open conversation, or '' when the page doesn't show one. */
  getConversationTitle(doc: Document, url: URL): string;
  /** Messages in page order. An empty list means nothing recognisable was found. */
  getMessages(doc: Document): RawMessage[];
  /** A reply is being generated right now. */
  isStreaming(doc: Document): boolean;
  /** Where to put the in-page button; null means "use the floating fallback". */
  injectButtonTarget(doc: Document): ButtonTarget | null;
  /** Site UI inside message bodies that must never be exported (CSS selector). */
  readonly chromeSelector: string;
}
