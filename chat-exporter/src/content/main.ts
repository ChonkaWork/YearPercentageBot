import { readConversation, ReadError } from '../core/read';
import { SITE_NAMES, type Conversation } from '../core/types';
import { exportFilename, FORMAT_INFO, formatConversation, isExportFormat, toMarkdownDocument } from '../export/formats';
import {
  isContentRequest,
  type ContentRequest,
  type DescribeResponse,
  type PrintRequest,
  type PrintResponse,
  type ReadResponse,
} from '../platform/messages';
import { adapterFor } from '../sites';
import type { SiteAdapter } from '../sites/types';
import { loadSettings, onSettingsChanged } from '../storage/settings';
import { pageIsDark } from './theme';
import { ExportUi, type MenuInfo, type UiAction } from './ui';
import { watchPage } from './watch';

/**
 * Content script on ChatGPT and Claude. Shows the Export button on conversation pages, runs the
 * exports, and answers the toolbar popup. Reading the page is done by the site adapter.
 */

const RELOAD_MESSAGE = 'Chat Exporter was updated. Reload this page to keep exporting.';
const STREAMING_NOTE = 'The last reply was still being written, so it may be cut off.';

function start(adapter: SiteAdapter): void {
  let showButton = true;
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
    if (themeMayHaveChanged) ui.setDark(pageIsDark());
    const url = new URL(location.href);
    const onConversation = adapter.getConversationId(url) !== null || adapter.getMessages(document).length > 0;
    if (showButton && onConversation) ui.mount(adapter.injectButtonTarget(document));
    else ui.unmount();
  }

  function read(): Conversation {
    return readConversation(adapter, document, location.href);
  }

  function describe(): MenuInfo {
    const title = adapter.getConversationTitle(document, new URL(location.href)) || 'This conversation';
    const count = adapter.getMessages(document).length;
    const streaming = adapter.isStreaming(document);
    try {
      const conversation = read();
      return {
        title: conversation.title,
        meta: `${SITE_NAMES[adapter.id]} · ${plural(conversation.messages.length, 'message')}`,
        ...(conversation.streaming ? { warning: 'A reply is still being written. Exports include what is on the page now.' } : {}),
      };
    } catch (error) {
      return {
        title,
        meta: `${SITE_NAMES[adapter.id]}${count ? ` · ${plural(count, 'message')}` : ''}${streaming ? ' · writing…' : ''}`,
        error: errorMessage(error),
      };
    }
  }

  async function run(action: UiAction): Promise<void> {
    let conversation: Conversation;
    try {
      conversation = read();
    } catch (error) {
      ui.toast('error', errorMessage(error));
      return;
    }
    const note = conversation.streaming ? ` ${STREAMING_NOTE}` : '';
    const now = new Date();
    try {
      if (action === 'copy') {
        const copied = await ui.copy(toMarkdownDocument(conversation, now));
        if (copied) ui.toast('success', `Copied as Markdown.${note}`);
        else ui.toast('error', "Couldn't copy to the clipboard. Use Download → Markdown instead.");
      } else if (isExportFormat(action)) {
        const info = FORMAT_INFO[action];
        ui.download(exportFilename(conversation.title, now, info.extension), formatConversation(action, conversation, now), info.mime);
        ui.toast('success', `${info.label} file downloaded.${note}`);
      } else {
        const response = (await chrome.runtime.sendMessage({ type: 'chat-exporter/print', conversation } satisfies PrintRequest)) as PrintResponse | undefined;
        if (response?.ok) ui.toast('info', `Print view opened in a new tab. Choose “Save as PDF” as the destination.${note}`);
        else ui.toast('error', response?.message ?? "Couldn't open the print view. Please try again.");
      }
    } catch (error) {
      ui.toast('error', alive() ? `Export failed: ${errorText(error)}` : RELOAD_MESSAGE);
    }
  }

  chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    if (!isContentRequest(message)) return false;
    sendResponse(answer(message));
    return false;
  });

  function answer(request: ContentRequest): DescribeResponse | ReadResponse {
    try {
      const conversation = read();
      if (request.type === 'chat-exporter/read') return { ok: true, conversation };
      return { ok: true, site: adapter.id, title: conversation.title, messageCount: conversation.messages.length, streaming: conversation.streaming };
    } catch (error) {
      const code = error instanceof ReadError ? error.code : 'INTERNAL';
      return { ok: false, code, message: errorMessage(error), site: adapter.id };
    }
  }

  onSettingsChanged((settings) => {
    showButton = settings.showButton;
    sync();
  });
  loadSettings()
    .then((settings) => {
      showButton = settings.showButton;
    })
    .catch(() => undefined) // Storage unavailable: keep the default (button shown).
    .finally(() => sync(true));
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
