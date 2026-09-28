import { cleanCopy, describeClean } from '../core/cleaner';
import { prepareLastCopy } from '../core/lastCopy';
import { hasFeature } from '../core/plan';
import type { ToastMessage } from '../page/toast';
import type { ClipboardOutcome } from '../platform/messages';
import { loadState, saveLastCopy, takePendingClipboardClean } from '../storage/store';
import { copyToClipboard, readClipboard } from './clipboard';

/**
 * "Clean clipboard" (free): reads the text already on the clipboard, cleans it with the
 * user's options and rules, and writes it back. Reading needs the optional clipboardRead
 * permission, asked for from the popup the first time (with an explanation). The original
 * text and HTML are kept for Undo like any other clean copy.
 */

export const CLIPBOARD_PERMISSION: chrome.permissions.Permissions = { permissions: ['clipboardRead'] };

export async function hasClipboardAccess(): Promise<boolean> {
  try {
    return await chrome.permissions.contains(CLIPBOARD_PERMISSION);
  } catch {
    return false;
  }
}

async function cleanClipboard(): Promise<ClipboardOutcome> {
  if (!(await hasClipboardAccess())) return { status: 'needs-permission' };
  const read = await readClipboard();
  if (!read) return { status: 'error', message: "Chrome didn't let Clean Copy read the clipboard." };
  if (!read.text.trim()) return { status: 'empty' };
  const state = await loadState();
  const rules = hasFeature(state.plan, 'custom-rules') ? state.rules : null;
  const result = cleanCopy({ kind: 'plain', text: read.text }, state.settings, rules, { track: true });
  if (!result.text.trim()) return { status: 'error', message: 'Nothing would be left after cleaning, so the clipboard was left as it was.' };
  if (result.text === read.text && !read.html) return { status: 'unchanged' };
  if (!(await copyToClipboard(result.text))) return { status: 'error', message: "Couldn't write to the clipboard. Please try again." };
  let summary = describeClean(result.stats, result.text.length);
  if (read.html) summary = `formatting removed · ${summary}`;
  const copy = prepareLastCopy({
    via: 'clipboard',
    original: read.html ? { text: read.text, html: read.html } : { text: read.text },
    cleaned: result.text,
    summary,
    changes: result.changes,
  });
  await saveLastCopy(copy);
  return { status: 'cleaned', id: copy.id, summary, length: result.text.length };
}

let queue: Promise<unknown> = Promise.resolve();
/** The outcome of the last run started by a permission grant (the popup may ask for it). */
let granted: { at: number; outcome: ClipboardOutcome } | null = null;

function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
}

/** From the popup button or the keyboard command. */
export function cleanClipboardNow(): Promise<ClipboardOutcome> {
  return serialized(cleanClipboard);
}

/**
 * Right after the permission prompt. The popup may have closed while the prompt was open, so
 * the background also runs this when the permission arrives; whichever comes first cleans,
 * the other gets the same outcome. Null (from the permission event) when nothing was pending.
 */
export function cleanClipboardAfterGrant(fromPopup: boolean): Promise<ClipboardOutcome | null> {
  return serialized(async () => {
    if (await takePendingClipboardClean()) {
      const outcome = await cleanClipboard();
      granted = { at: Date.now(), outcome };
      return outcome;
    }
    if (!fromPopup) return null;
    if (granted && Date.now() - granted.at < 30_000) return granted.outcome;
    return cleanClipboard();
  });
}

/** The toast (or badge) for an outcome. */
export function clipboardMessage(outcome: ClipboardOutcome): ToastMessage {
  switch (outcome.status) {
    case 'cleaned':
      return { tone: 'success', title: 'Clipboard cleaned', detail: outcome.summary, undo: outcome.id };
    case 'unchanged':
      return { tone: 'info', title: 'The clipboard is already clean', detail: 'Its text has nothing to remove.' };
    case 'empty':
      return { tone: 'info', title: 'Nothing to clean', detail: 'The clipboard has no text.' };
    case 'needs-permission':
      return {
        tone: 'info',
        title: 'Clean clipboard needs your OK once',
        detail: 'Click the Clean Copy button in the toolbar, then Clean clipboard, and allow clipboard access.',
      };
    default:
      return { tone: 'error', title: "Couldn't clean the clipboard", detail: outcome.message };
  }
}
