import { describe, expect, it } from 'vitest';
import type { AlertRule, AlertSnapshot } from '../src/core/alerts';
import {
  addToWatchlist,
  evaluateMarket,
  isRuleReady,
  marketsToCheck,
  needsSchedule,
  pruneMonitorState,
  putSnapshot,
  removeFromWatchlist,
  sanitizeBaselines,
  sanitizeMonitorState,
  sanitizeSnapshotMap,
  sanitizeWatchlist,
  type MarketSnapshot,
  type MonitorState,
} from '../src/core/monitor';

const rule = (id: string, patch: Partial<AlertRule> = {}): AlertRule => ({
  id,
  symbol: 'BTC',
  interval: '4h',
  condition: { type: 'signal-changed' },
  enabled: true,
  createdAt: 100,
  ...patch,
});
const snap = (patch: Partial<AlertSnapshot> = {}): AlertSnapshot => ({ symbol: 'BTC', interval: '4h', signal: 'NEUTRAL', strength: 0, price: 100, rsi: 50, at: 1000, ...patch });
const state = (patch: Partial<MonitorState> = {}): MonitorState => ({ lastRunAt: null, lastCheckedAt: {}, triggers: {}, lastProblem: null, ...patch });

describe('background check planning', () => {
  it('checks each market once, least recently checked first, capped', () => {
    const rules = [rule('a'), rule('b', { condition: { type: 'rsi-crosses', level: 70, direction: 'above' } }), rule('c', { symbol: 'ETH' }), rule('d', { symbol: 'SOL', enabled: false })];
    const watch = [{ symbol: 'DOGE', interval: '1h' as const, addedAt: 0 }, { symbol: 'BTC', interval: '4h' as const, addedAt: 0 }];
    expect(marketsToCheck(rules, watch, state())).toEqual([
      { symbol: 'BTC', interval: '4h' },
      { symbol: 'ETH', interval: '4h' },
      { symbol: 'DOGE', interval: '1h' },
    ]);
    expect(marketsToCheck(rules, watch, state({ lastCheckedAt: { 'BTC:4h': 5, 'ETH:4h': 9 } }), 2)).toEqual([
      { symbol: 'DOGE', interval: '1h' },
      { symbol: 'BTC', interval: '4h' },
    ]);
    expect(marketsToCheck([], [], state())).toEqual([]);
  });

  it('schedules only when there is something the plan allows', () => {
    const watch = [{ symbol: 'BTC', interval: '4h' as const }];
    expect(needsSchedule([rule('a')], [], true, true)).toBe(true);
    expect(needsSchedule([rule('a', { enabled: false })], [], true, true)).toBe(false);
    expect(needsSchedule([], watch, true, true)).toBe(true);
    expect(needsSchedule([rule('a')], watch, false, false)).toBe(false);
    expect(needsSchedule([rule('a')], [], false, true)).toBe(false);
  });

  it('a rule compares only against a baseline recorded after it started watching', () => {
    const baseline = { snapshot: snap(), recordedAt: 150 };
    expect(isRuleReady(rule('a'), null)).toBe(false);
    expect(isRuleReady(rule('a'), baseline)).toBe(true);
    expect(isRuleReady(rule('a', { createdAt: 200 }), baseline)).toBe(false);
    expect(isRuleReady(rule('a', { since: 200 }), baseline)).toBe(false);
    const current = snap({ signal: 'BEARISH', at: 2000 });
    expect(evaluateMarket([rule('a'), rule('b', { createdAt: 200 }), rule('c', { enabled: false }), rule('d', { symbol: 'ETH' })], baseline, current).map((e) => e.ruleId)).toEqual(['a']);
    expect(evaluateMarket([rule('a')], null, current)).toEqual([]);
  });

  it('prunes state of deleted alerts and markets', () => {
    const pruned = pruneMonitorState(state({ lastCheckedAt: { 'BTC:4h': 1, 'ETH:4h': 2 }, triggers: { a: { at: 1, message: 'm' }, gone: { at: 1, message: 'm' } } }), [rule('a')], []);
    expect(pruned.lastCheckedAt).toEqual({ 'BTC:4h': 1 });
    expect(Object.keys(pruned.triggers)).toEqual(['a']);
  });
});

describe('watchlist and stored state', () => {
  it('adds newest first within the limit, without duplicates', () => {
    let result = addToWatchlist([], { symbol: 'BTC', interval: '4h' }, 2, 1);
    expect(result).toEqual({ ok: true, items: [{ symbol: 'BTC', interval: '4h', addedAt: 1 }] });
    if (!result.ok) throw new Error();
    expect(addToWatchlist(result.items, { symbol: 'BTC', interval: '4h' }, 2, 2)).toEqual({ ok: false, error: 'BTC 4h is already on your watchlist.' });
    result = addToWatchlist(result.items, { symbol: 'ETH', interval: '1d' }, 2, 2);
    if (!result.ok) throw new Error();
    expect(result.items.map((item) => item.symbol)).toEqual(['ETH', 'BTC']);
    expect(addToWatchlist(result.items, { symbol: 'SOL', interval: '4h' }, 2, 3)).toEqual({ ok: false, error: 'Your watchlist holds 2 coins. Remove one to add another.' });
    expect(addToWatchlist([], { symbol: 'SOL', interval: '4h' }, 0, 3).ok).toBe(false);
    expect(removeFromWatchlist(result.items, { symbol: 'ETH', interval: '1d' })).toHaveLength(1);
  });

  it('sanitizes the watchlist, snapshots, baselines and monitor state', () => {
    expect(sanitizeWatchlist([{ symbol: 'BTC', interval: '4h', addedAt: 1 }, { symbol: 'BTC', interval: '4h', addedAt: 2 }, { symbol: 'x', interval: '4h', addedAt: 1 }, 5])).toEqual([
      { symbol: 'BTC', interval: '4h', addedAt: 1 },
    ]);
    const snapshot: MarketSnapshot = { ...snap(), quote: 'USDT', source: 'binance' };
    expect(sanitizeSnapshotMap({ 'BTC:4h': snapshot, 'ETH:4h': snapshot, 'SOL:4h': { ...snapshot, symbol: 'SOL', source: 'kraken' } })).toEqual({ 'BTC:4h': snapshot });
    expect(sanitizeBaselines({ 'BTC:4h': { snapshot: snap(), recordedAt: 5 }, 'ETH:4h': { snapshot: snap(), recordedAt: 5 }, bad: 1 })).toEqual({ 'BTC:4h': { snapshot: snap(), recordedAt: 5 } });
    expect(sanitizeMonitorState(null)).toEqual(state());
    expect(sanitizeMonitorState({ lastRunAt: 5, lastCheckedAt: { a: 1, b: 'x' }, triggers: { r: { at: 1, message: 'm' }, s: { at: 'x' } }, lastProblem: 3 })).toEqual(
      state({ lastRunAt: 5, lastCheckedAt: { a: 1 }, triggers: { r: { at: 1, message: 'm' } } }),
    );
  });

  it('keeps the newest snapshot per market', () => {
    const older: MarketSnapshot = { ...snap({ at: 1 }), quote: 'USDT', source: 'binance' };
    const newer: MarketSnapshot = { ...older, signal: 'BEARISH', at: 2 };
    expect(putSnapshot(putSnapshot({}, newer), older)['BTC:4h']).toEqual(newer);
    expect(putSnapshot({ 'BTC:4h': older }, newer)['BTC:4h']).toEqual(newer);
    let map = {};
    for (let i = 0; i < 70; i++) map = putSnapshot(map, { ...older, symbol: `C${i}`, at: i });
    expect(Object.keys(map)).toHaveLength(64);
    expect(map).not.toHaveProperty('C0:4h');
  });
});
