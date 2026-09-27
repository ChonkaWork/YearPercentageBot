import type { Explanation } from '../core/explain';
import { formatNumber, formatPercent, formatPoints, formatPrice, formatRatio, formatSignificant } from '../core/format';
import type { HistoryEntry } from '../core/history';
import {
  ENGINE_CONFIG,
  INDICATOR_KEYS,
  MAX_SCORE,
  SIGNAL_TEXT,
  signalDirection,
  type Analysis,
  type IndicatorKey,
  type SignalLabel,
} from '../core/signal';
import { h } from '../ui/dom';
import { icon, type IconName } from '../ui/icons';
import { renderChart, type Tone } from './chart';

export function toneOfSignal(signal: SignalLabel): Tone {
  const direction = signalDirection(signal);
  return direction > 0 ? 'up' : direction < 0 ? 'down' : 'neutral';
}

export function toneOfNumber(value: number | null): Tone {
  if (value === null || !Number.isFinite(value) || value === 0) return 'neutral';
  return value > 0 ? 'up' : 'down';
}

export function proBadge(title = 'Part of Pro later. Free during early access.'): HTMLElement {
  return h('span', { class: 'badge-pro', text: 'PRO', attrs: { title } });
}

// --- Loading ----------------------------------------------------------------------------

export function renderSkeleton(): HTMLElement {
  const rows = Array.from({ length: 6 }, (_, i) => {
    const name = ph('ph-row');
    name.style.width = `${[34, 42, 38, 46, 36, 40][i]}%`;
    const value = ph('ph-row');
    value.style.width = '22%';
    return h('div', { class: 'd-flex justify-content-between align-items-center py-2 border-top' }, name, value);
  });
  return h(
    'div',
    { class: 'skeleton placeholder-glow', attrs: { 'aria-hidden': 'true' } },
    h('div', { class: 'mt-3' }, ph('ph-price')),
    h('div', { class: 'mt-3' }, ph('ph-card')),
    h('div', { class: 'mt-3' }, ph('ph-chart')),
    h('div', { class: 'mt-3' }, ...rows),
  );
}

function ph(kind: string, extra = ''): HTMLElement {
  return h('span', { class: `placeholder d-block ${kind} ${extra}`.trim() });
}

// --- Result -----------------------------------------------------------------------------

export interface ResultOptions {
  stale: boolean;
  showAdvanced: boolean;
  proBadges: boolean;
}

export function renderResult(entry: HistoryEntry, options: ResultOptions): HTMLElement {
  const { analysis, explanation } = entry;
  const tone = toneOfSignal(analysis.signal);
  return h(
    'div',
    { class: 'result', attrs: { 'data-signal': analysis.signal } },
    renderPrice(entry, options.stale),
    renderSignalCard(analysis),
    renderChart(analysis, { interval: entry.interval, tone, showEmas: options.showAdvanced }),
    renderIndicators(analysis, options),
    renderAnalysis(explanation),
    renderReasons(explanation, tone),
  );
}

function renderPrice(entry: HistoryEntry, stale: boolean): HTMLElement {
  const change = entry.changePct24h;
  const row = h(
    'div',
    { class: 'price-row' },
    h('span', { class: 'price', attrs: { id: 'price' }, text: formatPrice(entry.price) }),
    h('span', { class: 'price-quote', text: entry.quote }),
  );
  if (change !== null) {
    row.append(
      h('span', { class: `change-pill tone-${toneOfNumber(change)}`, attrs: { title: 'Change over the last 24 hours' } }, `${formatPercent(change)} 24h`),
    );
  }
  if (stale) row.append(h('span', { class: 'badge badge-stale', text: 'STALE' }));
  if (change === null) row.append(h('span', { class: 'price-sub', text: 'Latest candle close · 24h change unavailable' }));
  return row;
}

function renderSignalCard(analysis: Analysis): HTMLElement {
  const tone = toneOfSignal(analysis.signal);
  const points = INDICATOR_KEYS.map((key) => analysis.indicators[key].points);
  const up = points.filter((p) => p > 0).length;
  const down = points.filter((p) => p < 0).length;
  const flat = points.length - up - down;
  const iconName: IconName = tone === 'up' ? 'arrowUpRight' : tone === 'down' ? 'arrowDownRight' : 'dash';
  const strengthHelp =
    `Signal strength = |score| ÷ ${MAX_SCORE}. It shows how strongly the indicators agree. ` +
    'It is not a probability of the price moving or of a profitable trade.';

  const progress = h(
    'div',
    {
      class: 'progress',
      attrs: { role: 'progressbar', 'aria-label': 'Signal strength', 'aria-valuenow': analysis.strength, 'aria-valuemin': 0, 'aria-valuemax': 100 },
    },
    h('div', { class: 'progress-bar' }),
  );
  (progress.firstElementChild as HTMLElement).style.width = `${analysis.strength}%`;

  return h(
    'section',
    { class: `signal-card tone-${tone}`, attrs: { 'aria-label': 'Signal' } },
    h(
      'div',
      { class: 'signal-head' },
      h('h2', { class: 'signal-label', attrs: { id: 'signal-label' } }, h('span', { class: 'signal-icon' }, icon(iconName, { size: 18 })), SIGNAL_TEXT[analysis.signal]),
      h('span', { class: 'score-chip', attrs: { title: `Sum of the indicator points, from −${MAX_SCORE} to +${MAX_SCORE}` } }, `Score ${formatPoints(analysis.score)} / ${MAX_SCORE}`),
    ),
    h(
      'div',
      { class: 'strength', attrs: { title: strengthHelp } },
      h('span', { class: 'd-inline-flex align-items-center gap-1' }, 'Signal strength', icon('infoCircle', { size: 11 })),
      h('span', { class: 'strength-value', attrs: { id: 'strength' }, text: `${analysis.strength}%` }),
    ),
    progress,
    h('p', { class: 'signal-meta' }, `${up} up · ${down} down · ${flat} flat · not a probability of profit`),
  );
}

interface Row {
  key: IndicatorKey;
  name: string;
  params: string;
  value: string;
  state: string;
  points: number;
  help: string;
  advanced: boolean;
}

export function indicatorRows(analysis: Analysis): Row[] {
  const { rsi, macd, priceVsEma50, trend, momentum, volume } = analysis.indicators;
  const cfg = ENGINE_CONFIG;
  const rsiState = { oversold: 'Oversold', weak: 'Soft', neutral: 'Neutral', firm: 'Firm', overbought: 'Overbought' }[rsi.zone];
  const macdState = { 'bullish-cross': 'Bull cross', bullish: 'Bullish', neutral: 'Flat', bearish: 'Bearish', 'bearish-cross': 'Bear cross' }[macd.state];
  const crossNote = macd.crossAgo === null ? '' : macd.crossAgo === 0 ? ' Crossed on the latest candle.' : ` Crossed ${macd.crossAgo} candle${macd.crossAgo === 1 ? '' : 's'} ago.`;
  const gapPct = trend.ema50 !== 0 ? ((trend.ema20 - trend.ema50) / trend.ema50) * 100 : null;
  const volumeState =
    volume.ratio === null ? 'No data' : volume.points > 0 ? 'High, up' : volume.points < 0 ? 'High, down' : volume.ratio > 1 ? 'High, flat' : 'Not high';

  return [
    {
      key: 'rsi',
      name: 'RSI',
      params: String(cfg.rsiPeriod),
      value: formatNumber(rsi.value, 1),
      state: rsiState,
      points: rsi.points,
      help: 'RSI (14, Wilder). Below 30: +2 · 30–45: +1 · 45–55: 0 · 55–70: 0 in an uptrend, −1 otherwise · above 70: −2.',
      advanced: false,
    },
    {
      key: 'macd',
      name: 'MACD',
      params: `${cfg.macdFast}·${cfg.macdSlow}·${cfg.macdSignal}`,
      value: formatSignificant(macd.histogram),
      state: macdState,
      points: macd.points,
      help: `MACD histogram (MACD line − signal line). Crossover within the last ${cfg.macdCrossLookback} candles: ±2 · histogram above/below zero: ±1.${crossNote}`,
      advanced: false,
    },
    {
      key: 'priceVsEma50',
      name: 'Price vs EMA50',
      params: '',
      value: formatPercent(priceVsEma50.distancePct),
      state: priceVsEma50.points > 0 ? 'Above' : priceVsEma50.points < 0 ? 'Below' : 'At',
      points: priceVsEma50.points,
      help: `Price above the 50-candle EMA (${formatPrice(priceVsEma50.ema50)}): +1 · below: −1.`,
      advanced: false,
    },
    {
      key: 'trend',
      name: 'EMA20 / EMA50',
      params: '',
      value: formatPercent(gapPct),
      state: trend.state === 'up' ? 'Uptrend' : trend.state === 'down' ? 'Downtrend' : 'Level',
      points: trend.points,
      help: `EMA20 ${formatPrice(trend.ema20)} vs EMA50 ${formatPrice(trend.ema50)}. EMA20 above: +1 · below: −1.`,
      advanced: false,
    },
    {
      key: 'momentum',
      name: 'Momentum',
      params: String(momentum.period),
      value: formatPercent(momentum.changePct),
      state: momentum.state === 'up' ? 'Rising' : momentum.state === 'down' ? 'Falling' : 'Flat',
      points: momentum.points,
      help: `Price change over the last ${momentum.period} candles. Above +${cfg.momentumFlatPct}%: +1 · below −${cfg.momentumFlatPct}%: −1.`,
      advanced: true,
    },
    {
      key: 'volume',
      name: 'Volume',
      params: `vs ${cfg.volumePeriod}`,
      value: formatRatio(volume.ratio),
      state: volumeState,
      points: volume.points,
      help: `Last closed candle's volume vs the average of the ${cfg.volumePeriod} before it. Above average on an up candle: +1 · on a down candle: −1.`,
      advanced: true,
    },
  ];
}

function renderIndicators(analysis: Analysis, options: ResultOptions): HTMLElement {
  const list = h('ul', { class: 'indicator-list', attrs: { 'aria-label': 'Indicators' } });
  for (const row of indicatorRows(analysis)) {
    const locked = row.advanced && !options.showAdvanced;
    const tone = locked ? 'neutral' : toneOfNumber(row.points);
    const name = h(
      'span',
      { class: 'indicator-name' },
      row.name,
      row.params ? h('span', { class: 'params', text: ` ${row.params}` }) : null,
    );
    if (row.advanced && options.proBadges && !locked) name.append(' ', proBadge());
    list.append(
      h(
        'li',
        { class: `indicator tone-${tone}${locked ? ' locked' : ''}`, attrs: { 'data-indicator': row.key, title: locked ? 'Advanced indicators are part of Pro.' : row.help } },
        name,
        locked
          ? h('span', { class: 'indicator-value' }, h('span', { class: 'locked-value' }, icon('lock', { size: 10 }), 'Pro'))
          : h('span', { class: 'indicator-value', text: row.value }),
        locked ? h('span', { class: 'indicator-state', text: '—' }) : h('span', { class: 'indicator-state', text: row.state }),
        h('span', { class: 'indicator-points', text: locked ? '' : formatPoints(row.points), attrs: { 'aria-label': locked ? null : `${formatPoints(row.points)} points` } }),
      ),
    );
  }
  return h(
    'section',
    { class: 'block', attrs: { 'aria-labelledby': 'indicators-label' } },
    h('div', { class: 'block-head' }, h('h2', { class: 'section-label', attrs: { id: 'indicators-label' }, text: 'Indicators' }), h('span', { class: 'section-label', text: 'Points' })),
    list,
  );
}

function renderAnalysis(explanation: Explanation): HTMLElement {
  return h(
    'section',
    { class: 'block', attrs: { 'aria-labelledby': 'analysis-label' } },
    h('h2', { class: 'section-label mb-2', attrs: { id: 'analysis-label' }, text: 'Analysis' }),
    h('p', { class: 'analysis-text', attrs: { id: 'analysis-text' }, text: explanation.sentences.join(' ') }),
  );
}

function renderReasons(explanation: Explanation, tone: Tone): HTMLElement {
  const list = h('ul', { class: `reasons tone-${tone}`, attrs: { id: 'reasons' } });
  for (const reason of explanation.reasons) {
    const look: { icon: IconName; label: string; className: string } =
      reason.kind === 'support'
        ? { icon: 'checkCircleFill', label: 'Supports the signal: ', className: 'support' }
        : reason.kind === 'caution'
          ? { icon: 'exclamationTriangle', label: 'Caution: ', className: 'caution' }
          : reason.lean === 'up'
            ? { icon: 'arrowUpRight', label: 'Leans bullish: ', className: 'neutral lean-up' }
            : reason.lean === 'down'
              ? { icon: 'arrowDownRight', label: 'Leans bearish: ', className: 'neutral lean-down' }
              : { icon: 'dash', label: 'Neutral: ', className: 'neutral lean-flat' };
    list.append(
      h(
        'li',
        { class: look.className, attrs: { 'data-kind': reason.kind } },
        icon(look.icon, { size: 13 }),
        h('span', { class: 'reason-kind', text: look.label }),
        h('span', { text: reason.text }),
      ),
    );
  }
  return h(
    'section',
    { class: 'block', attrs: { 'aria-labelledby': 'reasons-label' } },
    h('h2', { class: 'section-label mb-1', attrs: { id: 'reasons-label' }, text: 'Why this signal' }),
    list,
  );
}

// --- Other states -----------------------------------------------------------------------

export interface StateAction {
  label: string;
  primary?: boolean;
  id?: string;
  disabled?: boolean;
  onClick: () => void;
}

export function renderStateCard(options: {
  kind: 'error' | 'caution' | 'locked';
  icon: IconName;
  title: string;
  body: string;
  extra?: Node | null;
  actions?: StateAction[];
  id?: string;
}): HTMLElement {
  const actions = (options.actions ?? []).map((action) =>
    h('button', {
      class: `btn btn-sm ${action.primary ? 'btn-primary' : 'btn-outline-light'}`,
      text: action.label,
      attrs: { type: 'button', id: action.id, disabled: action.disabled },
      on: { click: action.onClick },
    }),
  );
  return h(
    'section',
    { class: `state-card state-${options.kind}`, attrs: { id: options.id ?? 'state-card', role: options.kind === 'error' ? 'alert' : 'status' } },
    h('div', { class: 'state-icon' }, icon(options.icon, { size: 18 })),
    h('h2', { text: options.title }),
    h('p', { text: options.body }),
    options.extra ?? null,
    actions.length ? h('div', { class: 'd-flex gap-2 flex-wrap' }, ...actions) : null,
  );
}

export function renderNotice(options: {
  kind: 'caution' | 'snapshot' | 'info';
  icon: IconName;
  body: (Node | string)[];
  action?: StateAction;
  id?: string;
}): HTMLElement {
  return h(
    'div',
    { class: `notice notice-${options.kind}`, attrs: { id: options.id, role: options.kind === 'caution' ? 'status' : null } },
    icon(options.icon, { size: 14 }),
    h('div', { class: 'notice-body' }, ...options.body),
    options.action
      ? h('button', {
          class: `btn btn-sm notice-action ${options.action.primary ? 'btn-primary' : 'btn-outline-light'}`,
          text: options.action.label,
          attrs: { type: 'button', id: options.action.id, disabled: options.action.disabled },
          on: { click: options.action.onClick },
        })
      : null,
  );
}
