import '../styles/options.scss';

import { ALERT_ALARM, ALERT_PERIOD_MINUTES, isBackingOff, MAX_MARKETS_PER_CHECK, type AlertCheckState } from '../core/alertCheck';
import { describeAlertSettings, hasActiveAlerts } from '../core/alerts';
import { formatClock, relativeTime } from '../core/format';
import { EARLY_ACCESS, effectivePlan, FREE_INCLUDES, hasFeature, PRO_FEATURE_INFO, PRO_FEATURES, PRO_PRICE, type Plan } from '../core/plan';
import type { WatchItem } from '../core/saved';
import { loadAlertCheckState, loadEarlyAccess, loadPlan, loadWatchlist, STORAGE_KEYS } from '../storage/store';
import { byId, h } from '../ui/dom';
import { icon, logo } from '../ui/icons';

/**
 * Options page: the status of background alerts and the "About Pro" card (docs/MONETIZATION.md).
 * Alert thresholds are set per market in the popup's watchlist (the bell on each item).
 */

const main = byId<HTMLElement>('main');

function proBadge(): HTMLElement {
  return h('span', { class: 'pro-badge', text: 'PRO', attrs: { title: EARLY_ACCESS ? 'Pro feature, free during early access' : 'Pro feature' } });
}

function untilText(at: number, now: number): string {
  const minutes = Math.ceil((at - now) / 60_000);
  return minutes <= 1 ? 'in a minute' : `in ${minutes} min`;
}

function planLabel(stored: Plan, earlyAccess: boolean): string {
  if (earlyAccess) return 'Early access: every Pro feature is on';
  return stored === 'pro' ? 'Pro' : 'Free';
}

function alertsCard(plan: Plan, items: WatchItem[], state: AlertCheckState, nextAt: number | null, now: number): HTMLElement {
  const allowed = hasFeature(plan, 'alerts');
  const withAlerts = items.filter((item) => hasActiveAlerts(item.alertSettings));
  const body = h('div', { class: 'card-body d-grid gap-3' });

  if (!allowed) {
    body.append(h('p', { class: 'mb-0 text-body-secondary', text: 'Background alerts are part of Pro. See About Pro below.' }));
  } else {
    body.append(
      h('p', {
        class: 'mb-0 text-body-secondary',
        text: `Chrome checks watchlist markets with alerts on every ${ALERT_PERIOD_MINUTES} minutes while it is running (up to ${MAX_MARKETS_PER_CHECK} markets per check) and shows a notification with the market and the numbers. Set the rules with the bell on each market in the popup's Watchlist.`,
      }),
    );
    const lastRun = state.lastRunAt
      ? `${relativeTime(state.lastRunAt, now)} · ${state.checked} checked · ${state.notified} ${state.notified === 1 ? 'notification' : 'notifications'}${state.failed ? ` · ${state.failed} failed` : ''}`
      : 'Not yet';
    const rows: [string, string][] = [
      ['Markets with alerts', `${withAlerts.length} of ${items.length}`],
      ['Last check', lastRun],
      ['Next check', withAlerts.length && nextAt ? `${formatClock(nextAt)} (${untilText(nextAt, now)})` : withAlerts.length ? 'Scheduled' : 'None: no market has alerts on'],
    ];
    body.append(
      h('dl', { class: 'status-grid', attrs: { 'data-alert-status': '' } }, ...rows.flatMap(([term, value]) => [h('dt', { text: term }), h('dd', { text: value })])),
    );
    if (isBackingOff(state, now) && state.backoffUntil) {
      body.append(
        h(
          'div',
          { class: 'alert alert-warning mb-0 small d-flex gap-2', attrs: { role: 'status' } },
          icon('hourglassSplit', 'mt-1'),
          h('span', { text: `Polymarket is limiting requests, so checks pause until ${formatClock(state.backoffUntil)}.` }),
        ),
      );
    } else if (state.lastError && state.failed) {
      body.append(h('div', { class: 'small text-warning', text: `Last problem: ${state.lastError}.` }));
    }
    if (withAlerts.length) {
      body.append(
        h(
          'ul',
          { class: 'list-group', attrs: { 'data-alert-markets': '' } },
          ...withAlerts.map((item) =>
            h(
              'li',
              { class: 'list-group-item d-flex flex-column' },
              h('span', { class: 'fw-semibold text-body-emphasis', text: item.title }),
              h('span', { class: 'small text-body-secondary', text: `${item.outcome} · ${describeAlertSettings(item.alertSettings)}` }),
            ),
          ),
        ),
      );
    }
  }

  return h(
    'section',
    { class: 'card', attrs: { id: 'alerts', 'aria-labelledby': 'alerts-title' } },
    h('div', { class: 'card-header d-flex align-items-center gap-2 py-3' }, icon('bell'), h('h2', { class: 'h6 mb-0', text: 'Background alerts', attrs: { id: 'alerts-title' } }), proBadge()),
    body,
  );
}

function aboutProCard(stored: Plan, earlyAccess: boolean): HTMLElement {
  const getPro = h('button', {
    class: 'btn btn-primary',
    text: 'Get Pro',
    attrs: { type: 'button', 'data-action': 'get-pro', 'aria-describedby': 'pro-note' },
  });
  // Payments aren't set up: during early access everyone already has Pro.
  getPro.disabled = true;

  return h(
    'section',
    { class: 'card', attrs: { id: 'pro', 'aria-labelledby': 'pro-title', 'data-section': 'about-pro' } },
    h(
      'div',
      { class: 'card-header d-flex align-items-center gap-2 py-3' },
      h('h2', { class: 'h6 mb-0', text: 'About Pro', attrs: { id: 'pro-title' } }),
      earlyAccess ? h('span', { class: 'badge text-bg-success ms-auto', text: 'Free during early access', attrs: { 'data-badge': 'early-access' } }) : null,
    ),
    h(
      'div',
      { class: 'card-body d-grid gap-4' },
      h(
        'div',
        { class: 'd-flex align-items-end gap-3 flex-wrap' },
        h('div', {}, h('div', { class: 'price num', text: PRO_PRICE, attrs: { 'data-value': 'price' } }), h('div', { class: 'small text-body-secondary', text: 'One-time payment. No subscription, no account.' })),
        h('div', { class: 'ms-auto d-grid gap-1 text-end' }, getPro, h('span', { class: 'small text-body-secondary', text: earlyAccess ? 'Free during early access' : 'Payments are not set up yet', attrs: { id: 'pro-note' } })),
      ),
      h(
        'div',
        {},
        h('div', { class: 'section-label mb-2', text: 'Pro adds' }),
        h(
          'ul',
          { class: 'feature-list', attrs: { 'data-list': 'pro' } },
          ...PRO_FEATURES.map((feature) =>
            h('li', {}, icon('check2'), h('div', {}, h('div', { class: 'fw-semibold text-body-emphasis', text: PRO_FEATURE_INFO[feature].title }), h('div', { class: 'small text-body-secondary', text: PRO_FEATURE_INFO[feature].text }))),
          ),
        ),
      ),
      h(
        'div',
        {},
        h('div', { class: 'section-label mb-2', text: 'Free includes' }),
        h('ul', { class: 'feature-list', attrs: { 'data-list': 'free' } }, ...FREE_INCLUDES.map((text) => h('li', {}, icon('check2'), h('div', { class: 'small', text })))),
      ),
      h(
        'p',
        { class: 'small text-body-secondary mb-0' },
        'Your plan: ',
        h('strong', { class: 'text-body-emphasis', text: planLabel(stored, earlyAccess), attrs: { 'data-value': 'plan' } }),
        '. Your watchlist and history stay in this browser whatever the plan; nothing is ever deleted when a limit applies.',
      ),
    ),
  );
}

async function render(): Promise<void> {
  const [stored, earlyAccess, items, state, alarm] = await Promise.all([
    loadPlan(),
    loadEarlyAccess(),
    loadWatchlist(),
    loadAlertCheckState(),
    chrome.alarms.get(ALERT_ALARM).catch(() => undefined),
  ]);
  const plan = effectivePlan(stored, earlyAccess);
  main.replaceChildren(alertsCard(plan, items, state, alarm?.scheduledTime ?? null, Date.now()), aboutProCard(stored, earlyAccess));
  if (location.hash === '#pro') document.getElementById('pro')?.scrollIntoView();
}

byId<HTMLElement>('brand').prepend(logo(22));
void render();
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (STORAGE_KEYS.watchlist in changes || STORAGE_KEYS.plan in changes || STORAGE_KEYS.alertCheck in changes)) void render();
});
