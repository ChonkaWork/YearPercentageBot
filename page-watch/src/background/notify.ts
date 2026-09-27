import { errorLabel } from '../core/errors';
import type { Change, Watch } from '../core/types';
import { shortUrl } from '../core/url';
import { totalUnseen } from '../core/watch';
import { loadSettings, loadWatches } from '../storage/store';

export const BRAND_COLOR = '#e03131';
const CHANGE_PREFIX = 'change:';
const ERROR_PREFIX = 'error:';

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
  if (!(await loadSettings()).notifyChanges) return;
  const unseen = watch.unseen > 1 ? ` (${watch.unseen} unseen changes)` : '';
  await createNotification(changeNotificationId(watch.id), {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title: watch.name,
    message: change.summary,
    contextMessage: `${shortUrl(watch.url)}${unseen}`,
    priority: 1,
  });
}

export async function notifyError(watch: Watch): Promise<void> {
  if (!watch.error || !(await loadSettings()).notifyErrors) return;
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

/** Toolbar badge: number of unseen changes across all watches. */
export async function updateBadge(watches?: Watch[]): Promise<void> {
  const count = totalUnseen(watches ?? (await loadWatches()));
  await chrome.action.setBadgeBackgroundColor({ color: BRAND_COLOR });
  if (chrome.action.setBadgeTextColor) await chrome.action.setBadgeTextColor({ color: '#ffffff' });
  await chrome.action.setBadgeText({ text: count === 0 ? '' : count > 99 ? '99+' : String(count) });
  await chrome.action.setTitle({ title: count ? `Page Watch: ${count} unseen change${count === 1 ? '' : 's'}` : 'Page Watch' });
}
