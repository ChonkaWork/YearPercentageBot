import { describe, expect, it } from 'vitest';
import { addToHistory, HISTORY_MERGE_WINDOW_MS, removeFromHistory, sanitizeHistory, type HistoryEntry } from '../src/core/history';
import { sanitizeAnalysis } from '../src/core/sanitize';
import { dayKey, DEFAULT_SETTINGS, sanitizeSettings, sanitizeUiState, sanitizeUsage } from '../src/core/settings';
import { analysis, entry } from './entries';

describe('history model', () => {
  it('adds newest first and caps the list', () => {
    let items: HistoryEntry[] = [];
    for (let i = 0; i < 5; i++) items = addToHistory(items, entry(`e${i}`, { symbol: `C${i}`, fetchedAt: i * 1000 }), 3);
    expect(items.map((item) => item.id)).toEqual(['e4', 'e3', 'e2']);
    expect(addToHistory(items, entry('x'), 0)).toEqual([]);
  });

  it('replaces the newest entry for the same market within 5 minutes', () => {
    const first = entry('a', { fetchedAt: 0 });
    const soon = entry('b', { fetchedAt: HISTORY_MERGE_WINDOW_MS - 1 });
    const later = entry('c', { fetchedAt: HISTORY_MERGE_WINDOW_MS * 2 });
    expect(addToHistory([first], soon, 10).map((item) => item.id)).toEqual(['b']);
    expect(addToHistory([first], later, 10).map((item) => item.id)).toEqual(['c', 'a']);
    expect(addToHistory([first], entry('d', { fetchedAt: 10, interval: '1h' }), 10).map((item) => item.id)).toEqual(['d', 'a']);
  });

  it('removes by id', () => {
    expect(removeFromHistory([entry('a'), entry('b')], 'a').map((item) => item.id)).toEqual(['b']);
  });

  it('round-trips through storage and drops anything malformed', () => {
    const good = entry('good');
    const stored = JSON.parse(JSON.stringify([good]));
    expect(sanitizeHistory(stored)).toEqual([good]);
    const broken = [
      null,
      'x',
      { ...good, id: 7 },
      { ...good, symbol: 'btc/usdt' },
      { ...good, interval: '15m' },
      { ...good, source: 'kraken' },
      { ...good, price: Number.NaN },
      { ...good, changePct24h: 'up' },
      { ...good, analysis: { ...good.analysis, signal: 'MOON' } },
      { ...good, analysis: { ...good.analysis, score: 7 } }, // doesn't match its indicators
      { ...good, analysis: { ...good.analysis, indicators: { ...good.analysis.indicators, rsi: { value: 'x' } } } },
      { ...good, analysis: { ...good.analysis, chart: { ...good.analysis.chart, close: [1, null] } } },
      { ...good, explanation: { sentences: [], reasons: [], generator: 'x' } },
    ];
    expect(sanitizeHistory([...broken, stored[0]]).map((item) => item.id)).toEqual(['good']);
    expect(sanitizeHistory({})).toEqual([]);
  });

  it('keeps legitimately empty values (no crossover, no volume ratio, no 24h change)', () => {
    const a = analysis();
    const loose = JSON.parse(JSON.stringify({ ...a, indicators: { ...a.indicators, macd: { ...a.indicators.macd, crossAgo: null }, volume: { ...a.indicators.volume, ratio: null } } }));
    expect(sanitizeAnalysis(loose)?.indicators.volume.ratio).toBeNull();
    expect(sanitizeHistory([JSON.parse(JSON.stringify(entry('n', { changePct24h: null })))])[0]?.changePct24h).toBeNull();
  });
});

describe('settings, UI state and usage', () => {
  it('falls back per field when storage holds garbage', () => {
    expect(sanitizeSettings({ detectFromPage: 'yes', historyLimit: 999, previewFreePlan: true })).toEqual({
      detectFromPage: true,
      historyLimit: 50,
      previewFreePlan: true,
    });
    expect(sanitizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(sanitizeSettings({ historyLimit: -4 }).historyLimit).toBe(0);
    expect(sanitizeUiState({ lastSymbol: '<b>', lastInterval: '5m' })).toEqual({ lastSymbol: null, lastInterval: '4h' });
    expect(sanitizeUiState({ lastSymbol: 'SOL', lastInterval: '1d' })).toEqual({ lastSymbol: 'SOL', lastInterval: '1d' });
  });

  it('counts usage per local day', () => {
    const now = new Date(2026, 8, 27, 15).getTime();
    expect(dayKey(now)).toBe('2026-09-27');
    expect(sanitizeUsage({ day: '2026-09-27', count: 4 }, now)).toEqual({ day: '2026-09-27', count: 4 });
    expect(sanitizeUsage({ day: '2026-09-26', count: 4 }, now)).toEqual({ day: '2026-09-27', count: 0 });
    expect(sanitizeUsage({ day: '2026-09-27', count: -1 }, now)).toEqual({ day: '2026-09-27', count: 0 });
  });
});
