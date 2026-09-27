/**
 * Service worker. Its only job: add the starter snippets on first install. Expansion itself
 * happens in the content script and never needs the background.
 */

import { seedStarterSnippets } from '../storage/store';

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason !== 'install') return;
  seedStarterSnippets().catch((error: unknown) => {
    // Nothing is visible yet at install time; the manager shows an empty list with a "Create" button.
    console.error('Snippets: could not add the starter snippets', error);
  });
});
