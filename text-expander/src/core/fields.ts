/**
 * Which form fields Snippets may type into. Pure: works on plain attribute values so it can
 * be tested without a DOM.
 */

/** `<input type>` values that hold free text. Everything else (password, number, date...) is off-limits. */
export const TEXT_INPUT_TYPES: ReadonlySet<string> = new Set(['text', 'search', 'email', 'url', 'tel']);

/** Types whose caret position isn't exposed (`selectionStart` is null); we assume "at the end". */
export const NO_SELECTION_API_TYPES: ReadonlySet<string> = new Set(['email']);

const SECRET_AUTOCOMPLETE_TOKENS: ReadonlySet<string> = new Set(['one-time-code', 'current-password', 'new-password']);

/**
 * True for `autocomplete` values that mark secrets: one-time codes, passwords (also after a
 * "show password" toggle turned the field into type=text) and every credit-card field (cc-*).
 * The attribute may hold several tokens, e.g. "section-pay billing cc-number".
 */
export function isSensitiveAutocomplete(autocomplete: string | null | undefined): boolean {
  if (!autocomplete) return false;
  return autocomplete
    .toLowerCase()
    .split(/\s+/)
    .some((token) => SECRET_AUTOCOMPLETE_TOKENS.has(token) || token.startsWith('cc-'));
}

export interface FieldDescription {
  /** 'input' or 'textarea'. */
  tag: string;
  /** Normalized `input.type` (lowercase); ignored for textarea. */
  type?: string;
  autocomplete?: string | null;
  readOnly?: boolean;
  disabled?: boolean;
}

export function isExpandableField(field: FieldDescription): boolean {
  if (field.readOnly || field.disabled) return false;
  if (isSensitiveAutocomplete(field.autocomplete)) return false;
  if (field.tag === 'textarea') return true;
  return field.tag === 'input' && TEXT_INPUT_TYPES.has(field.type ?? 'text');
}
