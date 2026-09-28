import type { DashMode } from './typography';

/** What "clean" means. Every option is applied by src/core/cleaner.ts. */
export interface CleanOptions {
  /** Keep the line breaks as they are, or merge wrapped lines into flowing paragraphs. */
  lineBreaks: 'keep' | 'merge';
  /** Keep "- item" markers on list lines (numbers of numbered lists are always kept). */
  keepBullets: boolean;
  /** Remove utm_*, fbclid, gclid and friends from web addresses in the text. */
  stripTracking: boolean;
  /** Runs of spaces and tabs become one space; at most one blank line in a row. */
  collapseWhitespace: boolean;
  /** Links keep their address after the text: "the guide (https://…)". */
  keepLinkUrls: boolean;
  /** Curly quotes, dashes, ellipses and special spaces become plain characters. */
  typography: boolean;
  /** With typography: turn en/em dashes into "-" / " - ", or keep them. */
  dashes: DashMode;
  /** Remove Markdown syntax (**bold**, # headings, [links](…)); code fences are kept. */
  removeMarkdown: boolean;
}

export interface Settings extends CleanOptions {
  /** Auto-clean (Pro): also clean copies made inside text fields and rich editors. */
  autoCleanEditors: boolean;
  /** Auto-clean (Pro): show a small confirmation in the page after a cleaned copy. */
  autoCleanToast: boolean;
}

export const LINE_BREAK_MODES: readonly CleanOptions['lineBreaks'][] = ['keep', 'merge'];

export function defaultSettings(): Settings {
  return {
    lineBreaks: 'keep',
    keepBullets: true,
    stripTracking: true,
    collapseWhitespace: true,
    keepLinkUrls: false,
    typography: false,
    dashes: 'hyphen',
    removeMarkdown: false,
    autoCleanEditors: false,
    autoCleanToast: true,
  };
}

/** Accepts anything read from storage and returns valid settings, falling back per field. */
export function sanitizeSettings(raw: unknown, defaults: Settings = defaultSettings()): Settings {
  const input = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const bool = (key: keyof Settings): boolean => (typeof input[key] === 'boolean' ? (input[key] as boolean) : (defaults[key] as boolean));
  return {
    lineBreaks: input.lineBreaks === 'merge' || input.lineBreaks === 'keep' ? input.lineBreaks : defaults.lineBreaks,
    keepBullets: bool('keepBullets'),
    stripTracking: bool('stripTracking'),
    collapseWhitespace: bool('collapseWhitespace'),
    keepLinkUrls: bool('keepLinkUrls'),
    typography: bool('typography'),
    dashes: input.dashes === 'keep' || input.dashes === 'hyphen' ? input.dashes : defaults.dashes,
    removeMarkdown: bool('removeMarkdown'),
    autoCleanEditors: bool('autoCleanEditors'),
    autoCleanToast: bool('autoCleanToast'),
  };
}
