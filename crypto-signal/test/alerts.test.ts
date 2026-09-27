import { describe, expect, it } from 'vitest';
import { evaluateAlert, evaluateAlerts, toAlertSnapshot, type AlertRule, type AlertSnapshot } from '../src/core/alerts';
import { analyze } from '../src/core/signal';
import { afterLast, candlesFromCloses, walk } from './helpers';

const base: AlertSnapshot = { symbol: 'BTC', interval: '4h', signal: 'NEUTRAL', strength: 13, price: 64000, rsi: 52, at: 1_000 };
const rule = (condition: AlertRule['condition'], extra: Partial<AlertRule> = {}): AlertRule => ({
  id: 'r1',
  symbol: 'BTC',
  interval: '4h',
  condition,
  enabled: true,
  createdAt: 0,
  ...extra,
});
const next = (patch: Partial<AlertSnapshot>): AlertSnapshot => ({ ...base, at: 2_000, ...patch });

describe('alert evaluation', () => {
  it('fires on a signal change, once', () => {
    const changed = next({ signal: 'BULLISH', strength: 38 });
    expect(evaluateAlert(rule({ type: 'signal-changed' }), base, changed)).toEqual({
      ruleId: 'r1',
      symbol: 'BTC',
      interval: '4h',
      message: 'BTC (4h) signal changed from Neutral to Bullish.',
      at: 2_000,
    });
    expect(evaluateAlert(rule({ type: 'signal-changed' }), changed, { ...changed, at: 3_000 })).toBeNull();
  });

  it('fires when the signal becomes one of the targets', () => {
    const r = rule({ type: 'signal-becomes', signals: ['BULLISH', 'STRONG_BULLISH'] });
    expect(evaluateAlert(r, base, next({ signal: 'STRONG_BULLISH' }))?.message).toBe('BTC (4h) signal is now Strong bullish.');
    expect(evaluateAlert(r, next({ signal: 'BULLISH' }), next({ signal: 'STRONG_BULLISH', at: 3_000 }))).toBeNull();
    expect(evaluateAlert(r, base, next({ signal: 'BEARISH' }))).toBeNull();
  });

  it('fires when strength reaches a threshold', () => {
    const r = rule({ type: 'strength-at-least', strength: 60 });
    expect(evaluateAlert(r, base, next({ strength: 63, signal: 'STRONG_BULLISH' }))?.message).toBe('BTC (4h) signal strength reached 63% (Strong bullish).');
    expect(evaluateAlert(r, next({ strength: 63 }), next({ strength: 75, at: 3_000 }))).toBeNull();
  });

  it('fires on RSI and price crossings in the right direction only', () => {
    const rsiBelow = rule({ type: 'rsi-crosses', level: 30, direction: 'below' });
    expect(evaluateAlert(rsiBelow, next({ rsi: 31, at: 1_000 }), next({ rsi: 28.4 }))?.message).toBe('BTC (4h) RSI crossed below 30 (now 28.4).');
    expect(evaluateAlert(rsiBelow, next({ rsi: 28, at: 1_000 }), next({ rsi: 35 }))).toBeNull();
    const priceAbove = rule({ type: 'price-crosses', price: 65000, direction: 'above' });
    expect(evaluateAlert(priceAbove, base, next({ price: 65010.5 }))?.message).toBe('BTC (4h) price crossed above 65,000.00 (now 65,010.50).');
    expect(evaluateAlert(priceAbove, base, next({ price: 64999 }))).toBeNull();
    expect(evaluateAlert(priceAbove, base, next({ price: Number.NaN }))).toBeNull();
  });

  it('never fires without a baseline, when disabled, for another market or out of order', () => {
    const r = rule({ type: 'signal-changed' });
    const changed = next({ signal: 'BEARISH' });
    expect(evaluateAlert(r, null, changed)).toBeNull();
    expect(evaluateAlert({ ...r, enabled: false }, base, changed)).toBeNull();
    expect(evaluateAlert({ ...r, symbol: 'ETH' }, base, changed)).toBeNull();
    expect(evaluateAlert({ ...r, interval: '1h' }, base, changed)).toBeNull();
    expect(evaluateAlert(r, changed, { ...base, at: 1_500 })).toBeNull();
  });

  it('evaluates many rules and builds snapshots from analyses', () => {
    const closes = walk(120, { seed: 1, drift: 0.002, noise: 0.025 });
    const candles = candlesFromCloses(closes);
    const outcome = analyze(candles, { now: afterLast(candles) });
    if (!outcome.ok) throw new Error('analysis failed');
    const snapshot = toAlertSnapshot('BTC', '4h', outcome.analysis, 5_000);
    expect(snapshot).toMatchObject({ symbol: 'BTC', interval: '4h', signal: outcome.analysis.signal, price: outcome.analysis.price, at: 5_000 });
    const rules = [rule({ type: 'signal-changed' }), rule({ type: 'price-crosses', price: 1, direction: 'below' }, { id: 'r2' })];
    const events = evaluateAlerts(rules, { ...base, signal: snapshot.signal === 'NEUTRAL' ? 'BEARISH' : 'NEUTRAL' }, snapshot);
    expect(events.map((event) => event.ruleId)).toEqual(['r1']);
  });
});
