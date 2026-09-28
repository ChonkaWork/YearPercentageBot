import type { CompareRow } from '../../core/compare';
import { MAX_COMPARE } from '../../core/compare';
import { ALERT_BOUNDS, DEFAULT_ALERT_SETTINGS, describeAlertSettings, hasActiveAlerts, sanitizeAlertSettings, type AlertSettings } from '../../core/alerts';
import { hasFeature, watchlistLimitMessage, type Plan } from '../../core/plan';
import { formatDate, formatDateTime, formatProbability, formatUsd, plural, relativeTime } from '../../core/format';
import { SIGNAL_TEXT, signalDirection } from '../../core/momentum';
import { refreshChange, type Snapshot, type WatchItem } from '../../core/saved';
import type { SearchResult } from '../../core/types';
import { h } from '../../ui/dom';
import { icon } from '../../ui/icons';
import { delta, emptyState, errorPanel, proBadge, sectionLabel } from '../components/common';

// --- Search -------------------------------------------------------------------------------

export type SearchStatus =
  | { state: 'idle' }
  | { state: 'loading'; query: string }
  | { state: 'results'; query: string; results: SearchResult[] }
  | { state: 'error'; query: string; error: unknown };

export interface SearchViewOptions {
  query: string;
  notice: string | null;
  recent: Snapshot[];
  canGoBack: string | null;
  onInput(query: string): void;
  onOpen(result: SearchResult): void;
  onOpenSnapshotLive(snapshot: Snapshot): void;
  onBack(): void;
  onRetry(): void;
}

/** Search page shell; results are rendered into the returned `results` element. */
export function renderSearch(options: SearchViewOptions): { root: HTMLElement; input: HTMLInputElement; results: HTMLElement } {
  const input = h('input', {
    class: 'form-control',
    attrs: { type: 'search', id: 'search-input', placeholder: 'Search Polymarket markets…', 'aria-label': 'Search Polymarket markets', autocomplete: 'off', spellcheck: 'false', maxlength: '100' },
    on: { input: (event) => options.onInput((event.target as HTMLInputElement).value) },
  });
  input.value = options.query;
  const results = h('div', { attrs: { id: 'search-results', 'aria-live': 'polite' } });
  const root = h(
    'div',
    { class: 'p-3 d-grid gap-3', attrs: { 'data-view': 'search' } },
    options.canGoBack
      ? h('button', { class: 'btn btn-link btn-sm p-0 text-start d-inline-flex align-items-center gap-1 text-truncate', attrs: { type: 'button' }, on: { click: options.onBack } }, icon('arrowLeft'), h('span', { class: 'text-truncate', text: `Back to ${options.canGoBack}` }))
      : null,
    h('div', { class: 'input-group search-box' }, h('span', { class: 'input-group-text' }, icon('search')), input),
    options.notice ? h('div', { class: 'small text-body-secondary d-flex gap-2', attrs: { 'data-notice': '' } }, icon('infoCircle', 'mt-1 flex-none'), h('span', { text: options.notice })) : null,
    results,
  );
  return { root, input, results };
}

export function renderSearchResults(container: HTMLElement, status: SearchStatus, options: SearchViewOptions): void {
  container.replaceChildren();
  if (status.state === 'idle') {
    if (options.recent.length) {
      container.append(
        sectionLabel('Recently analyzed'),
        h(
          'div',
          { class: 'list-group mt-2' },
          ...options.recent.map((snapshot) =>
            h(
              'button',
              { class: 'list-group-item list-group-item-action d-flex align-items-center gap-2', attrs: { type: 'button' }, on: { click: () => options.onOpenSnapshotLive(snapshot) } },
              h('span', { class: 'flex-grow-1 min-w-0' }, h('span', { class: 'item-title', text: snapshot.title }), h('span', { class: 'item-meta', text: `${snapshot.outcome} · ${relativeTime(snapshot.savedAt)}` })),
              h('span', { class: 'num item-value', text: formatProbability(snapshot.summary.probability) }),
            ),
          ),
        ),
      );
    } else {
      container.append(emptyState({ icon: 'search', title: 'Find a market', text: 'Type at least 2 characters, e.g. “bitcoin”, “fed” or “election”.' }));
    }
    return;
  }
  if (status.state === 'loading') {
    container.append(
      h(
        'div',
        { class: 'list-group skeleton placeholder-glow', attrs: { 'aria-busy': 'true', 'data-state': 'loading' } },
        ...[0, 1, 2].map(() => h('div', { class: 'list-group-item d-grid gap-2' }, h('span', { class: 'placeholder col-10' }), h('span', { class: 'placeholder placeholder-sm col-5' }))),
      ),
    );
    return;
  }
  if (status.state === 'error') {
    container.append(errorPanel(status.error, { onRetry: options.onRetry }));
    return;
  }
  if (!status.results.length) {
    container.append(emptyState({ icon: 'search', title: 'No open markets found', text: `Nothing matched “${status.query}”. Try a shorter or different term.` }));
    return;
  }
  container.append(
    h(
      'div',
      { class: 'list-group', attrs: { 'data-state': 'results' } },
      ...status.results.map((result) => {
        const value =
          result.probability !== null
            ? h('span', { class: 'text-end' }, h('span', { class: 'num item-value d-block', text: formatProbability(result.probability) }), h('span', { class: 'item-meta', text: result.outcomeName ?? '' }))
            : result.leader
              ? h('span', { class: 'text-end', attrs: { style: 'max-width: 7.5rem' } }, h('span', { class: 'num item-value d-block', text: formatProbability(result.leader.probability) }), h('span', { class: 'item-meta d-block text-truncate', text: result.leader.label }))
              : null;
        const meta = [result.marketCount > 1 ? plural(result.marketCount, 'outcome') : null, result.volume24h !== null ? `Vol 24h ${formatUsd(result.volume24h)}` : null, result.endDate ? `Ends ${formatDate(result.endDate)}` : null]
          .filter(Boolean)
          .join(' · ');
        return h(
          'button',
          { class: 'list-group-item list-group-item-action d-flex align-items-center gap-3', attrs: { type: 'button', 'data-result': result.eventSlug }, on: { click: () => options.onOpen(result) } },
          h('span', { class: 'flex-grow-1 min-w-0' }, h('span', { class: 'item-title', text: result.title }), h('span', { class: 'item-meta', text: meta })),
          value,
        );
      }),
    ),
  );
}

// --- Watchlist ----------------------------------------------------------------------------

export interface WatchlistViewOptions {
  items: WatchItem[];
  /** Plan limit (Infinity = none). */
  limit: number;
  plan: Plan;
  refreshing: boolean;
  errors: Map<string, unknown>;
  /** Key of the item whose alert settings are open. */
  editing: string | null;
  alertPeriodMinutes: number;
  onOpen(item: WatchItem): void;
  onRemove(item: WatchItem): void;
  onRefresh(): void;
  onSearch(): void;
  onToggleEditor(item: WatchItem): void;
  onAlertSettings(item: WatchItem, settings: AlertSettings): void;
  onAboutPro(): void;
}

/** "Free keeps 5 markets… Pro removes the limit. About Pro" */
export function limitNote(text: string, onAboutPro: () => void): HTMLElement {
  return h(
    'div',
    { class: 'small text-body-secondary d-flex gap-2', attrs: { 'data-limit': '' } },
    icon('infoCircle', 'flex-none mt-1'),
    h(
      'span',
      {},
      `${text} `,
      h('button', { class: 'btn btn-link btn-sm p-0 align-baseline border-0', text: 'About Pro', attrs: { type: 'button', 'data-action': 'about-pro' }, on: { click: onAboutPro } }),
    ),
  );
}

export function renderWatchlist(options: WatchlistViewOptions): HTMLElement {
  const root = h('div', { class: 'p-3 d-grid gap-3', attrs: { 'data-view': 'watchlist' } });
  if (!options.items.length) {
    root.append(
      emptyState({
        icon: 'star',
        title: 'Your watchlist is empty',
        text: 'Add markets with the star on any analysis. The list stays in this browser.',
        action: { label: 'Search markets', onClick: options.onSearch },
      }),
    );
    return root;
  }
  const limited = Number.isFinite(options.limit);
  root.append(
    h(
      'div',
      { class: 'd-flex align-items-center justify-content-between' },
      sectionLabel('Watchlist', h('span', { class: 'num text-body-secondary', text: limited ? `${options.items.length}/${options.limit}` : String(options.items.length) })),
      h(
        'button',
        { class: `btn btn-sm btn-outline-secondary d-inline-flex align-items-center gap-1 ${options.refreshing ? 'disabled' : ''}`, attrs: { type: 'button', 'data-action': 'refresh-watchlist' }, on: { click: options.onRefresh } },
        options.refreshing ? h('span', { class: 'spinner-border spinner-border-sm', attrs: { 'aria-hidden': 'true' } }) : icon('arrowClockwise'),
        options.refreshing ? 'Refreshing…' : 'Refresh',
      ),
    ),
  );
  if (limited && options.items.length >= options.limit) root.append(limitNote(watchlistLimitMessage(options.limit), options.onAboutPro));
  const alertsAllowed = hasFeature(options.plan, 'alerts');
  root.append(
    h(
      'div',
      { class: 'list-group' },
      ...options.items.map((item) => {
        const change = refreshChange(item);
        const error = options.errors.get(item.key);
        const checked = item.last ? `checked ${relativeTime(item.last.at)}` : 'not checked yet';
        const active = alertsAllowed && hasActiveAlerts(item.alertSettings);
        const editing = options.editing === item.key;
        const editorId = `alerts-${item.key.replace(/[^a-z0-9]/gi, '-')}`;
        return h(
          'div',
          { class: `list-group-item p-0 ${editing ? 'is-editing' : ''}`, attrs: { 'data-watch': item.key, 'data-alerts-on': String(active) } },
          h(
            'div',
            { class: 'd-flex align-items-stretch' },
            h(
              'button',
              { class: 'btn text-start flex-grow-1 min-w-0 d-flex align-items-center gap-2 px-3 py-2 border-0 rounded-0', attrs: { type: 'button', 'aria-label': `Analyze ${item.title}` }, on: { click: () => options.onOpen(item) } },
              h('span', { class: 'flex-grow-1 min-w-0' }, h('span', { class: 'item-title', text: item.title }), h('span', { class: 'item-meta', text: `${item.outcome} · ${checked}` })),
              h(
                'span',
                { class: 'text-end flex-none' },
                h('span', { class: 'num item-value d-block', text: formatProbability(item.last?.probability ?? null), attrs: { 'data-value': 'probability' } }),
                change !== null ? delta(change, { className: 'small' }) : null,
              ),
            ),
            h(
              'button',
              {
                class: `btn btn-icon rounded-0 px-2 ${active ? 'text-primary-emphasis' : ''}`,
                attrs: {
                  type: 'button',
                  'data-action': 'alert-settings',
                  'aria-label': `Alert settings for ${item.title}`,
                  'aria-expanded': String(editing),
                  'aria-controls': editing ? editorId : undefined,
                  title: active ? `Alerts on: ${describeAlertSettings(item.alertSettings)}` : 'Alert settings',
                },
                on: { click: () => options.onToggleEditor(item) },
              },
              icon(active ? 'bellFill' : 'bell'),
            ),
            h('button', { class: 'btn btn-icon rounded-0 px-2', attrs: { type: 'button', 'aria-label': `Remove ${item.title} from watchlist`, title: 'Remove' }, on: { click: () => options.onRemove(item) } }, icon('xLg')),
          ),
          error ? h('div', { class: 'px-3 pb-2 small text-warning', text: "Couldn't refresh this market." }) : null,
          alertsAllowed && item.alerts.length
            ? h('div', { class: 'px-3 pb-2 d-flex flex-wrap gap-1', attrs: { 'data-alerts': '' } }, ...item.alerts.map((message) => h('span', { class: 'alert-chip' }, icon('activity'), message)))
            : null,
          editing ? alertEditor(item, editorId, alertsAllowed, options) : null,
        );
      }),
    ),
  );
  root.append(
    h('p', {
      class: 'small text-body-secondary mb-0',
      text: alertsAllowed
        ? `Arrows show the change since the previous check. The bell sets background alerts for a market: checked every ${options.alertPeriodMinutes} min while Chrome is running.`
        : 'Arrows show the change since the previous refresh.',
    }),
  );
  return root;
}

/** Per-market alert settings, saved on every change. */
function alertEditor(item: WatchItem, id: string, allowed: boolean, options: WatchlistViewOptions): HTMLElement {
  const root = h('div', { class: 'alert-editor', attrs: { id, 'data-alert-editor': item.key, role: 'group', 'aria-label': `Alerts for ${item.title}` } });
  if (!allowed) {
    root.append(
      h('div', { class: 'd-flex align-items-center gap-2 mb-1' }, sectionLabel('Background alerts'), proBadge()),
      limitNote('Background alerts are part of Pro: a notification when this market moves more than your threshold.', options.onAboutPro),
    );
    return root;
  }
  const settings = item.alertSettings;
  const uid = id;
  const enabled = h('input', { class: 'form-check-input', attrs: { type: 'checkbox', role: 'switch', id: `${uid}-on`, 'data-field': 'enabled' } });
  enabled.checked = settings.enabled;
  const moveOn = h('input', { class: 'form-check-input', attrs: { type: 'checkbox', id: `${uid}-move-on`, 'data-field': 'move-on' } });
  moveOn.checked = settings.movePp !== null;
  const move = h('input', {
    class: 'form-control form-control-sm num threshold',
    attrs: { type: 'number', inputmode: 'decimal', min: String(ALERT_BOUNDS.movePp.min), max: String(ALERT_BOUNDS.movePp.max), step: String(ALERT_BOUNDS.movePp.step), id: `${uid}-move`, 'aria-label': 'Probability move threshold in percentage points', 'data-field': 'move' },
  });
  move.value = String(settings.movePp ?? DEFAULT_ALERT_SETTINGS.movePp);
  const volumeOn = h('input', { class: 'form-check-input', attrs: { type: 'checkbox', id: `${uid}-volume-on`, 'data-field': 'volume-on' } });
  volumeOn.checked = settings.volumePct !== null;
  const volume = h('input', {
    class: 'form-control form-control-sm num threshold',
    attrs: { type: 'number', inputmode: 'numeric', min: String(ALERT_BOUNDS.volumePct.min), max: String(ALERT_BOUNDS.volumePct.max), step: String(ALERT_BOUNDS.volumePct.step), id: `${uid}-volume`, 'aria-label': '24h volume increase threshold in percent', 'data-field': 'volume' },
  });
  volume.value = String(settings.volumePct ?? DEFAULT_ALERT_SETTINGS.volumePct);
  const flip = h('input', { class: 'form-check-input', attrs: { type: 'checkbox', id: `${uid}-flip`, 'data-field': 'flip' } });
  flip.checked = settings.momentumFlip;

  const rules = h('fieldset', { class: 'd-grid gap-2 mt-2' }, h('legend', { class: 'visually-hidden', text: 'Alert rules' }));
  const sync = () => {
    rules.disabled = !enabled.checked;
    move.disabled = !moveOn.checked;
    volume.disabled = !volumeOn.checked;
  };
  const save = () => {
    sync();
    options.onAlertSettings(
      item,
      sanitizeAlertSettings({ enabled: enabled.checked, movePp: moveOn.checked ? move.value : null, volumePct: volumeOn.checked ? volume.value : null, momentumFlip: flip.checked }),
    );
  };
  for (const input of [enabled, moveOn, move, volumeOn, volume, flip]) input.addEventListener('change', save);

  const ruleRow = (box: HTMLInputElement, label: string, field: HTMLInputElement | null, unit: string | null) =>
    h(
      'div',
      { class: 'd-flex align-items-center gap-2' },
      h('div', { class: 'form-check mb-0 flex-grow-1' }, box, h('label', { class: 'form-check-label', text: label, attrs: { for: box.id } })),
      field,
      unit ? h('span', { class: 'small text-body-secondary unit', text: unit }) : null,
    );
  rules.append(
    ruleRow(moveOn, 'Probability moves more than', move, 'pp'),
    ruleRow(volumeOn, '24h volume up more than', volume, '%'),
    ruleRow(flip, 'Momentum flips (positive ↔ negative)', null, null),
  );
  sync();
  root.append(
    h('div', { class: 'form-check form-switch mb-0' }, enabled, h('label', { class: 'form-check-label fw-semibold', attrs: { for: enabled.id } }, 'Background alerts ', proBadge())),
    rules,
    h('div', { class: 'small text-body-secondary mt-2', text: `Compared with the previous check. Notifications show the market and the numbers only.` }),
  );
  return root;
}

// --- History ------------------------------------------------------------------------------

export interface HistoryViewOptions {
  snapshots: Snapshot[];
  limit: number;
  confirmClear: boolean;
  onOpen(snapshot: Snapshot): void;
  onDelete(snapshot: Snapshot): void;
  onClear(): void;
  onSearch(): void;
}

export function renderHistory(options: HistoryViewOptions): HTMLElement {
  const root = h('div', { class: 'p-3 d-grid gap-3', attrs: { 'data-view': 'history' } });
  if (!options.snapshots.length) {
    root.append(emptyState({ icon: 'clockHistory', title: 'No analyses yet', text: 'Every market you analyze is saved here as a dated snapshot, in this browser only.', action: { label: 'Search markets', onClick: options.onSearch } }));
    return root;
  }
  root.append(
    h(
      'div',
      { class: 'd-flex align-items-center justify-content-between' },
      sectionLabel('Recent analyses', h('span', { class: 'num text-body-secondary', text: `${options.snapshots.length}/${options.limit}` })),
      h('button', { class: `btn btn-sm ${options.confirmClear ? 'btn-danger' : 'btn-outline-secondary'}`, text: options.confirmClear ? 'Click again to clear' : 'Clear all', attrs: { type: 'button', 'data-action': 'clear-history' }, on: { click: options.onClear } }),
    ),
  );
  root.append(
    h(
      'div',
      { class: 'list-group' },
      ...options.snapshots.map((snapshot) => {
        const direction = signalDirection(snapshot.summary.signal);
        return h(
          'div',
          { class: 'list-group-item p-0', attrs: { 'data-snapshot': snapshot.id } },
          h(
            'div',
            { class: 'd-flex align-items-stretch' },
            h(
              'button',
              { class: 'btn text-start flex-grow-1 min-w-0 d-flex align-items-center gap-2 px-3 py-2 border-0 rounded-0', attrs: { type: 'button', 'aria-label': `Open snapshot of ${snapshot.title}` }, on: { click: () => options.onOpen(snapshot) } },
              h(
                'span',
                { class: 'flex-grow-1 min-w-0' },
                h('span', { class: 'item-title', text: snapshot.title }),
                h('span', { class: 'item-meta d-flex align-items-center gap-1 flex-wrap' }, `${snapshot.outcome} · ${formatDateTime(snapshot.savedAt)} · `, h('span', { class: `text-${direction} fw-semibold`, text: snapshot.summary.signal ? SIGNAL_TEXT[snapshot.summary.signal].replace(' MOMENTUM', '').toLowerCase() : 'no signal' })),
              ),
              h('span', { class: 'num item-value flex-none', text: formatProbability(snapshot.summary.probability) }),
            ),
            h('button', { class: 'btn btn-icon rounded-0 px-2', attrs: { type: 'button', 'aria-label': `Delete snapshot of ${snapshot.title}`, title: 'Delete' }, on: { click: () => options.onDelete(snapshot) } }, icon('trash3')),
          ),
        );
      }),
    ),
  );
  return root;
}

// --- Compare ------------------------------------------------------------------------------

export interface CompareCandidate {
  key: string;
  title: string;
  outcome: string;
  source: 'watchlist' | 'recent';
}

export interface CompareViewOptions {
  plan: Plan;
  candidates: CompareCandidate[];
  selected: string[];
  status: { state: 'idle' } | { state: 'loading' } | { state: 'ready'; headers: { title: string; outcome: string; error?: string }[]; rows: CompareRow[] };
  onToggle(key: string): void;
  onSearch(): void;
  onAboutPro(): void;
}

export function renderCompare(options: CompareViewOptions): HTMLElement {
  const root = h('div', { class: 'p-3 d-grid gap-3', attrs: { 'data-view': 'compare' } });
  root.append(h('div', { class: 'd-flex align-items-center gap-2' }, sectionLabel('Compare markets'), proBadge()));
  if (!hasFeature(options.plan, 'compare')) {
    root.append(
      emptyState({
        icon: 'lockFill',
        title: 'The compare view is part of Pro',
        text: 'Compare probability, changes, volume, liquidity and momentum of 2–3 markets side by side.',
        action: { label: 'About Pro', onClick: options.onAboutPro },
      }),
    );
    return root;
  }
  if (options.candidates.length < 2) {
    root.append(emptyState({ icon: 'layoutThreeColumns', title: 'Nothing to compare yet', text: 'Watch or analyze at least two markets, then compare them here side by side.', action: { label: 'Search markets', onClick: options.onSearch } }));
    return root;
  }

  const full = options.selected.length >= MAX_COMPARE;
  root.append(
    h(
      'fieldset',
      { class: 'card' },
      h('legend', { class: 'visually-hidden', text: 'Markets to compare' }),
      h('div', { class: 'card-header py-2 small text-body-secondary', text: `Pick 2–${MAX_COMPARE} markets from your watchlist and recent analyses.` }),
      h(
        'div',
        { class: 'list-group list-group-flush' },
        ...options.candidates.map((candidate) => {
          const checked = options.selected.includes(candidate.key);
          const id = `cmp-${candidate.key.replace(/[^a-z0-9]/gi, '-')}`;
          const box = h('input', { class: 'form-check-input flex-none m-0', attrs: { type: 'checkbox', id, 'data-compare': candidate.key } });
          box.checked = checked;
          box.disabled = !checked && full;
          box.addEventListener('change', () => options.onToggle(candidate.key));
          return h(
            'label',
            { class: `list-group-item d-flex align-items-center gap-2 ${box.disabled ? 'text-body-secondary' : ''}`, attrs: { for: id } },
            box,
            h('span', { class: 'flex-grow-1 min-w-0' }, h('span', { class: 'item-title', text: candidate.title }), h('span', { class: 'item-meta', text: `${candidate.outcome} · ${candidate.source === 'watchlist' ? 'watchlist' : 'recent'}` })),
          );
        }),
      ),
    ),
  );

  const { status } = options;
  if (status.state === 'loading') {
    root.append(h('div', { class: 'd-flex align-items-center gap-2 small text-body-secondary', attrs: { 'data-state': 'loading' } }, h('span', { class: 'spinner-border spinner-border-sm' }), 'Loading market data…'));
  } else if (status.state === 'ready') {
    root.append(
      h(
        'section',
        { class: 'card', attrs: { 'data-section': 'comparison' } },
        h(
          'table',
          { class: 'table compare-table' },
          h('thead', {}, h('tr', {}, h('th', { attrs: { scope: 'col' } }, h('span', { class: 'visually-hidden', text: 'Metric' })), ...status.headers.map((header) => h('th', { attrs: { scope: 'col' } }, h('span', { class: 'd-block', text: header.title }), h('span', { class: 'item-meta fw-normal', text: header.error ?? header.outcome }))))),
          h(
            'tbody',
            {},
            ...status.rows.map((row) =>
              h(
                'tr',
                {},
                h('th', { attrs: { scope: 'row' }, text: row.label }),
                ...row.cells.map((cell) =>
                  h(
                    'td',
                    { class: `${cell.label ? 'fw-semibold' : 'num'} ${cell.tone === 'muted' ? 'text-body-secondary' : `text-${cell.tone === 'flat' ? 'body-emphasis' : cell.tone}`}` },
                    h('span', { class: 'd-block', text: cell.text }),
                    cell.sub ? h('span', { class: 'num small text-body-secondary fw-normal', text: cell.sub }) : null,
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
    root.append(h('p', { class: 'small text-body-secondary mb-0', text: 'Side-by-side market data, not a ranking or a recommendation. Momentum describes recent price movement only.' }));
  } else {
    root.append(h('p', { class: 'small text-body-secondary mb-0', text: 'Select at least two markets.' }));
  }
  return root;
}
