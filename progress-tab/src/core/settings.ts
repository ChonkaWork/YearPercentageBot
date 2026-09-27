import { ACCENTS, THEMES, isAccentId, isThemeId, type AccentId, type ThemeId } from './themes';
import { WEEK_STARTS, type PeriodKind, type WeekStart } from './time';
import { WIDGETS, type WidgetId } from './widgets';

export const CLOCK_FORMATS = ['auto', '12h', '24h'] as const;
export type ClockFormat = (typeof CLOCK_FORMATS)[number];

/** 'auto' = 2 decimals for the year (it moves slowly), 1 for month, week and day. */
export const DECIMAL_OPTIONS = ['auto', 0, 1, 2, 3, 4] as const;
export type Decimals = (typeof DECIMAL_OPTIONS)[number];

export interface Settings {
  weekStart: WeekStart;
  widgets: Record<WidgetId, boolean>;
  theme: ThemeId;
  accent: AccentId;
  clock: ClockFormat;
  decimals: Decimals;
}

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  weekStart: 'monday',
  widgets: Object.freeze(Object.fromEntries(WIDGETS.map((widget) => [widget.id, widget.defaultVisible])) as Record<WidgetId, boolean>),
  theme: THEMES[0].id,
  accent: ACCENTS[0].id,
  clock: 'auto',
  decimals: 'auto',
});

function isOneOf<T>(list: readonly T[], value: unknown): value is T {
  return list.includes(value as T);
}

/** Accepts anything read from storage and returns valid settings, falling back per field. */
export function sanitizeSettings(raw: unknown): Settings {
  const input = isRecord(raw) ? raw : {};
  const widgetsInput = isRecord(input.widgets) ? input.widgets : {};
  const widgets = {} as Record<WidgetId, boolean>;
  for (const widget of WIDGETS) {
    const value = widgetsInput[widget.id];
    widgets[widget.id] = typeof value === 'boolean' ? value : widget.defaultVisible;
  }
  return {
    weekStart: isOneOf(WEEK_STARTS, input.weekStart) ? input.weekStart : DEFAULT_SETTINGS.weekStart,
    widgets,
    theme: isThemeId(input.theme) ? input.theme : DEFAULT_SETTINGS.theme,
    accent: isAccentId(input.accent) ? input.accent : DEFAULT_SETTINGS.accent,
    clock: isOneOf(CLOCK_FORMATS, input.clock) ? input.clock : DEFAULT_SETTINGS.clock,
    decimals: sanitizeDecimals(input.decimals),
  };
}

function sanitizeDecimals(value: unknown): Decimals {
  if (value === 'auto') return 'auto';
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return isOneOf(DECIMAL_OPTIONS, number) ? number : DEFAULT_SETTINGS.decimals;
}

export function decimalsFor(kind: PeriodKind, decimals: Decimals): number {
  if (decimals !== 'auto') return decimals;
  return kind === 'year' ? 2 : 1;
}

/** Countdown progress uses the month/week/day precision. */
export function countdownDecimals(decimals: Decimals): number {
  return decimals === 'auto' ? 1 : decimals;
}

export function resolveHour12(clock: ClockFormat, localeUses12h: boolean): boolean {
  if (clock === 'auto') return localeUses12h;
  return clock === '12h';
}

export function settingsEqual(a: Settings, b: Settings): boolean {
  return JSON.stringify(sanitizeSettings(a)) === JSON.stringify(sanitizeSettings(b));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
