import type { Factor } from '../../core/analyze';
import { hasFeature, isProFeature, type Plan } from '../../core/features';
import { formatClock, formatDate, formatDateTime, formatProbability, formatRatio, formatUsd, plural, relativeTime } from '../../core/format';
import { LOW_LIQUIDITY_WARNING, type LiquidityLevel, type VolatilityLevel, type VolumeLevel } from '../../core/metrics';
import { SIGNAL_TEXT, signalDirection, type SignalLabel } from '../../core/momentum';
import type { OutcomeSumCheck } from '../../core/probability';
import type { HistoryRange, MarketKind, PricePoint } from '../../core/types';
import { describeError } from '../../data/errors';
import { h } from '../../ui/dom';
import { icon } from '../../ui/icons';
import { chartEmpty, chartLoading, priceChart } from '../components/chart';
import { delta, liquidityBadge, proBadge, sectionLabel, volatilityBadge, volumeBadge } from '../components/common';

export interface OutcomeRow {
  slug: string;
  label: string;
  probability: number | null;
  change24h: number | null;
  change7d: number | null;
}

export interface ChartState {
  range: HistoryRange;
  status: 'loading' | 'ready' | 'unavailable';
  series: PricePoint[];
  message?: string;
  /** Ranges the tabs offer (the static snapshot chart has none). */
  ranges: readonly HistoryRange[];
}

/** Everything the analysis view shows. Built from a live analysis or a stored snapshot. */
export interface AnalysisModel {
  mode: 'live' | 'snapshot';
  kind: MarketKind;
  eventTitle: string | null;
  title: string;
  pageUrl: string;
  endDate: number | null;
  volume24hEvent: number | null;
  /** The analyzed market's own outcomes (Yes/No). */
  outcomes: { name: string; probability: number | null }[];
  /** The outcome the numbers refer to ("Yes", or the label in a multi-outcome event). */
  outcomeName: string;
  multi: {
    rows: OutcomeRow[];
    selectedSlug: string;
    leader: OutcomeRow | null;
    mutuallyExclusive: boolean;
    sum: OutcomeSumCheck;
    hidden: number;
  } | null;
  probability: number | null;
  change24h: number | null;
  change7d: number | null;
  volume24h: number | null;
  volumeLevel: VolumeLevel;
  volumeRatio: number | null;
  liquidity: number | null;
  liquidityLevel: LiquidityLevel;
  volatility: VolatilityLevel | null;
  signal: SignalLabel | null;
  strength: number | null;
  unusual: { title: string; detail: string }[];
  factors: Factor[];
  explanation: string;
  warnings: string[];
  chart: ChartState;
  related: OutcomeRow[] | null;
  status: { fetchedAt: number; stale: boolean; staleError?: unknown };
  snapshotAt: number | null;
  watched: boolean;
}

export interface AnalysisHandlers {
  onRange(range: HistoryRange): void;
  onSelectOutcome(slug: string): void;
  onOpenRelated(slug: string): void;
  onToggleWatch(): void;
  onRefresh(): void;
  onOpenLive(): void;
}

/** Stale after the cache TTL, or when a refresh failed. */
export function isStale(model: AnalysisModel, now: number, ttlMs: number): boolean {
  return model.status.stale || now - model.status.fetchedAt >= ttlMs;
}

export function renderAnalysis(model: AnalysisModel, plan: Plan, handlers: AnalysisHandlers, now: number, ttlMs: number): HTMLElement {
  const root = h('div', { class: 'p-3 d-grid gap-3', attrs: { 'data-view': 'analysis', 'data-kind': model.kind, 'data-mode': model.mode } });

  if (model.mode === 'snapshot' && model.snapshotAt !== null) root.append(snapshotBanner(model.snapshotAt, handlers));
  if (model.mode === 'live' && model.status.stale && model.status.staleError !== undefined) root.append(staleAlert(model, handlers));

  root.append(header(model, handlers));
  if (model.multi) {
    root.append(leaderCard(model.multi.leader, model.multi.mutuallyExclusive));
    root.append(outcomeTable(model.multi, handlers));
    root.append(sectionLabel(`Analyzing: ${model.outcomeName}`));
  } else {
    root.append(probabilityHero(model));
  }

  root.append(signalCard(model));
  if (model.unusual.length) {
    root.append(hasFeature(plan, 'unusualActivity') ? unusualCard(model.unusual) : lockedNote('Unusual activity detection'));
  }
  for (const warning of model.warnings) {
    root.append(h('div', { class: 'alert alert-secondary small mb-0 d-flex gap-2', attrs: { role: 'note' } }, icon('infoCircle', 'mt-1'), h('span', { text: warning })));
  }
  root.append(chartCard(model, plan, handlers));
  root.append(dataCard(model));
  if (model.liquidityLevel === 'LOW') {
    root.append(
      h(
        'div',
        { class: 'alert alert-warning small mb-0 d-flex gap-2', attrs: { role: 'note', 'data-warning': 'low-liquidity' } },
        icon('exclamationTriangleFill', 'mt-1'),
        h('span', {}, h('strong', { text: 'Low liquidity. ' }), LOW_LIQUIDITY_WARNING),
      ),
    );
  }
  root.append(whyCard(model.factors));
  root.append(explanationCard(model));
  if (model.related && model.related.length) {
    root.append(hasFeature(plan, 'relatedMarkets') ? relatedCard(model.related, handlers) : lockedNote('Related markets'));
  }
  root.append(statusLine(model, now, ttlMs, handlers.onRefresh));
  root.append(h('p', { class: 'signal-note mb-0 mt-n2', text: 'Data: Polymarket public APIs. Unofficial tool, not affiliated with Polymarket.' }));
  return root;
}

// --- Sections -----------------------------------------------------------------------------

function snapshotBanner(savedAt: number, handlers: AnalysisHandlers): HTMLElement {
  return h(
    'div',
    { class: 'snapshot-banner d-flex align-items-center justify-content-between gap-2 px-3 py-2', attrs: { 'data-banner': 'snapshot' } },
    h('span', { class: 'd-inline-flex align-items-center gap-2' }, icon('clockHistory'), h('span', {}, h('strong', { text: 'Snapshot' }), ` from ${formatDateTime(savedAt)}. Not live data.`)),
    h('button', { class: 'btn btn-sm btn-primary text-nowrap', text: 'Load live', attrs: { type: 'button' }, on: { click: handlers.onOpenLive } }),
  );
}

function staleAlert(model: AnalysisModel, handlers: AnalysisHandlers): HTMLElement {
  const reason = describeError(model.status.staleError);
  return h(
    'div',
    { class: 'alert alert-warning small mb-0', attrs: { role: 'alert', 'data-banner': 'stale' } },
    h('div', { class: 'd-flex gap-2' }, icon('exclamationTriangleFill', 'mt-1'), h('div', {}, h('strong', { text: `Showing data from ${relativeTime(model.status.fetchedAt)}.` }), ` Couldn't refresh: ${reason.title}.`)),
    h('button', { class: 'btn btn-sm btn-outline-warning mt-2', text: 'Try again', attrs: { type: 'button' }, on: { click: handlers.onRefresh } }),
  );
}

function header(model: AnalysisModel, handlers: AnalysisHandlers): HTMLElement {
  const showEvent = model.eventTitle && model.eventTitle !== model.title;
  const watch = h(
    'button',
    {
      class: `btn btn-icon watch-toggle ${model.watched ? 'is-on' : ''}`,
      attrs: {
        type: 'button',
        'aria-pressed': String(model.watched),
        'aria-label': model.watched ? 'Remove from watchlist' : 'Add to watchlist',
        title: model.watched ? 'Remove from watchlist' : 'Add to watchlist',
        'data-action': 'watch',
      },
      on: { click: handlers.onToggleWatch },
    },
    icon(model.watched ? 'starFill' : 'star'),
  );
  const meta: (Node | string)[] = [];
  const add = (node: Node | string) => {
    if (meta.length) meta.push(h('span', { class: 'sep', text: '·' }));
    meta.push(node);
  };
  if (model.kind === 'multi' && model.multi) add(plural(model.multi.rows.length, 'outcome'));
  if (model.endDate) add(`Ends ${formatDate(model.endDate)}`);
  const volume = model.kind === 'multi' ? model.volume24hEvent : model.volume24h;
  if (volume !== null) add(h('span', {}, 'Vol 24h ', h('span', { class: 'num', text: formatUsd(volume) })));
  add(
    h('a', { class: 'd-inline-flex align-items-center gap-1', attrs: { href: model.pageUrl, target: '_blank', rel: 'noopener noreferrer' } }, 'Polymarket', icon('boxArrowUpRight')),
  );

  return h(
    'div',
    {},
    showEvent ? h('div', { class: 'event-title mb-1', text: model.eventTitle ?? '' }) : null,
    h('div', { class: 'd-flex align-items-start gap-2' }, h('h1', { class: 'market-title flex-grow-1 mb-0', text: model.title }), watch),
    h('div', { class: 'meta-line mt-1' }, ...meta),
  );
}

function probabilityHero(model: AnalysisModel): HTMLElement {
  const [first, second] = model.outcomes;
  const yes = model.probability;
  const bar =
    yes !== null
      ? h('div', { class: 'prob-bar mt-2', attrs: { 'aria-hidden': 'true' } }, h('span', { class: 'yes', attrs: { style: `width:${(yes * 100).toFixed(1)}%` } }), h('span', { class: 'no', attrs: { style: `width:${((1 - yes) * 100).toFixed(1)}%` } }))
      : null;
  return h(
    'section',
    { class: 'hero', attrs: { 'aria-label': 'Current probability', 'data-section': 'probability' } },
    h(
      'div',
      { class: 'd-flex align-items-end justify-content-between gap-2' },
      h(
        'div',
        {},
        h('div', { class: 'hero-outcome mb-1', text: first?.name ?? model.outcomeName }),
        h('div', { class: 'd-flex align-items-center gap-2' }, h('span', { class: 'hero-value', text: formatProbability(yes), attrs: { 'data-value': 'probability' } }), heroChange(model.change24h)),
      ),
      second
        ? h('div', { class: 'text-end' }, h('div', { class: 'hero-outcome mb-1', text: second.name }), h('div', { class: 'num fs-5 fw-semibold text-body-secondary', text: formatProbability(second.probability) }))
        : null,
    ),
    bar,
    h('div', { class: 'hero-secondary mt-2', text: 'Market price, read as the implied probability.' }),
  );
}

function heroChange(change: number | null): HTMLElement {
  const element = delta(change, { suffix: '24h' });
  element.classList.add('hero-change');
  return element;
}

function leaderCard(leader: OutcomeRow | null, mutuallyExclusive: boolean): HTMLElement {
  // Independent markets (e.g. price thresholds) have no "leader", just a highest price.
  const title = mutuallyExclusive ? 'Current market leader' : 'Highest-priced market';
  return h(
    'section',
    { class: 'hero', attrs: { 'aria-label': title, 'data-section': 'leader' } },
    h('div', { class: 'hero-outcome mb-1', text: title }),
    h(
      'div',
      { class: 'd-flex align-items-center justify-content-between gap-2' },
      h('span', { class: 'fs-5 fw-bold text-body-emphasis text-truncate', text: leader?.label ?? '—', attrs: { 'data-value': 'leader' } }),
      h('span', { class: 'hero-value', text: formatProbability(leader?.probability ?? null) }),
    ),
    h('div', { class: 'hero-secondary mt-1 d-flex align-items-center gap-2' }, h('span', { text: 'Highest-priced outcome' }), leader ? delta(leader.change24h, { suffix: '24h' }) : null),
  );
}

function outcomeTable(multi: NonNullable<AnalysisModel['multi']>, handlers: AnalysisHandlers): HTMLElement {
  const rows = multi.rows.map((row) => {
    const selected = row.slug === multi.selectedSlug;
    const isLeader = multi.leader?.slug === row.slug;
    const width = row.probability !== null ? Math.max(2, Math.round(row.probability * 100)) : 0;
    return h(
      'tr',
      { class: selected ? 'is-selected' : '', attrs: { 'data-outcome': row.slug }, on: { click: () => handlers.onSelectOutcome(row.slug) } },
      h(
        'td',
        {},
        h(
          'button',
          { class: 'outcome-select', attrs: { type: 'button', 'aria-pressed': String(selected), 'aria-label': `Analyze ${row.label}` } },
          h('span', { class: 'd-flex align-items-center gap-2' }, h('span', { class: 'outcome-name', text: row.label }), isLeader ? h('span', { class: 'leader-tag', text: 'LEADER' }) : null),
        ),
        h('span', { class: 'outcome-bar', attrs: { style: `width:${width}%` } }),
      ),
      h('td', { class: 'num text-end fw-semibold text-body-emphasis', text: formatProbability(row.probability) }),
      h('td', { class: 'text-end' }, delta(row.change24h)),
      h('td', { class: 'text-end' }, delta(row.change7d)),
    );
  });
  const sumText =
    multi.sum.sum !== null && multi.mutuallyExclusive
      ? h('span', { class: `num ${multi.sum.status === 'inconsistent' ? 'text-warning' : ''}`, text: `Sum ${formatProbability(multi.sum.sum)}`, attrs: { title: 'Prices of mutually exclusive outcomes should add up to about 100%; the spread adds a little.' } })
      : null;
  return h(
    'section',
    { class: 'card', attrs: { 'aria-label': 'Outcomes', 'data-section': 'outcomes' } },
    h('div', { class: 'card-header d-flex justify-content-between align-items-center py-2' }, sectionLabel(multi.mutuallyExclusive ? 'Outcomes by probability' : 'Markets in this event'), h('span', { class: 'small text-body-secondary' }, sumText)),
    h(
      'table',
      { class: 'table outcome-table' },
      h('thead', {}, h('tr', {}, h('th', { text: 'Outcome' }), h('th', { class: 'text-end', text: 'Prob.' }), h('th', { class: 'text-end', text: '24h' }), h('th', { class: 'text-end', text: '7d' }))),
      h('tbody', {}, ...rows),
    ),
    h(
      'div',
      { class: 'card-footer small text-body-secondary py-2' },
      'Select an outcome to analyze its momentum.',
      multi.hidden ? ` ${plural(multi.hidden, 'closed or unpriced market')} not shown.` : '',
    ),
  );
}

function signalCard(model: AnalysisModel): HTMLElement {
  const direction = signalDirection(model.signal);
  const strong = model.signal === 'STRONG_POSITIVE' || model.signal === 'STRONG_NEGATIVE';
  const label = model.signal ? SIGNAL_TEXT[model.signal] : 'NOT ENOUGH DATA';
  const strength = model.strength ?? 0;
  const arrow = direction === 'up' ? icon('caretUpFill') : direction === 'down' ? icon('caretDownFill') : icon('dash');
  return h(
    'section',
    { class: `signal-card is-${direction} ${strong ? 'is-strong' : ''}`, attrs: { 'aria-label': 'Momentum signal', 'data-section': 'signal', 'data-signal': model.signal ?? 'NONE' } },
    h('div', { class: 'd-flex align-items-center justify-content-between mb-1' }, h('span', { class: 'section-label', text: 'Momentum signal' }), h('span', { class: 'signal-note', text: model.outcomeName === 'Yes' ? 'Yes price' : `“${model.outcomeName}” price` })),
    h('div', { class: 'signal-label d-flex align-items-center gap-1', attrs: { 'data-value': 'signal' } }, arrow, label),
    model.signal
      ? h(
          'div',
          { class: 'd-flex align-items-center gap-2 mt-2' },
          h('span', { class: 'small text-body-secondary text-nowrap' }, 'Signal strength ', h('span', { class: 'num fw-bold text-body-emphasis', text: `${strength}/100`, attrs: { 'data-value': 'strength' } })),
          h('div', { class: 'progress flex-grow-1', attrs: { role: 'progressbar', 'aria-label': 'Signal strength', 'aria-valuenow': String(strength), 'aria-valuemin': '0', 'aria-valuemax': '100' } }, h('div', { class: 'progress-bar', attrs: { style: `width:${strength}%` } })),
        )
      : h('div', { class: 'small text-body-secondary mt-1', text: 'The 24-hour price change is unknown, so no momentum signal was computed.' }),
    h('div', { class: 'signal-note mt-2', text: 'Describes recent price movement, not the probability that the event happens.' }),
  );
}

function unusualCard(signals: { title: string; detail: string }[]): HTMLElement {
  return h(
    'section',
    { class: 'unusual-card', attrs: { 'aria-label': 'Unusual activity', 'data-section': 'unusual' } },
    h('div', { class: 'd-flex align-items-center gap-2 mb-2' }, icon('exclamationTriangleFill', 'text-warning'), h('span', { class: 'unusual-title', text: 'Unusual activity' }), proBadge()),
    h('ul', { class: 'list-unstyled small mb-2' }, ...signals.map((signal) => h('li', {}, h('span', { class: 'unusual-kind', text: `${signal.title}: ` }), h('span', { text: signal.detail })))),
    h('div', { class: 'signal-note', text: 'Informational. Based on price and volume data only; causes are not known.' }),
  );
}

function lockedNote(feature: string): HTMLElement {
  return h('div', { class: 'small text-body-secondary d-flex align-items-center gap-2' }, icon('lockFill'), `${feature} is part of Pro.`, proBadge());
}

function chartCard(model: AnalysisModel, plan: Plan, handlers: AnalysisHandlers): HTMLElement {
  const { chart } = model;
  const tabs = chart.ranges.length
    ? h(
        'div',
        { class: 'range-tabs', attrs: { role: 'group', 'aria-label': 'Chart range' } },
        ...chart.ranges.map((range) => {
          const pro = range === '30d' && isProFeature('extendedHistory');
          const allowed = range !== '30d' || hasFeature(plan, 'extendedHistory');
          return h(
            'button',
            {
              class: `btn ${range === chart.range ? 'active' : ''}`,
              attrs: { type: 'button', 'aria-pressed': String(range === chart.range), 'data-range': range, disabled: allowed ? undefined : '', title: pro ? 'Pro feature, free during early access' : undefined },
              on: { click: () => handlers.onRange(range) },
            },
            range.toUpperCase(),
            pro ? h('span', { class: 'visually-hidden', text: ' (Pro)' }) : null,
          );
        }),
      )
    : h('span', { class: 'small text-body-secondary', text: chart.range.toUpperCase() });

  let body: HTMLElement;
  if (chart.status === 'loading') body = chartLoading();
  else if (chart.status === 'unavailable' || chart.series.length < 2) body = chartEmpty(chart.message ?? 'Price history is not available for this market.');
  else body = priceChart(chart.series, chart.range);

  return h(
    'section',
    { class: 'card chart-card', attrs: { 'aria-label': 'Price chart', 'data-section': 'chart', 'data-chart-state': chart.status } },
    h('div', { class: 'card-body' }, h('div', { class: 'd-flex align-items-center justify-content-between mb-2' }, sectionLabel(model.outcomeName === 'Yes' ? 'Price history' : `Price history · ${model.outcomeName}`), tabs), body),
  );
}

function dataCard(model: AnalysisModel): HTMLElement {
  const row = (label: string, ...value: (Node | string | null)[]) => h('div', {}, h('dt', { text: label }), h('dd', {}, ...value));
  const num = (text: string, name?: string) => h('span', { class: 'num', text, attrs: name ? { 'data-value': name } : {} });
  return h(
    'section',
    { class: 'card', attrs: { 'aria-label': 'Market data', 'data-section': 'data' } },
    h('div', { class: 'card-header py-2' }, sectionLabel('Market data')),
    h(
      'dl',
      { class: 'data-rows' },
      row(model.outcomeName === 'Yes' ? 'Probability (Yes)' : `Probability (${model.outcomeName})`, num(formatProbability(model.probability))),
      row('24h change', delta(model.change24h)),
      row('7d change', delta(model.change7d)),
      row('Volume 24h', model.volumeRatio !== null ? h('span', { class: 'num small text-body-secondary', text: `${formatRatio(model.volumeRatio)} avg` }) : null, num(formatUsd(model.volume24h), 'volume24h'), volumeBadge(model.volumeLevel)),
      row('Liquidity', num(formatUsd(model.liquidity), 'liquidity'), liquidityBadge(model.liquidityLevel)),
      model.volatility ? row('Volatility', volatilityBadge(model.volatility)) : null,
    ),
  );
}

function whyCard(factors: Factor[]): HTMLElement {
  return h(
    'section',
    { attrs: { 'aria-label': 'Why is it moving?', 'data-section': 'why' } },
    h('h2', { class: 'section-label mb-2', text: 'Why is it moving?' }),
    h(
      'ul',
      { class: 'list-unstyled factor-list small mb-1' },
      ...factors.map((factor) =>
        h(
          'li',
          { class: factor.tone === 'support' ? 'is-support' : 'is-caution' },
          icon(factor.tone === 'support' ? 'checkCircleFill' : 'exclamationTriangleFill'),
          h('span', { class: 'visually-hidden', text: factor.tone === 'support' ? 'Supporting: ' : 'Caution: ' }),
          h('span', { text: factor.text }),
        ),
      ),
    ),
    h('div', { class: 'signal-note', text: 'From market data only. No news or outside information is used.' }),
  );
}

function explanationCard(model: AnalysisModel): HTMLElement {
  return h(
    'section',
    { class: 'card', attrs: { 'aria-label': 'Analysis', 'data-section': 'explanation' } },
    h(
      'div',
      { class: 'card-body' },
      h('div', { class: 'd-flex justify-content-between align-items-center mb-2' }, sectionLabel('Analysis'), h('span', { class: 'signal-note d-inline-flex align-items-center gap-1', text: 'Generated locally from the numbers above' })),
      h('p', { class: 'analysis-text mb-0', text: model.explanation }),
    ),
  );
}

function relatedCard(rows: OutcomeRow[], handlers: AnalysisHandlers): HTMLElement {
  return h(
    'section',
    { class: 'card', attrs: { 'aria-label': 'Related markets', 'data-section': 'related' } },
    h('div', { class: 'card-header py-2 d-flex align-items-center gap-2' }, sectionLabel('Related markets', proBadge()), h('span', { class: 'small text-body-secondary ms-auto', text: 'Same event' })),
    h(
      'div',
      { class: 'list-group list-group-flush' },
      ...rows.map((row) =>
        h(
          'button',
          { class: 'list-group-item list-group-item-action d-flex align-items-center gap-2', attrs: { type: 'button', 'data-related': row.slug }, on: { click: () => handlers.onOpenRelated(row.slug) } },
          h('span', { class: 'flex-grow-1 text-truncate', text: row.label }),
          h('span', { class: 'num fw-semibold text-body-emphasis', text: formatProbability(row.probability) }),
          delta(row.change24h, { className: 'small' }),
        ),
      ),
    ),
  );
}

export function statusLine(model: AnalysisModel, now: number, ttlMs: number, onRefresh: () => void): HTMLElement {
  if (model.mode === 'snapshot') {
    return h('div', { class: 'small text-body-secondary d-flex align-items-center gap-2', attrs: { 'data-status': 'snapshot' } }, h('span', { class: 'status-dot is-snapshot' }), `Saved ${formatDateTime(model.snapshotAt)}`);
  }
  const stale = isStale(model, now, ttlMs);
  return h(
    'div',
    { class: 'small text-body-secondary d-flex align-items-center gap-2', attrs: { 'data-status': stale ? 'stale' : 'fresh', id: 'status-line' } },
    h('span', { class: `status-dot ${stale ? 'is-stale' : ''}` }),
    h('span', {}, stale ? h('strong', { class: 'text-warning', text: 'Stale · ' }) : null, 'Updated ', h('span', { class: 'num', text: formatClock(model.status.fetchedAt) }), ` · ${relativeTime(model.status.fetchedAt, now)}`),
    stale ? h('button', { class: 'btn btn-link btn-sm p-0 ms-auto', text: 'Refresh', attrs: { type: 'button' }, on: { click: onRefresh } }) : null,
  );
}
