export const PROMPT_ACTIONS = [
  'analyze',
  'summarize',
  'explain',
  'extract',
  'compare',
  'rewrite',
  'custom',
] as const;
export type PromptAction = (typeof PROMPT_ACTIONS)[number];

/** Actions that need no extra input and can run straight from the context menu. */
export type DirectAction = Exclude<PromptAction, 'custom'>;

export const PROMPT_STYLES = ['concise', 'balanced', 'detailed'] as const;
export type PromptStyle = (typeof PROMPT_STYLES)[number];

/** Minimal page metadata. Pastebot never reads or sends the page body. */
export interface PageContext {
  title?: string;
  url?: string;
}

export interface PromptRequest {
  action: PromptAction;
  selectedText: string;
  style: PromptStyle;
  /** Only passed when the user enabled "Include page context". */
  pageContext?: PageContext | null;
  /** Required for the `custom` action, ignored otherwise. */
  customInstruction?: string;
}

export type ContentKind = 'text' | 'code' | 'error' | 'table';

export interface ContentInfo {
  kind: ContentKind;
  /** Human-readable language name ("Java", "Python"). Only set when detection is confident. */
  language?: string;
  /** True when most letters are outside the Latin script (Ukrainian, Japanese, ...). */
  nonLatin: boolean;
}

export type PromptErrorCode =
  | 'EMPTY_TEXT'
  | 'TEXT_TOO_LARGE'
  | 'EMPTY_INSTRUCTION'
  | 'INSTRUCTION_TOO_LONG'
  | 'UNKNOWN_ACTION';

export interface PromptError {
  ok: false;
  code: PromptErrorCode;
  /** Short, user-facing message. */
  message: string;
  /** For TEXT_TOO_LARGE: the offending length and the limit. */
  length?: number;
  limit?: number;
}

export type PromptResult = { ok: true; prompt: string; content: ContentInfo } | PromptError;

export function isPromptAction(value: unknown): value is PromptAction {
  return typeof value === 'string' && (PROMPT_ACTIONS as readonly string[]).includes(value);
}

export function isDirectAction(value: unknown): value is DirectAction {
  return isPromptAction(value) && value !== 'custom';
}

export function isPromptStyle(value: unknown): value is PromptStyle {
  return typeof value === 'string' && (PROMPT_STYLES as readonly string[]).includes(value);
}
