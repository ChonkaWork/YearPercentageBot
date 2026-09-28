import { assetName, DEFAULT_ASSETS } from '../core/assets';
import { canUseCoin, EARLY_ACCESS, isProCoin, planLimits, PRO_HIGHLIGHTS, PRO_PRICE, type Entitlements } from '../core/features';
import { formatAge, formatDateTime, formatFullDateTime, formatPrice } from '../core/format';
import type { HistoryEntry } from '../core/history';
import { HISTORY_LIMIT_OPTIONS, type Settings } from '../core/settings';
import { SIGNAL_TEXT } from '../core/signal';
import { PROVIDER_NAMES } from '../core/types';
import type { SearchResult } from '../data/market';
import type { SymbolMatch } from '../data/provider';
import { h } from '../ui/dom';
import { icon } from '../ui/icons';
import { shortReason } from './messages';
import { proBadge, toneOfSignal } from './render';

export function subviewHeader(title: string, onBack: () => void, ...extra: (Node | null)[]): HTMLElement {
  return h(
    'div',
    { class: 'subview-header' },
    h('button', { class: 'btn btn-icon', attrs: { type: 'button', 'aria-label': 'Back', title: 'Back', id: 'btn-back' }, on: { click: onBack } }, icon('chevronLeft', { size: 16 })),
    h('h1', { text: title }),
    ...extra,
  );
}

/** Currency signs where a coin has a well-known one; otherwise the first letter. No third-party logos. */
const COIN_GLYPHS: Readonly<Record<string, string>> = { BTC: '₿', ETH: 'Ξ', DOGE: 'Ð', ADA: '₳' };

export function coinGlyph(symbol: string): string {
  return COIN_GLYPHS[symbol] ?? symbol.slice(0, 1);
}

export function coinBadge(symbol: string, small = false): HTMLElement {
  return h('span', { class: `coin-badge${small ? ' sm' : ''}`, text: coinGlyph(symbol), attrs: { 'aria-hidden': 'true' } });
}

// --- Search -----------------------------------------------------------------------------

export interface SearchViewOptions {
  current: string;
  entitlements: Entitlements;
  proBadges: boolean;
  search: (query: string) => Promise<SearchResult>;
  onPick: (symbol: string) => void;
  onBack: () => void;
}

export const SEARCH_DEBOUNCE_MS = 250;

export function mountSearch(container: HTMLElement, options: SearchViewOptions): { focus(): void } {
  const input = h('input', {
    class: 'form-control',
    attrs: {
      id: 'search-input',
      type: 'search',
      placeholder: 'Search a coin, e.g. SOL or Solana',
      'aria-label': 'Search coins',
      autocomplete: 'off',
      spellcheck: 'false',
      maxlength: 24,
      'aria-controls': 'search-results',
    },
  });
  const spinner = h('span', { class: 'spinner-border', attrs: { role: 'status', hidden: true, 'aria-label': 'Searching' } });
  const heading = h('p', { class: 'section-label mt-3 mb-1', attrs: { id: 'search-heading' }, text: 'Popular' });
  const list = h('div', { class: 'list-group coin-list', attrs: { id: 'search-results', role: 'list', 'aria-labelledby': 'search-heading' } });
  const note = h('p', { class: 'list-note', attrs: { id: 'search-note', 'aria-live': 'polite' } });

  container.replaceChildren(
    subviewHeader('Choose a coin', options.onBack),
    h('div', { class: 'search-field' }, icon('search', { size: 14 }), input, spinner),
    heading,
    list,
    note,
  );

  const popular: SymbolMatch[] = DEFAULT_ASSETS.map((asset) => ({ symbol: asset.symbol, name: asset.name }));
  let token = 0;
  let timer: number | undefined;
  /** Quote currency of the provider that answered the last search, for names we don't know. */
  let quote: string | null = null;

  const show = (matches: SymbolMatch[], title: string, message: string) => {
    heading.textContent = title;
    note.textContent = message;
    list.replaceChildren(...matches.map((match) => coinRow(match)));
  };

  const coinRow = (match: SymbolMatch): HTMLElement => {
    const allowed = canUseCoin(match.symbol, options.entitlements);
    const current = match.symbol === options.current;
    const meta = h('span', { class: 'coin-meta' });
    if (!allowed) meta.append(h('span', { class: 'locked-value' }, icon('lock', { size: 10 }), 'Pro'));
    else if (options.proBadges && isProCoin(match.symbol)) meta.append(proBadge());
    if (current) meta.append(icon('checkCircleFill', { size: 14, class: 'text-primary' }));
    return h(
      'button',
      {
        class: 'list-group-item list-group-item-action',
        attrs: {
          type: 'button',
          role: 'listitem',
          'data-symbol': match.symbol,
          'aria-current': current ? 'true' : null,
          title: allowed ? `Analyze ${match.symbol}` : 'The Free plan covers BTC and ETH',
          disabled: !allowed,
        },
        on: { click: () => options.onPick(match.symbol) },
      },
      coinBadge(match.symbol, true),
      h(
        'span',
        { class: 'd-flex flex-column lh-sm' },
        h('span', { class: 'coin-symbol', text: match.symbol }),
        h('span', { class: 'coin-name', text: match.name ?? (quote ? `${match.symbol}/${quote} market` : assetName(match.symbol)) }),
      ),
      meta,
    );
  };

  const run = async (query: string) => {
    const mine = ++token;
    const trimmed = query.trim();
    if (!trimmed) {
      spinner.hidden = true;
      show(popular, 'Popular', '');
      return;
    }
    spinner.hidden = false;
    const result = await options.search(trimmed);
    if (mine !== token) return;
    spinner.hidden = true;
    if (result.error) {
      show(result.matches, 'Popular matches', `Search is unavailable right now (${shortReason(result.error)}). Showing matching popular coins.`);
      return;
    }
    quote = result.source === 'coinbase' ? 'USD' : 'USDT';
    const market = result.source === 'coinbase' ? 'USD markets on Coinbase' : 'USDT markets on Binance';
    show(result.matches, 'Results', result.matches.length ? market : `No ${market.replace('markets', 'market')} matches “${trimmed}”.`);
  };

  input.addEventListener('input', () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => void run(input.value), SEARCH_DEBOUNCE_MS);
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      window.clearTimeout(timer);
      void run(input.value).then(() => {
        const first = list.querySelector<HTMLButtonElement>('button:not(:disabled)');
        first?.click();
      });
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      list.querySelector<HTMLButtonElement>('button')?.focus();
    } else if (event.key === 'Escape' && input.value) {
      event.preventDefault();
      input.value = '';
      void run('');
    }
  });
  list.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const buttons = [...list.querySelectorAll<HTMLButtonElement>('button')];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'ArrowDown' ? index + 1 : index - 1;
    event.preventDefault();
    if (next < 0) input.focus();
    else buttons[Math.min(next, buttons.length - 1)]?.focus();
  });

  show(popular, 'Popular', '');
  return { focus: () => input.focus() };
}

// --- History ----------------------------------------------------------------------------

export interface HistoryViewOptions {
  items: HistoryEntry[];
  error: boolean;
  settings: Settings;
  limit: number;
  preview: boolean;
  proBadges: boolean;
  onOpen: (entry: HistoryEntry) => void;
  onDelete: (id: string) => Promise<HistoryEntry[]>;
  onClear: () => Promise<void>;
  onBack: () => void;
  onSettings: () => void;
}

export function mountHistory(container: HTMLElement, options: HistoryViewOptions): void {
  let items = options.items;
  let confirmTimer: number | undefined;

  const clear = h('button', { class: 'btn btn-sm btn-link text-body-secondary text-decoration-none px-1', text: 'Clear all', attrs: { type: 'button', id: 'history-clear' } });
  const list = h('ul', { class: 'history-list', attrs: { id: 'history-list', 'aria-label': 'Past analyses' } });
  const empty = h('div', { class: 'empty-state', attrs: { id: 'history-empty' } });
  const note = h('p', { class: 'list-note' });

  const render = () => {
    clear.hidden = items.length === 0;
    list.hidden = items.length === 0;
    empty.hidden = items.length > 0;
    list.replaceChildren(...items.map(row));
    if (!items.length) {
      const off = options.settings.historyLimit === 0;
      empty.replaceChildren(
        icon('clockHistory', { size: 28 }),
        h('p', {
          text: options.error ? "History couldn't be read from browser storage." : off ? 'History is turned off.' : 'Analyses you run show up here as dated snapshots.',
        }),
      );
      if (off) empty.append(h('button', { class: 'btn btn-sm btn-outline-light', text: 'Open settings', attrs: { type: 'button' }, on: { click: options.onSettings } }));
    }
    note.textContent = options.preview
      ? `Free keeps your last ${planLimits('free').historyItems} analyses.`
      : items.length
        ? `Keeping your last ${options.limit}. Stored only in this browser.`
        : '';
  };

  const row = (entry: HistoryEntry): HTMLElement => {
    const tone = toneOfSignal(entry.analysis.signal);
    const label = `${entry.symbol}/${entry.quote} ${entry.interval}, ${SIGNAL_TEXT[entry.analysis.signal]}, ${formatFullDateTime(entry.fetchedAt)}`;
    return h(
      'li',
      { class: 'history-item', attrs: { 'data-id': entry.id } },
      h(
        'button',
        { class: 'history-open', attrs: { type: 'button', title: `Open snapshot from ${formatFullDateTime(entry.fetchedAt)}`, 'aria-label': `Open ${label}` }, on: { click: () => options.onOpen(entry) } },
        coinBadge(entry.symbol, true),
        h(
          'span',
          { class: `history-main tone-${tone}` },
          h('span', { class: 'd-block' }, h('span', { class: 'history-pair', text: `${entry.symbol}/${entry.quote}` }), h('span', { class: 'history-interval', text: entry.interval })),
          h('span', { class: 'history-signal', text: `${SIGNAL_TEXT[entry.analysis.signal]} · ${entry.analysis.strength}%` }),
        ),
        h(
          'span',
          { class: 'history-side' },
          h('span', { class: 'history-price d-block', text: formatPrice(entry.price) }),
          h('span', { class: 'history-time', text: formatDateTime(entry.fetchedAt), attrs: { title: formatAge(entry.fetchedAt) } }),
        ),
      ),
      h(
        'button',
        {
          class: 'btn btn-icon',
          attrs: { type: 'button', 'aria-label': `Delete ${label}`, title: 'Delete' },
          on: {
            click: async () => {
              items = await options.onDelete(entry.id);
              render();
            },
          },
        },
        icon('x', { size: 12 }),
      ),
    );
  };

  clear.addEventListener('click', async () => {
    if (clear.dataset.confirm !== 'true') {
      clear.dataset.confirm = 'true';
      clear.textContent = 'Click again to clear';
      confirmTimer = window.setTimeout(() => {
        clear.dataset.confirm = '';
        clear.textContent = 'Clear all';
      }, 3000);
      return;
    }
    window.clearTimeout(confirmTimer);
    await options.onClear();
    items = [];
    clear.dataset.confirm = '';
    clear.textContent = 'Clear all';
    render();
  });

  container.replaceChildren(subviewHeader('History', options.onBack, options.proBadges ? proBadge('Full history is part of Pro later. Free during early access.') : null, clear), list, empty, note);
  render();
}

// --- Settings ---------------------------------------------------------------------------

export interface SettingsViewOptions {
  settings: Settings;
  version: string;
  onChange: (patch: Partial<Settings>) => Promise<Settings>;
  onClearHistory: () => Promise<void>;
  onClearCache: () => Promise<void>;
  onBack: () => void;
}

export function mountSettings(container: HTMLElement, options: SettingsViewOptions): void {
  const status = h('p', { class: 'save-status m-0', attrs: { id: 'save-status', role: 'status' } });
  let statusTimer: number | undefined;
  const saved = (text = 'Saved') => {
    status.textContent = text;
    status.classList.toggle('text-danger', text !== 'Saved' && !text.startsWith('Cleared'));
    window.clearTimeout(statusTimer);
    statusTimer = window.setTimeout(() => (status.textContent = ''), 2000);
  };
  const save = async (patch: Partial<Settings>) => {
    try {
      await options.onChange(patch);
      saved();
    } catch {
      saved("Couldn't save. Try again.");
    }
  };

  const detect = switchInput('setting-detect', options.settings.detectFromPage, (checked) => save({ detectFromPage: checked }));
  const preview = switchInput('setting-preview', options.settings.previewFreePlan, (checked) => save({ previewFreePlan: checked }));
  const historySelect = h(
    'select',
    { class: 'form-select form-select-sm', attrs: { id: 'setting-history' } },
    ...HISTORY_LIMIT_OPTIONS.map((value) =>
      h('option', { text: value === 0 ? 'Off' : `Last ${value}`, attrs: { value, selected: value === options.settings.historyLimit } }),
    ),
  );
  historySelect.addEventListener('change', () => void save({ historyLimit: Number(historySelect.value) }));

  const free = planLimits('free');
  const pro = planLimits('pro');
  const planRows: [string, string, string][] = [
    ['Coins', free.coins?.join(', ') ?? 'All', 'All'],
    ['Timeframes', free.timeframes.join(', '), pro.timeframes.join(', ')],
    ['Fresh analyses a day', String(free.dailyAnalyses ?? '∞'), 'Unlimited'],
    ['Momentum, volume, EMA chart', 'No', 'Yes'],
    ['History', `Last ${free.historyItems}`, `Up to ${pro.historyItems}`],
    ['Background alerts', 'No', `Up to ${pro.alerts}`],
    ['Watchlist', 'No', `Up to ${pro.watchlist} coins`],
  ];

  container.replaceChildren(
    subviewHeader('Settings', options.onBack, status),
    section(
      'Page detection',
      h('div', { class: 'form-check form-switch' }, detect, h('label', { class: 'form-check-label', attrs: { for: 'setting-detect' }, text: 'Detect the coin on the current page' })),
      h('p', {
        class: 'help',
        text: 'When you open CryptoSignal, it reads the tab’s address, title and main heading to pick the coin (for example /trade/BTC_USDT or “Solana price”). Nothing is stored or sent.',
      }),
    ),
    section(
      'History',
      h('div', { class: 'setting-row' }, h('label', { attrs: { for: 'setting-history' }, text: 'Keep analyses' }), historySelect),
      h('p', { class: 'help', text: 'Saved in this browser only (chrome.storage.local).' }),
      h('button', {
        class: 'btn btn-sm btn-outline-light mt-2',
        text: 'Clear history',
        attrs: { type: 'button', id: 'setting-clear-history' },
        on: {
          click: async () => {
            await options.onClearHistory();
            saved('Cleared history');
          },
        },
      }),
    ),
    section(
      'Market data',
      h('p', {
        class: 'help',
        text: 'Public price data from Binance (USDT pairs), with Coinbase Exchange (USD pairs) as a fallback when Binance is unavailable. No account or API key. Results are cached for 60 seconds; the refresh button always fetches new data.',
      }),
      h('button', {
        class: 'btn btn-sm btn-outline-light mt-2',
        text: 'Clear cached market data',
        attrs: { type: 'button', id: 'setting-clear-cache' },
        on: {
          click: async () => {
            await options.onClearCache();
            saved('Cleared cache');
          },
        },
      }),
    ),
    aboutPro(),
    section(
      'Plan',
      h('p', { class: 'help mb-2', text: EARLY_ACCESS ? 'Early access: every feature is unlocked. There are no payments or accounts.' : 'Free plan unless Pro is activated on this browser.' }),
      h('div', { class: 'form-check form-switch' }, preview, h('label', { class: 'form-check-label', attrs: { for: 'setting-preview' }, text: 'Preview Free plan limits' })),
      h('p', { class: 'help', text: 'Applies the limits a Free plan would have, to see how it would work.' }),
      h(
        'table',
        { class: 'plan-table' },
        h('thead', {}, h('tr', {}, h('th', { text: 'Feature' }), h('th', { text: 'Free' }), h('th', {}, proBadge(`Pro, ${PRO_PRICE} one-time`)))),
        h('tbody', {}, ...planRows.map(([name, freeValue, proValue]) => h('tr', {}, h('th', { text: name }), h('td', { text: freeValue }), h('td', { text: proValue })))),
      ),
    ),
    section(
      'About',
      h('p', {
        class: 'help',
        text: `CryptoSignal AI ${options.version}. Signals come from RSI, MACD, EMA20/EMA50, momentum and volume on the selected timeframe. The explanation is generated on your device from those numbers. It describes momentum; it does not predict prices.`,
      }),
    ),
  );
}

/** The "About Pro" card (docs/MONETIZATION.md): features, price, and a Get Pro button that stays disabled during early access. */
function aboutPro(): HTMLElement {
  return h(
    'section',
    { class: 'about-pro', attrs: { id: 'about-pro', tabindex: '-1', 'aria-labelledby': 'about-pro-title' } },
    h(
      'div',
      { class: 'about-pro-head' },
      h('h2', { attrs: { id: 'about-pro-title' } }, 'CryptoSignal ', h('span', { class: 'brand-ai', text: 'Pro' })),
      h('span', { class: 'about-pro-price', attrs: { id: 'pro-price' } }, PRO_PRICE, h('span', { text: ' one-time' })),
    ),
    h(
      'ul',
      { class: 'about-pro-list' },
      ...PRO_HIGHLIGHTS.map((item) => h('li', {}, icon('checkCircleFill', { size: 12 }), h('span', {}, h('strong', { text: item.title }), ` · ${item.detail}`))),
    ),
    h(
      'div',
      { class: 'd-flex align-items-center gap-2 flex-wrap' },
      h('button', { class: 'btn btn-sm btn-primary', text: 'Get Pro', attrs: { type: 'button', id: 'get-pro', disabled: EARLY_ACCESS, 'aria-describedby': 'pro-note' } }),
      h('span', { class: 'help m-0', attrs: { id: 'pro-note' }, text: EARLY_ACCESS ? 'Free during early access' : 'One-time payment, no subscription' }),
    ),
  );
}

function section(title: string, ...children: (Node | null)[]): HTMLElement {
  return h('section', { class: 'settings-section' }, h('h2', { class: 'section-label', text: title }), ...children);
}

function switchInput(id: string, checked: boolean, onChange: (checked: boolean) => void): HTMLInputElement {
  const input = h('input', { class: 'form-check-input', attrs: { type: 'checkbox', role: 'switch', id, checked } });
  input.addEventListener('change', () => onChange(input.checked));
  return input;
}
