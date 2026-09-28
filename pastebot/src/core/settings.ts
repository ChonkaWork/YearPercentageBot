import { DEFAULT_DESTINATION, isDestination, type Destination } from './destinations';
import { isTranslateSetting } from './languages';
import { MASK_CATEGORIES, isMaskCategory, type MaskCategory, type MaskOptions } from './mask';
import { FREE_HISTORY_LIMIT, PRO_HISTORY_LIMIT } from './plan';
import { isDirectAction, isPromptStyle, type DirectAction, type PromptStyle } from './types';

export interface Settings {
  /** Add the page title and URL to prompts. Off by default: nothing extra leaves the selection unless asked. */
  includePageContext: boolean;
  /** Action highlighted in the Pastebot panel and preselected in the popup. */
  defaultAction: DirectAction;
  promptStyle: PromptStyle;
  /** 0 disables history. The plan's limit (`limitsFor`) may cap it further. */
  maxHistoryItems: number;
  /** Mask secrets before prompting. On by default. */
  maskSecrets: boolean;
  /** Categories the user turned off (new categories are on until turned off). */
  maskOff: MaskCategory[];
  /** Where "Copy & open" goes; the last choice is remembered. */
  openIn: Destination;
  /** Translate target: '' follows the browser's language, else a code from TRANSLATE_LANGUAGES. */
  translateTo: string;
}

/** Absolute upper bound for the setting (the Pro limit). */
export const MAX_HISTORY_LIMIT = PRO_HISTORY_LIMIT;

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  includePageContext: false,
  defaultAction: 'analyze',
  promptStyle: 'balanced',
  maxHistoryItems: FREE_HISTORY_LIMIT,
  maskSecrets: true,
  maskOff: [],
  openIn: DEFAULT_DESTINATION,
  translateTo: '',
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
    maskSecrets: typeof input.maskSecrets === 'boolean' ? input.maskSecrets : DEFAULT_SETTINGS.maskSecrets,
    maskOff: Array.isArray(input.maskOff) ? MASK_CATEGORIES.filter((category) => (input.maskOff as unknown[]).includes(category)) : [],
    openIn: isDestination(input.openIn) ? input.openIn : DEFAULT_SETTINGS.openIn,
    translateTo: isTranslateSetting(input.translateTo) ? input.translateTo : DEFAULT_SETTINGS.translateTo,
  };
}

/** What the generator gets: null when masking is off. */
export function maskOptionsOf(settings: Pick<Settings, 'maskSecrets' | 'maskOff'>): MaskOptions | null {
  return settings.maskSecrets ? { off: settings.maskOff.filter(isMaskCategory) } : null;
}

function sanitizeHistoryLimit(value: unknown): number {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isFinite(number)) return DEFAULT_SETTINGS.maxHistoryItems;
  return Math.min(MAX_HISTORY_LIMIT, Math.max(0, Math.round(number)));
}
