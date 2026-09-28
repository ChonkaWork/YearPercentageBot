import { EXPORT_FORMATS, type CsvDelimiter, type ExportFormat } from './formats';

export type MergeLayout = 'stack' | 'sheets';

export interface Settings {
  /** Excel expects ";" where the decimal separator is a comma (Ukraine, Germany, France...). */
  csvDelimiter: CsvDelimiter;
  /** .xlsx: write number-like cells as numbers. */
  xlsxNumbers: boolean;
  /** Merged export: add "Source" and "Source URL" columns. */
  mergeSource: boolean;
  /** Merged .xlsx: one stacked sheet, or one sheet per table. */
  mergeLayout: MergeLayout;
  /** The popup's format switch: what Copy and Download use. */
  format: ExportFormat;
  /** Cells that are one link keep their URL: a "<Column> URL" column, [text](url) in Markdown. */
  keepLinks: boolean;
}

export const CSV_DELIMITERS: readonly CsvDelimiter[] = [',', ';'];
export const MERGE_LAYOUTS: readonly MergeLayout[] = ['stack', 'sheets'];

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
  return { csvDelimiter: defaultCsvDelimiter(locale), xlsxNumbers: true, mergeSource: true, mergeLayout: 'stack', format: 'csv', keepLinks: false };
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

/** Accepts anything read from storage and returns valid settings, falling back per field. */
export function sanitizeSettings(raw: unknown, defaults: Settings = defaultSettings()): Settings {
  const input = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  return {
    csvDelimiter: oneOf(input.csvDelimiter, CSV_DELIMITERS, defaults.csvDelimiter),
    xlsxNumbers: typeof input.xlsxNumbers === 'boolean' ? input.xlsxNumbers : defaults.xlsxNumbers,
    mergeSource: typeof input.mergeSource === 'boolean' ? input.mergeSource : defaults.mergeSource,
    mergeLayout: oneOf(input.mergeLayout, MERGE_LAYOUTS, defaults.mergeLayout),
    format: oneOf(input.format, EXPORT_FORMATS, defaults.format),
    keepLinks: typeof input.keepLinks === 'boolean' ? input.keepLinks : defaults.keepLinks,
  };
}
