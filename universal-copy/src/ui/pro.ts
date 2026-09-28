import { h } from './dom';

/** The small PRO tag next to Pro features (docs/MONETIZATION.md: a badge, no nagging). */
export function proBadge(): HTMLSpanElement {
  return h('span', { class: 'pro-badge', text: 'PRO', attrs: { title: 'Universal Copy Pro feature' } });
}

/** Opens the options page at the "About Pro" card. */
export function openAboutPro(): void {
  void chrome.tabs.create({ url: chrome.runtime.getURL('options.html#pro') });
}
