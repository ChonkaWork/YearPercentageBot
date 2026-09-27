import { buildExplanation } from '../src/core/explain';
import type { HistoryEntry } from '../src/core/history';
import { analyze, type Analysis } from '../src/core/signal';
import { afterLast, candlesFromCloses, walk } from './helpers';

export function analysis(seed = 1): Analysis {
  const candles = candlesFromCloses(walk(120, { seed, drift: 0.002, noise: 0.025 }));
  const outcome = analyze(candles, { now: afterLast(candles) });
  if (!outcome.ok) throw new Error('analysis failed');
  return outcome.analysis;
}

export function entry(id: string, patch: Partial<HistoryEntry> = {}): HistoryEntry {
  const a = analysis();
  return {
    id,
    fetchedAt: 1_000_000,
    symbol: 'BTC',
    name: 'Bitcoin',
    quote: 'USDT',
    interval: '4h',
    source: 'binance',
    price: a.price,
    changePct24h: 1.25,
    analysis: a,
    explanation: buildExplanation({ symbol: 'BTC', interval: '4h', analysis: a }),
    ...patch,
  };
}
