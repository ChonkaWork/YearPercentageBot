import { cleanCopy, type CleanSource } from '../core/cleaner';
import { hasFeature } from '../core/plan';
import { KEYS, stateFrom, type State } from '../storage/store';
import { snapshotSelection } from '../page/reader';
import { showToast } from '../page/toast';

/**
 * Auto-clean (Pro). Registered with chrome.scripting.registerContentScripts only for the
 * sites the user added and granted, never declared in the manifest. It listens to the page's
 * normal `copy` event (Ctrl+C / Cmd+C, Edit → Copy, the page's own context menu) and
 * replaces what goes on the clipboard with the clean text.
 *
 * - Copies inside text fields and rich editors are left alone unless the setting says
 *   otherwise (editors often put their own structured data on the clipboard).
 * - When the page already put its own text on the clipboard (e.g. "Read more at..."), that
 *   text is cleaned instead of the selection.
 * - Removing a site takes effect right away in open tabs too: the list is re-read from
 *   storage on every change, and the script does nothing for a host that isn't in it.
 */

const GUARD = '__cleanCopyAutoClean';
const holder = globalThis as unknown as Record<string, boolean | undefined>;

let state: State | null = null;

function extensionAlive(): boolean {
  try {
    // After the extension is updated, reloaded or removed, old content scripts lose their
    // connection: chrome.runtime.id becomes undefined. They must stop acting.
    return Boolean(chrome.runtime?.id);
  } catch {
    return false;
  }
}

async function refresh(): Promise<void> {
  try {
    state = stateFrom(await chrome.storage.local.get(Object.values(KEYS)));
  } catch {
    // Storage unavailable (extension gone): keep the last known state, extensionAlive() stops us.
  }
}

function enabledHere(current: State): boolean {
  if (!hasFeature(current.plan, 'auto-clean')) return false;
  return current.sites.includes(location.hostname.toLowerCase().replace(/\.$/, ''));
}

function editableTarget(event: Event): boolean {
  const target = event.target;
  const element = target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
  if (element instanceof HTMLElement && element.isContentEditable) return true;
  if (element?.closest('input, textarea')) return true;
  const active = document.activeElement;
  return active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || (active instanceof HTMLElement && active.isContentEditable);
}

function onCopy(event: ClipboardEvent): void {
  const current = state;
  if (!current || !event.clipboardData || !extensionAlive() || !enabledHere(current)) return;
  if (!current.settings.autoCleanEditors && editableTarget(event)) return;

  let source: CleanSource;
  let fromPage = false;
  if (event.defaultPrevented) {
    // The page wrote its own clipboard data: clean that text (it's what the user would get).
    const text = event.clipboardData.getData('text/plain');
    if (!text.trim()) return;
    source = { kind: 'plain', text };
    fromPage = true;
  } else {
    const snapshot = snapshotSelection(document);
    if (snapshot.kind === 'empty') return;
    source = snapshot.kind === 'dom' ? { kind: 'dom', nodes: snapshot.nodes, url: snapshot.url } : { kind: 'plain', text: snapshot.text };
  }

  const rules = hasFeature(current.plan, 'custom-rules') ? current.rules : null;
  let result;
  try {
    result = cleanCopy(source, current.settings, rules);
  } catch (error) {
    console.error('Clean Copy: auto-clean failed, the normal copy was kept', error);
    return;
  }
  if (!result.text.trim()) return;

  event.preventDefault();
  event.clipboardData.clearData();
  event.clipboardData.setData('text/plain', result.text);
  if (current.settings.autoCleanToast) {
    showToast({
      tone: result.stats.rulesStopped ? 'info' : 'success',
      title: result.stats.rulesStopped ? 'Copied clean, some rules skipped' : fromPage ? 'Copied clean (site text)' : 'Copied clean',
      compact: true,
    });
  }
}

if (!holder[GUARD]) {
  holder[GUARD] = true;
  void refresh();
  try {
    chrome.storage.onChanged.addListener((_changes, area) => {
      if (area === 'local') void refresh();
    });
  } catch {
    // Extension context already gone.
  }
  // Bubbling phase on window: runs after the page's own copy handlers, so their result can
  // be cleaned too.
  window.addEventListener('copy', onCopy);
  if (__E2E__) {
    // Test-only: lets the e2e test wait until the script has read (or re-read) its state.
    (globalThis as unknown as Record<string, unknown>).__cleanCopyAutoState = () => state;
  }
}
