import { checkError } from '../core/errors';
import { emptyNoise, noisyLineCount, removeRules } from '../core/noise';
import { parseTarget } from '../core/numbers';
import { allowedInterval, canAddWatch, isEarlyAccess, LIMIT_MESSAGE, limitsFor, planProblem } from '../core/plan';
import { catchUpDelay } from '../core/schedule';
import { planImport, validateImported, importSummary, type ExportedWatch, type ImportResult } from '../core/transfer';
import { isInterval, type Watch } from '../core/types';
import { originOf } from '../core/url';
import { applyPatch, createWatch, markSeen, setPaused, TARGET_MESSAGE, validateDraft, validatePatch } from '../core/watch';
import type { CompleteAddResponse, CreateResponse, ImportResponse, PendingAdd, PickerStartMessage, SimpleResponse } from '../platform/messages';
import {
  changesKey,
  clearPendingAdd,
  loadChanges,
  loadNoise,
  loadPendingAdd,
  loadPlan,
  loadSettings,
  loadWatch,
  loadWatches,
  noiseKey,
  removeWatchData,
  serialized,
  updateWatch,
  writeWatches,
} from '../storage/store';
import { hasAccess, patternMatcher, releaseAccessIfUnused, watchesForPatterns } from './access';
import { clearAlarm, scheduleAlarm } from './alarms';
import { createFromDraft, runCheck } from './checker';
import { changeNotificationId, clearNotifications, updateBadge } from './notify';

const NOT_FOUND: SimpleResponse = { ok: false, code: 'invalid', message: 'This watch no longer exists.' };

export async function checkNow(id: string): Promise<SimpleResponse> {
  if (!(await loadWatch(id))) return NOT_FOUND;
  // Runs in the background; the popup follows progress through storage.
  void runCheck(id, 'manual').catch((error: unknown) => console.error('Page Watch: check failed', error));
  return { ok: true };
}

export async function updateOptions(id: string, rawPatch: unknown): Promise<SimpleResponse> {
  const validated = validatePatch(rawPatch);
  if (!validated.ok) return { ok: false, code: 'invalid', message: validated.message };
  const patch = validated.value;
  const [current, plan] = await Promise.all([loadWatch(id), loadPlan()]);
  if (!current) return NOT_FOUND;
  if ((patch.mode ?? current.mode) === 'keyword' && !(patch.keyword ?? current.keyword)) {
    return { ok: false, code: 'invalid', message: 'Enter the keyword to look for.' };
  }
  if ((patch.mode ?? current.mode) === 'below' && !parseTarget(patch.target ?? current.target)) {
    return { ok: false, code: 'invalid', message: TARGET_MESSAGE };
  }
  // A watch's current rule and interval stay allowed on any plan; only new Pro choices need Pro.
  const problem = planProblem(plan, patch, current);
  if (problem) return { ok: false, code: 'limit', message: problem };
  const watch = await updateWatch(id, (existing) => applyPatch(existing, patch, Date.now(), Math.random));
  if (!watch) return NOT_FOUND;
  await scheduleAlarm(watch);
  return { ok: true };
}

export async function pauseOrResume(id: string, paused: boolean): Promise<SimpleResponse> {
  const watch = await updateWatch(id, (existing) => setPaused(existing, paused, Date.now(), Math.random));
  if (!watch) return NOT_FOUND;
  await scheduleAlarm(watch);
  if (!paused) void runCheck(id, 'resume').catch((error: unknown) => console.error('Page Watch: check failed', error));
  return { ok: true };
}

export async function deleteWatch(id: string): Promise<SimpleResponse> {
  const removed = await serialized(async () => {
    const watches = await loadWatches();
    const target = watches.find((watch) => watch.id === id);
    if (!target) return null;
    const rest = watches.filter((watch) => watch.id !== id);
    await writeWatches(rest);
    await removeWatchData(id);
    return { target, rest };
  });
  if (!removed) return NOT_FOUND;
  await clearAlarm(id);
  await clearNotifications(id);
  await updateBadge(removed.rest);
  await releaseAccessIfUnused(removed.target.url, removed.rest);
  return { ok: true };
}

/** Marks one watch's changes (or every watch's, for null) as seen. */
export async function markSeenFor(id: string | null): Promise<SimpleResponse> {
  const ids = await serialized(async () => {
    const watches = await loadWatches();
    const targets = watches.filter((watch) => (id === null ? watch.unseen > 0 : watch.id === id));
    if (targets.length === 0) return [];
    const extra: Record<string, unknown> = {};
    for (const target of targets) {
      const result = markSeen(target, await loadChanges(target.id));
      watches[watches.indexOf(target)] = result.watch;
      extra[changesKey(target.id)] = result.changes;
    }
    await writeWatches(watches, extra);
    return targets.map((target) => target.id);
  });
  await updateBadge();
  await Promise.all(ids.map((watchId) => chrome.notifications.clear(changeNotificationId(watchId)).catch(() => false)));
  return { ok: true };
}

/** "Watch this line again": the noise rule stops applying; the line counts again from the next check. */
export async function unignore(id: string, ruleId: string): Promise<SimpleResponse> {
  const done = await serialized(async () => {
    const watches = await loadWatches();
    const index = watches.findIndex((watch) => watch.id === id);
    if (index < 0) return false;
    const noise = removeRules(await loadNoise(id), ruleId);
    watches[index] = { ...watches[index]!, noisyLines: noisyLineCount(noise.rules) };
    await writeWatches(watches, { [noiseKey(id)]: noise });
    return true;
  });
  return done ? { ok: true } : NOT_FOUND;
}

/**
 * Adds watches from an import file. Entries are validated again, duplicates and what the plan
 * doesn't allow are handled like in the preview, and sites Page Watch has no access to are
 * left out (the options page asks for access first). Each new watch takes its baseline with a
 * first check right away, then learns its noise like a watch added by hand.
 */
export async function importWatches(entries: readonly unknown[]): Promise<ImportResponse> {
  const valid: ExportedWatch[] = [];
  let invalid = 0;
  for (const entry of entries.slice(0, 1000)) {
    const result = validateImported(entry);
    if (result.ok) valid.push(result.value);
    else invalid++;
  }
  const plan = await loadPlan();
  const accessible: ExportedWatch[] = [];
  let noAccess = 0;
  for (const entry of valid) {
    if (await hasAccess(entry.url)) accessible.push(entry);
    else noAccess++;
  }

  const created = await serialized(async () => {
    const watches = await loadWatches();
    const planned = planImport(accessible, watches, plan);
    const now = Date.now();
    const added: Watch[] = planned.add.map((entry, index) => {
      const watch = createWatch(entry, crypto.randomUUID(), now - index);
      return {
        ...watch,
        paused: entry.paused,
        sound: entry.sound,
        nextCheckAt: entry.paused ? null : now + catchUpDelay(Math.random, index),
      };
    });
    const extra: Record<string, unknown> = {};
    for (const watch of added) {
      extra[changesKey(watch.id)] = [];
      extra[noiseKey(watch.id)] = emptyNoise('pair');
    }
    if (added.length > 0) await writeWatches([...added, ...watches], extra);
    return { added, planned };
  });

  for (const watch of created.added) {
    await scheduleAlarm(watch);
    // The first check takes the baseline (queued, at most two at a time).
    if (!watch.paused) void runCheck(watch.id, 'import').catch((error: unknown) => console.error('Page Watch: check failed', error));
  }
  const result: ImportResult = {
    added: created.added.length,
    duplicates: created.planned.duplicates,
    adapted: created.planned.adapted,
    overLimit: created.planned.overLimit,
    invalid,
    noAccess,
  };
  return { ok: true, result, summary: importSummary(result, plan) };
}

/** Access to a site was granted again: re-check its watches so their error clears. */
export async function accessGranted(url: string): Promise<SimpleResponse> {
  if (!(await hasAccess(url))) return { ok: false, code: 'permission', message: 'Access was not granted.' };
  const origin = originOf(url);
  const watches = (await loadWatches()).filter((watch) => originOf(watch.url) === origin);
  for (const watch of watches) void runCheck(watch.id, 'access').catch(() => undefined);
  return { ok: true };
}

/** Access was removed (in chrome://extensions or the options page): show it on the affected watches right away. */
export async function accessRemoved(patterns: readonly string[]): Promise<void> {
  const affected = watchesForPatterns(await loadWatches(), patterns);
  for (const watch of affected) {
    if (await hasAccess(watch.url)) continue;
    await updateWatch(watch.id, (existing) => ({
      ...existing,
      status: 'error',
      error: { ...checkError('permission'), at: Date.now() },
    }));
  }
}

export async function pickerClosed(url: string, created: boolean): Promise<SimpleResponse> {
  // The site's access was requested for this picker; give it back if nothing uses it.
  if (!created) await releaseAccessIfUnused(url, await loadWatches());
  return { ok: true };
}

export async function createFromPicker(rawDraft: unknown, senderUrl: string | undefined): Promise<CreateResponse> {
  const validated = validateDraft(rawDraft);
  if (!validated.ok) return { ok: false, code: 'invalid', message: validated.message };
  // A page can only add a watch for itself.
  if (!senderUrl || originOf(senderUrl) !== originOf(validated.value.url)) {
    return { ok: false, code: 'invalid', message: 'The picked element belongs to a different page.' };
  }
  return createFromDraft(validated.value);
}

// --- Adding from the popup ----------------------------------------------------------------

export async function startPicker(tabId: number): Promise<CompleteAddResponse> {
  const [plan, watches] = await Promise.all([loadPlan(), loadWatches()]);
  if (!canAddWatch(plan, watches.length)) return { ok: false, code: 'limit', message: LIMIT_MESSAGE };
  try {
    const [tab, settings] = await Promise.all([chrome.tabs.get(tabId), loadSettings()]);
    await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ['picker.js'] });
    const minimum = limitsFor(plan).minIntervalMinutes;
    const message: PickerStartMessage = {
      type: 'pw/picker-start',
      title: tab.title ?? '',
      intervalMinutes: allowedInterval(plan, settings.defaultIntervalMinutes, isInterval(minimum) ? minimum : 60),
      plan,
    };
    if (__E2E__) message.earlyAccess = isEarlyAccess();
    await chrome.tabs.sendMessage(tabId, message, { frameId: 0 });
    return { ok: true, picker: true };
  } catch {
    return {
      ok: false,
      code: 'unavailable',
      message: "The element picker can't run on this page. Reload the page and try again, or watch the whole page.",
    };
  }
}

/** "About Pro" on the options page, from the popup or the picker. */
export async function openAboutPro(): Promise<SimpleResponse> {
  await chrome.tabs.create({ url: chrome.runtime.getURL('options.html#about-pro') });
  return { ok: true };
}

const completing = new Map<string, Promise<CompleteAddResponse>>();

/**
 * Finishes an add that waited for the permission prompt. Called by the popup once the prompt
 * resolves, and by permissions.onAdded in case the prompt closed the popup. Both callers
 * share one run.
 */
export function completeAdd(pending: PendingAdd): Promise<CompleteAddResponse> {
  let run = completing.get(pending.id);
  if (!run) {
    run = doCompleteAdd(pending).finally(() => {
      void clearPendingAdd(pending.id);
      setTimeout(() => completing.delete(pending.id), 60_000);
    });
    completing.set(pending.id, run);
  }
  return run;
}

async function doCompleteAdd(pending: PendingAdd): Promise<CompleteAddResponse> {
  if (!(await hasAccess(pending.url))) {
    return { ok: false, code: 'permission', message: 'Page Watch needs access to this site to watch it.' };
  }
  if (pending.kind === 'pick') return startPicker(pending.tabId);
  const validated = validateDraft(pending.draft);
  if (!validated.ok) return { ok: false, code: 'invalid', message: validated.message };
  const response = await createFromDraft(validated.value);
  if (!response.ok) await releaseAccessIfUnused(pending.url, await loadWatches());
  return response;
}

/**
 * The permission prompt can close the popup before it hears back. If the popup didn't pick up
 * its pending add shortly after access was granted, finish it here and tell the user.
 */
export async function finishOrphanedAdd(origins: readonly string[]): Promise<void> {
  const pending = await loadPendingAdd();
  if (!pending || !origins.some((pattern) => patternMatcher(pattern)(pending.url))) return;
  const alreadyRunning = completing.has(pending.id);
  const response = await completeAdd(pending);
  if (alreadyRunning || pending.kind !== 'page') return;
  await chrome.notifications
    .create(`added:${pending.id}`, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: response.ok ? 'Page Watch' : "Couldn't add the watch",
      message: response.ok ? `Now watching “${response.watch?.name ?? pending.url}”.` : response.message,
      priority: 0,
    })
    .catch(() => undefined);
}
