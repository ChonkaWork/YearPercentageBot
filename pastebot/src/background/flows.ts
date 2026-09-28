import { MAX_INPUT_CHARS } from '../core/limits';
import { sanitizePageContext } from '../core/pageContext';
import { hasFeature } from '../core/plan';
import type { DirectAction, PageContext } from '../core/types';
import { actionLabel } from '../templates';
import type { Choice, OverlayMessage, PanelMessage, TemplateRef } from '../platform/messages';
import { captureSelection } from '../platform/selection';
import { loadLastInstruction, loadPlanState, loadSettings, loadTemplates, setPendingSelection } from '../storage/store';
import { makePrompt } from './makePrompt';

/** Where the request came from: a context-menu click (frame + Chrome's own selection text) or the shortcut. */
export interface SelectionSource {
  frameId: number;
  selectionText?: string;
  pageUrl?: string;
}

interface Captured {
  text: string;
  totalLength: number;
  page: PageContext | null;
  anchor: PanelMessage['anchor'];
}

async function capture(tab: chrome.tabs.Tab & { id: number }, source: SelectionSource): Promise<Captured> {
  const fromPage = await captureSelection(tab.id, source.frameId);
  // Selection.toString() keeps line breaks (important for code); Chrome's selectionText
  // collapses them, so it is only the fallback for pages we can't script.
  const text = fromPage?.text.trim() ? fromPage.text : (source.selectionText ?? '');
  return {
    text,
    totalLength: fromPage?.text.trim() ? fromPage.totalLength : text.length,
    page: sanitizePageContext({
      title: tab.title || fromPage?.title,
      url: source.pageUrl || tab.url || fromPage?.url,
    }),
    // Coordinates from a child frame don't map to the top frame the panel lives in.
    anchor: source.frameId === 0 ? (fromPage?.anchor ?? null) : null,
  };
}

/** "Make Prompt…" and the keyboard shortcut: show the in-page panel. */
export async function openPanel(tab: chrome.tabs.Tab & { id: number }, source: SelectionSource): Promise<void> {
  const selection = await capture(tab, source);
  if (!selection.text.trim()) {
    const shown = await showOverlay(tab.id, {
      type: 'pastebot/overlay',
      view: 'toast',
      tone: 'error',
      message: 'Select some text on the page first.',
    });
    if (!shown) await handOffToPopup(tab.id, { text: '', page: selection.page });
    return;
  }

  const shown = await showOverlay(tab.id, await panelMessage(selection));
  if (!shown) await handOffToPopup(tab.id, { text: selection.text, page: selection.page });
}

/** Context-menu actions and templates: generate and copy immediately, then confirm with a toast. */
export async function runDirectAction(
  tab: chrome.tabs.Tab & { id: number },
  source: SelectionSource,
  choice: Choice,
): Promise<void> {
  const selection = await capture(tab, source);
  const handOff = 'action' in choice ? { action: choice.action } : { templateId: choice.template.id };

  if (selection.totalLength > MAX_INPUT_CHARS) {
    // Let the user decide how to shorten it in the panel.
    const shown = await showOverlay(tab.id, { ...(await panelMessage(selection)), preset: choice });
    if (!shown) await handOffToPopup(tab.id, { text: selection.text, page: selection.page, ...handOff });
    return;
  }

  const settings = await loadSettings();
  const response = await makePrompt({
    ...('action' in choice ? { action: choice.action } : { action: 'custom', templateId: choice.template.id }),
    text: selection.text,
    includePageContext: settings.includePageContext,
    page: selection.page,
    copy: true,
  });

  if (!response.ok) {
    const shown = await showOverlay(tab.id, {
      type: 'pastebot/overlay',
      view: 'toast',
      tone: 'error',
      message: response.message,
    });
    if (!shown) await handOffToPopup(tab.id, { text: selection.text, page: selection.page, ...handOff, message: response.message });
    return;
  }

  if (!response.copied) {
    const shown = await showOverlay(tab.id, { type: 'pastebot/overlay', view: 'manual-copy', prompt: response.prompt });
    if (!shown) {
      await handOffToPopup(tab.id, {
        text: selection.text,
        page: selection.page,
        ...handOff,
        message: "Couldn't copy automatically. Press Make Prompt, then Copy.",
      });
    }
    return;
  }

  const note = response.historySaved ? '' : ' (not saved to history)';
  const shown = await showOverlay(tab.id, {
    type: 'pastebot/overlay',
    view: 'toast',
    tone: 'success',
    message: `${'action' in choice ? actionLabel(choice.action) : `“${choice.template.name}”`} prompt copied${note}. Paste it into your AI tool.`,
  });
  if (!shown) await flashBadge(tab.id, '✓', '#16a34a');
}

async function panelMessage(selection: Captured): Promise<PanelMessage> {
  const [settings, lastInstruction, templates] = await Promise.all([loadSettings(), loadLastInstruction(), availableTemplates()]);
  return {
    type: 'pastebot/overlay',
    view: 'panel',
    text: selection.text,
    totalLength: selection.totalLength,
    page: selection.page,
    anchor: selection.anchor,
    includePageContext: settings.includePageContext,
    defaultAction: settings.defaultAction,
    lastInstruction,
    templates,
  };
}

/** Templates to offer in menus and the panel: none when the plan doesn't include them. */
export async function availableTemplates(): Promise<TemplateRef[]> {
  const { plan, earlyAccess } = await loadPlanState();
  if (!hasFeature(plan, 'templates', earlyAccess)) return [];
  return (await loadTemplates()).map(({ id, name }) => ({ id, name }));
}

/** Injects the overlay into the top frame and hands it a message. False if the page can't be scripted. */
async function showOverlay(tabId: number, message: OverlayMessage): Promise<boolean> {
  try {
    await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ['overlay.js'] });
    await chrome.tabs.sendMessage(tabId, message, { frameId: 0 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Pages Pastebot can't script (chrome://, Web Store, PDF viewer): continue in the popup.
 * chrome.action.openPopup() needs Chrome 127+; older versions get a badge instead.
 */
async function handOffToPopup(
  tabId: number,
  pending: { text: string; page: PageContext | null; action?: DirectAction; templateId?: string; message?: string },
): Promise<void> {
  try {
    await setPendingSelection(pending);
  } catch {
    // Session storage unavailable: the popup still opens, just empty.
  }
  try {
    await chrome.action.openPopup();
  } catch {
    await chrome.action.setBadgeBackgroundColor({ tabId, color: '#4f46e5' });
    await chrome.action.setBadgeText({ tabId, text: '1' });
  }
}

async function flashBadge(tabId: number, text: string, color: string): Promise<void> {
  try {
    await chrome.action.setBadgeBackgroundColor({ tabId, color });
    await chrome.action.setBadgeText({ tabId, text });
    setTimeout(() => {
      chrome.action.setBadgeText({ tabId, text: '' }).catch(() => undefined);
    }, 2500);
  } catch {
    // Tab closed.
  }
}
