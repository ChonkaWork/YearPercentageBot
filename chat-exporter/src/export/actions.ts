import type { ProFeature } from '../core/plan';
import type { Conversation } from '../core/types';
import { exportFilename, FORMAT_INFO, formatConversation, isExportFormat, type ExportFormat } from './formats';
import { toHtmlDocument } from './html';
import type { ExportOptions } from './options';

/**
 * What the in-page menu and the popup can do with a conversation: copy it, copy a hand-off prompt
 * for another AI, download a file, or open the print view.
 */
export type ExportAction = 'copy' | 'handoff' | ExportFormat | 'pdf';

/** The Pro feature an action needs, if any. Copy, hand-off, .md, .txt and .html are free. */
export function featureFor(action: ExportAction): ProFeature | null {
  if (action === 'pdf') return 'pdf';
  if (isExportFormat(action)) return FORMAT_INFO[action].pro ?? null;
  return null;
}

export interface ExportFile {
  filename: string;
  content: string;
  mime: string;
}

/** The file for a download format, named from the options' template. */
export function buildExportFile(format: ExportFormat, conversation: Conversation, now: Date, options: ExportOptions): ExportFile {
  const info = FORMAT_INFO[format];
  return {
    filename: exportFilename(conversation.title, now, info.extension, { template: options.filenameTemplate, site: conversation.site }),
    content: format === 'html' ? toHtmlDocument(conversation, now) : formatConversation(format, conversation, now, options),
    mime: info.mime,
  };
}

/** The print view's document title, which Chrome suggests as the PDF file name. */
export function pdfTitle(conversation: Conversation, now: Date, options: ExportOptions): string {
  return exportFilename(conversation.title, now, 'pdf', { template: options.filenameTemplate, site: conversation.site }).replace(/\.pdf$/, '');
}
