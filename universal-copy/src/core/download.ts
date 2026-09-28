/**
 * "Download as file": file names and contents. Pure; the popup turns the result into a
 * Blob and an `<a download>` click (no `downloads` permission needed).
 */

export type DownloadKind = 'md' | 'csv' | 'json';

export interface DownloadFile {
  filename: string;
  mime: string;
  content: string;
}

const MIME: Record<DownloadKind, string> = {
  md: 'text/markdown;charset=utf-8',
  csv: 'text/csv;charset=utf-8',
  json: 'application/json;charset=utf-8',
};

const MAX_NAME = 80;
const BOM = '\u{feff}';

/**
 * A file name that is safe on Windows, macOS and Linux: no path separators, reserved or
 * control characters, no leading or trailing dots; letters of any script are kept.
 */
export function safeFileName(base: string | null | undefined, extension: DownloadKind, fallback = 'universal-copy'): string {
  let name = (base ?? '')
    .normalize('NFC')
    .replace(/[\u{0}-\u{1f}\u{7f}<>:"/\\|?*]+/gu, ' ')
    .replace(/[\u{200b}-\u{200f}\u{2060}\u{feff}\u{ad}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  if ([...name].length > MAX_NAME) name = [...name].slice(0, MAX_NAME).join('');
  name = name.replace(/^[. ]+|[. ]+$/g, '');
  if (!name || /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(name)) name = fallback;
  return `${name}.${extension}`;
}

/**
 * CSV gets a UTF-8 byte order mark: without it Excel opens non-Latin text (Cyrillic,
 * accents) as mojibake. Every file ends with a line break; line endings stay LF.
 */
export function downloadFile(content: string, kind: DownloadKind, baseName: string | null | undefined): DownloadFile {
  const body = content.endsWith('\n') ? content : `${content}\n`;
  return {
    filename: safeFileName(baseName, kind),
    mime: MIME[kind],
    content: kind === 'csv' ? `${BOM}${body}` : body,
  };
}
