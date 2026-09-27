import { describe, expect, it } from 'vitest';
import { buildExplanation, createExplanationService, LocalExplanationService, type ExplanationInput } from '../src/core/explain';
import { analyze, type Analysis } from '../src/core/signal';
import type { Interval } from '../src/core/types';
import { afterLast, candlesFromCloses, walk } from './helpers';

function analysisFor(seed: number, drift: number, lastVolume = 2400, baseVolume = 1000): Analysis {
  const closes = walk(200, { seed, drift, noise: 0.025 });
  const candles = candlesFromCloses(closes, { volumes: closes.map((_, i) => (i === 199 ? lastVolume : baseVolume)) });
  const outcome = analyze(candles, { now: afterLast(candles) });
  if (!outcome.ok) throw new Error('analysis failed');
  return outcome.analysis;
}

const CASES: [string, ExplanationInput][] = [
  ['strong bullish', { symbol: 'BTC', interval: '4h', analysis: analysisFor(1, 0.002) }],
  ['bullish, overbought', { symbol: 'ETH', interval: '1h', analysis: analysisFor(4, 0.002) }],
  ['strong bearish', { symbol: 'SOL', interval: '1d', analysis: analysisFor(21, -0.002) }],
  ['bearish', { symbol: 'XRP', interval: '4h', analysis: analysisFor(19, -0.002) }],
  ['neutral', { symbol: 'ADA', interval: '4h', analysis: analysisFor(3, 0) }],
  ['neutral, flat MACD', { symbol: 'PEPE', interval: '4h', analysis: analysisFor(14, 0, 1000) }],
  ['no volume', { symbol: 'DOGE', interval: '4h', analysis: analysisFor(1, 0.002, 0, 0) }],
];

describe('local explanation', () => {
  it.each(CASES)('%s: 2–4 plain sentences without made-up content', (_name, input) => {
    const { sentences, reasons, generator } = buildExplanation(input);
    expect(sentences.length).toBeGreaterThanOrEqual(2);
    expect(sentences.length).toBeLessThanOrEqual(4);
    expect(generator).toBe('local-rules-v1');
    const text = [...sentences, ...reasons.map((r) => r.text)].join(' ');
    expect(text).not.toMatch(/NaN|undefined|Infinity|null|\[object/);
    expect(text).not.toMatch(/\bAI\b/);
    // No predictions, promises or invented causes.
    expect(text).not.toMatch(/guarantee|will (rise|fall|go|reach|pump|dump)|profit|should buy|should sell|news|because of|moon/i);
    for (const sentence of sentences) expect(sentence).toMatch(/^[A-Z].*\.$/);
  });

  it('mentions the coin, the chart and the key numbers', () => {
    const input = CASES[0]![1];
    const { sentences } = buildExplanation(input);
    expect(sentences[0]).toBe('Bitcoin shows strong bullish momentum on the 4-hour chart: 5 of 6 indicators point up.');
    expect(sentences.join(' ')).toContain(`RSI is ${input.analysis.indicators.rsi.value.toFixed(1)}`);
    expect(sentences.join(' ')).toContain('MACD crossed above its signal line on the latest candle');
    expect(sentences.join(' ')).toContain('2.4× its 20-candle average volume');
  });

  it('describes a neutral market as mixed, not directional', () => {
    const { sentences } = buildExplanation(CASES[4]![1]);
    expect(sentences[0]).toMatch(/^Cardano has no clear direction on the 4-hour chart/);
    expect(sentences.join(' ')).not.toMatch(/leans (bullish|bearish)/);
  });

  it('uses the ticker for coins it does not know by name', () => {
    expect(buildExplanation(CASES[5]![1]).sentences[0]).toMatch(/^PEPE /);
  });

  it('says so when volume cannot be checked', () => {
    expect(buildExplanation(CASES[6]![1]).sentences.join(' ')).toContain("volume data isn't usable");
  });

  it.each<[Interval, string]>([
    ['1h', '1-hour chart'],
    ['4h', '4-hour chart'],
    ['1d', 'daily chart'],
  ])('names the %s timeframe', (interval, phrase) => {
    expect(buildExplanation({ ...CASES[0]![1], interval }).sentences[0]).toContain(phrase);
  });

  it('lists one reason per indicator: supporting, then cautions, then neutral', () => {
    const rank = { support: 0, caution: 1, neutral: 2 };
    for (const [, input] of CASES) {
      const { reasons } = buildExplanation(input);
      expect(reasons.map((r) => r.indicator).sort()).toEqual(['macd', 'momentum', 'priceVsEma50', 'rsi', 'trend', 'volume']);
      const ranks = reasons.map((r) => rank[r.kind]);
      expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
      for (const reason of reasons) {
        const points = input.analysis.indicators[reason.indicator].points;
        expect(reason.lean).toBe(points > 0 ? 'up' : points < 0 ? 'down' : 'flat');
      }
    }
  });

  it('marks indicators against the signal as cautions and flat ones as neutral', () => {
    const overbought = buildExplanation(CASES[1]![1]); // bullish with RSI overbought
    expect(overbought.reasons.find((r) => r.indicator === 'rsi')).toMatchObject({ kind: 'caution', lean: 'down', text: expect.stringMatching(/overbought/) });
    expect(overbought.reasons.find((r) => r.indicator === 'trend')).toMatchObject({ kind: 'support', text: 'EMA20 is above the EMA50 (uptrend)' });
    const firm = buildExplanation(CASES[0]![1]); // strong bullish, RSI firm in an uptrend = 0 points
    expect(firm.reasons.find((r) => r.indicator === 'rsi')).toMatchObject({ kind: 'neutral', lean: 'flat', text: expect.stringMatching(/normal in an uptrend/) });
  });

  it('warns when a directional signal has no volume behind it', () => {
    const { reasons } = buildExplanation({ symbol: 'BTC', interval: '4h', analysis: analysisFor(4, 0.002, 1000) });
    expect(reasons.find((r) => r.indicator === 'volume')).toMatchObject({ kind: 'caution', lean: 'flat', text: expect.stringMatching(/no confirmation/) });
  });

  it('lists a neutral market by lean (up, then down, then flat) without ✓ or ⚠', () => {
    const { reasons } = buildExplanation(CASES[4]![1]);
    expect(reasons.every((r) => r.kind === 'neutral')).toBe(true);
    const order = reasons.map((r) => r.lean);
    expect(order).toEqual([...order].sort((a, b) => ['up', 'down', 'flat'].indexOf(a) - ['up', 'down', 'flat'].indexOf(b)));
    expect(order).toContain('up');
    expect(order).toContain('down');
  });

  it('can leave out indicators the plan does not show', () => {
    const { sentences, reasons } = buildExplanation({ ...CASES[0]![1], omit: ['momentum', 'volume'] });
    expect(sentences).toHaveLength(3);
    expect(sentences.join(' ')).not.toMatch(/volume|over the last 10 candles/i);
    expect(reasons.map((r) => r.indicator)).not.toContain('volume');
    expect(reasons.map((r) => r.indicator)).not.toContain('momentum');
    expect(reasons).toHaveLength(4);
  });

  it('is deterministic and available through the async service interface', async () => {
    const input = CASES[2]![1];
    const service = createExplanationService();
    expect(service).toBeInstanceOf(LocalExplanationService);
    expect(await service.explain(input)).toEqual(buildExplanation(input));
    expect(buildExplanation(input)).toEqual(buildExplanation(input));
  });
});
