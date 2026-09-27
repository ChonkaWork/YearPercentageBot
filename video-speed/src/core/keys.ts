/**
 * Keyboard shortcuts model. Pure functions, no DOM.
 *
 * Bindings are stored as `KeyboardEvent.code` (the physical key), not `key` (the character),
 * so shortcuts keep working with non-Latin layouts: on a Ukrainian layout the S key types
 * "і" but its code is still "KeyS".
 */

export const ACTION_IDS = ['slower', 'faster', 'reset', 'preferred', 'rewind', 'advance', 'toggleController'] as const;
export type ActionId = (typeof ACTION_IDS)[number];

/** `null` means the action has no key. */
export type KeyBindings = Record<ActionId, string | null>;

export const DEFAULT_KEYS: Readonly<KeyBindings> = Object.freeze({
  slower: 'KeyS',
  faster: 'KeyD',
  reset: 'KeyR',
  preferred: 'KeyG',
  rewind: 'KeyZ',
  advance: 'KeyX',
  toggleController: 'KeyV',
});

export const ACTION_LABELS: Readonly<Record<ActionId, string>> = Object.freeze({
  slower: 'Slower',
  faster: 'Faster',
  reset: 'Reset to 1×',
  preferred: 'Toggle preferred speed',
  rewind: 'Rewind',
  advance: 'Advance',
  toggleController: 'Show / hide controller',
});

/** Holding these keys down repeats the action; the others fire once per press. */
export const REPEATABLE_ACTIONS: ReadonlySet<ActionId> = new Set<ActionId>(['slower', 'faster', 'rewind', 'advance']);

/** Keys that can't be a shortcut: modifiers, focus navigation, and Escape (cancels capture). */
const RESERVED_CODES = new Set([
  // `key` names of modifiers, in case one ends up in storage instead of a code.
  'Shift',
  'Control',
  'Alt',
  'AltGraph',
  'Meta',
  'Hyper',
  'Super',
  'Symbol',
  'Tab',
  'Escape',
  'ShiftLeft',
  'ShiftRight',
  'ControlLeft',
  'ControlRight',
  'AltLeft',
  'AltRight',
  'MetaLeft',
  'MetaRight',
  'OSLeft',
  'OSRight',
  'CapsLock',
  'NumLock',
  'ScrollLock',
  'Fn',
  'FnLock',
  'ContextMenu',
  'Unidentified',
]);

export function isActionId(value: unknown): value is ActionId {
  return typeof value === 'string' && (ACTION_IDS as readonly string[]).includes(value);
}

export function isBindableCode(code: unknown): code is string {
  return typeof code === 'string' && /^[A-Za-z][A-Za-z0-9]{0,31}$/.test(code) && !RESERVED_CODES.has(code);
}

/**
 * Accepts anything read from storage. Invalid entries fall back to the default key, explicit
 * `null` stays unbound, and when two actions share a key the first one (in ACTION_IDS order)
 * keeps it.
 */
export function sanitizeBindings(raw: unknown): KeyBindings {
  const input = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const result = {} as KeyBindings;
  const used = new Set<string>();
  for (const action of ACTION_IDS) {
    const value = input[action];
    let code: string | null = value === null ? null : isBindableCode(value) ? value : DEFAULT_KEYS[action];
    if (code !== null && used.has(code)) code = null;
    if (code !== null) used.add(code);
    result[action] = code;
  }
  return result;
}

export function actionForCode(bindings: KeyBindings, code: string): ActionId | null {
  if (!code) return null;
  for (const action of ACTION_IDS) if (bindings[action] === code) return action;
  return null;
}

/** The other action that already uses `code`, if any. */
export function findConflict(bindings: KeyBindings, action: ActionId, code: string): ActionId | null {
  for (const other of ACTION_IDS) if (other !== action && bindings[other] === code) return other;
  return null;
}

const CODE_LABELS: Record<string, string> = {
  Space: 'Space',
  Enter: 'Enter',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Insert: 'Insert',
  Home: 'Home',
  End: 'End',
  PageUp: 'Page Up',
  PageDown: 'Page Down',
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  IntlBackslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Backquote: '`',
  Comma: ',',
  Period: '.',
  Slash: '/',
  NumpadAdd: 'Num +',
  NumpadSubtract: 'Num -',
  NumpadMultiply: 'Num *',
  NumpadDivide: 'Num /',
  NumpadDecimal: 'Num .',
  NumpadEnter: 'Num Enter',
};

/** Human label for a key code, as printed on a US keyboard: "KeyS" → "S", "Comma" → ",". */
export function keyLabel(code: string | null): string {
  if (!code) return 'Not set';
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter?.[1]) return letter[1];
  const digit = /^Digit([0-9])$/.exec(code);
  if (digit?.[1]) return digit[1];
  const numpad = /^Numpad([0-9])$/.exec(code);
  if (numpad?.[1]) return `Num ${numpad[1]}`;
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  return CODE_LABELS[code] ?? code;
}

// --- Matching key events --------------------------------------------------------------------

/** The parts of a KeyboardEvent the matcher needs (so it can be tested without a DOM). */
export interface KeyEventLike {
  key: string;
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  isComposing: boolean;
  keyCode?: number;
  repeat: boolean;
}

/** The parts of the event target the matcher needs. */
export interface KeyTargetLike {
  tagName: string;
  isContentEditable: boolean;
  role: string | null;
}

const TEXT_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton']);

/** True for form fields and editors, where letters must reach the page untouched. */
export function isTypingTarget(target: KeyTargetLike | null): boolean {
  if (!target) return false;
  const tag = target.tagName.toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (target.isContentEditable) return true;
  return target.role !== null && TEXT_ROLES.has(target.role.trim().toLowerCase());
}

/**
 * The physical key of an event. Some virtual keyboards report an empty `code`; for Latin
 * letters and digits the character is used instead.
 */
export function eventCode(event: Pick<KeyEventLike, 'code' | 'key'>): string {
  if (event.code) return event.code;
  if (/^[a-z]$/i.test(event.key)) return `Key${event.key.toUpperCase()}`;
  if (/^[0-9]$/.test(event.key)) return `Digit${event.key}`;
  return '';
}

export type KeyMatch = { action: ActionId; repeatOnly: boolean } | null;

/**
 * Decides whether a keydown is one of our shortcuts. Ignored: any modifier held, IME
 * composition, typing in fields/editors. `repeatOnly` marks auto-repeats of non-repeatable
 * actions: the key is ours (swallow it) but nothing should happen.
 */
export function matchShortcut(bindings: KeyBindings, event: KeyEventLike, target: KeyTargetLike | null): KeyMatch {
  if (event.isComposing || event.keyCode === 229) return null;
  if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return null;
  if (isTypingTarget(target)) return null;
  const action = actionForCode(bindings, eventCode(event));
  if (!action) return null;
  return { action, repeatOnly: event.repeat && !REPEATABLE_ACTIONS.has(action) };
}
