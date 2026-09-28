/**
 * Snippet variables: `{date}`, `{date:YYYY-MM-DD}`, `{time}`, `{datetime}`, `{weekday}`,
 * `{cursor}` and the Pro fill-in fields `{input:Name}` / `{input:Name=default}`. Unknown
 * `{names}` are left exactly as typed, so code and templates with braces survive.
 */

export interface ExpandOptions {
  now: Date;
  /** BCP 47 tag; defaults to the runtime locale. */
  locale?: string | undefined;
  /** For `<input>`: line breaks become single spaces (inputs would silently drop them). */
  singleLine?: boolean;
  /**
   * Values for `{input:Name}` fields, by name. Without it the fields stay exactly as typed
   * (free plan). A missing name falls back to the field's default.
   */
  inputs?: Readonly<Record<string, string>> | undefined;
}

export interface Expansion {
  text: string;
  /** Where the caret goes (UTF-16 index into `text`), or null for "at the end". */
  cursor: number | null;
}

const VARIABLE = /\{(cursor|date|time|datetime|weekday|input)(?::([^{}\n]+))?\}/gi;
const CURSOR_MARK = '\u0000';

export function expandTemplate(template: string, options: ExpandOptions): Expansion {
  const { now, locale } = options;
  let cursorPlaced = false;
  let text = template.replaceAll(CURSOR_MARK, '').replace(VARIABLE, (whole, rawName: string, format: string | undefined) => {
    const name = rawName.toLowerCase();
    if (name === 'cursor') {
      if (format !== undefined) return whole;
      if (cursorPlaced) return '';
      cursorPlaced = true;
      return CURSOR_MARK;
    }
    if (name === 'input') {
      const field = format === undefined ? null : parseFieldSpec(format);
      if (!field || !options.inputs) return whole;
      // What the user typed is plain text: never a variable, never the caret marker.
      return (options.inputs[field.name] ?? field.defaultValue).replaceAll(CURSOR_MARK, '');
    }
    if (name === 'weekday') return format === undefined ? weekdayName(now, locale) : whole;
    if (format !== undefined) return formatDate(now, format, locale);
    return defaultFormat(name, now, locale);
  });
  if (options.singleLine) text = text.replace(/[ \t]*\n[ \t\n]*/g, ' ');
  const cursor = text.indexOf(CURSOR_MARK);
  if (cursor === -1) return { text, cursor: null };
  return { text: text.slice(0, cursor) + text.slice(cursor + 1), cursor };
}

/** Text for the clipboard: variables filled in, `{cursor}` removed. */
export function renderForCopy(template: string, now: Date, locale?: string, inputs?: Readonly<Record<string, string>>): string {
  return expandTemplate(template, { now, locale, inputs }).text;
}

// --- Fill-in fields (Pro) ---------------------------------------------------------------

export interface FillField {
  name: string;
  defaultValue: string;
}

export const MAX_FIELD_NAME = 40;
export const MAX_FIELDS = 12;

/** `Name` or `Name=default` (the part after `input:`). Null when it isn't a usable field. */
export function parseFieldSpec(spec: string): FillField | null {
  const equals = spec.indexOf('=');
  const name = (equals === -1 ? spec : spec.slice(0, equals)).trim();
  if (!name || name.length > MAX_FIELD_NAME) return null;
  return { name, defaultValue: equals === -1 ? '' : spec.slice(equals + 1) };
}

/**
 * The distinct fill-in fields of a template, in order of first appearance. A name used twice
 * is asked once and fills every place; the first non-empty default wins.
 */
export function parseFields(template: string): FillField[] {
  const fields: FillField[] = [];
  for (const match of template.matchAll(VARIABLE)) {
    if ((match[1] ?? '').toLowerCase() !== 'input' || match[2] === undefined) continue;
    const field = parseFieldSpec(match[2]);
    if (!field) continue;
    const existing = fields.find((entry) => entry.name === field.name);
    if (existing) {
      if (!existing.defaultValue) existing.defaultValue = field.defaultValue;
      continue;
    }
    if (fields.length >= MAX_FIELDS) break;
    fields.push(field);
  }
  return fields;
}

export function hasFields(template: string): boolean {
  return parseFields(template).length > 0;
}

/** Each field's default, for a preview or an unattended fill. */
export function defaultInputs(fields: readonly FillField[]): Record<string, string> {
  return Object.fromEntries(fields.map((field) => [field.name, field.defaultValue]));
}

/** Values typed into a fill-in form: line breaks become spaces, control characters go away. */
export function normalizeInputValue(value: string): string {
  return value.replace(/\r\n?|\n/g, ' ').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}

export function hasVariables(template: string): boolean {
  VARIABLE.lastIndex = 0;
  const found = VARIABLE.test(template);
  VARIABLE.lastIndex = 0;
  return found;
}

// --- Date formatting --------------------------------------------------------------------

function formatter(locale: string | undefined, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat(locale, options);
  } catch {
    // Invalid locale tag: use the runtime default instead of failing the expansion.
    return new Intl.DateTimeFormat(undefined, options);
  }
}

/** ICU puts a narrow no-break space before AM/PM; plain text fields are better off with a space. */
function plain(text: string): string {
  return text.replace(/ /g, ' ');
}

function part(date: Date, locale: string | undefined, options: Intl.DateTimeFormatOptions, type: Intl.DateTimeFormatPartTypes): string {
  return formatter(locale, options).formatToParts(date).find((entry) => entry.type === type)?.value ?? '';
}

function weekdayName(date: Date, locale: string | undefined, style: 'long' | 'short' = 'long'): string {
  return part(date, locale, { weekday: style }, 'weekday');
}

function defaultFormat(name: string, now: Date, locale: string | undefined): string {
  switch (name) {
    case 'date':
      return plain(formatter(locale, { year: 'numeric', month: 'numeric', day: 'numeric' }).format(now));
    case 'time':
      return plain(formatter(locale, { hour: 'numeric', minute: '2-digit' }).format(now));
    default:
      return plain(
        formatter(locale, { year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(now),
      );
  }
}

const TOKENS = /\[([^\]]*)\]|YYYY|YY|MMMM|MMM|MM|M|DD|D|dddd|ddd|HH|H|hh|h|mm|ss|A|a/g;

const pad = (value: number, length = 2) => String(value).padStart(length, '0');

/**
 * Formats with dayjs-style tokens: YYYY YY · MMMM MMM MM M · DD D · dddd ddd · HH H hh h ·
 * mm · ss · A a. Text inside [brackets] is literal; anything else passes through.
 */
export function formatDate(date: Date, format: string, locale?: string): string {
  // With a day number in the format, some languages need the month in another case
  // ("27 сентября", not "27 сентябрь"), which Intl gives when the day is part of the pattern.
  const withDay = [...format.matchAll(TOKENS)].some(([token]) => token === 'D' || token === 'DD');
  const monthName = (style: 'long' | 'short') =>
    part(date, locale, withDay ? { day: 'numeric', month: style } : { month: style }, 'month');
  const hours12 = date.getHours() % 12 || 12;
  return format.replace(TOKENS, (token, literal: string | undefined) => {
    if (literal !== undefined) return literal;
    switch (token) {
      case 'YYYY':
        return pad(date.getFullYear(), 4);
      case 'YY':
        return pad(date.getFullYear() % 100);
      case 'MMMM':
        return monthName('long');
      case 'MMM':
        return monthName('short');
      case 'MM':
        return pad(date.getMonth() + 1);
      case 'M':
        return String(date.getMonth() + 1);
      case 'DD':
        return pad(date.getDate());
      case 'D':
        return String(date.getDate());
      case 'dddd':
        return weekdayName(date, locale, 'long');
      case 'ddd':
        return weekdayName(date, locale, 'short');
      case 'HH':
        return pad(date.getHours());
      case 'H':
        return String(date.getHours());
      case 'hh':
        return pad(hours12);
      case 'h':
        return String(hours12);
      case 'mm':
        return pad(date.getMinutes());
      case 'ss':
        return pad(date.getSeconds());
      case 'A':
        return date.getHours() < 12 ? 'AM' : 'PM';
      default:
        return date.getHours() < 12 ? 'am' : 'pm';
    }
  });
}

export interface VariableHelp {
  token: string;
  description: string;
}

export const VARIABLE_HELP: readonly VariableHelp[] = [
  { token: '{cursor}', description: 'Where the caret goes after expanding' },
  { token: '{date}', description: "Today's date" },
  { token: '{date:YYYY-MM-DD}', description: 'Date in your own format' },
  { token: '{time}', description: 'Current time' },
  { token: '{datetime}', description: 'Date and time' },
  { token: '{weekday}', description: 'Day of the week' },
];

/** Pro: asked for when the snippet expands. Shown with a PRO badge. */
export const FIELD_HELP: VariableHelp = { token: '{input:Name}', description: 'Asks for a value when the snippet expands (Pro)' };
