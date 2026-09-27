import { catchUpDelay } from '../core/schedule';
import type { Watch } from '../core/types';

/**
 * One alarm per watch, set for its next check. Alarms survive service worker restarts; they
 * are reconciled on browser start and install/update in case Chrome dropped them.
 */

const PREFIX = 'watch:';

export function alarmName(watchId: string): string {
  return `${PREFIX}${watchId}`;
}

export function watchIdFromAlarm(name: string): string | null {
  return name.startsWith(PREFIX) ? name.slice(PREFIX.length) : null;
}

export async function scheduleAlarm(watch: Watch): Promise<void> {
  if (watch.paused || watch.nextCheckAt === null) {
    await chrome.alarms.clear(alarmName(watch.id));
    return;
  }
  await chrome.alarms.create(alarmName(watch.id), { when: Math.max(watch.nextCheckAt, Date.now() + 1000) });
}

export async function clearAlarm(watchId: string): Promise<void> {
  await chrome.alarms.clear(alarmName(watchId));
}

/**
 * Makes the alarms match the watches: removes leftovers, re-creates missing ones. Overdue
 * checks (the browser was closed) are spread over the next few minutes. Returns the watches
 * whose next check time moved.
 */
export async function reconcileAlarms(watches: readonly Watch[], now: number, random: () => number): Promise<Map<string, number>> {
  const alarms = await chrome.alarms.getAll();
  const existing = new Set(alarms.map((alarm) => alarm.name));
  const active = new Set(watches.filter((watch) => !watch.paused).map((watch) => alarmName(watch.id)));

  for (const alarm of alarms) {
    if (alarm.name.startsWith(PREFIX) && !active.has(alarm.name)) await chrome.alarms.clear(alarm.name);
  }

  const moved = new Map<string, number>();
  let overdue = 0;
  for (const watch of watches) {
    if (watch.paused || existing.has(alarmName(watch.id))) continue;
    const when = watch.nextCheckAt !== null && watch.nextCheckAt > now ? watch.nextCheckAt : now + catchUpDelay(random, overdue++);
    await chrome.alarms.create(alarmName(watch.id), { when });
    if (when !== watch.nextCheckAt) moved.set(watch.id, when);
  }
  return moved;
}
