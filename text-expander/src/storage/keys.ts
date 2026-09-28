/** chrome.storage.local keys. Kept apart so the content script doesn't bundle the store. */
export const SNIPPETS_KEY = 'snippets';
export const SETTINGS_KEY = 'settings';
/** 'free' | 'pro', written only by a future payments adapter. */
export const PLAN_KEY = 'plan';
/** Test build only: `false` switches early access off so the free plan can be tested. */
export const E2E_EARLY_ACCESS_KEY = 'e2eEarlyAccess';
