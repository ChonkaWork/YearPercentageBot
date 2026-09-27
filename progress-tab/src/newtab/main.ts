import { addCountdown, createCountdown, removeCountdown, updateCountdown, type Countdown } from '../core/countdown';
import { DEFAULT_SETTINGS, countdownDecimals, resolveHour12, sanitizeSettings, settingsEqual, type Settings } from '../core/settings';
import { PERIOD_KINDS } from '../core/time';
import { loadState, readCachedSettings, saveSettings, updateCountdowns, watchStorage, writeCachedSettings } from '../storage/store';
import { byId, errorMessage, h, setHidden } from '../ui/dom';
import { icon, mountIcons } from '../ui/icons';
import { CountdownSection } from './countdowns';
import { Clock, PeriodList } from './progress';
import { SettingsPanel, type SettingsPatch } from './settings-panel';
import { applyTheme, localeUses12h, onSystemSchemeChange } from './theme';
import { startTicker } from './ticker';
import { Toast } from './toast';

// This script runs from <head>, before the body exists and before the first paint. Apply the
// last known look right away (localStorage mirror), then build the page on DOMContentLoaded.
let settings: Settings = readCachedSettings() ?? sanitizeSettings(DEFAULT_SETTINGS);
applyTheme(settings);

function start(): void {
  mountIcons();

  const page = byId<HTMLElement>('page');
  const clockSection = byId<HTMLElement>('clock');
  const periodsCard = byId<HTMLElement>('periods');
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
      countdowns.setCountdowns(await updateCountdowns((list) => addCountdown(list, created)));
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
  }, toast);

  const panel = new SettingsPanel((patch) => changeSettings(patch));

  const tick = (now: Date) => {
    if (settings.widgets.clock) clock.update(now, hour12);
    periods.update(now, settings);
    if (settings.widgets.countdowns) countdowns.update(now, { hour12, decimals: countdownDecimals(settings.decimals) });
  };

  /** Shows `next` everywhere: theme, visible widgets, controls and every value. */
  function applySettings(next: Settings): void {
    settings = next;
    hour12 = resolveHour12(next.clock, localeUses12h());
    applyTheme(next);
    panel.render(next);
    const anyPeriod = PERIOD_KINDS.some((kind) => next.widgets[kind]);
    setHidden(clockSection, !next.widgets.clock);
    setHidden(periodsCard, !anyPeriod);
    setHidden(countdownsCard, !next.widgets.countdowns);
    setHidden(nothingShown, anyPeriod || next.widgets.countdowns || next.widgets.clock);
    page.classList.toggle('is-split', anyPeriod && next.widgets.countdowns);
    ticker?.tickNow();
  }

  function changeSettings(patch: SettingsPatch): void {
    const next = sanitizeSettings({ ...settings, ...patch, widgets: { ...settings.widgets, ...patch.widgets } });
    if (settingsEqual(next, settings)) return;
    applySettings(next);
    const version = ++saveVersion;
    pendingSaves++;
    saveSettings(next)
      .then((saved) => {
        persisted = saved;
        if (version === saveVersion) panel.showSaved();
      })
      .catch((error: unknown) => {
        // Only the latest change decides what is shown; an older failure is superseded.
        if (version !== saveVersion) return;
        applySettings(persisted);
        panel.showError(`Couldn’t save your settings: ${errorMessage(error)}. Nothing was changed; please try again.`);
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
      if (!settingsEqual(state.settings, settings)) applySettings(state.settings);
      countdowns.setCountdowns(state.countdowns);
    } catch (error) {
      const message = errorMessage(error);
      showPageError(`Couldn’t read your saved settings and countdowns (${message}). Showing defaults; open a new tab to try again.`);
      countdowns.setError(message);
    }
  }

  byId('show-settings').addEventListener('click', () => panel.open());
  onSystemSchemeChange(() => applyTheme(settings));
  watchStorage((change) => {
    // Another tab (or our own save) changed storage. While our own saves are in flight their
    // echoes would briefly undo newer local changes, so settings wait for those to finish.
    if (change.settings && pendingSaves === 0 && !settingsEqual(change.settings, settings)) {
      persisted = change.settings;
      writeCachedSettings(change.settings);
      applySettings(change.settings);
    }
    if (change.countdowns) countdowns.setCountdowns(change.countdowns);
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
