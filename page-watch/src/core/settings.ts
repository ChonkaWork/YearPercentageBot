import { isInterval, type IntervalMinutes } from './types';

export interface QuietHours {
  /** Hold notifications during these hours (Pro). Checks keep running either way. */
  enabled: boolean;
  /** Minutes after local midnight. `start` later than `end` spans midnight (22:00–07:00). */
  start: number;
  end: number;
}

export interface Settings {
  /** Show a system notification when a watch changes. The badge is always updated. */
  notifyChanges: boolean;
  /** Show a notification when a watch stops working (persistent errors, or transient ones that keep failing). */
  notifyErrors: boolean;
  /** Preselected interval for new watches. */
  defaultIntervalMinutes: IntervalMinutes;
  quietHours: QuietHours;
  /** Play a short chime with change notifications (each watch can turn it off). Off by default. */
  sound: boolean;
}

export const DEFAULT_QUIET_HOURS: QuietHours = { enabled: false, start: 22 * 60, end: 7 * 60 };

export const DEFAULT_SETTINGS: Settings = {
  notifyChanges: true,
  notifyErrors: true,
  defaultIntervalMinutes: 60,
  quietHours: DEFAULT_QUIET_HOURS,
  sound: false,
};

const DAY_MINUTES = 24 * 60;

function isMinuteOfDay(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < DAY_MINUTES;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function sanitizeQuietHours(raw: unknown): QuietHours {
  const value = isRecord(raw) ? raw : {};
  return {
    enabled: value.enabled === true,
    start: isMinuteOfDay(value.start) ? value.start : DEFAULT_QUIET_HOURS.start,
    end: isMinuteOfDay(value.end) ? value.end : DEFAULT_QUIET_HOURS.end,
  };
}

export function sanitizeSettings(raw: unknown): Settings {
  const value = isRecord(raw) ? raw : {};
  return {
    notifyChanges: typeof value.notifyChanges === 'boolean' ? value.notifyChanges : DEFAULT_SETTINGS.notifyChanges,
    notifyErrors: typeof value.notifyErrors === 'boolean' ? value.notifyErrors : DEFAULT_SETTINGS.notifyErrors,
    defaultIntervalMinutes: isInterval(value.defaultIntervalMinutes)
      ? value.defaultIntervalMinutes
      : DEFAULT_SETTINGS.defaultIntervalMinutes,
    quietHours: sanitizeQuietHours(value.quietHours),
    sound: value.sound === true,
  };
}

/** "22:00" → 1320; null for anything else. */
export function parseClock(text: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return hours < 24 && minutes < 60 ? hours * 60 + minutes : null;
}

/** 1320 → "22:00". */
export function formatClock(minuteOfDay: number): string {
  const hours = Math.floor(minuteOfDay / 60);
  const minutes = minuteOfDay % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}
