/**
 * The snippet model: validation, sanitizing what comes out of storage, sorting and search.
 * Pure functions, no DOM or Chrome APIs.
 */

export interface Snippet {
  id: string;
  /** What the user types, e.g. `;sig`. Case-sensitive, no whitespace. */
  abbreviation: string;
  /** What it expands to. May contain variables like `{date}` and line breaks (`\n`). */
  text: string;
  /** Optional human name. Empty string when not set. */
  label: string;
  createdAt: number;
  updatedAt: number;
}

export interface SnippetDraft {
  abbreviation: string;
  text: string;
  label: string;
}

export const LIMITS = Object.freeze({
  abbreviationMin: 2,
  abbreviationMax: 32,
  textMax: 50_000,
  labelMax: 80,
  snippetsMax: 2_000,
});

export type SnippetField = keyof SnippetDraft;
export type FieldErrors = Partial<Record<SnippetField, string>>;

// C0 controls except tab and line feed, plus DEL. They never belong in typed text.
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const HAS_CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const HAS_WHITESPACE = /\s/u;
const WORD_CHARS_ONLY = /^[\p{L}\p{N}\p{M}_]+$/u;

/** Line breaks become `\n`; control characters are removed. */
export function normalizeText(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(CONTROL_CHARS, '');
}

/** Accepts anything (form values, imported JSON, storage) and returns trimmed strings. */
export function normalizeDraft(input: { abbreviation?: unknown; text?: unknown; label?: unknown }): SnippetDraft {
  return {
    abbreviation: typeof input.abbreviation === 'string' ? input.abbreviation.trim() : '',
    text: typeof input.text === 'string' ? normalizeText(input.text) : '',
    label: typeof input.label === 'string' ? normalizeText(input.label).replace(/\s+/g, ' ').trim() : '',
  };
}

function codePointLength(value: string): number {
  let length = 0;
  for (const _ of value) length++;
  return length;
}

/** Field rules that don't depend on other snippets. */
export function validateFields(draft: SnippetDraft): FieldErrors {
  const errors: FieldErrors = {};
  const abbreviationLength = codePointLength(draft.abbreviation);
  if (!draft.abbreviation) errors.abbreviation = 'Enter an abbreviation.';
  else if (HAS_WHITESPACE.test(draft.abbreviation)) errors.abbreviation = "Abbreviations can't contain spaces or line breaks.";
  else if (HAS_CONTROL_CHARS.test(draft.abbreviation)) errors.abbreviation = "Abbreviations can't contain control characters.";
  else if (abbreviationLength < LIMITS.abbreviationMin) errors.abbreviation = `Use at least ${LIMITS.abbreviationMin} characters.`;
  else if (abbreviationLength > LIMITS.abbreviationMax) errors.abbreviation = `Use at most ${LIMITS.abbreviationMax} characters.`;

  if (!draft.text.trim()) errors.text = 'Enter the text to insert.';
  else if (draft.text.length > LIMITS.textMax) errors.text = `Text is too long (${LIMITS.textMax.toLocaleString('en-US')} characters at most).`;

  if (draft.label.length > LIMITS.labelMax) errors.label = `Use at most ${LIMITS.labelMax} characters.`;
  return errors;
}

/**
 * All rules, including uniqueness. `others` are the saved snippets except the one being
 * edited.
 */
export function validateDraft(draft: SnippetDraft, others: readonly Pick<Snippet, 'abbreviation' | 'label'>[]): FieldErrors {
  const errors = validateFields(draft);
  if (!errors.abbreviation) {
    const clash = others.find((snippet) => snippet.abbreviation === draft.abbreviation);
    if (clash) {
      errors.abbreviation = clash.label
        ? `${draft.abbreviation} is already used by "${clash.label}".`
        : `${draft.abbreviation} is already used by another snippet.`;
    }
  }
  return errors;
}

export function hasErrors(errors: FieldErrors): boolean {
  return Object.keys(errors).length > 0;
}

/** Letters and digits only: can fire in the middle of ordinary typing. */
export function lacksPrefixSymbol(abbreviation: string): boolean {
  return WORD_CHARS_ONLY.test(abbreviation);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function timestamp(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

/**
 * Whatever is in storage (older versions, manual edits, corruption) becomes a valid list:
 * invalid entries and duplicate abbreviations are dropped, ids are made unique.
 */
export function sanitizeSnippets(raw: unknown): Snippet[] {
  if (!Array.isArray(raw)) return [];
  const snippets: Snippet[] = [];
  const abbreviations = new Set<string>();
  const ids = new Set<string>();
  for (const [index, item] of raw.entries()) {
    if (snippets.length >= LIMITS.snippetsMax) break;
    if (!isRecord(item)) continue;
    const draft = normalizeDraft(item);
    if (hasErrors(validateFields(draft)) || abbreviations.has(draft.abbreviation)) continue;
    let id = typeof item.id === 'string' && item.id.length > 0 && item.id.length <= 64 ? item.id : `snippet-${index}`;
    while (ids.has(id)) id = `${id}-${index}`;
    abbreviations.add(draft.abbreviation);
    ids.add(id);
    const createdAt = timestamp(item.createdAt);
    snippets.push({ id, ...draft, createdAt, updatedAt: Math.max(createdAt, timestamp(item.updatedAt)) });
  }
  return snippets;
}

const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true });

export function sortSnippets(snippets: readonly Snippet[]): Snippet[] {
  return [...snippets].sort(
    (a, b) => collator.compare(a.abbreviation, b.abbreviation) || (a.abbreviation < b.abbreviation ? -1 : 1),
  );
}

/**
 * Case-insensitive search over abbreviation, label and text. Every word of the query has to
 * match somewhere. Abbreviation hits rank first, then label hits, then text-only hits.
 */
export function searchSnippets(snippets: readonly Snippet[], query: string): Snippet[] {
  const sorted = sortSnippets(snippets);
  const terms = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return sorted;
  const ranked: { snippet: Snippet; rank: number }[] = [];
  for (const snippet of sorted) {
    const abbreviation = snippet.abbreviation.toLocaleLowerCase();
    const label = snippet.label.toLocaleLowerCase();
    const text = snippet.text.toLocaleLowerCase();
    if (!terms.every((term) => abbreviation.includes(term) || label.includes(term) || text.includes(term))) continue;
    const first = terms[0] ?? '';
    const rank = abbreviation === first ? 0 : abbreviation.startsWith(first) ? 1 : abbreviation.includes(first) ? 2 : label.includes(first) ? 3 : 4;
    ranked.push({ snippet, rank });
  }
  // Array.prototype.sort is stable, so equal ranks keep the alphabetical order.
  return ranked.sort((a, b) => a.rank - b.rank).map((entry) => entry.snippet);
}

/** One-line preview of the text for lists. */
export function previewText(text: string, max = 160): string {
  const flat = text.replace(/\s*\n\s*/g, ' ⏎ ').replace(/[ \t]+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
