/**
 * Service worker. It adds the starter snippets on first install and keeps the usage stats
 * (the single writer, so counts from several tabs never overwrite each other). Expansion
 * itself happens in the content script and never waits for the background.
 */

import { seedStarterSnippets } from '../storage/store';
import { isUsageMessage, recordUsage } from '../storage/usage';

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason !== 'install') return;
  seedStarterSnippets().catch((error: unknown) => {
    // Nothing is visible yet at install time; the manager shows an empty list with a "Create" button.
    console.error('Snippets: could not add the starter snippets', error);
  });
});

chrome.runtime.onMessage.addListener((message: unknown, sender) => {
  // Only this extension's own pages and content scripts can reach onMessage.
  if (sender.id !== chrome.runtime.id || !isUsageMessage(message)) return;
  recordUsage(message.id).catch((error: unknown) => console.warn('Snippets: could not update usage stats', error));
});
