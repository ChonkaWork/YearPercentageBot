import { SITE_NAMES } from '../core/types';
import { exportFilename, formatDateTime, roleLabel } from '../export/formats';
import { isConversation, PRINT_KEY_PREFIX, type PrintPayload } from '../platform/messages';
import { renderMarkdown } from '../render/markdown';
import { byId, h } from '../ui/dom';
import { icon, ICONS } from '../ui/icons';

/**
 * Print view: the conversation rendered by our own Markdown renderer (src/render/markdown.ts),
 * which escapes all content and never loads remote resources. Opens the print dialog once
 * rendered; the user picks "Save as PDF".
 */

const els = {
  print: byId<HTMLButtonElement>('print'),
  printIcon: byId<HTMLSpanElement>('print-icon'),
  loading: byId<HTMLDivElement>('loading'),
  error: byId<HTMLDivElement>('error'),
  document: byId<HTMLElement>('document'),
  title: byId<HTMLHeadingElement>('doc-title'),
  meta: byId<HTMLDivElement>('doc-meta'),
  note: byId<HTMLDivElement>('doc-note'),
  messages: byId<HTMLDivElement>('messages'),
};

function fail(message: string): void {
  els.loading.hidden = true;
  els.error.textContent = message;
  els.error.hidden = false;
}

async function load(): Promise<PrintPayload | null> {
  const key = `${PRINT_KEY_PREFIX}${location.hash.slice(1)}`;
  const data = await chrome.storage.session.get(key);
  const payload = data[key] as Partial<PrintPayload> | undefined;
  if (!payload || !isConversation(payload.conversation)) return null;
  return { conversation: payload.conversation, exportedAt: typeof payload.exportedAt === 'number' ? payload.exportedAt : Date.now() };
}

function render({ conversation, exportedAt }: PrintPayload): void {
  const date = new Date(exportedAt);
  // Chrome suggests the document title as the PDF file name.
  document.title = exportFilename(conversation.title, date, 'pdf').replace(/\.pdf$/, '');
  els.title.textContent = conversation.title;
  const meta = [SITE_NAMES[conversation.site], conversation.url, `Exported ${formatDateTime(date)}`, `${conversation.messages.length} messages`];
  els.meta.replaceChildren(...meta.flatMap((item, index) => [index ? ' · ' : '', h('span', { class: 'text-nowrap', text: item })]));
  els.note.hidden = !conversation.streaming;

  for (const message of conversation.messages) {
    const content = h('div', { class: 'content' });
    // Safe: renderMarkdown escapes every character of the conversation (see its tests).
    content.innerHTML = renderMarkdown(message.markdown);
    const section = h(
      'section',
      { class: `message ${message.role}` },
      h('div', { class: 'role', text: roleLabel(message.role, conversation.site) }),
      content,
    );
    if (message.incomplete) section.append(h('p', { class: 'small text-body-secondary fst-italic mt-2 mb-0', text: '(Incomplete: still being generated.)' }));
    els.messages.append(section);
  }
  els.loading.hidden = true;
  els.document.hidden = false;
  els.print.disabled = false;
}

async function init(): Promise<void> {
  els.printIcon.append(icon(ICONS.printer));
  els.print.addEventListener('click', () => window.print());
  const payload = await load();
  if (!payload) {
    fail('This print view has expired. Export the conversation again from the chat page.');
    return;
  }
  render(payload);
  await document.fonts.ready;
  // Let the first frame paint before the (blocking) print dialog opens.
  requestAnimationFrame(() => setTimeout(() => window.print(), 50));
}

init().catch((error: unknown) => fail(`Couldn't show the conversation: ${error instanceof Error ? error.message : String(error)}`));
