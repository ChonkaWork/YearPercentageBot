import { isDirectAction, isPromptStyle, type DirectAction, type PromptStyle } from './types';

export interface Settings {
  /** Add the page title and URL to prompts. Off by default: nothing extra leaves the selection unless asked. */
  includePageContext: boolean;
  /** Action highlighted in the Pastebot panel and preselected in the popup. */
  defaultAction: DirectAction;
  promptStyle: PromptStyle;
  /** 0 disables history. */
  maxHistoryItems: number;
}

export const MAX_HISTORY_LIMIT = 50;

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  includePageContext: false,
  defaultAction: 'analyze',
  promptStyle: 'balanced',
  maxHistoryItems: 20,
});

/** Accepts anything read from storage and returns valid settings, falling back per field. */
export function sanitizeSettings(raw: unknown): Settings {
  const input = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  return {
    includePageContext:
      typeof input.includePageContext === 'boolean' ? input.includePageContext : DEFAULT_SETTINGS.includePageContext,
    defaultAction: isDirectAction(input.defaultAction) ? input.defaultAction : DEFAULT_SETTINGS.defaultAction,
    promptStyle: isPromptStyle(input.promptStyle) ? input.promptStyle : DEFAULT_SETTINGS.promptStyle,
    maxHistoryItems: sanitizeHistoryLimit(input.maxHistoryItems),
  };
}

function sanitizeHistoryLimit(value: unknown): number {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isFinite(number)) return DEFAULT_SETTINGS.maxHistoryItems;
  return Math.min(MAX_HISTORY_LIMIT, Math.max(0, Math.round(number)));
}
