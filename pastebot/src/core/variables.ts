import type { PageContext } from './types';

/**
 * Template variables (Pro, part of custom templates):
 * - built-ins filled from the page and the clock: `{title}`, `{url}`, `{date}`; `{selection}` is
 *   an alias of `{content}` (placed by the generator);
 * - ask-at-run-time variables: `{{Audience}}` or `{{Language=English}}` (with a default). The
 *   panel and the popup ask for them before the prompt is made.
 *
 * Pure: the caller passes the page, the date and the answers.
 */

export const MAX_ASK_VARIABLES = 6;
export const MAX_VARIABLE_NAME_CHARS = 32;
export const MAX_VARIABLE_DEFAULT_CHARS = 100;
export const MAX_VARIABLE_VALUE_CHARS = 500;

export interface AskVariable {
  /** As first written in the template. Names match case-insensitively. */
  name: string;
  /** From `{{Name=default}}`; empty when there is none. */
  defaultValue: string;
}

/** What the built-ins and the answers are filled with. */
export interface VariableValues {
  page: PageContext | null;
  /** `YYYY-MM-DD`, see isoDate. */
  date: string;
  /** Answers to the ask variables, by name. */
  values: Readonly<Record<string, string>>;
}

/** Inserted by the editor's chips, in this order. */
export const VARIABLE_CHIPS = ['{content}', '{title}', '{url}', '{date}', '{{Variable}}'] as const;

const ASK = /\{\{([^{}\n]*)\}\}/g;
/** `{{Asked}}` or a built-in with single braces (`{title}`, `{ URL }`), in one pass so answers are never re-read. */
const ANY_VARIABLE = /\{\{([^{}\n]*)\}\}|(?<!\{)\{\s*(title|url|date)\s*\}(?!\})/gi;
const RESERVED = /^(?:content|selection|title|url|date)$/i;
const NAME = /^[\p{L}\p{N}][\p{L}\p{N} _'.-]*$/u;

interface ParsedAsk {
  name: string;
  defaultValue: string;
  problem?: string;
}

function parseAsk(body: string): ParsedAsk {
  const eq = body.indexOf('=');
  const name = (eq === -1 ? body : body.slice(0, eq)).replace(/\s+/g, ' ').trim();
  const defaultValue = eq === -1 ? '' : body.slice(eq + 1).trim();
  if (!name) return { name, defaultValue, problem: 'Give every {{variable}} a name, e.g. {{Audience}}.' };
  if (RESERVED.test(name)) return { name, defaultValue, problem: `Write {${name.toLowerCase()}} with single braces: it is filled in automatically.` };
  if (name.length > MAX_VARIABLE_NAME_CHARS) return { name, defaultValue, problem: `Keep variable names under ${MAX_VARIABLE_NAME_CHARS} characters.` };
  if (!NAME.test(name)) return { name, defaultValue, problem: `“${name}” can't be a variable name. Use letters, numbers and spaces.` };
  if (defaultValue.length > MAX_VARIABLE_DEFAULT_CHARS) {
    return { name, defaultValue, problem: `Keep default values under ${MAX_VARIABLE_DEFAULT_CHARS} characters.` };
  }
  return { name, defaultValue };
}

/** The ask variables of a template, once each, in order of first use. Malformed ones are skipped. */
export function askVariables(instruction: string): AskVariable[] {
  const seen = new Map<string, AskVariable>();
  for (const match of instruction.matchAll(ASK)) {
    const parsed = parseAsk(match[1] ?? '');
    if (parsed.problem) continue;
    const key = parsed.name.toLowerCase();
    const existing = seen.get(key);
    if (!existing) seen.set(key, { name: parsed.name, defaultValue: parsed.defaultValue });
    else if (!existing.defaultValue && parsed.defaultValue) existing.defaultValue = parsed.defaultValue;
    if (seen.size >= MAX_ASK_VARIABLES) break;
  }
  return [...seen.values()];
}

/** What's wrong with the variables of an instruction, for the template editor. Null when fine. */
export function variableProblem(instruction: string): string | null {
  const names = new Set<string>();
  for (const match of instruction.matchAll(ASK)) {
    const parsed = parseAsk(match[1] ?? '');
    if (parsed.problem) return parsed.problem;
    names.add(parsed.name.toLowerCase());
  }
  // Every `{{` must be part of a complete `{{Name}}` (a lone `}}` is fine: nested JSON has those).
  if (/\{\{/.test(instruction.replace(ASK, ''))) {
    return 'A {{variable}} is not closed. Write it as {{Name}} or {{Name=default}}.';
  }
  if (names.size > MAX_ASK_VARIABLES) return `Use at most ${MAX_ASK_VARIABLES} different {{variables}}.`;
  return null;
}

/** Names of ask variables that have neither an answer nor a default. */
export function missingVariables(asks: readonly AskVariable[], values: Readonly<Record<string, string>>): string[] {
  const answers = normalizeValues(values);
  return asks.filter((ask) => !answers.get(ask.name.toLowerCase()) && !ask.defaultValue).map((ask) => ask.name);
}

/**
 * Fills `{title}`, `{url}`, `{date}` and `{{Asked}}` in a piece of instruction. `{content}` is
 * left for the generator. `transform` is applied to page values (the masker, when on).
 */
export function fillVariables(text: string, context: VariableValues, transform: (value: string) => string = (value) => value): string {
  const answers = normalizeValues(context.values);
  return text.replace(ANY_VARIABLE, (whole, body: string | undefined, builtin: string | undefined) => {
    if (body !== undefined) {
      const parsed = parseAsk(body);
      if (parsed.problem) return whole;
      return answers.get(parsed.name.toLowerCase()) || parsed.defaultValue;
    }
    switch (builtin?.toLowerCase()) {
      case 'title':
        return context.page?.title ? transform(context.page.title) : '';
      case 'url':
        return context.page?.url ? transform(context.page.url) : '';
      default:
        return context.date;
    }
  });
}

/** Local calendar date as `YYYY-MM-DD` (unambiguous in any language). */
export function isoDate(date: Date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Answers from a form or a message: strings only, trimmed, bounded. */
export function sanitizeValues(raw: unknown): Record<string, string> {
  const values: Record<string, string> = {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return values;
  for (const [name, value] of Object.entries(raw as Record<string, unknown>).slice(0, MAX_ASK_VARIABLES * 2)) {
    if (typeof value !== 'string' || name.length > MAX_VARIABLE_NAME_CHARS) continue;
    values[name] = value.trim().slice(0, MAX_VARIABLE_VALUE_CHARS);
  }
  return values;
}

function normalizeValues(values: Readonly<Record<string, string>>): Map<string, string> {
  const map = new Map<string, string>();
  for (const [name, value] of Object.entries(values)) {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    if (trimmed) map.set(name.trim().toLowerCase(), trimmed);
  }
  return map;
}
