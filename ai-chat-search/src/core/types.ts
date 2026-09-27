export const SITE_IDS = ['chatgpt', 'claude'] as const;
export type SiteId = (typeof SITE_IDS)[number];

export const SITE_NAMES: Readonly<Record<SiteId, string>> = { chatgpt: 'ChatGPT', claude: 'Claude' };

export function isSiteId(value: unknown): value is SiteId {
  return typeof value === 'string' && (SITE_IDS as readonly string[]).includes(value);
}

export type Role = 'user' | 'assistant';

export interface Message {
  role: Role;
  /** Markdown converted from the rendered message. */
  markdown: string;
  /** Plain-text rendition of the same message. */
  text: string;
  /** Set on a reply that was still being generated when the page was read. */
  incomplete?: true;
}

export interface Conversation {
  site: SiteId;
  /** From the URL; null on pages that don't have one yet (e.g. a brand-new chat). */
  conversationId: string | null;
  title: string;
  /** Page URL without query string or fragment. */
  url: string;
  messages: Message[];
  /** A reply was still being generated when the page was read. */
  streaming: boolean;
}
