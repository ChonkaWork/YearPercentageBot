import { changeDirection, formatPp } from '../../core/format';
import { EARLY_ACCESS } from '../../core/plan';
import type { LiquidityLevel, VolatilityLevel, VolumeLevel } from '../../core/metrics';
import type { DataErrorCode } from '../../data/errors';
import { describeError, isDataError } from '../../data/errors';
import { h } from '../../ui/dom';
import { icon, type IconName } from '../../ui/icons';

/** "+3.1 pp" with a caret, coloured by direction. */
export function delta(change: number | null, options: { suffix?: string; className?: string } = {}): HTMLElement {
  const direction = changeDirection(change);
  const caret = direction === 'up' ? icon('caretUpFill') : direction === 'down' ? icon('caretDownFill') : null;
  return h(
    'span',
    { class: `delta num text-${direction} ${options.className ?? ''}`.trim() },
    caret,
    formatPp(change) + (options.suffix ? ` ${options.suffix}` : ''),
  );
}

export function proBadge(): HTMLElement {
  return h('span', { class: 'pro-badge', text: 'PRO', attrs: { title: EARLY_ACCESS ? 'Pro feature, free during early access' : 'Pro feature' } });
}

export function sectionLabel(text: string, ...extra: (Node | null | false)[]): HTMLElement {
  return h('div', { class: 'section-label d-flex align-items-center gap-2' }, h('span', { text }), ...extra);
}

const VOLUME_TEXT: Record<VolumeLevel, string> = { LOW: 'LOW', NORMAL: 'NORMAL', HIGH: 'HIGH', VERY_HIGH: 'VERY HIGH', UNKNOWN: 'N/A' };

export function volumeBadge(level: VolumeLevel): HTMLElement {
  const tone = level === 'HIGH' || level === 'VERY_HIGH' ? 'is-info' : level === 'LOW' ? 'is-warn' : '';
  return h('span', { class: `level-badge ${tone}`, text: VOLUME_TEXT[level], attrs: { title: 'Volume activity: last 24 h vs. the 7-day daily average' } });
}

export function liquidityBadge(level: LiquidityLevel): HTMLElement {
  const tone = level === 'HIGH' ? 'is-up' : level === 'LOW' ? 'is-warn' : '';
  return h('span', { class: `level-badge ${tone}`, text: level === 'UNKNOWN' ? 'N/A' : level, attrs: { title: 'LOW < $10K · MEDIUM < $100K · HIGH ≥ $100K' } });
}

export function volatilityBadge(level: VolatilityLevel): HTMLElement {
  const tone = level === 'ELEVATED' || level === 'EXTREME' ? 'is-warn' : '';
  return h('span', { class: `level-badge ${tone}`, text: level === 'UNKNOWN' ? 'N/A' : level, attrs: { title: 'Standard deviation of hourly price changes' } });
}

export function emptyState(options: { icon: IconName; title: string; text: string; action?: { label: string; onClick: () => void } }): HTMLElement {
  return h(
    'div',
    { class: 'empty-state' },
    h('div', { class: 'empty-icon' }, icon(options.icon)),
    h('div', { class: 'empty-title', text: options.title }),
    h('div', { class: 'small', text: options.text }),
    options.action
      ? h('button', { class: 'btn btn-primary btn-sm mt-1', text: options.action.label, attrs: { type: 'button' }, on: { click: options.action.onClick } })
      : null,
  );
}

const ERROR_ICONS: Record<DataErrorCode, IconName> = {
  NETWORK: 'wifiOff',
  TIMEOUT: 'hourglassSplit',
  RATE_LIMITED: 'hourglassSplit',
  NOT_FOUND: 'questionCircle',
  UNAVAILABLE: 'cloudSlash',
  INVALID_RESPONSE: 'fileEarmarkX',
  UNSUPPORTED_MARKET: 'slashCircle',
  MISSING_HISTORY: 'barChartLine',
};

/** Designed error state: what happened, what to do. Never shows an analysis. */
export function errorPanel(error: unknown, actions: { onRetry?: () => void; onSearch?: () => void }): HTMLElement {
  const description = describeError(error);
  const iconName: IconName = isDataError(error) ? ERROR_ICONS[error.code] : 'exclamationOctagon';
  const tone = isDataError(error) && (error.code === 'UNSUPPORTED_MARKET' || error.code === 'NOT_FOUND') ? 'alert-secondary' : 'alert-danger';
  return h(
    'div',
    { class: `alert ${tone} error-panel mb-0`, attrs: { role: 'alert', 'data-error': isDataError(error) ? error.code : 'UNKNOWN' } },
    h('div', { class: 'd-flex align-items-start gap-2' }, icon(iconName, 'mt-1'), h('div', {}, h('div', { class: 'alert-heading', text: description.title }), h('div', { class: 'small mt-1', text: description.message }))),
    h(
      'div',
      { class: 'd-flex gap-2 mt-3' },
      description.retry && actions.onRetry ? h('button', { class: 'btn btn-sm btn-primary', text: 'Try again', attrs: { type: 'button' }, on: { click: actions.onRetry } }) : null,
      description.search && actions.onSearch ? h('button', { class: 'btn btn-sm btn-outline-secondary', text: 'Search markets', attrs: { type: 'button' }, on: { click: actions.onSearch } }) : null,
    ),
  );
}

export function loadingSkeleton(label: string): HTMLElement {
  const bar = (cols: string, extra = '') => h('span', { class: `placeholder ${cols} ${extra}`.trim() });
  return h(
    'div',
    { class: 'skeleton placeholder-glow p-3 d-grid gap-3', attrs: { 'aria-busy': 'true', 'data-state': 'loading' } },
    h('div', { class: 'd-flex align-items-center gap-2 small text-body-secondary' }, h('span', { class: 'spinner-border spinner-border-sm text-primary', attrs: { 'aria-hidden': 'true' } }), h('span', { text: label })),
    h('div', { class: 'd-grid gap-2' }, bar('col-4', 'placeholder-xs'), bar('col-11', 'placeholder-lg'), bar('col-7', 'placeholder-sm')),
    h('div', { class: 'hero d-grid gap-2' }, bar('col-3', 'placeholder-sm'), bar('col-5', 'placeholder-lg'), bar('col-12', 'placeholder-xs')),
    h('div', { class: 'hero d-grid gap-2' }, bar('col-6'), bar('col-12', 'placeholder-xs')),
    h('div', { class: 'hero', attrs: { style: 'height: 150px' } }),
    h('div', { class: 'd-grid gap-2' }, bar('col-12', 'placeholder-sm'), bar('col-12', 'placeholder-sm'), bar('col-9', 'placeholder-sm')),
  );
}
