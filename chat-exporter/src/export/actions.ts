import type { ProFeature } from '../core/plan';
import type { Conversation } from '../core/types';
import { exportFilename, FORMAT_INFO, formatConversation, isExportFormat, type ExportFormat } from './formats';
import type { ExportOptions } from './options';

/** What the in-page menu and the popup can do with a conversation. */
export type ExportAction = 'copy' | ExportFormat | 'pdf';

/** The Pro feature an action needs, if any. Copy, .md and .txt are free. */
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
    content: formatConversation(format, conversation, now, options),
    mime: info.mime,
  };
}

/** The print view's document title, which Chrome suggests as the PDF file name. */
export function pdfTitle(conversation: Conversation, now: Date, options: ExportOptions): string {
  return exportFilename(conversation.title, now, 'pdf', { template: options.filenameTemplate, site: conversation.site }).replace(/\.pdf$/, '');
}
