import { addCountdown, createCountdown, removeCountdown, updateCountdown, type Countdown } from '../core/countdown';
import { EARLY_ACCESS, countdownLimitMessage, hasFeature, limitsFor, type Plan } from '../core/plan';
import {
  DEFAULT_SETTINGS,
  applyEntitlements,
  countdownDecimals,
  decimalsFor,
  resolveHour12,
  sanitizeSettings,
  settingsEqual,
  type Settings,
} from '../core/settings';
import { PERIOD_KINDS } from '../core/time';
import {
  loadState,
  readCachedPlan,
  readCachedSettings,
  saveSettings,
  updateCountdowns,
  watchStorage,
  writeCachedPlan,
  writeCachedSettings,
} from '../storage/store';
import { byId, errorMessage, h, setHidden } from '../ui/dom';
import { icon, mountIcons } from '../ui/icons';
import { CountdownSection } from './countdowns';
import { LifeWeeks } from './life-weeks';
import { Clock, PeriodList } from './progress';
import { SettingsPanel, type SettingsPatch } from './settings-panel';
import { applyTheme, localeUses12h, onSystemSchemeChange } from './theme';
import { startTicker } from './ticker';
import { Toast } from './toast';

/**
 * The e2e build can turn early access off (localStorage flag set by the test) to exercise the
 * free plan; the production build compiles this down to EARLY_ACCESS.
 */
function e2eEarlyAccess(): boolean {
  try {
    return localStorage.getItem('progress-tab:e2e-early-access') !== 'off';
  } catch {
    return EARLY_ACCESS;
  }
}
const earlyAccess: boolean = __E2E__ ? e2eEarlyAccess() : EARLY_ACCESS;

// This script runs from <head>, before the body exists and before the first paint. Apply the
// last known look right away (localStorage mirror), then build the page on DOMContentLoaded.
/** What the user chose (and what is stored). */
let settings: Settings = readCachedSettings() ?? sanitizeSettings(DEFAULT_SETTINGS);
let plan: Plan = readCachedPlan();
/** What is shown: `settings` minus Pro choices the plan doesn't include. */
let visible: Settings = applyEntitlements(settings, plan, earlyAccess);
applyTheme(visible);

function start(): void {
  mountIcons();

  const page = byId<HTMLElement>('page');
  const clockSection = byId<HTMLElement>('clock');
  const periodsCard = byId<HTMLElement>('periods');
  const layoutMain = byId<HTMLElement>('layout-main');
  const lifeCard = byId<HTMLElement>('life');
  const countdownsCard = byId<HTMLElement>('countdowns');
  const nothingShown = byId<HTMLElement>('nothing-shown');
  const pageAlert = byId<HTMLDivElement>('page-alert');

  const clock = new Clock(byId('clock-time'), byId('clock-date'));
  const periods = new PeriodList(byId<HTMLUListElement>('period-list'));
  let hour12 = resolveHour12(settings.clock, localeUses12h());
  /** Last settings known to be in storage; the UI falls back to these when a save fails. */
  let persisted = settings;
  let saveVersion = 0;
  let pendingSaves = 0;

  const toast = new Toast(() => countdowns.focusAdd());
  const countdowns = new CountdownSection(countdownsCard, byId('countdown-body'), byId<HTMLButtonElement>('add-countdown'), {
    add: async (fields) => {
      const created = createCountdown(fields, crypto.randomUUID(), Date.now());
      const { maxCountdowns } = limitsFor(plan, earlyAccess);
      countdowns.setCountdowns(await updateCountdowns((list) => addCountdown(list, created, maxCountdowns, countdownLimitMessage(plan, earlyAccess))));
      return created;
    },
    update: async (id, fields) => {
      const list = await updateCountdowns((current) => {
        if (!current.some((countdown) => countdown.id === id)) throw new Error('it no longer exists (deleted in another tab?)');
        return updateCountdown(current, id, fields);
      });
      countdowns.setCountdowns(list);
    },
    remove: async (id) => {
      let removed: Countdown | undefined;
      const list = await updateCountdowns((current) => {
        removed = current.find((countdown) => countdown.id === id);
        return removeCountdown(current, id);
      });
      countdowns.setCountdowns(list);
      if (!removed) throw new Error('it was already deleted');
      return removed;
    },
    restore: async (countdown) => {
      countdowns.setCountdowns(await updateCountdowns((list) => addCountdown(list, countdown)));
    },
    reload: () => void load(),
    aboutPro: () => panel.showAboutPro(),
  }, toast);

  const panel = new SettingsPanel((patch) => void changeSettings(patch));
  const life = new LifeWeeks((next) => changeSettings({ life: next }));

  const tick = (now: Date) => {
    if (visible.widgets.clock) clock.update(now, hour12);
    periods.update(now, visible);
    if (visible.widgets.countdowns) countdowns.update(now, { hour12, decimals: countdownDecimals(visible.decimals) });
    if (visible.widgets.lifeWeeks) life.update(now, visible.life, decimalsFor('year', visible.decimals));
  };

  /** Shows `next` everywhere: theme, visible widgets, controls and every value. */
  function applySettings(next: Settings): void {
    settings = next;
    const shown = applyEntitlements(next, plan, earlyAccess);
    visible = shown;
    hour12 = resolveHour12(shown.clock, localeUses12h());
    applyTheme(shown);
    life.invalidateColors();
    panel.render(shown);
    panel.renderPlan({ plan, earlyAccess });
    countdowns.setLimit({
      max: limitsFor(plan, earlyAccess).maxCountdowns,
      message: countdownLimitMessage(plan, earlyAccess),
      upgradable: !hasFeature(plan, 'unlimited-countdowns', earlyAccess),
    });
    const anyPeriod = PERIOD_KINDS.some((kind) => shown.widgets[kind]);
    const main = anyPeriod || shown.widgets.lifeWeeks;
    setHidden(clockSection, !shown.widgets.clock);
    setHidden(periodsCard, !anyPeriod);
    setHidden(lifeCard, !shown.widgets.lifeWeeks);
    setHidden(layoutMain, !main);
    setHidden(countdownsCard, !shown.widgets.countdowns);
    setHidden(nothingShown, main || shown.widgets.countdowns || shown.widgets.clock);
    page.classList.toggle('is-split', main && shown.widgets.countdowns);
    ticker?.tickNow();
  }

  function setPlan(next: Plan): void {
    writeCachedPlan(next);
    if (next === plan) return;
    plan = next;
    applySettings(settings);
  }

  /** Applies and saves a change; resolves false (after rolling back) when it couldn't be saved. */
  function changeSettings(patch: SettingsPatch): Promise<boolean> {
    const next = sanitizeSettings({ ...settings, ...patch, widgets: { ...settings.widgets, ...patch.widgets } });
    if (settingsEqual(next, settings)) return Promise.resolve(true);
    applySettings(next);
    const version = ++saveVersion;
    pendingSaves++;
    return saveSettings(next)
      .then((saved) => {
        persisted = saved;
        if (version === saveVersion) panel.showSaved();
        return true;
      })
      .catch((error: unknown) => {
        // Only the latest change decides what is shown; an older failure is superseded.
        if (version !== saveVersion) return false;
        applySettings(persisted);
        panel.showError(`Couldn’t save your settings: ${errorMessage(error)}. Nothing was changed; please try again.`);
        return false;
      })
      .finally(() => pendingSaves--);
  }

  function showPageError(message: string | null): void {
    pageAlert.replaceChildren(...(message ? [icon('exclamationTriangleFill'), h('span', { text: message })] : []));
    setHidden(pageAlert, !message);
  }

  async function load(): Promise<void> {
    countdowns.setLoading();
    try {
      const state = await loadState();
      showPageError(null);
      persisted = state.settings;
      writeCachedSettings(state.settings);
      writeCachedPlan(state.plan);
      if (state.plan !== plan) {
        plan = state.plan;
        applySettings(state.settings);
      } else if (!settingsEqual(state.settings, settings)) applySettings(state.settings);
      countdowns.setCountdowns(state.countdowns);
    } catch (error) {
      const message = errorMessage(error);
      showPageError(`Couldn’t read your saved settings and countdowns (${message}). Showing defaults; open a new tab to try again.`);
      countdowns.setError(message);
    }
  }

  byId('show-settings').addEventListener('click', () => panel.open());
  onSystemSchemeChange(() => {
    applyTheme(visible);
    life.invalidateColors();
  });
  watchStorage((change) => {
    // Another tab (or our own save) changed storage. While our own saves are in flight their
    // echoes would briefly undo newer local changes, so settings wait for those to finish.
    if (change.settings && pendingSaves === 0 && !settingsEqual(change.settings, settings)) {
      persisted = change.settings;
      writeCachedSettings(change.settings);
      applySettings(change.settings);
    }
    if (change.countdowns) countdowns.setCountdowns(change.countdowns);
    if (change.plan) setPlan(change.plan);
  });

  // First paint: everything below renders synchronously from the cached (or default) settings.
  let ticker: ReturnType<typeof startTicker> | undefined;
  applySettings(settings);
  ticker = startTicker(tick);
  performance.mark('progress-tab:rendered');
  void load();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
else start();
