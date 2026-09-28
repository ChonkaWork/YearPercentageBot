import '../styles/popup.scss';
import { assetName, DEFAULT_SYMBOL } from '../core/assets';
import { createExplanationService } from '../core/explain';
import { toAlertSnapshot } from '../core/alerts';
import {
  can,
  canUseCoin,
  canUseTimeframe,
  entitlementsFor,
  historyLimit,
  isProTimeframe,
  planLimits,
  remainingAnalyses,
  type Entitlements,
  type Plan,
} from '../core/features';
import { formatAge, formatDuration, formatFullDateTime } from '../core/format';
import type { HistoryEntry } from '../core/history';
import { DEFAULT_SETTINGS, type Settings } from '../core/settings';
import { analyze, SIGNAL_TEXT } from '../core/signal';
import { INTERVALS, PROVIDER_NAMES, type Interval, type ProviderId } from '../core/types';
import { BinanceProvider } from '../data/binance';
import { CoinbaseProvider } from '../data/coinbase';
import { isAbortError, MarketDataError } from '../data/errors';
import { MarketService, type ProviderAttempt } from '../data/market';
import {
  addHistoryEntry,
  clearHistory,
  deleteHistoryEntry,
  loadHistory,
  loadPlan,
  loadSettings,
  loadUiState,
  loadUsage,
  recordAnalysis,
  recordSnapshots,
  saveSettings,
  saveUiState,
  sessionStore,
  takePendingAnalysis,
} from '../storage/store';
import { byId, h } from '../ui/dom';
import { icon } from '../ui/icons';
import { logo } from './logo';
import { attemptRows, describeError, shortReason } from './messages';
import { detectFromActiveTab } from './page';
import { renderNotice, renderResult, renderSkeleton, renderStateCard, type StateAction } from './render';
import { mountAlerts } from './alerts-view';
import { coinGlyph, mountHistory, mountSearch, mountSettings } from './views';

// --- Setup ------------------------------------------------------------------------------

type View = 'main' | 'search' | 'history' | 'settings' | 'alerts';

type Screen =
  | { kind: 'loading' }
  | { kind: 'result'; entry: HistoryEntry; mode: 'live' | 'stale' | 'snapshot'; error: MarketDataError | null; attempts: ProviderAttempt[]; retryAt: number | null }
  | { kind: 'error'; error: MarketDataError; attempts: ProviderAttempt[]; retryAt: number | null }
  | { kind: 'no-analysis'; reason: 'insufficient-data' | 'invalid-data'; got: number; needed: number; source: ProviderId }
  | { kind: 'locked'; reason: 'coin' | 'timeframe' | 'daily-limit' };

type Origin = { kind: 'page'; host: string | null } | { kind: 'selection'; text: string } | { kind: 'alert'; text: string | null } | null;

/** Rows the Free plan preview hides (see core/features.ts "advancedIndicators"). */
const ADVANCED_INDICATORS = ['momentum', 'volume'] as const;

/** Live data older than this is marked stale even without an error (popup left open). */
const STALE_AFTER_MS = 5 * 60 * 1000;

const market = new MarketService({ providers: [new BinanceProvider(), new CoinbaseProvider()], store: sessionStore });
const explainer = createExplanationService();

const els = {
  brand: byId<HTMLDivElement>('brand'),
  alerts: byId<HTMLButtonElement>('btn-alerts'),
  history: byId<HTMLButtonElement>('btn-history'),
  refresh: byId<HTMLButtonElement>('btn-refresh'),
  settings: byId<HTMLButtonElement>('btn-settings'),
  main: byId<HTMLElement>('view-main'),
  search: byId<HTMLElement>('view-search'),
  historyView: byId<HTMLElement>('view-history'),
  settingsView: byId<HTMLElement>('view-settings'),
  alertsView: byId<HTMLElement>('view-alerts'),
  assetButton: byId<HTMLButtonElement>('asset-button'),
  coinBadge: byId<HTMLSpanElement>('coin-badge'),
  pair: byId<HTMLSpanElement>('pair'),
  assetName: byId<HTMLSpanElement>('asset-name'),
  timeframes: byId<HTMLDivElement>('timeframes'),
  notices: byId<HTMLDivElement>('notices'),
  content: byId<HTMLDivElement>('content'),
  live: byId<HTMLDivElement>('live'),
  updated: byId<HTMLDivElement>('updated'),
};

const state = {
  symbol: DEFAULT_SYMBOL,
  interval: '4h' as Interval,
  view: 'main' as View,
  screen: { kind: 'loading' } as Screen,
  settings: { ...DEFAULT_SETTINGS } as Settings,
  plan: 'free' as Plan,
  entitlements: entitlementsFor(false) as Entitlements,
  origin: null as Origin,
  note: null as string | null,
  loading: false,
};

let loadToken = 0;
let inFlight: AbortController | null = null;

// --- Analysis ---------------------------------------------------------------------------

async function runAnalysis(options: { force: boolean }): Promise<void> {
  const token = ++loadToken;
  inFlight?.abort();
  const controller = new AbortController();
  inFlight = controller;
  const { symbol, interval } = state;

  if (!canUseCoin(symbol, state.entitlements)) return finish(token, { kind: 'locked', reason: 'coin' });
  if (!canUseTimeframe(interval, state.entitlements)) return finish(token, { kind: 'locked', reason: 'timeframe' });
  const remaining = remainingAnalyses((await loadUsage()).count, state.entitlements);
  if (remaining === 0 && (options.force || !(await market.hasFresh(symbol, interval)))) {
    return finish(token, { kind: 'locked', reason: 'daily-limit' });
  }

  // Keep the current result on screen (dimmed) while refreshing the same market.
  const current = state.screen;
  const refreshingInPlace =
    current.kind === 'result' && current.mode !== 'snapshot' && current.entry.symbol === symbol && current.entry.interval === interval;
  state.loading = true;
  if (!refreshingInPlace) state.screen = { kind: 'loading' };
  render();

  let result;
  try {
    result = await market.load(symbol, interval, { force: options.force, signal: controller.signal });
  } catch (error) {
    if (isAbortError(error)) return;
    result = { status: 'error' as const, error: new MarketDataError('unavailable', 'Unexpected error.'), attempts: [] };
  }
  if (token !== loadToken) return;

  if (result.status === 'error') {
    return finish(token, { kind: 'error', error: result.error, attempts: result.attempts, retryAt: retryAtOf(result.error) });
  }

  const data = result.data;
  // Closed vs in-progress candles are judged at fetch time, so a cached result reads the same later.
  const outcome = analyze(data.candles, { now: data.fetchedAt });
  if (!outcome.ok) {
    return finish(token, {
      kind: 'no-analysis',
      reason: outcome.reason,
      got: outcome.reason === 'insufficient-data' ? outcome.got : data.candles.length,
      needed: outcome.reason === 'insufficient-data' ? outcome.needed : 0,
      source: data.source,
    });
  }

  const name = assetName(symbol);
  const showAdvanced = can('advancedIndicators', state.entitlements);
  const explanation = await explainer.explain({
    symbol,
    name,
    interval,
    analysis: outcome.analysis,
    omit: showAdvanced ? [] : ADVANCED_INDICATORS,
  });
  if (token !== loadToken) return;
  const entry: HistoryEntry = {
    id: crypto.randomUUID(),
    fetchedAt: data.fetchedAt,
    symbol,
    name,
    quote: data.quote,
    interval,
    source: data.source,
    price: data.ticker?.lastPrice ?? outcome.analysis.price,
    changePct24h: data.ticker?.changePct24h ?? null,
    analysis: outcome.analysis,
    explanation,
  };

  if (result.status === 'fresh') {
    // The watchlist shows each market's last known signal.
    void recordSnapshots([{ ...toAlertSnapshot(symbol, interval, outcome.analysis, data.fetchedAt), quote: data.quote, source: data.source }]);
  }
  if (result.status === 'fresh' && !result.fromCache) {
    void recordAnalysis();
    const limit = historyLimit(state.settings.historyLimit, state.entitlements);
    addHistoryEntry(entry, limit).catch((error: unknown) => console.warn('CryptoSignal AI: history not saved', error));
  }

  finish(token, {
    kind: 'result',
    entry,
    mode: result.status === 'stale' ? 'stale' : 'live',
    error: result.status === 'stale' ? result.error : null,
    attempts: result.attempts,
    retryAt: result.status === 'stale' ? retryAtOf(result.error) : null,
  });
}

function finish(token: number, screen: Screen): void {
  if (token !== loadToken) return;
  state.loading = false;
  state.screen = screen;
  render();
  announce();
}

function retryAtOf(error: MarketDataError): number | null {
  return error.code === 'rate-limited' && error.retryAfterMs ? Date.now() + error.retryAfterMs : null;
}

// --- Rendering --------------------------------------------------------------------------

function render(): void {
  renderMarketBar();
  renderNotices();
  renderContent();
  renderFooter();
  els.refresh.disabled = state.loading;
  els.refresh.classList.toggle('is-spinning', state.loading);
  els.content.setAttribute('aria-busy', String(state.loading));
  els.content.style.opacity = state.loading && state.screen.kind === 'result' ? '0.55' : '';
}

function renderMarketBar(): void {
  const screen = state.screen;
  const quote = screen.kind === 'result' ? screen.entry.quote : null;
  els.coinBadge.textContent = coinGlyph(state.symbol);
  els.pair.replaceChildren(state.symbol, quote ? h('span', { class: 'quote', text: `/${quote}` }) : '');
  els.assetName.textContent = assetName(state.symbol) === state.symbol ? 'Choose a coin' : assetName(state.symbol);

  els.timeframes.replaceChildren(
    ...INTERVALS.flatMap((interval) => {
      const allowed = canUseTimeframe(interval, state.entitlements);
      const input = h('input', {
        class: 'btn-check',
        attrs: { type: 'radio', name: 'timeframe', id: `tf-${interval}`, value: interval, autocomplete: 'off', checked: interval === state.interval, disabled: !allowed },
      });
      input.addEventListener('change', () => {
        state.interval = interval;
        void saveUiState({ lastInterval: interval });
        void runAnalysis({ force: false });
      });
      const title = allowed ? `${interval} candles${isProTimeframe(interval) && state.entitlements.policy === 'early-access' ? ' (Pro later, free during early access)' : ''}` : 'The Free plan uses the 4h timeframe';
      const label = h('label', { class: 'btn', attrs: { for: `tf-${interval}`, title } }, allowed ? null : icon('lock', { size: 9 }), interval);
      return [input, label];
    }),
  );
}

function renderNotices(): void {
  const notices: HTMLElement[] = [];
  const screen = state.screen;

  if (screen.kind === 'result' && screen.mode === 'snapshot') {
    notices.push(
      renderNotice({
        kind: 'snapshot',
        icon: 'clock',
        id: 'snapshot-notice',
        body: [h('strong', { text: `Snapshot from ${formatFullDateTime(screen.entry.fetchedAt)}.` }), ' Saved analysis, not live data.'],
        action: { label: 'Analyze now', primary: true, id: 'analyze-now', onClick: () => void runAnalysis({ force: false }) },
      }),
    );
  } else if (screen.kind === 'result' && screen.mode === 'stale' && screen.error) {
    const waiting = screen.retryAt !== null && screen.retryAt > Date.now();
    notices.push(
      renderNotice({
        kind: 'caution',
        icon: 'exclamationTriangle',
        id: 'stale-notice',
        body: [
          h('strong', { text: `Couldn't refresh (${shortReason(screen.error)}).` }),
          ` Showing data from ${formatAge(screen.entry.fetchedAt)}.`,
          waiting ? h('span', {}, ' Retry in ', countdown(screen.retryAt!), '.') : '',
        ],
        action: { label: 'Retry', id: 'retry', disabled: waiting, onClick: () => void runAnalysis({ force: true }) },
      }),
    );
  } else if (screen.kind === 'result' && screen.mode === 'live' && screen.attempts.length && screen.entry.source !== screen.attempts[0]!.provider) {
    const first = screen.attempts[0]!;
    notices.push(
      renderNotice({
        kind: 'info',
        icon: 'infoCircle',
        id: 'fallback-notice',
        body: [`${PROVIDER_NAMES[first.provider]}: ${shortReason(new MarketDataError(first.code, ''))}. Using ${PROVIDER_NAMES[screen.entry.source]} (${screen.entry.quote}) instead.`],
      }),
    );
  }

  if (state.note) notices.push(renderNotice({ kind: 'info', icon: 'infoCircle', id: 'selection-note', body: [state.note] }));

  const origin = state.origin;
  const originLine =
    origin && !(screen.kind === 'result' && screen.mode === 'snapshot')
      ? h(
          'p',
          { class: 'detected', attrs: { id: 'origin' } },
          icon('cursor', { size: 10 }),
          origin.kind === 'page'
            ? `Detected on ${origin.host ?? 'this page'}`
            : origin.kind === 'alert'
              ? origin.text
                ? `From your alert: ${truncate(origin.text, 90)}`
                : 'From your alert'
              : `From your selection “${truncate(origin.text, 40)}”`,
        )
      : null;

  els.notices.replaceChildren(...(originLine ? [originLine] : []), ...notices);
}

function renderContent(): void {
  const screen = state.screen;
  const showAdvanced = can('advancedIndicators', state.entitlements);
  const proBadges = state.entitlements.policy === 'early-access';
  switch (screen.kind) {
    case 'loading':
      els.content.replaceChildren(renderSkeleton());
      return;
    case 'result': {
      const stale = screen.mode === 'stale' || (screen.mode === 'live' && Date.now() - screen.entry.fetchedAt > STALE_AFTER_MS);
      els.content.replaceChildren(renderResult(screen.entry, { stale, showAdvanced, proBadges }));
      return;
    }
    case 'error': {
      const copy = describeError(screen.error, state.symbol);
      const waiting = screen.retryAt !== null && screen.retryAt > Date.now();
      const actions: StateAction[] = [{ label: 'Try again', primary: true, id: 'retry', disabled: waiting, onClick: () => void runAnalysis({ force: true }) }];
      if (screen.error.code === 'invalid-symbol') {
        actions.length = 0;
        actions.push({ label: 'Choose another coin', primary: true, id: 'choose-coin', onClick: () => showView('search') });
      }
      const rows = attemptRows(screen.attempts);
      const extra = h(
        'div',
        {},
        waiting ? h('p', { class: 'mb-2', attrs: { id: 'retry-countdown' } }, 'You can try again in ', countdown(screen.retryAt!), '.') : null,
        rows.length
          ? h('ul', { class: 'attempts' }, ...rows.map((row) => h('li', {}, h('span', { class: 'attempt-provider', text: row.provider }), h('span', { text: row.outcome }))))
          : null,
      );
      els.content.replaceChildren(renderStateCard({ kind: copy.tone, icon: copy.icon, title: copy.title, body: copy.body, extra, actions, id: 'error-card' }));
      return;
    }
    case 'no-analysis': {
      const source = PROVIDER_NAMES[screen.source];
      const card =
        screen.reason === 'insufficient-data'
          ? renderStateCard({
              kind: 'caution',
              icon: 'hourglass',
              title: 'Not enough price history',
              body: `${source} has ${screen.got} ${state.interval} candles for ${state.symbol}; the indicators need at least ${screen.needed}. A shorter timeframe has more candles.`,
              actions: state.interval !== '1h' && canUseTimeframe('1h', state.entitlements) ? [{ label: 'Use 1h', primary: true, onClick: () => switchInterval('1h') }] : [],
            })
          : renderStateCard({
              kind: 'error',
              icon: 'exclamationOctagon',
              title: "The price data didn't pass validation",
              body: `Some candles from ${source} had impossible values, so no signal is shown rather than a wrong one.`,
              actions: [{ label: 'Try again', primary: true, onClick: () => void runAnalysis({ force: true }) }],
            });
      els.content.replaceChildren(card);
      return;
    }
    case 'locked': {
      const free = planLimits('free');
      const copy = {
        coin: {
          title: `${state.symbol} is part of Pro`,
          body: `The Free plan covers ${free.coins?.join(' and ')}. You're previewing Free plan limits; turn the preview off in Settings to use every coin during early access.`,
          actions: [
            { label: 'Analyze BTC', primary: true, onClick: () => pickSymbol('BTC') },
            { label: 'About Pro', onClick: showAboutPro },
          ],
        },
        timeframe: {
          title: `The ${state.interval} timeframe is part of Pro`,
          body: `The Free plan uses the ${free.timeframes.join(', ')} timeframe. You're previewing Free plan limits.`,
          actions: [
            { label: `Use ${free.timeframes[0]}`, primary: true, onClick: () => switchInterval(free.timeframes[0]!) },
            { label: 'About Pro', onClick: showAboutPro },
          ],
        },
        'daily-limit': {
          title: 'Daily limit reached',
          body: `The Free plan includes ${free.dailyAnalyses} fresh analyses a day; results under a minute old still open. The count resets at midnight. You're previewing Free plan limits.`,
          actions: [{ label: 'About Pro', primary: true, onClick: showAboutPro }],
        },
      }[screen.reason];
      els.content.replaceChildren(renderStateCard({ kind: 'locked', icon: 'lock', id: 'locked-card', ...copy }));
      return;
    }
  }
}

function renderFooter(): void {
  const screen = state.screen;
  els.updated.hidden = state.view !== 'main';
  if (screen.kind === 'result') {
    const source = PROVIDER_NAMES[screen.entry.source];
    if (screen.mode === 'snapshot') {
      els.updated.replaceChildren(
        h('span', { attrs: { id: 'last-updated' }, text: `Snapshot · ${formatFullDateTime(screen.entry.fetchedAt)}` }),
        h('span', { attrs: { id: 'data-source' }, text: source }),
      );
      return;
    }
    const stale = screen.mode === 'stale' || Date.now() - screen.entry.fetchedAt > STALE_AFTER_MS;
    els.updated.replaceChildren(
      h('span', { class: stale ? 'is-stale' : '', attrs: { id: 'last-updated' } }, `Last updated: ${formatAge(screen.entry.fetchedAt)}${stale ? ' · stale' : ''}`),
      h('span', { attrs: { id: 'data-source' }, text: source }),
    );
    return;
  }
  els.updated.replaceChildren(h('span', { attrs: { id: 'last-updated' }, text: screen.kind === 'loading' ? 'Loading market data…' : 'No live data' }));
}

function announce(): void {
  const screen = state.screen;
  let text = '';
  if (screen.kind === 'result') {
    const { entry } = screen;
    text = `${entry.symbol}/${entry.quote} ${entry.interval}: ${SIGNAL_TEXT[entry.analysis.signal]}, signal strength ${entry.analysis.strength}%.`;
    if (screen.mode === 'stale') text += ' Data is stale.';
  } else if (screen.kind === 'error') {
    text = describeError(screen.error, state.symbol).title;
  } else if (screen.kind === 'locked') {
    text = 'This needs the Pro plan.';
  } else if (screen.kind === 'no-analysis') {
    text = 'No signal: not enough valid price data.';
  }
  els.live.textContent = text;
}

/** A self-updating "42 s" countdown (see tick()). */
function countdown(until: number): HTMLElement {
  return h('span', { class: 'countdown', attrs: { 'data-until': until }, text: formatDuration(until - Date.now()) });
}

/** Once a second: relative times and countdowns. */
function tick(): void {
  const screen = state.screen;
  const turnedStale =
    screen.kind === 'result' && screen.mode === 'live' && Date.now() - screen.entry.fetchedAt > STALE_AFTER_MS && !document.querySelector('.badge-stale');
  if (state.view === 'main' && turnedStale && !state.loading) render();
  else if (state.view === 'main') renderFooter();
  for (const element of document.querySelectorAll<HTMLElement>('.countdown[data-until]')) {
    const remaining = Number(element.dataset.until) - Date.now();
    element.textContent = formatDuration(remaining);
    if (remaining <= 0) {
      element.removeAttribute('data-until');
      const retry = document.getElementById('retry') as HTMLButtonElement | null;
      if (retry) retry.disabled = false;
      element.closest('#retry-countdown')?.replaceChildren('You can try again now.');
    }
  }
}

// --- Navigation -------------------------------------------------------------------------

function showView(view: View): void {
  const previous = state.view;
  state.view = view;
  els.main.hidden = view !== 'main';
  els.search.hidden = view !== 'search';
  els.historyView.hidden = view !== 'history';
  els.settingsView.hidden = view !== 'settings';
  els.alertsView.hidden = view !== 'alerts';
  els.alerts.setAttribute('aria-pressed', String(view === 'alerts'));
  els.history.setAttribute('aria-pressed', String(view === 'history'));
  els.settings.setAttribute('aria-pressed', String(view === 'settings'));
  renderFooter();

  if (view === 'search') {
    const proBadges = state.entitlements.policy === 'early-access';
    mountSearch(els.search, {
      current: state.symbol,
      entitlements: state.entitlements,
      proBadges,
      search: (query) => market.search(query),
      onPick: pickSymbol,
      onBack: () => showView('main'),
    }).focus();
  } else if (view === 'history') {
    void openHistory();
  } else if (view === 'alerts') {
    const screen = state.screen;
    const live = screen.kind === 'result' && screen.mode !== 'snapshot' && screen.entry.symbol === state.symbol && screen.entry.interval === state.interval;
    void mountAlerts(els.alertsView, {
      market: { symbol: state.symbol, interval: state.interval },
      quote: live ? screen.entry.quote : null,
      price: live ? screen.entry.price : null,
      entitlements: state.entitlements,
      onOpen: (symbol, interval) => {
        state.interval = interval;
        void saveUiState({ lastInterval: interval });
        pickSymbol(symbol);
      },
      onAboutPro: showAboutPro,
      onBack: () => showView('main'),
    });
  } else if (view === 'settings') {
    mountSettings(els.settingsView, {
      settings: state.settings,
      version: chrome.runtime.getManifest().version,
      onChange: async (patch) => {
        state.settings = await saveSettings(patch);
        state.entitlements = entitlementsFor(state.settings.previewFreePlan, state.plan);
        return state.settings;
      },
      onClearHistory: () => clearHistory(),
      onClearCache: () => market.clear(),
      onBack: () => showView('main'),
    });
  } else if (view === 'main' && previous === 'settings') {
    // Settings can change what's allowed (Free plan preview).
    if (state.screen.kind !== 'result' || state.screen.mode !== 'snapshot') void runAnalysis({ force: false });
    else render();
  } else if (view === 'main') {
    render();
  }
  window.scrollTo(0, 0);
}

async function openHistory(): Promise<void> {
  let items: HistoryEntry[] = [];
  let error = false;
  try {
    items = await loadHistory();
  } catch {
    error = true;
  }
  const preview = state.entitlements.policy === 'enforced';
  const limit = historyLimit(state.settings.historyLimit, state.entitlements);
  mountHistory(els.historyView, {
    items: items.slice(0, Math.max(limit, 0) || items.length),
    error,
    settings: state.settings,
    limit,
    preview,
    proBadges: !preview,
    onOpen: openSnapshot,
    onDelete: (id) => deleteHistoryEntry(id),
    onClear: () => clearHistory(),
    onBack: () => showView('main'),
    onSettings: () => showView('settings'),
  });
}

function showAboutPro(): void {
  showView('settings');
  const card = document.getElementById('about-pro');
  card?.scrollIntoView({ block: 'start' });
  card?.focus({ preventScroll: true });
}

function openSnapshot(entry: HistoryEntry): void {
  loadToken++;
  inFlight?.abort();
  state.loading = false;
  state.symbol = entry.symbol;
  state.interval = entry.interval;
  state.origin = null;
  state.note = null;
  state.screen = { kind: 'result', entry, mode: 'snapshot', error: null, attempts: [], retryAt: null };
  showView('main');
  announce();
}

function pickSymbol(symbol: string): void {
  state.symbol = symbol;
  state.origin = null;
  state.note = null;
  void saveUiState({ lastSymbol: symbol });
  showView('main');
  void runAnalysis({ force: false });
}

function switchInterval(interval: Interval): void {
  state.interval = interval;
  void saveUiState({ lastInterval: interval });
  void runAnalysis({ force: false });
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// --- Start ------------------------------------------------------------------------------

async function start(): Promise<void> {
  els.brand.prepend(logo(22));
  els.alerts.append(icon('bell', { size: 16 }));
  els.history.append(icon('clockHistory', { size: 16 }));
  els.refresh.append(icon('arrowClockwise', { size: 16 }));
  els.settings.append(icon('gear', { size: 16 }));
  els.assetButton.append(icon('chevronDown', { size: 12, class: 'chevron' }));
  els.alerts.addEventListener('click', () => showView(state.view === 'alerts' ? 'main' : 'alerts'));
  els.history.addEventListener('click', () => showView(state.view === 'history' ? 'main' : 'history'));
  els.settings.addEventListener('click', () => showView(state.view === 'settings' ? 'main' : 'settings'));
  els.refresh.addEventListener('click', () => {
    if (state.view !== 'main') showView('main');
    void runAnalysis({ force: true });
  });
  els.assetButton.addEventListener('click', () => showView('search'));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && state.view !== 'main' && !(event.target instanceof HTMLInputElement && event.target.value)) showView('main');
  });
  render();

  void clearBadge();
  const [settings, ui, pending, plan] = await Promise.all([loadSettings(), loadUiState(), takePendingAnalysis(), loadPlan()]);
  state.settings = settings;
  state.plan = plan;
  state.entitlements = entitlementsFor(settings.previewFreePlan, plan);
  state.interval = pending?.symbol && pending.interval ? pending.interval : ui.lastInterval;

  let symbol: string | null = null;
  if (pending?.symbol && pending.alert !== undefined && pending.alert !== null) {
    symbol = pending.symbol;
    state.origin = { kind: 'alert', text: pending.alert };
  } else if (pending?.symbol && pending.interval) {
    symbol = pending.symbol;
    state.origin = { kind: 'alert', text: null };
  } else if (pending?.symbol) {
    symbol = pending.symbol;
    state.origin = { kind: 'selection', text: pending.selection };
  } else if (pending) {
    const fallback = ui.lastSymbol ?? DEFAULT_SYMBOL;
    state.note = `Couldn't find a coin in “${truncate(pending.selection, 40)}”. Showing ${assetName(fallback)} instead.`;
  }
  if (!symbol && !pending && settings.detectFromPage) {
    const detection = await detectFromActiveTab();
    if (detection) {
      symbol = detection.symbol;
      state.origin = { kind: 'page', host: detection.host };
    }
  }
  state.symbol = symbol ?? ui.lastSymbol ?? DEFAULT_SYMBOL;

  window.setInterval(tick, 1000);
  await runAnalysis({ force: false });
}

async function clearBadge(): Promise<void> {
  try {
    await chrome.action.setBadgeText({ text: '' });
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id !== undefined) {
      await chrome.action.setBadgeText({ tabId: tab.id, text: '' });
      await chrome.action.setTitle({ tabId: tab.id, title: 'CryptoSignal AI' });
    }
  } catch {
    // Nothing to clear.
  }
}

void start();
