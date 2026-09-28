import { CONTENT_SCRIPT_TYPES, isBackgroundRequest, type BackgroundRequest } from '../platform/messages';
import { loadWatch, loadWatches, planChanged, serialized, SETTINGS_KEY, writeWatches } from '../storage/store';
import {
  accessGranted,
  accessRemoved,
  checkNow,
  completeAdd,
  createFromPicker,
  deleteWatch,
  finishOrphanedAdd,
  markSeenFor,
  openAboutPro,
  pauseOrResume,
  pickerClosed,
  updateOptions,
} from './actions';
import { reconcileAlarms, watchIdFromAlarm } from './alarms';
import { limiter, runCheck } from './checker';
import { setFetchTimeout } from './fetchPage';
import { flushHeld, parseNotificationId, QUIET_ALARM, QUIET_SUMMARY_ID, updateBadge } from './notify';

/** Browser start, install and update: make sure every active watch has its alarm and the badge is right. */
async function startup(): Promise<void> {
  const watches = await loadWatches();
  const moved = await reconcileAlarms(watches, Date.now(), Math.random);
  if (moved.size > 0) {
    await serialized(async () => {
      const latest = await loadWatches();
      await writeWatches(latest.map((watch) => (moved.has(watch.id) ? { ...watch, nextCheckAt: moved.get(watch.id)! } : watch)));
    });
  }
  await updateBadge(watches);
  await flushHeld();
}

async function onAlarm(alarm: chrome.alarms.Alarm): Promise<void> {
  if (alarm.name === QUIET_ALARM) {
    await flushHeld();
    return;
  }
  const id = watchIdFromAlarm(alarm.name);
  if (id) await runCheck(id, 'alarm');
}

async function onNotificationClicked(notificationId: string): Promise<void> {
  await chrome.notifications.clear(notificationId);
  if (notificationId === QUIET_SUMMARY_ID) {
    await chrome.action.openPopup().catch(() => undefined);
    return;
  }
  const target = parseNotificationId(notificationId);
  if (!target) return;
  const watch = await loadWatch(target.watchId);
  if (!watch) return;
  if (target.kind === 'change') {
    await markSeenFor(watch.id);
    await openInTab(watch.url);
    return;
  }
  // Errors are explained in the popup; fall back to the page if it can't be opened.
  try {
    await chrome.action.openPopup();
  } catch {
    await openInTab(watch.url);
  }
}

async function openInTab(url: string): Promise<void> {
  const tab = await chrome.tabs.create({ url });
  if (tab.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => undefined);
}

async function onPermissionsAdded(permissions: chrome.permissions.Permissions): Promise<void> {
  const origins = permissions.origins ?? [];
  if (origins.length === 0) return;
  // Give the popup a moment to finish the add itself; this only covers a popup the prompt closed.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  await finishOrphanedAdd(origins);
}

async function onPermissionsRemoved(permissions: chrome.permissions.Permissions): Promise<void> {
  const origins = permissions.origins ?? [];
  if (origins.length > 0) await accessRemoved(origins);
}

async function handleRequest(request: BackgroundRequest, sender: chrome.runtime.MessageSender): Promise<unknown> {
  switch (request.type) {
    case 'pw/complete-add':
      return completeAdd(request.pending);
    case 'pw/create':
      return createFromPicker(request.draft, sender.url);
    case 'pw/check-now':
      return checkNow(request.id);
    case 'pw/update':
      return updateOptions(request.id, request.patch);
    case 'pw/set-paused':
      return pauseOrResume(request.id, request.paused);
    case 'pw/delete':
      return deleteWatch(request.id);
    case 'pw/mark-seen':
      return markSeenFor(request.id);
    case 'pw/access-granted':
      return accessGranted(request.url);
    case 'pw/picker-closed':
      return pickerClosed(request.url, request.created);
    case 'pw/open-about-pro':
      return openAboutPro();
  }
}

function logError(context: string) {
  return (error: unknown) => console.error(`Page Watch: ${context}`, error);
}

// Listeners are registered synchronously at the top level so events wake the worker.
chrome.runtime.onInstalled.addListener(() => void startup().catch(logError('startup failed')));
chrome.runtime.onStartup.addListener(() => void startup().catch(logError('startup failed')));
chrome.alarms.onAlarm.addListener((alarm) => void onAlarm(alarm).catch(logError('scheduled check failed')));
chrome.notifications.onClicked.addListener((id) => void onNotificationClicked(id).catch(logError('notification click failed')));
chrome.permissions.onAdded.addListener((permissions) => void onPermissionsAdded(permissions).catch(logError('permission update failed')));
chrome.permissions.onRemoved.addListener((permissions) => void onPermissionsRemoved(permissions).catch(logError('permission update failed')));

// Quiet hours turned off or changed, or the plan changed: deliver what was held if it isn't quiet anymore.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (SETTINGS_KEY in changes || planChanged(changes))) void flushHeld().catch(logError('quiet hours update failed'));
});

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  // Only this extension's pages and its picker; no externally_connectable is declared.
  if (sender.id !== chrome.runtime.id || !isBackgroundRequest(message)) return false;
  const fromExtensionPage = sender.url?.startsWith(chrome.runtime.getURL('')) ?? false;
  if (!fromExtensionPage && (!CONTENT_SCRIPT_TYPES.has(message.type) || sender.frameId !== 0)) return false;
  handleRequest(message, sender)
    .then(sendResponse)
    .catch((error: unknown) => {
      console.error('Page Watch: request failed', error);
      sendResponse({ ok: false, code: 'internal', message: 'Something went wrong. Please try again.' });
    });
  return true;
});

if (__E2E__) {
  // Test-only hook: alarms can't be fast-forwarded and notifications can't be clicked from
  // automation, so the e2e suite calls the same handlers Chrome would. Compiled out of dist/.
  Object.assign(globalThis, {
    __pageWatchTest: {
      runCheck: (id: string) => runCheck(id, 'manual'),
      fireAlarm: (name: string) => onAlarm({ name, scheduledTime: Date.now(), persistAcrossSessions: true }),
      clickNotification: onNotificationClicked,
      permissionsAdded: onPermissionsAdded,
      permissionsRemoved: onPermissionsRemoved,
      startup,
      flushHeld,
      setFetchTimeout,
      queue: () => ({ active: limiter.active, queued: limiter.queued }),
    },
  });
}
