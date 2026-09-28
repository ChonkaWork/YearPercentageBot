import { errorLabel } from '../core/errors';
import { hasFeature } from '../core/plan';
import { holdNotification, isQuietAt, minuteOfDay, quietEndsAt, summarizeHeld, type HeldNotification } from '../core/quiet';
import type { Settings } from '../core/settings';
import type { Change, Watch } from '../core/types';
import { shortUrl } from '../core/url';
import { totalUnseen } from '../core/watch';
import type { ChimeResponse } from '../platform/messages';
import { loadHeld, loadPlan, loadSettings, loadWatches, saveHeld, serialized } from '../storage/store';
import { chimeInOffscreen } from './offscreen';

export const BRAND_COLOR = '#e03131';
const CHANGE_PREFIX = 'change:';
const ERROR_PREFIX = 'error:';
export const QUIET_SUMMARY_ID = 'quiet-summary';
export const QUIET_ALARM = 'quiet-end';

export function changeNotificationId(watchId: string): string {
  return `${CHANGE_PREFIX}${watchId}`;
}

export function errorNotificationId(watchId: string): string {
  return `${ERROR_PREFIX}${watchId}`;
}

/** Which watch a notification belongs to, and what it's about. */
export function parseNotificationId(id: string): { kind: 'change' | 'error'; watchId: string } | null {
  if (id.startsWith(CHANGE_PREFIX)) return { kind: 'change', watchId: id.slice(CHANGE_PREFIX.length) };
  if (id.startsWith(ERROR_PREFIX)) return { kind: 'error', watchId: id.slice(ERROR_PREFIX.length) };
  return null;
}

/** One notification per watch: a newer change replaces the previous one instead of piling up. */
export async function notifyChange(watch: Watch, change: Change): Promise<void> {
  const settings = await loadSettings();
  if (!settings.notifyChanges) return;
  if (await holdIfQuiet(settings, { kind: 'change', watchId: watch.id, name: watch.name, text: change.summary, at: change.at })) return;
  const unseen = watch.unseen > 1 ? ` (${watch.unseen} unseen changes)` : '';
  await createNotification(changeNotificationId(watch.id), {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title: watch.name,
    message: change.summary,
    contextMessage: `${shortUrl(watch.url)}${unseen}`,
    priority: 1,
  });
  if (settings.sound && watch.sound) await chime(watch.id);
}

/** e2e builds only: every chime played, with the AudioContext state it played in. */
export const chimeLog: { watchId: string | null; response: ChimeResponse }[] = [];

/** The alert sound, off by default (Settings → Play a sound). A failure only costs the sound. */
async function chime(watchId: string | null): Promise<void> {
  try {
    const response = await chimeInOffscreen();
    if (__E2E__) chimeLog.push({ watchId, response });
    if (!response.ok) console.warn('Page Watch: could not play the sound', response.message);
  } catch (error) {
    console.warn('Page Watch: could not play the sound', error);
  }
}

export async function notifyError(watch: Watch): Promise<void> {
  const settings = await loadSettings();
  if (!watch.error || !settings.notifyErrors) return;
  if (await holdIfQuiet(settings, { kind: 'error', watchId: watch.id, name: watch.name, text: errorLabel(watch.error), at: watch.error.at })) return;
  await createNotification(errorNotificationId(watch.id), {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title: `${watch.name}: ${errorLabel(watch.error)}`,
    message: watch.error.message,
    contextMessage: shortUrl(watch.url),
    priority: 0,
  });
}

async function createNotification(id: string, options: chrome.notifications.NotificationCreateOptions): Promise<void> {
  try {
    // Clearing first makes Chrome show the replacement again instead of silently updating it.
    await chrome.notifications.clear(id);
    await chrome.notifications.create(id, options);
  } catch (error) {
    // Notifications can be blocked at the OS level; the badge and the popup still show the change.
    console.warn('Page Watch: could not show a notification', error);
  }
}

export async function clearNotifications(watchId: string): Promise<void> {
  await Promise.all([
    chrome.notifications.clear(changeNotificationId(watchId)).catch(() => false),
    chrome.notifications.clear(errorNotificationId(watchId)).catch(() => false),
  ]);
}

// --- Quiet hours (Pro) -------------------------------------------------------------------------

/** Quiet hours are on (and part of the plan) and it's quiet right now. */
export async function isQuietNow(settings?: Settings, now = new Date()): Promise<boolean> {
  const { quietHours } = settings ?? (await loadSettings());
  if (!quietHours.enabled || !isQuietAt(quietHours, minuteOfDay(now))) return false;
  return hasFeature(await loadPlan(), 'quiet-hours');
}

// Held notifications are read-modify-written by checks that finish together.
let heldQueue: Promise<unknown> = Promise.resolve();
function inOrder<T>(task: () => Promise<T>): Promise<T> {
  const run = heldQueue.then(task, task);
  heldQueue = run.catch(() => undefined);
  return run;
}

/** During quiet hours, keeps the notification for the summary instead of showing it. */
async function holdIfQuiet(settings: Settings, item: HeldNotification): Promise<boolean> {
  const now = new Date();
  if (!(await isQuietNow(settings, now))) return false;
  await inOrder(async () => saveHeld(holdNotification(await loadHeld(), item)));
  await chrome.alarms.create(QUIET_ALARM, { when: Math.max(quietEndsAt(settings.quietHours, now), Date.now() + 1000) });
  return true;
}

/**
 * Delivers what was held once it isn't quiet anymore (quiet hours ended, were turned off, or
 * the plan no longer includes them): one summary notification. While still quiet, makes sure
 * the alarm for the end of quiet hours exists.
 */
export async function flushHeld(): Promise<void> {
  const settings = await loadSettings();
  const now = new Date();
  if (await isQuietNow(settings, now)) {
    if ((await loadHeld()).length > 0 && !(await chrome.alarms.get(QUIET_ALARM))) {
      await chrome.alarms.create(QUIET_ALARM, { when: quietEndsAt(settings.quietHours, now) });
    }
    return;
  }
  await chrome.alarms.clear(QUIET_ALARM);
  const held = await inOrder(async () => {
    const items = await loadHeld();
    if (items.length > 0) await saveHeld([]);
    return items;
  });
  if (held.length === 0) return;
  const watches = await serialized(() => loadWatches());
  const summary = summarizeHeld(
    held.filter((item) => (item.kind === 'change' ? settings.notifyChanges : settings.notifyErrors)),
    watches.map((watch) => ({ id: watch.id, name: watch.name, unseen: watch.unseen, hasError: watch.error !== null })),
  );
  if (!summary) return;
  await createNotification(QUIET_SUMMARY_ID, {
    type: 'list',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title: summary.title,
    message: summary.message,
    items: summary.items.slice(0, 5),
    contextMessage: summary.message,
    priority: 1,
  });
  // One chime for the summary, if a watch with changes in it has sound on.
  const withSound = new Set(watches.filter((watch) => watch.sound).map((watch) => watch.id));
  if (settings.sound && held.some((item) => item.kind === 'change' && withSound.has(item.watchId))) await chime(null);
}

/** Toolbar badge: number of unseen changes across all watches. */
export async function updateBadge(watches?: Watch[]): Promise<void> {
  const count = totalUnseen(watches ?? (await loadWatches()));
  await chrome.action.setBadgeBackgroundColor({ color: BRAND_COLOR });
  if (chrome.action.setBadgeTextColor) await chrome.action.setBadgeTextColor({ color: '#ffffff' });
  await chrome.action.setBadgeText({ text: count === 0 ? '' : count > 99 ? '99+' : String(count) });
  await chrome.action.setTitle({ title: count ? `Page Watch: ${count} unseen change${count === 1 ? '' : 's'}` : 'Page Watch' });
}
