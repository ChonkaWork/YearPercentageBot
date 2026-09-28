import type { QuietHours } from './settings';

/**
 * Quiet hours (Pro): checks keep running, but change and error notifications are held and
 * delivered as one summary when the quiet hours end. Times are the browser's local time.
 */

const DAY_MINUTES = 24 * 60;
/** Held notifications kept at most (the oldest are dropped). */
export const MAX_HELD = 50;

/** Minutes since local midnight. */
export function minuteOfDay(date: Date): number {
  return date.getHours() * 60 + date.getMinutes();
}

/** Whether `minute` (since local midnight) falls in the quiet hours. Start == end means never. */
export function isQuietAt(quiet: QuietHours, minute: number): boolean {
  if (!quiet.enabled || quiet.start === quiet.end) return false;
  return quiet.start < quiet.end ? minute >= quiet.start && minute < quiet.end : minute >= quiet.start || minute < quiet.end;
}

/** Whole minutes from `minute` until the quiet hours end (at least 1). */
export function minutesUntilQuietEnds(quiet: QuietHours, minute: number): number {
  const diff = (quiet.end - minute + DAY_MINUTES) % DAY_MINUTES;
  return diff === 0 ? DAY_MINUTES : diff;
}

/** When the current quiet hours end, as a timestamp (at the start of that minute). */
export function quietEndsAt(quiet: QuietHours, now: Date): number {
  const startOfMinute = new Date(now);
  startOfMinute.setSeconds(0, 0);
  return startOfMinute.getTime() + minutesUntilQuietEnds(quiet, minuteOfDay(now)) * 60_000;
}

export interface HeldNotification {
  kind: 'change' | 'error';
  watchId: string;
  /** Watch name at the time. */
  name: string;
  /** Change summary or error label. */
  text: string;
  at: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function sanitizeHeld(raw: unknown): HeldNotification[] {
  if (!Array.isArray(raw)) return [];
  const held: HeldNotification[] = [];
  for (const item of raw) {
    if (!isRecord(item) || (item.kind !== 'change' && item.kind !== 'error') || typeof item.watchId !== 'string') continue;
    held.push({
      kind: item.kind,
      watchId: item.watchId.slice(0, 64),
      name: typeof item.name === 'string' ? item.name.slice(0, 120) : '',
      text: typeof item.text === 'string' ? item.text.slice(0, 300) : '',
      at: typeof item.at === 'number' && Number.isFinite(item.at) ? item.at : 0,
    });
  }
  return held.slice(-MAX_HELD);
}

export function holdNotification(held: readonly HeldNotification[], item: HeldNotification): HeldNotification[] {
  return [...held, item].slice(-MAX_HELD);
}

export interface WatchState {
  id: string;
  name: string;
  unseen: number;
  /** The watch still has a problem. */
  hasError: boolean;
}

export interface QuietSummary {
  title: string;
  message: string;
  /** One line per watch, most recent first. */
  items: { title: string; message: string }[];
}

function plural(count: number, word: string, many = `${word}s`): string {
  return `${count} ${count === 1 ? word : many}`;
}

/**
 * What to tell the user when quiet hours end. Changes already looked at (in the popup) and
 * problems that fixed themselves are left out; null when nothing is left.
 */
export function summarizeHeld(held: readonly HeldNotification[], watches: readonly WatchState[]): QuietSummary | null {
  const byId = new Map(watches.map((watch) => [watch.id, watch]));
  const perWatch = new Map<string, { name: string; changes: HeldNotification[]; error: HeldNotification | null; at: number }>();
  for (const item of held) {
    const watch = byId.get(item.watchId);
    if (!watch) continue;
    if (item.kind === 'change' && watch.unseen === 0) continue;
    if (item.kind === 'error' && !watch.hasError) continue;
    const entry = perWatch.get(item.watchId) ?? { name: watch.name, changes: [], error: null, at: 0 };
    if (item.kind === 'change') entry.changes.push(item);
    else entry.error = item;
    entry.at = Math.max(entry.at, item.at);
    perWatch.set(item.watchId, entry);
  }
  if (perWatch.size === 0) return null;

  const entries = [...perWatch.values()].sort((a, b) => b.at - a.at);
  const changeCount = entries.reduce((sum, entry) => sum + entry.changes.length, 0);
  const errorCount = entries.filter((entry) => entry.error).length;
  const parts: string[] = [];
  if (changeCount) parts.push(plural(changeCount, 'change'));
  if (errorCount) parts.push(`${plural(errorCount, 'problem')}`);
  const items = entries.map((entry) => {
    const latest = entry.changes[entry.changes.length - 1];
    const more = entry.changes.length > 1 ? ` (+${entry.changes.length - 1} more)` : '';
    const message = latest ? `${latest.text}${more}` : `${entry.error!.text}`;
    return { title: entry.name, message };
  });
  return {
    title: 'Page Watch: during quiet hours',
    message: `${parts.join(' and ')} on ${plural(entries.length, 'watch', 'watches')}`,
    items,
  };
}
