import {
  ALERT_CHOICE_TEXT,
  ALERT_CHOICES,
  choiceNeedsLevel,
  createAlertRule,
  defaultLevel,
  describeCondition,
  isAlertChoice,
  type AlertChoice,
  type AlertRule,
} from '../core/alerts';
import { alertLimit, can, planLimits, watchlistLimit, type Entitlements } from '../core/features';
import { formatAge, formatDateTime, formatFullDateTime, formatPrice } from '../core/format';
import { addToWatchlist, CHECK_PERIOD_MINUTES, marketKey, removeFromWatchlist, type Market, type MarketSnapshot, type MonitorState, type WatchItem } from '../core/monitor';
import { SIGNAL_TEXT } from '../core/signal';
import type { Interval } from '../core/types';
import { loadAlerts, loadMonitorState, loadSnapshots, loadWatchlist, updateAlerts, updateWatchlist } from '../storage/store';
import { h } from '../ui/dom';
import { icon } from '../ui/icons';
import { proBadge, renderNotice, toneOfSignal } from './render';
import { coinBadge, subviewHeader } from './views';

/**
 * Alerts and watchlist (Pro). Alerts are created for the market shown on the main screen and
 * checked by the service worker (src/background/monitor.ts) on a chrome.alarms schedule. Every
 * alert describes an indicator event; nothing here says buy or sell.
 */

export interface AlertsViewOptions {
  /** The market on the main screen: new alerts and "Watch" use it. */
  market: Market;
  /** Quote and price of the live result on the main screen, if any (for labels and defaults). */
  quote: string | null;
  price: number | null;
  entitlements: Entitlements;
  onOpen: (symbol: string, interval: Interval) => void;
  onAboutPro: () => void;
  onBack: () => void;
}

interface Data {
  rules: AlertRule[];
  watchlist: WatchItem[];
  snapshots: Record<string, MarketSnapshot>;
  monitor: MonitorState;
  error: boolean;
}

async function loadData(): Promise<Data> {
  const [rules, watchlist, snapshots, monitor] = await Promise.all([
    loadAlerts().catch(() => null),
    loadWatchlist().catch(() => null),
    loadSnapshots(),
    loadMonitorState(),
  ]);
  return { rules: rules ?? [], watchlist: watchlist ?? [], snapshots, monitor, error: rules === null || watchlist === null };
}

export async function mountAlerts(container: HTMLElement, options: AlertsViewOptions): Promise<void> {
  const allowAlerts = can('alerts', options.entitlements);
  const allowWatchlist = can('watchlist', options.entitlements);
  const maxAlerts = alertLimit(options.entitlements) || planLimits('pro').alerts;
  const maxWatch = watchlistLimit(options.entitlements) || planLimits('pro').watchlist;
  const proBadges = options.entitlements.policy === 'early-access';
  const { symbol, interval } = options.market;
  const pair = options.quote ? `${symbol}/${options.quote}` : symbol;
  let data = await loadData();

  // --- Watchlist ---------------------------------------------------------------------------
  const watchCount = h('span', { class: 'count', attrs: { id: 'watch-count' } });
  const watchList = h('ul', { class: 'watch-list', attrs: { id: 'watch-list', 'aria-label': 'Watchlist' } });
  const watchEmpty = h('p', { class: 'help', attrs: { id: 'watch-empty' }, text: 'Watch coins to see their last signal here. They refresh with the background checks.' });
  const watchStatus = h('p', { class: 'form-status', attrs: { id: 'watch-status', role: 'status' } });
  const watchButton = h('button', { class: 'btn btn-sm btn-outline-light btn-with-icon', attrs: { type: 'button', id: 'watch-add' } });
  const checkButton = h('button', { class: 'btn btn-sm btn-link px-1', attrs: { type: 'button', id: 'check-now', title: 'Check alerts and watched coins now' } }, 'Check now');

  // --- New alert form ---------------------------------------------------------------------
  const choice = h(
    'select',
    { class: 'form-select form-select-sm', attrs: { id: 'alert-choice', 'aria-label': 'Condition', disabled: !allowAlerts } },
    ...ALERT_CHOICES.map((value) => h('option', { text: ALERT_CHOICE_TEXT[value], attrs: { value, selected: value === 'turns-bearish' } })),
  );
  const level = h('input', {
    class: 'form-control form-control-sm num',
    attrs: { id: 'alert-level', type: 'number', inputmode: 'decimal', min: '0', step: 'any', 'aria-label': 'Level', disabled: !allowAlerts },
  });
  const levelUnit = h('span', { class: 'level-unit', attrs: { id: 'alert-level-unit' } });
  const levelGroup = h('div', { class: 'level-group' }, level, levelUnit);
  const create = h('button', { class: 'btn btn-sm btn-primary btn-with-icon', attrs: { type: 'submit', id: 'alert-create', disabled: !allowAlerts } }, icon('plus', { size: 12 }), 'Create alert');
  const formStatus = h('p', { class: 'form-status', attrs: { id: 'alert-status', role: 'status' } });
  const form = h(
    'form',
    { class: 'alert-form', attrs: { id: 'alert-form', novalidate: true } },
    h('div', { class: 'alert-form-market' }, coinBadge(symbol, true), h('span', { class: 'fw-bold', text: pair }), h('span', { class: 'interval-chip', text: interval }), h('span', { class: 'help ms-auto m-0', text: 'Change it on the main screen' })),
    h('div', { class: 'alert-form-row' }, choice, levelGroup),
    h('div', { class: 'd-flex align-items-center gap-2' }, create, formStatus),
  );

  const syncLevel = () => {
    const value = isAlertChoice(choice.value) ? choice.value : 'signal-changed';
    const needs = choiceNeedsLevel(value);
    levelGroup.hidden = needs === null;
    levelUnit.textContent = needs === 'rsi' ? 'RSI' : (options.quote ?? '');
    const start = defaultLevel(value, options.price);
    level.value = start === null ? '' : String(start);
    level.setAttribute('aria-label', needs === 'rsi' ? 'RSI level' : 'Price');
    level.max = needs === 'rsi' ? '99' : '';
  };
  choice.addEventListener('change', syncLevel);
  syncLevel();

  // --- Alert list -------------------------------------------------------------------------
  const alertCount = h('span', { class: 'count', attrs: { id: 'alert-count' } });
  const alertList = h('ul', { class: 'alert-list', attrs: { id: 'alert-list', 'aria-label': 'Your alerts' } });
  const alertEmpty = h('p', { class: 'help', attrs: { id: 'alert-empty' }, text: 'No alerts yet. Create one above; it is checked in the background.' });
  const runNote = h('p', { class: 'help', attrs: { id: 'run-note' } });

  let statusTimer: number | undefined;
  const say = (target: HTMLElement, text: string, error = false) => {
    target.textContent = text;
    target.classList.toggle('is-error', error);
    window.clearTimeout(statusTimer);
    if (!error) statusTimer = window.setTimeout(() => (target.textContent = ''), 2500);
  };

  const render = () => {
    // Watchlist
    watchCount.textContent = `${data.watchlist.length}/${maxWatch}`;
    watchList.replaceChildren(...data.watchlist.map(watchRow));
    watchList.hidden = data.watchlist.length === 0;
    watchEmpty.hidden = data.watchlist.length > 0;
    const watching = data.watchlist.some((item) => marketKey(item) === marketKey(options.market));
    watchButton.replaceChildren(icon(watching ? 'starFill' : 'star', { size: 12 }), watching ? `Watching ${symbol} ${interval}` : `Watch ${symbol} ${interval}`);
    watchButton.disabled = watching || !allowWatchlist || data.watchlist.length >= maxWatch;
    checkButton.hidden = !(allowAlerts || allowWatchlist) || (data.watchlist.length === 0 && !data.rules.some((rule) => rule.enabled));

    // Alerts
    alertCount.textContent = `${data.rules.length}/${maxAlerts}`;
    alertList.replaceChildren(...data.rules.map(alertRow));
    alertList.hidden = data.rules.length === 0;
    alertEmpty.hidden = data.rules.length > 0;
    create.disabled = !allowAlerts || data.rules.length >= maxAlerts;

    const monitor = data.monitor;
    runNote.textContent = [
      `Checked in the background about every ${CHECK_PERIOD_MINUTES} minutes while Chrome is running, with the same cache and rate limits as the popup.`,
      monitor.lastRunAt ? `Last check: ${formatAge(monitor.lastRunAt)}${monitor.lastProblem ? ` (${monitor.lastProblem})` : ''}.` : '',
      'Alerts describe indicator events. They are not trading advice.',
    ]
      .filter(Boolean)
      .join(' ');
  };

  const watchRow = (item: WatchItem): HTMLElement => {
    const snapshot = data.snapshots[marketKey(item)];
    const label = `${item.symbol} ${item.interval}`;
    const main = snapshot
      ? h(
          'span',
          { class: `watch-main tone-${toneOfSignal(snapshot.signal)}` },
          h('span', { class: 'd-block' }, h('span', { class: 'watch-pair', text: `${item.symbol}/${snapshot.quote}` }), h('span', { class: 'interval-chip', text: item.interval })),
          h('span', { class: 'watch-signal', text: `${SIGNAL_TEXT[snapshot.signal]} · ${snapshot.strength}%` }),
        )
      : h(
          'span',
          { class: 'watch-main' },
          h('span', { class: 'd-block' }, h('span', { class: 'watch-pair', text: item.symbol }), h('span', { class: 'interval-chip', text: item.interval })),
          h('span', { class: 'watch-signal text-body-secondary', text: 'No signal yet' }),
        );
    const side = snapshot
      ? h(
          'span',
          { class: 'watch-side' },
          h('span', { class: 'watch-price d-block', text: formatPrice(snapshot.price) }),
          h('span', { class: 'watch-time', text: formatAge(snapshot.at), attrs: { title: `Data from ${formatFullDateTime(snapshot.at)}` } }),
        )
      : h('span', { class: 'watch-side' });
    return h(
      'li',
      { class: 'watch-item', attrs: { 'data-market': marketKey(item) } },
      h(
        'button',
        { class: 'watch-open', attrs: { type: 'button', 'aria-label': `Analyze ${label}`, title: `Analyze ${label}` }, on: { click: () => options.onOpen(item.symbol, item.interval) } },
        coinBadge(item.symbol, true),
        main,
        side,
      ),
      h(
        'button',
        {
          class: 'btn btn-icon',
          attrs: { type: 'button', 'aria-label': `Remove ${label} from the watchlist`, title: 'Remove' },
          on: {
            click: async () => {
              data.watchlist = await updateWatchlist((items) => removeFromWatchlist(items, item));
              render();
            },
          },
        },
        icon('x', { size: 12 }),
      ),
    );
  };

  const alertRow = (rule: AlertRule): HTMLElement => {
    const description = describeCondition(rule.condition);
    const trigger = data.monitor.triggers[rule.id];
    const paused = !rule.enabled || !allowAlerts;
    const status = !allowAlerts
      ? 'Paused on the Free plan'
      : !rule.enabled
        ? 'Paused'
        : trigger
          ? `Active · last triggered ${formatDateTime(trigger.at)}`
          : 'Active';
    const label = `${rule.symbol} ${rule.interval}: ${description}`;
    return h(
      'li',
      { class: `alert-item${paused ? ' is-paused' : ''}`, attrs: { 'data-id': rule.id } },
      h('span', { class: 'alert-icon' }, icon(paused ? 'bell' : 'bellFill', { size: 13 })),
      h(
        'span',
        { class: 'alert-main' },
        h('span', { class: 'd-block' }, h('span', { class: 'alert-market', text: rule.symbol }), h('span', { class: 'interval-chip', text: rule.interval }), h('span', { class: 'alert-text', text: description })),
        h('span', { class: 'alert-status', text: status, attrs: { title: trigger ? trigger.message : '' } }),
      ),
      h(
        'button',
        {
          class: 'btn btn-icon alert-toggle',
          attrs: { type: 'button', 'aria-label': `${rule.enabled ? 'Pause' : 'Resume'} ${label}`, title: rule.enabled ? 'Pause' : 'Resume', disabled: !allowAlerts },
          on: {
            click: async () => {
              const now = Date.now();
              data.rules = await updateAlerts((rules) =>
                rules.map((candidate) => (candidate.id === rule.id ? { ...candidate, enabled: !candidate.enabled, since: candidate.enabled ? candidate.since : now } : candidate)),
              );
              render();
            },
          },
        },
        icon(rule.enabled ? 'pause' : 'play', { size: 14 }),
      ),
      h(
        'button',
        {
          class: 'btn btn-icon',
          attrs: { type: 'button', 'aria-label': `Delete ${label}`, title: 'Delete' },
          on: {
            click: async () => {
              data.rules = await updateAlerts((rules) => rules.filter((candidate) => candidate.id !== rule.id));
              render();
            },
          },
        },
        icon('x', { size: 12 }),
      ),
    );
  };

  // --- Actions ----------------------------------------------------------------------------
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const value: AlertChoice = isAlertChoice(choice.value) ? choice.value : 'signal-changed';
    const needs = choiceNeedsLevel(value);
    const parsed = needs ? Number.parseFloat(level.value.replace(',', '.')) : null;
    let failure: string | null = null;
    try {
      data.rules = await updateAlerts((rules) => {
        const result = createAlertRule({ symbol, interval, choice: value, level: parsed }, rules, alertLimit(options.entitlements), crypto.randomUUID(), Date.now());
        if (!result.ok) {
          failure = result.error;
          return rules;
        }
        return [...rules, result.rule];
      });
    } catch {
      failure = "Couldn't save the alert. Try again.";
    }
    render();
    if (failure) say(formStatus, failure, true);
    else say(formStatus, 'Alert created');
  });

  watchButton.addEventListener('click', async () => {
    let failure: string | null = null;
    try {
      data.watchlist = await updateWatchlist((items) => {
        const result = addToWatchlist(items, options.market, watchlistLimit(options.entitlements), Date.now());
        if (!result.ok) {
          failure = result.error;
          return items;
        }
        return result.items;
      });
    } catch {
      failure = "Couldn't save the watchlist. Try again.";
    }
    render();
    if (failure) say(watchStatus, failure, true);
  });

  checkButton.addEventListener('click', async () => {
    checkButton.disabled = true;
    say(watchStatus, 'Checking…');
    try {
      const summary = (await chrome.runtime.sendMessage({ type: 'check-now' })) as { status: string; checked: number; notified: number; reason?: string } | null;
      data = await loadData();
      render();
      if (!summary) say(watchStatus, "Couldn't check right now.", true);
      else if (summary.reason === 'too-soon') say(watchStatus, 'Checked moments ago.');
      else say(watchStatus, `Checked ${summary.checked} market${summary.checked === 1 ? '' : 's'}${summary.notified ? `, ${summary.notified} alert${summary.notified === 1 ? '' : 's'} triggered` : ''}.`);
    } catch {
      say(watchStatus, "Couldn't check right now.", true);
    } finally {
      checkButton.disabled = false;
    }
  });

  // --- Layout -----------------------------------------------------------------------------
  const locked =
    !allowAlerts || !allowWatchlist
      ? renderNotice({
          kind: 'info',
          icon: 'lock',
          id: 'alerts-locked',
          body: [
            h('strong', { text: 'Background alerts and the watchlist are part of Pro.' }),
            data.rules.length || data.watchlist.length ? ' Yours are kept and paused while you preview the Free plan.' : ' You are previewing the Free plan limits.',
          ],
          action: { label: 'About Pro', id: 'alerts-about-pro', onClick: options.onAboutPro },
        })
      : null;

  container.replaceChildren(
    subviewHeader('Alerts & watchlist', options.onBack, proBadges ? proBadge('Alerts and the watchlist are part of Pro later. Free during early access.') : null),
    ...(locked ? [locked] : []),
    data.error ? renderNotice({ kind: 'caution', icon: 'exclamationTriangle', body: ["Alerts couldn't be read from browser storage."] }) : h('span', { attrs: { hidden: true } }),
    h(
      'section',
      { class: 'settings-section', attrs: { 'aria-labelledby': 'watch-heading' } },
      h('div', { class: 'section-head' }, h('h2', { class: 'section-label', attrs: { id: 'watch-heading' }, text: 'Watchlist' }), watchCount, checkButton),
      watchList,
      watchEmpty,
      h('div', { class: 'd-flex align-items-center gap-2 mt-2' }, watchButton, watchStatus),
    ),
    h('section', { class: 'settings-section', attrs: { 'aria-labelledby': 'new-alert-heading' } }, h('h2', { class: 'section-label', attrs: { id: 'new-alert-heading' }, text: 'New alert' }), form),
    h(
      'section',
      { class: 'settings-section', attrs: { 'aria-labelledby': 'alerts-heading' } },
      h('div', { class: 'section-head' }, h('h2', { class: 'section-label', attrs: { id: 'alerts-heading' }, text: 'Your alerts' }), alertCount),
      alertList,
      alertEmpty,
      runNote,
    ),
  );
  render();
}
