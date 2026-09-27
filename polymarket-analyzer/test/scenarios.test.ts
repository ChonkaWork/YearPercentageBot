import { describe, expect, it } from 'vitest';
import { analyzeMarket, type Analysis } from '../src/core/analyze';
import { generateLocalExplanation, LocalExplanationService, type AIExplanationService, type ExplanationInput } from '../src/core/explanation';
import { toPp } from '../src/core/numbers';
import { highestPriced, sortByProbability } from '../src/core/probability';
import { changeOverWindow } from '../src/core/series';
import { DAY_MS, type Market } from '../src/core/types';
import { FIXTURE_NOW_MS, historyOf, hourlySeries, makeMarket, marketOf, parsedEvent } from './helpers';

function analyzeFixture(eventSlug: string, marketSlug?: string): { market: Market; analysis: Analysis } {
  const market = marketOf(eventSlug, marketSlug);
  let history = null;
  try {
    history = historyOf(market.slug, '7d');
  } catch {
    history = null;
  }
  return { market, analysis: analyzeMarket({ market, history, now: FIXTURE_NOW_MS }) };
}

function explain(market: Market, analysis: Analysis, extra: Partial<ExplanationInput> = {}): string[] {
  return generateLocalExplanation({ title: market.question, outcomeName: market.outcomes[0]!.name, kind: 'binary', analysis, ...extra });
}

/** No NaN/Infinity/undefined anywhere in an analysis. */
function assertClean(value: unknown): void {
  JSON.stringify(value, (key, entry) => {
    if (typeof entry === 'number') expect(Number.isFinite(entry), `${key} is finite`).toBe(true);
    if (entry === undefined && key !== '') throw new Error(`${key} is undefined`);
    return entry;
  });
}

describe('scenarios (fixture payloads in the Gamma/CLOB formats)', () => {
  it('positive momentum', () => {
    const { market, analysis } = analyzeFixture('ev-sales-20m-2026');
    expect(analysis.probability).toBe(0.624);
    expect(analysis.change24hSource).toBe('market');
    expect(analysis.momentum).toMatchObject({ label: 'POSITIVE', score: 3, strength: 60 });
    expect(analysis.volume.level).toBe('NORMAL');
    expect(analysis.liquidity.level).toBe('HIGH');
    expect(analysis.volatility.level).toBe('NORMAL');
    expect(analysis.unusual).toEqual([]);
    expect(analysis.factors.every((factor) => factor.tone === 'support')).toBe(true);
    expect(explain(market, analysis)[0]).toBe('The market prices “Yes” at 62.4%, up 3.1 points over the last 24 hours and up 5.4 points over 7 days.');
    assertClean(analysis);
  });

  it('neutral momentum', () => {
    const { market, analysis } = analyzeFixture('hottest-year-on-record-2026');
    expect(analysis.momentum).toMatchObject({ label: 'NEUTRAL', score: 0, strength: 0 });
    expect(analysis.factors[0]!.text).toBe('Little change in the last 24 hours (+0.2 pp).');
    expect(explain(market, analysis).at(-1)).toMatch(/^Overall the recent price movement shows no clear direction; that describes recent trading/);
  });

  it('negative momentum with high volume', () => {
    const { analysis } = analyzeFixture('bitcoin-above-150k-end-of-2026');
    expect(analysis.momentum).toMatchObject({ label: 'STRONG_NEGATIVE', score: -5 });
    expect(analysis.volume.level).toBe('HIGH');
    expect(analysis.volatility.level).toBe('ELEVATED');
    expect(analysis.momentum.strength).toBe(85);
    expect(analysis.unusual.map((signal) => signal.kind)).toEqual(['MOVE_WITH_SPIKE']);
  });

  it('low liquidity', () => {
    const { market, analysis } = analyzeFixture('new-element-confirmed-2026');
    expect(analysis.liquidity).toEqual({ level: 'LOW', usd: 3120 });
    expect(analysis.volume.level).toBe('LOW');
    expect(analysis.momentum).toMatchObject({ label: 'NEGATIVE', strength: 20 });
    expect(analysis.factors.filter((factor) => factor.tone === 'caution').map((factor) => factor.text)).toEqual([
      'Volume is below the recent daily average (0.4×), so less trading backs the price.',
      'Low liquidity ($3.12K): the price reacts more to single trades.',
    ]);
    expect(explain(market, analysis)).toContain('Liquidity is low ($3.12K), so individual trades can move the price noticeably.');
  });

  it('sudden movement: jump, volume spike, reversal', () => {
    const { market, analysis } = analyzeFixture('us-q3-2026-gdp-growth');
    expect(analysis.unusual.map((signal) => signal.kind)).toEqual(['MOVE_WITH_SPIKE', 'REVERSAL', 'SUDDEN_MOVE']);
    expect(analysis.momentum.label).toBe('STRONG_POSITIVE');
    expect(explain(market, analysis).at(-1)).toContain('with some unusual activity');
  });

  it('multi-outcome event: leader, order, per-outcome analysis', () => {
    const { event, closed } = parsedEvent('atlantic-named-storms-2026');
    expect(event.mutuallyExclusive).toBe(true);
    expect(event.markets).toHaveLength(5);
    expect(closed.map((market) => market.label)).toEqual(['10 or fewer']);
    expect(event.hiddenMarkets).toBe(1);
    expect(highestPriced(event.markets)?.label).toBe('17–19');
    expect(sortByProbability(event.markets).map((market) => market.label)).toEqual(['17–19', '14–16', '20–22', '23 or more', '11–13']);

    const market = event.markets.find((candidate) => candidate.label === '14–16')!;
    const analysis = analyzeMarket({ market, history: historyOf(market.slug), now: FIXTURE_NOW_MS });
    expect(analysis.momentum.label).toBe('NEGATIVE');
    const sentences = explain(market, analysis, {
      title: event.title,
      outcomeName: '14–16',
      kind: 'multi',
      leader: { name: '17–19', probability: 0.41 },
      rank: { position: 2, of: 5 },
    });
    expect(sentences[0]).toBe('“14–16” is priced at 23.5%, number 2 of 5 outcomes (the current market leader, “17–19”, is at 41.0%), down 1.2 points over the last 24 hours and down 2.0 points over 7 days.');
    const leaderText = explain(market, analysis, { kind: 'multi', outcomeName: '17–19', leader: { name: '17–19', probability: 0.41 }, rank: { position: 1, of: 5 } });
    expect(leaderText[0]).toMatch(/^“17–19” is the highest-priced of 5 outcomes at 23\.5%/);
  });

  it('missing history: changes from market data, no volatility, a warning', () => {
    const market = marketOf('private-lunar-landing-2026');
    const analysis = analyzeMarket({ market, history: null, now: FIXTURE_NOW_MS });
    expect(analysis.hasHistory).toBe(false);
    expect(analysis.volatility.level).toBe('UNKNOWN');
    expect(analysis.momentum.label).toBe('POSITIVE');
    expect(analysis.warnings).toContain('Price history is unavailable, so the chart and volatility are missing.');
    expect(analysis.factors.at(-1)).toEqual({ tone: 'caution', text: 'No price history available for this market.' });
  });

  it('missing change fields fall back to history, and nothing is invented when both are missing', () => {
    const history = hourlySeries(168, (hoursAgo) => 0.6 - hoursAgo * 0.0003);
    const fromHistory = analyzeMarket({ market: makeMarket({ probability: 0.6, change24h: null, change7d: null }), history, now: FIXTURE_NOW_MS });
    expect(fromHistory.change24hSource).toBe('history');
    expect(toPp(fromHistory.change24h!)).toBeCloseTo(0.72, 6);
    expect(fromHistory.change7d).toBeCloseTo(0.0504, 6);

    const nothing = analyzeMarket({ market: makeMarket({ change24h: null, change7d: null, volume24h: null, liquidity: null }), history: null, now: FIXTURE_NOW_MS });
    expect(nothing.momentum.label).toBeNull();
    expect(nothing.change24h).toBeNull();
    expect(nothing.volume.level).toBe('UNKNOWN');
    expect(nothing.liquidity.level).toBe('UNKNOWN');
    expect(nothing.warnings).toContain('Not enough data to measure the 24-hour change.');
    assertClean(nothing);
  });

  it('flags inconsistent outcome prices', () => {
    const market = makeMarket({
      outcomes: [
        { name: 'Yes', probability: 0.3, tokenId: 'a' },
        { name: 'No', probability: 0.3, tokenId: 'b' },
      ],
      probability: 0.3,
    });
    const analysis = analyzeMarket({ market, history: null, now: FIXTURE_NOW_MS });
    expect(analysis.outcomeSum.status).toBe('inconsistent');
    expect(analysis.warnings[0]).toMatch(/Outcome prices add up to 60%/);
  });

  it('fixture histories agree with the Gamma change fields', () => {
    for (const [eventSlug, marketSlug] of [
      ['ev-sales-20m-2026', undefined],
      ['bitcoin-above-150k-end-of-2026', undefined],
      ['us-q3-2026-gdp-growth', undefined],
      ['atlantic-named-storms-2026', 'atlantic-named-storms-2026-17-19'],
    ] as const) {
      const market = marketOf(eventSlug, marketSlug);
      const history = historyOf(market.slug);
      expect(toPp(changeOverWindow(history, DAY_MS)!)).toBeCloseTo(toPp(market.change24h!), 1);
      expect(toPp(changeOverWindow(history, 7 * DAY_MS)!)).toBeCloseTo(toPp(market.change7d!), 1);
    }
  });
});

describe('explanations', () => {
  const FORBIDDEN = /\bwill (win|happen|resolve)\b|guarantee|arbitrage|mispric|insider|profit|because|news|rumou?r|whale|\bbet\b|winner/i;
  const fixtures: [string, string?][] = [
    ['ev-sales-20m-2026'],
    ['hottest-year-on-record-2026'],
    ['bitcoin-above-150k-end-of-2026'],
    ['new-element-confirmed-2026'],
    ['us-q3-2026-gdp-growth'],
    ['private-lunar-landing-2026'],
    ['fed-decision-december-2026', 'fed-increases-rates-december-2026'],
    ['atlantic-named-storms-2026', 'atlantic-named-storms-2026-20-22'],
  ];

  it.each(fixtures)('%s: 2–4 sentences, numbers only, no causes or predictions', (eventSlug, marketSlug) => {
    const { market, analysis } = analyzeFixture(eventSlug, marketSlug);
    const sentences = explain(market, analysis);
    expect(sentences.length).toBeGreaterThanOrEqual(2);
    expect(sentences.length).toBeLessThanOrEqual(4);
    for (const sentence of sentences) {
      expect(sentence).toMatch(/^[“A-Z].*\.$/);
      expect(sentence).not.toMatch(FORBIDDEN);
      expect(sentence).not.toMatch(/NaN|undefined|Infinity/);
    }
    expect(sentences.join(' ')).toContain(`${(market.probability! * 100).toFixed(1)}%`);
  });

  it('is deterministic and sits behind the AIExplanationService interface', async () => {
    const { market, analysis } = analyzeFixture('ev-sales-20m-2026');
    const service: AIExplanationService = new LocalExplanationService();
    const input: ExplanationInput = { title: market.question, outcomeName: 'Yes', kind: 'binary', analysis };
    const first = await service.explain(input);
    const second = await service.explain(input);
    expect(first).toEqual(second);
    expect(first.source).toBe('local');
    expect(first.text).toBe(first.sentences.join(' '));
  });

  it('says so when the price is missing', () => {
    const analysis = analyzeMarket({ market: makeMarket({ probability: null, change24h: null, change7d: null }), history: null, now: FIXTURE_NOW_MS });
    const sentences = generateLocalExplanation({ title: 'Q?', outcomeName: 'Yes', kind: 'binary', analysis });
    expect(sentences[0]).toBe('The current price is not available in the market data.');
    expect(sentences.length).toBeGreaterThanOrEqual(2);
  });
});
