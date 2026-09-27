import { isValidSymbol } from './assets';
import { asObject } from './sanitize';
import { isInterval, type Interval } from './types';

export interface Settings {
  /** Read the current tab's URL, title and main heading when the popup opens. */
  detectFromPage: boolean;
  /** Analyses kept in history. 0 turns history off. */
  historyLimit: number;
  /** Developer switch: apply the Free plan limits (see core/features.ts). */
  previewFreePlan: boolean;
}

export const HISTORY_LIMIT_OPTIONS = [0, 10, 20, 50] as const;

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  detectFromPage: true,
  historyLimit: 20,
  previewFreePlan: false,
});

/** Accepts anything read from storage and returns valid settings, falling back per field. */
export function sanitizeSettings(raw: unknown): Settings {
  const input = asObject(raw) ?? {};
  return {
    detectFromPage: typeof input.detectFromPage === 'boolean' ? input.detectFromPage : DEFAULT_SETTINGS.detectFromPage,
    historyLimit: sanitizeHistoryLimit(input.historyLimit),
    previewFreePlan: typeof input.previewFreePlan === 'boolean' ? input.previewFreePlan : DEFAULT_SETTINGS.previewFreePlan,
  };
}

function sanitizeHistoryLimit(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_SETTINGS.historyLimit;
  const max = HISTORY_LIMIT_OPTIONS[HISTORY_LIMIT_OPTIONS.length - 1]!;
  return Math.min(max, Math.max(0, Math.round(value)));
}

/** What the popup remembers between openings. */
export interface UiState {
  lastSymbol: string | null;
  lastInterval: Interval;
}

export const DEFAULT_UI_STATE: Readonly<UiState> = Object.freeze({ lastSymbol: null, lastInterval: '4h' });

export function sanitizeUiState(raw: unknown): UiState {
  const input = asObject(raw) ?? {};
  return {
    lastSymbol: isValidSymbol(input.lastSymbol) ? input.lastSymbol : null,
    lastInterval: isInterval(input.lastInterval) ? input.lastInterval : DEFAULT_UI_STATE.lastInterval,
  };
}

/** Fresh analyses counted per local day, for the Free plan's daily limit. */
export interface Usage {
  day: string;
  count: number;
}

export function dayKey(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function sanitizeUsage(raw: unknown, now: number): Usage {
  const input = asObject(raw);
  const today = dayKey(now);
  if (!input || input.day !== today || typeof input.count !== 'number' || !Number.isInteger(input.count) || input.count < 0) {
    return { day: today, count: 0 };
  }
  return { day: today, count: input.count };
}
