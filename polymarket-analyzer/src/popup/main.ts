import '../styles/popup.scss';

import { LocalAlertService, type AlertObservation, type AlertService } from '../core/alerts';
import { analyzeMarket, type Analysis } from '../core/analyze';
import { buildComparison, MAX_COMPARE, type CompareColumn } from '../core/compare';
import { runConsistencyChecks } from '../core/consistency';
import { effectivePlan, hasFeature, limitsFor, type Plan, type PlanLimits } from '../core/features';
import { LocalExplanationService, type AIExplanationService, type ExplanationInput } from '../core/explanation';
import { checkOutcomeSum, highestPriced, sortByProbability } from '../core/probability';
import { recordRefresh, summarize, type MarketSummary, type Snapshot, type WatchItem } from '../core/saved';
import { normalizeQuery } from '../core/search';
import { downsample } from '../core/series';
import { isPolymarketUrl, marketPageUrl, parseMarketUrl, refKey } from '../core/slug';
import type { HistoryRange, Market, MarketContext, MarketRef, PricePoint } from '../core/types';
import { API, CACHE_TTL_MS, MAX_STALE_MS, SEARCH_DEBOUNCE_MS } from '../config';
import { TtlCache, type Fetched } from '../data/cache';
import { describeError, isDataError } from '../data/errors';
import { PolymarketService, type MarketDataService } from '../data/polymarketService';
import { takePending } from '../storage/handoff';
import {
  addWatchItem,
  clearSnapshots,
  deleteSnapshot,
  loadPlan,
  loadSnapshots,
  loadWatchlist,
  removeWatchItem,
  saveSnapshot,
  SessionCacheBackend,
  updateWatchItem,
} from '../storage/store';
import { byId, h } from '../ui/dom';
import { icon, logo, mountIcons } from '../ui/icons';
import { errorPanel, loadingSkeleton } from './components/common';
import { refFromCanonical, targetTab } from './detect';
import { renderAnalysis, statusLine, type AnalysisHandlers, type AnalysisModel, type ChartState, type OutcomeRow } from './views/analysis';
import {
  renderCompare,
  renderHistory,
  renderSearch,
  renderSearchResults,
  renderWatchlist,
  type CompareCandidate,
  type CompareViewOptions,
  type SearchStatus,
  type SearchViewOptions,
} from './views/lists';

// --- Services -----------------------------------------------------------------------------

const service: MarketDataService = new PolymarketService({
  gammaBase: API.gammaBase,
  clobBase: API.clobBase,
  fetch: (input, init) => fetch(input, init),
  cache: new TtlCache(new SessionCacheBackend(MAX_STALE_MS), { ttlMs: CACHE_TTL_MS, maxStaleMs: MAX_STALE_MS }),
});
const explainer: AIExplanationService = new LocalExplanationService();
const alertService: AlertService = new LocalAlertService();

// --- Elements & state ---------------------------------------------------------------------

const els = {
  main: byId<HTMLElement>('main'),
  status: byId<HTMLDivElement>('status'),
  toasts: byId<HTMLDivElement>('toasts'),
  brand: byId<HTMLSpanElement>('brand'),
  search: byId<HTMLButtonElement>('search-button'),
  refresh: byId<HTMLButtonElement>('refresh-button'),
  watchCount: byId<HTMLSpanElement>('watch-count'),
  tabs: [...document.querySelectorAll<HTMLButtonElement>('[data-tab]')],
};

type Tab = 'market' | 'watchlist' | 'history' | 'compare';

interface Session {
  ref: MarketRef;
  context: Fetched<MarketContext>;
  selected: Market;
  history7d: PricePoint[] | null;
  historyError: unknown;
  analysis: Analysis;
  explanation: string;
  chart: ChartState;
}

type Screen =
  | { kind: 'search'; query: string; notice: string | null }
  | { kind: 'loading'; ref: MarketRef }
  | { kind: 'error'; ref: MarketRef | null; error: unknown }
  | { kind: 'live'; session: Session }
  | { kind: 'snapshot'; snapshot: Snapshot };

let tab: Tab = 'market';
let plan: Plan = 'free';
let limits: PlanLimits = limitsFor('free');
let screen: Screen = { kind: 'search', query: '', notice: null };
let lastSession: Session | null = null;
let watchlist: WatchItem[] = [];
let snapshots: Snapshot[] = [];
let loadToken = 0;
let busy = false;

// --- Rendering ----------------------------------------------------------------------------

function render(options: { keepScroll?: boolean } = {}): void {
  const scroll = els.main.scrollTop;
  els.main.replaceChildren(view());
  els.main.scrollTop = options.keepScroll ? scroll : 0;
  for (const button of els.tabs) {
    const active = button.dataset.tab === tab;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
    button.tabIndex = active ? 0 : -1;
  }
  els.watchCount.textContent = String(watchlist.length);
  els.watchCount.hidden = watchlist.length === 0;
  updateRefreshButton();
}

/** The header refresh button: enabled when the current view has something to refresh. */
function updateRefreshButton(): void {
  const canRefresh = (tab === 'market' && (screen.kind === 'live' || (screen.kind === 'error' && screen.ref !== null))) || (tab === 'watchlist' && watchlist.length > 0);
  els.refresh.disabled = !canRefresh || busy;
  els.refresh.classList.toggle('is-spinning', busy);
}

function view(): HTMLElement {
  switch (tab) {
    case 'watchlist':
      return watchlistView();
    case 'history':
      return historyView();
    case 'compare':
      return compareView();
    case 'market':
      return marketView();
  }
}

function announce(message: string): void {
  els.status.textContent = message;
}

function setBusy(value: boolean): void {
  busy = value;
  updateRefreshButton();
}

// --- Market screen ------------------------------------------------------------------------

function marketView(): HTMLElement {
  switch (screen.kind) {
    case 'loading':
      return loadingSkeleton('Loading market data…');
    case 'error': {
      const { error, ref } = screen;
      return h(
        'div',
        { class: 'p-3 d-grid gap-3', attrs: { 'data-view': 'error' } },
        errorPanel(error, { onRetry: ref ? () => void openMarket(ref, { force: true }) : undefined, onSearch: () => showSearch('', null) }),
        h('p', { class: 'small text-body-secondary mb-0', text: 'No analysis is shown without valid market data.' }),
      );
    }
    case 'search':
      return searchView(screen.query, screen.notice);
    case 'live':
      return renderAnalysis(liveModel(screen.session), plan, handlers(), Date.now(), CACHE_TTL_MS);
    case 'snapshot':
      return renderAnalysis(snapshotModel(screen.snapshot), plan, handlers(), Date.now(), CACHE_TTL_MS);
  }
}

function handlers(): AnalysisHandlers {
  return {
    onRange: (range) => void changeRange(range),
    onSelectOutcome: (slug) => void selectOutcome(slug),
    onOpenRelated: (slug) => {
      const session = currentSession();
      const eventSlug = session?.context.data.event?.slug ?? null;
      void openMarket({ eventSlug, marketSlug: slug });
    },
    onToggleWatch: () => void toggleWatch(),
    onRefresh: () => void refreshCurrent(),
    onOpenLive: () => {
      if (screen.kind === 'snapshot') void openMarket(screen.snapshot.ref, { selectSlug: screen.snapshot.selectedSlug });
    },
  };
}

function currentSession(): Session | null {
  return screen.kind === 'live' ? screen.session : null;
}

async function openMarket(ref: MarketRef, options: { force?: boolean; selectSlug?: string | null; range?: HistoryRange } = {}): Promise<void> {
  const token = ++loadToken;
  tab = 'market';
  screen = { kind: 'loading', ref };
  setBusy(true);
  render();
  announce('Loading market data…');
  try {
    const context = await service.getCurrentMarket(ref, { force: options.force ?? false });
    if (token !== loadToken) return;
    const event = context.data.event;
    const selected = (options.selectSlug && event?.markets.find((market) => market.slug === options.selectSlug)) || context.data.market;
    const session = await buildSession(ref, context, selected, options.range ?? '7d', options.force ?? false);
    if (token !== loadToken) return;
    screen = { kind: 'live', session };
    lastSession = session;
    busy = false;
    render();
    announce(`Analysis ready: ${session.selected.question}`);
    if (session.chart.status === 'loading') void loadChart(session, session.chart.range, options.force ?? false);
    if (!context.stale) void recordSnapshot(session);
  } catch (error) {
    if (token !== loadToken) return;
    screen = { kind: 'error', ref, error };
    busy = false;
    render();
    announce(describeError(error).title);
  } finally {
    if (token === loadToken) setBusy(false);
  }
}

async function buildSession(ref: MarketRef, context: Fetched<MarketContext>, market: Market, range: HistoryRange, force: boolean): Promise<Session> {
  let history: PricePoint[] | null = null;
  let historyError: unknown = null;
  try {
    history = (await service.getMarketHistory(market, '7d', { force })).data;
  } catch (error) {
    historyError = error;
  }
  const analysis = analyzeMarket({ market, history, now: Date.now() });
  const explanation = (await explainer.explain(explanationInput(context.data, market, analysis))).text;
  const allowedRange = limits.chartRanges.includes(range) ? range : '7d';
  const chart: ChartState =
    allowedRange === '7d'
      ? { range: '7d', status: history ? 'ready' : 'unavailable', series: history ?? [], message: historyMessage(historyError), ranges: limits.chartRanges }
      : { range: allowedRange, status: 'loading', series: [], ranges: limits.chartRanges };
  return { ref, context, selected: market, history7d: history, historyError, analysis, explanation, chart };
}

function historyMessage(error: unknown): string | undefined {
  if (!error) return undefined;
  if (isDataError(error) && error.code === 'MISSING_HISTORY') return 'Polymarket has no price history for this market yet.';
  return `Price history couldn't be loaded: ${describeError(error).title}.`;
}

function explanationInput(context: MarketContext, market: Market, analysis: Analysis): ExplanationInput {
  if (context.kind === 'multi' && context.event) {
    const sorted = sortByProbability(context.event.markets);
    const leader = highestPriced(context.event.markets);
    return {
      title: context.event.title,
      outcomeName: market.label ?? market.question,
      kind: 'multi',
      analysis,
      leader: leader ? { name: leader.label ?? leader.question, probability: leader.probability } : null,
      rank: { position: sorted.findIndex((candidate) => candidate.slug === market.slug) + 1, of: sorted.length },
    };
  }
  return { title: market.question, outcomeName: market.outcomes[0]?.name ?? 'Yes', kind: 'binary', analysis };
}

async function changeRange(range: HistoryRange): Promise<void> {
  const session = currentSession();
  if (!session || session.chart.range === range) return;
  await loadChart(session, range, false);
}

async function loadChart(session: Session, range: HistoryRange, force: boolean): Promise<void> {
  if (range === '7d' && session.history7d && !force) {
    session.chart = { ...session.chart, range, status: 'ready', series: session.history7d, message: undefined };
    render({ keepScroll: true });
    return;
  }
  session.chart = { ...session.chart, range, status: 'loading', series: [] };
  render({ keepScroll: true });
  let next: ChartState;
  try {
    const fetched = await service.getMarketHistory(session.selected, range, { force });
    next = { ...session.chart, range, status: 'ready', series: fetched.data, message: undefined };
  } catch (error) {
    next = { ...session.chart, range, status: 'unavailable', series: [], message: historyMessage(error) };
  }
  if (currentSession() !== session || session.chart.range !== range) return;
  session.chart = next;
  render({ keepScroll: true });
}

async function selectOutcome(slug: string): Promise<void> {
  const session = currentSession();
  const market = session?.context.data.event?.markets.find((candidate) => candidate.slug === slug);
  if (!session || !market || session.selected.slug === slug) return;
  const token = ++loadToken;
  setBusy(true);
  let next: Session;
  try {
    next = await buildSession(session.ref, session.context, market, session.chart.range, false);
  } finally {
    if (token === loadToken) setBusy(false);
  }
  if (token !== loadToken) return;
  screen = { kind: 'live', session: next };
  lastSession = next;
  render({ keepScroll: true });
  announce(`Analyzing ${market.label ?? market.question}`);
  if (next.chart.status === 'loading') void loadChart(next, next.chart.range, false);
  if (!next.context.stale) void recordSnapshot(next);
}

async function refreshCurrent(): Promise<void> {
  if (tab === 'watchlist') return refreshWatchlist(true);
  if (screen.kind === 'live') {
    const { session } = screen;
    return openMarket(session.ref, { force: true, selectSlug: session.selected.slug, range: session.chart.range });
  }
  if (screen.kind === 'error' && screen.ref) return openMarket(screen.ref, { force: true });
}

// --- View models --------------------------------------------------------------------------

function row(market: Market): OutcomeRow {
  return { slug: market.slug, label: market.label ?? market.question, probability: market.probability, change24h: market.change24h, change7d: market.change7d };
}

function watchRef(session: Session): MarketRef {
  return { eventSlug: session.context.data.event?.slug ?? null, marketSlug: session.selected.slug };
}

function liveModel(session: Session): AnalysisModel {
  const { context, selected, analysis } = session;
  const event = context.data.event;
  const multi = context.data.kind === 'multi' && event !== null;
  const sortedRows = event ? sortByProbability(event.markets).map(row) : [];
  const leader = event ? highestPriced(event.markets) : null;
  // Prepared extension point: related-market consistency checks (none registered in the MVP).
  const findings = event ? runConsistencyChecks(event) : [];

  return {
    mode: 'live',
    kind: multi ? 'multi' : 'binary',
    // A single-market event's title just repeats the question.
    eventTitle: event && (multi || event.markets.length > 1) ? event.title : null,
    title: multi ? event.title : selected.question,
    pageUrl: marketPageUrl(multi ? { eventSlug: event.slug, marketSlug: null } : watchRef(session)),
    endDate: selected.endDate ?? event?.endDate ?? null,
    volume24hEvent: event?.volume24h ?? null,
    outcomes: selected.outcomes.map((outcome) => ({ name: outcome.name, probability: outcome.probability })),
    outcomeName: multi ? (selected.label ?? selected.question) : (selected.outcomes[0]?.name ?? 'Yes'),
    multi: multi
      ? {
          rows: sortedRows,
          selectedSlug: selected.slug,
          leader: leader ? row(leader) : null,
          mutuallyExclusive: event.mutuallyExclusive,
          // Closed outcomes of a winner-takes-all event resolved to No (price 0), so the open ones should still sum to ~100%.
          sum: checkOutcomeSum(
            event.markets.map((market) => market.probability),
            event.mutuallyExclusive,
          ),
          hidden: event.hiddenMarkets,
        }
      : null,
    probability: analysis.probability,
    change24h: analysis.change24h,
    change7d: analysis.change7d,
    volume24h: analysis.volume.volume24h,
    volumeLevel: analysis.volume.level,
    volumeRatio: analysis.volume.ratio,
    liquidity: analysis.liquidity.usd,
    liquidityLevel: analysis.liquidity.level,
    volatility: analysis.volatility.level,
    signal: analysis.momentum.label,
    strength: analysis.momentum.strength,
    unusual: analysis.unusual.map(({ title, detail }) => ({ title, detail })),
    factors: analysis.factors,
    explanation: session.explanation,
    warnings: [...analysis.warnings.filter((warning) => !(session.chart.status !== 'unavailable' && warning.startsWith('Price history'))), ...findings.map((finding) => finding.message)],
    chart: session.chart,
    related: !multi && event && event.markets.length > 1 ? sortByProbability(event.markets.filter((market) => market.slug !== selected.slug)).map(row) : null,
    status: { fetchedAt: context.fetchedAt, stale: context.stale, staleError: context.error },
    snapshotAt: null,
    watched: watchlist.some((item) => item.key === refKey(watchRef(session))),
  };
}

function snapshotModel(snapshot: Snapshot): AnalysisModel {
  const ref = { eventSlug: snapshot.ref.eventSlug, marketSlug: snapshot.selectedSlug ?? snapshot.ref.marketSlug };
  return {
    mode: 'snapshot',
    kind: 'binary',
    eventTitle: snapshot.eventTitle,
    title: snapshot.title,
    pageUrl: marketPageUrl(snapshot.ref),
    endDate: snapshot.endDate,
    volume24hEvent: null,
    // A multi-outcome snapshot shows the analyzed outcome, not that market's own Yes/No pair.
    outcomes: snapshot.kind === 'multi' ? [{ name: snapshot.outcome, probability: snapshot.summary.probability }] : snapshot.outcomes,
    outcomeName: snapshot.outcome,
    multi: null,
    probability: snapshot.summary.probability,
    change24h: snapshot.summary.change24h,
    change7d: snapshot.summary.change7d,
    volume24h: snapshot.summary.volume24h,
    volumeLevel: snapshot.volumeLevel,
    volumeRatio: snapshot.volumeRatio,
    liquidity: snapshot.summary.liquidity,
    liquidityLevel: snapshot.liquidityLevel,
    volatility: null,
    signal: snapshot.summary.signal,
    strength: snapshot.summary.strength,
    unusual: snapshot.unusual,
    factors: snapshot.factors,
    explanation: snapshot.explanation,
    warnings: snapshot.warnings,
    chart: { range: snapshot.seriesRange, status: snapshot.series.length >= 2 ? 'ready' : 'unavailable', series: snapshot.series, ranges: [], message: 'No price history was saved with this snapshot.' },
    related: null,
    status: { fetchedAt: snapshot.savedAt, stale: false },
    snapshotAt: snapshot.savedAt,
    watched: watchlist.some((item) => item.key === refKey(ref)),
  };
}

// --- Watchlist ----------------------------------------------------------------------------

let watchRefreshing = false;
const watchErrors = new Map<string, unknown>();

function watchlistView(): HTMLElement {
  return renderWatchlist({
    items: watchlist,
    limit: limits.watchlist,
    plan,
    refreshing: watchRefreshing,
    errors: watchErrors,
    onOpen: (item) => void openMarket(item.ref),
    onRemove: (item) => void removeFromWatchlist(item.key),
    onRefresh: () => void refreshWatchlist(true),
    onSearch: () => showSearch('', null),
  });
}

async function toggleWatch(): Promise<void> {
  let ref: MarketRef;
  let title: string;
  let outcome: string;
  let summary: MarketSummary;
  if (screen.kind === 'live') {
    const { session } = screen;
    const model = liveModel(session);
    ref = watchRef(session);
    title = model.title;
    outcome = model.outcomeName;
    summary = summarize(session.analysis, session.context.fetchedAt);
  } else if (screen.kind === 'snapshot') {
    const { snapshot } = screen;
    ref = { eventSlug: snapshot.ref.eventSlug, marketSlug: snapshot.selectedSlug ?? snapshot.ref.marketSlug };
    title = snapshot.title;
    outcome = snapshot.outcome;
    summary = snapshot.summary;
  } else {
    return;
  }
  const key = refKey(ref);
  try {
    if (watchlist.some((item) => item.key === key)) {
      watchlist = await removeWatchItem(key);
      announce('Removed from watchlist');
    } else {
      const result = await addWatchItem({ key, ref, title, outcome, addedAt: Date.now(), last: summary, previous: null, alerts: [] }, limits.watchlist);
      watchlist = result.items;
      announce(result.ok ? 'Added to watchlist' : result.reason === 'limit' ? `Watchlist is full (${limits.watchlist}). Remove a market first.` : 'Already on your watchlist');
      if (!result.ok && result.reason === 'limit') showToast(`Watchlist is full (${limits.watchlist}). Remove a market to add another.`);
    }
  } catch {
    showToast("Couldn't update the watchlist.");
  }
  render({ keepScroll: true });
}

async function removeFromWatchlist(key: string): Promise<void> {
  try {
    watchlist = await removeWatchItem(key);
    watchErrors.delete(key);
  } catch {
    showToast("Couldn't update the watchlist.");
  }
  render({ keepScroll: true });
}

function observation(summary: MarketSummary | null): AlertObservation | null {
  return summary ? { probability: summary.probability, volume24h: summary.volume24h, signal: summary.signal, at: summary.at } : null;
}

/** Refreshes watchlist items (3 at a time). Without `force`, cached data younger than the TTL is reused. */
async function refreshWatchlist(force: boolean): Promise<void> {
  if (watchRefreshing || !watchlist.length) return;
  watchRefreshing = true;
  setBusy(true);
  if (tab === 'watchlist') render({ keepScroll: true });
  const queue = [...watchlist];
  const worker = async () => {
    for (let item = queue.shift(); item; item = queue.shift()) {
      try {
        const context = await service.getCurrentMarket(item.ref, { force });
        const market = context.data.market;
        let history: PricePoint[] | null = null;
        try {
          history = (await service.getMarketHistory(market, '7d', { force })).data;
        } catch {
          history = null;
        }
        const summary = summarize(analyzeMarket({ market, history, now: Date.now() }), context.fetchedAt);
        const current = item;
        const events = hasFeature(plan, 'alerts') ? alertService.evaluate(observation(current.last), observation(summary)!) : [];
        watchlist = await updateWatchItem(current.key, (stored) => recordRefresh(stored, summary, events.map((event) => event.message)));
        watchErrors.delete(current.key);
      } catch (error) {
        watchErrors.set(item.key, error);
      }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  watchRefreshing = false;
  setBusy(false);
  if (tab === 'watchlist') render({ keepScroll: true });
  announce('Watchlist refreshed');
}

// --- History ------------------------------------------------------------------------------

let confirmClear = false;
let confirmTimer: number | undefined;

function historyView(): HTMLElement {
  return renderHistory({
    snapshots,
    limit: limits.history,
    confirmClear,
    onOpen: (snapshot) => {
      tab = 'market';
      screen = { kind: 'snapshot', snapshot };
      render();
      announce(`Snapshot from ${new Date(snapshot.savedAt).toLocaleString()}`);
    },
    onDelete: (snapshot) => {
      void deleteSnapshot(snapshot.id)
        .then((items) => {
          snapshots = items;
          render({ keepScroll: true });
        })
        .catch(() => showToast("Couldn't delete the snapshot."));
    },
    onClear: () => {
      if (!confirmClear) {
        confirmClear = true;
        render({ keepScroll: true });
        window.clearTimeout(confirmTimer);
        confirmTimer = window.setTimeout(() => {
          confirmClear = false;
          if (tab === 'history') render({ keepScroll: true });
        }, 4000);
        return;
      }
      confirmClear = false;
      void clearSnapshots()
        .then(() => {
          snapshots = [];
          render();
        })
        .catch(() => showToast("Couldn't clear the history."));
    },
    onSearch: () => showSearch('', null),
  });
}

async function recordSnapshot(session: Session): Promise<void> {
  const model = liveModel(session);
  const range: HistoryRange = session.history7d ? '7d' : session.chart.range;
  const series = session.history7d ?? (session.chart.status === 'ready' ? session.chart.series : []);
  const snapshot: Snapshot = {
    id: crypto.randomUUID(),
    key: refKey(session.ref),
    ref: session.ref,
    selectedSlug: session.selected.slug,
    savedAt: session.context.fetchedAt,
    kind: model.kind,
    title: model.title,
    eventTitle: model.eventTitle,
    outcome: model.outcomeName,
    outcomes: model.outcomes,
    endDate: model.endDate,
    summary: summarize(session.analysis, session.context.fetchedAt),
    volumeLevel: model.volumeLevel,
    volumeRatio: model.volumeRatio,
    liquidityLevel: model.liquidityLevel,
    unusual: hasFeature(plan, 'unusualActivity') ? model.unusual : [],
    factors: model.factors,
    explanation: model.explanation,
    warnings: session.analysis.warnings,
    series: downsample(series, 120),
    seriesRange: range,
  };
  try {
    snapshots = await saveSnapshot(snapshot, limits.history);
  } catch {
    // History is a convenience; the analysis is already on screen.
  }
}

// --- Compare ------------------------------------------------------------------------------

let compareSelected: string[] = [];
let compareStatus: CompareViewOptions['status'] = { state: 'idle' };
let compareToken = 0;

function compareCandidates(): (CompareCandidate & { ref: MarketRef })[] {
  const candidates: (CompareCandidate & { ref: MarketRef })[] = [];
  const seen = new Set<string>();
  for (const item of watchlist) {
    if (seen.has(item.key)) continue;
    seen.add(item.key);
    candidates.push({ key: item.key, title: item.title, outcome: item.outcome, source: 'watchlist', ref: item.ref });
  }
  for (const snapshot of snapshots) {
    const ref = { eventSlug: snapshot.ref.eventSlug, marketSlug: snapshot.selectedSlug ?? snapshot.ref.marketSlug };
    const key = refKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({ key, title: snapshot.title, outcome: snapshot.outcome, source: 'recent', ref });
    if (candidates.length >= 10) break;
  }
  return candidates;
}

function compareView(): HTMLElement {
  const candidates = compareCandidates();
  compareSelected = compareSelected.filter((key) => candidates.some((candidate) => candidate.key === key));
  return renderCompare({
    plan,
    candidates,
    selected: compareSelected,
    status: compareSelected.length >= 2 ? compareStatus : { state: 'idle' },
    onToggle: (key) => {
      compareSelected = compareSelected.includes(key) ? compareSelected.filter((selected) => selected !== key) : [...compareSelected, key].slice(0, MAX_COMPARE);
      void loadComparison();
    },
    onSearch: () => showSearch('', null),
  });
}

async function loadComparison(): Promise<void> {
  const token = ++compareToken;
  if (compareSelected.length < 2) {
    compareStatus = { state: 'idle' };
    render({ keepScroll: true });
    return;
  }
  compareStatus = { state: 'loading' };
  render({ keepScroll: true });
  const candidates = compareCandidates();
  const columns: CompareColumn[] = await Promise.all(
    compareSelected.map(async (key): Promise<CompareColumn> => {
      const candidate = candidates.find((entry) => entry.key === key)!;
      try {
        const context = await service.getCurrentMarket(candidate.ref);
        const market = context.data.market;
        let history: PricePoint[] | null = null;
        try {
          history = (await service.getMarketHistory(market, '7d')).data;
        } catch {
          history = null;
        }
        return { key, title: candidate.title, outcome: candidate.outcome, summary: summarize(analyzeMarket({ market, history, now: Date.now() }), context.fetchedAt) };
      } catch (error) {
        return { key, title: candidate.title, outcome: candidate.outcome, summary: null, error: describeError(error).title };
      }
    }),
  );
  if (token !== compareToken || tab !== 'compare') return;
  compareStatus = {
    state: 'ready',
    headers: columns.map((column) => ({ title: column.title, outcome: column.outcome, ...(column.error ? { error: column.error } : {}) })),
    rows: buildComparison(columns),
  };
  render({ keepScroll: true });
}

// --- Search -------------------------------------------------------------------------------

let searchTimer: number | undefined;
let searchController: AbortController | null = null;
let searchStatus: SearchStatus = { state: 'idle' };
let searchUi: { results: HTMLElement; options: SearchViewOptions; input: HTMLInputElement } | null = null;

function showSearch(query: string, notice: string | null): void {
  tab = 'market';
  screen = { kind: 'search', query, notice };
  searchStatus = { state: 'idle' };
  render();
  searchUi?.input.focus();
  if (normalizeQuery(query)) onSearchInput(query);
}

function searchView(query: string, notice: string | null): HTMLElement {
  const recent: Snapshot[] = [];
  for (const snapshot of snapshots) {
    if (recent.some((entry) => entry.key === snapshot.key && entry.selectedSlug === snapshot.selectedSlug)) continue;
    recent.push(snapshot);
    if (recent.length >= 4) break;
  }
  const options: SearchViewOptions = {
    query,
    notice,
    recent,
    canGoBack: lastSession ? (lastSession.context.data.event?.title ?? lastSession.selected.question) : null,
    onInput: onSearchInput,
    onOpen: (result) => void openMarket({ eventSlug: result.eventSlug, marketSlug: null }),
    onOpenSnapshotLive: (snapshot) => void openMarket(snapshot.ref, { selectSlug: snapshot.selectedSlug }),
    onBack: () => {
      if (!lastSession) return;
      screen = { kind: 'live', session: lastSession };
      render();
    },
    onRetry: () => onSearchInput(screen.kind === 'search' ? screen.query : ''),
  };
  const { root, input, results } = renderSearch(options);
  searchUi = { results, options, input };
  renderSearchResults(results, searchStatus, options);
  return root;
}

function onSearchInput(value: string): void {
  if (screen.kind === 'search') screen.query = value;
  window.clearTimeout(searchTimer);
  const query = normalizeQuery(value);
  if (!query) {
    searchController?.abort();
    searchStatus = { state: 'idle' };
  } else {
    searchStatus = { state: 'loading', query };
    searchTimer = window.setTimeout(() => void runSearch(query), SEARCH_DEBOUNCE_MS);
  }
  if (searchUi) renderSearchResults(searchUi.results, searchStatus, searchUi.options);
}

async function runSearch(query: string): Promise<void> {
  searchController?.abort();
  const controller = new AbortController();
  searchController = controller;
  try {
    const results = await service.searchMarkets(query, { signal: controller.signal, limit: 10 });
    if (controller.signal.aborted) return;
    searchStatus = { state: 'results', query, results };
    announce(`${results.length} markets found`);
  } catch (error) {
    if (controller.signal.aborted) return;
    searchStatus = { state: 'error', query, error };
  }
  if (screen.kind === 'search' && tab === 'market' && searchUi) renderSearchResults(searchUi.results, searchStatus, searchUi.options);
}

// --- Misc ---------------------------------------------------------------------------------

/** Short message outside the view, so re-rendering the view doesn't remove it. */
function showToast(message: string): void {
  const toast = h('div', { class: 'alert small py-2 px-3 mb-0 d-flex align-items-center gap-2', attrs: { 'data-toast': '' } }, icon('infoCircle'), h('span', { text: message }));
  els.toasts.append(toast);
  window.setTimeout(() => toast.remove(), 4500);
}

async function clearBadge(tabId: number | undefined): Promise<void> {
  try {
    await chrome.action.setBadgeText(tabId !== undefined ? { tabId, text: '' } : { text: '' });
  } catch {
    // Nothing to clear.
  }
}

/** Keeps "Updated … ago" and the stale indicator current while the popup stays open. */
function tickStatus(): void {
  if (tab !== 'market' || screen.kind !== 'live') return;
  const current = document.getElementById('status-line');
  if (current) current.replaceWith(statusLine(liveModel(screen.session), Date.now(), CACHE_TTL_MS, () => void refreshCurrent()));
}

// --- Start --------------------------------------------------------------------------------

async function start(): Promise<void> {
  mountIcons();
  els.brand.prepend(logo(22));
  for (const [index, button] of els.tabs.entries()) {
    button.addEventListener('click', () => {
      tab = button.dataset.tab as Tab;
      render();
      if (tab === 'watchlist' && watchlist.some((item) => !item.last || Date.now() - item.last.at > CACHE_TTL_MS)) void refreshWatchlist(false);
      if (tab === 'compare' && compareSelected.length >= 2) void loadComparison();
    });
    // Arrow keys move between tabs (WAI-ARIA tabs pattern).
    button.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
      event.preventDefault();
      const next = els.tabs[(index + (event.key === 'ArrowRight' ? 1 : els.tabs.length - 1)) % els.tabs.length]!;
      next.focus();
      next.click();
    });
  }
  els.search.addEventListener('click', () => showSearch('', null));
  els.refresh.addEventListener('click', () => void refreshCurrent());
  document.addEventListener('keydown', (event) => {
    const target = event.target as HTMLElement | null;
    if (event.key === '/' && !(target instanceof HTMLInputElement)) {
      event.preventDefault();
      showSearch('', null);
    }
  });
  window.setInterval(tickStatus, 15_000);

  plan = effectivePlan(await loadPlan());
  limits = limitsFor(plan);
  [watchlist, snapshots] = await Promise.all([loadWatchlist(), loadSnapshots()]);

  const [pending, target] = await Promise.all([takePending(), targetTab()]);
  void clearBadge(target?.id);

  if (pending?.kind === 'search') {
    showSearch(pending.query, null);
    return;
  }
  const url = pending?.kind === 'analyze' ? pending.url : target?.url;
  let ref = parseMarketUrl(url);
  if (!ref && target) ref = await refFromCanonical(target);
  if (ref) {
    await openMarket(ref);
    return;
  }
  showSearch(
    '',
    isPolymarketUrl(url ?? target?.url)
      ? "This Polymarket page isn't a single market. Search for one, or open a market page."
      : 'Open a market on polymarket.com to analyze it, or search below.',
  );
}

void start();
