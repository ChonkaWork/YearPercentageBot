import { priceStatus } from '../core/compare';
import { readValue, recordValue, tracksValue } from '../core/history';
import { emptyNoise, LEARN_DELAY_MS } from '../core/noise';
import { parseTarget } from '../core/numbers';
import { canAddWatch, LIMIT_MESSAGE, planProblem } from '../core/plan';
import { choosePageBaseline, chooseElementBaseline, looksCollapsed, type Baseline } from '../core/creation';
import { checkError } from '../core/errors';
import { createLimiter } from '../core/limiter';
import { capSnapshot, normalizeText } from '../core/normalize';
import { nextCheckDelay } from '../core/schedule';
import type { Snapshot, Watch, WatchDraft } from '../core/types';
import { hostLabel } from '../core/url';
import { applyCheck, createWatch, MAX_WATCHES, type CheckApplied, type CheckOutcome } from '../core/watch';
import type { CreateResponse } from '../platform/messages';
import {
  changesKey,
  historyKey,
  isQuotaError,
  loadChanges,
  loadHistory,
  loadNoise,
  loadPlan,
  loadSnapshot,
  loadWatch,
  loadWatches,
  noiseKey,
  saveChecking,
  serialized,
  snapshotKey,
  writeWatches,
} from '../storage/store';
import { hasAccess } from './access';
import { clearAlarm, learnAlarmName, scheduleAlarm, scheduleLearn } from './alarms';
import { CheckFailure, fail, fetchPage } from './fetchPage';
import { notifyChange, notifyError, updateBadge } from './notify';
import { closeOffscreen, extractInOffscreen } from './offscreen';

/** At most two pages are fetched at the same time, whatever the number of watches. */
export const MAX_CONCURRENT_FETCHES = 2;
export const limiter = createLimiter(MAX_CONCURRENT_FETCHES);
limiter.onIdle(() => void closeOffscreen());

/** `learn`: the noise filter's second fetch, a few seconds after the watch was added. */
export type CheckReason = 'alarm' | 'manual' | 'resume' | 'access' | 'import' | 'learn';

/** Runs a check through the global queue. A watch already being checked isn't queued twice. */
export function runCheck(id: string, reason: CheckReason): Promise<Watch | null> {
  // The learning fetch has its own key: it must not be swallowed by a regular check in flight.
  return limiter.run(`${reason === 'learn' ? 'learn' : 'check'}:${id}`, () => performCheck(id, reason));
}

let learnDelayMs = LEARN_DELAY_MS;

/** e2e builds only: the learning fetch is triggered by the test instead of 10 seconds later. */
export function setLearnDelay(ms: number): void {
  learnDelayMs = ms;
}

/** Schedules the learning fetch for a watch whose baseline was just taken. */
async function startLearning(id: string): Promise<void> {
  if (await chrome.alarms.get(learnAlarmName(id))) return;
  await scheduleLearn(id, learnDelayMs);
}

const checking = new Map<string, number>();
async function markChecking(id: string, on: boolean): Promise<void> {
  if (on) checking.set(id, Date.now());
  else checking.delete(id);
  // Memory is the truth: checks don't outlive the worker, so older stored entries are stale.
  await saveChecking(Object.fromEntries(checking));
}

async function performCheck(id: string, reason: CheckReason): Promise<Watch | null> {
  const watch = await loadWatch(id);
  if (!watch) {
    await clearAlarm(id);
    return null;
  }
  if (watch.paused && (reason === 'alarm' || reason === 'learn')) return watch;
  if (reason === 'learn' && (await loadNoise(id)).phase !== 'pair') return watch;

  // The learning fetch runs quietly: no spinner in the popup.
  if (reason !== 'learn') await markChecking(id, true);
  let outcome: CheckOutcome;
  try {
    const previous = await loadSnapshot(id);
    outcome = await fetchAndExtract(watch, previous);
  } catch (error) {
    outcome = { ok: false, error: error instanceof CheckFailure ? error.error : checkError('internal') };
    if (!(error instanceof CheckFailure)) console.error('Page Watch: check failed unexpectedly', error);
  } finally {
    if (reason !== 'learn') await markChecking(id, false);
  }

  const applied = await saveOutcome(id, outcome, reason === 'learn');
  if (!applied) return null;
  await scheduleAlarm(applied.watch);
  // Imported watches take their baseline on the first check; then comes the learning fetch.
  if (reason !== 'learn' && applied.snapshot && (await loadNoise(id)).phase === 'pair') await startLearning(id);
  if (applied.change) {
    await updateBadge();
    await notifyChange(applied.watch, applied.change);
  }
  if (applied.notifyError) await notifyError(applied.watch);
  return applied.watch;
}

async function fetchAndExtract(watch: Watch, previous: Snapshot | null): Promise<CheckOutcome> {
  if (!(await hasAccess(watch.url))) throw fail('permission');
  const page = await fetchPage(watch.url);

  if (page.kind === 'text') {
    if (watch.selector) throw fail('not-html', { detail: 'It returns plain text, so the element you picked no longer exists.' });
    return { ok: true, ...capSnapshot(normalizeText(page.body)) };
  }

  const extracted = await extractInOffscreen(page.body, watch.selector ? [watch.selector] : null);
  if (!extracted.ok) throw fail('internal');
  if (watch.selector) {
    const result = extracted.results[0];
    if (!result || result.text === null) throw fail('selector');
    return { ok: true, text: result.text, truncated: result.truncated };
  }
  const text = extracted.page?.text ?? '';
  if (looksCollapsed(previous?.text ?? '', text)) throw fail('empty');
  return { ok: true, text, truncated: extracted.page?.truncated ?? false };
}

/**
 * Applies the outcome to the watch as it is *now* (the user may have paused or edited it
 * during the check) and stores watch, baseline and changes in one write.
 */
function saveOutcome(id: string, outcome: CheckOutcome, learn: boolean): Promise<CheckApplied | null> {
  return serialized(async () => {
    const watches = await loadWatches();
    const index = watches.findIndex((watch) => watch.id === id);
    if (index < 0) return null; // Deleted while checking.
    const [previous, changes, noise, history] = await Promise.all([loadSnapshot(id), loadChanges(id), loadNoise(id), loadHistory(id)]);
    const applied = applyCheck(
      watches[index]!,
      previous,
      changes,
      outcome,
      { now: Date.now(), random: Math.random, changeId: crypto.randomUUID() },
      { noise, history, learn },
    );
    watches[index] = applied.watch;
    const extra: Record<string, unknown> = { [changesKey(id)]: applied.changes };
    if (applied.snapshot) extra[snapshotKey(id)] = applied.snapshot;
    if (applied.noise) extra[noiseKey(id)] = applied.noise;
    if (applied.history) extra[historyKey(id)] = applied.history;
    try {
      await writeWatches(watches, extra);
    } catch (error) {
      if (!isQuotaError(error)) throw error;
      // Storage is full: keep the result but fewer old changes; if that isn't enough, say so.
      applied.changes = applied.changes.slice(0, 2);
      extra[changesKey(id)] = applied.changes;
      try {
        await writeWatches(watches, extra);
      } catch {
        applied.watch = {
          ...applied.watch,
          status: 'error',
          error: {
            code: 'internal',
            message: "Page Watch's storage in this browser is full. Delete watches you don't need, especially whole-page ones.",
            at: Date.now(),
          },
        };
        watches[index] = applied.watch;
        await writeWatches(watches);
        applied.change = null;
      }
    }
    return applied;
  });
}

// --- Creating a watch ------------------------------------------------------------------------

/**
 * Adds a watch: fetches the page once to make sure background checks can see what the user
 * picked (and nothing is saved if they can't), stores that as the baseline, schedules checks.
 */
export async function createFromDraft(draft: WatchDraft): Promise<CreateResponse> {
  const [plan, existing] = await Promise.all([loadPlan(), loadWatches()]);
  if (existing.length >= MAX_WATCHES) {
    return { ok: false, code: 'limit', message: `You can watch up to ${MAX_WATCHES} pages. Delete a watch to add another.` };
  }
  if (!canAddWatch(plan, existing.length)) return { ok: false, code: 'limit', message: LIMIT_MESSAGE };
  const problem = planProblem(plan, draft);
  if (problem) return { ok: false, code: 'limit', message: problem };
  if (!(await hasAccess(draft.url))) {
    return {
      ok: false,
      code: 'permission',
      message: `Page Watch needs access to ${hostLabel(draft.url)} to check it. Add the watch again and allow access when Chrome asks.`,
    };
  }

  const id = crypto.randomUUID();
  let baseline: Baseline & { title?: string };
  try {
    baseline = await limiter.run(`create:${id}`, () => fetchBaseline(draft));
  } catch (error) {
    const failure = error instanceof CheckFailure ? error.error : checkError('internal');
    if (!(error instanceof CheckFailure)) console.error('Page Watch: first check failed unexpectedly', error);
    return { ok: false, code: failure.code, message: failure.message };
  }
  if (!baseline.ok) return { ok: false, code: baseline.error.code, message: baseline.error.message };
  let note: string | undefined;
  if (draft.mode === 'below') {
    const status = priceStatus(baseline.text, draft.target);
    if (!status) {
      return {
        ok: false,
        code: 'invalid',
        message: `Page Watch couldn't find a price${parseTarget(draft.target)?.currency ? ' in that currency' : ''} in ${draft.selectors.length ? 'the part you picked' : 'this page'}. Pick the element that shows the price.`,
      };
    }
    note = status.below
      ? `It's already below ${draft.target} (${status.price.raw}). You'll be notified the next time it drops below after going back up.`
      : `Now ${status.price.raw}. You'll be notified when it drops below ${draft.target}.`;
  }
  if (draft.mode === 'lowest') {
    const value = readValue(baseline.text);
    if (!value) {
      return {
        ok: false,
        code: 'invalid',
        message: `Page Watch couldn't find a price or number in ${draft.selectors.length ? 'the part you picked' : 'this page'}. Pick the element that shows the price.`,
      };
    }
    note = `Now ${value.raw}. You'll be notified when it's the lowest in 30 days.`;
  }

  const now = Date.now();
  const watch: Watch = {
    ...createWatch(
      {
        url: draft.url,
        name: draft.name || baseline.title || hostLabel(draft.url),
        selector: baseline.selector,
        intervalMinutes: draft.intervalMinutes,
        mode: draft.mode,
        keyword: draft.keyword,
        target: draft.target,
      },
      id,
      now,
    ),
    status: 'unchanged',
    lastCheckedAt: now,
    nextCheckAt: now + nextCheckDelay(draft.intervalMinutes, 0, Math.random),
  };
  const snapshot: Snapshot = { text: baseline.text, at: now, truncated: baseline.truncated };
  const extra: Record<string, unknown> = { [snapshotKey(id)]: snapshot, [changesKey(id)]: [], [noiseKey(id)]: emptyNoise('pair') };
  // Number and price watches start their history with the value seen now.
  const value = tracksValue(watch, baseline.text) ? readValue(baseline.text) : null;
  if (value) extra[historyKey(id)] = recordValue([], { t: now, v: value.value, r: value.raw });

  try {
    const added = await serialized(async () => {
      const watches = await loadWatches();
      // Another add may have finished while this one was fetching.
      if (!canAddWatch(plan, watches.length) || watches.length >= MAX_WATCHES) return false;
      await writeWatches([watch, ...watches], extra);
      return true;
    });
    if (!added) return { ok: false, code: 'limit', message: LIMIT_MESSAGE };
  } catch (error) {
    const message = isQuotaError(error)
      ? "Page Watch's storage in this browser is full. Delete watches you don't need, then try again."
      : "Couldn't save the watch. Please try again.";
    return { ok: false, code: 'internal', message };
  }
  await scheduleAlarm(watch);
  // A second fetch a few seconds later shows what changes on every visit (the noise filter).
  await startLearning(id);
  return note ? { ok: true, watch, note } : { ok: true, watch };
}

async function fetchBaseline(draft: WatchDraft): Promise<Baseline & { title?: string }> {
  const page = await fetchPage(draft.url);
  const wantsElement = draft.selectors.length > 0;
  if (page.kind === 'text') {
    if (wantsElement) throw fail('not-html', { detail: 'It returns plain text, so there are no elements to watch.' });
    return choosePageBaseline(draft.liveText, capSnapshot(normalizeText(page.body)));
  }
  const extracted = await extractInOffscreen(page.body, wantsElement ? draft.selectors : null);
  if (!extracted.ok) throw fail('internal');
  const baseline = wantsElement
    ? chooseElementBaseline(draft.liveText, extracted.results)
    : choosePageBaseline(draft.liveText, extracted.page ?? { text: '', truncated: false });
  return { ...baseline, title: extracted.title };
}
