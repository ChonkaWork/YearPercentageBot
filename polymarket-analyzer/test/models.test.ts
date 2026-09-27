import { describe, expect, it } from 'vitest';
import { DEFAULT_ALERT_RULES, evaluateAlertRule, evaluateAlertRules, LocalAlertService, type AlertObservation } from '../src/core/alerts';
import { analyzeMarket } from '../src/core/analyze';
import { chartGeometry } from '../src/core/chartGeometry';
import { buildComparison } from '../src/core/compare';
import { registerConsistencyCheck, runConsistencyChecks } from '../src/core/consistency';
import { EARLY_ACCESS, effectivePlan, FEATURES, hasFeature, isProFeature, limitsFor } from '../src/core/features';
import {
  addSnapshot,
  addToWatchlist,
  recordRefresh,
  refreshChange,
  removeFromWatchlist,
  sanitizeSnapshot,
  sanitizeSnapshots,
  sanitizeWatchlist,
  summarize,
  type MarketSummary,
  type Snapshot,
  type WatchItem,
} from '../src/core/saved';
import { normalizeQuery } from '../src/core/search';
import { isMarketRef, isPolymarketUrl, marketPageUrl, parseMarketUrl, refKey } from '../src/core/slug';
import { FIXTURE_NOW_MS, historyOf, hourlySeries, makeMarket, marketOf, parsedEvent } from './helpers';

const summary = (overrides: Partial<MarketSummary> = {}): MarketSummary => ({
  probability: 0.5,
  change24h: 0.01,
  change7d: 0.02,
  volume24h: 1000,
  liquidity: 50_000,
  signal: 'POSITIVE',
  strength: 40,
  at: 1_000,
  ...overrides,
});

const watchItem = (key: string, overrides: Partial<WatchItem> = {}): WatchItem => {
  const [eventSlug, marketSlug] = key.split('/');
  return { key, ref: { eventSlug: eventSlug || null, marketSlug: marketSlug || null }, title: `Title ${key}`, outcome: 'Yes', addedAt: 1, last: null, previous: null, alerts: [], ...overrides };
};

describe('URL detection', () => {
  it.each([
    ['https://polymarket.com/event/fed-decision-in-december', { eventSlug: 'fed-decision-in-december', marketSlug: null }],
    ['https://polymarket.com/event/fed-decision-in-december?tid=1712345', { eventSlug: 'fed-decision-in-december', marketSlug: null }],
    ['https://polymarket.com/event/fed-decision/fed-cuts-25-bps#comments', { eventSlug: 'fed-decision', marketSlug: 'fed-cuts-25-bps' }],
    ['https://www.polymarket.com/market/will-it-rain', { eventSlug: null, marketSlug: 'will-it-rain' }],
    ['https://polymarket.com/es/event/elecciones-2026', { eventSlug: 'elecciones-2026', marketSlug: null }],
    ['https://polymarket.com/pt-br/event/eleicoes/segundo-turno', { eventSlug: 'eleicoes', marketSlug: 'segundo-turno' }],
    ['https://polymarket.com/event/fed-decision/', { eventSlug: 'fed-decision', marketSlug: null }],
  ])('%s', (url, ref) => {
    expect(parseMarketUrl(url)).toEqual(ref);
  });

  it.each([
    'https://polymarket.com/',
    'https://polymarket.com/sports/nfl/games',
    'https://polymarket.com/event/',
    'https://polymarket.com/event/bad%2Fslug',
    'https://polymarket.com/event/-leading-dash',
    'http://polymarket.com/event/insecure',
    'https://polymarket.com.evil.test/event/phish',
    'https://gamma-api.polymarket.com/event/x',
    'https://example.com/event/x',
    'chrome://extensions',
    'not a url',
    '',
    null,
    undefined,
  ])('rejects %s', (url) => {
    expect(parseMarketUrl(url)).toBeNull();
  });

  it('page URLs, keys and ref validation', () => {
    expect(isPolymarketUrl('https://www.polymarket.com/sports')).toBe(true);
    expect(marketPageUrl({ eventSlug: 'e', marketSlug: 'm' })).toBe('https://polymarket.com/event/e/m');
    expect(marketPageUrl({ eventSlug: 'e', marketSlug: null })).toBe('https://polymarket.com/event/e');
    expect(marketPageUrl({ eventSlug: null, marketSlug: 'm' })).toBe('https://polymarket.com/market/m');
    expect(refKey({ eventSlug: 'e', marketSlug: null })).toBe('e/');
    expect(isMarketRef({ eventSlug: 'e', marketSlug: null })).toBe(true);
    expect(isMarketRef({ eventSlug: null, marketSlug: null })).toBe(false);
    expect(isMarketRef({ eventSlug: '../x', marketSlug: null })).toBe(false);
    expect(isMarketRef('e/m')).toBe(false);
  });
});

describe('search query', () => {
  it('normalizes selections and typed text', () => {
    expect(normalizeQuery('  “Atlantic   named storms”  ')).toBe('Atlantic named storms');
    expect(normalizeQuery('Will Bitcoin hit $150k?')).toBe('Will Bitcoin hit $150k');
    expect(normalizeQuery('a')).toBe('');
    expect(normalizeQuery('  ')).toBe('');
    expect(normalizeQuery('x'.repeat(500))).toHaveLength(100);
  });
});

describe('features', () => {
  it('free has basic analysis only; pro has everything', () => {
    for (const feature of FEATURES) expect(hasFeature('pro', feature)).toBe(true);
    expect(FEATURES.filter((feature) => hasFeature('free', feature))).toEqual(['basicAnalysis']);
    expect(isProFeature('comparisons')).toBe(true);
    expect(isProFeature('basicAnalysis')).toBe(false);
  });

  it('early access unlocks Pro for everyone; limits follow the plan', () => {
    expect(EARLY_ACCESS).toBe(true);
    expect(effectivePlan('free')).toBe('pro');
    expect(effectivePlan('free', false)).toBe('free');
    expect(limitsFor('free')).toEqual({ watchlist: 5, history: 10, chartRanges: ['24h', '7d'] });
    expect(limitsFor('pro').watchlist).toBe(50);
  });
});

describe('alert rules', () => {
  const before: AlertObservation = { probability: 0.5, volume24h: 1000, signal: 'POSITIVE', at: 1 };

  it('probability moved more than X pp', () => {
    const rule = { id: 'm', kind: 'probability-move', thresholdPp: 5 } as const;
    expect(evaluateAlertRule(rule, before, { ...before, probability: 0.56, at: 2 })?.message).toBe('Moved +6.0 pp since last check (50.0% → 56.0%)');
    expect(evaluateAlertRule(rule, before, { ...before, probability: 0.44, at: 2 })?.message).toMatch(/^Moved −6\.0 pp/);
    expect(evaluateAlertRule(rule, before, { ...before, probability: 0.55, at: 2 })).toBeNull();
    expect(evaluateAlertRule(rule, before, { ...before, probability: null, at: 2 })).toBeNull();
  });

  it('volume increased more than Y%', () => {
    const rule = { id: 'v', kind: 'volume-increase', thresholdPct: 100 } as const;
    expect(evaluateAlertRule(rule, before, { ...before, volume24h: 2500, at: 2 })?.message).toBe('24h volume up 150% since last check');
    expect(evaluateAlertRule(rule, before, { ...before, volume24h: 2000, at: 2 })).toBeNull();
    expect(evaluateAlertRule(rule, { ...before, volume24h: 0 }, { ...before, volume24h: 2000, at: 2 })).toBeNull();
  });

  it('momentum flip needs a real change of direction', () => {
    const rule = { id: 'f', kind: 'momentum-flip' } as const;
    expect(evaluateAlertRule(rule, before, { ...before, signal: 'STRONG_NEGATIVE', at: 2 })?.message).toBe('Momentum flipped to strong negative momentum');
    expect(evaluateAlertRule(rule, before, { ...before, signal: 'NEUTRAL', at: 2 })).toBeNull();
    expect(evaluateAlertRule(rule, { ...before, signal: 'NEUTRAL' }, { ...before, signal: 'NEGATIVE', at: 2 })).toBeNull();
    expect(evaluateAlertRule(rule, before, { ...before, signal: 'STRONG_POSITIVE', at: 2 })).toBeNull();
  });

  it('evaluates rule sets; nothing without a previous observation', () => {
    const after = { probability: 0.6, volume24h: 3000, signal: 'NEGATIVE' as const, at: 2 };
    expect(evaluateAlertRules(DEFAULT_ALERT_RULES, null, after)).toEqual([]);
    expect(new LocalAlertService().evaluate(before, after).map((event) => event.kind)).toEqual(['probability-move', 'volume-increase', 'momentum-flip']);
  });
});

describe('watchlist and history models', () => {
  it('adds with limit and duplicate checks, removes', () => {
    const items = [watchItem('a/'), watchItem('b/')];
    expect(addToWatchlist(items, watchItem('c/'), 3)).toMatchObject({ ok: true });
    expect((addToWatchlist(items, watchItem('c/'), 3) as { items: WatchItem[] }).items[0]!.key).toBe('c/');
    expect(addToWatchlist(items, watchItem('c/'), 2)).toMatchObject({ ok: false, reason: 'limit' });
    expect(addToWatchlist(items, watchItem('a/'), 5)).toMatchObject({ ok: false, reason: 'exists' });
    expect(removeFromWatchlist(items, 'a/').map((item) => item.key)).toEqual(['b/']);
  });

  it('records refreshes in order and reports the change between them', () => {
    const item = watchItem('a/', { last: summary({ probability: 0.5, at: 10 }) });
    const refreshed = recordRefresh(item, summary({ probability: 0.57, at: 20 }), ['Moved']);
    expect(refreshChange(refreshed)).toBeCloseTo(0.07, 9);
    expect(refreshed.alerts).toEqual(['Moved']);
    expect(recordRefresh(refreshed, summary({ probability: 0.9, at: 20 }), [])).toBe(refreshed);
    expect(refreshChange(item)).toBeNull();
  });

  it('sanitizes stored watchlists', () => {
    const stored = [
      null,
      'junk',
      { ...watchItem('a/m'), last: { probability: 7, at: 'x' }, alerts: ['ok', 5, ''] },
      watchItem('a/m'),
      { ...watchItem('b/'), ref: { eventSlug: '../../etc', marketSlug: null } },
      { ...watchItem('c/'), title: '' },
      { ...watchItem('d/'), last: summary({ probability: 1.5, strength: 250, signal: 'MOON' as never, at: 5 }) },
    ];
    const items = sanitizeWatchlist(stored, 50);
    expect(items.map((item) => item.key)).toEqual(['a/m', 'd/']);
    expect(items[0]!.last).toBeNull();
    expect(items[0]!.alerts).toEqual(['ok']);
    expect(items[1]!.last).toMatchObject({ probability: null, strength: null, signal: null, at: 5 });
    expect(sanitizeWatchlist({ nope: true }, 50)).toEqual([]);
    expect(sanitizeWatchlist([watchItem('a/'), watchItem('b/'), watchItem('c/')], 2)).toHaveLength(2);
  });

  const snapshot = (id: string, savedAt: number, overrides: Partial<Snapshot> = {}): Snapshot => ({
    id,
    key: 'e/',
    ref: { eventSlug: 'e', marketSlug: null },
    selectedSlug: 'm',
    savedAt,
    kind: 'binary',
    title: 'Title',
    eventTitle: null,
    outcome: 'Yes',
    outcomes: [{ name: 'Yes', probability: 0.5 }],
    endDate: null,
    summary: summary({ at: savedAt }),
    volumeLevel: 'NORMAL',
    volumeRatio: 1,
    liquidityLevel: 'HIGH',
    unusual: [],
    factors: [{ tone: 'support', text: 'Up 1 pp' }],
    explanation: 'Text.',
    warnings: [],
    series: [
      { t: 1, p: 0.5 },
      { t: 2, p: 0.6 },
    ],
    seriesRange: '7d',
    ...overrides,
  });

  it('snapshots of the same market within 10 minutes replace each other; limit applies', () => {
    let list = addSnapshot([], snapshot('1', 0), 10);
    list = addSnapshot(list, snapshot('2', 5 * 60_000), 10);
    expect(list.map((item) => item.id)).toEqual(['2']);
    list = addSnapshot(list, snapshot('3', 20 * 60_000), 10);
    list = addSnapshot(list, snapshot('4', 21 * 60_000, { selectedSlug: 'other' }), 10);
    expect(list.map((item) => item.id)).toEqual(['4', '3', '2']);
    expect(addSnapshot(list, snapshot('5', 60 * 60_000), 2).map((item) => item.id)).toEqual(['5', '4']);
    expect(addSnapshot(list, snapshot('6', 1), 0)).toEqual([]);
  });

  it('sanitizes stored snapshots', () => {
    const good = snapshot('1', 100);
    expect(sanitizeSnapshot(JSON.parse(JSON.stringify(good)))).toEqual(good);
    expect(sanitizeSnapshot({ ...good, summary: null })).toBeNull();
    expect(sanitizeSnapshot({ ...good, ref: { eventSlug: null, marketSlug: null } })).toBeNull();
    const repaired = sanitizeSnapshot({ ...good, volumeLevel: 'HUGE', series: [{ t: 'x' }, { t: 5, p: 0.2 }], factors: [{ tone: 'weird', text: 'x' }, 7], seriesRange: '1y', kind: 'nope' });
    expect(repaired).toMatchObject({ volumeLevel: 'UNKNOWN', series: [{ t: 5, p: 0.2 }], factors: [{ tone: 'support', text: 'x' }], seriesRange: '7d', kind: 'binary' });
    expect(sanitizeSnapshots([good, good, snapshot('2', 200), 'junk'], 10).map((item) => item.id)).toEqual(['2', '1']);
  });

  it('summarizes an analysis', () => {
    const analysis = analyzeMarket({ market: marketOf('ev-sales-20m-2026'), history: historyOf('will-global-ev-sales-exceed-20-million-in-2026'), now: FIXTURE_NOW_MS });
    expect(summarize(analysis, 42)).toEqual({ probability: 0.624, change24h: 0.031, change7d: 0.054, volume24h: 245120.44, liquidity: 1184233.5521, signal: 'POSITIVE', strength: 60, at: 42 });
  });
});

describe('compare', () => {
  it('keeps the chosen order, never ranks, shows gaps as dashes', () => {
    const rows = buildComparison([
      { key: 'a', title: 'A', outcome: 'Yes', summary: summary({ probability: 0.2, signal: 'STRONG_NEGATIVE', strength: 85 }) },
      { key: 'b', title: 'B', outcome: 'Yes', summary: summary({ probability: 0.9 }) },
      { key: 'c', title: 'C', outcome: 'Yes', summary: null, error: 'Market not found' },
    ]);
    expect(rows.map((row) => row.label)).toEqual(['Probability', '24h change', '7d change', 'Volume 24h', 'Liquidity', 'Momentum']);
    expect(rows[0]!.cells.map((cell) => cell.text)).toEqual(['20.0%', '90.0%', '—']);
    expect(rows[5]!.cells[0]).toMatchObject({ text: 'Strong negative', sub: '85/100', tone: 'down' });
    expect(JSON.stringify(rows)).not.toMatch(/best|winner|recommend/i);
  });
});

describe('chart geometry', () => {
  const box = { width: 344, height: 150, padding: { top: 10, right: 38, bottom: 18, left: 2 } };

  it('needs two points', () => {
    expect(chartGeometry([], '7d', box)).toBeNull();
    expect(chartGeometry([{ t: 1, p: 0.5 }], '7d', box)).toBeNull();
  });

  it('builds a path inside the box, nice ticks, markers and a summary', () => {
    const geometry = chartGeometry(historyOf('will-us-q3-2026-gdp-growth-exceed-2-percent'), '7d', box)!;
    expect(geometry.line.startsWith('M')).toBe(true);
    for (const point of geometry.points) {
      expect(point.x).toBeGreaterThanOrEqual(box.padding.left);
      expect(point.x).toBeLessThanOrEqual(box.width - box.padding.right);
      expect(point.y).toBeGreaterThanOrEqual(box.padding.top);
      expect(point.y).toBeLessThanOrEqual(box.height - box.padding.bottom);
    }
    expect(geometry.yTicks.length).toBeGreaterThanOrEqual(2);
    expect(geometry.yTicks.every((tick) => /^\d+(\.\d)?%$/.test(tick.label))).toBe(true);
    expect(geometry.markers.map((marker) => marker.direction)).toContain('up');
    expect(geometry.direction).toBe('up');
    expect(geometry.last.label).toBe('71.0%');
    expect(geometry.summary).toMatch(/^Price over 7 days: from 62\.0% to 71\.0% \(\+9\.0 pp\)/);
  });

  it('draws small drifts as flat and keeps the domain within 0–100%', () => {
    expect(chartGeometry(hourlySeries(48, (h) => 0.47 + (h % 3) * 0.001), '7d', box)!.direction).toBe('flat');
    const extreme = chartGeometry(hourlySeries(48, (h) => (h > 24 ? 0.001 : 0.999)), '7d', box)!;
    expect(extreme.domain.min).toBeGreaterThanOrEqual(0);
    expect(extreme.domain.max).toBeLessThanOrEqual(1);
  });
});

describe('consistency extension point', () => {
  it('is empty by default, runs registered checks and contains failures', () => {
    const { event } = parsedEvent('atlantic-named-storms-2026');
    expect(runConsistencyChecks(event)).toEqual([]);
    const unregister = registerConsistencyCheck({
      id: 'demo',
      appliesTo: (candidate) => candidate.mutuallyExclusive,
      run: (candidate) => [{ checkId: 'demo', severity: 'info', message: `${candidate.markets.length} outcomes`, marketSlugs: [] }],
    });
    const unregisterBroken = registerConsistencyCheck({
      id: 'broken',
      appliesTo: () => true,
      run: () => {
        throw new Error('boom');
      },
    });
    expect(runConsistencyChecks(event).map((finding) => finding.message)).toEqual(['5 outcomes']);
    unregister();
    unregisterBroken();
    expect(runConsistencyChecks(event)).toEqual([]);
    expect(makeMarket().probability).toBe(0.5);
  });
});
