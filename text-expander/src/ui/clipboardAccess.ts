/**
 * The optional `clipboardRead` permission behind `{clipboard}`. It's asked for only when the
 * user saves a snippet that uses `{clipboard}` (or clicks "Allow clipboard access"), and can
 * be given back from the manager at any time.
 */

import { E2E_CLIPBOARD_DENIED_KEY } from '../storage/keys';

const PERMISSION: chrome.permissions.Permissions = { permissions: ['clipboardRead'] };

async function deniedInTest(): Promise<boolean> {
  // Test build only: the permission is granted up front there (automation can't click
  // Chrome's prompt), and this flag stands in for "refused".
  if (__E2E__) {
    return (await chrome.storage.local.get(E2E_CLIPBOARD_DENIED_KEY))[E2E_CLIPBOARD_DENIED_KEY] === true;
  }
  return false;
}

export async function hasClipboardAccess(): Promise<boolean> {
  try {
    return (await chrome.permissions.contains(PERMISSION)) && !(await deniedInTest());
  } catch {
    return false;
  }
}

/**
 * Asks for clipboard access. Call it straight from a click or key handler, before any other
 * await: Chrome shows its prompt only during the user gesture. Resolves without a prompt when
 * access is already granted.
 */
export function requestClipboardAccess(): Promise<boolean> {
  let request: Promise<boolean>;
  try {
    request = chrome.permissions.request(PERMISSION).catch(() => false);
  } catch {
    request = Promise.resolve(false);
  }
  return request.then(async (granted) => granted && !(await deniedInTest()));
}

/** Gives the permission back. */
export async function removeClipboardAccess(): Promise<boolean> {
  if (__E2E__) {
    // The test build's permission is required, so it can't be removed: record the refusal instead.
    await chrome.storage.local.set({ [E2E_CLIPBOARD_DENIED_KEY]: true });
    return true;
  }
  try {
    return await chrome.permissions.remove(PERMISSION);
  } catch {
    return false;
  }
}

/** Calls back when access is granted or removed (here, in chrome://extensions or elsewhere). */
export function onClipboardAccessChange(callback: () => void): void {
  chrome.permissions.onAdded.addListener(callback);
  chrome.permissions.onRemoved.addListener(callback);
  if (__E2E__) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && E2E_CLIPBOARD_DENIED_KEY in changes) callback();
    });
  }
}

/** The clipboard text for copying a `{clipboard}` snippet from the popup; empty without access. */
export async function readClipboardForCopy(): Promise<string> {
  if (!(await hasClipboardAccess())) return '';
  try {
    return await navigator.clipboard.readText();
  } catch {
    return '';
  }
}
