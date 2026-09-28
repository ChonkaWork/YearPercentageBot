/**
 * "Copy & open" (Free): after the prompt is copied, open an AI chat in a new tab. ChatGPT and
 * Perplexity accept the prompt in the address (`?q=`), so it arrives filled in when it's short
 * enough for a URL; Claude and Gemini open empty and the user pastes. Pure: the caller opens
 * the tab (chrome.tabs.create needs no permission).
 *
 * The prefill behaviour of those sites is theirs and can change; see the README (unverified).
 */

export const DESTINATIONS = ['chatgpt', 'perplexity', 'claude', 'gemini'] as const;
export type Destination = (typeof DESTINATIONS)[number];

export interface DestinationInfo {
  label: string;
  /** Opened when the prompt can't (or needn't) go in the address. */
  home: string;
  /** Address prefix that takes the prompt as a URL-encoded query. */
  prefill?: string;
}

export const DESTINATION_INFO: Readonly<Record<Destination, DestinationInfo>> = {
  chatgpt: { label: 'ChatGPT', home: 'https://chatgpt.com/', prefill: 'https://chatgpt.com/?q=' },
  perplexity: { label: 'Perplexity', home: 'https://www.perplexity.ai/', prefill: 'https://www.perplexity.ai/search?q=' },
  claude: { label: 'Claude', home: 'https://claude.ai/new' },
  gemini: { label: 'Gemini', home: 'https://gemini.google.com/app' },
};

/** Longer prompts are pasted instead: long addresses get cut or refused by servers. */
export const MAX_PREFILL_CHARS = 6_000;
/** Non-Latin text triples in length when URL-encoded; the address itself is capped too. */
export const MAX_PREFILL_URL_CHARS = 16_000;

export const DEFAULT_DESTINATION: Destination = 'chatgpt';

export function isDestination(value: unknown): value is Destination {
  return typeof value === 'string' && (DESTINATIONS as readonly string[]).includes(value);
}

export interface OpenTarget {
  url: string;
  /** True when the prompt is in the address; otherwise the user pastes it. */
  prefilled: boolean;
}

export function openTarget(destination: Destination, prompt: string): OpenTarget {
  const info = DESTINATION_INFO[destination];
  if (info.prefill && prompt.length <= MAX_PREFILL_CHARS) {
    const url = `${info.prefill}${encodeURIComponent(prompt)}`;
    if (url.length <= MAX_PREFILL_URL_CHARS) return { url, prefilled: true };
  }
  return { url: info.home, prefilled: false };
}

/** One line under the button, so the user knows what happens before the tab takes focus. */
export function openHint(destination: Destination, prompt: string, pasteKey = 'Ctrl+V'): string {
  const { label, prefill } = DESTINATION_INFO[destination];
  if (openTarget(destination, prompt).prefilled) return `${label} opens with the prompt filled in.`;
  if (prefill) return `Too long to fill in: ${label} opens, press ${pasteKey} to paste.`;
  return `${label} opens in a new tab. Press ${pasteKey} to paste.`;
}
