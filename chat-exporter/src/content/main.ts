import { buildHandoff, compactTokens, describeSize } from '../core/handoff';
import { proMessage } from '../core/plan';
import { readConversation, ReadError } from '../core/read';
import { SITE_NAMES, type Conversation } from '../core/types';
import { buildExportFile, featureFor, pdfTitle } from '../export/actions';
import { FORMAT_INFO, isExportFormat, toMarkdownDocument } from '../export/formats';
import { roleLabel } from '../export/labels';
import { applyExportOptions, describeExportOptions, effectiveExportOptions, type ExportOptions } from '../export/options';
import {
  isContentRequest,
  type ContentRequest,
  type DescribeResponse,
  type OpenOptionsRequest,
  type PrintRequest,
  type PrintResponse,
  type ReadResponse,
} from '../platform/messages';
import { adapterFor } from '../sites';
import type { SiteAdapter } from '../sites/types';
import { loadPlan, onPlanChanged, planState, type PlanState } from '../storage/plan';
import { DEFAULT_SETTINGS, loadSettings, onSettingsChanged, type Settings } from '../storage/settings';
import { pageIsDark } from './theme';
import { ExportUi, type MenuInfo, type SelectTarget, type Selection, type UiAction } from './ui';
import { watchPage } from './watch';

/**
 * Content script on ChatGPT and Claude. Shows the Export button on conversation pages, runs the
 * exports, and answers the toolbar popup. Reading the page is done by the site adapter.
 */

const RELOAD_MESSAGE = 'Chat Exporter was updated. Reload this page to keep exporting.';
const STREAMING_NOTE = 'The last reply was still being written, so it may be cut off.';

const EXPORT_ACTIONS = ['copy', 'handoff', 'markdown', 'text', 'html', 'obsidian', 'json', 'pdf'] as const;

function start(adapter: SiteAdapter): void {
  let settings: Settings = DEFAULT_SETTINGS;
  let plan: PlanState = planState('free');
  /** Settings and plan are loaded. */
  let ready = false;
  /** The conversation the message selection belongs to (it ends on navigation). */
  let selectionUrl = '';
  const ui = new ExportUi({ describe, run });
  const stopWatching = watchPage((change) => sync(change.attributes || change.navigated));
  // Sites that follow the OS theme through CSS alone change no attributes.
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => sync(true));

  function alive(): boolean {
    try {
      return Boolean(chrome.runtime?.id);
    } catch {
      return false;
    }
  }

  /**
   * Keeps the button where it belongs: re-inserted after the site re-renders or navigates.
   * The page theme is only re-read when it may have changed (computed styles aren't free).
   */
  function sync(themeMayHaveChanged = false): void {
    if (!alive()) {
      // The extension was reloaded or removed: this copy of the script is orphaned.
      stopWatching();
      ui.destroy();
      return;
    }
    if (!ready) return;
    if (themeMayHaveChanged) ui.setDark(pageIsDark());
    const url = new URL(location.href);
    const onConversation = adapter.getConversationId(url) !== null || adapter.getMessages(document).length > 0;
    if (settings.showButton && onConversation) ui.mount(adapter.injectButtonTarget(document));
    else ui.unmount();
    if (ui.selecting) {
      if (pageKey() !== selectionUrl) ui.stopSelection();
      else ui.refreshSelection(selectTargets());
    }
  }

  function pageKey(): string {
    return `${location.origin}${location.pathname}`;
  }

  /** The messages on the page, for the checkboxes of "Select messages". */
  function selectTargets(): SelectTarget[] {
    let replies = 0;
    let questions = 0;
    return adapter.getMessages(document).map((message) => {
      const number = message.role === 'user' ? ++questions : ++replies;
      const label = message.role === 'user' ? `your message ${number}` : `${roleLabel('assistant', adapter.id)} reply ${number}`;
      return { elements: message.parts, label };
    });
  }

  /** The export options that apply with the current plan (stored ones are kept either way). */
  function options(): ExportOptions {
    return effectiveExportOptions(settings.exportOptions, plan.has('export-options'));
  }

  /**
   * The whole conversation on the page, and what gets exported after the export options. A
   * selection is exported as picked: "your messages" and "last N" don't apply to it.
   */
  function read(selection: Selection = null): { conversation: Conversation; total: number } {
    const current = options();
    const readOptions = { omitCode: !current.includeCode };
    const full = readConversation(adapter, document, location.href, readOptions);
    if (selection) return { conversation: readConversation(adapter, document, location.href, { ...readOptions, selected: new Set(selection) }), total: full.messages.length };
    return { conversation: applyExportOptions(full, current), total: full.messages.length };
  }

  function describe(selection: Selection): MenuInfo {
    const title = adapter.getConversationTitle(document, new URL(location.href)) || 'This conversation';
    const count = adapter.getMessages(document).length;
    const streaming = adapter.isStreaming(document);
    const locked = EXPORT_ACTIONS.filter((action) => {
      const feature = featureFor(action);
      return feature !== null && !plan.has(feature);
    });
    const optionLabels = describeExportOptions(options()).filter((label) => !selection || label === 'No code blocks');
    const common = { locked, ...(optionLabels.length ? { options: optionLabels.join(' · ') } : {}) };
    try {
      const { conversation, total } = read(selection);
      const counted = selection
        ? `${conversation.messages.length} of ${plural(total, 'message')} selected`
        : conversation.messages.length === total
          ? plural(total, 'message')
          : `${conversation.messages.length} of ${plural(total, 'message')}`;
      return {
        title: conversation.title,
        meta: `${SITE_NAMES[adapter.id]} · ${counted}`,
        ...common,
        handoff: compactTokens(buildHandoff(conversation).tokens),
        ...(conversation.streaming ? { warning: 'A reply is still being written. Exports include what is on the page now.' } : {}),
      };
    } catch (error) {
      return {
        title,
        meta: `${SITE_NAMES[adapter.id]}${count ? ` · ${plural(count, 'message')}` : ''}${streaming ? ' · writing…' : ''}`,
        ...common,
        error: errorMessage(error),
      };
    }
  }

  function openOptions(section: OpenOptionsRequest['section']): void {
    chrome.runtime.sendMessage({ type: 'chat-exporter/open-options', section } satisfies OpenOptionsRequest).catch(() => ui.toast('error', RELOAD_MESSAGE));
  }

  async function run(action: UiAction, selection: Selection): Promise<boolean> {
    if (action === 'options') {
      openOptions('options');
      return false;
    }
    if (action === 'select') {
      selectionUrl = pageKey();
      ui.startSelection(selectTargets());
      return false;
    }
    const feature = featureFor(action);
    if (feature && !plan.has(feature)) {
      ui.toast('info', proMessage(feature), { label: 'About Pro', run: () => openOptions('pro') });
      return false;
    }
    let conversation: Conversation;
    try {
      conversation = read(selection).conversation;
    } catch (error) {
      ui.toast('error', errorMessage(error));
      return false;
    }
    if (conversation.messages.length === 0) {
      ui.toast('info', 'Pick at least one message to export.');
      return false;
    }
    const note = conversation.streaming ? ` ${STREAMING_NOTE}` : '';
    const what = selection ? ` (${plural(conversation.messages.length, 'message')})` : '';
    const now = new Date();
    const current = options();
    try {
      if (action === 'copy') {
        const copied = await ui.copy(toMarkdownDocument(conversation, now));
        if (!copied) {
          ui.toast('error', "Couldn't copy to the clipboard. Use Download → Markdown instead.");
          return false;
        }
        ui.toast('success', `Copied as Markdown${what}.${note}`);
      } else if (action === 'handoff') {
        const handoff = buildHandoff(conversation);
        if (!(await ui.copy(handoff.text))) {
          ui.toast('error', "Couldn't copy to the clipboard. Please try again.");
          return false;
        }
        ui.toast('success', `Hand-off prompt copied: ${describeSize(handoff)}. Paste it into a new chat in any AI.${note}`);
      } else if (isExportFormat(action)) {
        const file = buildExportFile(action, conversation, now, current);
        ui.download(file.filename, file.content, file.mime);
        ui.toast('success', `${FORMAT_INFO[action].label} file downloaded${what}.${note}`);
      } else {
        const request: PrintRequest = { type: 'chat-exporter/print', conversation, title: pdfTitle(conversation, now, current) };
        const response = (await chrome.runtime.sendMessage(request)) as PrintResponse | undefined;
        if (!response?.ok) {
          ui.toast('error', response?.message ?? "Couldn't open the print view. Please try again.");
          return false;
        }
        ui.toast('info', `Print view opened in a new tab. Choose “Save as PDF” as the destination.${note}`);
      }
      return true;
    } catch (error) {
      ui.toast('error', alive() ? `Export failed: ${errorText(error)}` : RELOAD_MESSAGE);
      return false;
    }
  }

  chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    if (!isContentRequest(message)) return false;
    sendResponse(answer(message));
    return false;
  });

  function answer(request: ContentRequest): DescribeResponse | ReadResponse {
    try {
      const { conversation, total } = read();
      if (request.type === 'chat-exporter/read') return { ok: true, conversation };
      const handoff = buildHandoff(conversation);
      return {
        ok: true,
        site: adapter.id,
        title: conversation.title,
        messageCount: conversation.messages.length,
        totalCount: total,
        streaming: conversation.streaming,
        handoff: { characters: handoff.characters, tokens: handoff.tokens },
      };
    } catch (error) {
      const code = error instanceof ReadError ? error.code : 'INTERNAL';
      return { ok: false, code, message: errorMessage(error), site: adapter.id };
    }
  }

  onSettingsChanged((next) => {
    settings = next;
    sync();
  });
  onPlanChanged((next) => {
    plan = next;
  });
  // The button appears once both are known, so the menu never shows a stale plan.
  Promise.all([
    loadPlan().then((next) => {
      plan = next;
    }),
    loadSettings()
      .then((next) => {
        settings = next;
      })
      .catch(() => undefined), // Storage unavailable: keep the defaults (button shown).
  ]).finally(() => {
    ready = true;
    sync(true);
  });
}

function errorMessage(error: unknown): string {
  if (error instanceof ReadError) return error.message;
  return `Couldn't read this conversation: ${errorText(error)}`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

const adapter = adapterFor(new URL(location.href));
if (adapter) start(adapter);
