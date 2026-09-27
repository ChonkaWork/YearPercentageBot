import { isInterval, type IntervalMinutes } from './types';

export interface Settings {
  /** Show a system notification when a watch changes. The badge is always updated. */
  notifyChanges: boolean;
  /** Show a notification when a watch stops working (persistent errors, or transient ones that keep failing). */
  notifyErrors: boolean;
  /** Preselected interval for new watches. */
  defaultIntervalMinutes: IntervalMinutes;
}

export const DEFAULT_SETTINGS: Settings = {
  notifyChanges: true,
  notifyErrors: true,
  defaultIntervalMinutes: 60,
};

export function sanitizeSettings(raw: unknown): Settings {
  const value = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return {
    notifyChanges: typeof value.notifyChanges === 'boolean' ? value.notifyChanges : DEFAULT_SETTINGS.notifyChanges,
    notifyErrors: typeof value.notifyErrors === 'boolean' ? value.notifyErrors : DEFAULT_SETTINGS.notifyErrors,
    defaultIntervalMinutes: isInterval(value.defaultIntervalMinutes)
      ? value.defaultIntervalMinutes
      : DEFAULT_SETTINGS.defaultIntervalMinutes,
  };
}
