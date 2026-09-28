import { sanitizeAllowlist, type AllowedChannel } from './channels';
import { MAX_ALLOWLIST } from './plan';
import { DEFAULT_SCHEDULE, sanitizeSchedule, type Schedule } from './schedule';

/** Distractions the free version can hide, each with its own switch. */
export type Feature = 'shorts' | 'home' | 'comments' | 'related' | 'endscreen';

export const FEATURES: readonly Feature[] = ['shorts', 'home', 'related', 'endscreen', 'comments'];

export const FEATURE_LABELS: Readonly<Record<Feature, { title: string; text: string }>> = {
  shorts: { title: 'Shorts', text: 'Shelves, the Shorts tab, and Shorts in search and subscriptions' },
  home: { title: 'Home feed', text: 'Recommendations on the home page' },
  related: { title: 'Up next', text: 'Recommended videos next to the player' },
  endscreen: { title: 'End screens', text: 'Cards and suggested videos over the player' },
  comments: { title: 'Comments', text: 'The comment section under videos' },
};

/** What the home page shows while its feed is hidden. */
export type HomeMode = 'calm' | 'subscriptions';

export interface Settings {
  /** Master switch. */
  enabled: boolean;
  hide: Record<Feature, boolean>;
  homeMode: HomeMode;
  /** Focus is paused until this time (epoch ms); 0 when not paused. */
  pausedUntil: number;
  /** Pro: on only during these hours. */
  schedule: Schedule;
  /** Pro: channels whose videos keep comments, Up next and end screens. */
  allowlist: AllowedChannel[];
  /** Pro: hide everything but subscriptions and search. */
  subscriptionsOnly: boolean;
}

export const PAUSE_MINUTES = 15;
/** A pause longer than this is treated as corrupt (e.g. the clock jumped) and ignored. */
export const MAX_PAUSE_MS = 24 * 60 * 60_000;

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  enabled: true,
  // Comments are often useful (tutorials, fixes), so they stay visible until switched off.
  hide: { shorts: true, home: true, related: true, endscreen: true, comments: false },
  homeMode: 'calm',
  pausedUntil: 0,
  schedule: { ...DEFAULT_SCHEDULE, days: [...DEFAULT_SCHEDULE.days] },
  allowlist: [],
  subscriptionsOnly: false,
});

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function sanitizeHide(raw: unknown): Record<Feature, boolean> {
  const input = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const hide = { ...DEFAULT_SETTINGS.hide };
  for (const feature of FEATURES) hide[feature] = bool(input[feature], DEFAULT_SETTINGS.hide[feature]);
  return hide;
}

function sanitizePausedUntil(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

/** Accepts anything read from storage and returns valid settings, falling back per field. */
export function sanitizeSettings(raw: unknown): Settings {
  const input = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  return {
    enabled: bool(input.enabled, DEFAULT_SETTINGS.enabled),
    hide: sanitizeHide(input.hide),
    homeMode: input.homeMode === 'subscriptions' ? 'subscriptions' : 'calm',
    pausedUntil: sanitizePausedUntil(input.pausedUntil),
    schedule: sanitizeSchedule(input.schedule),
    allowlist: sanitizeAllowlist(input.allowlist, MAX_ALLOWLIST),
    subscriptionsOnly: bool(input.subscriptionsOnly, DEFAULT_SETTINGS.subscriptionsOnly),
  };
}

/** Paused right now (a pause more than a day ahead is ignored as corrupt). */
export function isPaused(settings: Settings, now: number): boolean {
  return settings.pausedUntil > now && settings.pausedUntil - now <= MAX_PAUSE_MS;
}

export function pauseUntil(now: number, minutes = PAUSE_MINUTES): number {
  return now + minutes * 60_000;
}
