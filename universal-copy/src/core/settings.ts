import type { CsvDelimiter } from './tableFormats';

export type ShortcutFormat = 'text' | 'markdown';
export type BulletMarker = '-' | '*' | '+';
export type EmphasisMarker = '*' | '_';

export interface Settings {
  /** What the keyboard shortcut copies. */
  shortcutFormat: ShortcutFormat;
  /** Clean text: add "(https://...)" after link text. */
  includeLinkUrls: boolean;
  bulletMarker: BulletMarker;
  emphasisMarker: EmphasisMarker;
  /** Excel expects ";" where the decimal separator is a comma (Ukraine, Germany, France...). */
  csvDelimiter: CsvDelimiter;
}

export const SHORTCUT_FORMATS: readonly ShortcutFormat[] = ['text', 'markdown'];
export const BULLET_MARKERS: readonly BulletMarker[] = ['-', '*', '+'];
export const EMPHASIS_MARKERS: readonly EmphasisMarker[] = ['*', '_'];
export const CSV_DELIMITERS: readonly CsvDelimiter[] = [',', ';'];

/**
 * The CSV delimiter Excel uses for a locale: ";" when the locale writes decimals with a
 * comma (1,5), "," otherwise. Falls back to "," for unknown locales.
 */
export function defaultCsvDelimiter(locale: string | undefined): CsvDelimiter {
  try {
    const decimal = new Intl.NumberFormat(locale).formatToParts(1.5).find((part) => part.type === 'decimal')?.value;
    return decimal === ',' ? ';' : ',';
  } catch {
    return ',';
  }
}

export function defaultSettings(locale?: string): Settings {
  return {
    shortcutFormat: 'text',
    includeLinkUrls: false,
    bulletMarker: '-',
    emphasisMarker: '*',
    csvDelimiter: defaultCsvDelimiter(locale),
  };
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

/** Accepts anything read from storage and returns valid settings, falling back per field. */
export function sanitizeSettings(raw: unknown, defaults: Settings = defaultSettings()): Settings {
  const input = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  return {
    shortcutFormat: oneOf(input.shortcutFormat, SHORTCUT_FORMATS, defaults.shortcutFormat),
    includeLinkUrls: typeof input.includeLinkUrls === 'boolean' ? input.includeLinkUrls : defaults.includeLinkUrls,
    bulletMarker: oneOf(input.bulletMarker, BULLET_MARKERS, defaults.bulletMarker),
    emphasisMarker: oneOf(input.emphasisMarker, EMPHASIS_MARKERS, defaults.emphasisMarker),
    csvDelimiter: oneOf(input.csvDelimiter, CSV_DELIMITERS, defaults.csvDelimiter),
  };
}
